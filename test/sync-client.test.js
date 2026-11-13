import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../cloud/server.js';
import { CloudStore } from '../cloud/lib/store.js';

const require = createRequire(import.meta.url);
const {
  CloudSync,
  normalizeServerUrl,
  validateSyncToken,
} = require('../electron/cloud-sync.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'cloud', 'public');

let tmpRoot;
let dataDir;
let store;
let server;
let base;
let syncToken;
let user;

async function waitFor(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out; last=${JSON.stringify(last)}`);
}

async function serverDocuments() {
  const response = await fetch(`${base}/api/sync/documents`, {
    headers: { Authorization: `Bearer ${syncToken}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).documents;
}

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-sync-test-'));
  dataDir = path.join(tmpRoot, 'data');
  store = await new CloudStore(dataDir).init();
  const created = await store.addUser('syncuser', 'correct horse battery');
  user = created.user;
  syncToken = created.syncToken;
  server = await createCloudServer({
    dataDir,
    publicDir,
    maxDocBytes: 2 * 1024 * 1024,
    pollMs: 1000,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(0, '127.0.0.1');
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.cloudShutdown();
    await new Promise((resolve) => server.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('server URL rejects public plaintext HTTP and embedded credentials', () => {
  assert.throws(() => normalizeServerUrl('http://example.com'), /HTTPS/);
  assert.throws(() => normalizeServerUrl('http://192.0.2.10:4680'), /HTTPS/);
  assert.throws(() => normalizeServerUrl('https://user:pass@example.com'), /用户名或密码/);
  assert.throws(() => normalizeServerUrl('ftp://example.com'), /HTTPS/);
  assert.equal(normalizeServerUrl('http://localhost:4680/'), 'http://localhost:4680');
  assert.equal(normalizeServerUrl('http://127.0.0.1:4680'), 'http://127.0.0.1:4680');
  assert.equal(normalizeServerUrl('https://md.example.com/'), 'https://md.example.com');
  assert.throws(() => validateSyncToken('short'), /长度/);
});

test('credentials are saved only in a private local file and never exposed in state', async () => {
  const profile = path.join(tmpRoot, 'profile-credentials');
  const sync = new CloudSync({ userDataDir: profile, debounceMs: 300 });
  await sync.init();
  try {
    const before = sync.getState();
    assert.equal(before.configured, false);
    assert.equal(JSON.stringify(before).includes(syncToken), false);

    await assert.rejects(
      sync.saveSettings({ serverUrl: base, token: 'x'.repeat(43) }),
      /同步令牌无效|401/,
    );
    assert.equal(sync.getState().configured, false);

    await sync.saveSettings({ serverUrl: base, token: syncToken });
    const state = sync.getState();
    assert.equal(state.configured, true);
    assert.equal(state.hasToken, true);
    assert.equal(state.serverUser, 'syncuser');
    const serialized = JSON.stringify(state);
    assert.equal(serialized.includes(syncToken), false);
    assert.doesNotMatch(serialized, /"syncToken"|"token"/);

    const stat = await fsp.stat(path.join(profile, 'cloud-sync.json'));
    assert.equal(stat.mode & 0o777, 0o600);
    const saved = await fsp.readFile(path.join(profile, 'cloud-sync.json'), 'utf8');
    assert.match(saved, /"syncToken"/);
    assert.ok(saved.includes(syncToken), 'the private local file is the one place the token lives');
  } finally {
    sync.dispose();
  }
});

test('only explicitly added Markdown is uploaded; other local files stay local', async () => {
  const profile = path.join(tmpRoot, 'profile-explicit');
  const docs = path.join(tmpRoot, 'explicit-docs');
  await fsp.mkdir(docs, { recursive: true });
  const added = path.join(docs, 'added.md');
  const notAdded = path.join(docs, 'not-added.md');
  const textFile = path.join(docs, 'secret.txt');
  await fsp.writeFile(added, '# Added\n\nonly this one\n');
  await fsp.writeFile(notAdded, '# Not added\n\nnever upload me\n');
  await fsp.writeFile(textFile, 'plain text secret');

  const sync = new CloudSync({ userDataDir: profile, debounceMs: 300 });
  await sync.init();
  try {
    await sync.saveSettings({ serverUrl: base, token: syncToken });
    await sync.addPath(added);
    const state = sync.getState();
    assert.equal(state.documents.length, 1);
    assert.equal(state.documents[0].path, added);
    assert.equal(state.documents[0].status, 'synced');

    const afterAdd = await serverDocuments();
    assert.equal(afterAdd.some((doc) => doc.name === 'added.md'), true);
    assert.equal(afterAdd.some((doc) => doc.name === 'not-added.md'), false);

    await assert.rejects(() => sync.addPath(textFile), /只支持/);
    await assert.rejects(() => sync.addPath(notAdded + '.missing.md'), /不存在/);
    const afterRejected = await serverDocuments();
    assert.equal(afterRejected.some((doc) => doc.name === 'not-added.md'), false);
    assert.equal(afterRejected.some((doc) => doc.name === 'secret.txt'), false);
  } finally {
    sync.dispose();
  }
});

test('debounced file changes upload, manual sync works, and removal keeps cloud copy', async () => {
  const profile = path.join(tmpRoot, 'profile-watch');
  const docs = path.join(tmpRoot, 'watch-docs');
  await fsp.mkdir(docs, { recursive: true });
  const file = path.join(docs, 'watched.md');
  await fsp.writeFile(file, '# Watch\n\nfirst version\n');

  const sync = new CloudSync({ userDataDir: profile, debounceMs: 250 });
  await sync.init();
  try {
    await sync.saveSettings({ serverUrl: base, token: syncToken });
    await sync.addPath(file);
    const first = await serverDocuments();
    const firstDoc = first.find((doc) => doc.name === 'watched.md');
    assert.ok(firstDoc);

    await fsp.writeFile(file, '# Watch\n\nsecond version via debounce\n');
    const changed = await waitFor(async () => {
      const docsNow = await serverDocuments();
      const doc = docsNow.find((entry) => entry.name === 'watched.md');
      return doc && doc.revision > firstDoc.revision ? doc : null;
    });
    assert.ok(changed.revision > firstDoc.revision);

    const manual = await sync.syncAll({ reason: 'manual' });
    assert.equal(manual.documents[0].status, 'synced');

    await sync.removePath(file);
    assert.equal(sync.getState().documents.length, 0);
    const stillCloud = await serverDocuments();
    assert.equal(stillCloud.some((doc) => doc.name === 'watched.md'), true, 'cloud copy is preserved');
  } finally {
    sync.dispose();
  }
});

test('a change made during a slow upload is retried and the final content reaches cloud', async () => {
  const profile = path.join(tmpRoot, 'profile-dirty');
  const docs = path.join(tmpRoot, 'dirty-docs');
  await fsp.mkdir(docs, { recursive: true });
  const file = path.join(docs, 'slow-final.md');
  await fsp.writeFile(file, '# Slow\n\nfirst body\n');

  const realFetch = globalThis.fetch;
  let firstPutStartedResolve;
  const firstPutStarted = new Promise((resolve) => { firstPutStartedResolve = resolve; });
  let putCount = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'PUT' && putCount++ === 0) {
      firstPutStartedResolve();
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return realFetch(url, init);
  };

  const sync = new CloudSync({
    userDataDir: profile,
    fetchImpl,
    debounceMs: 200,
  });
  await sync.init();
  try {
    await sync.saveSettings({ serverUrl: base, token: syncToken });
    const adding = sync.addPath(file);
    await firstPutStarted;
    await fsp.writeFile(file, '# Slow\n\nfinal body after slow upload\n');
    await adding;

    const docId = crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32);
    const finalDoc = await waitFor(async () => {
      const doc = await store.getDocument(user.id, docId);
      return doc.markdown.includes('final body after slow upload') && doc.revision >= 2
        ? doc
        : null;
    }, 8000);
    assert.ok(finalDoc.revision >= 2);
    assert.ok(putCount >= 2, `expected a dirty retry PUT, saw ${putCount}`);
    assert.equal(sync.getState().documents[0].status, 'synced');
  } finally {
    sync.dispose();
  }
});

test('removing a document during a slow upload does not revive it', async () => {
  const profile = path.join(tmpRoot, 'profile-remove-dirty');
  const docs = path.join(tmpRoot, 'remove-dirty-docs');
  await fsp.mkdir(docs, { recursive: true });
  const file = path.join(docs, 'remove-slow.md');
  await fsp.writeFile(file, '# Remove\n\nfirst body\n');

  const realFetch = globalThis.fetch;
  let firstPutStartedResolve;
  const firstPutStarted = new Promise((resolve) => { firstPutStartedResolve = resolve; });
  let putCount = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'PUT' && putCount++ === 0) {
      firstPutStartedResolve();
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    return realFetch(url, init);
  };

  const sync = new CloudSync({
    userDataDir: profile,
    fetchImpl,
    debounceMs: 150,
  });
  await sync.init();
  try {
    await sync.saveSettings({ serverUrl: base, token: syncToken });
    const adding = sync.addPath(file);
    await firstPutStarted;
    // Change during the upload to set the dirty flag, then remove the entry.
    await fsp.writeFile(file, '# Remove\n\nchanged but removed while uploading\n');
    await new Promise((resolve) => setTimeout(resolve, 260));
    await sync.removePath(file);
    await adding;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(sync.getState().documents.length, 0);
    assert.equal(putCount, 1, 'removed document must not be uploaded a second time');
  } finally {
    sync.dispose();
  }
});


test('symlink and wrong-token sync are rejected without leaking paths', async () => {
  const profile = path.join(tmpRoot, 'profile-safety');
  const docs = path.join(tmpRoot, 'safety-docs');
  await fsp.mkdir(docs, { recursive: true });
  const target = path.join(docs, 'target.md');
  const link = path.join(docs, 'link.md');
  await fsp.writeFile(target, '# target\n');
  await fsp.symlink(target, link);

  const sync = new CloudSync({ userDataDir: profile, debounceMs: 300 });
  await sync.init();
  try {
    await assert.rejects(() => sync.addPath(link), /符号链接/);
    assert.equal(sync.getState().documents.length, 0);

    await assert.rejects(
      sync.saveSettings({ serverUrl: base, token: 'x'.repeat(43) }),
      /同步令牌无效|401/,
    );
    assert.equal(sync.getState().configured, false);
  } finally {
    sync.dispose();
  }
});
