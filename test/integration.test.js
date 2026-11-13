import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderServer } from '../lib/reader-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

let server;
let base;
let tmpRoot;

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-reader-test-'));
  await fsp.writeFile(path.join(tmpRoot, 'welcome.md'), '# 测试示例\n\n示例正文。\n');
  server = createReaderServer({
    rootDir: projectRoot,
    samplePath: path.join(tmpRoot, 'welcome.md'),
    pollMs: 100,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server?.readerShutdown();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function makeDoc(name, content) {
  const dir = await fsp.mkdtemp(path.join(tmpRoot, `${name}-`));
  const file = path.join(dir, 'doc.md');
  await fsp.writeFile(file, content);
  return { dir, file };
}

async function newSession() {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = html.match(/<meta name="md-token" content="([^"]+)">/);
  assert.ok(match, 'initial HTML must contain a session token');
  return { token: match[1], html, response };
}

function apiFetch(pathname, token, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (token) headers['X-MD-Token'] = token;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${pathname}`, {
    ...init,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function openDoc(token, file) {
  const response = await apiFetch('/api/open', token, {
    method: 'POST',
    body: { path: file },
  });
  const payload = await response.json();
  return { response, payload };
}

function requestWithHost(host) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/api/state',
      method: 'GET',
      headers: { Host: host },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

class SseClient {
  constructor(response, controller) {
    this.response = response;
    this.controller = controller;
    this.reader = response.body.getReader();
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.events = [];
    this.pendingRead = null;
  }

  async readChunk(timeoutMs) {
    if (!this.pendingRead) {
      const pending = this.reader.read();
      this.pendingRead = pending;
      pending.finally(() => {
        if (this.pendingRead === pending) this.pendingRead = null;
      }).catch(() => {});
    }
    const sentinel = Symbol('timeout');
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(sentinel), timeoutMs);
    });
    try {
      const result = await Promise.race([this.pendingRead, timeout]);
      if (result === sentinel) return null;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  static async connect(token) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    return new SseClient(response, controller);
  }

  parse() {
    while (true) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary < 0) return;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) {
        try {
          this.events.push({ event, data: JSON.parse(dataLines.join('\n')) });
        } catch {
          // Ignore malformed frames.
        }
      }
    }
  }

  async nextNamed(name, { timeout = 5000, predicate = null } = {}) {
    const deadline = Date.now() + timeout;
    while (true) {
      this.parse();
      const index = this.events.findIndex((entry) => entry.event === name
        && (!predicate || predicate(entry.data)));
      if (index >= 0) {
        const [entry] = this.events.splice(index, 1);
        return entry.data;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for SSE event ${name}. Seen: ${this.events.map((item) => item.event).join(', ')}`);
      }
      const chunk = await this.readChunk(remaining);
      if (!chunk) throw new Error(`Timed out waiting for SSE event ${name}`);
      if (chunk.done) throw new Error('SSE stream ended unexpectedly');
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async expectNoEvent(name, duration = 700) {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      this.parse();
      if (this.events.some((entry) => entry.event === name)) {
        throw new Error(`Unexpected SSE event: ${name}`);
      }
      const remaining = deadline - Date.now();
      const chunk = await this.readChunk(remaining);
      if (chunk?.done) return;
      if (chunk) this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
    this.parse();
    assert.equal(this.events.some((entry) => entry.event === name), false);
  }

  close() {
    try {
      this.controller.abort();
    } catch {
      // Already aborted.
    }
  }
}

test('initial page delivers a session token and security headers', async () => {
  const { token, html, response } = await newSession();
  assert.ok(token.length >= 40);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(html, /墨读/);
  assert.match(html, /__MD_SAMPLE_PATH__|welcome\.md/);
  assert.equal(server.address().address, '127.0.0.1');
});

