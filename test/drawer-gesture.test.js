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
const WIDGET = 'c'.repeat(32);

function bodyFor(marker) {
  return [
    `# ${marker}`,
    '',
    `${marker}_BODY`,
    '',
    ...Array.from({ length: 30 }, (_, index) => [
      `## ${marker} 章节 ${index + 1}`,
      '',
      `${'边缘滑动只应移动覆盖的抽屉，正文位置与滚动都保持不动。'.repeat(8)}`,
      '',
    ]).flat(),
  ].join('\n');
}

const HTML_BODY = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<style>body{margin:0;padding:24px;font:18px sans-serif}button{padding:18px 24px}'
  + '#long{height:1600px}</style></head><body><h1>交互记忆</h1>'
  + '<button id="counter">0</button><div id="long"></div>'
  + '<script>let n=0;document.querySelector("#counter").onclick=()=>document.querySelector("#counter").textContent=++n;</script>'
  + '</body></html>';

let tmpRoot;
let server;
let base;
let browser;

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-drawer-gesture-'));
  const dataDir = path.join(tmpRoot, 'data');
  const store = await new CloudStore(dataDir).init();
  const alice = await store.addUser('alice', 'correct horse battery');
  await store.upsertDocument(alice.user.id, ALPHA, { name: 'alpha.md', markdown: bodyFor('ALPHA') });
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

async function newPage({ viewport = { width: 390, height: 844 } } = {}) {
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: false,
    serviceWorkers: 'block',
  });
  // Playwright WebKit reports maxTouchPoints=0 even with hasTouch; emulate
  // touch hardware so the touch-only edge strip is armed for these tests.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 });
  });
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

async function waitForWidget(page) {
  const frame = page.frameLocator('#html-frame');
  await frame.locator('#counter').waitFor({ timeout: 15000 });
  await page.locator('#doc-loading').waitFor({ state: 'hidden', timeout: 15000 });
  return frame;
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
    state: JSON.stringify(history.state),
    href: location.href,
    hash: location.hash,
    path: `${location.pathname}${location.search}`,
  }));
}

async function readerSnapshot(page) {
  return page.evaluate(() => {
    const reader = document.querySelector('#reader-scroll');
    const rect = reader.getBoundingClientRect();
    const iframe = document.querySelector('#html-frame');
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scrollTop: reader.scrollTop,
      transform: getComputedStyle(reader).transform,
      iframePresent: Boolean(iframe),
      iframeSrc: iframe?.src || '',
      iframeIdentity: iframe?.__edgeIdentity || '',
      frameWindow: Boolean(iframe?.__edgeFrameWindow && iframe.contentWindow === iframe.__edgeFrameWindow),
    };
  });
}

// Synthetic Touch events exercise the parent document only, exactly where the
// strip lives. They prove defaultPrevented/state handling; they cannot prove
// that iOS's OS-level edge-back animation is gone on a real device.
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
    let target = window.__drawerTouchTarget || document.body;
    let inEdge = Boolean(target.closest?.('#edge-nav'));
    if (type === 'touchstart' && touches.length === 1) {
      target = document.elementFromPoint(touches[0].x, touches[0].y) || document.body;
      window.__drawerTouchTarget = target;
      inEdge = Boolean(target.closest?.('#edge-nav'));
    }
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points(touches) });
    Object.defineProperty(event, 'targetTouches', { value: points(touches) });
    Object.defineProperty(event, 'changedTouches', { value: points(changed) });
    target.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      inEdge,
      targetId: target.id || '',
      targetClass: typeof target.className === 'string' ? target.className : '',
    };
  }, { type, touches, changed });
}

