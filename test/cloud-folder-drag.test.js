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

const USERNAME = 'drag-user';
const PASSWORD = 'correct horse battery';
const DOC_IDS = Array.from({ length: 12 }, (_, index) => (index + 1).toString(16).padStart(32, '0'));
const DOC_NAMES = new Map();
const FOLDER_NAMES = [
  '产品与设计资料归档文件夹名称很长',
  '工作',
  '子目录',
  '空文件夹',
  '第五个文件夹',
  '第六个文件夹',
  '第七个文件夹',
  '第八个文件夹',
];
const VIEWPORTS = [
  { width: 768, height: 1024, label: 'iPad portrait 768x1024' },
  { width: 834, height: 1194, label: 'iPad portrait 834x1194' },
  { width: 1024, height: 768, label: 'iPad landscape 1024x768' },
  { width: 1194, height: 834, label: 'iPad landscape 1194x834' },
  { width: 390, height: 844, label: 'iPhone portrait 390x844' },
  { width: 844, height: 390, label: 'iPhone short landscape 844x390' },
];

let tmpRoot;
let server;
let base;
let browser;
let store;
let userId;
let folderIds = [];

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-cloud-folder-drag-'));
  const dataDir = path.join(tmpRoot, 'data');
  store = await new CloudStore(dataDir).init();
  const account = await store.addUser(USERNAME, PASSWORD);
  userId = account.user.id;

  for (const [index, id] of DOC_IDS.entries()) {
    const name = `年度项目复盘与设计资料-第${index + 1}份-最终版本-final-draft-with-long-name.md`;
    DOC_NAMES.set(id, name);
    const body = [
      `# ${name}`,
      '',
      ...Array.from({ length: 26 }, (_, section) => [
        `## 章节 ${section + 1}`,
        '',
        `${name} 的正文内容。拖动归类时正文、滚动位置和阅读器尺寸都必须保持不变。`.repeat(6),
        '',
      ]).flat(),
    ].join('\n');
    await store.upsertDocument(userId, id, { name, markdown: body });
  }

  let library = await store.getLibrary(userId);
  let parentId = null;
  for (const name of FOLDER_NAMES) {
    library = await store.mutateLibrary(userId, {
      revision: library.revision,
      action: 'createFolder',
      name,
      parentId,
    });
    parentId = library.folders.at(-1).id;
  }
  folderIds = library.folders.map((folder) => folder.id);
  for (let index = 0; index < folderIds.length; index += 1) {
    library = await store.mutateLibrary(userId, {
      revision: library.revision,
      action: 'moveDocument',
      docId: DOC_IDS[index],
      folderId: folderIds[index],
    });
  }

  server = await createCloudServer({
    dataDir,
    publicDir,
    pollMs: 60000,
    loginMaxAttempts: 100,
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

async function waitUntil(check, message, timeout = 8000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeout) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function newPage(viewport) {
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: false,
    serviceWorkers: 'block',
  });
  // WebKit reports maxTouchPoints=0 even with hasTouch. The UI only needs this
  // for its edge strip; touch pointer drag itself uses Pointer Events.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    let data = null;
    try {
      data = request.postDataJSON();
    } catch {
      data = null;
    }
    let pathname = '';
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      pathname = request.url();
    }
    requests.push({ method: request.method(), pathname, data });
  });
  return { context, page, errors, requests };
}

async function login(page) {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-user').fill(USERNAME);
  await page.locator('#login-pass').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await page.locator('#cloud-shell').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#doc-loading').waitFor({ state: 'hidden', timeout: 15000 });
}

async function openLibrary(page) {
  const narrow = await page.evaluate(() => matchMedia('(max-width: 900px)').matches);
  if (!narrow) return;
  const open = await page.evaluate(() => document.querySelector('#library')?.classList.contains('is-open'));
  if (!open) {
    await page.locator('#library-toggle').click();
    await page.waitForFunction(() => document.querySelector('#library')?.classList.contains('is-open'));
  }
  await page.waitForTimeout(320);
}

