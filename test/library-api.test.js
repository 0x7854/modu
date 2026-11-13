import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudStore } from '../cloud/lib/store.js';
import { createCloudServer } from '../cloud/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'cloud', 'public');
const DOC_A = 'a'.repeat(32);
const DOC_B = 'b'.repeat(32);

async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-library-api-'));
  const store = await new CloudStore(root, { maxDocBytes: 64 * 1024 }).init();
  const alice = await store.addUser('alice', 'correct horse battery');
  const bob = await store.addUser('bob', 'another good password');
  await store.upsertDocument(alice.user.id, DOC_A, { name: 'a.md', markdown: '# Alice A\n' });
  await store.upsertDocument(alice.user.id, DOC_B, { name: 'b.md', markdown: '# Alice B\n' });
  await store.upsertDocument(bob.user.id, 'c'.repeat(32), { name: 'c.md', markdown: '# Bob C\n' });

  let server = await startServer(root);
  t.after(async () => {
    await stopServer(server);
    server = null;
    await fsp.rm(root, { recursive: true, force: true });
  });
  async function restart() {
    await stopServer(server);
    server = await startServer(root);
    return server;
  }
  return {
    root,
    store,
    alice: alice.user,
    bob: bob.user,
    aliceToken: alice.syncToken,
    bobToken: bob.syncToken,
    get server() { return server; },
    get base() { return `http://127.0.0.1:${server.address().port}`; },
    restart,
  };
}

async function startServer(dataDir) {
  const instance = await createCloudServer({
    dataDir,
    publicDir,
    maxDocBytes: 64 * 1024,
    pollMs: 1000,
    loginMaxAttempts: 50,
  });
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.once('listening', resolve);
    instance.listen(0, '127.0.0.1');
  });
  return instance;
}

async function stopServer(instance) {
  if (!instance) return;
  instance.cloudShutdown();
  await new Promise((resolve) => instance.close(resolve));
}

async function login(base, username, password) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return {
    cookie: String(response.headers.get('set-cookie') || '').split(';')[0],
    csrf: payload.csrfToken,
  };
}

