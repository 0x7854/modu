import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderServer } from '../lib/reader-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const cloudPublicDir = path.join(projectRoot, 'cloud', 'public');

let playwright = null;
try {
  playwright = await import('playwright');
} catch {
  playwright = null;
}
const chromiumPath = playwright?.chromium?.executablePath?.() || '';
const webkitPath = playwright?.webkit?.executablePath?.() || '';
const chromiumReady = Boolean(chromiumPath && await fsp.access(chromiumPath).then(() => true).catch(() => false));
const webkitReady = Boolean(webkitPath && await fsp.access(webkitPath).then(() => true).catch(() => false));
const canRun = Boolean(playwright && (chromiumReady || webkitReady));

const ALPHA = 'a'.repeat(32);
const REMOTE = 'b'.repeat(32);
const WIDGET = 'c'.repeat(32);
const CSRF = 'test-csrf-token';

const DOCUMENTS = [
  {
    id: ALPHA,
    name: 'alpha.md',
    kind: 'markdown',
    revision: 2,
    size: 900,
    updatedAt: '2026-02-01T08:00:00.000Z',
    markdown: '# Alpha\n\nALPHA_BODY',
  },
  {
    id: REMOTE,
    name: '仅云端.md',
    kind: 'markdown',
    revision: 3,
    size: 1200,
    updatedAt: '2026-02-02T08:00:00.000Z',
    markdown: '# Remote only\n\nREMOTE_ONLY_BODY',
  },
  {
    id: WIDGET,
    name: 'widget.html',
    kind: 'html',
    revision: 1,
    size: 1600,
    updatedAt: '2026-02-03T08:00:00.000Z',
    html: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<style>body{margin:0;padding:20px;font:16px sans-serif}button{padding:14px 18px}</style></head>'
      + '<body><h1>交互页</h1><button id="counter">0</button>'
      + '<script>let n=0;document.querySelector("#counter").onclick=()=>document.querySelector("#counter").textContent=++n;'
      + 'parent.postMessage({type:"modu-preview-ready"},"*");</script></body></html>',
  },
];

function publicDoc(doc) {
  return {
    id: doc.id,
    name: doc.name,
    kind: doc.kind,
    revision: doc.revision,
    size: doc.size,
    updatedAt: doc.updatedAt,
  };
}

function fullDoc(doc) {
  const base = { ...publicDoc(doc), position: null };
  if (doc.kind === 'html') return { ...base, previewUrl: `/api/documents/${doc.id}/preview` };
  return { ...base, markdown: doc.markdown };
}

