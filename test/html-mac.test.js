import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReaderServer } from '../lib/reader-server.js';

const require = createRequire(import.meta.url);
const {
  CloudSync,
  normalizeDocumentPath,
} = require('../electron/cloud-sync.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const demoPath = path.join(projectRoot, 'examples', '墨读-HTML体验.html');

let playwright = null;
try {
  playwright = await import('playwright');
} catch {
  playwright = null;
}
const chromiumPath = playwright?.chromium?.executablePath?.() || '';
const webkitPath = playwright?.webkit?.executablePath?.() || '';
const chromiumReady = Boolean(
  chromiumPath && await fsp.access(chromiumPath).then(() => true).catch(() => false),
);
const webkitReady = Boolean(
  webkitPath && await fsp.access(webkitPath).then(() => true).catch(() => false),
);
const canRun = Boolean(playwright && (chromiumReady || webkitReady));
const browserKind = chromiumReady ? 'Chromium' : 'WebKit';

function htmlFixture(marker, title) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { margin: 0; padding: 46px; background: #f6f1e6; color: #24362d; font-family: -apple-system, sans-serif; }
  h1 { font-family: Georgia, serif; font-size: 42px; }
  button { padding: 10px 18px; border: 0; border-radius: 999px; background: #2f5a48; color: #fff; font-size: 16px; cursor: pointer; }
  .card { margin-top: 20px; padding: 22px; border: 1px solid #d9d0bf; border-radius: 14px; background: #fffdf8; }
  output { margin-left: 8px; font-weight: 700; }
</style>
</head>
<body data-fixture="${marker}">
  <h1>${marker}</h1>
  <div class="card">
    <p>控件次数：<strong id="count">0</strong></p>
    <button id="bump" type="button">加一</button>
    <p><label for="slider">滑块</label><input id="slider" type="range" min="0" max="10" value="3"><output id="slider-out" for="slider">3</output></p>
  </div>
  <script>
    let count = 0;
    const countNode = document.getElementById('count');
    document.getElementById('bump').addEventListener('click', () => {
      count += 1;
      countNode.textContent = String(count);
    });
    const slider = document.getElementById('slider');
    const sliderOut = document.getElementById('slider-out');
    slider.addEventListener('input', () => { sliderOut.textContent = slider.value; });
  </script>
</body>
</html>`;
}

const markdownFixture = `# 墨读 Markdown

MARKDOWN_STILL_WORKS

## 章节一

Markdown reader behavior must remain.

## 章节二

Second section.
`;

let tmpRoot;
let htmlPath;
let secondHtmlPath;
let dropHtmlPath;
let noBridgePath;
let mdPath;
let server;
let base;
let browser;
let context;
let page;
const pageErrors = [];

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-html-mac-'));
  htmlPath = path.join(tmpRoot, '体验.html');
  secondHtmlPath = path.join(tmpRoot, '第二页.htm');
  dropHtmlPath = path.join(tmpRoot, '拖入.html');
  noBridgePath = path.join(tmpRoot, '未就绪.html');
  mdPath = path.join(tmpRoot, '笔记.md');
  await fsp.writeFile(htmlPath, htmlFixture('FIRST', '第一页'));
  await fsp.writeFile(secondHtmlPath, htmlFixture('SECOND', '第二页'));
  await fsp.writeFile(dropHtmlPath, htmlFixture('DROP', '拖入页'));
  await fsp.writeFile(noBridgePath, htmlFixture('NO-BRIDGE-MARKER', '未就绪页'));
  await fsp.writeFile(mdPath, markdownFixture);
  await fsp.writeFile(path.join(tmpRoot, 'welcome.md'), '# 示例\n');

  if (!canRun) return;

  server = createReaderServer({
    rootDir: projectRoot,
    samplePath: path.join(tmpRoot, 'welcome.md'),
    pollMs: 200,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const type = chromiumReady ? playwright.chromium : playwright.webkit;
  browser = await type.launch({
    headless: true,
    ...(chromiumReady ? {} : {}),
  });
  context = await browser.newContext({ viewport: { width: 1240, height: 900 } });
  await context.addInitScript(({ fileMap }) => {
    const state = {
      configured: true,
      serverUrl: 'https://md.example.test',
      hasToken: true,
      serverUser: 'alice',
      lastSyncAt: null,
      syncing: false,
      maxDocBytes: 2 * 1024 * 1024,
      documents: [],
    };
    window.__moduCalls = [];
    window.__moduState = state;
    window.moduDesktop = {
      onOpenPath() { return () => {}; },
      ready() { return Promise.resolve(null); },
      documentOpened() {},
      getPathForFile(file) { return fileMap[file?.name] || ''; },
      sync: {
        getState() { return Promise.resolve(window.__moduState); },
        saveSettings() {
          return Promise.resolve({
            state: window.__moduState,
            ping: { ok: true, user: { username: 'alice' } },
          });
        },
        addPath(filePath) {
          window.__moduCalls.push(['addPath', filePath]);
          const name = filePath.split('/').pop();
          if (!window.__moduState.documents.some((doc) => doc.path === filePath)) {
            window.__moduState.documents.push({
              path: filePath,
              name,
              kind: /\.html?$/i.test(name) ? 'html' : 'markdown',
              status: 'synced',
              lastSyncedAt: new Date().toISOString(),
              lastError: null,
              revision: 1,
            });
          }
          return Promise.resolve(window.__moduState);
        },
        removePath(filePath) {
          window.__moduCalls.push(['removePath', filePath]);
          window.__moduState.documents = window.__moduState.documents
            .filter((doc) => doc.path !== filePath);
          return Promise.resolve(window.__moduState);
        },
        syncNow() {
          window.__moduCalls.push(['syncNow']);
          return Promise.resolve(window.__moduState);
        },
        ping() { return Promise.resolve({ ok: true, user: { username: 'alice' } }); },
        onState() { return () => {}; },
      },
    };
  }, {
    fileMap: {
      '体验.html': htmlPath,
      '第二页.htm': secondHtmlPath,
      '拖入.html': dropHtmlPath,
      '未就绪.html': noBridgePath,
      '笔记.md': mdPath,
    },
  });

  // A short verification timeout keeps the explicit-error test quick while the
  // renderer still requires the ready message, never the iframe load event.
  await context.route(`${base}/`, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('content="12000"', 'content="1200"');
    const headers = { ...response.headers() };
    delete headers['content-encoding'];
    delete headers['content-length'];
    await route.fulfill({ status: response.status(), headers, body });
  });

  await context.route(/\/api\/html-preview\?cap=/, async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    if (body.includes('NO-BRIDGE-MARKER')) {
      body = body.replace(/<script[^>]*>[\s\S]*?modu-preview-ready[\s\S]*?<\/script>/gi, '');
    }
    const headers = { ...response.headers() };
    delete headers['content-encoding'];
    delete headers['content-length'];
    await new Promise((resolve) => setTimeout(resolve, 380));
    await route.fulfill({ status: response.status(), headers, body });
  });

  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.readerShutdown();
    await new Promise((resolve) => server.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function openPath(target, pageInstance = page) {
  await pageInstance.locator('#path-input').fill(target);
  await pageInstance.locator('#path-input').press('Enter');
}

async function waitForReady(pageInstance = page) {
  await pageInstance.waitForFunction(() => {
    const stage = document.querySelector('#html-stage');
    const error = document.querySelector('#html-error');
    const loading = document.querySelector('#html-loading');
    return Boolean(stage && !stage.hidden && error?.hidden && loading?.hidden
      && document.querySelector('#html-frame'));
  }, null, { timeout: 12_000 });
}

async function waitForFrameText(text, pageInstance = page, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of pageInstance.frames()) {
      if (!frame.url().includes('/api/html-preview')) continue;
      try {
        const body = await frame.locator('body').innerText();
        if (body.includes(text)) return frame;
      } catch {
        // The frame may be detaching during a rapid switch.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`frame never showed ${text}`);
}

function previewFrames(pageInstance = page) {
  return pageInstance.frames().filter((frame) => frame.url().includes('/api/html-preview'));
}

async function dropFile(name, pageInstance = page) {
  await pageInstance.evaluate((fileName) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['<html><body>drop fixture</body></html>'], fileName, { type: 'text/html' }));
    window.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, name);
}

test('static wiring: HTML association is alternate, preview is sandboxed, cloud payload is typed', () => {
  const mainSource = fsp.readFile(path.join(projectRoot, 'electron', 'main.cjs'), 'utf8');
  const packSource = fsp.readFile(path.join(projectRoot, 'scripts', 'pack-app.mjs'), 'utf8');
  const appSource = fsp.readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
  const syncSource = fsp.readFile(path.join(projectRoot, 'electron', 'cloud-sync.cjs'), 'utf8');

  return Promise.all([mainSource, packSource, appSource, syncSource]).then(([
    main,
    pack,
    app,
    sync,
  ]) => {
    assert.match(main, /DOCUMENT_EXTENSIONS = new Set\(\['\.md', '\.markdown', '\.html', '\.htm'\]\)/);
    assert.match(pack, /LSItemContentTypes: \['public\.html'\]/);
    assert.match(pack, /CFBundleTypeExtensions: \['html', 'htm'\]/);
    assert.equal((pack.match(/LSHandlerRank: 'Alternate'/g) || []).length >= 2, true);
    assert.doesNotMatch(pack, /LSHandlerRank: '(?:Default|Owner)'/);

    assert.match(app, /event\.source !== frame\.contentWindow/);
    assert.match(app, /event\.data\.type !== 'modu-preview-ready'/);
    assert.match(app, /setAttribute\('sandbox', 'allow-scripts'\)/);
    assert.match(app, /setAttribute\('referrerpolicy', 'no-referrer'\)/);
    assert.doesNotMatch(app, /allow-same-origin/);

    assert.match(sync, /kind: 'html', content: file\.text/);
    assert.match(sync, /markdown: file\.text/);
    assert.match(sync, /fs\.watchFile\(/);
  });
});

test('cloud sync sends HTML as kind/content and keeps Markdown legacy markdown', {
  timeout: 20000,
}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-html-sync-'));
  const htmlFile = path.join(root, '体验.html');
  const htmFile = path.join(root, '第二页.htm');
  const mdFile = path.join(root, '笔记.md');
  const assetFile = path.join(root, '相邻图片.png');
  const htmlBody = '<!doctype html><html><body><h1>交互页</h1><script>1 + 1</script></body></html>';
  const mdBody = '# 旧格式\n\nMarkdown 正文\n';
  await fsp.writeFile(htmlFile, htmlBody);
  await fsp.writeFile(htmFile, htmlBody.replace('交互页', 'HTM 页'));
  await fsp.writeFile(mdFile, mdBody);
  await fsp.writeFile(assetFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const requests = [];
  const testServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET' && req.url === '/api/sync/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: { username: 'alice' } }));
        return;
      }
      if (req.method === 'PUT' && req.url?.startsWith('/api/sync/documents/')) {
        requests.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, doc: { revision: 1 } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    testServer.listen(0, '127.0.0.1', resolve);
  });
  const syncBase = `http://127.0.0.1:${testServer.address().port}`;
  const sync = new CloudSync({ userDataDir: path.join(root, 'profile'), debounceMs: 300 });

  try {
    await sync.init();
    await sync.saveSettings({ serverUrl: syncBase, token: 't'.repeat(28) });
    await sync.addPath(htmlFile);
    await sync.addPath(htmFile);
    await sync.addPath(mdFile);

    assert.equal(requests.length, 3);
    const htmlRequest = requests.find((item) => item.body.name === '体验.html');
    const htmRequest = requests.find((item) => item.body.name === '第二页.htm');
    const mdRequest = requests.find((item) => item.body.name === '笔记.md');
    assert.ok(htmlRequest);
    assert.ok(htmRequest);
    assert.ok(mdRequest);
    assert.deepEqual(htmlRequest.body, { name: '体验.html', kind: 'html', content: htmlBody });
    assert.deepEqual(htmRequest.body, { name: '第二页.htm', kind: 'html', content: htmlBody.replace('交互页', 'HTM 页') });
    assert.deepEqual(mdRequest.body, { name: '笔记.md', markdown: mdBody });
    assert.equal('kind' in mdRequest.body, false);
    assert.equal('content' in mdRequest.body, false);

    const docs = sync.getState().documents;
    assert.deepEqual(
      docs.map((doc) => [doc.name, doc.kind]).sort(),
      [['笔记.md', 'markdown'], ['体验.html', 'html'], ['第二页.htm', 'html']].sort(),
    );
    assert.equal(requests.some((item) => item.body.name === '相邻图片.png'), false);
    assert.equal(normalizeDocumentPath(htmFile), htmFile);
    assert.throws(() => normalizeDocumentPath(path.join(root, 'secret.txt')), /只支持/);
  } finally {
    sync.dispose();
    await new Promise((resolve) => testServer.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test(`Mac HTML reader ${browserKind}: ready bridge, widgets, same revision, drop, cloud, Markdown fallback`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 90000,
}, async () => {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.applyDocument === 'function');

  await openPath(htmlPath);
  await page.locator('#html-stage').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#html-loading').isVisible(), true, 'loading overlay should be visible while waiting');
  await waitForReady();

  const iframe = page.locator('#html-frame');
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await iframe.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(await iframe.getAttribute('src'), /^\/api\/html-preview\?cap=[A-Za-z0-9_-]{32,128}$/);
  assert.equal(await page.locator('#doc-content').isVisible(), false);
  assert.equal(await page.locator('#html-mode-note').isVisible(), true);
  assert.equal((await page.locator('#doc-kind-badge').textContent()).trim(), 'HTML');
  assert.equal(await page.locator('.outline-column').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await page.locator('#theme-toggle').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await page.locator('#find-trigger').isDisabled(), true);
  assert.match(await page.locator('#status-text').textContent(), /交互页就绪/);
  assert.match(await page.locator('#html-mode-note').textContent(), /外部/);
  assert.match(await page.locator('#html-mode-note').textContent(), /跨设备/);
  assert.doesNotMatch(await page.locator('#html-mode-note').textContent(), /iframe|CSP|sandbox/i);

  const frame = page.frameLocator('#html-frame');
  await frame.locator('#bump').click();
  await frame.locator('#bump').click();
  assert.equal((await frame.locator('#count').textContent()).trim(), '2');
  await frame.locator('#slider').evaluate((node) => {
    node.value = '7';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal((await frame.locator('#slider-out').textContent()).trim(), '7');
  await waitForFrameText('FIRST');

  // Re-applying the exact same revision must keep the live iframe and its state.
  const sameRevision = await page.evaluate(async () => {
    const token = document.querySelector('meta[name="md-token"]').content;
    const response = await fetch('/api/state', { headers: { 'X-MD-Token': token } });
    const payload = await response.json();
    const currentFrame = document.querySelector('#html-frame');
    currentFrame.dataset.keep = 'yes';
    window.applyDocument(payload.doc);
    return { revision: payload.doc.revision, src: currentFrame.src };
  });
  await page.waitForTimeout(120);
  assert.equal(await iframe.getAttribute('data-keep'), 'yes');
  assert.equal(await iframe.evaluate((node) => node.src), sameRevision.src);
  assert.equal((await frame.locator('#count').textContent()).trim(), '2');
  assert.equal((await frame.locator('#slider-out').textContent()).trim(), '7');

  // Rapid switching: the newest document wins and only one preview frame stays.
  await page.evaluate(([first, second]) => {
    window.openPath(first);
    window.openPath(second);
  }, [htmlPath, secondHtmlPath]);
  await waitForFrameText('SECOND');
  await page.waitForFunction(() => document.querySelectorAll('#html-frame').length === 1);
  assert.equal(previewFrames().length, 1);
  assert.equal(await page.locator('#html-loading').isVisible(), false);

  // Drop is a local open by default; no silent cloud upload.
  await dropFile('拖入.html');
  await page.locator('#drop-choice').waitFor({ state: 'visible' });
  assert.match(await page.locator('#drop-choice-title').textContent(), /这份文稿/);
  await page.locator('#drop-open').click();
  await waitForFrameText('DROP');
  assert.equal(
    await page.evaluate(() => window.__moduCalls.filter(([name]) => name === 'addPath').length),
    0,
  );

  // Explicit cloud add accepts the current HTML file and shows its kind.
  await page.locator('#cloud-trigger').click();
  await page.locator('#cloud-panel').waitFor({ state: 'visible' });
  await page.locator('#cloud-add-current').click();
  await page.waitForFunction(() => window.__moduCalls.some(([name]) => name === 'addPath'));
  const addedPaths = await page.evaluate(() => window.__moduCalls
    .filter(([name]) => name === 'addPath')
    .map(([, filePath]) => filePath));
  assert.deepEqual(addedPaths, [dropHtmlPath]);
  await page.waitForFunction(() => document.querySelector('#cloud-doc-list')?.textContent.includes('HTML'));
  await page.locator('#cloud-close').click();

  // LAN share is disabled for HTML and points at the cloud library.
  assert.equal(await page.locator('#share-trigger').isDisabled(), true);
  assert.match(await page.locator('#share-trigger').getAttribute('title'), /云端文库/);
  await page.evaluate(() => window.openSharePanel());
  await page.locator('#share-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#share-html-note').isVisible(), true);
  assert.equal(await page.locator('#share-start').isDisabled(), true);
  assert.equal(await page.locator('#share-idle').isVisible(), false);
  await page.locator('#share-close').click();

  // Markdown settings are replaced by an HTML-only note.
  await page.locator('#settings-toggle').click();
  await page.locator('#settings-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#settings-html-note').isVisible(), true);
  assert.equal(await page.locator('#theme-segment').isVisible(), false);
  assert.equal(await page.locator('#font-range').isVisible(), false);
  await page.locator('#settings-close').click();

  // Existing Markdown behavior is untouched.
  await openPath(mdPath);
  await page.waitForFunction(() => (document.querySelector('#doc-content')?.textContent || '')
    .includes('MARKDOWN_STILL_WORKS'));
  assert.equal(await page.locator('#html-stage').isVisible(), false);
  assert.equal(await page.locator('#html-mode-note').isVisible(), false);
  assert.equal((await page.locator('#doc-kind-badge').textContent()).trim(), 'MD');
  assert.notEqual(await page.locator('#theme-toggle').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await page.locator('#share-trigger').isDisabled(), false);
  assert.equal(previewFrames().length, 0);
  assert.ok((await page.locator('#outline .outline-link').count()) >= 2);

  // Re-open HTML, then verify pagehide and session expiry tear the frame down.
  await openPath(secondHtmlPath);
  await waitForReady();
  assert.equal(previewFrames().length, 1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForFunction(() => document.querySelector('#html-stage')?.hidden === true);
  assert.equal(previewFrames().length, 0);

  await openPath(secondHtmlPath);
  await waitForReady();
  assert.equal(previewFrames().length, 1);
  await page.evaluate(() => window.expireSession());
  await page.waitForFunction(() => document.querySelector('#html-stage')?.hidden === true);
  assert.equal(previewFrames().length, 0);
  assert.match(await page.locator('#alert-title').textContent(), /会话/);
  assert.deepEqual(pageErrors, []);
});

test(`HTML preview verifies the ready message source and shows an explicit timeout`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 30000,
}, async () => {
  const errorPage = await context.newPage();
  const errors = [];
  errorPage.on('pageerror', (error) => errors.push(error.message));
  await errorPage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await openPath(noBridgePath, errorPage);
  await errorPage.locator('#html-stage').waitFor({ state: 'visible' });

  // A parent-originated message is not enough: event.source is checked.
  await errorPage.evaluate(() => window.postMessage({ type: 'modu-preview-ready' }, '*'));
  await errorPage.waitForTimeout(300);
  assert.equal(await errorPage.locator('#html-loading').isVisible(), true);

  await errorPage.locator('#html-error').waitFor({ state: 'visible', timeout: 8000 });
  assert.match(await errorPage.locator('#html-error-title').textContent(), /没有完成加载/);
  assert.match(await errorPage.locator('#html-error-detail').textContent(), /相邻文件/);
  assert.equal(await errorPage.locator('#html-error-retry').isVisible(), true);
  assert.equal(await errorPage.locator('#html-loading').isVisible(), false);
  assert.match(await errorPage.locator('#status-text').textContent(), /交互页未加载/);
  assert.deepEqual(errors, []);
  await errorPage.close();
});

test(`standalone HTML demo ${browserKind}: embedded assets, sliders, fold panel, responsive`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 45000,
}, async () => {
  const demoPage = await context.newPage();
  const errors = [];
  const requests = [];
  demoPage.on('pageerror', (error) => errors.push(error.message));
  demoPage.on('request', (request) => requests.push(request.url()));
  await demoPage.goto(pathToFileURL(demoPath).href, { waitUntil: 'load' });

  assert.equal(await demoPage.evaluate(() => document.querySelectorAll(
    'script[src], link[rel="stylesheet"], img:not([src^="data:"])',
  ).length), 0);
  assert.equal(requests.every((url) => url.startsWith('file:') || url.startsWith('data:')), true);
  assert.equal(await demoPage.locator('.hero-art img').evaluate((img) => img.naturalWidth > 0), true);
  assert.match(await demoPage.locator('#status-stat').textContent(), /从容/);

  await demoPage.locator('#range-food').evaluate((node) => {
    node.value = '8000';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal((await demoPage.locator('#out-food').textContent()).trim(), '¥8,000');
  assert.match(await demoPage.locator('#remaining').textContent(), /超出/);
  assert.equal(await demoPage.locator('#remaining-box').evaluate((node) => node.classList.contains('is-over')), true);

  await demoPage.locator('#balance').click();
  assert.match(await demoPage.locator('#remaining').textContent(), /¥0/);
  assert.match(await demoPage.locator('#status-stat').textContent(), /刚好/);
  assert.equal(await demoPage.locator('#range-save').inputValue(), '2400');

  assert.equal(await demoPage.locator('details.fold').evaluate((node) => node.open), false);
  await demoPage.locator('details.fold > summary').click();
  assert.equal(await demoPage.locator('details.fold').evaluate((node) => node.open), true);
  assert.equal((await demoPage.locator('#row-home').textContent()).trim(), '¥5,200');

  for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
    await demoPage.setViewportSize(viewport);
    await demoPage.waitForTimeout(80);
    const overflow = await demoPage.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    assert.ok(overflow <= 1, `unexpected horizontal overflow at ${viewport.width}px: ${overflow}`);
  }

  assert.deepEqual(errors, []);
  await demoPage.close();
});
