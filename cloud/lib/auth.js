import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const DOC_ID_RE = /^[a-f0-9]{32}$/;
export const USER_ID_RE = /^[a-f0-9]{24}$/;
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const IMPORT_TOKEN_PREFIX = 'modu_import_';
// The user id is part of the token only so verification can find the one
// per-user hash file without scanning every account. The secret remains
// 256 bits of randomness and is never stored in clear text.
export const IMPORT_TOKEN_RE = /^modu_import_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/;

export class CloudError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashSyncToken(token) {
  return sha256(String(token));
}

export function hashImportToken(token) {
  return sha256(String(token));
}

export function makeImportToken(userId) {
  if (!USER_ID_RE.test(String(userId || ''))) {
    throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
  }
  return `${IMPORT_TOKEN_PREFIX}${userId}_${randomToken(32)}`;
}

export function importTokenUserId(token) {
  const match = IMPORT_TOKEN_RE.exec(String(token || ''));
  return match ? match[1] : '';
}

export function constantTimeEqual(a, b) {
  // Compare fixed-size digests so neither content nor length leaks through the
  // comparison itself.
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export function assertValidUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_RE.test(username)) {
    throw new CloudError(
      'INVALID_USERNAME',
      '用户名需为 2–64 位小写字母、数字、点、下划线或连字符。',
      400,
    );
  }
  return username;
}

export function assertValidPassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 256) {
    throw new CloudError('WEAK_PASSWORD', '密码长度需为 10–256 个字符。', 400);
  }
  return password;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(assertValidPassword(password), salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    algorithm: 'scrypt-n16384-r8-p1',
    salt: salt.toString('base64'),
    hash: Buffer.from(derived).toString('base64'),
  };
}

export async function verifyPassword(password, stored) {
  if (!stored || stored.algorithm !== 'scrypt-n16384-r8-p1') return false;
  const salt = Buffer.from(String(stored.salt || ''), 'base64');
  const expected = Buffer.from(String(stored.hash || ''), 'base64');
  if (salt.length !== 16 || expected.length !== 32) return false;
  const derived = await scrypt(String(password || ''), salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(Buffer.from(derived), expected);
}

export function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value; it will simply fail the session lookup.
    }
    cookies.set(name, value);
  }
  return cookies;
}

export const SESSION_COOKIE = 'modu_cloud_sid';
export const SESSION_COOKIE_SECURE = '__Host-modu_cloud_sid';

function cookieAttributes({ secure, maxAgeSeconds, httpOnly = true }) {
  return [
    'Path=/',
    httpOnly ? 'HttpOnly' : '',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].filter(Boolean).join('; ');
}

export function serializeSessionCookie(token, { secure, maxAgeSeconds }) {
  const name = secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
  return `${name}=${encodeURIComponent(token)}; ${cookieAttributes({ secure, maxAgeSeconds })}`;
}

export function serializeClearedSessionCookie({ secure }) {
  return `${secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE}=; ${cookieAttributes({
    secure,
    maxAgeSeconds: 0,
  })}`;
}

export function readSessionId(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies.get(SESSION_COOKIE_SECURE) || cookies.get(SESSION_COOKIE) || '';
}

export function requestIsHttps(req, { trustProxy = false } = {}) {
  if (req.socket?.encrypted) return true;
  if (!trustProxy) return false;
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

export function requestHost(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-host'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return String(req.headers.host || '').trim();
}

export function requestOrigin(req, options = {}) {
  const proto = requestIsHttps(req, options) ? 'https' : 'http';
  const host = requestHost(req, options);
  if (!host || !/^[a-zA-Z0-9.[\]:_-]+$/.test(host)) return '';
  return `${proto}://${host.toLowerCase()}`;
}

export function getClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded && forwarded.length <= 64 && /^[a-fA-F0-9.:]+$/.test(forwarded)) {
      return forwarded.toLowerCase();
    }
  }
  return String(req.socket?.remoteAddress || 'unknown');
}

/**
 * Reject browser mutations from another origin. Requests without an Origin
 * header (curl, the Mac sync client) are still required to carry the CSRF
 * header when they rely on a login cookie.
 */
export function assertSameOrigin(req, { publicOrigin = '', trustProxy = false } = {}) {
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw new CloudError('CROSS_SITE_BLOCKED', '已拒绝跨站请求。', 403);
  }
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (String(origin) === 'null') {
    throw new CloudError('ORIGIN_BLOCKED', '已拒绝空来源请求。', 403);
  }
  const expected = publicOrigin || requestOrigin(req, { trustProxy });
  if (!expected || String(origin).toLowerCase() !== expected.toLowerCase()) {
    throw new CloudError('ORIGIN_BLOCKED', '请求来源与站点不一致。', 403);
  }
}

export class RateLimiter {
  constructor({ limit, windowMs, maxKeys = 5000 }) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.windowMs = Math.max(1000, Number(windowMs) || 60_000);
    this.maxKeys = maxKeys;
    this.entries = new Map();
  }

  prune(now = Date.now()) {
    if (this.entries.size < this.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    if (this.entries.size >= this.maxKeys) {
      const oldest = [...this.entries.entries()]
        .sort((a, b) => a[1].resetAt - b[1].resetAt)
        .slice(0, Math.ceil(this.maxKeys * 0.2));
      for (const [key] of oldest) this.entries.delete(key);
    }
  }

  peek(key) {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      return { allowed: true, retryAfter: 0, remaining: this.limit };
    }
    if (entry.count >= this.limit) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
        remaining: 0,
      };
    }
    return { allowed: true, retryAfter: 0, remaining: this.limit - entry.count };
  }

  record(key) {
    const now = Date.now();
    this.prune(now);
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return entry;
  }

  hit(key) {
    const entry = this.record(key);
    const now = Date.now();
    if (entry.count > this.limit) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
        remaining: 0,
      };
    }
    return {
      allowed: true,
      retryAfter: 0,
      remaining: this.limit - entry.count,
    };
  }

  clear(key) {
    this.entries.delete(key);
  }
}
