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
      `${'拖动抽屉时正文、滚动位置与交互页都应保持静止。'.repeat(8)}`,
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
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-fluid-drawer-'));
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
      iframeIdentity: iframe?.__fluidIdentity || '',
      frameWindow: Boolean(iframe?.__fluidFrameWindow && iframe.contentWindow === iframe.__fluidFrameWindow),
    };
  });
}

async function drawerSnapshot(page) {
  return page.evaluate(() => {
    const library = document.querySelector('#library');
    const scrim = document.querySelector('#scrim');
    const rect = library.getBoundingClientRect();
    const style = getComputedStyle(library);
    return {
      open: library.classList.contains('is-open'),
      dragging: library.classList.contains('is-dragging'),
      inlineTransform: library.style.transform,
      transform: style.transform,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      scrimHidden: scrim.hidden,
      scrimDragging: scrim.classList.contains('is-dragging'),
      scrimOpacity: Number(getComputedStyle(scrim).opacity),
    };
  });
}

// Synthetic Touch events exercise only the parent document. They prove the
// gesture/state behavior, not iOS's OS-level edge-back animation.
async function dispatchTouch(page, type, touches, changed = touches, targetSelector = '') {
  return page.evaluate(({ type, touches, changed, targetSelector }) => {
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
    let target = window.__fluidTouchTarget || document.body;
    if (targetSelector) {
      target = document.querySelector(targetSelector) || document.body;
    } else if (type === 'touchstart' && touches.length === 1) {
      target = document.elementFromPoint(touches[0].x, touches[0].y) || document.body;
      window.__fluidTouchTarget = target;
    }
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points(touches) });
    Object.defineProperty(event, 'targetTouches', { value: points(touches) });
    Object.defineProperty(event, 'changedTouches', { value: points(changed) });
    target.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      inEdge: Boolean(target.closest?.('#edge-nav')),
      targetId: target.id || '',
      targetTag: target.tagName || '',
    };
  }, { type, touches, changed, targetSelector });
}

async function assertSnappedClosed(page, label) {
  await page.waitForTimeout(80);
  const drawer = await drawerSnapshot(page);
  assert.equal(drawer.open, false, `${label} must leave the drawer closed`);
  assert.equal(drawer.dragging, false, `${label} must clear drag styles`);
  assert.equal(drawer.inlineTransform, '', `${label} must clear the inline transform`);
  assert.equal(drawer.scrimHidden, true, `${label} must hide the scrim`);
  assert.equal(drawer.scrimDragging, false, `${label} must clear scrim drag state`);
}

async function waitForEdgeTarget(page, x, y) {
  await page.waitForFunction(({ pointX, pointY }) => {
    return Boolean(document.elementFromPoint(pointX, pointY)?.closest('#edge-nav'));
  }, { pointX: x, pointY: y }, { timeout: 5000 });
}

