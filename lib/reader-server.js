import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './markdown.js';
import { createShareServer, findLanAddress } from './share-server.js';
import {
  inspectDocPath,
  readDocFile,
  resolveImage,
  readAsset,
  ReaderError,
  sha256,
} from './paths.js';

const PREVIEW_READY_BRIDGE = "\n<script>(()=>{const ready=()=>parent.postMessage({type:'modu-preview-ready'},'*');if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready()})();</script>";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 4648;
const POLL_MS = 500;
const MAX_JSON_BODY = 32 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;

const STATIC_FILES = new Map([
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml; charset=utf-8' }],
]);

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
};

const HTML_PREVIEW_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "navigate-to 'none'",
  ].join('; '),
};

function nowIso() {
  return new Date().toISOString();
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function getHeaderToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const headerToken = req.headers['x-md-token'];
  return typeof headerToken === 'string' ? headerToken.trim() : '';
}

function buildSnapshot(session, doc, buffer, statusSource = 'synced', previews = null) {
  const hash = sha256(buffer);
  session.revision += 1;
  const checkedAt = nowIso();
  if (doc.kind === 'html') {
    revokePreviewCapabilities(session, previews);
    const snapshot = {
      path: doc.requestedPath,
      name: doc.name,
      dir: path.dirname(doc.requestedPath),
      kind: 'html',
      size: Buffer.byteLength(buffer),
      mtimeMs: doc.stat.mtimeMs,
      hash,
      revision: session.revision,
      checkedAt,
      previewUrl: '',
      statusSource,
    };
    if (previews) {
      const capability = crypto.randomBytes(32).toString('base64url');
      previews.set(capability, {
        sessionToken: session.token,
        realPath: doc.realPath,
        revision: snapshot.revision,
        hash,
        createdAt: Date.now(),
      });
      session.previewCapabilities.add(capability);
      snapshot.previewUrl = `/api/html-preview?cap=${encodeURIComponent(capability)}`;
    }
    return snapshot;
  }

  revokePreviewCapabilities(session, previews);
  const source = buffer.toString('utf8');
  let rendered;
  try {
    rendered = renderMarkdown(source, doc, session.token);
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError('RENDER_FAILED', 'Markdown 渲染失败。', 422);
  }
  return {
    path: doc.requestedPath,
    name: doc.name,
    dir: path.dirname(doc.requestedPath),
    kind: 'markdown',
    size: Buffer.byteLength(buffer),
    mtimeMs: doc.stat.mtimeMs,
    hash,
    revision: session.revision,
    checkedAt,
    html: rendered.html,
    headings: rendered.headings,
    statusSource,
  };
}

function revokePreviewCapabilities(session, previews) {
  if (!previews || !session?.previewCapabilities) return;
  for (const capability of session.previewCapabilities) previews.delete(capability);
  session.previewCapabilities.clear();
}

function publicStatus(session) {
  return {
    key: session.status.key,
    code: session.status.code || null,
    message: session.status.message || null,
    checkedAt: session.status.checkedAt || null,
  };
}

function sseSend(res, event, payload) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // The connection close handler removes dead clients.
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    ...BASE_SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, error) {
  const readerError = error instanceof ReaderError
    ? error
    : new ReaderError('INTERNAL_ERROR', '服务内部错误。', 500);
  sendJson(res, readerError.status, {
    ok: false,
    error: {
      code: readerError.code,
      message: readerError.message,
    },
  });
}

function sendText(res, statusCode, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(statusCode, {
    ...BASE_SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ReaderError('UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json。', 415);
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_JSON_BODY) {
    throw new ReaderError('BODY_TOO_LARGE', '请求内容过大。', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) {
      throw new ReaderError('BODY_TOO_LARGE', '请求内容过大。', 413);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ReaderError('INVALID_JSON', '请求内容不是有效的 JSON。', 400);
  }
}

function runNativePicker() {
  if (process.platform !== 'darwin') {
    throw new ReaderError('PICKER_UNSUPPORTED', '原生文件选择器仅支持 macOS。', 501);
  }
  const script = [
    'try',
    'set chosenFile to choose file with prompt "选择要阅读的 Markdown 或单文件 HTML 文档"',
    'return POSIX path of chosenFile',
    'on error number -128',
    'return "__MD_PICKER_CANCELLED__"',
    'end try',
  ];
  const args = script.flatMap((line) => ['-e', line]);

  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', args, {
      timeout: 180_000,
      maxBuffer: 16 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || error.signal) {
          reject(new ReaderError('PICKER_TIMEOUT', '文件选择器已超时。', 408));
          return;
        }
        if (String(stderr).includes('-128')) {
          reject(new ReaderError('PICKER_CANCELLED', '未选择文件。', 400));
          return;
        }
        reject(new ReaderError('PICKER_FAILED', '无法打开 macOS 文件选择器。', 500));
        return;
      }
      const picked = String(stdout).trim();
      if (!picked || picked === '__MD_PICKER_CANCELLED__') {
        reject(new ReaderError('PICKER_CANCELLED', '未选择文件。', 400));
        return;
      }
      resolve(picked);
    });
  });
}