function libraryJson(cloud) {
  return {
    revision: cloud.library.revision,
    folders: cloud.library.folders.map((folder) => ({ ...folder })),
    assignments: { ...cloud.library.assignments },
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function resetCloudMock(cloud) {
  cloud.library = {
    revision: 5,
    folders: [
      { id: 'f-project', name: '项目', parentId: null },
      { id: 'f-child', name: '子目录', parentId: 'f-project' },
      { id: 'f-empty', name: '空文件夹', parentId: null },
    ],
    assignments: { [ALPHA]: 'f-project', [REMOTE]: 'f-child' },
  };
  cloud.requests = [];
  cloud.previewRequests = 0;
  cloud.conflictOnce = false;
  cloud.created = 0;
}

function applyCloudMutation(cloud, body) {
  if (body.action === 'createFolder') {
    cloud.created += 1;
    const folder = {
      id: `f-created-${cloud.created}`,
      name: body.name,
      parentId: body.parentId || null,
    };
    cloud.library.folders.push(folder);
  } else if (body.action === 'renameFolder') {
    const folder = cloud.library.folders.find((entry) => entry.id === body.folderId);
    if (!folder) return false;
    folder.name = body.name;
  } else if (body.action === 'moveFolder') {
    const folder = cloud.library.folders.find((entry) => entry.id === body.folderId);
    if (!folder) return false;
    folder.parentId = body.parentId || null;
  } else if (body.action === 'deleteFolder') {
    const folder = cloud.library.folders.find((entry) => entry.id === body.folderId);
    if (!folder) return false;
    const parentId = folder.parentId || null;
    cloud.library.folders = cloud.library.folders
      .filter((entry) => entry.id !== body.folderId)
      .map((entry) => (entry.parentId === body.folderId ? { ...entry, parentId } : entry));
    for (const [docId, folderId] of Object.entries(cloud.library.assignments)) {
      if (folderId === body.folderId) {
        if (parentId) cloud.library.assignments[docId] = parentId;
        else delete cloud.library.assignments[docId];
      }
    }
  } else if (body.action === 'moveDocument') {
    if (!DOCUMENTS.some((doc) => doc.id === body.docId)) return false;
    if (body.folderId) {
      if (!cloud.library.folders.some((folder) => folder.id === body.folderId)) return false;
      cloud.library.assignments[body.docId] = body.folderId;
    } else {
      delete cloud.library.assignments[body.docId];
    }
  } else {
    return false;
  }
  cloud.library.revision += 1;
  return true;
}

let tmpRoot;
let cloud;
let cloudServer;
let cloudBase;
let readerTemplate;
let readerServer;
let readerBase;
let cloudBrowser;
let macBrowser;

const staticCache = new Map();

async function staticFile(pathname) {
  if (staticCache.has(pathname)) return staticCache.get(pathname);
  const map = {
    '/cloud.css': ['cloud.css', 'text/css; charset=utf-8'],
    '/cloud.js': ['cloud.js', 'text/javascript; charset=utf-8'],
    '/vendor/markdown-it.min.js': ['vendor/markdown-it.min.js', 'text/javascript; charset=utf-8'],
    '/vendor/purify.min.js': ['vendor/purify.min.js', 'text/javascript; charset=utf-8'],
    '/favicon.svg': ['icons/favicon.svg', 'image/svg+xml; charset=utf-8'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  };
  const entry = map[pathname];
  if (!entry) return null;
  const value = {
    body: await fsp.readFile(path.join(cloudPublicDir, entry[0])),
    type: entry[1],
  };
  staticCache.set(pathname, value);
  return value;
}

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-library-ui-'));
  cloud = {};
  resetCloudMock(cloud);
  readerTemplate = (await fsp.readFile(path.join(cloudPublicDir, 'index.html'), 'utf8'))
    .replaceAll('__MODU_POLL_MS__', '60000')
    .replaceAll('__MODU_VERSION__', 'library-ui-test');

  cloudServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        const record = {
          method: req.method,
          pathname,
          csrf: req.headers['x-csrf-token'] || '',
          body: null,
        };
        cloud.requests.push(record);

        if (pathname === '/api/bootstrap' && req.method === 'GET') {
          const preferred = url.searchParams.get('doc');
          const selected = DOCUMENTS.find((doc) => doc.id === preferred) || DOCUMENTS[0];
          return sendJson(res, 200, {
            ok: true,
            user: { id: 'user-alice', username: 'alice' },
            csrfToken: CSRF,
            expiresAt: '2099-01-01T00:00:00.000Z',
            documents: DOCUMENTS.map(publicDoc),
            doc: fullDoc(selected),
            library: libraryJson(cloud),
          });
        }

        if (pathname === '/api/documents' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            documents: DOCUMENTS.map(publicDoc),
            library: libraryJson(cloud),
          });
        }

        if (pathname === '/api/library') {
          if (req.method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              library: libraryJson(cloud),
              documents: DOCUMENTS.map(publicDoc),
            });
          }
          if (req.method === 'PATCH') {
            if (req.headers['x-csrf-token'] !== CSRF) {
              return sendJson(res, 403, {
                ok: false,
                error: { code: 'CSRF_REQUIRED', message: '缺少 CSRF。' },
              });
            }
            const body = await readJson(req);
            record.body = body;
            if (cloud.conflictOnce) {
              cloud.conflictOnce = false;
              return sendJson(res, 409, {
                ok: false,
                error: { code: 'LIBRARY_CONFLICT', message: '文库已被其他设备更新。' },
              });
            }
            if (body.revision !== cloud.library.revision) {
              return sendJson(res, 409, {
                ok: false,
                error: { code: 'LIBRARY_CONFLICT', message: '文库已被其他设备更新。' },
              });
            }
            if (!applyCloudMutation(cloud, body)) {
              return sendJson(res, 400, {
                ok: false,
                error: { code: 'INVALID_ACTION', message: '文件夹操作无效。' },
              });
            }
            return sendJson(res, 200, {
              ok: true,
              library: libraryJson(cloud),
              documents: DOCUMENTS.map(publicDoc),
            });
          }
        }

        const previewMatch = pathname.match(/^\/api\/documents\/([a-f0-9]{32})\/preview$/);
        if (previewMatch && req.method === 'GET') {
          const doc = DOCUMENTS.find((entry) => entry.id === previewMatch[1]);
          if (!doc || doc.kind !== 'html') return sendJson(res, 404, { ok: false });
          cloud.previewRequests += 1;
          const body = Buffer.from(doc.html, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          });
          res.end(body);
          return;
        }

        const positionMatch = pathname.match(/^\/api\/documents\/([a-f0-9]{32})\/position$/);
        if (positionMatch && req.method === 'PUT') {
          return sendJson(res, 200, { ok: true, position: await readJson(req) });
        }

        const docMatch = pathname.match(/^\/api\/documents\/([a-f0-9]{32})$/);
        if (docMatch && req.method === 'GET') {
          const doc = DOCUMENTS.find((entry) => entry.id === docMatch[1]);
          if (!doc) return sendJson(res, 404, { ok: false, error: { code: 'DOCUMENT_NOT_FOUND', message: '不存在。' } });
          const etag = `"rev-${doc.revision}"`;
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { ETag: etag });
            res.end();
            return;
          }
          return sendJson(res, 200, { ok: true, doc: fullDoc(doc) }, { ETag: etag });
        }

        if (pathname === '/api/logout' && req.method === 'POST') {
          return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '不存在。' } });
      }

      if (pathname === '/' || pathname === '/index.html') {
        const body = Buffer.from(readerTemplate, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-cache',
        });
        res.end(body);
        return;
      }

      if (pathname === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end('');
        return;
      }

      const asset = await staticFile(pathname);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Content-Length': asset.body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(asset.body);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: { code: 'MOCK_ERROR', message: error.message } });
    }
  });
  await new Promise((resolve, reject) => {
    cloudServer.once('error', reject);
    cloudServer.listen(0, '127.0.0.1', resolve);
  });
  cloudBase = `http://127.0.0.1:${cloudServer.address().port}`;

  const samplePath = path.join(tmpRoot, 'welcome.md');
  await fsp.writeFile(samplePath, '# 示例\n\nLOCAL_SAMPLE_BODY\n');
  readerServer = createReaderServer({
    rootDir: projectRoot,
    samplePath,
    pollMs: 500,
  });
  await new Promise((resolve, reject) => {
    readerServer.once('error', reject);
    readerServer.listen(0, '127.0.0.1', resolve);
  });
  readerBase = `http://127.0.0.1:${readerServer.address().port}`;

  if (webkitReady) {
    cloudBrowser = await playwright.webkit.launch({ headless: true });
  } else {
    cloudBrowser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }
  macBrowser = chromiumReady
    ? await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] })
    : cloudBrowser;
});

