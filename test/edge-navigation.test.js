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

const ALPHA = 'a'.repeat(32);
const BETA = 'b'.repeat(32);
const WIDGET = 'c'.repeat(32);

function bodyFor(marker) {
  return [
    `# ${marker}`,
    '',
    `${marker}_BODY`,
    '',
    ...Array.from({ length: 24 }, (_, index) => [
      `## ${marker} 章节 ${index + 1}`,
      '',
      `${'安静地读一段文字，位置和选择都应被记住。'.repeat(8)}`,
      '',
    ]).flat(),
  ].join('\n');
}

const HTML_BODY = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<style>body{margin:0;padding:24px;font:18px sans-serif}button{padding:18px 24px}'
  + '#long{height:1200px}</style></head><body><h1>交互记忆</h1>'
  + '<button id="counter">0</button><div id="long"></div>'
  + '<script>let n=0;document.querySelector("#counter").onclick=()=>document.querySelector("#counter").textContent=++n;</script>'
  + '</body></html>';

let tmpRoot;
let server;
let base;
let browser;

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-edge-nav-'));
  const dataDir = path.join(tmpRoot, 'data');
  const store = await new CloudStore(dataDir).init();
  const alice = await store.addUser('alice', 'correct horse battery');
  await store.upsertDocument(alice.user.id, ALPHA, { name: 'alpha.md', markdown: bodyFor('ALPHA') });
  await store.upsertDocument(alice.user.id, BETA, { name: 'beta.md', markdown: bodyFor('BETA') });
  await store.upsertDocument(alice.user.id, WIDGET, {
    name: 'widget.html',
    kind: 'html',
    content: HTML_BODY,
  });

  server = await createCloudServer({ dataDir, publicDir, pollMs: 1000 });
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

async function newPage({
  viewport = { width: 390, height: 844 },
  storageState = undefined,
  standalone = true,
  initScript = null,
  initScriptArg = undefined,
} = {}) {
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: false,
    serviceWorkers: 'block',
    ...(storageState ? { storageState } : {}),
  });
  // Playwright WebKit reports maxTouchPoints=0 even with hasTouch; emulate
  // touch hardware so the touch-only edge strip is armed for these tests.
  await context.addInitScript((isStandalone) => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 });
    if (isStandalone) {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    }
  }, standalone);
  if (initScript) await context.addInitScript(initScript, initScriptArg);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