async function showAllDocuments(page) {
  await page.locator('#folder-tree [data-library-view="all"]').click();
  await page.waitForFunction((count) => document.querySelectorAll('.doc-row').length === count, DOC_IDS.length);
}

async function readerSnapshot(page) {
  return page.evaluate(() => {
    const reader = document.querySelector('#reader-scroll');
    const rect = reader.getBoundingClientRect();
    return {
      title: document.querySelector('#doc-title')?.textContent || '',
      scrollTop: reader.scrollTop,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
}

async function setReaderScroll(page, value) {
  await page.locator('#reader-scroll').evaluate((node, next) => {
    node.scrollTop = next;
  }, value);
  await page.waitForTimeout(60);
}

function patchRequests(requests) {
  return requests.filter((entry) => entry.method === 'PATCH' && entry.pathname === '/api/library');
}

function documentGetRequests(requests) {
  return requests.filter((entry) => entry.method === 'GET'
    && /^\/api\/documents\/[a-f0-9]{32}$/.test(entry.pathname));
}

async function dispatchTouchPointer(page, type, x, y, selector = '', pointerId = 41) {
  return page.evaluate(({ type, x, y, selector, pointerId }) => {
    const target = selector ? document.querySelector(selector) : window;
    if (!target) throw new Error(`missing pointer target ${selector}`);
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, x, y, selector, pointerId });
}

async function startTouchDrag(page, docId) {
  const handle = page.locator(`.doc-drag-handle[data-move-doc-id="${docId}"]`);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  assert.ok(box, `handle for ${docId} must be visible`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await dispatchTouchPointer(page, 'pointerdown', x, y, `.doc-drag-handle[data-move-doc-id="${docId}"]`);
  await dispatchTouchPointer(page, 'pointermove', x + 12, y + 2);
  await page.waitForFunction(() => document.body.classList.contains('library-doc-dragging'));
  return { x, y };
}

async function documentDragState(page) {
  return page.evaluate(() => ({
    bodyDragging: document.body.classList.contains('library-doc-dragging'),
    ghostCount: document.querySelectorAll('.doc-drag-ghost').length,
    draggingRows: document.querySelectorAll('.doc-row.is-dragging').length,
    dropTargets: [...document.querySelectorAll('.is-drop-target')].map((node) => node.textContent || ''),
  }));
}

async function mouseDrag(page, docId, targetLocator, { betweenStartAndDrop } = {}) {
  const handle = page.locator(`.doc-drag-handle[data-move-doc-id="${docId}"]`);
  await handle.scrollIntoViewIfNeeded();
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox, `handle for ${docId} must be visible`);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 12, handleBox.y + handleBox.height / 2 + 2, { steps: 3 });
  await page.waitForFunction(() => document.body.classList.contains('library-doc-dragging'));
  if (betweenStartAndDrop) await betweenStartAndDrop();
  const targetBox = await targetLocator.boundingBox();
  assert.ok(targetBox, 'drop target must be visible');
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.waitForTimeout(80);
  await page.mouse.up();
}

function folderTarget(page, folderId) {
  return page.locator(`#folder-tree [data-drop-folder="${folderId}"]`);
}

function listSubfolderTarget(page, folderId) {
  return page.locator(`#doc-list [data-drop-folder="${folderId}"]`);
}

test(`folder drag layout ${browserKind}: long folder tree and 12 long-named documents never overlap or trap scrolling`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 120000,
}, async () => {
  const { context, page, errors } = await newPage({ width: 768, height: 1024 });
  try {
    await login(page);
    await openLibrary(page);
    assert.equal(await page.locator('.doc-row').count(), DOC_IDS.length);
    assert.equal(await page.locator('.doc-row .doc-drag-handle').count(), DOC_IDS.length);
    assert.equal(await page.locator('.doc-move').count(), 0);
    assert.equal(await page.locator('#folder-tree [data-drop-root]').count(), 1);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(120);
      await openLibrary(page);
      const layout = await page.evaluate(() => {
        const box = (selector) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            overflowY: style.overflowY,
            flexShrink: style.flexShrink,
          };
        };
        return {
          pageScrollY: window.scrollY,
          head: box('.library-head'),
          note: box('.library-note'),
          browse: box('.library-browse'),
          tree: box('#folder-tree'),
          view: box('.library-view'),
          viewHead: box('.library-view-head'),
          list: box('#doc-list'),
          foot: box('.library-foot'),
          treeRows: document.querySelectorAll('#folder-tree .folder-filter, #folder-tree .folder-item').length,
          docNameStyle: (() => {
            const node = document.querySelector('.doc-item-name');
            const style = getComputedStyle(node);
            return { textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
          })(),
        };
      });

      assert.ok(layout.browse.bottom <= layout.view.top + 0.5,
        `${viewport.label}: folder browser must end before the document view starts`);
      assert.ok(layout.tree.bottom <= layout.browse.bottom + 0.5,
        `${viewport.label}: folder tree ${layout.tree.bottom} must stay inside folder browser ${layout.browse.bottom}`);
      assert.ok(layout.note.bottom <= layout.browse.top + 0.5,
        `${viewport.label}: note must precede folder browser`);
      assert.ok(layout.viewHead.bottom <= layout.list.top + 0.5,
        `${viewport.label}: document list must follow its header`);
      assert.ok(layout.view.bottom <= layout.foot.top + 0.5,
        `${viewport.label}: document view must end before the library footer`);
      assert.equal(layout.browse.overflowY, 'hidden');
      assert.equal(layout.tree.overflowY, 'auto');
      assert.equal(layout.list.overflowY, 'auto');
      assert.equal(layout.tree.flexShrink, '0');
      assert.equal(layout.note.flexShrink, '0');
      assert.ok(layout.tree.scrollHeight > layout.tree.clientHeight,
        `${viewport.label}: folder tree must remain scrollable (${layout.tree.scrollHeight}/${layout.tree.clientHeight})`);
      assert.ok(layout.list.scrollHeight > layout.list.clientHeight,
        `${viewport.label}: document list must remain scrollable (${layout.list.scrollHeight}/${layout.list.clientHeight})`);
      assert.ok(layout.tree.height >= 50, `${viewport.label}: folder tree is too short (${layout.tree.height}px)`);
      assert.ok(layout.list.height >= 50, `${viewport.label}: document list is too short (${layout.list.height}px)`);
      assert.ok(layout.treeRows >= 10, `${viewport.label}: expected all filters and nestable folders`);
      assert.equal(layout.pageScrollY, 0);
      assert.deepEqual(layout.docNameStyle, { textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    }

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`folder drag mouse ${browserKind}: only the leading grip starts a drag, drop uses the captured revision and never opens the document`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 90000,
}, async () => {
  const { context, page, errors, requests } = await newPage({ width: 768, height: 1024 });
  try {
    await login(page);
    await openLibrary(page);
    await showAllDocuments(page);

    const title = await page.locator('#doc-title').textContent();
    const libraryBefore = await store.getLibrary(userId);
    const docId = DOC_IDS.find((id) => !Object.hasOwn(libraryBefore.assignments, id)
      && !title.includes(DOC_NAMES.get(id))) || DOC_IDS[10];
    const targetFolderId = folderIds[0];
    await setReaderScroll(page, 120);
    const readerBefore = await readerSnapshot(page);
    const docGetsBefore = documentGetRequests(requests).length;

    const rowShape = await page.evaluate((id) => {
      const row = document.querySelector(`.doc-item[data-doc-id="${id}"]`)?.closest('.doc-row');
      return {
        firstClass: row?.firstElementChild?.className || '',
        handleAction: getComputedStyle(row?.querySelector('.doc-drag-handle')).touchAction,
        itemAction: getComputedStyle(row?.querySelector('.doc-item')).touchAction,
      };
    }, docId);
    assert.match(rowShape.firstClass, /doc-drag-handle/);
    assert.equal(rowShape.handleAction, 'none');
    assert.equal(rowShape.itemAction, 'auto', 'the document card must keep native list scrolling');

    // The card itself is not a drag source. Synthetic touch events prove that
    // without generating a browser click that would open the document.
    const itemBox = await page.locator(`.doc-item[data-doc-id="${docId}"]`).boundingBox();
    await dispatchTouchPointer(page, 'pointerdown', itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2,
      `.doc-item[data-doc-id="${docId}"]`, 43);
    await dispatchTouchPointer(page, 'pointermove', itemBox.x + itemBox.width / 2 + 24, itemBox.y + itemBox.height / 2, '', 43);
    await page.waitForTimeout(60);
    assert.deepEqual(await documentDragState(page), {
      bodyDragging: false,
      ghostCount: 0,
      draggingRows: 0,
      dropTargets: [],
    });
    await dispatchTouchPointer(page, 'pointercancel', itemBox.x, itemBox.y, '', 43);

    const handle = page.locator(`.doc-drag-handle[data-move-doc-id="${docId}"]`);
    await handle.scrollIntoViewIfNeeded();
    const handleBox = await handle.boundingBox();
    const target = folderTarget(page, targetFolderId);
    const targetBox = await target.boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 12, handleBox.y + handleBox.height / 2 + 2, { steps: 3 });
    await page.waitForFunction(() => document.body.classList.contains('library-doc-dragging'));
    const started = await documentDragState(page);
    assert.equal(started.bodyDragging, true);
    assert.equal(started.ghostCount, 1, 'a floating drag label must be visible');
    assert.equal(started.draggingRows, 1);
    assert.ok(started.dropTargets.length === 0 || started.dropTargets.every((text) => !text.includes(DOC_NAMES.get(docId))));

    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
    await page.waitForTimeout(100);
    const overTarget = await documentDragState(page);
    assert.equal(overTarget.dropTargets.length, 1, 'the hovered folder must be highlighted');
    assert.match(overTarget.dropTargets[0], new RegExp(FOLDER_NAMES[0]));
    assert.equal(patchRequests(requests).length, 0, 'hovering must not write');

    await page.mouse.up();
    await waitUntil(() => patchRequests(requests).length === 1, 'the drop must issue one PATCH');
    const patch = patchRequests(requests)[0];
    assert.deepEqual(patch.data, {
      action: 'moveDocument',
      docId,
      folderId: targetFolderId,
      revision: libraryBefore.revision,
    });
    await waitUntil(async () => (await store.getLibrary(userId)).assignments[docId] === targetFolderId,
      'the drop must persist the new folder assignment');

    const after = await documentDragState(page);
    assert.deepEqual(after, {
      bodyDragging: false,
      ghostCount: 0,
      draggingRows: 0,
      dropTargets: [],
    });
    assert.match(await page.locator('.toast').last().textContent(), /已移动/);
    assert.equal(documentGetRequests(requests).length, docGetsBefore, 'dropping must not open a document');
    const readerAfter = await readerSnapshot(page);
    assert.deepEqual(readerAfter, readerBefore, 'the reader title, rect and scroll must stay static');

    // The list still scrolls natively after drag support is added.
    await page.locator('#doc-list').evaluate((node) => { node.scrollTop = 0; });
    await page.locator('#doc-list').hover();
    await page.mouse.wheel(0, 260);
    await page.waitForTimeout(150);
    assert.ok(await page.locator('#doc-list').evaluate((node) => node.scrollTop) > 0,
      'the document list must still scroll with the mouse wheel');

    // Tap / keyboard opens the existing move dialog instead of dragging.
    await page.waitForTimeout(500);
    const patchesBeforeDialog = patchRequests(requests).length;
    await page.locator(`.doc-drag-handle[data-move-doc-id="${DOC_IDS[9]}"]`).click();
    await page.locator('#library-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#library-dialog-title').textContent(), '移动文稿');
    assert.equal(patchRequests(requests).length, patchesBeforeDialog);
    await page.keyboard.press('Escape');
    await page.locator('#library-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await readerSnapshot(page), readerAfter);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`folder drag touch ${browserKind}: pointer drag auto-scrolls the tree, cancels cleanly, and leaves reader/list scroll untouched`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 90000,
}, async () => {
  const { context, page, errors, requests } = await newPage({ width: 390, height: 844 });
  try {
    await login(page);
    await openLibrary(page);
    await showAllDocuments(page);

    const title = await page.locator('#doc-title').textContent();
    const docId = DOC_IDS.find((id) => !title.includes(DOC_NAMES.get(id))) || DOC_IDS[11];
    const targetFolderId = folderIds.at(-1);
    await setReaderScroll(page, 120);
    const readerBefore = await readerSnapshot(page);
    await page.locator(`.doc-drag-handle[data-move-doc-id="${docId}"]`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(60);
    const listScrollBefore = await page.locator('#doc-list').evaluate((node) => node.scrollTop);
    const libraryBefore = await store.getLibrary(userId);

    await startTouchDrag(page, docId);
    const started = await documentDragState(page);
    assert.equal(started.bodyDragging, true);
    assert.equal(started.ghostCount, 1);
    assert.equal(await page.locator('#doc-list').evaluate((node) => node.scrollTop), listScrollBefore,
      'starting a drag must not scroll the list');

    const treeBox = await page.locator('#folder-tree').boundingBox();
    await dispatchTouchPointer(page, 'pointermove', treeBox.x + treeBox.width / 2, treeBox.y + treeBox.height - 3);
    await page.waitForTimeout(500);
    const scrolled = await page.locator('#folder-tree').evaluate((node) => node.scrollTop);
    assert.ok(scrolled > 0, `holding at the tree edge must auto-scroll it (${scrolled})`);

    const target = folderTarget(page, targetFolderId);
    const targetBox = await target.boundingBox();
    assert.ok(targetBox, 'the deep folder must become visible after auto-scroll');
    await dispatchTouchPointer(page, 'pointermove', targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
    await page.waitForTimeout(80);
    const overTarget = await documentDragState(page);
    assert.equal(overTarget.dropTargets.length, 1);
    assert.match(overTarget.dropTargets[0], new RegExp(FOLDER_NAMES.at(-1)));

    await dispatchTouchPointer(page, 'pointerup', targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
    await waitUntil(() => patchRequests(requests).length === 1, 'touch drop must issue one PATCH');
    const patch = patchRequests(requests)[0];
    assert.equal(patch.data.revision, libraryBefore.revision, 'drag start must capture the library revision');
    assert.equal(patch.data.docId, docId);
    assert.equal(patch.data.folderId, targetFolderId);
    await waitUntil(async () => (await store.getLibrary(userId)).assignments[docId] === targetFolderId,
      'touch drop must persist the assignment');
    assert.deepEqual(await readerSnapshot(page), readerBefore);
    assert.equal(await page.locator('#doc-list').evaluate((node) => node.scrollTop), listScrollBefore);
    assert.deepEqual(await documentDragState(page), {
      bodyDragging: false,
      ghostCount: 0,
      draggingRows: 0,
      dropTargets: [],
    });

    // A second finger abandons the drag instead of leaving one finger able to
    // scroll while the other owns a floating document.
    const cancelDocId = DOC_IDS.find((id) => id !== docId && !title.includes(DOC_NAMES.get(id))) || DOC_IDS[8];
    const patchesBeforeCancel = patchRequests(requests).length;
    const libraryBeforeCancel = await store.getLibrary(userId);
    await startTouchDrag(page, cancelDocId);
    await dispatchTouchPointer(page, 'pointerdown', 220, 540, '', 99);
    await page.waitForTimeout(120);
    assert.equal(patchRequests(requests).length, patchesBeforeCancel, 'a second finger must not write');
    assert.deepEqual(await documentDragState(page), {
      bodyDragging: false,
      ghostCount: 0,
      draggingRows: 0,
      dropTargets: [],
    });
    assert.deepEqual((await store.getLibrary(userId)).assignments, libraryBeforeCancel.assignments);

    // Pointer cancel must not write or turn into a document tap.
    await startTouchDrag(page, cancelDocId);
    const cancelTargetBox = await folderTarget(page, folderIds[0]).boundingBox();
    await dispatchTouchPointer(page, 'pointermove', cancelTargetBox.x + cancelTargetBox.width / 2,
      cancelTargetBox.y + cancelTargetBox.height / 2);
    await page.waitForTimeout(60);
    await dispatchTouchPointer(page, 'pointercancel', cancelTargetBox.x, cancelTargetBox.y);
    await page.waitForTimeout(180);
    assert.equal(patchRequests(requests).length, patchesBeforeCancel, 'pointercancel must not write');
    assert.deepEqual((await store.getLibrary(userId)).assignments, libraryBeforeCancel.assignments);
    assert.deepEqual(await documentDragState(page), {
      bodyDragging: false,
      ghostCount: 0,
      draggingRows: 0,
      dropTargets: [],
    });
    assert.deepEqual(await readerSnapshot(page), readerBefore, 'cancel must not open a document');

    // An inert target (the document list itself) must not write either.
    await startTouchDrag(page, cancelDocId);
    const listBox = await page.locator('#doc-list').boundingBox();
    await dispatchTouchPointer(page, 'pointermove', listBox.x + listBox.width / 2, listBox.y + 12);
    await dispatchTouchPointer(page, 'pointerup', listBox.x + listBox.width / 2, listBox.y + 12);
    await page.waitForTimeout(180);
    assert.equal(patchRequests(requests).length, patchesBeforeCancel, 'an invalid target must not write');
    assert.deepEqual((await store.getLibrary(userId)).assignments, libraryBeforeCancel.assignments);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`folder drag targets ${browserKind}: list subfolder and unfiled root accept drops, same folder and API failure do not write`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 90000,
}, async () => {
  const { context, page, errors, requests } = await newPage({ width: 390, height: 844 });
  try {
    await login(page);
    await openLibrary(page);

    await page.locator(`#folder-tree [data-folder-id="${folderIds[0]}"]`).click();
    await page.waitForFunction((name) => document.querySelector('#folder-breadcrumb')?.textContent.includes(name),
      FOLDER_NAMES[0]);
    const library = await store.getLibrary(userId);
    const entry = Object.entries(library.assignments)
      .find(([docId, folderId]) => folderId === folderIds[0] && DOC_IDS.includes(docId));
    assert.ok(entry, 'fixture must leave a document in the first folder');
    const [docId] = entry;

    // A subfolder row inside the document list is a drop target.
    await listSubfolderTarget(page, folderIds[1]).waitFor({ state: 'visible' });
    await mouseDrag(page, docId, listSubfolderTarget(page, folderIds[1]));
    await waitUntil(() => patchRequests(requests).length === 1, 'list subfolder drop must PATCH');
    await waitUntil(async () => (await store.getLibrary(userId)).assignments[docId] === folderIds[1],
      'list subfolder drop must persist');

    // Dropping onto the folder the document already lives in is a no-op.
    await page.locator(`#folder-tree [data-folder-id="${folderIds[1]}"]`).click();
    await page.waitForFunction((name) => document.querySelector('#folder-breadcrumb')?.textContent.includes(name),
      FOLDER_NAMES[1]);
    const patchesBeforeSame = patchRequests(requests).length;
    await mouseDrag(page, docId, folderTarget(page, folderIds[1]));
    await page.waitForTimeout(250);
    assert.equal(patchRequests(requests).length, patchesBeforeSame, 'same-folder drop must not PATCH');
    assert.equal((await store.getLibrary(userId)).assignments[docId], folderIds[1]);
    assert.match(await page.locator('.toast').last().textContent(), /已在这个文件夹/);

    // The unfiled root filter accepts a drop and clears the assignment.
    await showAllDocuments(page);
    await mouseDrag(page, docId, page.locator('#folder-tree [data-library-view="root"]'));
    await waitUntil(() => patchRequests(requests).length === patchesBeforeSame + 1, 'root drop must PATCH');
    await waitUntil(async () => !Object.hasOwn((await store.getLibrary(userId)).assignments, docId),
      'root drop must clear the assignment');

    // A 500 from the library API leaves the local assignment untouched.
    const patchesBeforeFailure = patchRequests(requests).length;
    await page.route('**/api/library', async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'MOCK_FAIL', message: '模拟服务端失败' } }),
      });
    });
    await mouseDrag(page, docId, folderTarget(page, folderIds[0]));
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')]
      .some((node) => node.textContent.includes('模拟服务端失败')), { timeout: 8000 });
    assert.equal(patchRequests(requests).length, patchesBeforeFailure + 1);
    assert.equal(Object.hasOwn((await store.getLibrary(userId)).assignments, docId), false,
      'a failed PATCH must not be shown as persisted');
    assert.deepEqual(await documentDragState(page), {
      bodyDragging: false,
      ghostCount: 0,
      draggingRows: 0,
      dropTargets: [],
    });
    await page.unroute('**/api/library');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(`folder drag conflict ${browserKind}: a remote revision change produces 409, no replay, and a later explicit retry succeeds`, {
  skip: canRun ? false : 'No Playwright browser available',
  timeout: 90000,
}, async () => {
  const { context, page, errors, requests } = await newPage({ width: 390, height: 844 });
  try {
    await login(page);
    await openLibrary(page);
    await showAllDocuments(page);

    const library = await store.getLibrary(userId);
    const docId = DOC_IDS.find((id) => !Object.hasOwn(library.assignments, id));
    assert.ok(docId, 'fixture must leave an unfiled document for the conflict case');
    const targetFolderId = folderIds[0];

    const patchesBefore = patchRequests(requests).length;
    const remoteName = '远端新增文件夹';
    await mouseDrag(page, docId, folderTarget(page, targetFolderId), {
      betweenStartAndDrop: async () => {
        const remote = await store.mutateLibrary(userId, {
          revision: library.revision,
          action: 'createFolder',
          name: remoteName,
          parentId: null,
        });
        assert.equal(remote.revision, library.revision + 1);
      },
    });

    await waitUntil(() => patchRequests(requests).length === patchesBefore + 1, 'conflicting drag must PATCH once');
    const conflictPatch = patchRequests(requests)[patchesBefore];
    assert.equal(conflictPatch.data.revision, library.revision,
      'the drag must submit the revision captured at drag start, not a refreshed one');
    await page.locator('#library-state[data-kind="conflict"]').waitFor({ state: 'visible', timeout: 8000 });
    assert.match(await page.locator('#library-state-text').textContent(), /其他设备|更新/);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')]
      .some((node) => node.textContent.includes('本次拖动未保存')), { timeout: 8000 });
    assert.equal(Object.hasOwn((await store.getLibrary(userId)).assignments, docId), false,
      'a 409 must not be applied locally or replayed automatically');
    await page.waitForFunction((name) => document.querySelector('#folder-tree')?.textContent.includes(name), remoteName);

    // The next explicit drag uses the refreshed revision and succeeds.
    await mouseDrag(page, docId, folderTarget(page, targetFolderId));
    await waitUntil(() => patchRequests(requests).length === patchesBefore + 2, 'retry must PATCH');
    const retryPatch = patchRequests(requests)[patchesBefore + 1];
    assert.equal(retryPatch.data.revision, library.revision + 1,
      'retry must use the refreshed library revision');
    await waitUntil(async () => (await store.getLibrary(userId)).assignments[docId] === targetFolderId,
      'the explicit retry must persist');
    await page.locator('#library-state').waitFor({ state: 'hidden', timeout: 8000 });

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