test(`fluid edge ${browserKind}: viewport strip accepts x28 at top, middle and bottom but x40 stays native`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, WIDGET);
    await waitForWidget(page);

    const navBox = await page.locator('#edge-nav').boundingBox();
    const style = await page.locator('#edge-nav').evaluate((node) => ({
      position: getComputedStyle(node).position,
      width: getComputedStyle(node).width,
    }));
    assert.equal(style.position, 'fixed', 'the hit region must be viewport-fixed');
    assert.ok(navBox.width >= 30 && navBox.width <= 34, `edge strip width ${navBox.width} should be about 32px`);
    assert.ok(Math.abs(navBox.x) <= 1, `edge strip x ${navBox.x} should sit at the left edge`);
    assert.ok(navBox.height > 400, `edge strip height ${navBox.height} should span the viewport`);

    const points = [
      Math.round(navBox.y + 3),
      Math.round(navBox.y + navBox.height / 2),
      Math.round(navBox.y + navBox.height - 3),
    ];
    for (const y of points) {
      const start = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 28, y }]);
      assert.equal(start.inEdge, true, `x28/y${y} must land on the reserved strip`);
      assert.equal(start.prevented, true, `x28/y${y} must suppress the native Back gesture`);
      await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 28, y }]);
    }
    await assertSnappedClosed(page, 'hit-region probes');

    const outside = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 40, y: points[1] }]);
    assert.equal(outside.inEdge, false, 'x40 must be outside the 32px strip');
    assert.equal(outside.prevented, false, 'a touch outside the reserved strip must stay native');
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 40, y: points[1] }]);
    await assertSnappedClosed(page, 'touch outside the strip');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`fluid edge ${browserKind}: finger drag reveals the panel before lift and keeps reader/iframe/history static`, {
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
      iframe.__fluidIdentity = 'same-frame';
      iframe.__fluidFrameWindow = iframe.contentWindow;
      window.__fluidPopstate = 0;
      window.addEventListener('popstate', () => { window.__fluidPopstate += 1; });
    });
    const beforeHistory = await historySnapshot(page);
    const beforeReader = await readerSnapshot(page);
    const activeBefore = await page.evaluate(() => document.activeElement?.id || '');

    const started = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 360 }]);
    assert.equal(started.prevented, true, 'the opening edge touchstart must be cancelled');
    const moved = await dispatchTouch(page, 'touchmove', [{ id: 1, x: 60, y: 364 }]);
    assert.equal(moved.prevented, true);

    const partial = await drawerSnapshot(page);
    assert.equal(partial.dragging, true, 'the drawer must follow the finger before release');
    assert.equal(partial.open, false, 'a partial drag is not a committed open yet');
    assert.ok(partial.right > 0 && partial.right < partial.width, `partial drawer right edge ${partial.right} should be visibly inside the viewport`);
    assert.notEqual(partial.transform, 'none', 'the library transform must move during the drag');
    assert.equal(partial.scrimHidden, false, 'the scrim must be visible during the drag');
    assert.ok(partial.scrimOpacity > 0 && partial.scrimOpacity < 1, `partial scrim opacity ${partial.scrimOpacity} should be between 0 and 1`);
    assert.equal(await page.evaluate(() => document.activeElement?.id || ''), activeBefore, 'dragging must not move focus');

    const duringReader = await readerSnapshot(page);
    assert.deepEqual(duringReader.rect, beforeReader.rect, 'the reader rect must stay static during the drag');
    assert.equal(duringReader.scrollTop, beforeReader.scrollTop, 'the reader scroll must stay static during the drag');
    assert.equal(duringReader.transform, 'none', 'the reader must not be transformed during the drag');
    assert.equal(duringReader.iframeIdentity, 'same-frame');
    assert.equal(duringReader.frameWindow, true);
    assert.equal(await frame.locator('#counter').textContent(), '1');
    assert.deepEqual(await historySnapshot(page), beforeHistory, 'dragging must not touch URL or history');
    assert.equal(await page.evaluate(() => window.__fluidPopstate), 0);

    // The panel now covers the strip; move events dispatched through the
    // panel must still reach the locked gesture.
    const overlayMove = await dispatchTouch(page, 'touchmove', [{ id: 1, x: 92, y: 368 }], undefined, '#library');
    assert.equal(overlayMove.prevented, true, 'a locked gesture must stay captured over the panel');
    const further = await drawerSnapshot(page);
    assert.ok(further.right > partial.right, 'the panel must keep following after it covers the strip');

    await dispatchTouch(page, 'touchend', [], [{ id: 1, x: 92, y: 368 }], '#library');
    await waitForLibraryOpen(page);
    await page.waitForFunction(() => document.activeElement?.closest('#library'), { timeout: 5000 });

    const opened = await drawerSnapshot(page);
    assert.equal(opened.open, true);
    assert.equal(opened.dragging, false, 'release must clear drag-only styles');
    assert.equal(opened.inlineTransform, '', 'release must release the inline transform');
    assert.equal(opened.scrimHidden, false);

    const afterReader = await readerSnapshot(page);
    assert.deepEqual(afterReader, beforeReader, 'opening must not move the reader, scroll, or reload the iframe');
    assert.equal(await frame.locator('#counter').textContent(), '1', 'widget state must survive the drag');
    assert.deepEqual(await historySnapshot(page), beforeHistory, 'a gesture open must not rewrite history');
    assert.equal(await page.evaluate(() => window.__fluidPopstate), 0, 'a gesture open must not fire popstate');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`fluid edge ${browserKind}: slow diagonal opens, while vertical, short, cancel and multi-touch reset`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, errors } = await newPage();
  try {
    await login(page, ALPHA);
    await waitForMarkdown(page, 'ALPHA_BODY');
    await page.evaluate(() => {
      document.querySelector('#reader-scroll').scrollTop = 260;
      window.__fluidPopstate = 0;
      window.addEventListener('popstate', () => { window.__fluidPopstate += 1; });
    });
    const beforeHistory = await historySnapshot(page);
    const beforeReader = await readerSnapshot(page);
    assert.ok(beforeReader.scrollTop > 0);

    const slow = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 400 }]);
    assert.equal(slow.prevented, true);
    await page.waitForTimeout(430);
    await dispatchTouch(page, 'touchmove', [{ id: 1, x: 30, y: 418 }]);
    await page.waitForTimeout(520);
    await dispatchTouch(page, 'touchmove', [{ id: 1, x: 70, y: 450 }]);
    await dispatchTouch(page, 'touchend', [], [{ id: 1, x: 70, y: 450 }]);
    await waitForLibraryOpen(page);

    const openedReader = await readerSnapshot(page);
    assert.deepEqual(openedReader.rect, beforeReader.rect, 'slow diagonal open must not move the reader');
    assert.equal(openedReader.scrollTop, beforeReader.scrollTop, 'slow diagonal open must retain reader scroll');
    assert.equal(openedReader.transform, 'none');
    assert.deepEqual(await historySnapshot(page), beforeHistory, 'slow open must not rewrite history');
    assert.equal(await page.evaluate(() => window.__fluidPopstate), 0);

    await page.locator('#library-close').click();
    await waitForLibraryClosed(page);
    await waitForEdgeTarget(page, 8, 700);

    const verticalPrevented = await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 700 }]);
    assert.equal(verticalPrevented.prevented, true);
    await dispatchTouch(page, 'touchmove', [{ id: 1, x: 10, y: 470 }]);
    const verticalDrawer = await drawerSnapshot(page);
    assert.equal(verticalDrawer.dragging, false, 'vertical intent must not start dragging');
    await dispatchTouch(page, 'touchend', [], [{ id: 1, x: 10, y: 470 }]);
    await assertSnappedClosed(page, 'vertical drag');

    await waitForEdgeTarget(page, 8, 430);
    await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 430 }]);
    await dispatchTouch(page, 'touchmove', [{ id: 1, x: 20, y: 432 }]);
    const shortPartial = await drawerSnapshot(page);
    assert.equal(shortPartial.dragging, true);
    assert.ok(shortPartial.right > 0);
    await dispatchTouch(page, 'touchmove', [{ id: 1, x: 30, y: 434 }]);
    await dispatchTouch(page, 'touchend', [], [{ id: 1, x: 30, y: 434 }]);
    await assertSnappedClosed(page, 'short drag');

    await waitForEdgeTarget(page, 8, 430);
    await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 430 }]);
    await dispatchTouch(page, 'touchmove', [{ id: 1, x: 90, y: 434 }]);
    const cancelledPartial = await drawerSnapshot(page);
    assert.equal(cancelledPartial.dragging, true);
    await dispatchTouch(page, 'touchcancel', [], [{ id: 1, x: 90, y: 434 }]);
    await assertSnappedClosed(page, 'cancelled drag');

    await waitForEdgeTarget(page, 8, 430);
    await dispatchTouch(page, 'touchstart', [{ id: 1, x: 8, y: 430 }]);
    await dispatchTouch(page, 'touchmove', [{ id: 1, x: 90, y: 434 }]);
    const multiPartial = await drawerSnapshot(page);
    assert.equal(multiPartial.dragging, true);
    const second = { id: 2, x: 180, y: 440 };
    await dispatchTouch(page, 'touchstart', [{ id: 1, x: 90, y: 434 }, second], [second]);
    await assertSnappedClosed(page, 'multi-touch drag');
    await dispatchTouch(page, 'touchend', [], [{ id: 1, x: 90, y: 434 }]);

    const afterReader = await readerSnapshot(page);
    assert.deepEqual(afterReader.rect, beforeReader.rect, 'reset gestures must not move the reader');
    assert.equal(afterReader.scrollTop, beforeReader.scrollTop, 'reset gestures must not change reader scroll');
    assert.deepEqual(await historySnapshot(page), beforeHistory, 'gesture use must never rewrite history');
    assert.equal(await page.evaluate(() => window.__fluidPopstate), 0);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
