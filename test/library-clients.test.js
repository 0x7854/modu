import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  CloudSync,
  normalizeLibraryMutation,
} = require('../electron/cloud-sync.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const TOKEN = 'library-test-token-0123456789abcdef';

let tmpRoot;
let server;
let base;
let mock;
let requestRecords = [];

function libraryPayload() {
  return {
    revision: mock.revision,
    folders: mock.folders.map((folder) => ({ ...folder })),
    assignments: { ...mock.assignments },
  };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function resetMock() {
  mock = {
    revision: 3,
    folders: [
      { id: 'f-project', name: '项目', parentId: null },
      { id: 'f-child', name: '子目录', parentId: 'f-project' },
    ],
    assignments: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 'f-child' },
    documents: [
      {
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'remote-only.md',
        kind: 'markdown',
        revision: 2,
        size: 42,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    conflictOnce: false,
  };
  requestRecords = [];
}

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-library-clients-'));
  resetMock();
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const record = {
        method: req.method,
        pathname: url.pathname,
        authorization: req.headers.authorization || '',
        cookie: req.headers.cookie || '',
        csrf: req.headers['x-csrf-token'] || '',
        body: null,
      };
      requestRecords.push(record);

      if (url.pathname === '/api/sync/ping' && req.method === 'GET') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '未授权。' } });
        }
        return sendJson(res, 200, { ok: true, user: { username: 'alice' } });
      }

      if (url.pathname === '/api/sync/library') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '未授权。' } });
        }
        if (req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            library: libraryPayload(),
            documents: mock.documents,
          });
        }
        if (req.method === 'PATCH') {
          const body = await readJson(req);
          record.body = body;
          if (mock.conflictOnce) {
            mock.conflictOnce = false;
            return sendJson(res, 409, {
              ok: false,
              error: { code: 'LIBRARY_CONFLICT', message: '文库已被其他设备更新。' },
            });
          }
          if (body.revision !== mock.revision) {
            return sendJson(res, 409, {
              ok: false,
              error: { code: 'LIBRARY_CONFLICT', message: '文库已被其他设备更新。' },
            });
          }
          if (body.action === 'createFolder') {
            mock.folders.push({
              id: `f-created-${mock.folders.length}`,
              name: body.name,
              parentId: body.parentId || null,
            });
          } else if (body.action === 'renameFolder') {
            const folder = mock.folders.find((entry) => entry.id === body.folderId);
            if (!folder) {
              return sendJson(res, 404, { ok: false, error: { code: 'FOLDER_NOT_FOUND', message: '文件夹不存在。' } });
            }
            folder.name = body.name;
          } else if (body.action === 'moveFolder') {
            const folder = mock.folders.find((entry) => entry.id === body.folderId);
            if (!folder) {
              return sendJson(res, 404, { ok: false, error: { code: 'FOLDER_NOT_FOUND', message: '文件夹不存在。' } });
            }
            folder.parentId = body.parentId || null;
          } else if (body.action === 'deleteFolder') {
            const folder = mock.folders.find((entry) => entry.id === body.folderId);
            if (!folder) {
              return sendJson(res, 404, { ok: false, error: { code: 'FOLDER_NOT_FOUND', message: '文件夹不存在。' } });
            }
            const parentId = folder.parentId || null;
            mock.folders = mock.folders
              .filter((entry) => entry.id !== body.folderId)
              .map((entry) => (entry.parentId === body.folderId ? { ...entry, parentId } : entry));
            for (const [docId, folderId] of Object.entries(mock.assignments)) {
              if (folderId === body.folderId) mock.assignments[docId] = parentId;
            }
          } else if (body.action === 'moveDocument') {
            if (body.folderId === null) delete mock.assignments[body.docId];
            else mock.assignments[body.docId] = body.folderId;
          } else {
            return sendJson(res, 400, { ok: false, error: { code: 'INVALID_ACTION', message: '操作无效。' } });
          }
          mock.revision += 1;
          return sendJson(res, 200, {
            ok: true,
            library: libraryPayload(),
            documents: mock.documents,
          });
        }
      }

      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '不存在。' } });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: { code: 'MOCK_ERROR', message: error.message } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  resetMock();
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function configuredSync(profileName) {
  const profile = path.join(tmpRoot, profileName);
  const sync = new CloudSync({ userDataDir: profile });
  await sync.init();
  await sync.saveSettings({ serverUrl: base, token: TOKEN });
  requestRecords = [];
  return { sync, profile };
}

test('CloudSync.getLibrary uses Bearer only and exposes all online documents', async () => {
  const { sync } = await configuredSync('profile-get');
  try {
    const result = await sync.getLibrary();
    assert.equal(result.ok, true);
    assert.equal(result.library.revision, 3);
    assert.deepEqual(result.library.folders.map((folder) => folder.name), ['项目', '子目录']);
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].name, 'remote-only.md');

    const request = requestRecords.find((entry) => entry.pathname === '/api/sync/library');
    assert.equal(request.method, 'GET');
    assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.cookie, '', 'the sync client must not send a browser cookie');
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(JSON.stringify(sync.getState()).includes(TOKEN), false);
    assert.doesNotMatch(JSON.stringify(sync.getState()), /"syncToken"|"token"/);
  } finally {
    sync.dispose();
  }
});

