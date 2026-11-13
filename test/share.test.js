import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderServer } from '../lib/reader-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let server;
let base;
let tmpRoot;
let sessionToken;

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-share-test-'));
  await fsp.writeFile(path.join(tmpRoot, 'welcome.md'), '# 分享测试\n');
  server = createReaderServer({
    rootDir: projectRoot,
    samplePath: path.join(tmpRoot, 'welcome.md'),
    pollMs: 100,
    shareHost: '127.0.0.1',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  sessionToken = await newSessionToken();
});

after(async () => {
  server?.readerShutdown();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function newSessionToken() {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = html.match(/<meta name="md-token" content="([^"]+)">/);
  assert.ok(match, 'local shell must contain a session token');
  return match[1];
}

function localFetch(pathname, token, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (token) headers['X-MD-Token'] = token;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${pathname}`, {
    ...init,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function makeDoc(name, content) {
  const dir = await fsp.mkdtemp(path.join(tmpRoot, `${name}-`));
  const file = path.join(dir, 'doc.md');
  await fsp.writeFile(file, content);
  return { dir, file };
}

async function openDoc(file) {
  const response = await localFetch('/api/open', sessionToken, {
    method: 'POST',
    body: { path: file },
  });
  assert.equal(response.status, 200);
  return (await response.json()).doc;
}

async function startShare() {
  const response = await localFetch('/api/share', sessionToken, {
    method: 'POST',
    body: {},
  });
  assert.equal(response.status, 200);
  return (await response.json()).share;
}

async function revokeShare() {
  const response = await localFetch('/api/share/revoke', sessionToken, {
    method: 'POST',
    body: {},
  });
  assert.equal(response.status, 200);
  return (await response.json()).share;
}

function shareParts(share) {
  const url = new URL(share.link);
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  assert.ok(token && token.length >= 40, 'share link must carry a fragment token');
  return { url, origin: url.origin, token, port: Number(url.port) };
}

function shareFetch(share, pathname, init = {}) {
  const { origin, token } = shareParts(share);
  const headers = { ...(init.headers || {}) };
  if (init.auth !== false) headers['X-MD-Token'] = token;
  delete init.auth;
  return fetch(`${origin}${pathname}`, { ...init, headers });
}

async function waitForShareState(share, predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const response = await shareFetch(share, '/api/share/state');
    if (response.status === 200) {
      last = await response.json();
      if (predicate(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`share state did not reach expected condition: ${JSON.stringify(last)}`);
}

function requestWithHost(share, host, pathname = '/api/share/state') {
  const { port } = shareParts(share);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      headers: { Host: host, 'X-MD-Token': shareParts(share).token },
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

function waitForPortClosed(port, timeout = 6000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 100);
      });
      socket.once('error', () => resolve(true));
      socket.once('timeout', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

test('LAN sharing stays off until the Mac user starts it', async () => {
  assert.equal(server.address().address, '127.0.0.1');
  const before = await (await localFetch('/api/share', sessionToken)).json();
  assert.equal(before.share, null);

  const { file } = await makeDoc('one', '# 只分享这一份\n');
  await openDoc(file);
  const beforeStart = await (await localFetch('/api/share', sessionToken)).json();
  assert.equal(beforeStart.share, null);

  const share = await startShare();
  assert.equal(share.active, true);
  assert.equal(share.name, 'doc.md');
  assert.equal(share.path, file);
  assert.match(share.address, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(share.link, /#t=/);

  const after = await (await localFetch('/api/share', sessionToken)).json();
  assert.equal(after.share.active, true);
  assert.equal(after.share.link, share.link);
  await revokeShare();
});

test('LAN server exposes only token-authenticated state and safe images', async () => {
  const { dir, file } = await makeDoc('secure', [
    '# 安全分享',
    '',
    '![像素](pixel.png)',
  ].join('\n'));
  await fsp.writeFile(path.join(dir, 'pixel.png'), PNG_1PX);
  const outside = path.join(tmpRoot, 'outside.png');
  await fsp.writeFile(outside, PNG_1PX);

  await openDoc(file);
  const share = await startShare();
  const { origin, token } = shareParts(share);

  const shell = await fetch(`${origin}/`);
  assert.equal(shell.status, 200);
  const shellHtml = await shell.text();
  assert.match(shellHtml, /iPad 阅读/);
  assert.doesNotMatch(shellHtml, new RegExp(token));
  assert.doesNotMatch(shellHtml, /安全分享/);
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
  assert.match(shell.headers.get('content-security-policy'), /img-src 'self' data: blob:/);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(shell.headers.get('x-frame-options'), 'DENY');
  assert.equal(shell.headers.get('cache-control'), 'no-store');

  const noToken = await fetch(`${origin}/api/share/state`);
  assert.equal(noToken.status, 401);
  const wrongToken = await fetch(`${origin}/api/share/state`, {
    headers: { 'X-MD-Token': 'not-the-token' },
  });
  assert.equal(wrongToken.status, 401);
  const queryToken = await fetch(`${origin}/api/share/state?t=${encodeURIComponent(token)}`);
  assert.equal(queryToken.status, 401);

  const stateResponse = await shareFetch(share, '/api/share/state');
  assert.equal(stateResponse.status, 200);
  const stateText = await stateResponse.text();
  assert.doesNotMatch(stateText, new RegExp(tmpRoot));
  assert.doesNotMatch(stateText, /"path"|"dir"/);
  const statePayload = JSON.parse(stateText);
  assert.equal(statePayload.doc.name, 'doc.md');
  assert.equal(statePayload.status.key, 'synced');
  assert.match(statePayload.doc.html, /data-share-asset="pixel\.png"/);
  assert.doesNotMatch(statePayload.doc.html, /\/api\/asset\?token=/);

  const openOnLan = await shareFetch(share, '/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: outside }),
  });
  assert.equal(openOnLan.status, 404);
  const pickOnLan = await shareFetch(share, '/api/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(pickOnLan.status, 404);
  const assetAlias = await shareFetch(share, '/api/asset?p=pixel.png');
  assert.equal(assetAlias.status, 404);
  const events = await shareFetch(share, '/api/events');
  assert.equal(events.status, 404);

  const crossOrigin = await fetch(`${origin}/api/share/state`, {
    headers: { 'X-MD-Token': token, Origin: 'https://evil.example' },
  });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await fetch(`${origin}/api/share/state`, {
    headers: { 'X-MD-Token': token, 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  const preflight = await fetch(`${origin}/api/share/state`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Headers': 'x-md-token' },
  });
  assert.equal(preflight.status, 403);

  const wrongHost = await requestWithHost(share, 'evil.example');
  assert.equal(wrongHost.status, 403);

  const image = await shareFetch(share, '/api/share/asset?p=pixel.png');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG_1PX);

  const traversal = await shareFetch(share, '/api/share/asset?p=../outside.png');
  assert.equal(traversal.status, 403);
  const absolute = await shareFetch(share, '/api/share/asset?p=%2Fetc%2Fpasswd');
  assert.equal(absolute.status, 403);
  const noImageToken = await fetch(`${origin}/api/share/asset?p=pixel.png`);
  assert.equal(noImageToken.status, 401);

  await revokeShare();
});

test('a share is pinned to one file; later reading does not re-share it', async () => {
  const first = await makeDoc('pinned-a', '# 文稿 A\n\nA 的正文。\n');
  const second = await makeDoc('pinned-b', '# 文稿 B\n\nB 的正文。\n');

  await openDoc(first.file);
  const shareA = await startShare();
  const portA = shareParts(shareA).port;

  await openDoc(second.file);
  const stateA = await (await shareFetch(shareA, '/api/share/state')).json();
  assert.equal(stateA.doc.name, 'doc.md');
  assert.match(stateA.doc.html, /A 的正文/);
  assert.doesNotMatch(stateA.doc.html, /B 的正文/);

  const shareB = await startShare();
  assert.equal(shareB.path, second.file);
  assert.notEqual(shareParts(shareB).port, portA);
  assert.equal(await waitForPortClosed(portA), true, 'replacing a share must close the old listener');

  const stateB = await (await shareFetch(shareB, '/api/share/state')).json();
  assert.match(stateB.doc.html, /B 的正文/);

  const oldTokenOnNewPort = await fetch(`${shareParts(shareB).origin}/api/share/state`, {
    headers: { 'X-MD-Token': shareParts(shareA).token },
  });
  assert.equal(oldTokenOnNewPort.status, 401);

  await revokeShare();
  const afterRevoke = await (await localFetch('/api/share', sessionToken)).json();
  assert.equal(afterRevoke.share, null);
  assert.equal(await waitForPortClosed(shareParts(shareB).port), true);
  const revoked = await fetch(`${shareParts(shareB).origin}/api/share/state`, {
    headers: { 'X-MD-Token': shareParts(shareB).token },
  }).then(() => 'response').catch(() => 'closed');
  assert.equal(revoked, 'closed');

  // Revoking the LAN share must not disable the local reader.
  const stillLocal = await localFetch('/api/state', sessionToken);
  assert.equal(stillLocal.status, 200);
});

test('shared file updates, deletion, and recovery are visible through polling', async () => {
  const { file } = await makeDoc('live-share', '# 实时共享\n\n初始内容。\n');
  await openDoc(file);
  const share = await startShare();

  const first = await waitForShareState(share, (payload) => payload.status.key === 'synced');
  const revision = first.doc.revision;

  await fsp.writeFile(file, '# 实时共享\n\n轮询后的新内容。\n\n## 新章节\n');
  const changed = await waitForShareState(share, (payload) => (
    payload.doc.revision > revision && /轮询后的新内容/.test(payload.doc.html)
  ));
  assert.equal(changed.status.key, 'synced');

  await fsp.unlink(file);
  const missing = await waitForShareState(share, (payload) => payload.status.key === 'missing');
  assert.equal(missing.status.code, 'FILE_MISSING');
  assert.match(missing.doc.html, /轮询后的新内容/);

  await fsp.writeFile(file, '# 实时共享\n\n文件恢复后的内容。\n');
  const recovered = await waitForShareState(share, (payload) => (
    payload.status.key === 'synced' && /文件恢复后的内容/.test(payload.doc.html)
  ));
  assert.equal(recovered.status.key, 'synced');

  await revokeShare();
});

test('app shutdown tears down an active LAN listener', async () => {
  const { file } = await makeDoc('shutdown', '# 停止\n');
  await openDoc(file);
  const share = await startShare();
  const { port } = shareParts(share);

  server.readerShutdown();
  assert.equal(await waitForPortClosed(port), true, 'LAN listener must close with the app server');
});
