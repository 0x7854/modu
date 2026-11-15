import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../cloud/server.js';
import { CloudStore } from '../cloud/lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'cloud', 'public');

let tmpRoot;
let store;
let server;
let base;
let alice;
let bob;
let aliceToken;
let bobToken;

function idFor(index) {
  return index.toString(16).padStart(32, '0');
}

async function createServer(options = {}) {
  const instance = await createCloudServer({
    dataDir: path.join(tmpRoot, 'data'),
    publicDir,
    maxDocBytes: 4096,
    pollMs: 1000,
    loginMaxAttempts: 50,
    ...options,
  });
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.once('listening', resolve);
    instance.listen(0, '127.0.0.1');
  });
  return instance;
}

async function closeServer(instance) {
  if (!instance) return;
  instance.cloudShutdown();
  await new Promise((resolve) => instance.close(resolve));
}

async function login(username, password) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function session(username, password) {
  const { response, payload } = await login(username, password);
  assert.equal(response.status, 200, JSON.stringify(payload));
  return {
    cookie: cookieFrom(response),
    csrf: payload.csrfToken,
    user: payload.user,
  };
}

function apiFetch(pathname, { cookie, csrf, method = 'GET', body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (cookie) finalHeaders.Cookie = cookie;
  if (csrf) finalHeaders['X-CSRF-Token'] = csrf;
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  return fetch(`${base}${pathname}`, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function syncFetch(token, pathname, { method = 'GET', body } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function putDoc(token, id, { name = 'doc.md', markdown }) {
  return syncFetch(token, `/api/sync/documents/${id}`, {
    method: 'PUT',
    body: { name, markdown },
  });
}

function importFetch(token, body) {
  return fetch(`${base}/api/import/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function importWithSession(auth, body, { csrf = auth.csrf } = {}) {
  return apiFetch('/api/import/documents', {
    cookie: auth.cookie,
    csrf,
    method: 'POST',
    body,
  });
}

async function issueImportToken(auth) {
  const response = await apiFetch('/api/import/token', {
    cookie: auth.cookie,
    csrf: auth.csrf,
    method: 'POST',
    body: {},
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.token, /^modu_import_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/);
  return payload;
}

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-cloud-test-'));
  store = await new CloudStore(path.join(tmpRoot, 'data'), { maxDocBytes: 4096 }).init();
  const a = await store.addUser('alice', 'correct horse battery');
  const b = await store.addUser('bob', 'another good password');
  alice = a.user;
  aliceToken = a.syncToken;
  bob = b.user;
  bobToken = b.syncToken;
  server = await createServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeServer(server);
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('cloud service is private: session API, CSRF, cookie and origin checks', async () => {
  const anonymous = await apiFetch('/api/documents');
  assert.equal(anonymous.status, 401);

  const wrong = await login('alice', 'not-the-password');
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.payload.error.code, 'INVALID_CREDENTIALS');

  const auth = await session('alice', 'correct horse battery');
  const setCookie = String((await login('alice', 'correct horse battery')).response.headers.get('set-cookie'));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Secure/, 'plain localhost HTTP test must not set Secure');

  const list = await apiFetch('/api/documents', auth);
  assert.equal(list.status, 200);
  const listPayload = await list.json();
  assert.equal(Array.isArray(listPayload.documents), true);

  const noCsrf = await apiFetch('/api/logout', { cookie: auth.cookie, method: 'POST', body: {} });
  assert.equal(noCsrf.status, 403);
  const wrongCsrf = await apiFetch('/api/logout', {
    cookie: auth.cookie,
    csrf: 'wrong',
    method: 'POST',
    body: {},
  });
  assert.equal(wrongCsrf.status, 403);

  const crossSite = await apiFetch('/api/documents', {
    cookie: auth.cookie,
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, 'ORIGIN_BLOCKED');

  const crossFetch = await apiFetch('/api/documents', {
    cookie: auth.cookie,
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossFetch.status, 403);
});

test('login rate limiting returns 429 and Retry-After', async () => {
  const limited = await createServer({ loginMaxAttempts: 2, loginWindowMs: 60_000 });
  const oldBase = base;
  base = `http://127.0.0.1:${limited.address().port}`;
  try {
    const first = await login('alice', 'wrong-1');
    const second = await login('alice', 'wrong-2');
    const third = await login('alice', 'wrong-3');
    assert.equal(first.response.status, 401);
    assert.equal(second.response.status, 401);
    assert.equal(third.response.status, 429);
    assert.ok(Number(third.response.headers.get('retry-after')) >= 1);
  } finally {
    base = oldBase;
    await closeServer(limited);
  }
});

test('sync token and reading login are separate credentials', async () => {
  const syncOnly = await syncFetch(aliceToken, '/api/sync/ping');
  assert.equal(syncOnly.status, 200);
  const ping = await syncOnly.json();
  assert.equal(ping.user.username, 'alice');

  const cookieOnly = await apiFetch('/api/documents', {
    cookie: (await session('alice', 'correct horse battery')).cookie,
  });
  assert.equal(cookieOnly.status, 200);

  const tokenOnReaderApi = await apiFetch('/api/documents', {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(tokenOnReaderApi.status, 401);

  const cookieOnSyncApi = await apiFetch('/api/sync/ping', {
    cookie: (await session('alice', 'correct horse battery')).cookie,
  });
  assert.equal(cookieOnSyncApi.status, 401);
});

test('documents and sync tokens are isolated between accounts', async () => {
  const aliceDoc = idFor(100);
  const bobDoc = idFor(101);
  assert.equal((await putDoc(aliceToken, aliceDoc, { markdown: '# Alice only\n' })).status, 200);
  assert.equal((await putDoc(bobToken, bobDoc, { name: 'bob.md', markdown: '# Bob only\n' })).status, 200);

  const a = await session('alice', 'correct horse battery');
  const b = await session('bob', 'another good password');
  const aList = await (await apiFetch('/api/documents', a)).json();
  const bList = await (await apiFetch('/api/documents', b)).json();
  assert.deepEqual(aList.documents.map((doc) => doc.id), [aliceDoc]);
  assert.deepEqual(bList.documents.map((doc) => doc.id), [bobDoc]);

  const crossRead = await apiFetch(`/api/documents/${bobDoc}`, a);
  assert.equal(crossRead.status, 404);
  const crossSync = await syncFetch(aliceToken, `/api/sync/documents/${bobDoc}`);
  assert.equal(crossSync.status, 405, 'sync documents are write-only by id; no cross-account read');

  const bobListWithAliceToken = await syncFetch(aliceToken, '/api/sync/documents');
  assert.equal(bobListWithAliceToken.status, 200);
  const syncList = await bobListWithAliceToken.json();
  assert.deepEqual(syncList.documents.map((doc) => doc.id), [aliceDoc]);
});

test('upload accepts Markdown, rejects traversal/oversize, and preserves raw text for client sanitizing', async () => {
  const id = idFor(200);
  const xss = '# 安全\n\n<script>window.__xss = 1</script>\n\n<img src=x onerror="window.__xss=2">\n';
  const saved = await putDoc(aliceToken, id, { name: 'xss.md', markdown: xss });
  assert.equal(saved.status, 200);
  const savedPayload = await saved.json();
  assert.equal(savedPayload.doc.revision, 1);

  const traversal = await syncFetch(aliceToken, '/api/sync/documents/../../users.json', { method: 'PUT' });
  assert.ok([400, 404].includes(traversal.status));
  const nonHex = await syncFetch(aliceToken, '/api/sync/documents/not-a-document', { method: 'PUT' });
  assert.ok([400, 404].includes(nonHex.status));

  const tooLarge = await putDoc(aliceToken, idFor(201), {
    name: 'large.md',
    markdown: `# large\n${'x'.repeat(5000)}`,
  });
  assert.equal(tooLarge.status, 413);

  const auth = await session('alice', 'correct horse battery');
  const docResponse = await apiFetch(`/api/documents/${id}`, auth);
  assert.equal(docResponse.status, 200);
  assert.equal(docResponse.headers.get('content-type'), 'application/json; charset=utf-8');
  const docPayload = await docResponse.json();
  assert.equal(docPayload.doc.markdown, xss);
  assert.doesNotMatch(docResponse.headers.get('content-type'), /html/);
});

test('reader sees updates with ETag, same-content rename is preserved, positions persist', async () => {
  const id = idFor(300);
  await putDoc(aliceToken, id, { name: 'a.md', markdown: '# First\n\nbody\n' });
  const auth = await session('alice', 'correct horse battery');

  const first = await apiFetch(`/api/documents/${id}`, auth);
  const etag = first.headers.get('etag');
  assert.match(etag, /"rev-1"/);
  const firstPayload = await first.json();

  const unchanged = await apiFetch(`/api/documents/${id}`, { ...auth, headers: { 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304);

  const positionResponse = await apiFetch(`/api/documents/${id}/position`, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    method: 'PUT',
    body: { anchor: 'b:test:0', ratio: 0.42, scrollTop: 600 },
  });
  assert.equal(positionResponse.status, 200);

  const rename = await putDoc(aliceToken, id, { name: 'renamed.md', markdown: '# First\n\nbody\n' });
  assert.equal(rename.status, 200);
  const renamePayload = await rename.json();
  assert.equal(renamePayload.doc.name, 'renamed.md');
  assert.equal(renamePayload.doc.revision, 1, 'same content must not bump revision');

  const afterRename = await (await apiFetch(`/api/documents/${id}`, auth)).json();
  assert.equal(afterRename.doc.name, 'renamed.md');
  assert.equal(afterRename.doc.position.ratio, 0.42);

  await putDoc(aliceToken, id, { name: 'renamed.md', markdown: '# Second\n\nnew body\n' });
  const second = await apiFetch(`/api/documents/${id}`, auth);
  const secondPayload = await second.json();
  assert.equal(secondPayload.doc.revision, 2);
  assert.match(secondPayload.doc.markdown, /Second/);
  assert.equal(secondPayload.doc.position.ratio, 0.42);
  assert.notEqual(second.headers.get('etag'), etag);
  assert.equal(firstPayload.doc.revision, 1);
});

test('concurrent upload and position writes serialize without losing revision or position', async () => {
  const auth = await session('alice', 'correct horse battery');
  let mismatches = 0;
  for (let index = 0; index < 20; index += 1) {
    const id = idFor(1000 + index);
    await putDoc(aliceToken, id, { name: 'race.md', markdown: '# old' });
    const [upload, position] = await Promise.all([
      putDoc(aliceToken, id, { name: 'race.md', markdown: '# new' }),
      apiFetch(`/api/documents/${id}/position`, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        method: 'PUT',
        body: { ratio: 0.5 },
      }),
    ]);
    assert.equal(upload.status, 200);
    assert.equal(position.status, 200);
    const doc = await (await apiFetch(`/api/documents/${id}`, auth)).json();
    if (doc.doc.revision !== 2 || doc.doc.markdown !== '# new' || doc.doc.position?.ratio !== 0.5) {
      mismatches += 1;
    }
  }
  assert.equal(mismatches, 0);
});

test('reset-password revokes old sessions and keeps sync token behavior explicit', async () => {
  const auth = await session('bob', 'another good password');
  const ok = await apiFetch('/api/documents', auth);
  assert.equal(ok.status, 200);

  // Simulate the separate manage.js process rewriting users.json.
  const externalStore = await new CloudStore(path.join(tmpRoot, 'data')).init();
  await externalStore.resetPassword(bob.id, 'a brand new password');
  const revoked = await apiFetch('/api/documents', auth);
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).error.code, 'SESSION_REVOKED');

  const oldLogin = await login('bob', 'another good password');
  assert.equal(oldLogin.response.status, 401);
  const newLogin = await login('bob', 'a brand new password');
  assert.equal(newLogin.response.status, 200);
  const ping = await syncFetch(bobToken, '/api/sync/ping');
  assert.equal(ping.status, 200, 'password reset must not rotate the independent sync token');
});

test('health check and public shell are private-data free', async () => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json();
  assert.equal(healthPayload.service, 'modu-cloud');

  const shell = await fetch(`${base}/`);
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.match(html, /PRIVATE CLOUD LIBRARY/);
  assert.doesNotMatch(html, /alice|bob|Alice only|Bob only/);
  assert.match(shell.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(shell.headers.get('content-security-policy'), /worker-src 'self'/);
  assert.equal(shell.headers.get('x-frame-options'), 'DENY');
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
});

test('reverse-proxy HTTPS marks cookies Secure and validates the public origin', async () => {
  const proxied = await createServer({
    publicOrigin: 'https://md.example.com',
    trustProxy: true,
  });
  const oldBase = base;
  base = `http://127.0.0.1:${proxied.address().port}`;
  try {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://md.example.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'md.example.com',
      },
      body: JSON.stringify({ username: 'alice', password: 'correct horse battery' }),
    });
    assert.equal(response.status, 200);
    const cookie = String(response.headers.get('set-cookie') || '');
    assert.match(cookie, /^__Host-modu_cloud_sid=/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);

    const evilOrigin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'md.example.com',
      },
      body: JSON.stringify({ username: 'alice', password: 'correct horse battery' }),
    });
    assert.equal(evilOrigin.status, 403);
  } finally {
    base = oldBase;
    await closeServer(proxied);
  }
});

