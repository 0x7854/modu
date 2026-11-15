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

test(`mobile import UI ${browserKind}: file import, same-name docs, invalid file, network error, shortcut token`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 120000,
}, async () => {
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const mobilePage = await mobile.newPage();
  const pageErrors = [];
  mobilePage.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await mobilePage.goto(base, { waitUntil: 'domcontentloaded' });
    await mobilePage.locator('#auth-screen').waitFor({ state: 'visible', timeout: 10000 });
    await mobilePage.locator('#login-user').fill('alice');
    await mobilePage.locator('#login-pass').fill('correct horse battery');
    await mobilePage.locator('#login-submit').click();
    await mobilePage.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 10000 });

    // Open the narrow drawer and confirm the new import/shortcut controls do
    // not break the existing edge/drawer shell.
    await mobilePage.locator('#library-toggle').click();
    await mobilePage.locator('#library').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await mobilePage.locator('#library').evaluate((node) => node.classList.contains('is-open')), true);
    await mobilePage.locator('#import-doc').waitFor({ state: 'visible' });
    await mobilePage.locator('#shortcut-settings').waitFor({ state: 'visible' });

    const beforeCount = await mobilePage.locator('#doc-list [data-doc-id]').count();
    await mobilePage.locator('#import-file').setInputFiles({
      name: 'unsupported.pdf',
      mimeType: 'text/plain',
      buffer: Buffer.from('not markdown'),
    });
    await mobilePage.getByText('请选择 Markdown 或纯文本文件，不支持此文件后缀。').waitFor({ timeout: 5000 });
    assert.equal(await mobilePage.locator('#doc-list [data-doc-id]').count(), beforeCount);

    await mobilePage.locator('#import-file').setInputFiles({
      name: '中文 同名.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 导入一\n\n第一份正文\n'),
    });
    await mobilePage.getByText('第一份正文').first().waitFor({ timeout: 10000 });
    const firstHash = await mobilePage.evaluate(() => location.hash);
    assert.match(firstHash, /^#doc-[a-f0-9]{32}$/);
    const firstId = firstHash.slice('#doc-'.length);
    const firstDoc = await mobilePage.evaluate(async (id) => {
      const response = await fetch(`/api/documents/${id}`);
      return response.json();
    }, firstId);
    assert.equal(firstDoc.doc.name, '中文 同名.md');
    const firstLibrary = await mobilePage.evaluate(async () => (await (await fetch('/api/library')).json()).library);
    assert.equal(firstLibrary.assignments[firstId], undefined, 'imports default to unfiled');

    await mobilePage.locator('#library-toggle').click();
    await mobilePage.locator('#library').waitFor({ state: 'visible', timeout: 5000 });
    await mobilePage.locator('#import-file').setInputFiles({
      name: '中文 同名.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 导入二\n\n第二份正文，不是合并\n'),
    });
    await mobilePage.getByText('第二份正文，不是合并').first().waitFor({ timeout: 10000 });
    const secondHash = await mobilePage.evaluate(() => location.hash);
    assert.match(secondHash, /^#doc-[a-f0-9]{32}$/);
    assert.notEqual(secondHash, firstHash, 'same filename creates a distinct document');
    const sameNameCount = await mobilePage.evaluate(async () => {
      const payload = await (await fetch('/api/documents')).json();
      return payload.documents.filter((doc) => doc.name === '中文 同名.md').length;
    });
    assert.equal(sameNameCount, 2);

    // Generic iOS text shares may keep no extension or acquire .txt.
    for (const name of ['分享文件', '分享文件.txt', '分享文件.md.txt']) {
      await mobilePage.locator('#library-toggle').click();
      await mobilePage.locator('#import-file').setInputFiles({
        name, mimeType: 'text/plain', buffer: Buffer.from(`# 分享文本\n\n正文保留 ${name}`),
      });
      await mobilePage.getByText(`正文保留 ${name}`, {exact: true}).waitFor();
      const saved = await mobilePage.evaluate(async () =>
        (await (await fetch('/api/documents/' + location.hash.slice(5))).json()).doc);
      assert.equal(saved.name, '分享文件.md');
      assert.equal(saved.markdown, `# 分享文本\n\n正文保留 ${name}`);
    }


    // A lost network request must surface an error and must not leave the import
    // button stuck in its loading state.
    await mobilePage.route('**/api/import/documents', (route) => route.abort('failed'));
    await mobilePage.locator('#library-toggle').click();
    await mobilePage.locator('#library').waitFor({ state: 'visible', timeout: 5000 });
    await mobilePage.locator('#import-file').setInputFiles({
      name: '网络失败.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 断网\n'),
    });
    await mobilePage.getByText('网络连接失败，请稍后重试。').waitFor({ timeout: 10000 });
    await mobilePage.unroute('**/api/import/documents');
    assert.equal(await mobilePage.locator('#import-doc').textContent(), '导入 Markdown');

    await mobilePage.evaluate(() => {
      window.sharedFiles = [];
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async ({files}) => {
        window.sharedFiles.push({name: files[0].name, size: files[0].size});
        throw new DOMException('User cancelled', 'AbortError');
      }});
    });
    // Shortcut settings: real download path, URL, one-time token, rotation and
    // revocation. The dialog must not cache or re-reveal the clear token.
    await mobilePage.locator('#shortcut-settings').click();
    await mobilePage.locator('#shortcut-dialog').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await mobilePage.locator('#shortcut-url').inputValue(), base);
    assert.match(await mobilePage.locator('#shortcut-download-url').inputValue(), /\/shortcuts\/Open-in-Modu\.shortcut$/);
    await mobilePage.locator('#shortcut-generate').click();
    await mobilePage.locator('#shortcut-token-secret').waitFor({ state: 'visible', timeout: 10000 });
    const firstToken = await mobilePage.locator('#shortcut-token-value').inputValue();
    assert.match(firstToken, /^modu_import_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/);
    // No top-level navigation or popup, even when system file sharing is cancelled.
    const readerUrl = mobilePage.url();
    const pagesBefore = mobile.pages().length;
    const downloadButton = mobilePage.locator('#shortcut-download');
    await downloadButton.filter({hasText: '保存快捷指令文件'}).waitFor();
    await downloadButton.click();
    await mobilePage.waitForFunction(() => window.sharedFiles.length === 1);
    assert.equal(mobilePage.url(), readerUrl);
    assert.equal(mobile.pages().length, pagesBefore);
    assert.equal(await mobilePage.locator('#shortcut-dialog').isVisible(), true);
    assert.equal(await mobilePage.locator('#shortcut-token-value').inputValue(), firstToken);
    assert.equal(await mobilePage.locator('#shortcut-error').isHidden(), true);
    assert.equal(await mobilePage.evaluate(() => window.sharedFiles[0].name), '用墨读打开.shortcut');
    assert.ok(await mobilePage.evaluate(() => window.sharedFiles[0].size > 0));
    await mobilePage.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new Error('blocked'); }});
    });
    await downloadButton.click();
    await mobilePage.locator('#shortcut-error').filter({hasText: 'Safari'}).waitFor();
    assert.equal(mobilePage.url(), readerUrl);
    await mobilePage.evaluate(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }));

    assert.match(await mobilePage.locator('#shortcut-token-hint').textContent(), /只显示一次|不能读取/);
    await mobilePage.locator('#shortcut-close').click();
    await mobilePage.locator('#shortcut-dialog').waitFor({ state: 'hidden' });
    await mobilePage.locator('#shortcut-settings').click();
    await mobilePage.locator('#shortcut-dialog').waitFor({ state: 'visible' });
    await mobilePage.locator('#shortcut-token-status').filter({ hasText: '已启用' }).waitFor({ timeout: 10000 });
    assert.equal(await mobilePage.locator('#shortcut-token-secret').isHidden(), true);
    assert.equal(await mobilePage.locator('#shortcut-token-value').inputValue(), '');
    await mobilePage.locator('#shortcut-download').filter({hasText: '复制下载链接'}).waitFor();
    assert.equal(await mobilePage.locator('#shortcut-download').getAttribute('href'), null);

    await mobilePage.locator('#shortcut-generate').click();
    await mobilePage.locator('#shortcut-token-secret').waitFor({ state: 'visible', timeout: 10000 });
    const secondToken = await mobilePage.locator('#shortcut-token-value').inputValue();
    assert.notEqual(secondToken, firstToken);
    const oldTokenStatus = await mobilePage.evaluate(async (token) => {
      const response = await fetch('/api/import/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'old-token.md', markdown: '# old' }),
      });
      return response.status;
    }, firstToken);
    assert.equal(oldTokenStatus, 401, 'rotation revokes the previous token');

    await mobilePage.locator('#shortcut-revoke').click();
    await mobilePage.locator('#shortcut-token-status').filter({ hasText: '尚未生成' }).waitFor({ timeout: 10000 });
    const revokedStatus = await mobilePage.evaluate(async (token) => {
      const response = await fetch('/api/import/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'revoked-token.md', markdown: '# revoked' }),
      });
      return response.status;
    }, secondToken);
    assert.equal(revokedStatus, 401);
    await mobilePage.locator('#shortcut-close').click();
    await mobilePage.locator('#shortcut-dialog').waitFor({ state: 'hidden' });

    // The drawer still closes and reopens after the dialogs, so the new tools
    // did not steal the edge/drawer state.
    await mobilePage.locator('#library-close').click();
    await mobilePage.waitForTimeout(350);
    assert.equal(await mobilePage.locator('#library').evaluate((node) => node.classList.contains('is-open')), false);
    await mobilePage.locator('#library-toggle').click();
    await mobilePage.locator('#library').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await mobilePage.locator('#library').evaluate((node) => node.classList.contains('is-open')), true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await mobile.close();
  }
});