after(async () => {
  if (macBrowser && macBrowser !== cloudBrowser) await macBrowser.close().catch(() => {});
  if (cloudBrowser) await cloudBrowser.close().catch(() => {});
  if (readerServer) {
    readerServer.readerShutdown();
    await new Promise((resolve) => readerServer.close(resolve));
  }
  if (cloudServer) await new Promise((resolve) => cloudServer.close(resolve));
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function openCloudPage() {
  const context = await cloudBrowser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: false,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${cloudBase}/#doc-${WIDGET}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
  const frame = page.frameLocator('#html-frame');
  await frame.locator('#counter').waitFor({ timeout: 15000 });
  await page.locator('#doc-loading').waitFor({ state: 'hidden', timeout: 15000 });
  return { context, page, errors, frame };
}

test(`iPad cloud folders ${webkitReady ? 'WebKit' : 'Chromium'}: nested browse preserves HTML, move dialog, conflict, folder lifecycle`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 90000,
}, async () => {
  resetCloudMock(cloud);
  const { context, page, errors, frame } = await openCloudPage();
  try {
    await frame.locator('#counter').click();
    assert.equal(await frame.locator('#counter').textContent(), '1');
    await page.evaluate(() => { document.querySelector('#html-frame').dataset.keep = 'yes'; });
    const previewBefore = cloud.previewRequests;
    const titleBefore = await page.locator('#doc-title').textContent();

    assert.equal(await page.locator('#library-toggle').isVisible(), true);
    await page.locator('#library-toggle').click();
    await page.waitForFunction(() => document.querySelector('#library')?.classList.contains('is-open'));

    const treeText = await page.locator('#folder-tree').textContent();
    assert.match(treeText, /全部文稿/);
    assert.match(treeText, /未归档/);
    assert.match(treeText, /项目/);
    assert.match(treeText, /子目录/);
    assert.equal(await page.locator('.doc-row').count(), 3, 'All lists every online document, including remote-only');
    assert.match(await page.locator('#doc-list').textContent(), /仅云端\.md/);
    assert.equal(
      await page.evaluate(() => document.querySelectorAll('.doc-row button button').length),
      0,
      'drag grip is a sibling, never nested inside the document click button',
    );
    assert.equal(await page.locator('.doc-row .doc-drag-handle').count(), 3);

    await page.locator('#folder-tree button[data-folder-id="f-project"]').click();
    await page.waitForFunction(() => document.querySelector('#folder-breadcrumb')?.textContent.includes('项目'));
    assert.match(await page.locator('#doc-list').textContent(), /alpha\.md/);
    assert.doesNotMatch(await page.locator('#doc-list').textContent(), /仅云端\.md/);
    assert.equal(await page.locator('#doc-title').textContent(), titleBefore);
    assert.equal(await page.locator('#html-frame').getAttribute('data-keep'), 'yes');
    assert.equal(await frame.locator('#counter').textContent(), '1');
    assert.equal(cloud.previewRequests, previewBefore, 'folder navigation must not reload the HTML frame');

    await page.locator('#folder-tree button[data-folder-id="f-child"]').click();
    await page.waitForFunction(() => document.querySelector('#folder-breadcrumb')?.textContent.includes('子目录'));
    assert.match(await page.locator('#doc-list').textContent(), /仅云端\.md/);
    assert.doesNotMatch(await page.locator('#doc-list').textContent(), /alpha\.md/);

    await page.locator('#folder-tree button[data-folder-id="f-empty"]').click();
    await page.waitForFunction(() => document.querySelector('#library-empty')?.textContent.includes('还没有内容'));
    assert.equal(await page.locator('#library-empty').isVisible(), true);

    await page.locator('#folder-tree button[data-library-view="all"]').click();
    await page.locator(`button[data-move-doc-id="${ALPHA}"]`).click();
    await page.locator('#library-dialog').waitFor({ state: 'visible' });
    const dialogBox = await page.locator('.library-dialog').boundingBox();
    assert.ok(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 391, 'dialog fits a 390px portrait viewport');
    assert.ok(dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 845);
    assert.equal(await page.locator('#library-parent').isVisible(), true);
    const patchesBeforeEscape = cloud.requests.filter((entry) => entry.method === 'PATCH').length;
    await page.keyboard.press('Escape');
    await page.locator('#library-dialog').waitFor({ state: 'hidden' });
    assert.equal(cloud.requests.filter((entry) => entry.method === 'PATCH').length, patchesBeforeEscape);
    assert.equal(await page.locator('#library').evaluate((node) => node.classList.contains('is-open')), true);

    await page.locator(`button[data-move-doc-id="${ALPHA}"]`).click();
    await page.locator('#library-parent').selectOption('f-child');
    await page.locator('#library-dialog-submit').click();
    await page.locator('#library-dialog').waitFor({ state: 'hidden' });
    assert.equal(cloud.library.assignments[ALPHA], 'f-child');
    const movePatch = cloud.requests.filter((entry) => entry.method === 'PATCH').at(-1);
    assert.deepEqual(movePatch.body, {
      action: 'moveDocument',
      revision: 5,
      docId: ALPHA,
      folderId: 'f-child',
    });
    assert.equal(movePatch.csrf, CSRF, 'iPad cookie mutations must carry the CSRF token');

    cloud.conflictOnce = true;
    const patchesBeforeConflict = cloud.requests.filter((entry) => entry.method === 'PATCH').length;
    const getsBeforeConflict = cloud.requests.filter((entry) => entry.pathname === '/api/library').length;
    await page.locator('#folder-create').click();
    await page.locator('#library-name').fill('冲突后创建');
    await page.locator('#library-dialog-submit').click();
    await page.locator('#library-dialog-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#library-dialog-error').textContent(), /其他设备/);
    assert.equal(await page.locator('#library-dialog-submit').textContent(), '确认后重试');
    assert.equal(cloud.requests.filter((entry) => entry.method === 'PATCH').length, patchesBeforeConflict + 1);
    assert.ok(cloud.requests.filter((entry) => entry.pathname === '/api/library').length > getsBeforeConflict);
    assert.equal(cloud.library.folders.some((folder) => folder.name === '冲突后创建'), false);

    await page.locator('#library-dialog-submit').click();
    await page.locator('#library-dialog').waitFor({ state: 'hidden' });
    const created = cloud.library.folders.find((folder) => folder.name === '冲突后创建');
    assert.ok(created, 'retry after refetch applies the mutation');

    // Moving a document back to root clears its assignment without touching
    // the document itself.
    await page.locator(`button[data-move-doc-id="${ALPHA}"]`).click();
    await page.locator('#library-parent').selectOption('');
    await page.locator('#library-dialog-submit').click();
    await page.locator('#library-dialog').waitFor({ state: 'hidden' });
    assert.equal(Object.hasOwn(cloud.library.assignments, ALPHA), false);

    await page.locator(`#folder-tree button[data-folder-id="${created.id}"]`).click();
    await page.locator('#folder-rename').click();
    await page.locator('#library-name').fill('改名后');
    await page.locator('#library-dialog-submit').click();
    await page.locator('#library-dialog').waitFor({ state: 'hidden' });
    assert.equal(cloud.library.folders.find((folder) => folder.id === created.id).name, '改名后');

    await page.locator('#folder-move').click();
    await page.locator('#library-parent').selectOption('');
    await page.locator('#library-dialog-submit').click();
    await page.locator('#library-dialog').waitFor({ state: 'hidden' });
    assert.equal(cloud.library.folders.find((folder) => folder.id === created.id).parentId, null);

    await page.locator('#folder-delete').click();
    assert.match(await page.locator('#library-dialog-copy').textContent(), /文稿不会被删除/);
    await page.locator('#library-dialog-submit').click();
    await page.locator('#library-dialog').waitFor({ state: 'hidden' });
    assert.equal(cloud.library.folders.some((folder) => folder.id === created.id), false);
    await page.waitForFunction(() => document.querySelectorAll('.doc-row').length === 3);

    await context.setOffline(true);
    await page.locator('#library-state').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await page.locator('#library-state-text').textContent(), /离线/);
    assert.equal(await page.locator('#folder-create').isDisabled(), true);
    await context.setOffline(false);
    await page.locator('#library-state').waitFor({ state: 'hidden', timeout: 8000 });
    assert.equal(await page.locator('#folder-create').isEnabled(), true);

    await page.evaluate(() => document.querySelector('#logout-button').click());
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal((await page.locator('#folder-tree').textContent()).trim(), '');
    assert.equal((await page.locator('#doc-list').textContent()).trim(), '');
    assert.equal(await page.locator('#library-dialog').isVisible(), false);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

async function launchMacPage(libraryData) {
  const context = await macBrowser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.addInitScript(({ initialLibrary, syncState }) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const library = clone(initialLibrary);
    const state = clone(syncState);
    window.__moduLibrary = library;
    window.__moduCalls = [];
    window.__moduLibraryGetCount = 0;
    window.__moduConflictOnce = false;
    function fallbackConflict() {
      return { ok: false, error: { code: 'LIBRARY_CONFLICT', status: 409, message: '文库已被其他设备更新。' } };
    }
    function apply(body) {
      if (body.action === 'createFolder') {
        library.folders.push({
          id: `f-fake-${library.folders.length + 1}`,
          name: body.name,
          parentId: body.parentId || null,
        });
      } else if (body.action === 'renameFolder') {
        const folder = library.folders.find((entry) => entry.id === body.folderId);
        if (!folder) return false;
        folder.name = body.name;
      } else if (body.action === 'moveFolder') {
        const folder = library.folders.find((entry) => entry.id === body.folderId);
        if (!folder) return false;
        folder.parentId = body.parentId || null;
      } else if (body.action === 'deleteFolder') {
        const folder = library.folders.find((entry) => entry.id === body.folderId);
        if (!folder) return false;
        const parentId = folder.parentId || null;
        library.folders = library.folders
          .filter((entry) => entry.id !== body.folderId)
          .map((entry) => (entry.parentId === body.folderId ? { ...entry, parentId } : entry));
        for (const [docId, folderId] of Object.entries(library.assignments)) {
          if (folderId === body.folderId) {
            if (parentId) library.assignments[docId] = parentId;
            else delete library.assignments[docId];
          }
        }
      } else if (body.action === 'moveDocument') {
        if (body.folderId) library.assignments[body.docId] = body.folderId;
        else delete library.assignments[body.docId];
      } else {
        return false;
      }
      library.revision += 1;
      return true;
    }
    window.moduDesktop = {
      onOpenPath() { return () => {}; },
      ready() { return Promise.resolve(null); },
      documentOpened() {},
      getPathForFile() { return ''; },
      sync: {
        getState() { return Promise.resolve(clone(state)); },
        saveSettings(payload) {
          window.__moduCalls.push(['saveSettings', payload]);
          return Promise.resolve({
            state: clone(state),
            ping: { ok: true, user: { username: 'alice' } },
          });
        },
        addPath(filePath) {
          window.__moduCalls.push(['addPath', filePath]);
          return Promise.resolve(clone(state));
        },
        removePath(filePath) {
          window.__moduCalls.push(['removePath', filePath]);
          return Promise.resolve(clone(state));
        },
        syncNow() { return Promise.resolve(clone(state)); },
        ping() { return Promise.resolve({ ok: true, user: { username: 'alice' } }); },
        getLibrary() {
          window.__moduLibraryGetCount += 1;
          return Promise.resolve({
            ok: true,
            library: clone(library),
            documents: clone(window.__moduDocuments),
          });
        },
        mutateLibrary(payload) {
          window.__moduCalls.push(['mutateLibrary', clone(payload)]);
          if (window.__moduConflictOnce) {
            window.__moduConflictOnce = false;
            return Promise.resolve(fallbackConflict());
          }
          if (payload.revision !== library.revision) return Promise.resolve(fallbackConflict());
          if (!apply(payload)) {
            return Promise.resolve({ ok: false, error: { code: 'INVALID_ACTION', status: 400, message: '操作无效。' } });
          }
          return Promise.resolve({
            ok: true,
            library: clone(library),
            documents: clone(window.__moduDocuments),
          });
        },
        onState() { return () => {}; },
      },
    };
    window.__moduDocuments = clone(initialLibrary.documents || []);
  }, {
    initialLibrary: libraryData,
    syncState: {
      configured: true,
      serverUrl: 'https://md.example.test',
      hasToken: true,
      serverUser: 'alice',
      lastSyncAt: null,
      syncing: false,
      maxDocBytes: 2 * 1024 * 1024,
      documents: [
        {
          path: '/tmp/local-alpha.md',
          name: 'alpha.md',
          kind: 'markdown',
          status: 'synced',
          lastSyncedAt: '2026-02-01T08:00:00.000Z',
          lastError: null,
          revision: 2,
        },
      ],
    },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(readerBase, { waitUntil: 'domcontentloaded' });
  await page.locator('#sample-button').click();
  await page.waitForFunction(() => document.querySelector('#file-name')?.textContent.includes('welcome.md'));
  return { context, page, errors };
}

test(`Mac cloud panel ${chromiumReady ? 'Chromium' : 'WebKit'}: remote-only list, folders, move, conflict, refresh/poll ownership`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 90000,
}, async () => {
  const libraryData = {
    revision: 9,
    folders: [
      { id: 'f-project', name: '项目', parentId: null },
      { id: 'f-child', name: '子目录', parentId: 'f-project' },
    ],
    assignments: { [ALPHA]: 'f-project', [REMOTE]: 'f-child' },
    documents: DOCUMENTS.map(publicDoc),
  };
  const { context, page, errors } = await launchMacPage(libraryData);
  try {
    await page.locator('#cloud-trigger').click();
    await page.locator('#cloud-panel').waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.__moduLibraryGetCount >= 1);
    await page.waitForFunction(() => document.querySelector('#cloud-online-docs')?.textContent.includes('仅云端.md'));
    assert.match(await page.locator('#cloud-online-docs').textContent(), /alpha\.md/);
    assert.match(await page.locator('#cloud-folder-tree').textContent(), /全部文稿/);
    assert.match(await page.locator('#cloud-folder-tree').textContent(), /未归档/);
    assert.equal(await page.locator('.cloud-online-item').count(), 3);
    assert.equal(
      await page.evaluate(() => document.querySelectorAll('.cloud-online-item button button').length),
      0,
    );
    assert.equal(await page.locator('#cloud-panel').textContent().then((text) => text.includes('sync-token-value')), false);

    const readerTitle = await page.locator('#file-name').textContent();
    await page.locator('#cloud-folder-tree button[data-folder-id="f-project"]').click();
    assert.match(await page.locator('#cloud-online-docs').textContent(), /alpha\.md/);
    assert.doesNotMatch(await page.locator('#cloud-online-docs').textContent(), /仅云端\.md/);
    assert.equal(await page.locator('#file-name').textContent(), readerTitle, 'cloud folder navigation leaves the reader alone');

    await page.locator(`button[data-move-doc-id="${ALPHA}"]`).click();
    await page.locator('#cloud-library-dialog').waitFor({ state: 'visible' });
    const callsBeforeEscape = await page.evaluate(() => window.__moduCalls.filter(([name]) => name === 'mutateLibrary').length);
    await page.keyboard.press('Escape');
    await page.locator('#cloud-library-dialog').waitFor({ state: 'hidden' });
    assert.equal(
      await page.evaluate(() => window.__moduCalls.filter(([name]) => name === 'mutateLibrary').length),
      callsBeforeEscape,
    );
    assert.equal(await page.locator('#cloud-panel').isVisible(), true, 'Escape closes only the dialog');

    await page.locator(`button[data-move-doc-id="${ALPHA}"]`).click();
    await page.locator('#cloud-library-parent').selectOption('f-child');
    await page.locator('#cloud-library-submit').click();
    await page.locator('#cloud-library-dialog').waitFor({ state: 'hidden' });
    const moveCall = await page.evaluate(() => window.__moduCalls.filter(([name]) => name === 'mutateLibrary').at(-1)[1]);
    assert.deepEqual(moveCall, {
      action: 'moveDocument',
      revision: 9,
      docId: ALPHA,
      folderId: 'f-child',
    });
    assert.equal(
      await page.evaluate((id) => window.__moduLibrary.assignments[id], ALPHA),
      'f-child',
    );

    // Open a dialog at the current revision, then let a background refresh see
    // a newer remote revision. Submitting must use the dialog's starting
    // revision, get a 409, and never silently overwrite the remote edit.
    await page.locator('#cloud-folder-create').click();
    await page.locator('#cloud-library-name').fill('Mac 新文件夹');
    const getBeforeConflict = await page.evaluate(() => window.__moduLibraryGetCount);
    await page.evaluate(() => {
      window.__moduLibrary.revision += 1;
      window.__moduLibrary.folders.find((folder) => folder.id === 'f-project').name = '远端改名';
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.querySelector('#cloud-folder-tree')?.textContent.includes('远端改名'));
    const revisionBeforeRetry = await page.evaluate(() => window.__moduLibrary.revision);
    await page.locator('#cloud-library-submit').click();
    await page.locator('#cloud-library-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#cloud-library-error').textContent(), /其他设备/);
    assert.equal(await page.locator('#cloud-library-submit').textContent(), '确认后重试');
    assert.ok(await page.evaluate(() => window.__moduLibraryGetCount) > getBeforeConflict);
    assert.equal(
      await page.evaluate(() => window.__moduLibrary.folders.some((folder) => folder.name === 'Mac 新文件夹')),
      false,
    );
    assert.equal(await page.evaluate(() => window.__moduLibrary.revision), revisionBeforeRetry);
    await page.locator('#cloud-library-submit').click();
    await page.locator('#cloud-library-dialog').waitFor({ state: 'hidden' });
    const createdId = await page.evaluate(() => {
      const folder = window.__moduLibrary.folders.find((entry) => entry.name === 'Mac 新文件夹');
      return folder?.id || '';
    });
    assert.ok(createdId);
    assert.match(await page.locator('#cloud-folder-tree').textContent(), /Mac 新文件夹/);

    await page.locator(`#cloud-folder-tree button[data-folder-id="${createdId}"]`).click();
    await page.locator('#cloud-folder-delete').click();
    assert.match(await page.locator('#cloud-library-copy').textContent(), /文稿不会被删除/);
    await page.locator('#cloud-library-submit').click();
    await page.locator('#cloud-library-dialog').waitFor({ state: 'hidden' });
    assert.equal(
      await page.evaluate((id) => window.__moduLibrary.folders.some((folder) => folder.id === id), createdId),
      false,
    );

    const getBeforeRefresh = await page.evaluate(() => window.__moduLibraryGetCount);
    await page.locator('#cloud-library-refresh').click();
    await page.waitForFunction((count) => window.__moduLibraryGetCount > count, getBeforeRefresh);

    // A dialog remains usable at a 390px-wide window.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#cloud-folder-tree button[data-folder-id="f-child"]').click();
    await page.locator(`button[data-move-doc-id="${REMOTE}"]`).click();
    const dialogBox = await page.locator('.cloud-library-dialog').boundingBox();
    assert.ok(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 391);
    assert.ok(dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 845);
    await page.keyboard.press('Escape');
    await page.locator('#cloud-library-dialog').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1100, height: 800 });

    // Polling is bounded to the open panel and cancelled on close.
    await page.locator('#cloud-close').click();
    await page.locator('#cloud-panel').waitFor({ state: 'hidden' });
    await page.evaluate(() => { document.querySelector('meta[name="modu-cloud-library-poll-ms"]').content = '250'; });
    await page.locator('#cloud-trigger').click();
    await page.locator('#cloud-panel').waitFor({ state: 'visible' });
    const pollStart = await page.evaluate(() => window.__moduLibraryGetCount);
    await page.waitForFunction((start) => window.__moduLibraryGetCount >= start + 2, pollStart, { timeout: 5000 });
    await page.locator('#cloud-close').click();
    const afterClose = await page.evaluate(() => window.__moduLibraryGetCount);
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.__moduLibraryGetCount), afterClose, 'closing the panel cancels polling');
    await page.evaluate(() => { document.querySelector('meta[name="modu-cloud-library-poll-ms"]').content = '15000'; });

    // Opening the panel exactly once begins exactly one library refresh.
    const beforeOpen = await page.evaluate(() => window.__moduLibraryGetCount);
    await page.locator('#cloud-trigger').click();
    await page.waitForFunction((count) => window.__moduLibraryGetCount >= count + 1, beforeOpen);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__moduLibraryGetCount), beforeOpen + 1);

    // Reopening does not accumulate listeners or duplicate refreshes.
    const beforeReopen = await page.evaluate(() => window.__moduLibraryGetCount);
    await page.locator('#cloud-close').click();
    await page.locator('#cloud-trigger').click();
    await page.waitForFunction((count) => window.__moduLibraryGetCount >= count + 1, beforeReopen);
    await page.locator('#cloud-close').click();
    await page.locator('#cloud-trigger').click();
    await page.waitForFunction((count) => window.__moduLibraryGetCount >= count + 2, beforeReopen);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__moduLibraryGetCount), beforeReopen + 2);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
