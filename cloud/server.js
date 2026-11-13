#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CloudStore } from './lib/store.js';
import {
  CloudError,
  DOC_ID_RE,
  RateLimiter,
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
  assertSameOrigin,
  constantTimeEqual,
  getClientIp,
  nowIso,
  randomToken,
  readSessionId,
  requestIsHttps,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from './lib/auth.js';

const PREVIEW_READY_BRIDGE = "\n<script>(()=>{const ready=()=>parent.postMessage({type:'modu-preview-ready'},'*');if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready()})();</script>";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = 4680;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024;
const LOGIN_BODY_BYTES = 8 * 1024;
const MAX_SESSIONS = 2000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const STATIC_FILES = new Map([
  ['/cloud.css', { file: 'cloud.css', type: 'text/css; charset=utf-8', cache: 'public, max-age=300' }],
  ['/cloud.js', { file: 'cloud.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=300' }],
  ['/manifest.webmanifest', {
    file: 'manifest.webmanifest',
    type: 'application/manifest+json; charset=utf-8',
    cache: 'public, max-age=3600',
  }],
  ['/sw.js', { file: 'sw.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' }],
  ['/favicon.svg', {
    file: 'icons/favicon.svg',
    type: 'image/svg+xml; charset=utf-8',
    cache: 'public, max-age=604800',
  }],
  ['/vendor/markdown-it.min.js', {
    file: 'vendor/markdown-it.min.js',
    type: 'text/javascript; charset=utf-8',
    cache: 'public, max-age=31536000, immutable',
  }],
  ['/vendor/purify.min.js', {
    file: 'vendor/purify.min.js',
    type: 'text/javascript; charset=utf-8',
    cache: 'public, max-age=31536000, immutable',
  }],
  ['/icons/icon-192.png', {
    file: 'icons/icon-192.png',
    type: 'image/png',
    cache: 'public, max-age=604800',
  }],
  ['/icons/icon-512.png', {
    file: 'icons/icon-512.png',
    type: 'image/png',
    cache: 'public, max-age=604800',
  }],
  ['/icons/apple-touch-icon.png', {
    file: 'icons/apple-touch-icon.png',
    type: 'image/png',
    cache: 'public, max-age=604800',
  }],
  ['/icons/maskable-512.png', {
    file: 'icons/maskable-512.png',
    type: 'image/png',
    cache: 'public, max-age=604800',
  }],
]);

function securityHeaders({ secure = false } = {}) {
  return {
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
      "manifest-src 'self'",
      "worker-src 'self'",
      "frame-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

/**
 * The preview document is deliberately its own security context:
 * - HTTP `sandbox allow-scripts` forces an opaque origin even when the URL is
 *   opened directly, so it cannot read the cloud session cookie or storage.
 * - No parent IPC, cookie, same-origin script or network destination is allowed.
 * - `frame-ancestors 'self'` lets the authenticated library frame it while
 *   preventing third-party embedding of a captured preview URL.
 * - `navigate-to` is CSP3 and ignored by WebKit today; Electron additionally
 *   cancels subframe navigation away from this endpoint.
 */
function previewSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), fullscreen=()',
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
}

function previewUrlFor(doc) {
  return `/api/documents/${doc.id}/preview?v=${encodeURIComponent(doc.revision)}`;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, error) {
  const cloudError = error instanceof CloudError
    ? error
    : new CloudError('INTERNAL_ERROR', '服务内部错误。', 500);
  if (!(error instanceof CloudError) && process.env.MODU_DEBUG === '1') {
    console.error('[modu-cloud]', error);
  }
  sendJson(res, cloudError.status, {
    ok: false,
    error: {
      code: cloudError.code,
      message: cloudError.message,
    },
  }, cloudError.extra?.headers || {});
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  throw new CloudError('METHOD_NOT_ALLOWED', '请求方法不允许。', 405);
}

async function readBody(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new CloudError('UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json。', 415);
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CloudError('BODY_TOO_LARGE', '请求内容过大。', 413);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new CloudError('BODY_TOO_LARGE', '请求内容过大。', 413);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CloudError('INVALID_JSON', '请求内容不是有效的 JSON。', 400);
  }
}

function parseBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function normalizePathname(raw) {
  try {
    return new URL(raw || '/', 'http://cloud.invalid').pathname;
  } catch {
    throw new CloudError('BAD_REQUEST', '请求地址无效。', 400);
  }
}

