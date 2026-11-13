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