function apiFetch(base, pathname, {
  cookie,
  csrf,
  method = 'GET',
  body,
  headers = {},
} = {}) {
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

function syncFetch(base, token, pathname, { method = 'GET', body } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function json(response) {
  const payload = await response.json().catch(() => null);
  assert.ok(payload, `expected JSON, got status ${response.status}`);
  return payload;
}

test('cookie and Bearer library APIs are isolated, interchangeable and expose no cross-account state', async (t) => {
  const ctx = await setup(t);
  const alice = await login(ctx.base, 'alice', 'correct horse battery');
  const bob = await login(ctx.base, 'bob', 'another good password');

  assert.equal((await apiFetch(ctx.base, '/api/library')).status, 401);

  const bearerRead = await syncFetch(ctx.base, ctx.aliceToken, '/api/sync/library');
  assert.equal(bearerRead.status, 200);
  assert.equal(bearerRead.headers.get('set-cookie'), null, 'Bearer responses must not expose cookies');
  const bearerPayload = await json(bearerRead);
  assert.equal(bearerPayload.ok, true);
  assert.equal(bearerPayload.csrfToken, undefined);
  assert.equal(bearerPayload.library.revision, 0);
  assert.deepEqual(bearerPayload.documents.map((doc) => doc.id).sort(), [DOC_A, DOC_B].sort());
  assert.equal('version' in bearerPayload.library, false);

  const cookieRead = await json(await apiFetch(ctx.base, '/api/library', alice));
  assert.deepEqual(cookieRead.library, bearerPayload.library);
  assert.deepEqual(cookieRead.documents.map((doc) => doc.id).sort(), [DOC_A, DOC_B].sort());

  assert.equal(
    (await apiFetch(ctx.base, '/api/library', { headers: { Authorization: `Bearer ${ctx.aliceToken}` } })).status,
    401,
    'reader library is cookie-only',
  );
  assert.equal(
    (await syncFetch(ctx.base, ctx.aliceToken, '/api/sync/library', {})).status,
    200,
  );
  assert.equal(
    (await apiFetch(ctx.base, '/api/sync/library', alice)).status,
    401,
    'sync library is Bearer-only and must not accept a login cookie',
  );

  // Create through the cookie/CSRF path, then observe it through Bearer.
  const created = await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: 0, action: 'createFolder', name: 'Cookie folder', parentId: null },
  });
  assert.equal(created.status, 200);
  const createdPayload = await json(created);
  assert.equal(createdPayload.ok, true);
  assert.equal(createdPayload.library.revision, 1);
  const folderId = createdPayload.library.folders[0].id;
  const afterBearer = await json(await syncFetch(ctx.base, ctx.aliceToken, '/api/sync/library'));
  assert.deepEqual(afterBearer.library, createdPayload.library);

  // Create through Bearer (no CSRF, no cookie), then observe it with a cookie.
  const viaBearer = await syncFetch(ctx.base, ctx.aliceToken, '/api/sync/library', {
    method: 'PATCH',
    body: { revision: 1, action: 'createFolder', name: 'Bearer folder', parentId: folderId },
  });
  assert.equal(viaBearer.status, 200);
  assert.equal(viaBearer.headers.get('set-cookie'), null);
  const viaBearerPayload = await json(viaBearer);
  assert.equal(viaBearerPayload.library.revision, 2);
  const afterCookie = await json(await apiFetch(ctx.base, '/api/library', alice));
  assert.deepEqual(afterCookie.library, viaBearerPayload.library);

  // bootstrap and /api/documents augment existing fields with the same library.
  const bootstrap = await json(await apiFetch(ctx.base, `/api/bootstrap?doc=${DOC_A}`, alice));
  assert.equal(bootstrap.user.username, 'alice');
  assert.equal(bootstrap.doc.id, DOC_A);
  assert.deepEqual(bootstrap.library, viaBearerPayload.library);
  const documents = await json(await apiFetch(ctx.base, '/api/documents', alice));
  assert.deepEqual(documents.library, viaBearerPayload.library);
  assert.deepEqual(documents.documents.map((doc) => doc.id).sort(), [DOC_A, DOC_B].sort());

  // The other account sees only its own library and cannot mutate Alice's.
  const bobLibrary = await json(await apiFetch(ctx.base, '/api/library', bob));
  assert.equal(bobLibrary.library.revision, 0);
  assert.deepEqual(bobLibrary.library.folders, []);
  assert.deepEqual(bobLibrary.documents.map((doc) => doc.id), ['c'.repeat(32)]);

  const crossRename = await apiFetch(ctx.base, '/api/library', {
    ...bob,
    method: 'PATCH',
    body: { revision: 0, action: 'renameFolder', folderId, name: 'Stolen' },
  });
  assert.equal(crossRename.status, 404);
  assert.equal((await json(crossRename)).error.code, 'FOLDER_NOT_FOUND');

  const crossParent = await apiFetch(ctx.base, '/api/library', {
    ...bob,
    method: 'PATCH',
    body: { revision: 0, action: 'createFolder', name: 'Child', parentId: folderId },
  });
  assert.equal(crossParent.status, 404);

  const crossDoc = await apiFetch(ctx.base, '/api/library', {
    ...bob,
    method: 'PATCH',
    body: { revision: 0, action: 'moveDocument', docId: DOC_A, folderId: null },
  });
  assert.equal(crossDoc.status, 404);
  assert.equal((await json(crossDoc)).error.code, 'DOCUMENT_NOT_FOUND');

  assert.deepEqual(
    (await json(await apiFetch(ctx.base, '/api/library', alice))).library,
    viaBearerPayload.library,
    'cross-account attempts must not mutate the owner library',
  );
});

