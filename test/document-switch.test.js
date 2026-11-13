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
const GAMMA = 'c'.repeat(32);
const DOC_RE = /\/api\/documents\/[a-f0-9]{32}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bodyFor(marker, extra = '') {
  return [
    `# ${marker}`,
    '',
    `${marker}_BODY`,
    extra,
    '',
    ...Array.from({ length: 36 }, (_, index) => [
      `## ${marker} 章节 ${index + 1}`,
      '',
      `${'慢一点也没关系，正文稍后完整出现。'.repeat(9)}`,
      '',
    ]).flat(),
  ].join('\n');
}

const BODIES = {
  [ALPHA]: bodyFor('ALPHA'),
  [BETA]: bodyFor('BETA'),
  [GAMMA]: bodyFor('GAMMA'),
};

let tmpRoot;
let store;
let userId;
let server;
let base;
let browser;

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-doc-switch-'));
  store = await new CloudStore(path.join(tmpRoot, 'data')).init();
  const alice = await store.addUser('alice', 'correct horse battery');
  userId = alice.user.id;
  for (const id of [ALPHA, BETA, GAMMA]) {
    await store.upsertDocument(userId, id, {
      name: `${BODIES[id].match(/^# (\S+)/)[1].toLowerCase()}.md`,
      markdown: BODIES[id],
    });
  }

  server = await createCloudServer({
    dataDir: path.join(tmpRoot, 'data'),
    publicDir,
    pollMs: 1000,
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

async function newPage({ viewport = { width: 1280, height: 900 }, serviceWorkers = 'block' } = {}) {
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: false,
    serviceWorkers,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return { context, page, pageErrors };
}

async function loginAsAlice(page, initialId = ALPHA) {
  await page.goto(`${base}/#doc-${initialId}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-user').fill('alice');
  await page.locator('#login-pass').fill('correct horse battery');
  await page.locator('#login-submit').click();
  await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
  await waitForBody(page, BODIES[initialId].match(/^# (\S+)/)[1] + '_BODY');
}

async function waitForBody(page, marker) {
  await page.waitForFunction(
    (value) => (document.querySelector('#cloud-doc')?.textContent || '').includes(value),
    marker,
    { timeout: 15000 },
  );
}

function makeGate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

async function installDocRoutes(page, rules) {
  await page.route(DOC_RE, async (route) => {
    const id = route.request().url().split('/').pop();
    const rule = rules[id];
    if (!rule) {
      try { await route.continue(); } catch { /* aborted by a newer click */ }
      return;
    }
    if (rule.gate) await rule.gate.promise;
    if (rule.delay) await sleep(rule.delay);
    if (rule.status) {
      await route.fulfill({
        status: rule.status,
        contentType: 'application/json',
        body: JSON.stringify(rule.body || {
          error: { code: 'TEST_FAILURE', message: '测试中的读取失败。' },
        }),
      }).catch(() => {});
      return;
    }
    try { await route.continue(); } catch { /* aborted by a newer click */ }
  });
}

function trackDocRequests(page) {
  const requests = [];
  page.on('request', (request) => {
    let pathname = '';
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      return;
    }
    if (DOC_RE.test(pathname)) requests.push(pathname.split('/').pop());
  });
  return requests;
}

async function clickDoc(page, id) {
  await page.locator(`button[data-doc-id="${id}"]`).click();
}

async function loadingSnapshot(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('#doc-loading');
    const stage = document.querySelector('.reader-stage');
    const reader = document.querySelector('#reader-scroll');
    const ring = document.querySelector('.doc-loading-ring');
    const style = getComputedStyle(overlay);
    const ringStyle = getComputedStyle(ring);
    const rect = overlay.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      hidden: overlay.hidden,
      background: style.backgroundColor,
      backdrop: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter') || '',
      overlayAnimation: style.animationName,
      ringAnimation: ringStyle.animationName,
      ariaBusy: reader.getAttribute('aria-busy'),
      role: overlay.getAttribute('role'),
      live: overlay.getAttribute('aria-live'),
      text: overlay.textContent.replace(/\s+/g, ''),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      stage: { left: stageRect.left, top: stageRect.top, width: stageRect.width, height: stageRect.height },
      centerHitsOverlay: Boolean(top?.closest('#doc-loading')),
    };
  });
}

function assertLoadingOverlay(snap) {
  assert.equal(snap.hidden, false, 'loading overlay must be visible');
  assert.equal(snap.role, 'status', 'overlay must expose a status role');
  assert.equal(snap.live, 'polite');
  assert.match(snap.text, /正在加载/);
  assert.equal(snap.ariaBusy, 'true', 'reader must be marked aria-busy');
  assert.notEqual(snap.background, 'rgba(0, 0, 0, 0)', 'overlay needs a translucent wash');
  assert.notEqual(snap.background, 'transparent');
  assert.match(snap.backdrop, /blur/i, 'overlay must blur the reading viewport, not the long body');
  assert.match(snap.overlayAnimation, /doc-loading-fade/);
  assert.match(snap.ringAnimation, /doc-loading-spin/);
  assert.ok(Math.abs(snap.rect.left - snap.stage.left) < 2, 'overlay starts at the reader stage');
  assert.ok(Math.abs(snap.rect.top - snap.stage.top) < 2, 'overlay starts at the reader stage');
  assert.ok(Math.abs(snap.rect.width - snap.stage.width) < 2, 'overlay covers the reader viewport');
  assert.ok(Math.abs(snap.rect.height - snap.stage.height) < 2, 'overlay covers the reader viewport');
  assert.equal(snap.centerHitsOverlay, true);
}

async function assertOverlayGone(page) {
  assert.equal(await page.locator('#doc-loading').isHidden(), true, 'overlay must be hidden after loading');
  assert.equal(await page.locator('#reader-scroll').getAttribute('aria-busy'), null);
}

test(`document switch ${browserKind}: immediate selection, painted overlay, no duplicate render`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    await loginAsAlice(page);
    const requests = trackDocRequests(page);
    const betaGate = makeGate();
    await installDocRoutes(page, { [BETA]: { gate: betaGate } });

    await clickDoc(page, BETA);
    await page.locator('#doc-loading').waitFor({ state: 'visible', timeout: 3000 });

    const selected = page.locator(`button[data-doc-id="${BETA}"]`);
    assert.match(await selected.getAttribute('class'), /is-active/);
    assert.equal(await selected.getAttribute('aria-current'), 'page');
    assert.match(await page.locator(`button[data-doc-id="${ALPHA}"]`).getAttribute('class'), /doc-item/);
    assert.equal(await page.locator(`button[data-doc-id="${ALPHA}"]`).getAttribute('aria-current'), null);

    const snap = await loadingSnapshot(page);
    assertLoadingOverlay(snap);
    // The previous document stays underneath the translucent overlay until
    // the new body is ready; the overlay itself must not erase it.
    assert.match(await page.locator('#cloud-doc').textContent(), /ALPHA_BODY/);

    const lightBackground = snap.background;
    await page.locator('#theme-toggle').click();
    await page.waitForTimeout(60);
    const darkSnap = await loadingSnapshot(page);
    assert.notEqual(darkSnap.background, lightBackground, 'dark theme needs its own translucent wash');
    assertLoadingOverlay(darkSnap);
    await page.locator('#theme-toggle').click();

    betaGate.release();
    await waitForBody(page, 'BETA_BODY');
    await assertOverlayGone(page);
    assert.equal(await page.locator('#doc-title').textContent(), 'beta.md');
    assert.equal(requests.filter((id) => id === BETA).length, 1);

    // Clicking the already-open document must not replace the rendered tree
    // or hit the network again.
    await page.evaluate(() => {
      const first = document.querySelector('#cloud-doc > *');
      if (first) first.dataset.repeatProbe = 'kept';
    });
    const before = requests.length;
    await clickDoc(page, BETA);
    await page.waitForTimeout(180);
    assert.equal(requests.length, before, 'repeat click must not refetch the current document');
    assert.equal(
      await page.evaluate(() => document.querySelector('#cloud-doc > *')?.dataset.repeatProbe),
      'kept',
      'repeat click must not re-render the body',
    );
    await assertOverlayGone(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test(`document switch ${browserKind}: rapid A to B to C ignores the late B response`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    await loginAsAlice(page);
    const requests = trackDocRequests(page);
    await installDocRoutes(page, {
      [BETA]: { delay: 700 },
      [GAMMA]: { delay: 40 },
    });

    const betaRequest = page.waitForRequest((request) => request.url().endsWith(`/api/documents/${BETA}`));
    await clickDoc(page, BETA);
    await betaRequest;
    await page.locator('#doc-loading').waitFor({ state: 'visible', timeout: 3000 });
    await clickDoc(page, GAMMA);

    assert.match(await page.locator(`button[data-doc-id="${GAMMA}"]`).getAttribute('class'), /is-active/);
    await waitForBody(page, 'GAMMA_BODY');
    await assertOverlayGone(page);
    assert.equal(await page.locator('#doc-title').textContent(), 'gamma.md');

    await page.waitForTimeout(900);
    assert.match(await page.locator('#cloud-doc').textContent(), /GAMMA_BODY/);
    assert.doesNotMatch(await page.locator('#cloud-doc').textContent(), /BETA_BODY/);
    assert.equal(await page.locator('#doc-title').textContent(), 'gamma.md');
    assert.equal(requests.includes(BETA), true);
    await assertOverlayGone(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test(`document switch ${browserKind}: failure restores the visible document and retry works`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    await loginAsAlice(page);
    await installDocRoutes(page, {
      [BETA]: {
        delay: 200,
        status: 503,
        body: { error: { code: 'UNAVAILABLE', message: '文库暂时不可用，请稍后再试。' } },
      },
    });

    await clickDoc(page, BETA);
    await page.locator('#doc-loading').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('#doc-loading').waitFor({ state: 'hidden', timeout: 8000 });

    assert.match(await page.locator('#cloud-doc').textContent(), /ALPHA_BODY/);
    assert.equal(await page.locator('#doc-title').textContent(), 'alpha.md');
    assert.match(await page.locator('#cloud-status').getAttribute('data-state'), /error/);
    assert.equal(await page.locator('#cloud-alert').isVisible(), true);
    assert.match(await page.locator('#cloud-alert-detail').textContent(), /暂时不可用/);
    assert.match(await page.locator(`button[data-doc-id="${ALPHA}"]`).getAttribute('class'), /is-active/);
    assert.doesNotMatch(await page.locator(`button[data-doc-id="${BETA}"]`).getAttribute('class'), /is-active/);
    await assertOverlayGone(page);

    // The sidebar remains usable after an error: remove the failing route and
    // open B successfully without reloading the page.
    await page.unroute(DOC_RE);
    await clickDoc(page, BETA);
    await waitForBody(page, 'BETA_BODY');
    await assertOverlayGone(page);
    assert.equal(await page.locator('#cloud-alert').isHidden(), true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test(`document switch ${browserKind}: logout aborts a pending load without restoring content`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    await loginAsAlice(page);
    const betaGate = makeGate();
    await installDocRoutes(page, { [BETA]: { gate: betaGate } });

    await clickDoc(page, BETA);
    await page.locator('#doc-loading').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('#logout-button').click();
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 10000 });

    assert.equal(await page.locator('#cloud-shell').isHidden(), true);
    assert.equal(await page.locator('#doc-loading').isHidden(), true);
    assert.equal(await page.locator('#reader-scroll').getAttribute('aria-busy'), null);
    assert.equal(await page.locator('#cloud-doc').textContent(), '');
    assert.equal(await page.locator('#doc-list').locator('button').count(), 0);

    betaGate.release();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#auth-screen').isVisible(), true);
    assert.equal(await page.locator('#cloud-doc').textContent(), '');
    assert.equal(await page.locator('#doc-title').textContent(), '选择一份文稿');
    assert.doesNotMatch(await page.locator('body').textContent(), /BETA_BODY/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test(`document switch ${browserKind}: a delayed poll cannot overwrite the newly selected document`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, pageErrors } = await newPage();
  let releasePoll = () => {};
  try {
    let pollSeenResolve;
    const pollSeen = new Promise((resolve) => { pollSeenResolve = resolve; });
    const pollGate = new Promise((resolve) => { releasePoll = resolve; });
    await page.route(DOC_RE, async (route) => {
      const id = route.request().url().split('/').pop();
      const headers = route.request().headers();
      if (id !== ALPHA || !headers['if-none-match']) {
        try { await route.continue(); } catch { /* newer click aborted it */ }
        return;
      }
      pollSeenResolve();
      await pollGate;
      try {
        const response = await route.fetch();
        await route.fulfill({ response });
      } catch {
        // The page may have discarded the request while switching documents.
      }
    });

    await loginAsAlice(page);
    // Make the next poll deterministic instead of waiting for the real timer.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await Promise.race([
      pollSeen,
      sleep(5000).then(() => { throw new Error('poll request did not start'); }),
    ]);

    await store.upsertDocument(userId, ALPHA, {
      name: 'alpha.md',
      markdown: bodyFor('ALPHA', 'ALPHA_LATE_POLL'),
    });

    await clickDoc(page, BETA);
    await waitForBody(page, 'BETA_BODY');
    releasePoll();

    await page.waitForTimeout(700);
    assert.match(await page.locator('#cloud-doc').textContent(), /BETA_BODY/);
    assert.doesNotMatch(await page.locator('#cloud-doc').textContent(), /ALPHA_LATE_POLL/);
    assert.equal(await page.locator('#doc-title').textContent(), 'beta.md');
    await assertOverlayGone(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    releasePoll();
    await context.close();
  }
});

test(`document switch ${browserKind}: portrait drawer closes before a visible overlay; reduced motion`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, pageErrors } = await newPage({ viewport: { width: 390, height: 844 } });
  let betaGate;
  let gammaGate;
  try {
    await loginAsAlice(page);
    betaGate = makeGate();
    gammaGate = makeGate();
    await installDocRoutes(page, {
      [BETA]: { gate: betaGate },
      [GAMMA]: { gate: gammaGate },
    });

    await page.locator('#library-toggle').click();
    await page.locator('#library').waitFor({ state: 'visible', timeout: 3000 });
    await clickDoc(page, BETA);

    // The drawer closes synchronously on click, so the reader overlay is not
    // hidden behind it on an iPad kept in portrait orientation.
    assert.equal(await page.locator('#library').evaluate((node) => node.classList.contains('is-open')), false);
    assert.equal(await page.locator('#scrim').isHidden(), true);
    await page.locator('#doc-loading').waitFor({ state: 'visible', timeout: 3000 });
    await page.waitForTimeout(350);
    const snap = await loadingSnapshot(page);
    assertLoadingOverlay(snap);
    assert.ok(snap.rect.width >= 300, `narrow overlay width ${snap.rect.width}`);
    assert.ok(snap.rect.height >= 300, `narrow overlay height ${snap.rect.height}`);
    const libraryRight = await page.locator('#library').evaluate((node) => node.getBoundingClientRect().right);
    assert.ok(libraryRight <= 1, `drawer should be off-screen, right=${libraryRight}`);

    betaGate.release();
    await waitForBody(page, 'BETA_BODY');
    await assertOverlayGone(page);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#library-toggle').click();
    await page.locator('#library').waitFor({ state: 'visible', timeout: 3000 });
    await clickDoc(page, GAMMA);
    await page.locator('#doc-loading').waitFor({ state: 'visible', timeout: 3000 });
    const reduced = await loadingSnapshot(page);
    assert.equal(reduced.overlayAnimation, 'none', 'overlay fade must be disabled');
    assert.equal(reduced.ringAnimation, 'none', 'spinner must not rotate under reduced motion');
    assert.equal(reduced.hidden, false);
    assert.equal(reduced.ariaBusy, 'true');
    assert.equal(reduced.role, 'status');
    gammaGate.release();
    await waitForBody(page, 'GAMMA_BODY');
    await assertOverlayGone(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    betaGate?.release();
    gammaGate?.release();
    await context.close();
  }
});

test(`document switch ${browserKind}: a timed-out read clears the overlay and keeps the old body`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    await loginAsAlice(page);
    await page.evaluate(() => {
      const meta = document.querySelector('meta[name="modu-document-timeout-ms"]');
      if (!meta) throw new Error('missing document timeout meta');
      meta.setAttribute('content', '1000');
    });
    await installDocRoutes(page, { [BETA]: { delay: 1700 } });

    await clickDoc(page, BETA);
    await page.locator('#doc-loading').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('#doc-loading').waitFor({ state: 'hidden', timeout: 6000 });

    assert.match(await page.locator('#cloud-alert-detail').textContent(), /超时/);
    assert.match(await page.locator('#cloud-doc').textContent(), /ALPHA_BODY/);
    assert.equal(await page.locator('#doc-title').textContent(), 'alpha.md');
    await assertOverlayGone(page);

    await page.unroute(DOC_RE);
    await clickDoc(page, BETA);
    await waitForBody(page, 'BETA_BODY');
    await assertOverlayGone(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test(`service worker ${browserKind}: r12 reuses unchanged r6 vendor cache and never caches API`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 60000,
}, async () => {
  const { context, page, pageErrors } = await newPage({ serviceWorkers: 'allow' });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });

    const seeded = await page.evaluate(async () => {
      const cache = await caches.open('modu-cloud-v1.1.0-r6-shell');
      await cache.put(new Request(new URL('/vendor/markdown-it.min.js', location.origin)), new Response(
        (await (await fetch('/vendor/markdown-it.min.js')).text()) + '\n/*R5_MARKDOWN_VENDOR_MARKER*/',
        { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } },
      ));
      await cache.put(new Request(new URL('/vendor/purify.min.js', location.origin)), new Response(
        (await (await fetch('/vendor/purify.min.js')).text()) + '\n/*R5_PURIFY_VENDOR_MARKER*/',
        { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } },
      ));
      return (await cache.keys()).length;
    });
    assert.equal(seeded, 2);

    await page.locator('#login-user').fill('alice');
    await page.locator('#login-pass').fill('correct horse battery');
    await page.locator('#login-submit').click();
    await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 20000 });
    await page.waitForFunction(async () => (await caches.keys()).includes('modu-cloud-v1.3.0-r13-shell'), null, {
      timeout: 20000,
    });

    await page.waitForFunction(() => new URL(location.href).searchParams.get('modu-shell') === 'modu-cloud-v1.3.0-r13');
    await page.locator('#cloud-shell').waitFor({state: 'visible'});
    const audit = await page.evaluate(async () => {
      const keys = await caches.keys();
      const cache = await caches.open('modu-cloud-v1.3.0-r13-shell');
      const paths = [];
      const vendorBodies = {};
      for (const request of await cache.keys()) {
        const pathname = new URL(request.url).pathname;
        paths.push(pathname);
        if (pathname.startsWith('/vendor/')) {
          vendorBodies[pathname] = await (await cache.match(request)).text();
        }
      }
      return { keys, paths, vendorBodies };
    });

    assert.ok(audit.keys.includes('modu-cloud-v1.3.0-r13-shell'));
    for (const required of ['/', '/cloud.css', '/cloud.js', '/vendor/markdown-it.min.js', '/vendor/purify.min.js']) {
      assert.ok(audit.paths.includes(required), `r6 shell missing ${required}`);
    }
    assert.match(audit.vendorBodies['/vendor/markdown-it.min.js'], /R5_MARKDOWN_VENDOR_MARKER/);
    assert.match(audit.vendorBodies['/vendor/purify.min.js'], /R5_PURIFY_VENDOR_MARKER/);
    assert.equal(audit.paths.some((entry) => entry.startsWith('/api/')), false, 'API must never be cached');
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
