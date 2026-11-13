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
const webkitPath = playwright?.webkit?.executablePath?.() || '';
const chromiumPath = playwright?.chromium?.executablePath?.() || '';
const webkitReady = Boolean(webkitPath && await fsp.access(webkitPath).then(() => true).catch(() => false));
const chromiumReady = Boolean(chromiumPath && await fsp.access(chromiumPath).then(() => true).catch(() => false));
const browserKind = webkitReady ? 'WebKit' : (chromiumReady ? 'Chromium' : 'none');
const canRun = Boolean(playwright && (webkitReady || chromiumReady));

const ALICE_DOC = 'a'.repeat(32);
const ALICE_OTHER = 'c'.repeat(32);
const DOC_BODY = [
  '# 慢网启动验证',
  '',
  '这篇文稿用于检查一次 bootstrap 请求是否同时带回文库和正文。',
  '',
  ...Array.from({ length: 24 }, (_, index) => `## 第 ${index + 1} 节\n\n${'墨读慢网正文。'.repeat(20)}\n`),
].join('\n');
const OTHER_BODY = '# 另一份文稿\n\nHASH_PREFERRED_BODY\n';

let tmpRoot;
let server;
let base;
let browser;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-startup-'));
  const store = await new CloudStore(path.join(tmpRoot, 'data')).init();
  const alice = await store.addUser('alice', 'correct horse battery');
  await store.upsertDocument(alice.user.id, ALICE_DOC, {
    name: 'slow-start.md',
    markdown: DOC_BODY,
  });
  await store.upsertDocument(alice.user.id, ALICE_OTHER, {
    name: 'hash-picked.md',
    markdown: OTHER_BODY,
  });

  server = await createCloudServer({
    dataDir: path.join(tmpRoot, 'data'),
    publicDir,
    pollMs: 60000,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(0, '127.0.0.1');
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const type = webkitReady ? playwright.webkit : playwright.chromium;
  browser = await type.launch({
    headless: true,
    ...(webkitReady ? {} : { args: ['--no-sandbox'] }),
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

async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: false,
  });
  const page = await context.newPage();
  return { context, page };
}

async function login(page) {
  await page.locator('#login-user').fill('alice');
  await page.locator('#login-pass').fill('correct horse battery');
  await page.locator('#login-submit').click();
  await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#cloud-doc').waitFor({ state: 'visible', timeout: 15000 });
}

test(`startup ${browserKind}: one bootstrap replaces session/list/doc chain`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page } = await newPage();
  try {
    const calls = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) calls.push(url.pathname + url.search);
    });

    await page.goto(`${base}/#doc-${ALICE_OTHER}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    calls.length = 0;
    await login(page);

    await page.waitForFunction(() => document.querySelector('#doc-title')?.textContent === 'hash-picked.md');
    assert.equal(await page.getByText('HASH_PREFERRED_BODY').count(), 1);

    const afterLogin = calls.filter((entry) => entry !== `/api/bootstrap?doc=${ALICE_OTHER}`);
    assert.deepEqual(afterLogin, ['/api/login'], `unexpected startup calls: ${calls.join(', ')}`);
    assert.equal(calls.includes('/api/session'), false);
    assert.equal(calls.filter((entry) => entry.startsWith('/api/documents')).length, 0);
    assert.equal(calls.filter((entry) => entry.startsWith('/api/bootstrap')).length, 1);
    assert.ok(calls.includes(`/api/bootstrap?doc=${ALICE_OTHER}`), 'URL hash must choose the document');
  } finally {
    await context.close();
  }
});

test(`startup ${browserKind}: brand shell paints before slow CSS/vendor, cached shell covers slow bootstrap`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page } = await newPage();
  try {
    await page.route('**/cloud.css', async (route) => {
      await sleep(1400);
      await route.continue();
    });
    await page.route('**/vendor/**', async (route) => {
      await sleep(1400);
      await route.continue();
    });

    const start = Date.now();
    const navigation = page.goto(base, { waitUntil: 'commit' });
    await navigation;
    await page.locator('#boot').waitFor({ state: 'visible', timeout: 3000 });
    const bootVisibleMs = Date.now() - start;
    assert.ok(bootVisibleMs < 1200, `brand boot should paint early, got ${bootVisibleMs}ms`);

    const paint = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const boot = document.querySelector('#boot');
      return {
        background: body.backgroundColor,
        bootBackground: getComputedStyle(boot).backgroundColor,
        text: boot.textContent,
      };
    });
    assert.notEqual(paint.background, 'rgb(0, 0, 0)', 'critical shell must not leave a black screen');
    assert.match(paint.text, /正在打开私人文库/);

    // The delayed stylesheet/vendor must eventually promote and log in.
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    const media = await page.evaluate(() => document.querySelector('#cloud-css')?.media);
    assert.equal(media, 'all');

    await login(page);
    await page.waitForFunction(() => navigator.serviceWorker?.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'new worker should control the shell');

    // Warm PWA launch with a deliberately slow bootstrap: the cached public
    // shell must appear while the authenticated payload is still in flight.
    // A page-level fetch wrapper is used because Playwright routes do not see
    // pass-through requests handled by an active service worker.
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (url.includes('/api/bootstrap')) {
          return new Promise((resolve) => setTimeout(() => resolve(originalFetch(input, init)), 2500));
        }
        return originalFetch(input, init);
      };
    });
    const warmStart = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#boot').waitFor({ state: 'visible', timeout: 1500 });
    const warmBootMs = Date.now() - warmStart;
    assert.ok(warmBootMs < 1200, `cached shell should show quickly, got ${warmBootMs}ms`);
    assert.equal(await page.locator('#cloud-doc').isHidden(), true, 'private body must stay hidden until bootstrap returns');
    await page.locator('#cloud-doc').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => ['HASH_PREFERRED_BODY', '墨读慢网正文'].some(text => (document.querySelector('#cloud-doc')?.textContent || '').includes(text)));

    // API bodies must never enter the shell cache.
    const cacheAudit = await page.evaluate(async () => {
      const keys = await caches.keys();
      const entries = [];
      for (const key of keys) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) entries.push(new URL(request.url).pathname);
      }
      return entries;
    });
    assert.equal(cacheAudit.some((entry) => entry.startsWith('/api/')), false, 'API must never be cached');
    assert.equal(cacheAudit.includes('/'), true, 'public shell should be cached');
  } finally {
    await context.close();
  }
});

test(`startup ${browserKind}: bfcache restore hides private DOM and revalidates without full reload`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page } = await newPage();
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await login(page);
    await page.locator('#cloud-doc').waitFor({ state: 'visible', timeout: 15000 });
    const titleBefore = await page.locator('#doc-title').textContent();

    const navigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (url.includes('/api/bootstrap')) {
          return new Promise((resolve) => setTimeout(() => resolve(originalFetch(input, init)), 1200));
        }
        return originalFetch(input, init);
      };
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });

    // The snapshot must be hidden immediately, before the revalidation RTT.
    await page.waitForFunction(() => document.querySelector('#boot')?.hidden === false);
    assert.equal(await page.locator('#cloud-doc').isHidden(), true);
    assert.equal(await page.locator('#cloud-shell').isHidden(), true);

    await page.locator('#cloud-doc').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.locator('#doc-title').textContent(), titleBefore);
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), navigationCount);
  } finally {
    await context.close();
  }
});

test(`startup ${browserKind}: late bootstrap cannot undo logout`, {skip: !canRun, timeout:20000}, async()=>{
  const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
  let release,ready;const held=new Promise(r=>ready=r);const unblock=new Promise(r=>release=r);
  try {
    await page.route('**/api/bootstrap',async route=>{const response=await route.fetch();if(response.status()===200){ready();await unblock;}await route.fulfill({response});});
    await page.goto(base);await page.locator('#login-user').fill('alice');await page.locator('#login-pass').fill('correct horse battery');await page.click('#login-submit');await held;
    await page.click('#logout-button');await page.locator('#auth-screen').waitFor({state:'visible'});release();await sleep(250);
    assert.equal(await page.locator('#auth-screen').isVisible(),true);assert.equal(await page.locator('#cloud-shell').isHidden(),true);assert.equal(await page.locator('#cloud-doc').textContent(),'');
  } finally {release?.();await context.close();}
});

test(`startup ${browserKind}: failed post-login bootstrap displays the error`, {skip: !canRun, timeout:20000}, async()=>{
  const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
  try {
    await page.route('**/api/bootstrap',async route=>{const response=await route.fetch();if(response.status()===200)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'文库暂时无法加载，请重试。'}})});else await route.fulfill({response});});
    await page.goto(base);await page.locator('#login-user').fill('alice');await page.locator('#login-pass').fill('correct horse battery');await page.click('#login-submit');await page.locator('#login-error').waitFor({state:'visible'});
    assert.equal(await page.locator('#auth-screen').isVisible(),true);assert.match(await page.locator('#login-error').textContent(),/暂时无法加载/);
  } finally {await context.close();}
});