export function createReaderServer(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT);
  const samplePath = options.samplePath
    ? path.resolve(options.samplePath)
    : path.join(rootDir, 'welcome.md');
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : POLL_MS;
  const indexTemplatePath = path.join(rootDir, 'public', 'index.html');
  const indexTemplate = fs.readFileSync(indexTemplatePath, 'utf8');
  const staticContents = new Map();
  for (const [route, meta] of STATIC_FILES) {
    const absolute = path.join(rootDir, 'public', meta.file);
    staticContents.set(route, {
      ...meta,
      body: fs.readFileSync(absolute),
    });
  }

  const sessions = new Map();
  // Capability -> one immutable HTML preview. A capability is never the generic
  // X-MD-Token; a sandboxed HTML document can read its own URL but can only use
  // it for this one session/document/revision.
  const previews = new Map();
  const shareHostOverride = typeof options.shareHost === 'string'
    ? options.shareHost.trim()
    : '';
  let pickerBusy = false;
  let lanShare = null;
  let server;
  let cleanupTimer;

  function expectedHosts() {
    const address = server?.address();
    const port = address && typeof address === 'object' ? address.port : DEFAULT_PORT;
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  }

  function expectedOrigins() {
    const address = server?.address();
    const port = address && typeof address === 'object' ? address.port : DEFAULT_PORT;
    return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  }

  function requestIsLocal(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!expectedHosts().has(host)) return false;
    // Opening the public shell from another app/site is a legitimate navigation.
    // No document is read until a token-authenticated same-origin API request.
    if (req.method === 'GET' && req.url === '/') return true;
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
    const origin = req.headers.origin;
    if (origin && !expectedOrigins().has(String(origin))) return false;
    return true;
  }

  function createSession() {
    if (sessions.size >= MAX_SESSIONS) {
      const evictable = [...sessions.values()]
        .filter((session) => session.sseClients.size === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (evictable) removeSession(evictable);
      else throw new ReaderError('SESSION_LIMIT', '打开的页面过多，请刷新后重试。', 503);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const session = {
      token,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      doc: null,
      snapshot: null,
      revision: 0,
      openingGeneration: 0,
      polling: false,
      pollTimer: null,
      missingStreak: 0,
      status: { key: 'idle', code: null, message: null, checkedAt: null },
      sseClients: new Set(),
      previewCapabilities: new Set(),
    };
    sessions.set(token, session);
    return session;
  }

  function stopPolling(session) {
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
  }

  function removeSession(session) {
    stopPolling(session);
    revokePreviewCapabilities(session, previews);
    for (const client of session.sseClients) {
      clearInterval(client.heartbeat);
      try {
        client.res.end();
      } catch {
        // Already closed.
      }
    }
    session.sseClients.clear();
    sessions.delete(session.token);
  }

  function broadcast(session, event, payload) {
    for (const client of [...session.sseClients]) {
      if (client.res.writableEnded || client.res.destroyed) {
        clearInterval(client.heartbeat);
        session.sseClients.delete(client);
        continue;
      }
      sseSend(client.res, event, payload);
    }
  }

  function setStatus(session, key, extra = {}) {
    const previous = session.status;
    const next = {
      key,
      code: extra.code || null,
      message: extra.message || null,
      checkedAt: extra.checkedAt || nowIso(),
    };
    session.status = next;
    return previous.key !== next.key
      || previous.code !== next.code
      || previous.message !== next.message;
  }

  async function pollSession(session) {
    if (!server || session.polling || !session.doc || !sessions.has(session.token)) return;
    session.polling = true;
    const activeDoc = session.doc;
    const generation = session.openingGeneration;
    try {
      const { buffer, stat } = await readDocFile(activeDoc);
      if (session.doc !== activeDoc || session.openingGeneration !== generation) return;
      session.missingStreak = 0;
      session.doc.stat = stat;
      const hash = sha256(buffer);

      if (!session.snapshot || hash !== session.snapshot.hash) {
        const snapshot = buildSnapshot(session, session.doc, buffer, 'synced', previews);
        session.snapshot = snapshot;
        setStatus(session, 'synced', { checkedAt: snapshot.checkedAt });
        broadcast(session, 'doc-changed', {
          doc: snapshot,
          status: publicStatus(session),
        });
      } else {
        const wasTrouble = session.status.key === 'missing' || session.status.key === 'error';
        const checkedAt = nowIso();
        session.snapshot.checkedAt = checkedAt;
        setStatus(session, 'synced', { checkedAt });
        if (wasTrouble) {
          broadcast(session, 'doc-recovered', {
            doc: session.snapshot,
            status: publicStatus(session),
          });
        }
      }
    } catch (error) {
      if (session.doc !== activeDoc || session.openingGeneration !== generation) return;
      if (error?.code === 'FILE_MISSING') {
        // An atomic replace can briefly unlink the path. Ignore one 500ms
        // miss, then surface a real missing-file state.
        session.missingStreak += 1;
        if (session.missingStreak >= 2) {
          const changed = setStatus(session, 'missing', {
            code: 'FILE_MISSING',
            message: '原文件已删除或移动，正在等待它恢复。',
          });
          if (changed || session.missingStreak === 2) {
            broadcast(session, 'doc-status', {
              status: publicStatus(session),
              path: session.doc.requestedPath,
            });
          }
        }
      } else {
        const code = error?.code || 'READ_FAILED';
        const message = error?.message || '读取原文件失败。';
        const changed = setStatus(session, 'error', { code, message });
        if (changed) {
          broadcast(session, 'doc-status', {
            status: publicStatus(session),
            path: session.doc.requestedPath,
          });
        }
      }
    } finally {
      session.polling = false;
    }
  }

  function ensurePolling(session) {
    if (session.pollTimer) return;
    session.pollTimer = setInterval(() => {
      pollSession(session).catch(() => {});
    }, pollMs);
    session.pollTimer.unref?.();
  }

  async function openDocument(session, requestedPath) {
    const generation = ++session.openingGeneration;
    const doc = inspectDocPath(requestedPath);
    const { buffer, stat } = await readDocFile(doc);
    doc.stat = stat;
    if (generation !== session.openingGeneration) {
      throw new ReaderError('OPEN_SUPERSEDED', '打开请求已被新的请求替代。', 409);
    }
    const snapshot = buildSnapshot(session, doc, buffer, 'synced', previews);

    stopPolling(session);
    session.doc = doc;
    session.snapshot = snapshot;
    session.missingStreak = 0;
    if (doc.kind === 'html') stopLanShare();
    setStatus(session, 'synced', { checkedAt: snapshot.checkedAt });
    session.lastUsed = Date.now();
    ensurePolling(session);
    return { doc: snapshot, status: publicStatus(session) };
  }

  function getSession(req, url, allowQueryToken) {
    let token = getHeaderToken(req);
    if (!token && allowQueryToken) {
      token = String(url.searchParams.get('token') || '');
    }
    if (!token) {
      throw new ReaderError('UNAUTHORIZED', '缺少会话令牌。', 401);
    }
    const session = sessions.get(token);
    if (!session) {
      throw new ReaderError('SESSION_EXPIRED', '页面会话已失效，请刷新页面。', 401);
    }
    session.lastUsed = Date.now();
    return session;
  }

  function handleSse(req, res, url) {
    const session = getSession(req, url, true);
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1200\n\n');

    const client = { res, heartbeat: null };
    session.sseClients.add(client);
    sseSend(res, 'hello', {
      doc: session.snapshot,
      status: publicStatus(session),
      path: session.doc?.requestedPath || null,
    });

    client.heartbeat = setInterval(() => {
      sseSend(res, 'ping', {
        status: publicStatus(session),
        revision: session.snapshot?.revision || null,
      });
    }, 10_000);
    client.heartbeat.unref?.();

    const close = () => {
      clearInterval(client.heartbeat);
      session.sseClients.delete(client);
    };
    req.on('close', close);
    res.on('close', close);
  }

  async function handleAsset(req, res, url) {
    const session = getSession(req, url, true);
    if (!session.doc) {
      throw new ReaderError('NO_DOCUMENT', '当前没有打开的文档。', 404);
    }
    const relative = String(url.searchParams.get('p') || '');
    if (!relative || relative.length > 2048) {
      throw new ReaderError('ASSET_PATH', '图片路径无效。', 400);
    }
    const asset = resolveImage(session.doc, relative);
    const etag = `"${Math.round(asset.mtimeMs)}-${asset.size}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        ...BASE_SECURITY_HEADERS,
        'Cache-Control': 'private, max-age=0, must-revalidate',
        ETag: etag,
      });
      res.end();
      return;
    }
    const body = await readAsset(asset);
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      'Content-Type': asset.mime,
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ETag: etag,
    });
    res.end(body);
  }

  function publicShare() {
    if (!lanShare) return null;
    return {
      active: true,
      name: lanShare.docName,
      path: lanShare.docPath,
      host: lanShare.host,
      port: lanShare.port,
      address: lanShare.server.shareAddress(),
      link: lanShare.server.shareLink(),
      createdAt: lanShare.createdAt,
      readOnly: true,
    };
  }

  function stopLanShare() {
    const current = lanShare;
    lanShare = null;
    if (!current) return;
    try {
      current.server.shareShutdown();
    } catch {
      // The share may already be closing.
    }
  }

  async function startLanShare(session) {
    if (!session.doc) {
      throw new ReaderError('NO_DOCUMENT', '请先打开一份文档，再开启 iPad 阅读。', 400);
    }
    if (session.doc.kind === 'html') {
      throw new ReaderError(
        'HTML_SHARE_UNSUPPORTED',
        '单文件 HTML 交互页不能通过本地 LAN 分享；请把它明确加入云端文库后在线打开。',
        415,
      );
    }

    const host = shareHostOverride || findLanAddress();
    if (!host) {
      throw new ReaderError(
        'LAN_UNAVAILABLE',
        '没有找到可用的局域网 IPv4 地址。请先连接 Wi-Fi 或以太网。',
        503,
      );
    }

    stopLanShare();

    let shareServer = null;
    try {
      shareServer = await createShareServer({
        rootDir,
        docPath: session.doc.requestedPath,
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          shareServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          shareServer.off('error', onError);
          resolve();
        };
        shareServer.once('error', onError);
        shareServer.once('listening', onListening);
        shareServer.listen(0, host);
      });
    } catch (error) {
      try {
        shareServer?.shareShutdown();
      } catch {
        // Nothing to clean up.
      }
      if (error instanceof ReaderError) throw error;
      if (error?.code === 'EADDRNOTAVAIL' || error?.code === 'ENETUNREACH') {
        throw new ReaderError('LAN_UNAVAILABLE', '局域网地址当前不可用，请检查 Wi-Fi 连接。', 503);
      }
      throw new ReaderError(
        'SHARE_START_FAILED',
        `无法开启局域网分享：${error?.message || '未知错误'}`,
        500,
      );
    }

    const address = shareServer.address();
    lanShare = {
      server: shareServer,
      host,
      port: address && typeof address === 'object' ? address.port : 0,
      docName: shareServer.shareDocName,
      docPath: session.doc.requestedPath,
      createdAt: nowIso(),
    };
    return publicShare();
  }

  function revokePreviewCapability(capability) {
    const preview = previews.get(capability);
    previews.delete(capability);
    if (preview) {
      const session = sessions.get(preview.sessionToken);
      session?.previewCapabilities.delete(capability);
    }
  }

  async function handleHtmlPreview(req, res, url) {
    const capability = String(url.searchParams.get('cap') || '');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(capability)) {
      throw new ReaderError('PREVIEW_UNAUTHORIZED', 'HTML 预览凭据无效。', 401);
    }
    const preview = previews.get(capability);
    if (!preview) {
      throw new ReaderError('PREVIEW_EXPIRED', 'HTML 预览凭据已失效，请重新打开这份文稿。', 410);
    }
    const session = sessions.get(preview.sessionToken);
    if (!session
      || Date.now() - preview.createdAt > SESSION_TTL_MS
      || !session.doc
      || session.doc.realPath !== preview.realPath
      || !session.snapshot
      || session.snapshot.revision !== preview.revision) {
      revokePreviewCapability(capability);
      throw new ReaderError('PREVIEW_EXPIRED', 'HTML 预览凭据已失效，请重新打开这份文稿。', 410);
    }

    const { buffer } = await readDocFile(session.doc);
    if (sha256(buffer) !== preview.hash) {
      // The document changed after this revision was issued. Do not serve a
      // newer body under an older capability; the poll builds a fresh one.
      revokePreviewCapability(capability);
      throw new ReaderError('PREVIEW_STALE', 'HTML 已更新，正在重新生成预览。', 410);
    }

    const body = Buffer.from(buffer.toString('utf8') + PREVIEW_READY_BRIDGE);
    res.writeHead(200, {
      ...HTML_PREVIEW_SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
    });
    res.end(body);
  }

  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    if (pathname === '/api/share') {
      if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        throw new ReaderError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
      }
      const session = getSession(req, url, false);
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, share: publicShare() });
        return;
      }
      await readJsonBody(req);
      const share = await startLanShare(session);
      sendJson(res, 200, { ok: true, share });
      return;
    }

    if (pathname === '/api/share/revoke' && req.method === 'POST') {
      getSession(req, url, false);
      await readJsonBody(req);
      stopLanShare();
      sendJson(res, 200, { ok: true, share: null });
      return;
    }

    if (pathname === '/api/open' && req.method === 'POST') {
      const session = getSession(req, url, false);
      const body = await readJsonBody(req);
      if (typeof body.path !== 'string') {
        throw new ReaderError('INVALID_PATH', '请提供文档的绝对路径。', 400);
      }
      const result = await openDocument(session, body.path);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      const session = getSession(req, url, false);
      sendJson(res, 200, {
        ok: true,
        doc: session.snapshot,
        status: publicStatus(session),
        path: session.doc?.requestedPath || null,
      });
      return;
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      handleSse(req, res, url);
      return;
    }

    if (pathname === '/api/html-preview' && req.method === 'GET') {
      await handleHtmlPreview(req, res, url);
      return;
    }

    if (pathname === '/api/asset' && req.method === 'GET') {
      await handleAsset(req, res, url);
      return;
    }

    if (pathname === '/api/pick' && req.method === 'POST') {
      getSession(req, url, false);
      await readJsonBody(req);
      if (pickerBusy) {
        throw new ReaderError('PICKER_BUSY', '文件选择器已经在等待选择。', 409);
      }
      pickerBusy = true;
      try {
        const picked = await runNativePicker();
        const doc = inspectDocPath(picked);
        sendJson(res, 200, { ok: true, path: doc.requestedPath });
      } finally {
        pickerBusy = false;
      }
      return;
    }

    if (['/api/open', '/api/pick', '/api/share/revoke'].includes(pathname) && req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw new ReaderError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
    }
    if (['/api/state', '/api/events', '/api/asset', '/api/html-preview'].includes(pathname) && req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new ReaderError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
    }
    throw new ReaderError('NOT_FOUND', '接口不存在。', 404);
  }

  async function handler(req, res) {
    try {
      if (!requestIsLocal(req)) {
        sendJson(res, 403, {
          ok: false,
          error: { code: 'CROSS_ORIGIN_BLOCKED', message: '已拒绝非本机同源请求。' },
        });
        return;
      }

      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        throw new ReaderError('BAD_REQUEST', '请求地址无效。', 400);
      }

      if (req.method === 'OPTIONS') {
        throw new ReaderError('CROSS_ORIGIN_BLOCKED', '不接受跨域预检请求。', 403);
      }

      if (url.pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, app: 'modu-reader', name: '墨读', version: '1.3.0' }, {
          'Cache-Control': 'no-store',
        });
        return;
      }

      if (url.pathname === '/') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          throw new ReaderError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
        }
        const session = createSession();
        const html = indexTemplate
          .replaceAll('__MD_TOKEN__', escapeAttribute(session.token))
          .replaceAll('__MD_SAMPLE_PATH__', escapeAttribute(samplePath));
        const body = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          ...BASE_SECURITY_HEADERS,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }

      if (STATIC_FILES.has(url.pathname)) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          throw new ReaderError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
        }
        const asset = staticContents.get(url.pathname);
        res.writeHead(200, {
          ...BASE_SECURITY_HEADERS,
          'Content-Type': asset.type,
          'Content-Length': asset.body.length,
          'Cache-Control': 'no-cache',
        });
        res.end(asset.body);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }

      sendText(res, 404, '未找到页面。');
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      sendError(res, error);
    }
  }

  server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, error);
      else if (!res.writableEnded) res.end();
    });
  });

  cleanupTimer = setInterval(() => {
    const threshold = Date.now() - SESSION_TTL_MS;
    for (const session of [...sessions.values()]) {
      if (session.sseClients.size === 0 && session.lastUsed < threshold) {
        removeSession(session);
      }
    }
  }, 60_000);
  cleanupTimer.unref?.();

  function shutdownConnections() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    stopLanShare();
    for (const session of [...sessions.values()]) removeSession(session);
    previews.clear();
    server.closeAllConnections?.();
  }

  server.on('close', () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    stopLanShare();
    for (const session of [...sessions.values()]) {
      stopPolling(session);
      for (const client of session.sseClients) {
        clearInterval(client.heartbeat);
        try {
          client.res.end();
        } catch {
          // Already closed.
        }
      }
    }
    sessions.clear();
    previews.clear();
  });

  server.readerShutdown = shutdownConnections;
  server.readerConfig = { rootDir, samplePath, pollMs, shareHost: shareHostOverride || null };
  return server;
}

export { DEFAULT_PORT, POLL_MS };