test('session API rejects missing, wrong, and cross-origin requests', async () => {
  const { token } = await newSession();
  const noToken = await apiFetch('/api/state', '');
  assert.equal(noToken.status, 401);

  const wrongToken = await apiFetch('/api/state', 'not-a-real-token');
  assert.equal(wrongToken.status, 401);

  const crossOrigin = await fetch(`${base}/api/open`, {
    method: 'POST',
    headers: {
      'X-MD-Token': token,
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({ path: '/tmp/x.md' }),
  });
  assert.equal(crossOrigin.status, 403);
  const crossPayload = await crossOrigin.json();
  assert.equal(crossPayload.error.code, 'CROSS_ORIGIN_BLOCKED');

  const crossFetchSite = await fetch(`${base}/api/state`, {
    headers: { 'X-MD-Token': token, 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossFetchSite.status, 403);

  const badHost = await requestWithHost('evil.example');
  assert.equal(badHost.status, 403);

  const preflight = await fetch(`${base}/api/open`, {
    method: 'OPTIONS',
    headers: { Origin: base },
  });
  assert.equal(preflight.status, 403);
});

test('open validates absolute path, extension, symlinks, and file size', async () => {
  const { token } = await newSession();
  const relative = await apiFetch('/api/open', token, { method: 'POST', body: { path: 'relative.md' } });
  assert.equal(relative.status, 400);

  const htmlFile = path.join(tmpRoot, 'page.pdf');
  await fsp.writeFile(htmlFile, '<h1>no</h1>');
  const unsupported = await apiFetch('/api/open', token, { method: 'POST', body: { path: htmlFile } });
  assert.equal(unsupported.status, 415);

  const target = path.join(tmpRoot, 'target.md');
  await fsp.writeFile(target, '# target');
  const link = path.join(tmpRoot, 'link.md');
  await fsp.symlink(target, link);
  const symlink = await apiFetch('/api/open', token, { method: 'POST', body: { path: link } });
  assert.equal(symlink.status, 403);
  assert.equal((await symlink.json()).error.code, 'SYMLINK_BLOCKED');

  const huge = path.join(tmpRoot, 'huge.md');
  await fsp.writeFile(huge, `# huge\n${'x'.repeat(2 * 1024 * 1024 + 1)}`);
  const tooLarge = await apiFetch('/api/open', token, { method: 'POST', body: { path: huge } });
  assert.equal(tooLarge.status, 413);
});

test('public shell allows external navigation while private APIs remain same-origin', async () => {
  const navigation = await fetch(`${base}/`, { headers: {
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate',
  }});
  assert.equal(navigation.status, 200);
  const { token } = await newSession();
  const api = await apiFetch('/api/state', token, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(api.status, 403);
});

test('Markdown renders headings, GFM tables/tasks, highlighting, and local images', async () => {
  const { token } = await newSession();
  const { dir, file } = await makeDoc('render', [
    '# 第一章',
    '',
    '## 第一章',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    '| 状态 | 良好 |',
    '',
    '- [x] 完成',
    '- [ ] 待办',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '![本地图片](assets/pixel.png)',
    '',
    '## 第二章',
  ].join('\n'));
  await fsp.mkdir(path.join(dir, 'assets'));
  await fsp.writeFile(path.join(dir, 'assets', 'pixel.png'), PNG_1PX);

  const { response, payload } = await openDoc(token, file);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.doc.name, 'doc.md');
  const ids = payload.doc.headings.map((heading) => heading.id);
  assert.deepEqual(ids, ['第一章', '第一章-2', '第二章']);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(payload.doc.html, /<table>/);
  assert.match(payload.doc.html, /task-list-item-checkbox/);
  assert.match(payload.doc.html, /class="hljs"/);
  assert.match(payload.doc.html, /hljs-keyword/);
  assert.match(payload.doc.html, /\/api\/asset\?token=/);

  const imageMatch = payload.doc.html.match(/<img src="([^"]+)"/);
  assert.ok(imageMatch);
  const imageUrl = imageMatch[1].replaceAll('&amp;', '&');
  const imageResponse = await fetch(`${base}${imageUrl}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), PNG_1PX);
});

test('raw HTML and dangerous links are sanitized', async () => {
  const { token } = await newSession();
  const { file } = await makeDoc('xss', [
    '# 安全测试',
    '',
    '<script>window.__xss = 1</script>',
    '<img src=x onerror="window.__xss = 2">',
    '<iframe src="https://evil.example"></iframe>',
    '',
    '[javascript](javascript:window.__xss=3)',
    '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[外部链接](https://example.com/path?q=1)',
    '![外部图片](https://example.com/tracker.png)',
    '![越界图片](../secret.png)',
    '',
    '正常文本 <b>raw</b>',
  ].join('\n'));
  const { response, payload } = await openDoc(token, file);
  assert.equal(response.status, 200);
  const html = payload.doc.html;
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img[^>]*onerror/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.match(html, /&lt;img src=x onerror=/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /href="data:/i);
  assert.doesNotMatch(html, /src="javascript:/i);
  assert.doesNotMatch(html, /tracker\.png/);
  assert.match(html, /外部图片/);
  assert.match(html, /class="md-image-blocked"/);
  assert.match(html, /href="https:\/\/example\.com\/path\?q=1"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /&lt;script&gt;/);
});

test('asset channel blocks traversal, symlinks, foreign origins, and non-images', async () => {
  const { token } = await newSession();
  const { dir, file } = await makeDoc('assets', '# 图片\n\n![ok](pixel.png)\n\n![bad](link.png)');
  await fsp.writeFile(path.join(dir, 'pixel.png'), PNG_1PX);
  const outside = path.join(tmpRoot, 'outside.png');
  await fsp.writeFile(outside, PNG_1PX);
  await fsp.symlink(outside, path.join(dir, 'link.png'));
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'not an image');

  const { payload } = await openDoc(token, file);
  assert.match(payload.doc.html, /p=pixel\.png/);
  assert.match(payload.doc.html, /md-image-blocked/);

  const traversal = await fetch(`${base}/api/asset?token=${encodeURIComponent(token)}&p=${encodeURIComponent('../outside.png')}`);
  assert.equal(traversal.status, 403);

  const symlink = await fetch(`${base}/api/asset?token=${encodeURIComponent(token)}&p=link.png`);
  assert.equal(symlink.status, 403);

  const nonImage = await fetch(`${base}/api/asset?token=${encodeURIComponent(token)}&p=notes.txt`);
  assert.equal(nonImage.status, 415);

  const noToken = await fetch(`${base}/api/asset?p=pixel.png`);
  assert.equal(noToken.status, 401);

  const crossOrigin = await fetch(`${base}/api/asset?token=${encodeURIComponent(token)}&p=pixel.png`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossOrigin.status, 403);

  const queryTokenOnState = await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`);
  assert.equal(queryTokenOnState.status, 401);
});

test('live sync handles hash-only changes, atomic replace, deletion, recreation, and reconnect', async () => {
  const { token } = await newSession();
  const { file } = await makeDoc('live', '# 实时\n\n初始内容。\n');
  const { payload } = await openDoc(token, file);
  assert.equal(payload.status.key, 'synced');
  assert.equal(payload.doc.headings[0].text, '实时');

  const sse = await SseClient.connect(token);
  const hello = await sse.nextNamed('hello');
  assert.equal(hello.doc.path, file);

  // Same content must not cause a re-render or revision bump.
  const beforeState = await (await apiFetch('/api/state', token)).json();
  await fsp.writeFile(file, '# 实时\n\n初始内容。\n');
  await sse.expectNoEvent('doc-changed', 650);
  const afterState = await (await apiFetch('/api/state', token)).json();
  assert.equal(afterState.doc.revision, beforeState.doc.revision);

  // Direct edit.
  await fsp.writeFile(file, '# 实时\n\n第一处改动。\n\n## 新章节\n\n新正文。\n');
  const changed = await sse.nextNamed('doc-changed');
  assert.match(changed.doc.html, /第一处改动/);
  assert.match(changed.doc.html, /新章节/);
  assert.equal(changed.status.key, 'synced');
  assert.ok(changed.doc.checkedAt);

  // Atomic save: write to a sibling temp file, then rename over the original.
  const temp = path.join(path.dirname(file), '.doc.md.swp');
  await fsp.writeFile(temp, '# 实时\n\n原子替换后的正文。\n');
  await fsp.rename(temp, file);
  const atomic = await sse.nextNamed('doc-changed');
  assert.match(atomic.doc.html, /原子替换后的正文/);

  // Deletion: after a tolerant beat, status becomes missing but old content remains.
  await fsp.unlink(file);
  const missing = await sse.nextNamed('doc-status', {
    predicate: (data) => data.status.key === 'missing',
  });
  assert.equal(missing.status.code, 'FILE_MISSING');
  assert.match(missing.path, /doc\.md$/);
  const missingState = await (await apiFetch('/api/state', token)).json();
  assert.equal(missingState.status.key, 'missing');
  assert.match(missingState.doc.html, /原子替换后的正文/);

  // Recreate with the same content: recovery event, not a false new revision.
  await fsp.writeFile(file, '# 实时\n\n原子替换后的正文。\n');
  const recovered = await sse.nextNamed('doc-recovered', {
    predicate: (data) => data.status.key === 'synced',
  });
  assert.equal(recovered.status.key, 'synced');
  assert.match(recovered.doc.html, /原子替换后的正文/);

  // Recreate/change again after the missing interval.
  await fsp.unlink(file);
  await sse.nextNamed('doc-status', {
    predicate: (data) => data.status.key === 'missing',
  });
  await fsp.writeFile(file, '# 实时\n\n恢复后的新内容。\n');
  const restored = await sse.nextNamed('doc-changed');
  assert.match(restored.doc.html, /恢复后的新内容/);
  assert.equal(restored.status.key, 'synced');

  // A fresh SSE connection receives a full snapshot for recovery.
  sse.close();
  const sse2 = await SseClient.connect(token);
  const hello2 = await sse2.nextNamed('hello');
  assert.match(hello2.doc.html, /恢复后的新内容/);
  assert.equal(hello2.status.key, 'synced');
  sse2.close();
});

test('API state is authenticated and returns the latest snapshot', async () => {
  const { token } = await newSession();
  const { file } = await makeDoc('state', '# 状态\n\n正文。\n');
  const { payload } = await openDoc(token, file);
  const stateResponse = await apiFetch('/api/state', token);
  assert.equal(stateResponse.status, 200);
  const statePayload = await stateResponse.json();
  assert.equal(statePayload.doc.revision, payload.doc.revision);
  assert.equal(statePayload.doc.path, file);
  assert.equal(statePayload.status.key, 'synced');
});