test('CloudSync.mutateLibrary sends only the narrow contract payload and returns server truth', async () => {
  const { sync } = await configuredSync('profile-mutate');
  try {
    const result = await sync.mutateLibrary({
      action: 'createFolder',
      revision: 3,
      name: '新文件夹',
      parentId: null,
      // These must never be forwarded as part of a library action.
      token: TOKEN,
      url: 'https://attacker.example/',
    });
    assert.equal(result.library.revision, 4);
    assert.equal(result.library.folders.some((folder) => folder.name === '新文件夹'), true);
    const patch = requestRecords.find((entry) => entry.method === 'PATCH');
    assert.deepEqual(patch.body, {
      action: 'createFolder',
      revision: 3,
      name: '新文件夹',
      parentId: null,
    });
    assert.equal(patch.authorization, `Bearer ${TOKEN}`);
    assert.equal(patch.cookie, '');

    await assert.rejects(
      () => sync.mutateLibrary({ action: 'deleteEverything', revision: 4 }),
      /不支持的文件夹操作/,
    );
    await assert.rejects(
      () => sync.mutateLibrary({ action: 'createFolder', revision: 4, name: 'a/b', parentId: null }),
      /斜杠/,
    );
    assert.equal(requestRecords.filter((entry) => entry.method === 'PATCH').length, 1);
  } finally {
    sync.dispose();
  }
});

test('409 LIBRARY_CONFLICT is surfaced once and never silently replayed', async () => {
  const { sync } = await configuredSync('profile-conflict');
  try {
    mock.conflictOnce = true;
    let error;
    try {
      await sync.mutateLibrary({
        action: 'moveDocument',
        revision: 3,
        docId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        folderId: null,
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.code, 'LIBRARY_CONFLICT');
    assert.equal(error.status, 409);
    assert.equal(requestRecords.filter((entry) => entry.method === 'PATCH').length, 1);
    assert.equal(sync.getState().documents.length, 0);

    const latest = await sync.getLibrary();
    assert.equal(latest.library.revision, 3);
    assert.equal(requestRecords.filter((entry) => entry.pathname === '/api/sync/library').length, 2);
  } finally {
    sync.dispose();
  }
});

test('library folder state stays on the server and is never written into local sync config', async () => {
  const { sync, profile } = await configuredSync('profile-config');
  try {
    await sync.getLibrary();
    await sync.mutateLibrary({
      action: 'renameFolder',
      revision: 3,
      folderId: 'f-project',
      name: '改名后的项目',
    });
    const raw = await fsp.readFile(path.join(profile, 'cloud-sync.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.equal(saved.version, 1);
    assert.equal('library' in saved, false);
    assert.equal('folders' in saved, false);
    assert.equal('assignments' in saved, false);
    assert.equal(Array.isArray(saved.documents), true);
    assert.equal(raw.includes('改名后的项目'), false);
    assert.equal(raw.includes(TOKEN), true, 'the token remains in the private main-process file');
  } finally {
    sync.dispose();
  }
});

test('library mutation normalization enforces revision, action and field shapes', () => {
  assert.deepEqual(
    normalizeLibraryMutation({ action: 'moveDocument', revision: 0, docId: 'doc-1', folderId: null }),
    { action: 'moveDocument', revision: 0, docId: 'doc-1', folderId: null },
  );
  assert.deepEqual(
    normalizeLibraryMutation({ action: 'createFolder', revision: 2, name: '  trimmed  ', parentId: '' }),
    { action: 'createFolder', revision: 2, name: 'trimmed', parentId: null },
  );
  assert.throws(
    () => normalizeLibraryMutation({ action: 'createFolder', revision: -1, name: 'x' }),
    /版本无效/,
  );
  assert.throws(
    () => normalizeLibraryMutation({ action: 'createFolder', revision: 1, name: '   ' }),
    /1 到 80/,
  );
  assert.throws(
    () => normalizeLibraryMutation({ action: 'moveFolder', revision: 1, folderId: 'bad\nid', parentId: null }),
    /folderId 无效/,
  );
});

test('main and preload expose only sender-checked library IPC without credentials', async () => {
  const [mainSource, preloadSource, syncSource] = await Promise.all([
    fsp.readFile(path.join(projectRoot, 'electron', 'main.cjs'), 'utf8'),
    fsp.readFile(path.join(projectRoot, 'electron', 'preload.cjs'), 'utf8'),
    fsp.readFile(path.join(projectRoot, 'electron', 'cloud-sync.cjs'), 'utf8'),
  ]);
  assert.match(mainSource, /ipcMain\.handle\('modu:library-get', async \(event\) => \{\s*requireMainSender\(event\)/);
  assert.match(mainSource, /ipcMain\.handle\('modu:library-mutate', async \(event, payload\) => \{\s*requireMainSender\(event\)/);
  assert.match(preloadSource, /getLibrary\(\)/);
  assert.match(preloadSource, /mutateLibrary\(payload\)/);
  assert.doesNotMatch(preloadSource, /syncToken|Authorization|Bearer/);
  assert.doesNotMatch(preloadSource, /ipcRenderer\.invoke\([^'"]/);
  assert.match(syncSource, /\/api\/sync\/library/);
  assert.doesNotMatch(syncSource, /config\.(library|folders|assignments)\s*=/);
});
