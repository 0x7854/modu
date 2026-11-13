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
const browserKind = webkitReady ? 'WebKit' : (chromiumReady ? 'Chromium' : 'none');
const canRun = Boolean(playwright && (webkitReady || chromiumReady));

let tmpRoot;
let store;
let server;
let base;
let browser;
let context;
let page;
let aliceDocId;
let aliceDocName = 'alice-rotation.md';
let aliceUserId = '';

function bodyFor(marker = '') {
  return [
    '# 云端旋转阅读',
    '',
    marker ? `更新标记：${marker}` : '初始正文。',
    '',
    '<script>window.__cloud_xss = 1</script>',
    '<img src="https://evil.example/tracker.png" onerror="window.__cloud_xss = 2">',
    '',
    '[危险链接](javascript:window.__cloud_xss=3)',
    '![外链图片](https://evil.example/image.png)',
    '',
    ...Array.from({ length: 32 }, (_, index) => [
      `## 章节 ${index + 1}`,
      '',
      `第 ${index + 1} 节的正文。${'安静的墨读文字。'.repeat(7)}`,
      '',
    ]).flat(),
  ].join('\n');
}

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-cloud-web-'));
  store = await new CloudStore(path.join(tmpRoot, 'data')).init();
  const alice = await store.addUser('alice', 'correct horse battery');
  const bob = await store.addUser('bob', 'another good password');
  aliceUserId = alice.user.id;
  aliceDocId = 'a'.repeat(32);
  await store.upsertDocument(alice.user.id, aliceDocId, {
    name: aliceDocName,
    markdown: bodyFor(),
  });
  await store.upsertDocument(bob.user.id, 'b'.repeat(32), {
    name: 'bob-private.md',
    markdown: '# Bob only\n\nBOB_PRIVATE_TEXT\n',
  });

  server = await createCloudServer({
    dataDir: path.join(tmpRoot, 'data'),
    publicDir,
    pollMs: 1000,
    maxDocBytes: 2 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(0, '127.0.0.1');
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const browserType = webkitReady ? playwright.webkit : playwright.chromium;
  browser = await browserType.launch({
    headless: true,
    ...(webkitReady ? {} : { args: ['--no-sandbox'] }),
  });
  context = await browser.newContext({
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: false,
  });
  page = await context.newPage();
  page.on('pageerror', (error) => {
    console.error('PAGE ERROR', error.message);
  });
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.cloudShutdown();
    await new Promise((resolve) => server.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function loginAs(username, password) {
  await page.locator('#login-user').fill(username);
  await page.locator('#login-pass').fill(password);
  await page.locator('#login-submit').click();
  await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 10000 });
}

test(`cloud reader ${browserKind}: auth, XSS, update, scroll restore, rotation, isolation`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 120000,
}, async () => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const externalRequests = [];
  page.on('request', (request) => {
    if (/evil\.example/.test(request.url())) externalRequests.push(request.url());
  });

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 10000 });
  await loginAs('alice', 'correct horse battery');

  await page.locator(`button[data-doc-id="${aliceDocId}"]`).waitFor({ state: 'attached', timeout: 10000 });
  await page.locator('#cloud-doc').waitFor({ state: 'visible', timeout: 10000 });
  await page.getByText('云端旋转阅读').first().waitFor({ timeout: 10000 });

  assert.equal(await page.locator(`button[data-doc-id="${'b'.repeat(32)}"]`).count(), 0);
  assert.equal(await page.locator('#cloud-doc script').count(), 0);
  assert.equal(await page.locator('#cloud-doc iframe').count(), 0);
  assert.equal(await page.locator('#cloud-doc img').count(), 0);
  assert.equal(await page.evaluate(() => window.__cloud_xss), undefined);
  assert.equal(await page.locator('#cloud-doc a[href^="javascript:"]').count(), 0);
  assert.equal(await page.getByText('危险链接').count() > 0, true);
  assert.equal(await page.locator('.md-image-blocked').count() > 0, true);
  assert.deepEqual(externalRequests, [], 'blocked images/links must not make external requests');

  // Scroll and let the debounced position save reach the server.
  await page.locator('#reader-scroll').evaluate((node) => {
    node.scrollTop = Math.min(1700, node.scrollHeight - node.clientHeight - 10);
  });
  const savedScroll = await page.locator('#reader-scroll').evaluate((node) => node.scrollTop);
  assert.ok(savedScroll > 200);
  await page.waitForTimeout(1400);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#cloud-doc').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#cloud-doc')?.textContent.includes('云端旋转阅读'));
  await page.waitForTimeout(300);
  const restoredScroll = await page.locator('#reader-scroll').evaluate((node) => node.scrollTop);
  assert.ok(Math.abs(restoredScroll - savedScroll) < 120, `scroll position should survive reload (${savedScroll} -> ${restoredScroll})`);

  // A Mac sync update reaches the open reader without a reload.
  await store.upsertDocument(aliceUserId, aliceDocId, {
    name: aliceDocName,
    markdown: bodyFor('SYNC_UPDATE_2026'),
  });
  await page.getByText('更新标记：SYNC_UPDATE_2026').waitFor({ timeout: 12000 });
  const afterUpdateScroll = await page.locator('#reader-scroll').evaluate((node) => node.scrollTop);
  assert.ok(Math.abs(afterUpdateScroll - savedScroll) < 220, 'update should keep reading position');

  // Portrait/landscape/small screens: header and footer stay reachable and the
  // reader remains the scroll container.
  for (const viewport of [
    { width: 1194, height: 834 },
    { width: 834, height: 1194 },
    { width: 768, height: 1024 },
    { width: 507, height: 768 },
    { width: 390, height: 844 },
    { width: 1194, height: 650 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(120);
    const geometry = await page.evaluate(() => {
      const topbar = document.querySelector('.cloud-topbar').getBoundingClientRect();
      const footer = document.querySelector('.reading-footer').getBoundingClientRect();
      const reader = document.querySelector('#reader-scroll');
      return {
        top: topbar.top,
        headerBottom: topbar.bottom,
        footerBottom: footer.bottom,
        innerHeight: window.innerHeight,
        bodyScroll: document.documentElement.scrollHeight - window.innerHeight,
        readerClient: reader.clientHeight,
        readerScroll: reader.scrollHeight,
        readerTop: reader.getBoundingClientRect().top,
      };
    });
    assert.ok(geometry.top >= -1, `header top ${viewport.width}x${viewport.height}`);
    assert.ok(geometry.headerBottom <= geometry.innerHeight + 1, `header bottom ${viewport.width}x${viewport.height}`);
    assert.ok(geometry.footerBottom <= geometry.innerHeight + 1, `footer bottom ${viewport.width}x${viewport.height}`);
    assert.ok(geometry.bodyScroll <= 1, `page shell must not scroll as a whole ${viewport.width}x${viewport.height}`);
    assert.ok(geometry.readerClient > 120, `reader must retain usable height ${viewport.width}x${viewport.height}`);
    assert.ok(geometry.readerScroll > geometry.readerClient, `reader must scroll ${viewport.width}x${viewport.height}`);
  }

  // PWA assets and service worker: shell cached, API never cached.
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    return { status: response.status, payload: await response.json() };
  });
  assert.equal(manifest.status, 200);
  assert.equal(manifest.payload.display, 'standalone');
  assert.equal(manifest.payload.icons.length >= 3, true);
  for (const icon of manifest.payload.icons) {
    const response = await page.evaluate(async (src) => (await fetch(src)).status, icon.src);
    assert.equal(response, 200, `icon ${icon.src}`);
  }
  await page.waitForFunction(() => navigator.serviceWorker?.ready, null, { timeout: 10000 }).catch(() => {});
  const cacheAudit = await page.evaluate(async () => {
    const keys = await caches.keys();
    const entries = [];
    for (const key of keys) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) entries.push(request.url);
    }
    return { keys, entries };
  });
  assert.ok(cacheAudit.entries.length > 0, 'service worker should cache the public shell');
  assert.equal(cacheAudit.entries.some((url) => new URL(url).pathname.startsWith('/api/')), false, 'service worker must never cache API bodies');

  // Logout clears alice's DOM; bob sees only bob's document.
  await page.locator('#logout-button').click();
  await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.getByText('云端旋转阅读').count(), 0);
  await loginAs('bob', 'another good password');
  await page.getByText('Bob only').first().waitFor({ timeout: 10000 });
  assert.equal(await page.getByText('云端旋转阅读').count(), 0);
  assert.equal(await page.getByText('SYNC_UPDATE_2026').count(), 0);
  assert.equal(await page.locator(`button[data-doc-id="${aliceDocId}"]`).count(), 0);

  assert.deepEqual(pageErrors, []);
});
