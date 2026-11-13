import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderServer } from '../lib/reader-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

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

let tmpRoot;
let droppedPath;
let textPath;
let server;
let base;
let browser;
let page;

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-mac-cloud-ui-'));
  droppedPath = path.join(tmpRoot, 'dropped.md');
  textPath = path.join(tmpRoot, 'secret.txt');
  await fsp.writeFile(droppedPath, '# 拖入的文稿\n\n这是明确的主动加入测试。\n');
  await fsp.writeFile(textPath, 'never upload me');
  await fsp.writeFile(path.join(tmpRoot, 'welcome.md'), '# 示例\n');
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

  const browserType = chromiumReady ? playwright.chromium : playwright.webkit;
  browser = await browserType.launch({
    headless: true,
    ...(chromiumReady ? { args: ['--no-sandbox'] } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
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
      onOpenPath() {
        return () => {};
      },
      ready() {
        return Promise.resolve(null);
      },
      documentOpened() {},
      getPathForFile(file) {
        window.__moduCalls.push(['getPathForFile', file?.name || '']);
        return fileMap[file?.name] || '';
      },
      sync: {
        getState() {
          return Promise.resolve(window.__moduState);
        },
        saveSettings(payload) {
          window.__moduCalls.push(['saveSettings', payload]);
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
        ping() {
          return Promise.resolve({ ok: true, user: { username: 'alice' } });
        },
        onState() {
          return () => {};
        },
      },
    };
  }, { fileMap: { 'dropped.md': droppedPath, 'secret.txt': textPath } });
  page = await context.newPage();
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.readerShutdown();
    await new Promise((resolve) => server.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function dropFile(name) {
  await page.evaluate((fileName) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['# dropped'], fileName, { type: 'text/markdown' }));
    window.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, name);
}

test(`Mac cloud UI ${chromiumReady ? 'Chromium' : 'WebKit'}: drag choice, explicit add, no silent upload`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const pageErrors = [];
  page.on('pageerror', (error) => { pageErrors.push(error.message); console.error('PAGE ERROR', error.message); });
  page.on('console', (message) => { if (message.type() === 'error') console.error('CONSOLE', message.text()); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.moduDesktop?.sync?.getState === 'function');

  await page.locator('#cloud-trigger').click();
  await page.locator('#cloud-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#cloud-account-text')?.textContent.includes('alice'));
  assert.match(await page.locator('#cloud-panel').textContent(), /只有你在这里主动加入/);
  assert.match(await page.locator('#cloud-panel').textContent(), /不会上传/);

  await dropFile('dropped.md');
  await page.locator('#drop-choice').waitFor({ state: 'visible' });
  assert.match(await page.locator('#drop-choice-name').textContent(), /dropped\.md/);
  assert.equal(
    await page.evaluate(() => window.__moduCalls.some(([name]) => name === 'addPath')),
    false,
    'showing the choice must not upload',
  );

  // Explicit "open only" must not call addPath.
  await page.locator('#drop-open').click();
  await page.waitForFunction(() => document.title.startsWith('dropped.md'));
  assert.equal(await page.getByText('主动加入测试').count() > 0, true);
  assert.equal(
    await page.evaluate(() => window.__moduCalls.some(([name]) => name === 'addPath')),
    false,
  );

  // Second drop: explicit "add to cloud" calls the scoped bridge once.
  await dropFile('dropped.md');
  await page.locator('#drop-choice').waitFor({ state: 'visible' });
  await page.locator('#drop-add').click();
  await page.waitForFunction(() => window.__moduCalls.some(([name]) => name === 'addPath'));
  const calledPaths = await page.evaluate(() => window.__moduCalls
    .filter(([name]) => name === 'addPath')
    .map(([, filePath]) => filePath));
  assert.deepEqual(calledPaths, [droppedPath]);
  await page.locator('#cloud-trigger').click();
  await page.locator('#cloud-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#cloud-doc-list')?.textContent.includes('dropped.md'));

  // Non-Markdown is rejected before any add.
  await page.locator('#cloud-close').click();
  await dropFile('secret.txt');
  await page.locator('.toast[data-kind="error"]').last().waitFor({ state: 'visible' });
  assert.match(await page.locator('#toast-region').textContent(), /只支持拖入 \.md/);
  assert.equal(await page.locator('#drop-choice').isVisible(), false);
  assert.equal(
    await page.evaluate(() => window.__moduCalls.filter(([name]) => name === 'addPath').length),
    1,
  );

  // The bridge is narrow and contains only the purpose-built surface.
  const bridgeKeys = await page.evaluate(() => Object.keys(window.moduDesktop).sort());
  assert.deepEqual(bridgeKeys, ['documentOpened', 'getPathForFile', 'onOpenPath', 'ready', 'sync']);
  const syncKeys = await page.evaluate(() => Object.keys(window.moduDesktop.sync).sort());
  assert.deepEqual(syncKeys, ['addPath', 'getState', 'onState', 'ping', 'removePath', 'saveSettings', 'syncNow']);

  assert.deepEqual(pageErrors, []);
});