test('cookie mutations require CSRF, stale revisions conflict and concurrent edits have one winner', async (t) => {
  const ctx = await setup(t);
  const alice = await login(ctx.base, 'alice', 'correct horse battery');

  const payload = { revision: 0, action: 'createFolder', name: 'Base', parentId: null };
  const missing = await apiFetch(ctx.base, '/api/library', {
    cookie: alice.cookie,
    method: 'PATCH',
    body: payload,
  });
  assert.equal(missing.status, 403);
  assert.equal((await json(missing)).error.code, 'CSRF_REQUIRED');
  const wrong = await apiFetch(ctx.base, '/api/library', {
    cookie: alice.cookie,
    csrf: 'wrong-token',
    method: 'PATCH',
    body: payload,
  });
  assert.equal(wrong.status, 403);

  const created = await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: payload,
  });
  assert.equal(created.status, 200);
  const first = await json(created);
  assert.equal(first.library.revision, 1);

  const stale = await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: 0, action: 'createFolder', name: 'Stale', parentId: null },
  });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).error.code, 'LIBRARY_CONFLICT');
  assert.deepEqual((await json(await apiFetch(ctx.base, '/api/library', alice))).library, first.library);

  const [left, right] = await Promise.all([
    apiFetch(ctx.base, '/api/library', {
      ...alice,
      method: 'PATCH',
      body: { revision: 1, action: 'createFolder', name: 'Race A', parentId: null },
    }),
    apiFetch(ctx.base, '/api/library', {
      ...alice,
      method: 'PATCH',
      body: { revision: 1, action: 'createFolder', name: 'Race B', parentId: null },
    }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409]);
  const finalLibrary = (await json(await apiFetch(ctx.base, '/api/library', alice))).library;
  assert.equal(finalLibrary.revision, 2);
  assert.equal(finalLibrary.folders.length, 2);
  assert.equal(finalLibrary.folders.filter((folder) => folder.name.startsWith('Race')).length, 1);

  // Validation errors are reported without mutating the library.
  const before = finalLibrary;
  for (const body of [
    { revision: before.revision, action: 'notAnAction' },
    { revision: before.revision, action: 'createFolder', name: 'bad/name', parentId: null },
    { revision: before.revision, action: 'createFolder', name: 'Base', parentId: null },
    { revision: before.revision, action: 'createFolder', name: 'X', parentId: 42 },
  ]) {
    const response = await apiFetch(ctx.base, '/api/library', { ...alice, method: 'PATCH', body });
    assert.ok([400, 409].includes(response.status), `unexpected ${response.status}`);
  }
  assert.deepEqual((await json(await apiFetch(ctx.base, '/api/library', alice))).library, before);
});

test('upload preserves assignment, library revision and position while keeping the document schema', async (t) => {
  const ctx = await setup(t);
  const alice = await login(ctx.base, 'alice', 'correct horse battery');

  let library = (await json(await apiFetch(ctx.base, '/api/library', alice))).library;
  const created = await json(await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: library.revision, action: 'createFolder', name: 'Filed', parentId: null },
  }));
  library = created.library;
  const folderId = library.folders[0].id;
  library = (await json(await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: library.revision, action: 'moveDocument', docId: DOC_A, folderId },
  }))).library;
  assert.equal(library.assignments[DOC_A], folderId);
  const revisionBeforeUpload = library.revision;

  const position = await apiFetch(ctx.base, `/api/documents/${DOC_A}/position`, {
    ...alice,
    method: 'PUT',
    body: { anchor: 'b:test:0', ratio: 0.37, scrollTop: 480 },
  });
  assert.equal(position.status, 200);

  const upload = await syncFetch(ctx.base, ctx.aliceToken, `/api/sync/documents/${DOC_A}`, {
    method: 'PUT',
    body: { name: 'renamed.md', markdown: '# Alice A v2\n' },
  });
  assert.equal(upload.status, 200);
  assert.equal((await json(upload)).doc.revision, 2);

  const after = (await json(await apiFetch(ctx.base, '/api/library', alice))).library;
  assert.deepEqual(after, library, 'upload must not alter folder organization or library revision');
  assert.equal(after.revision, revisionBeforeUpload);
  assert.equal(after.assignments[DOC_A], folderId);

  const doc = await json(await apiFetch(ctx.base, `/api/documents/${DOC_A}`, alice));
  assert.equal(doc.doc.revision, 2);
  assert.equal(doc.doc.name, 'renamed.md');
  assert.equal(doc.doc.position.ratio, 0.37);
  assert.equal(doc.doc.position.anchor, 'b:test:0');
  assert.equal(doc.doc.markdown, '# Alice A v2\n');

  const list = await json(await apiFetch(ctx.base, '/api/documents', alice));
  for (const summary of list.documents) {
    assert.deepEqual(
      Object.keys(summary).sort(),
      ['id', 'kind', 'name', 'positionUpdatedAt', 'revision', 'size', 'updatedAt'],
    );
  }
  // Sync document list keeps its original payload; folders live on /api/sync/library.
  const syncList = await json(await syncFetch(ctx.base, ctx.aliceToken, '/api/sync/documents'));
  assert.equal(syncList.library, undefined);
  assert.equal(syncList.documents.find((entry) => entry.id === DOC_A).revision, 2);
});

