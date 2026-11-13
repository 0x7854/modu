import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './markdown.js';
import {
  inspectDocPath,
  readDocFile,
  resolveImage,
  readAsset,
  ReaderError,
  sha256,
} from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const POLL_HINT_MS = 700;

const STATIC_FILES = new Map([
  ['/share.js', { file: 'share.js', type: 'text/javascript; charset=utf-8' }],
  ['/share.css', { file: 'share.css', type: 'text/css; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml; charset=utf-8' }],
]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
};

function nowIso() {
  return new Date().toISOString();
}

function getHeaderToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const headerToken = req.headers['x-md-token'];
  return typeof headerToken === 'string' ? headerToken.trim() : '';
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
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
    : new ReaderError('SHARE_INTERNAL', '共享服务内部错误。', 500);
  sendJson(res, readerError.status, {
    ok: false,
    error: {
      code: readerError.code,
      message: readerError.message,
    },
  });
}

function sendText(res, statusCode, text) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(text, 'utf8');
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function formatUrlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function isPrivateIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return parts[0] === 192 && parts[1] === 168;
}

/**
 * Pick one usable private IPv4 address for the local network. Wi-Fi/Ethernet
 * (`en*`) wins over VPN/utility interfaces so the link is the one an iPad can
 * reach. Public addresses are never used for the share listener.
 */
export function findLanAddress() {
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return null;
  }

  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const info of addresses || []) {
      if (info.internal) continue;
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (!info.address || !isPrivateIPv4(info.address)) continue;
      if (info.address.startsWith('169.254.')) continue;
      const preferred = /^en\d+$/.test(name) ? 0 : 1;
      candidates.push({ name, address: info.address, preferred });
    }
  }

  candidates.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred - b.preferred;
    return a.name.localeCompare(b.name);
  });
  return candidates[0]?.address || null;
}

/**
 * A read-only HTTP server for exactly one already-opened document. It has no
 * open/picker endpoints, no path input, and never returns an absolute path.
 * All document and asset access requires the random bearer token that lives in
 * the URL fragment on the Mac screen.
 */
