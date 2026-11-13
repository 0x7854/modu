import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit } from 'playwright';
import { createReaderServer } from '../lib/reader-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const ipad = devices['iPad Pro 11'];
const webkitPath = webkit.executablePath();
const chromiumPath = chromium.executablePath();
const hasWebKit = Boolean(webkitPath && fs.existsSync(webkitPath));
const hasChromium = Boolean(chromiumPath && fs.existsSync(chromiumPath));
const browserKind = hasWebKit ? 'WebKit' : (hasChromium ? 'Chromium fallback' : 'none');
const canRun = hasWebKit || hasChromium;

let server;
let base;
let tmpRoot;
let sessionToken;
let share;
let browser;
let page;

function makeBody() {
  return [
    '# iPad 仿真阅读',
    '',
    '这是一段用于验证触屏阅读、目录和主题的正文。',
    '',
    '![像素](pixel.png)',
    '',
    ...Array.from({ length: 28 }, (_, index) => [
      `## 章节 ${index + 1}`,
      '',
      `第 ${index + 1} 节的正文。${'安静的墨读文字。'.repeat(6)}`,
      '',
    ]).flat(),
  ].join('\n');
}

before(async () => {
  if (!canRun) return;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-ipad-test-'));
  const docDir = path.join(tmpRoot, 'doc');
  await fsp.mkdir(docDir);
  const doc = path.join(docDir, 'ipad.md');
  await fsp.writeFile(doc, makeBody());
  await fsp.writeFile(path.join(docDir, 'pixel.png'), PNG_1PX);

  server = createReaderServer({
    rootDir: projectRoot,
    samplePath: doc,
    pollMs: 100,
    shareHost: '127.0.0.1',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const shell = await fetch(`${base}/`);
  const html = await shell.text();
  sessionToken = html.match(/<meta name="md-token" content="([^"]+)">/)[1];
  const headers = { 'X-MD-Token': sessionToken, 'Content-Type': 'application/json' };
  const openResponse = await fetch(`${base}/api/open`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: doc }),
  });
  assert.equal(openResponse.status, 200);
  const shareResponse = await fetch(`${base}/api/share`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(shareResponse.status, 200);
  const payload = await shareResponse.json();
  share = payload.share;

  const browserType = hasWebKit ? webkit : chromium;
  browser = await browserType.launch({ headless: true });
  const context = await browser.newContext(hasWebKit ? {
    ...ipad,
  } : {
    viewport: ipad.viewport,
    deviceScaleFactor: ipad.deviceScaleFactor,
    hasTouch: true,
    isMobile: true,
    userAgent: ipad.userAgent,
  });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.text().startsWith('capture-anchor') || message.text().startsWith('restore-anchor')) {
      console.log('PAGE', message.text());
    }
  });
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  server?.readerShutdown();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

console.log(`iPad simulation engine: ${browserKind} (not a physical iPad)`);