test('deleting a folder reparents children/docs, never deletes documents and survives restart', async (t) => {
  const ctx = await setup(t);
  const alice = await login(ctx.base, 'alice', 'correct horse battery');

  let library = (await json(await apiFetch(ctx.base, '/api/library', alice))).library;
  library = (await json(await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: library.revision, action: 'createFolder', name: 'Parent', parentId: null },
  }))).library;
  const parent = library.folders[0];
  library = (await json(await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: library.revision, action: 'createFolder', name: 'Child', parentId: parent.id },
  }))).library;
  const child = library.folders.find((folder) => folder.name === 'Child');
  library = (await json(await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: library.revision, action: 'moveDocument', docId: DOC_B, folderId: child.id },
  }))).library;
  assert.equal(library.assignments[DOC_B], child.id);

  const deleted = await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: library.revision, action: 'deleteFolder', folderId: parent.id },
  });
  assert.equal(deleted.status, 200);
  const firstDelete = await json(deleted);
  assert.deepEqual(
    firstDelete.library.folders,
    [{ id: child.id, name: 'Child', parentId: null }],
    'direct children are reparented to the deleted folder parent',
  );
  assert.equal(
    firstDelete.library.assignments[DOC_B],
    child.id,
    'documents assigned to a surviving child stay there',
  );
  assert.deepEqual(
    firstDelete.documents.map((doc) => doc.id).sort(),
    [DOC_A, DOC_B].sort(),
    'documents are not deleted with their folder',
  );

  const cleared = await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: firstDelete.library.revision, action: 'deleteFolder', folderId: child.id },
  });
  assert.equal(cleared.status, 200);
  const afterDelete = await json(cleared);
  assert.equal(afterDelete.library.folders.length, 0);
  assert.equal(afterDelete.library.assignments[DOC_B], undefined, 'root/unfiled is an absent assignment');
  assert.deepEqual(afterDelete.documents.map((doc) => doc.id).sort(), [DOC_A, DOC_B].sort());

  // A new server process on the same data directory sees the committed library.
  await ctx.restart();
  const aliceAfterRestart = await login(ctx.base, 'alice', 'correct horse battery');
  const persisted = await json(await apiFetch(ctx.base, '/api/library', aliceAfterRestart));
  assert.deepEqual(persisted.library, afterDelete.library);
  assert.deepEqual(persisted.documents.map((doc) => doc.id).sort(), [DOC_A, DOC_B].sort());
  assert.equal(
    (await json(await apiFetch(ctx.base, `/api/documents/${DOC_B}`, aliceAfterRestart))).doc.id,
    DOC_B,
  );
});

test('corrupt library data returns a fail-closed 500 through HTTP without leaking paths', async (t) => {
  const ctx = await setup(t);
  const alice = await login(ctx.base, 'alice', 'correct horse battery');
  const created = await json(await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: 0, action: 'createFolder', name: 'Keep', parentId: null },
  }));
  assert.equal(created.library.revision, 1);

  const file = path.join(ctx.root, 'libraries', `${ctx.alice.id}.json`);
  const corrupt = '{"version":1,"revision":1,"folders":';
  await fsp.writeFile(file, corrupt, 'utf8');

  const response = await apiFetch(ctx.base, '/api/library', alice);
  assert.equal(response.status, 500);
  const payload = await json(response);
  assert.equal(payload.error.code, 'LIBRARY_CORRUPT');
  assert.equal(JSON.stringify(payload).includes(ctx.root), false, 'filesystem paths must not leak');
  assert.equal(await fsp.readFile(file, 'utf8'), corrupt, 'corruption must not be silently reset');

  const conflictOrCorrupt = await apiFetch(ctx.base, '/api/library', {
    ...alice,
    method: 'PATCH',
    body: { revision: 1, action: 'createFolder', name: 'Reset', parentId: null },
  });
  assert.equal(conflictOrCorrupt.status, 500);
  assert.equal((await json(conflictOrCorrupt)).error.code, 'LIBRARY_CORRUPT');
});