export async function createShareServer(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT);
  const doc = inspectDocPath(options.docPath);
  const initial = await readDocFile(doc);
  doc.stat = initial.stat;

  const token = typeof options.token === 'string' && options.token.length >= 32
    ? options.token
    : crypto.randomBytes(32).toString('base64url');
  const pollHintMs = Number(options.pollHintMs) > 0 ? Number(options.pollHintMs) : POLL_HINT_MS;

  const indexShell = fs.readFileSync(path.join(rootDir, 'public', 'share.html'), 'utf8');
  const staticContents = new Map();
  for (const [route, meta] of STATIC_FILES) {
    staticContents.set(route, {
      ...meta,
      body: fs.readFileSync(path.join(rootDir, 'public', meta.file)),
    });
  }

  let revision = 0;
  let closed = false;
  let missingStreak = 0;
  let refreshPromise = null;
  let boundHost = '';
  let boundPort = 0;
  let server;

  function buildSnapshot(buffer, stat) {
    let rendered;
    try {
      rendered = renderMarkdown(buffer.toString('utf8'), doc, token, { assetMode: 'lan' });
    } catch (error) {
      if (error instanceof ReaderError) throw error;
      throw new ReaderError('RENDER_FAILED', 'Markdown 渲染失败。', 422);
    }
    revision += 1;
    return {
      name: doc.name,
      size: Buffer.byteLength(buffer),
      mtimeMs: stat.mtimeMs,
      hash: sha256(buffer),
      revision,
      checkedAt: nowIso(),
      html: rendered.html,
      headings: rendered.headings,
      readOnly: true,
    };
  }

  let snapshot = buildSnapshot(initial.buffer, initial.stat);
  let status = {
    key: 'synced',
    code: null,
    message: null,
    checkedAt: snapshot.checkedAt,
  };

  function setStatus(key, extra = {}) {
    status = {
      key,
      code: extra.code || null,
      message: extra.message || null,
      checkedAt: extra.checkedAt || nowIso(),
    };
  }

  function publicStatus() {
    return { ...status };
  }

  async function refresh() {
    if (closed) return;
    try {
      const { buffer, stat } = await readDocFile(doc);
      doc.stat = stat;
      missingStreak = 0;
      const hash = sha256(buffer);
      const checkedAt = nowIso();
      if (hash !== snapshot.hash) {
        snapshot = buildSnapshot(buffer, stat);
        setStatus('synced', { checkedAt: snapshot.checkedAt });
      } else {
        snapshot.checkedAt = checkedAt;
        snapshot.mtimeMs = stat.mtimeMs;
        setStatus('synced', { checkedAt });
      }
    } catch (error) {
      if (error?.code === 'FILE_MISSING') {
        // Let one poll tolerate an atomic-save gap before reporting missing.
        missingStreak += 1;
        if (missingStreak >= 2) {
          setStatus('missing', {
            code: 'FILE_MISSING',
            message: '原文件已删除或移动，正在等待它恢复。',
          });
        } else if (status.key === 'synced') {
          status = { ...status, checkedAt: nowIso() };
        }
        return;
      }
      const code = error?.code || 'READ_FAILED';
      const message = error?.message || '读取原文件失败。';
      setStatus('error', { code, message });
    }
  }

  function ensureFresh() {
    if (!refreshPromise) {
      refreshPromise = refresh().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string' || candidate.length !== token.length) return false;
    const provided = Buffer.from(candidate, 'utf8');
    const expected = Buffer.from(token, 'utf8');
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }

  function requireToken(req) {
    if (!tokenMatches(getHeaderToken(req))) {
      throw new ReaderError(
        'SHARE_UNAUTHORIZED',
        '分享链接已失效或已撤销，请在 Mac 上重新分享。',
        401,
      );
    }
  }

  function allowedHosts() {
    const hosts = new Set();
    if (boundHost && boundPort) {
      hosts.add(`${formatUrlHost(boundHost).toLowerCase()}:${boundPort}`);
    }
    return hosts;
  }

  function allowedOrigins() {
    const origins = new Set();
    if (boundHost && boundPort) {
      origins.add(`http://${formatUrlHost(boundHost).toLowerCase()}:${boundPort}`);
    }
    return origins;
  }

  function requestIsAllowed(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts().has(host)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (String(origin) === 'null') return false;
      if (!allowedOrigins().has(String(origin).toLowerCase())) return false;
    }
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      return false;
    }
    return true;
  }

  async function handleAsset(req, res, url) {
    const relative = String(url.searchParams.get('p') || '');
    if (!relative || relative.length > 2048 || relative.includes('\0')) {
      throw new ReaderError('ASSET_PATH', '图片路径无效。', 400);
    }
    const asset = resolveImage(doc, relative);
    const etag = `"${Math.round(asset.mtimeMs)}-${asset.size}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        ...SECURITY_HEADERS,
        'Cache-Control': 'private, max-age=0, must-revalidate',
        ETag: etag,
      });
      res.end();
      return;
    }
    const body = await readAsset(asset);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': asset.mime,
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ETag: etag,
    });
    res.end(body);
  }

  async function handler(req, res) {
    try {
      if (!requestIsAllowed(req)) {
        sendJson(res, 403, {
          ok: false,
          error: { code: 'CROSS_ORIGIN_BLOCKED', message: '已拒绝非分享地址或跨站请求。' },
        });
        return;
      }

      let url;
      try {
        url = new URL(req.url || '/', 'http://share.invalid');
      } catch {
        throw new ReaderError('BAD_REQUEST', '请求地址无效。', 400);
      }

      if (req.method === 'OPTIONS') {
        throw new ReaderError('CROSS_ORIGIN_BLOCKED', '不接受跨域预检请求。', 403);
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          throw new ReaderError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
        }
        const body = Buffer.from(indexShell, 'utf8');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
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
          ...SECURITY_HEADERS,
          'Content-Type': asset.type,
          'Content-Length': asset.body.length,
          'Cache-Control': 'no-cache',
        });
        res.end(asset.body);
        return;
      }

      if (url.pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, share: true });
        return;
      }

      if (url.pathname === '/api/share/state') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          throw new ReaderError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
        }
        requireToken(req);
        await ensureFresh();
        sendJson(res, 200, {
          ok: true,
          doc: snapshot,
          status: publicStatus(),
          pollMs: pollHintMs,
          serverTime: nowIso(),
        });
        return;
      }

      if (url.pathname === '/api/share/asset') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          throw new ReaderError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
        }
        requireToken(req);
        await handleAsset(req, res, url);
        return;
      }

      // There is deliberately no /api/open, /api/pick, filesystem listing, or
      // generic static-file route on the LAN server.
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

  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      boundHost = address.address;
      boundPort = address.port;
    }
  });

  function shutdown() {
    if (closed) return;
    closed = true;
    refreshPromise = null;
    try {
      server.closeAllConnections?.();
    } catch {
      // Already gone.
    }
    try {
      server.close(() => {});
    } catch {
      // Already closed.
    }
  }

  server.on('close', () => {
    closed = true;
    try {
      server.closeAllConnections?.();
    } catch {
      // Already gone.
    }
  });

  server.shareShutdown = shutdown;
  server.shareToken = token;
  server.shareDocName = doc.name;
  server.sharePollHintMs = pollHintMs;
  server.shareLink = () => {
    if (!boundHost || !boundPort) return null;
    return `http://${formatUrlHost(boundHost)}:${boundPort}/#t=${encodeURIComponent(token)}`;
  };
  server.shareAddress = () => {
    if (!boundHost || !boundPort) return null;
    return `http://${formatUrlHost(boundHost)}:${boundPort}/`;
  };
  return server;
}

export { POLL_HINT_MS };