export async function createCloudServer(options = {}) {
  const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
  const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const maxDocBytes = Number(options.maxDocBytes) > 0
    ? Math.min(10 * 1024 * 1024, Number(options.maxDocBytes))
    : DEFAULT_MAX_DOC_BYTES;
  const sessionTtlMs = Number(options.sessionTtlMs) > 0
    ? Math.max(60_000, Number(options.sessionTtlMs))
    : SESSION_TTL_MS;
  const trustProxy = options.trustProxy === true;
  const publicOrigin = (() => {
    const raw = String(options.publicOrigin || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('MODU_PUBLIC_ORIGIN 不是有效 URL。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('MODU_PUBLIC_ORIGIN 只支持 http/https。');
    }
    return parsed.origin;
  })();
  const secureCookieMode = ['auto', 'always', 'never'].includes(options.secureCookies)
    ? options.secureCookies
    : 'auto';
  const pollMs = Number(options.pollMs) > 0 ? Math.max(1000, Number(options.pollMs)) : 5000;
  const loginLimiter = new RateLimiter({
    limit: Number(options.loginMaxAttempts) > 0 ? Number(options.loginMaxAttempts) : 5,
    windowMs: Number(options.loginWindowMs) > 0
      ? Number(options.loginWindowMs)
      : 15 * 60 * 1000,
  });
  const apiLimiter = new RateLimiter({
    limit: Number(options.apiMaxRequests) > 0 ? Number(options.apiMaxRequests) : 600,
    windowMs: 60_000,
  });
  const uploadLimiter = new RateLimiter({
    limit: Number(options.uploadMaxRequests) > 0 ? Number(options.uploadMaxRequests) : 60,
    windowMs: 60_000,
  });

  const store = await new CloudStore(dataDir, { maxDocBytes }).init();
  const indexTemplate = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const staticContents = new Map();
  for (const [route, meta] of STATIC_FILES) {
    staticContents.set(route, {
      ...meta,
      body: fs.readFileSync(path.join(publicDir, meta.file)),
    });
  }

  const sessions = new Map();
  let server;
  let cleanupTimer;

  function cookieShouldBeSecure(req) {
    if (secureCookieMode === 'always') return true;
    if (secureCookieMode === 'never') return false;
    return requestIsHttps(req, { trustProxy }) || publicOrigin.startsWith('https://');
  }

  function pruneSessions() {
    const now = Date.now();
    for (const [sid, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(sid);
    }
    while (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
    }
  }

  function createSession(user, req) {
    pruneSessions();
    if (sessions.size >= MAX_SESSIONS) {
      throw new CloudError('SESSION_LIMIT', '登录会话过多，请稍后再试。', 503);
    }
    const sid = randomToken(32);
    const session = {
      sid,
      user,
      csrfToken: randomToken(32),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      expiresAt: Date.now() + sessionTtlMs,
      secureCookie: cookieShouldBeSecure(req),
    };
    sessions.set(sid, session);
    return session;
  }

  async function authenticate(req) {
    const sid = readSessionId(req);
    if (!sid) throw new CloudError('AUTH_REQUIRED', '请先登录。', 401);
    const session = sessions.get(sid);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) sessions.delete(sid);
      throw new CloudError('SESSION_EXPIRED', '登录已过期，请重新登录。', 401);
    }
    // Do not trust the user snapshot cached in the session. A password reset
    // rotates authVersion and must revoke every older session immediately.
    const currentUser = await store.getUser(session.user.id, { fresh: true });
    if (!currentUser || currentUser.authVersion !== session.user.authVersion) {
      sessions.delete(sid);
      throw new CloudError('SESSION_REVOKED', '登录已失效，请重新登录。', 401);
    }
    session.user = currentUser;
    session.lastSeen = Date.now();
    return session;
  }

  function requireCsrf(req, session) {
    const provided = String(req.headers['x-csrf-token'] || '');
    if (!provided || !constantTimeEqual(provided, session.csrfToken)) {
      throw new CloudError('CSRF_REQUIRED', '缺少或错误的 CSRF 令牌，请刷新页面重试。', 403);
    }
  }

  function checkApiRate(req) {
    const ip = getClientIp(req, { trustProxy });
    const result = apiLimiter.hit(ip);
    if (!result.allowed) {
      throw new CloudError('RATE_LIMITED', '请求过于频繁，请稍后再试。', 429, {
        headers: { 'Retry-After': String(result.retryAfter) },
      });
    }
  }

  async function handleLogin(req, res) {
    assertSameOrigin(req, { publicOrigin, trustProxy });
    const ip = getClientIp(req, { trustProxy });
    const precheck = loginLimiter.peek(ip);
    if (!precheck.allowed) {
      throw new CloudError('LOGIN_RATE_LIMITED', '登录尝试过多，请稍后再试。', 429, {
        headers: { 'Retry-After': String(precheck.retryAfter) },
      });
    }
    const body = await readBody(req, LOGIN_BODY_BYTES);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = await store.verifyLogin(username, password);
    if (!user) {
      loginLimiter.record(ip);
      throw new CloudError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401);
    }
    loginLimiter.clear(ip);

    const oldSid = readSessionId(req);
    if (oldSid) sessions.delete(oldSid);
    const session = createSession(user, req);
    const maxAge = Math.floor(sessionTtlMs / 1000);
    sendJson(res, 200, {
      ok: true,
      user: { id: user.id, username: user.username },
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    }, {
      'Set-Cookie': serializeSessionCookie(session.sid, {
        secure: session.secureCookie,
        maxAgeSeconds: maxAge,
      }),
    });
  }

  function handleLogout(req, res, session) {
    assertSameOrigin(req, { publicOrigin, trustProxy });
    requireCsrf(req, session);
    sessions.delete(session.sid);
    sendJson(res, 200, { ok: true }, {
      'Set-Cookie': serializeClearedSessionCookie({ secure: session.secureCookie }),
    });
  }

  function documentSummary(doc) {
    return {
      id: doc.id,
      name: doc.name,
      kind: doc.kind === 'html' ? 'html' : 'markdown',
      revision: doc.revision,
      size: doc.size,
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * HTML bodies never travel in bootstrap/list/get JSON. The browser receives a
   * metadata record and an authenticated preview URL for a single sandboxed
   * iframe navigation, avoiding a second copy of the source and keeping the raw
   * document out of the parent DOM.
   */
  function documentPayload(doc) {
    const base = {
      id: doc.id,
      name: doc.name,
      kind: doc.kind === 'html' ? 'html' : 'markdown',
      revision: doc.revision,
      size: doc.size,
      updatedAt: doc.updatedAt,
      position: doc.position || null,
    };
    if (base.kind === 'html') return { ...base, previewUrl: previewUrlFor(doc) };
    return { ...base, markdown: doc.markdown };
  }

  async function handleSync(req, res, pathname) {
    const token = parseBearer(req);
    if (!token) {
      throw new CloudError('SYNC_UNAUTHORIZED', '缺少同步令牌。', 401);
    }
    const user = await store.findBySyncToken(token);
    if (!user) {
      throw new CloudError('SYNC_UNAUTHORIZED', '同步令牌无效。', 401);
    }

    if (pathname === '/api/sync/ping' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        user: { id: user.id, username: user.username },
        documentCount: await store.countDocuments(user.id),
        maxDocBytes,
        serverTime: nowIso(),
      });
      return;
    }

    if (pathname === '/api/sync/documents' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        documents: await store.listDocuments(user.id),
        maxDocBytes,
      });
      return;
    }

    if (pathname === '/api/sync/library') {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          library: await store.getLibrary(user.id),
          documents: await store.listDocuments(user.id),
        });
        return;
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req, MAX_JSON_BYTES);
        // Read the independent document list before mutating so a list failure
        // cannot leave a committed change behind an error response.
        const documents = await store.listDocuments(user.id);
        const library = await store.mutateLibrary(user.id, body);
        sendJson(res, 200, { ok: true, library, documents });
        return;
      }
      methodNotAllowed(res, 'GET, PATCH');
    }

    const match = pathname.match(/^\/api\/sync\/documents\/([a-f0-9]{32})$/);
    if (match && req.method === 'PUT') {
      const result = uploadLimiter.hit(user.id);
      if (!result.allowed) {
        throw new CloudError('RATE_LIMITED', '同步上传过于频繁，请稍后再试。', 429, {
          headers: { 'Retry-After': String(result.retryAfter) },
        });
      }
      const body = await readBody(req, maxDocBytes + 32 * 1024);
      const saved = await store.upsertDocument(user.id, match[1], {
        name: body.name,
        kind: body.kind,
        markdown: body.markdown,
        content: body.content,
      });
      sendJson(res, 200, { ok: true, ...saved });
      return;
    }

    if (/^\/api\/sync\/documents\/[a-f0-9]{32}$/.test(pathname)) {
      methodNotAllowed(res, 'PUT');
    }
    throw new CloudError('NOT_FOUND', '同步接口不存在。', 404);
  }

  async function handleApi(req, res, pathname) {
    checkApiRate(req);
    if (req.method === 'OPTIONS') {
      throw new CloudError('CROSS_SITE_BLOCKED', '不接受跨域预检请求。', 403);
    }
    assertSameOrigin(req, { publicOrigin, trustProxy });

    if (pathname === '/api/login') {
      if (req.method !== 'POST') methodNotAllowed(res, 'POST');
      await handleLogin(req, res);
      return;
    }

    if (pathname.startsWith('/api/sync/')) {
      if (!['GET', 'PUT', 'PATCH'].includes(req.method)) methodNotAllowed(res, 'GET, PUT, PATCH');
      await handleSync(req, res, pathname);
      return;
    }

    if (pathname === '/api/logout') {
      if (req.method !== 'POST') methodNotAllowed(res, 'POST');
      const session = await authenticate(req);
      handleLogout(req, res, session);
      return;
    }

    // Authenticate once and return the first screen in one network round trip.
    // Only the authenticated user's list may select a document; never use a
    // caller-provided ID directly to read another account's store.
    if (pathname === '/api/bootstrap') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      const session = await authenticate(req);
      const documents = await store.listDocuments(session.user.id);
      const preferred = new URL(req.url, 'http://localhost').searchParams.get('doc');
      const candidate = documents.find((entry) => entry.id === preferred) || documents[0];
      let firstDoc = null;
      if (candidate) {
        const doc = await store.getDocument(session.user.id, candidate.id);
        firstDoc = documentPayload(doc);
      }
      sendJson(res, 200, {
        ok: true,
        user: { id: session.user.id, username: session.user.username },
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAt).toISOString(),
        documents, doc: firstDoc, maxDocBytes,
        library: await store.getLibrary(session.user.id),
      });
      return;
    }

    if (pathname === '/api/session') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      const session = await authenticate(req);
      sendJson(res, 200, {
        ok: true,
        user: { id: session.user.id, username: session.user.username },
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
      return;
    }

    if (pathname === '/api/documents') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      const session = await authenticate(req);
      sendJson(res, 200, {
        ok: true,
        documents: await store.listDocuments(session.user.id),
        maxDocBytes,
        library: await store.getLibrary(session.user.id),
      });
      return;
    }

    if (pathname === '/api/library') {
      if (!['GET', 'PATCH'].includes(req.method)) methodNotAllowed(res, 'GET, PATCH');
      const session = await authenticate(req);
      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          library: await store.getLibrary(session.user.id),
          documents: await store.listDocuments(session.user.id),
        });
        return;
      }
      requireCsrf(req, session);
      const body = await readBody(req, MAX_JSON_BYTES);
      const documents = await store.listDocuments(session.user.id);
      const library = await store.mutateLibrary(session.user.id, body);
      sendJson(res, 200, { ok: true, library, documents });
      return;
    }

    const previewMatch = pathname.match(/^\/api\/documents\/([a-f0-9]{32})\/preview$/);
    if (previewMatch) {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      const session = await authenticate(req);
      const doc = await store.getDocument(session.user.id, previewMatch[1]);
      if (doc.kind !== 'html') {
        throw new CloudError('NOT_HTML', '这份文稿不是 HTML 交互页。', 404);
      }
      const body = Buffer.from(doc.html + PREVIEW_READY_BRIDGE, 'utf8');
      res.writeHead(200, {
        ...previewSecurityHeaders(),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
      });
      res.end(body);
      return;
    }

    const positionMatch = pathname.match(/^\/api\/documents\/([a-f0-9]{32})\/position$/);
    if (positionMatch) {
      if (req.method !== 'PUT') methodNotAllowed(res, 'PUT');
      const session = await authenticate(req);
      requireCsrf(req, session);
      const body = await readBody(req, MAX_JSON_BYTES);
      const position = await store.updatePosition(session.user.id, positionMatch[1], body);
      sendJson(res, 200, { ok: true, position });
      return;
    }

    const docMatch = pathname.match(/^\/api\/documents\/([a-f0-9]{32})$/);
    if (docMatch) {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      const session = await authenticate(req);
      const doc = await store.getDocument(session.user.id, docMatch[1]);
      const etag = `"rev-${doc.revision}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, {
          ...securityHeaders({ secure: requestIsHttps(req, { trustProxy }) }),
          'Cache-Control': 'no-store',
          ETag: etag,
        });
        res.end();
        return;
      }
      sendJson(res, 200, {
        ok: true,
        doc: documentPayload(doc),
      }, { ETag: etag });
      return;
    }

    if (pathname.startsWith('/api/documents/')) {
      throw new CloudError('INVALID_DOCUMENT_ID', '文档标识无效。', 400);
    }

    throw new CloudError('NOT_FOUND', '接口不存在。', 404);
  }

  async function handler(req, res) {
    try {
      const pathname = normalizePathname(req.url);
      const secure = requestIsHttps(req, { trustProxy }) || publicOrigin.startsWith('https://');

      if (pathname === '/healthz') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        sendJson(res, 200, {
          ok: true,
          service: 'modu-cloud',
          version: '1.3.0',
          time: nowIso(),
        });
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        const html = indexTemplate
          .replaceAll('__MODU_POLL_MS__', String(pollMs))
          .replaceAll('__MODU_VERSION__', '1.3.0');
        const body = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          ...securityHeaders({ secure }),
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-cache',
        });
        res.end(body);
        return;
      }

      if (STATIC_FILES.has(pathname)) {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        const asset = staticContents.get(pathname);
        res.writeHead(200, {
          ...securityHeaders({ secure }),
          'Content-Type': asset.type,
          'Content-Length': asset.body.length,
          'Cache-Control': asset.cache,
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(asset.body);
        return;
      }

      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
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

  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 20_000;

  cleanupTimer = setInterval(pruneSessions, 60_000);
  cleanupTimer.unref?.();

  function shutdown() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    sessions.clear();
    try {
      server.closeAllConnections?.();
    } catch {
      // Already closing.
    }
    try {
      server.close(() => {});
    } catch {
      // Already closed.
    }
  }

  server.on('close', () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    sessions.clear();
  });

  server.cloudShutdown = shutdown;
  server.cloudConfig = {
    dataDir,
    publicDir,
    maxDocBytes,
    pollMs,
    trustProxy,
    publicOrigin: publicOrigin || null,
    secureCookieMode,
  };
  return server;
}

export async function startCloudServerFromEnv(env = process.env) {
  const port = Number(env.MODU_CLOUD_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MODU_CLOUD_PORT 无效。');
  }
  const host = String(env.MODU_CLOUD_HOST || DEFAULT_HOST);
  const dataDir = path.resolve(env.MODU_CLOUD_DATA || path.join(process.cwd(), 'data'));
  const maxDocBytes = Number(env.MODU_MAX_DOC_BYTES || DEFAULT_MAX_DOC_BYTES);
  const server = await createCloudServer({
    dataDir,
    maxDocBytes,
    trustProxy: env.MODU_TRUST_PROXY === '1',
    publicOrigin: env.MODU_PUBLIC_ORIGIN || '',
    secureCookies: env.MODU_COOKIE_SECURE || 'auto',
    sessionTtlMs: Number(env.MODU_SESSION_TTL_HOURS || 168) * 60 * 60 * 1000,
    pollMs: Number(env.MODU_POLL_MS || 5000),
    loginMaxAttempts: Number(env.MODU_LOGIN_MAX_ATTEMPTS || 5),
    loginWindowMs: Number(env.MODU_LOGIN_WINDOW_MINUTES || 15) * 60 * 1000,
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  console.log(`墨读云文档库：http://${host}:${actualPort}`);
  console.log(`数据目录：${dataDir}`);
  console.log('阅读登录与 Mac 同步令牌分离；不要把令牌写入源码或提交到仓库。');
  return server;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  let server = null;
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在停止墨读云文档库…`);
    server?.cloudShutdown();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  startCloudServerFromEnv().then((created) => {
    server = created;
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  }).catch((error) => {
    console.error(`墨读云文档库启动失败：${error.message}`);
    process.exit(1);
  });
}

export { DEFAULT_PORT, DEFAULT_HOST, DEFAULT_MAX_DOC_BYTES };