async function login(page, docId) {
  await page.goto(`${base}/#doc-${docId}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#login-user').fill('alice');
  await page.locator('#login-pass').fill('correct horse battery');
  await page.locator('#login-submit').click();
  await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
}

async function waitForMarkdown(page, marker) {
  await page.waitForFunction(
    (value) => (document.querySelector('#cloud-doc')?.textContent || '').includes(value),
    marker,
    { timeout: 15000 },
  );
}

async function waitForLibraryOpen(page) {
  await page.waitForFunction(() => {
    const library = document.querySelector('#library');
    const scrim = document.querySelector('#scrim');
    return Boolean(library?.classList.contains('is-open') && scrim?.hidden === false);
  }, { timeout: 10000 });
}

async function waitForLibraryClosed(page) {
  await page.waitForFunction(() => {
    const library = document.querySelector('#library');
    const scrim = document.querySelector('#scrim');
    return Boolean(!library?.classList.contains('is-open') && scrim?.hidden === true);
  }, { timeout: 10000 });
}

async function historySnapshot(page) {
  return page.evaluate(() => ({
    length: history.length,
    state: history.state,
    hash: location.hash,
    path: `${location.pathname}${location.search}`,
  }));
}

async function browserBack(page) {
  await page.evaluate(() => history.back());
}

async function browserForward(page) {
  await page.evaluate(() => history.forward());
}

// Synthetic touch events exercise the JS gesture state machine only. They are
// not a substitute for validating iOS's OS-level edge-back gesture.
async function dispatchTouch(page, type, touches, changed = touches) {
  return page.evaluate(({ type, touches, changed }) => {
    const points = (list) => list.map((point) => ({
      identifier: point.id ?? 0,
      clientX: point.x,
      clientY: point.y,
      pageX: point.x,
      pageY: point.y,
      screenX: point.x,
      screenY: point.y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
      target: document.body,
    }));
    // A touch sequence is dispatched to the element under the first finger,
    // as a real browser would. Later moves keep that movement target even if
    // the finger leaves the narrow strip.
    let target = window.__edgeSwipeTarget || document.body;
    if (type === 'touchstart' && touches.length === 1) {
      target = document.elementFromPoint(touches[0].x, touches[0].y) || document.body;
      window.__edgeSwipeTarget = target;
    }
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points(touches) });
    Object.defineProperty(event, 'targetTouches', { value: points(touches) });
    Object.defineProperty(event, 'changedTouches', { value: points(changed) });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, touches, changed });
}

async function swipe(page, { start, end, cancel = false, secondFinger = false }) {
  await dispatchTouch(page, 'touchstart', [start], [start]);
  if (secondFinger) {
    const second = { id: 2, x: start.x + 60, y: start.y + 6 };
    await dispatchTouch(page, 'touchstart', [start, second], [second]);
    await dispatchTouch(page, 'touchmove', [
      { id: start.id ?? 1, x: end.x, y: end.y },
      { id: 2, x: second.x + 40, y: second.y },
    ], [{ id: start.id ?? 1, x: end.x, y: end.y }]);
    await dispatchTouch(page, 'touchend', [], [{ id: start.id ?? 1, x: end.x, y: end.y }]);
    return false;
  }
  const mid = {
    id: start.id ?? 1,
    x: Math.round((start.x + end.x) / 2),
    y: Math.round((start.y + end.y) / 2),
  };
  const prevented = await dispatchTouch(page, 'touchmove', [mid], [mid]);
  if (cancel) {
    await dispatchTouch(page, 'touchcancel', [], [mid]);
    return prevented;
  }
  await dispatchTouch(page, 'touchmove', [end], [end]);
  await dispatchTouch(page, 'touchend', [], [end]);
  return prevented;
}

async function assertLibraryStaysClosed(page, label) {
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#scrim').isHidden(), true, `${label} must not open the library`);
  assert.equal(await page.locator('#library').evaluate((node) => node.classList.contains('is-open')), false);
}

test(`history ${browserKind}: Back opens library, Forward/selection return reader, entries do not grow`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');

    let snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'reader');
    assert.equal(snap.hash, `#doc-${ALPHA}`);
    const length = snap.length;

    // A normal poll/render pass must not touch history.
    await page.waitForTimeout(1400);
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'reader');
    assert.equal(snap.length, length, 'polling must not add history entries');

    await browserBack(page);
    await waitForLibraryOpen(page);
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'library');
    assert.equal(snap.hash, '');
    assert.equal(snap.length, length, 'Back must not add history entries');
    assert.equal(await page.locator('#auth-screen').isVisible(), false);
    assert.match(await page.locator('#cloud-doc').textContent(), /ALPHA_BODY/);

    await browserForward(page);
    await waitForLibraryClosed(page);
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'reader');
    assert.equal(snap.hash, `#doc-${ALPHA}`);
    assert.equal(snap.length, length, 'Forward must not add history entries');

    for (let index = 0; index < 2; index += 1) {
      await browserBack(page);
      await waitForLibraryOpen(page);
      assert.equal((await historySnapshot(page)).length, length);
      await browserForward(page);
      await waitForLibraryClosed(page);
      assert.equal((await historySnapshot(page)).length, length);
    }

    // Switching documents from the reader replaces the one reader entry.
    await page.locator('#library-toggle').click();
    await waitForLibraryOpen(page);
    await page.locator(`button[data-doc-id="${BETA}"]`).click();
    await waitForMarkdown(page, 'BETA_BODY');
    snap = await historySnapshot(page);
    assert.equal(snap.hash, `#doc-${BETA}`);
    assert.equal(snap.length, length, 'document switch must reuse the reader entry');

    // Back to library, then choose the preserved document from the list.
    await browserBack(page);
    await waitForLibraryOpen(page);
    await page.locator(`button[data-doc-id="${ALPHA}"]`).click();
    await waitForMarkdown(page, 'ALPHA_BODY');
    snap = await historySnapshot(page);
    assert.equal(snap.hash, `#doc-${ALPHA}`);
    assert.equal(snap.length, length, 'choosing from library must not grow history');

    // One more Back reaches the library, and a second Back is free to leave.
    await browserBack(page);
    await waitForLibraryOpen(page);
    assert.equal(await page.locator('#auth-screen').isVisible(), false);
    await page.goBack({ waitUntil: 'commit', timeout: 10000 }).catch(() => {});
    assert.match(page.url(), /^about:/, 'a second Back from the library must exit normally');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`history ${browserKind}: logout then Back/Forward never restores private DOM`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, WIDGET);
    const frame = page.frameLocator('#html-frame');
    await frame.locator('#counter').waitFor({ timeout: 15000 });
    await page.locator('#doc-loading').waitFor({ state: 'hidden' });
    await frame.locator('#counter').click();
    assert.equal(await frame.locator('#counter').textContent(), '1');

    await page.locator('#logout-button').click();
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.locator('#cloud-shell').isHidden(), true);
    assert.equal(await page.locator('#html-frame').count(), 0);
    assert.equal((await page.locator('#cloud-doc').textContent()).trim(), '');
    let snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'auth');
    assert.equal(snap.hash, '');

    await browserBack(page);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#auth-screen').isVisible(), true);
    assert.equal(await page.locator('#cloud-shell').isHidden(), true);
    assert.equal(await page.locator('#html-frame').count(), 0);
    assert.equal((await page.locator('#cloud-doc').textContent()).trim(), '');
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'auth');
    assert.equal(snap.hash, '');

    await browserForward(page);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#auth-screen').isVisible(), true);
    assert.equal(await page.locator('#cloud-shell').isHidden(), true);
    assert.equal(await page.locator('#html-frame').count(), 0);
    assert.equal((await page.locator('#cloud-doc').textContent()).trim(), '');
    assert.equal((await historySnapshot(page)).state?.view, 'auth');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`history ${browserKind}: logout then re-login reuses the same library base`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');
    const length = (await historySnapshot(page)).length;

    await page.locator('#logout-button').click();
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    let snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'auth');
    assert.equal(snap.length, length);

    await page.locator('#login-user').fill('alice');
    await page.locator('#login-pass').fill('correct horse battery');
    await page.locator('#login-submit').click();
    await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => history.state?.view === 'reader', { timeout: 10000 });
    snap = await historySnapshot(page);
    assert.equal(snap.length, length, 're-login must reuse the existing library base');

    await browserBack(page);
    await waitForLibraryOpen(page);
    assert.equal((await historySnapshot(page)).length, length);
    assert.equal((await historySnapshot(page)).state?.view, 'library');
    await page.goBack({ waitUntil: 'commit', timeout: 10000 }).catch(() => {});
    assert.match(page.url(), /^about:/, 'Back from the reused library base must exit normally');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`history ${browserKind}: reload on the logged-out screen reuses the library base`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');
    const length = (await historySnapshot(page)).length;

    await page.locator('#logout-button').click();
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal((await historySnapshot(page)).state?.view, 'auth');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    let snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'auth');
    assert.equal(snap.length, length);

    await page.locator('#login-user').fill('alice');
    await page.locator('#login-pass').fill('correct horse battery');
    await page.locator('#login-submit').click();
    await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => history.state?.view === 'reader', { timeout: 10000 });
    snap = await historySnapshot(page);
    assert.equal(snap.length, length, 're-login after reload must reuse the library base');

    await browserBack(page);
    await waitForLibraryOpen(page);
    assert.equal((await historySnapshot(page)).length, length);
    await page.goBack({ waitUntil: 'commit', timeout: 10000 }).catch(() => {});
    assert.match(page.url(), /^about:/, 'Back from the reused library base must exit normally');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`edge gesture ${browserKind}: right swipe opens library; vertical, center, small, cancel and multi-touch do not`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');
    const readerHash = `#doc-${ALPHA}`;

    const horizontalPrevented = await swipe(page, {
      start: { id: 1, x: 8, y: 420 },
      end: { id: 1, x: 96, y: 424 },
    });
    assert.equal(horizontalPrevented, true, 'a deliberate right swipe may suppress the native back gesture');
    await waitForLibraryOpen(page);
    assert.equal(new URL(page.url()).hash, readerHash, 'opening the drawer does not rewrite the reader URL');
    assert.match(await page.locator('#cloud-doc').textContent(), /ALPHA_BODY/);
    await page.locator('#library-close').click();
    await waitForLibraryClosed(page);

    const verticalPrevented = await swipe(page, {
      start: { id: 1, x: 8, y: 700 },
      end: { id: 1, x: 10, y: 470 },
    });
    assert.equal(verticalPrevented, false, 'vertical reading must not be intercepted');
    await assertLibraryStaysClosed(page, 'vertical swipe');

    await swipe(page, {
      start: { id: 1, x: 210, y: 420 },
      end: { id: 1, x: 340, y: 424 },
    });
    await assertLibraryStaysClosed(page, 'center-page drag');

    await swipe(page, {
      start: { id: 1, x: 8, y: 420 },
      end: { id: 1, x: 30, y: 422 },
    });
    await assertLibraryStaysClosed(page, 'small drag');

    const cancelledPrevented = await swipe(page, {
      start: { id: 1, x: 8, y: 420 },
      end: { id: 1, x: 96, y: 424 },
      cancel: true,
    });
    assert.equal(cancelledPrevented, true);
    await assertLibraryStaysClosed(page, 'cancelled drag');

    await swipe(page, {
      start: { id: 1, x: 8, y: 420 },
      end: { id: 1, x: -24, y: 422 },
    });
    await assertLibraryStaysClosed(page, 'leftward drag');

    await swipe(page, {
      start: { id: 1, x: 8, y: 420 },
      end: { id: 1, x: 110, y: 424 },
      secondFinger: true,
    });
    await assertLibraryStaysClosed(page, 'multi-touch');

    await swipe(page, {
      start: { id: 1, x: 40, y: 420 },
      end: { id: 1, x: 120, y: 424 },
    });
    await assertLibraryStaysClosed(page, 'drag starting outside the narrow edge');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`HTML ${browserKind}: widget state survives Back/Forward and the sandbox stays allow-scripts`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    let previewRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/preview')) previewRequests += 1;
    });
    await login(page, WIDGET);
    const frame = page.frameLocator('#html-frame');
    await frame.locator('#counter').waitFor({ timeout: 15000 });
    await page.locator('#doc-loading').waitFor({ state: 'hidden' });
    await frame.locator('#counter').click();
    assert.equal(await frame.locator('#counter').textContent(), '1');
    assert.equal(await page.locator('#html-frame').getAttribute('sandbox'), 'allow-scripts');
    const requestsBefore = previewRequests;

    await browserBack(page);
    await waitForLibraryOpen(page);
    assert.equal(await page.locator('#html-frame').count(), 1);
    assert.equal(await frame.locator('#counter').textContent(), '1');
    assert.equal(previewRequests, requestsBefore, 'Back must not reload the HTML iframe');

    await browserForward(page);
    await waitForLibraryClosed(page);
    assert.equal(await frame.locator('#counter').textContent(), '1');
    assert.equal(previewRequests, requestsBefore, 'Forward must not reload the HTML iframe');

    await browserBack(page);
    await waitForLibraryOpen(page);
    await browserForward(page);
    await waitForLibraryClosed(page);
    assert.equal(await frame.locator('#counter').textContent(), '1');
    assert.equal(previewRequests, requestsBefore);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`wide ${browserKind}: Back reveals the sidebar without a scrim and resize stays coherent`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage({ viewport: { width: 1194, height: 834 } });
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');
    const length = (await historySnapshot(page)).length;

    await browserBack(page);
    await page.waitForFunction(() => {
      const scrim = document.querySelector('#scrim');
      const doc = document.querySelector('#cloud-doc');
      return Boolean(scrim?.hidden === true && doc && !doc.hidden);
    }, { timeout: 10000 });
    let snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'library');
    assert.equal(snap.hash, '');
    assert.equal(snap.length, length);
    assert.equal(await page.locator('#scrim').isHidden(), true);
    assert.equal(await page.locator('#cloud-doc').isVisible(), true);
    assert.equal(await page.locator('#library').isVisible(), true);
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('#library')), { timeout: 5000 });

    await browserForward(page);
    await waitForLibraryClosed(page);
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'reader');
    assert.equal(snap.hash, `#doc-${ALPHA}`);
    assert.equal(snap.length, length);

    await browserBack(page);
    await page.waitForFunction(() => document.querySelector('#scrim')?.hidden === true, { timeout: 10000 });
    await page.setViewportSize({ width: 834, height: 1194 });
    await waitForLibraryOpen(page);
    await page.setViewportSize({ width: 1194, height: 834 });
    await page.waitForFunction(() => document.querySelector('#scrim')?.hidden === true, { timeout: 10000 });
    assert.equal(await page.locator('#cloud-doc').isVisible(), true);

    await browserForward(page);
    await waitForLibraryClosed(page);
    assert.equal((await historySnapshot(page)).hash, `#doc-${ALPHA}`);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`refresh/bfcache ${browserKind}: the library view is remembered without duplicate entries`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');
    await browserBack(page);
    await waitForLibraryOpen(page);
    const length = (await historySnapshot(page)).length;

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
    await waitForLibraryOpen(page);
    await waitForMarkdown(page, 'ALPHA_BODY');
    let snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'library');
    assert.equal(snap.hash, '');
    assert.equal(snap.length, length, 'refresh must keep one library entry');

    await browserForward(page);
    await waitForLibraryClosed(page);
    await waitForMarkdown(page, 'ALPHA_BODY');
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'reader');
    assert.equal(snap.hash, `#doc-${ALPHA}`);
    assert.equal(snap.length, length, 'Forward after refresh must not add entries');

    await page.route('**/api/bootstrap*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.locator('#boot').waitFor({ state: 'visible', timeout: 3000 });
    await waitForMarkdown(page, 'ALPHA_BODY');
    await page.unroute('**/api/bootstrap*');
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'reader');
    assert.equal(snap.length, length, 'bfcache revalidation must not add entries');

    await browserBack(page);
    await waitForLibraryOpen(page);
    await page.route('**/api/bootstrap*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.locator('#boot').waitFor({ state: 'visible', timeout: 3000 });
    await waitForMarkdown(page, 'ALPHA_BODY');
    await waitForLibraryOpen(page);
    await page.unroute('**/api/bootstrap*');
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'library');
    assert.equal(snap.hash, '');
    assert.equal(snap.length, length, 'bfcache must keep the remembered library view');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`startup ${browserKind}: boot leading-edge touch is claimed before bootstrap arms the strip`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');

    // Keep the boot screen up long enough to exercise the window that used to
    // fall through to WebKit's native Back gesture.
    await page.route('**/api/bootstrap*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#boot').waitFor({ state: 'visible', timeout: 3000 });

    const leftEdge = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 420 }]);
    assert.equal(leftEdge, true, 'a boot-time leading-edge touch must suppress the native Back gesture');
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 8, y: 420 }]);

    const center = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 200, y: 420 }]);
    assert.equal(center, false, 'boot-time central touches must stay native');
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 200, y: 420 }]);

    await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
    await waitForMarkdown(page, 'ALPHA_BODY');
    await page.unroute('**/api/bootstrap*');
    assert.equal(await page.locator('#edge-nav').isVisible(), true, 'the normal strip must arm after bootstrap');

    await swipe(page, {
      start: { id: 1, x: 8, y: 420 },
      end: { id: 1, x: 110, y: 424 },
    });
    await waitForLibraryOpen(page);
    await page.locator('#library-close').click();
    await waitForLibraryClosed(page);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`startup ${browserKind}: wide boot guard stops on auth so browser navigation stays native`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage({ viewport: { width: 1194, height: 834 } });
  try {
    await page.route('**/api/bootstrap*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#boot').waitFor({ state: 'visible', timeout: 3000 });

    const bootLeft = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 420 }]);
    assert.equal(bootLeft, true, 'wide boot must also claim the leading edge');
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 8, y: 420 }]);

    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    await page.unroute('**/api/bootstrap*');
    const authLeft = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 420 }]);
    assert.equal(authLeft, false, 'the auth screen must not block a real browser Back');
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 8, y: 420 }]);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`startup ${browserKind}: a normal browser tab keeps boot-time Back native`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage({ standalone: false });
  try {
    await page.route('**/api/bootstrap*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#boot').waitFor({ state: 'visible', timeout: 3000 });

    const leftEdge = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 420 }]);
    assert.equal(leftEdge, false, 'non-PWA tabs must not have their browser Back gesture trapped');
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 8, y: 420 }]);

    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    await page.unroute('**/api/bootstrap*');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`history ${browserKind}: a legacy auth hint without a base does not skip base creation on login`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage({
    initScript: () => {
      try {
        if (!location.protocol.startsWith('http') || sessionStorage.getItem('modu.test.authRestored') === '1') return;
        sessionStorage.setItem('modu.test.authRestored', '1');
        history.replaceState({ moduCloud: 1, view: 'auth', libraryBehind: true }, '', location.href);
      } catch {
        // Ignore restricted storage; the app still exercises its own boot.
      }
    },
  });
  try {
    await page.goto(`${base}/#doc-${ALPHA}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    let snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'auth');
    assert.equal(snap.state?.libraryBehind, undefined, 'a hint without base evidence must not be preserved');

    await page.locator('#login-user').fill('alice');
    await page.locator('#login-pass').fill('correct horse battery');
    await page.locator('#login-submit').click();
    await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => history.state?.view === 'reader', { timeout: 10000 });
    await waitForMarkdown(page, 'ALPHA_BODY');
    snap = await historySnapshot(page);
    assert.equal(snap.state?.base, true);
    const length = snap.length;

    await browserBack(page);
    await waitForLibraryOpen(page);
    assert.equal((await historySnapshot(page)).state?.view, 'library');
    assert.equal((await historySnapshot(page)).length, length);

    await page.goBack({ waitUntil: 'commit', timeout: 10000 }).catch(() => {});
    assert.match(page.url(), /^about:/, 'the library base must still let a second Back leave normally');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`history ${browserKind}: restored reader without a library base repairs once, then Back opens library`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const first = await newPage();
  let storageState;
  try {
    await login(first.page, ALPHA);
    await waitForMarkdown(first.page, 'ALPHA_BODY');
    storageState = await first.context.storageState();
  } finally {
    await first.context.close();
  }

  const { context, page, errors } = await newPage({
    storageState,
    initScript: ({ docId }) => {
      // Simulate a standalone PWA restoring only the current entry and its
      // view state, without the library entry that originally sat behind it.
      try {
        if (!location.protocol.startsWith('http') || sessionStorage.getItem('modu.test.restored') === '1') return;
        sessionStorage.setItem('modu.test.restored', '1');
        history.replaceState({ moduCloud: 1, view: 'reader', docId }, '', `#doc-${docId}`);
      } catch {
        // Ignore restricted storage; the app still exercises its own boot.
      }
    },
    initScriptArg: { docId: ALPHA },
  });
  try {
    await page.goto(`${base}/#doc-${ALPHA}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
    await waitForMarkdown(page, 'ALPHA_BODY');

    let snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'reader');
    assert.equal(snap.state?.base, true, 'the restored reader must gain a durable base marker');
    assert.equal(await page.locator('#edge-nav').isVisible(), true);
    const repairedLength = snap.length;

    await browserBack(page);
    await waitForLibraryOpen(page);
    snap = await historySnapshot(page);
    assert.equal(snap.state?.view, 'library');
    assert.equal(snap.length, repairedLength, 'the repair must not add entries on traversal');
    assert.match(await page.locator('#cloud-doc').textContent(), /ALPHA_BODY/);

    await browserForward(page);
    await waitForLibraryClosed(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
    await waitForMarkdown(page, 'ALPHA_BODY');
    snap = await historySnapshot(page);
    assert.equal(snap.state?.base, true);
    assert.equal(snap.length, repairedLength, 'reloading a repaired reader must not repair again');

    await browserBack(page);
    await waitForLibraryOpen(page);
    assert.equal((await historySnapshot(page)).length, repairedLength);
    assert.match(await page.locator('#cloud-doc').textContent(), /ALPHA_BODY/);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});


test(`PWA ${browserKind}: repeated edge swipes in open library and landscape keep history intact`, {
  skip: canRun ? false : 'No Playwright browser available', timeout: 30000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');
    await page.locator('#library-toggle').click();
    await waitForLibraryOpen(page);
    const initial = await historySnapshot(page);
    for (let i = 0; i < 3; i++) {
      assert.equal(await dispatchTouch(page, 'touchstart', [{id: 1, x: 5, y: 700}]), true);
      await dispatchTouch(page, 'touchcancel', [], [{id: 1, x: 5, y: 700}]);
    }
    assert.deepEqual(await historySnapshot(page), initial);
    assert.equal(await dispatchTouch(page, 'touchstart', [{id: 1, x: 200, y: 700}]), false);
    await dispatchTouch(page, 'touchcancel', []);
    await page.setViewportSize({width: 1194, height: 834});
    assert.equal(await dispatchTouch(page, 'touchstart', [{id: 1, x: 5, y: 700}]), true);
    await dispatchTouch(page, 'touchcancel', []);
    assert.deepEqual(await historySnapshot(page), initial);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});


test(`cold startup ${browserKind}: PWA edge protection does not wait for renderer downloads`, {
  skip: canRun ? false : 'No Playwright browser available', timeout: 30000,
}, async () => {
  const { context, page, errors } = await newPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.route('**/vendor/**', async route => { await gate; await route.continue().catch(() => {}); });
    await page.goto(base, {waitUntil: 'commit'});
    await page.waitForFunction(() => typeof onPwaEdgeTouchStart === 'function');
    assert.equal(await page.evaluate(() => typeof window.markdownit), 'undefined');
    assert.equal(await page.locator('#boot').isVisible(), true);
    assert.equal(await dispatchTouch(page, 'touchstart', [{id: 1, x: 5, y: 400}]), true);
    await dispatchTouch(page, 'touchcancel', []);
    release();
    await page.locator('#auth-screen').waitFor({state: 'visible'});
    assert.equal(await dispatchTouch(page, 'touchstart', [{id: 1, x: 5, y: 400}]), false);
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});


test(`startup ${browserKind}: delayed auth focus does not steal the password field`, {
  skip: canRun ? false : 'No Playwright browser available', timeout: 15000,
}, async () => {
  const {context, page} = await newPage();
  try {
    await page.goto(base);
    await page.locator('#auth-screen').waitFor();
    await page.evaluate(() => { showAuth(''); document.querySelector('#login-pass').focus(); });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'login-pass');
  } finally { await context.close(); }
});