test(`iPad ${browserKind} viewport: touch reading, outline, theme, live update, missing state`, {
  skip: canRun ? false : 'No Playwright WebKit or Chromium browser is installed',
  timeout: 120000,
}, async () => {
  await page.goto(share.link, { waitUntil: 'domcontentloaded' });
  await page.locator('#share-doc').waitFor({ state: 'visible', timeout: 15000 });
  await page.getByText('iPad 仿真阅读').first().waitFor({ timeout: 10000 });
  await page.locator('img[data-share-asset]').waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const image = document.querySelector('img[data-share-asset]');
    return image && image.src.startsWith('blob:');
  }, null, { timeout: 10000 });

  const url = page.url();
  assert.equal(url.includes('#t='), false, 'fragment token must be removed from the address');
  assert.equal(url.includes('modu.share.token'), false);
  assert.match(await page.locator('#share-status-text').textContent(), /实时同步/);
  assert.equal(await page.locator('#share-reader').evaluate((node) => node.scrollHeight > node.clientHeight), true);

  await page.locator('#share-outline-toggle').tap();
  await page.waitForFunction(() => document.querySelector('#share-outline-panel').classList.contains('is-open'));
  assert.ok(await page.locator('#share-outline .outline-link').count() > 3);
  await page.locator('#share-outline .outline-link').nth(2).tap();
  await page.waitForFunction(() => !document.querySelector('#share-outline-panel').classList.contains('is-open'));
  await page.waitForFunction(() => document.querySelector('#share-reader').scrollTop > 100);

  await page.locator('#share-theme-toggle').tap();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('#share-theme-toggle').tap();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');

  await page.locator('#share-settings-toggle').tap();
  assert.match(await page.locator('#share-settings').textContent(), /添加到主屏幕/);
  assert.match(await page.locator('#share-settings').textContent(), /不会离线保存正文/);
  await page.locator('#share-font-range').evaluate((input) => {
    input.value = '21';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(
    await page.locator('html').evaluate((node) => getComputedStyle(node).getPropertyValue('--doc-font-size').trim()),
    '21px',
  );
  await page.locator('#share-settings-close').tap();

  // Put the reader in the middle of the document, then append a new section.
  await page.locator('#share-reader').evaluate((node) => {
    node.scrollTop = Math.min(1400, node.scrollHeight - node.clientHeight);
  });
  const beforeScroll = await page.locator('#share-reader').evaluate((node) => node.scrollTop);
  const anchorProbe = () => page.evaluate(() => {
    const container = document.querySelector('#share-reader');
    const doc = document.querySelector('#share-doc');
    const rect = container.getBoundingClientRect();
    const focusY = rect.top + Math.min(140, container.clientHeight * 0.22);
    const node = [...doc.children].find((child) => child.getBoundingClientRect().bottom > focusY);
    return {
      scrollTop: container.scrollTop,
      max: container.scrollHeight - container.clientHeight,
      clientHeight: container.clientHeight,
      docHeight: doc.getBoundingClientRect().height,
      fontSize: getComputedStyle(doc).fontSize,
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--doc-font-size').trim(),
      focusTop: node ? node.getBoundingClientRect().top - rect.top : null,
      key: node?.dataset.anchor || null,
      text: node?.textContent.slice(0, 50) || null,
    };
  });
  console.log('BEFORE PROBE', await anchorProbe());
  await page.evaluate(() => { window.__MODU_SHARE_DEBUG__ = true; });

  const docPath = path.join(tmpRoot, 'doc', 'ipad.md');
  const updated = makeBody().replace(
    '# iPad 仿真阅读',
    '# iPad 仿真阅读\n\n实时更新标记：示例 20260101。',
  );
  await fsp.writeFile(docPath, updated);
  await page.getByText('实时更新标记：示例 20260101。').waitFor({ timeout: 10000 });
  console.log('AFTER PROBE', await page.evaluate(() => {
    const container = document.querySelector('#share-reader');
    const doc = document.querySelector('#share-doc');
    return {
      scrollTop: container.scrollTop,
      max: container.scrollHeight - container.clientHeight,
      clientHeight: container.clientHeight,
      docHeight: doc.getBoundingClientRect().height,
      fontSize: getComputedStyle(doc).fontSize,
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--doc-font-size').trim(),
      targetTop: document.querySelector('[data-anchor="b:ird5so:0"]')?.getBoundingClientRect().top,
      targetText: document.querySelector('[data-anchor="b:ird5so:0"]')?.textContent.slice(0, 50),
      h1Height: doc.querySelector('h1')?.getBoundingClientRect().height,
    };
  }));
  const afterScroll = await page.locator('#share-reader').evaluate((node) => node.scrollTop);
  assert.ok(Math.abs(afterScroll - beforeScroll) < 220, `reading position should be kept (${beforeScroll} -> ${afterScroll})`);

  await fsp.unlink(docPath);
  await page.locator('#share-status-text').filter({ hasText: '原文件已删除' }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByText('实时更新标记：示例 20260101。').count() > 0, true);
  assert.match(await page.locator('#share-alert').textContent(), /正文保留/);

  await fsp.writeFile(docPath, `${updated}\n\n恢复后的新段落。\n`);
  await page.locator('#share-status-text').filter({ hasText: '实时同步' }).waitFor({ timeout: 10000 });
  await page.getByText('恢复后的新段落。').waitFor({ timeout: 10000 });
});