async function swipe(page, { start, end, cancel = false, secondFinger = false, between = null }) {
  const started = await dispatchTouch(page, 'touchstart', [start], [start]);
  if (between) await between();
  if (secondFinger) {
    const second = { id: 2, x: start.x + 60, y: start.y + 6 };
    await dispatchTouch(page, 'touchstart', [start, second], [second]);
    await dispatchTouch(page, 'touchmove', [
      { id: start.id ?? 1, x: end.x, y: end.y },
      { id: 2, x: second.x + 40, y: second.y },
    ], [{ id: start.id ?? 1, x: end.x, y: end.y }]);
    await dispatchTouch(page, 'touchend', [], [{ id: start.id ?? 1, x: end.x, y: end.y }]);
    return { ...started, moved: null };
  }
  const mid = {
    id: start.id ?? 1,
    x: Math.round((start.x + end.x) / 2),
    y: Math.round((start.y + end.y) / 2),
  };
  const moved = await dispatchTouch(page, 'touchmove', [mid], [mid]);
  if (cancel) {
    await dispatchTouch(page, 'touchcancel', [], [mid]);
    return { ...started, moved };
  }
  await dispatchTouch(page, 'touchmove', [end], [end]);
  await dispatchTouch(page, 'touchend', [], [end]);
  return { ...started, moved };
}

async function assertLibraryStaysClosed(page, label) {
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#scrim').isHidden(), true, `${label} must not open the drawer`);
  assert.equal(
    await page.locator('#library').evaluate((node) => node.classList.contains('is-open')),
    false,
    `${label} must leave the drawer closed`,
  );
}