test('mobile import accepts cookie+CSRF or import-only bearer, and never widens either credential', async () => {
  const created = await store.addUser('carol', 'carol long password');
  const auth = await session('carol', 'carol long password');

  const anonymous = await importFetch('', { name: 'anon.md', markdown: '# no' });
  assert.equal(anonymous.status, 401);

  const noCsrf = await importWithSession(auth, { name: 'csrf.md', markdown: '# no' }, { csrf: '' });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, 'CSRF_REQUIRED');
  const wrongCsrf = await importWithSession(auth, { name: 'csrf.md', markdown: '# no' }, { csrf: 'wrong' });
  assert.equal(wrongCsrf.status, 403);

  const first = await importWithSession(auth, {
    name: '中文 同名.md',
    markdown: '# 你好\n\n第一份。\n',
  });
  assert.equal(first.status, 201);
  const firstPayload = await first.json();
  assert.match(firstPayload.doc.id, /^[a-f0-9]{32}$/);
  assert.equal(firstPayload.doc.name, '中文 同名.md');
  assert.equal(firstPayload.doc.kind, 'markdown');
  assert.equal(firstPayload.url, `/#doc-${firstPayload.doc.id}`);
  assert.equal(firstPayload.replayed, false);

  const sameName = await importWithSession(auth, {
    name: '中文 同名.md',
    markdown: '# 你好\n\n第二份，不是覆盖。\n',
  });
  assert.equal(sameName.status, 201);
  const sameNamePayload = await sameName.json();
  assert.notEqual(sameNamePayload.doc.id, firstPayload.doc.id, 'same filename must create a new document');

  const library = await (await apiFetch('/api/library', auth)).json();
  assert.equal(library.library.assignments[firstPayload.doc.id], undefined, 'imports start unfiled');

  const issued = await issueImportToken(auth);
  assert.equal(issued.configured, true);
  assert.equal(issued.valid, true);
  assert.equal(issued.tokenInfo.configured, true);
  assert.equal(issued.tokenInfo.valid, true);
  assert.equal('tokenHash' in issued, false);
  assert.equal('tokenHash' in issued.tokenInfo, false);

  const tokenReadList = await apiFetch('/api/documents', {
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  assert.equal(tokenReadList.status, 401, 'import token must not read the library');
  const tokenReadDoc = await apiFetch(`/api/documents/${firstPayload.doc.id}`, {
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  assert.equal(tokenReadDoc.status, 401);
  const tokenManage = await apiFetch('/api/import/token', {
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  assert.equal(tokenManage.status, 401, 'import token cannot manage tokens');
  const tokenSync = await syncFetch(issued.token, `/api/sync/documents/${idFor(9000)}`, {
    method: 'PUT',
    body: { name: 'x.md', markdown: '# x' },
  });
  assert.equal(tokenSync.status, 401, 'import token cannot write through the sync API');

  const syncAsImport = await importFetch(created.syncToken, {
    name: 'sync-token.md',
    markdown: '# no',
  });
  assert.equal(syncAsImport.status, 401, 'sync token is not an import token');

  const bob = await session('alice', 'correct horse battery');
  const crossRead = await apiFetch(`/api/documents/${firstPayload.doc.id}`, bob);
  assert.equal(crossRead.status, 404, 'another account cannot read an imported document');

  const tooLargeBody = await importFetch(issued.token, {
    name: 'huge.md',
    markdown: `# huge\n${'x'.repeat(200_000)}`,
  });
  assert.equal(tooLargeBody.status, 413);
  assert.equal((await tooLargeBody.json()).error.code, 'BODY_TOO_LARGE');

  const badType = await importFetch(issued.token, { name: 'note.pdf', markdown: '# nope' });
  assert.equal(badType.status, 415);
  const badName = await importFetch(issued.token, { name: '../escape.md', markdown: '# nope' });
  assert.equal(badName.status, 400);
  const controlName = await importFetch(issued.token, {
    name: 'bad\u0000name.md',
    markdown: '# nope',
  });
  assert.equal(controlName.status, 400);
  const badMarkdown = await importFetch(issued.token, { name: 'missing.md' });
  assert.equal(badMarkdown.status, 400);
  assert.equal((await badMarkdown.json()).error.code, 'INVALID_MARKDOWN');
  const badRequestId = await importFetch(issued.token, {
    name: 'bad-id.md',
    markdown: '# bad',
    requestId: 'NOT-32-HEX',
  });
  assert.equal(badRequestId.status, 400);
  assert.equal((await badRequestId.json()).error.code, 'INVALID_REQUEST_ID');
});

test('import requestId is idempotent per user, rejects conflicts, and never overwrites existing docs', async () => {
  const created = await store.addUser('dave', 'dave long password');
  const auth = await session('dave', 'dave long password');
  const issued = await issueImportToken(auth);

  const existingId = idFor(5000);
  assert.equal((await putDoc(created.syncToken, existingId, {
    name: 'keep.md',
    markdown: '# keep me\n',
  })).status, 200);

  const requestId = '1'.repeat(32);
  const first = await importFetch(issued.token, {
    name: '同名.md',
    markdown: '# first\n',
    requestId,
  });
  assert.equal(first.status, 201);
  const firstPayload = await first.json();
  const replay = await importFetch(issued.token, {
    name: '同名.md',
    markdown: '# first\n',
    requestId,
  });
  assert.equal(replay.status, 200);
  const replayPayload = await replay.json();
  assert.equal(replayPayload.replayed, true);
  assert.equal(replayPayload.doc.id, firstPayload.doc.id);

  const conflict = await importFetch(issued.token, {
    name: '同名.md',
    markdown: '# different\n',
    requestId,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IMPORT_CONFLICT');

  const sameNameNewId = await importFetch(issued.token, {
    name: '同名.md',
    markdown: '# second\n',
  });
  assert.equal(sameNameNewId.status, 201);
  const sameNamePayload = await sameNameNewId.json();
  assert.notEqual(sameNamePayload.doc.id, firstPayload.doc.id);

  const untouched = await (await apiFetch(`/api/documents/${existingId}`, auth)).json();
  assert.equal(untouched.doc.markdown, '# keep me\n');
  assert.equal(untouched.doc.revision, 1);
  assert.equal(untouched.doc.name, 'keep.md');

  const concurrentId = '2'.repeat(32);
  const [left, right] = await Promise.all([
    importFetch(issued.token, { name: '并发.md', markdown: '# once\n', requestId: concurrentId }),
    importFetch(issued.token, { name: '并发.md', markdown: '# once\n', requestId: concurrentId }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201]);
  const [leftPayload, rightPayload] = await Promise.all([left.json(), right.json()]);
  assert.equal(leftPayload.doc.id, rightPayload.doc.id);
  assert.equal(leftPayload.replayed === rightPayload.replayed, false);

  const exactlyMax = await importFetch(issued.token, {
    name: 'boundary.md',
    markdown: 'x'.repeat(4096),
  });
  assert.equal(exactlyMax.status, 201);
  const overMax = await importFetch(issued.token, {
    name: 'boundary-over.md',
    markdown: 'x'.repeat(4097),
  });
  assert.equal(overMax.status, 413);
  assert.equal((await overMax.json()).error.code, 'DOCUMENT_TOO_LARGE');
});

test('import token rotates, revokes, and is invalidated by password reset, account disable, and authVersion', async () => {
  const created = await store.addUser('erin', 'erin long password');
  const auth = await session('erin', 'erin long password');
  const first = await issueImportToken(auth);

  const tokenFile = path.join(tmpRoot, 'data', 'import-tokens', `${created.user.id}.json`);
  const storedToken = await fsp.readFile(tokenFile, 'utf8');
  assert.equal(storedToken.includes(first.token), false, 'token file must be hash-only');
  assert.match(storedToken, /"tokenHash": "[a-f0-9]{64}"/);
  assert.equal((await fsp.stat(tokenFile)).mode & 0o777, 0o600);
  const usersText = await fsp.readFile(path.join(tmpRoot, 'data', 'users.json'), 'utf8');
  assert.equal(usersText.includes(first.token), false, 'users.json must not contain import tokens');
  assert.equal(usersText.includes('tokenHash'), false);

  const status = await (await apiFetch('/api/import/token', { cookie: auth.cookie })).json();
  assert.equal(status.configured, true);
  assert.equal(status.valid, true);
  assert.equal('token' in status, false, 'status must never return a clear token');
  assert.equal('tokenHash' in status, false);

  const second = await issueImportToken(auth);
  assert.notEqual(second.token, first.token);
  assert.equal((await importFetch(first.token, {
    name: 'old.md',
    markdown: '# old',
  })).status, 401);
  assert.equal((await importFetch(second.token, {
    name: 'new.md',
    markdown: '# new',
  })).status, 201);

  const noCsrfDelete = await apiFetch('/api/import/token', {
    cookie: auth.cookie,
    method: 'DELETE',
    body: {},
  });
  assert.equal(noCsrfDelete.status, 403);
  const revoked = await apiFetch('/api/import/token', {
    cookie: auth.cookie,
    csrf: auth.csrf,
    method: 'DELETE',
    body: {},
  });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).configured, false);
  assert.equal((await importFetch(second.token, {
    name: 'revoked.md',
    markdown: '# revoked',
  })).status, 401);

  const third = await issueImportToken(auth);
  const externalStore = await new CloudStore(path.join(tmpRoot, 'data')).init();
  await externalStore.resetPassword(created.user.id, 'erin new long password');
  assert.equal((await importFetch(third.token, {
    name: 'after-reset.md',
    markdown: '# reset',
  })).status, 401, 'authVersion rotation revokes import tokens');
  const newAuth = await session('erin', 'erin new long password');
  const staleStatus = await (await apiFetch('/api/import/token', { cookie: newAuth.cookie })).json();
  assert.equal(staleStatus.configured, true);
  assert.equal(staleStatus.valid, false);

  const fourth = await issueImportToken(newAuth);
  assert.equal((await importFetch(fourth.token, {
    name: 'after-reset-new.md',
    markdown: '# reset new',
  })).status, 201);

  const usersPath = path.join(tmpRoot, 'data', 'users.json');
  const users = JSON.parse(await fsp.readFile(usersPath, 'utf8'));
  const erin = users.users.find((entry) => entry.id === created.user.id);
  erin.disabled = true;
  await fsp.writeFile(usersPath, `${JSON.stringify(users, null, 2)}\n`);
  assert.equal((await importFetch(fourth.token, {
    name: 'disabled.md',
    markdown: '# disabled',
  })).status, 401, 'disabled accounts cannot import');
  delete erin.disabled;
  await fsp.writeFile(usersPath, `${JSON.stringify(users, null, 2)}\n`);
  assert.equal((await importFetch(fourth.token, {
    name: 'enabled-again.md',
    markdown: '# enabled',
  })).status, 201);
});

test('import token validation failures are rate limited', async () => {
  const limited = await createServer({
    importTokenMaxFailures: 2,
    importTokenWindowMs: 60_000,
  });
  const oldBase = base;
  base = `http://127.0.0.1:${limited.address().port}`;
  try {
    const fake = `modu_import_${'a'.repeat(24)}_${'b'.repeat(43)}`;
    const first = await importFetch(fake, { name: 'bad-1.md', markdown: '# bad' });
    assert.equal(first.status, 401);
    assert.equal((await first.json()).error.code, 'IMPORT_TOKEN_INVALID');
    const second = await importFetch(fake, { name: 'bad-2.md', markdown: '# bad' });
    assert.equal(second.status, 401);
    const third = await importFetch(fake, { name: 'bad-3.md', markdown: '# bad' });
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
  } finally {
    base = oldBase;
    await closeServer(limited);
  }
});

test('shortcut download is one fixed public path with no caching and no directory traversal', async () => {
  const tempPublic = path.join(tmpRoot, 'shortcut-public');
  await fsp.cp(publicDir, tempPublic, { recursive: true });
  await fsp.mkdir(path.join(tempPublic, 'shortcuts'), { recursive: true });
  await fsp.writeFile(
    path.join(tempPublic, 'shortcuts', 'Open-in-Modu.shortcut'),
    Buffer.from('SIGNED_SHORTCUT_FIXTURE'),
  );
  const shortcutServer = await createServer({ publicDir: tempPublic });
  const oldBase = base;
  base = `http://127.0.0.1:${shortcutServer.address().port}`;
  try {
    const shortcut = await fetch(`${base}/shortcuts/Open-in-Modu.shortcut`);
    assert.equal(shortcut.status, 200);
    assert.equal(await shortcut.text(), 'SIGNED_SHORTCUT_FIXTURE');
    assert.equal(shortcut.headers.get('cache-control'), 'no-store');
    assert.match(shortcut.headers.get('content-disposition'), /attachment; filename="Open-in-Modu.shortcut"/);

    assert.equal((await fetch(`${base}/shortcuts/Other.shortcut`)).status, 404);
    assert.equal((await fetch(`${base}/shortcuts/../users.json`)).status, 404);
  } finally {
    base = oldBase;
    await closeServer(shortcutServer);
    await fsp.rm(tempPublic, { recursive: true, force: true });
  }
});

test('shared Markdown survives lost extensions and plain-text names without changing the body', async () => {
  const account = await store.addUser('shared-text', 'share filename test password');
  const auth = await session('shared-text', 'share filename test password');
  const issued = await issueImportToken(auth);
  const markdown = '# 阅读材料\n\n> 引用\n\n**重点** 与 [链接](https://example.com)\n';
  for (const [name, expected] of [['AI___', 'AI___.md'], ['文本文稿.txt', '文本文稿.md'], ['原稿.md.txt', '原稿.md'], ['原稿.MD', '原稿.MD'], ['.md', '.md'], ['原稿.markdown', '原稿.markdown']]) {
    const response = await importFetch(issued.token, {name, markdown});
    assert.equal(response.status, 201, name);
    const result = await response.json();
    assert.equal(result.doc.name, expected);
    assert.equal((await store.getDocument(account.user.id, result.doc.id)).markdown, markdown);
  }
  const requestId = '8'.repeat(32);
  const first = await (await importFetch(issued.token, {name:'重试', markdown, requestId})).json();
  const replay = await importFetch(issued.token, {name:'重试.md', markdown, requestId});
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).doc.id, first.doc.id);
  for (const name of ['file.pdf', 'file.docx', 'page.html', 'image.png']) {
    assert.equal((await importFetch(issued.token, {name, markdown})).status, 415, name);
  }
  for (const name of ['.', '..', 'a'.repeat(198)]) {
    assert.equal((await importFetch(issued.token, {name, markdown})).status, 400, name);
  }
  assert.equal((await importFetch(issued.token, {name:'binary', markdown:'text\u0000binary'})).status,400);
});