test(`edge hit region ${browserKind}: only narrow authenticated reader arms a real target above the iframe`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await page.goto(`${base}/#doc-${WIDGET}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.locator('#edge-nav').isHidden(), true, 'auth screen must not arm the strip');
    const authStart = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 400 }]);
    assert.equal(authStart.prevented, false, 'auth surface touchstart must remain native');

    await login(page, WIDGET);
    const frame = await waitForWidget(page);
    assert.equal(await frame.locator('#counter').textContent(), '0');

    const navBox = await page.locator('#edge-nav').boundingBox();
    const iframeBox = await page.locator('#html-frame').boundingBox();
    assert.ok(navBox.width >= 30 && navBox.width <= 34, `edge strip width ${navBox.width} should be about 32px`);
    assert.ok(navBox.height > 200, `edge strip height ${navBox.height} should span the reader`);
    assert.ok(Math.abs(navBox.x) <= 1, `edge strip x ${navBox.x} should sit at the left edge`);
    assert.ok(iframeBox.height > 200, 'the actual sandboxed iframe should be laid out');

    const y = Math.round(iframeBox.y + Math.min(120, iframeBox.height / 2));
    const hit = await page.evaluate(({ x, y }) => {
      const nav = document.querySelector('#edge-nav');
      nav.__edgeIdentity = 'strip';
      const top = document.elementFromPoint(x, y);
      const previous = nav.style.visibility;
      nav.style.visibility = 'hidden';
      const below = document.elementFromPoint(x, y);
      nav.style.visibility = previous;
      return {
        topId: top?.id || '',
        belowId: below?.id || '',
        belowTag: below?.tagName || '',
      };
    }, { x: 8, y });
    assert.equal(hit.topId, 'edge-nav', 'the strip must be the hit target before the iframe');
    assert.equal(hit.belowId, 'html-frame', 'without the strip the same point reaches the real iframe');

    const edgeStart = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y }]);
    assert.equal(edgeStart.inEdge, true);
    assert.equal(edgeStart.prevented, true, 'eligible edge touchstart must call preventDefault immediately');
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 8, y }]);

    const central = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 210, y }]);
    assert.equal(central.inEdge, false);
    assert.equal(central.prevented, false, 'central content touchstart must not be intercepted');
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 210, y }]);

    await page.setViewportSize({ width: 1194, height: 834 });
    await page.waitForFunction(() => {
      const nav = document.querySelector('#edge-nav');
      return Boolean(nav?.hidden || getComputedStyle(nav).display === 'none');
    }, { timeout: 5000 });
    assert.equal(await page.locator('#edge-nav').isVisible(), false, 'wide layout must not expose the strip');
    const wideStart = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 400 }]);
    assert.equal(wideStart.inEdge, false);
    assert.equal(wideStart.prevented, false, 'wide layout touchstart must remain native');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`drawer gesture ${browserKind}: opens an overlay without URL, history or iframe/reader changes`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, WIDGET);
    const frame = await waitForWidget(page);
    await frame.locator('#counter').click();
    assert.equal(await frame.locator('#counter').textContent(), '1');

    await page.evaluate(() => {
      const iframe = document.querySelector('#html-frame');
      iframe.__edgeIdentity = 'same-frame';
      iframe.__edgeFrameWindow = iframe.contentWindow;
      window.__popstateCount = 0;
      window.addEventListener('popstate', () => { window.__popstateCount += 1; });
    });
    const beforeHistory = await historySnapshot(page);
    const beforeReader = await readerSnapshot(page);
    assert.equal(beforeReader.iframePresent, true);
    assert.equal(beforeReader.iframeIdentity, 'same-frame');
    assert.equal(beforeReader.frameWindow, true);
    assert.equal(beforeReader.transform, 'none');

    const gesture = await swipe(page, {
      start: { id: 1, x: 8, y: 360 },
      end: { id: 1, x: 110, y: 364 },
    });
    assert.equal(gesture.prevented, true, 'the opening swipe must cancel touchstart');
    assert.equal(gesture.moved.prevented, true);
    await waitForLibraryOpen(page);

    const afterHistory = await historySnapshot(page);
    assert.deepEqual(afterHistory, beforeHistory, 'opening the overlay must not touch URL or history');
    assert.equal(await page.evaluate(() => window.__popstateCount), 0, 'opening the overlay must not fire popstate');

    const afterReader = await readerSnapshot(page);
    assert.deepEqual(afterReader.rect, beforeReader.rect, 'the reading viewport must not move');
    assert.equal(afterReader.scrollTop, beforeReader.scrollTop, 'the reader scroll position must be retained');
    assert.equal(afterReader.transform, 'none', 'the reader must stay static while the drawer animates');
    assert.equal(afterReader.iframeIdentity, 'same-frame', 'the same iframe node must be retained');
    assert.equal(afterReader.iframeSrc, beforeReader.iframeSrc, 'the iframe must not navigate');
    assert.equal(afterReader.frameWindow, true, 'the iframe content window must be the same');
    assert.equal(await frame.locator('#counter').textContent(), '1', 'widget state must survive the overlay');

    const drawerStyle = await page.locator('#library').evaluate((node) => ({
      position: getComputedStyle(node).position,
      zIndex: getComputedStyle(node).zIndex,
    }));
    assert.equal(drawerStyle.position, 'fixed', 'the drawer must overlay the static reader');
    assert.ok(Number(drawerStyle.zIndex) >= 50);
    assert.equal(await page.locator('#edge-nav').isHidden(), true, 'the strip must disarm while the drawer is open');

    await page.locator('#library-close').click();
    await waitForLibraryClosed(page);
    assert.equal(await page.locator('#edge-nav').isVisible(), true, 'closing the drawer must re-arm the strip');
    assert.deepEqual(await historySnapshot(page), beforeHistory, 'closing the overlay must not touch history either');
    assert.deepEqual(await readerSnapshot(page), afterReader, 'closing must not move the reader or reload the iframe');
    assert.equal(await frame.locator('#counter').textContent(), '1');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`drawer gesture ${browserKind}: vertical, cancelled, multi-touch and rotated gestures never open`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');
    await page.evaluate(() => {
      const reader = document.querySelector('#reader-scroll');
      reader.scrollTop = 320;
      window.__popstateCount = 0;
      window.addEventListener('popstate', () => { window.__popstateCount += 1; });
    });
    const beforeHistory = await historySnapshot(page);
    const beforeReader = await readerSnapshot(page);
    assert.ok(beforeReader.scrollTop > 0, 'the reader should be scrolled for the retention check');

    const vertical = await swipe(page, {
      start: { id: 1, x: 8, y: 700 },
      end: { id: 1, x: 10, y: 470 },
    });
    assert.equal(vertical.prevented, true, 'the edge strip reserves the gesture from its first touch');
    await assertLibraryStaysClosed(page, 'vertical edge drag');

    const cancelled = await swipe(page, {
      start: { id: 1, x: 8, y: 430 },
      end: { id: 1, x: 110, y: 434 },
      cancel: true,
    });
    assert.equal(cancelled.prevented, true);
    await assertLibraryStaysClosed(page, 'cancelled edge drag');

    const leftward = await swipe(page, {
      start: { id: 1, x: 8, y: 430 },
      end: { id: 1, x: -24, y: 434 },
    });
    assert.equal(leftward.prevented, true);
    await assertLibraryStaysClosed(page, 'leftward edge drag');

    const multi = await swipe(page, {
      start: { id: 1, x: 8, y: 430 },
      end: { id: 1, x: 118, y: 434 },
      secondFinger: true,
    });
    assert.equal(multi.prevented, true);
    await assertLibraryStaysClosed(page, 'multi-touch edge drag');

    const central = await swipe(page, {
      start: { id: 1, x: 210, y: 430 },
      end: { id: 1, x: 340, y: 434 },
    });
    assert.equal(central.prevented, false, 'normal content must keep its native touchstart');
    await assertLibraryStaysClosed(page, 'central-page drag');

    const outside = await swipe(page, {
      start: { id: 1, x: 40, y: 430 },
      end: { id: 1, x: 140, y: 434 },
    });
    assert.equal(outside.prevented, false, 'a touch just outside the strip must stay native');
    await assertLibraryStaysClosed(page, 'drag outside the strip');

    assert.deepEqual(await historySnapshot(page), beforeHistory);
    assert.equal(await page.evaluate(() => window.__popstateCount), 0);
    const afterReader = await readerSnapshot(page);
    assert.deepEqual(afterReader.rect, beforeReader.rect, 'failed gestures must not move the reader');
    assert.equal(afterReader.scrollTop, beforeReader.scrollTop, 'failed gestures must not change reader scroll');

    const rotatedStarted = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 400 }]);
    assert.equal(rotatedStarted.prevented, true);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(80);
    await dispatchTouch(page, 'touchmove', [{ id: 1, x: 110, y: 404 }], [{ id: 1, x: 110, y: 404 }]);
    await dispatchTouch(page, 'touchend', [], [{ id: 1, x: 110, y: 404 }]);
    await assertLibraryStaysClosed(page, 'rotation mid-gesture');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(80);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedReader = await readerSnapshot(page);
    const reducedHistory = await historySnapshot(page);
    assert.ok(reducedReader.scrollTop > 0, 'the markdown reader should still be scrolled before opening');
    const reducedStarted = await swipe(page, {
      start: { id: 1, x: 8, y: 430 },
      end: { id: 1, x: 110, y: 434 },
    });
    assert.equal(reducedStarted.prevented, true);
    await waitForLibraryOpen(page);
    const openedReader = await readerSnapshot(page);
    assert.deepEqual(openedReader.rect, reducedReader.rect, 'a real drawer open must not move the markdown reader');
    assert.equal(openedReader.scrollTop, reducedReader.scrollTop, 'a real drawer open must retain markdown scroll');
    assert.equal(openedReader.transform, 'none');
    assert.deepEqual(await historySnapshot(page), reducedHistory, 'opening the drawer must not rewrite history');
    const durations = await page.locator('#library').evaluate((node) => getComputedStyle(node)
      .transitionDuration
      .split(',')
      .map((value) => Number.parseFloat(value)));
    assert.ok(durations.every((value) => value <= 0.001), `reduced-motion drawer duration ${durations.join(',')} must be effectively instant`);
    await page.locator('#library-close').click();
    await waitForLibraryClosed(page);

    assert.deepEqual(await historySnapshot(page), beforeHistory, 'gesture-only drawer use must never rewrite history');
    assert.equal(await page.evaluate(() => window.__popstateCount), 0);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
