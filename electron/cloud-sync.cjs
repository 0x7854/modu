'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const CONFIG_FILE = 'cloud-sync.json';
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);
const DEBOUNCE_MS = 1200;

function kindForPath(filePath) {
  return /\.(?:html?)$/i.test(path.extname(String(filePath || ''))) ? 'html' : 'markdown';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function documentIdForPath(filePath) {
  return sha256(path.resolve(filePath)).slice(0, 32);
}

function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Credentials may travel over TLS anywhere. Plain HTTP is accepted only for a
 * loopback test server; a public HTTP URL would leak the sync token in transit.
 */
function normalizeServerUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('请填写云服务地址。');
  if (value.length > 2048) throw new Error('云服务地址过长。');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('云服务地址不是有效 URL。');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('云服务地址只支持 HTTPS。');
  }
  if (url.username || url.password) {
    throw new Error('云服务地址不能包含用户名或密码。');
  }
  if (url.search || url.hash) {
    throw new Error('云服务地址不能包含查询参数或片段。');
  }
  if (url.protocol === 'http:' && !isLocalHostname(url.hostname)) {
    throw new Error('公网地址必须使用 HTTPS；明文 HTTP 只允许 localhost 测试。');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

function validateSyncToken(raw) {
  const token = String(raw || '').trim();
  if (token.length < 20 || token.length > 512) {
    throw new Error('同步令牌长度不正确。');
  }
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    throw new Error('同步令牌格式不正确。');
  }
  return token;
}

function normalizeDocumentPath(rawPath) {
  if (typeof rawPath !== 'string') throw new Error('文件路径无效。');
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) {
    throw new Error('文件路径无效。');
  }
  if (!path.isAbsolute(trimmed)) throw new Error('请使用绝对文件路径。');
  if (!DOC_EXTENSIONS.has(path.extname(trimmed).toLowerCase())) {
    throw new Error('只支持主动加入 .md、.markdown、.html 或 .htm 文件。');
  }
  return path.normalize(trimmed);
}

async function readDocumentFile(filePath, maxBytes = MAX_DOC_BYTES) {
  let handle;
  try {
    const stat = await fsp.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error('不读取符号链接文件。');
    if (!stat.isFile()) throw new Error('这个路径不是普通文件。');
    if (stat.size > maxBytes) {
      throw new Error(`文档超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`);
    }
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error('这个路径不是普通文件。');
    if (openedStat.size > maxBytes) {
      throw new Error(`文档超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`);
    }
    const buffer = await handle.readFile();
    if (buffer.length > maxBytes) {
      throw new Error(`文档超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`);
    }
    return {
      buffer,
      text: buffer.toString('utf8'),
      name: path.basename(filePath),
      kind: kindForPath(filePath),
      hash: sha256(buffer),
      size: buffer.length,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('文件不存在或已被移动。');
    if (error?.code === 'ELOOP') throw new Error('不读取符号链接文件。');
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

function cleanError(message) {
  return String(message || '同步失败。')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}

/* ------------------------------------------------------ cloud library API */

const LIBRARY_ACTIONS = new Set([
  'createFolder',
  'renameFolder',
  'moveFolder',
  'deleteFolder',
  'moveDocument',
]);

class CloudLibraryError extends Error {
  constructor(message, { code = 'LIBRARY_REQUEST_FAILED', status = 0 } = {}) {
    super(cleanError(message));
    this.name = 'CloudLibraryError';
    this.code = String(code || 'LIBRARY_REQUEST_FAILED');
    this.status = Number(status) || 0;
  }
}

function libraryId(value, field) {
  if (typeof value !== 'string') throw new CloudLibraryError(`${field} 无效。`, { code: 'INVALID_LIBRARY_REQUEST', status: 400 });
  const id = value.trim();
  if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new CloudLibraryError(`${field} 无效。`, { code: 'INVALID_LIBRARY_REQUEST', status: 400 });
  }
  return id;
}

function libraryParentId(value) {
  if (value === null || value === undefined || value === '') return null;
  return libraryId(value, 'parentId');
}

function libraryFolderName(value) {
  if (typeof value !== 'string') throw new CloudLibraryError('文件夹名称无效。', { code: 'INVALID_LIBRARY_REQUEST', status: 400 });
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 80) {
    throw new CloudLibraryError('文件夹名称需要 1 到 80 个字符。', { code: 'INVALID_LIBRARY_REQUEST', status: 400 });
  }
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) {
    throw new CloudLibraryError('文件夹名称不能包含斜杠或控制字符。', { code: 'INVALID_LIBRARY_REQUEST', status: 400 });
  }
  return name;
}

/**
 * The renderer only ever supplies a library action. Rebuild a narrow payload so
 * no arbitrary URL, method or extra field can travel through the main process.
 */
function normalizeLibraryMutation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CloudLibraryError('文件夹操作无效。', { code: 'INVALID_LIBRARY_REQUEST', status: 400 });
  }
  const revision = Number(payload.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new CloudLibraryError('文库版本无效。', { code: 'INVALID_LIBRARY_REQUEST', status: 400 });
  }
  const action = String(payload.action || '');
  if (!LIBRARY_ACTIONS.has(action)) {
    throw new CloudLibraryError('不支持的文件夹操作。', { code: 'INVALID_LIBRARY_REQUEST', status: 400 });
  }
  const request = { action, revision };
  if (action === 'createFolder') {
    request.name = libraryFolderName(payload.name);
    request.parentId = libraryParentId(payload.parentId);
  } else if (action === 'renameFolder') {
    request.folderId = libraryId(payload.folderId, 'folderId');
    request.name = libraryFolderName(payload.name);
  } else if (action === 'moveFolder') {
    request.folderId = libraryId(payload.folderId, 'folderId');
    request.parentId = libraryParentId(payload.parentId);
  } else if (action === 'deleteFolder') {
    request.folderId = libraryId(payload.folderId, 'folderId');
  } else {
    request.docId = libraryId(payload.docId, 'docId');
    request.folderId = libraryParentId(payload.folderId);
  }
  return request;
}

function normalizeLibraryResponse(payload) {
  if (!payload || payload.ok !== true || !payload.library || typeof payload.library !== 'object') {
    throw new CloudLibraryError('云端返回的文件夹数据不完整。', { code: 'BAD_LIBRARY_RESPONSE', status: 500 });
  }
  const revision = payload.library.revision;
  if (!Number.isInteger(revision) || revision < 0) {
    throw new CloudLibraryError('云端返回的文库版本无效。', { code: 'BAD_LIBRARY_RESPONSE', status: 500 });
  }
  if (!Array.isArray(payload.library.folders)) {
    throw new CloudLibraryError('云端返回的文件夹列表无效。', { code: 'BAD_LIBRARY_RESPONSE', status: 500 });
  }
  const folders = [];
  for (const folder of payload.library.folders) {
    if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string') continue;
    folders.push({
      id: folder.id,
      name: folder.name,
      parentId: typeof folder.parentId === 'string' && folder.parentId ? folder.parentId : null,
    });
  }
  const assignments = {};
  const rawAssignments = payload.library.assignments;
  if (rawAssignments && typeof rawAssignments === 'object' && !Array.isArray(rawAssignments)) {
    for (const [docId, folderId] of Object.entries(rawAssignments)) {
      if (typeof folderId === 'string' && folderId) assignments[docId] = folderId;
    }
  }
  return {
    ok: true,
    library: { revision, folders, assignments },
    documents: Array.isArray(payload.documents) ? payload.documents : [],
  };
}

class CloudSync extends EventEmitter {
  constructor({ userDataDir, fetchImpl = globalThis.fetch, debounceMs = DEBOUNCE_MS } = {}) {
    super();
    if (!userDataDir) throw new Error('缺少本地设置目录。');
    this.userDataDir = path.resolve(userDataDir);
    this.configPath = path.join(this.userDataDir, CONFIG_FILE);
    this.fetchImpl = fetchImpl;
    this.debounceMs = Math.max(300, Number(debounceMs) || DEBOUNCE_MS);
    this.config = {
      version: 1,
      serverUrl: '',
      syncToken: '',
      serverUser: '',
      documents: [],
      lastSyncAt: null,
    };
    this.watchers = new Map();
    this.debounceTimers = new Map();
    this.uploading = new Set();
    this.dirty = new Set();
    this.syncingAll = false;
    this.disposed = false;
    this.initialTimer = null;
  }

  async init() {
    await fsp.mkdir(this.userDataDir, { recursive: true, mode: 0o700 });
    try {
      const raw = await fsp.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.documents)) {
        this.config = {
          version: 1,
          serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
          syncToken: typeof parsed.syncToken === 'string' ? parsed.syncToken : '',
          serverUser: typeof parsed.serverUser === 'string' ? parsed.serverUser : '',
          lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
          documents: parsed.documents
            .filter((item) => item && typeof item.path === 'string')
            .map((item) => ({
              path: item.path,
              name: typeof item.name === 'string' ? item.name : path.basename(item.path),
              kind: item.kind === 'html' || item.kind === 'markdown'
                ? item.kind
                : kindForPath(item.path),
              lastSyncedHash: typeof item.lastSyncedHash === 'string' ? item.lastSyncedHash : '',
              lastSyncedAt: typeof item.lastSyncedAt === 'string' ? item.lastSyncedAt : null,
              revision: Number(item.revision) || 0,
              status: ['synced', 'pending', 'error'].includes(item.status) ? item.status : 'pending',
              lastError: typeof item.lastError === 'string' ? item.lastError.slice(0, 400) : null,
            })),
        };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        try {
          await fsp.rename(this.configPath, `${this.configPath}.corrupt-${Date.now()}`);
        } catch {
          // A corrupt settings file must never prevent the local reader opening.
        }
      }
    }
    this._persist();
    this._startWatchers();
    if (this.isConfigured() && this.config.documents.length) {
      this.initialTimer = setTimeout(() => {
        this.syncAll({ reason: 'startup' }).catch(() => {});
      }, 1500);
      this.initialTimer.unref?.();
    }
    return this;
  }

  isConfigured() {
    return Boolean(this.config.serverUrl && this.config.syncToken);
  }

  getState() {
    return {
      configured: this.isConfigured(),
      serverUrl: this.config.serverUrl,
      hasToken: Boolean(this.config.syncToken),
      serverUser: this.config.serverUser,
      lastSyncAt: this.config.lastSyncAt,
      syncing: this.syncingAll || this.uploading.size > 0,
      maxDocBytes: MAX_DOC_BYTES,
      documents: this.config.documents.map((item) => ({
        path: item.path,
        name: item.name,
        kind: item.kind,
        status: item.status,
        lastSyncedAt: item.lastSyncedAt,
        lastError: item.lastError,
        revision: item.revision,
      })),
    };
  }

  _persist() {
    atomicWriteJson(this.configPath, this.config);
  }

  _emitState() {
    this.emit('state', this.getState());
  }

  _document(filePath) {
    return this.config.documents.find((item) => item.path === filePath) || null;
  }

  _publicState() {
    return this.getState();
  }

  async saveSettings({ serverUrl, token } = {}) {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const reuseStoredToken = !String(token || '').trim()
      && this.config.syncToken
      && normalizedUrl === this.config.serverUrl;
    const normalizedToken = reuseStoredToken
      ? this.config.syncToken
      : validateSyncToken(token);
    const previousUrl = this.config.serverUrl;
    const ping = await this._ping(normalizedUrl, normalizedToken);
    this.config.serverUrl = normalizedUrl;
    this.config.syncToken = normalizedToken;
    this.config.serverUser = ping.user?.username || '';
    if (previousUrl && previousUrl !== normalizedUrl) {
      for (const item of this.config.documents) {
        item.lastSyncedHash = '';
        item.status = 'pending';
        item.lastError = null;
      }
    }
    this._persist();
    this._startWatchers();
    this._emitState();
    if (this.config.documents.length) {
      this.syncAll({ reason: 'settings' }).catch(() => {});
    }
    return { state: this._publicState(), ping };
  }

  async _ping(serverUrl = this.config.serverUrl, token = this.config.syncToken) {
    const response = await this._request(`${serverUrl}/api/sync/ping`, {
      method: 'GET',
      token,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message = payload?.error?.message || `服务器返回 ${response.status}`;
      throw new Error(message);
    }
    const payload = await response.json().catch(() => null);
    if (!payload?.ok || !payload.user?.username) {
      throw new Error('服务器响应不是墨读云文档库。');
    }
    return payload;
  }

  async ping() {
    if (!this.isConfigured()) throw new Error('请先配置云服务地址和同步令牌。');
    return this._ping();
  }

  async getLibrary() {
    return this._libraryRequest('GET');
  }

  async mutateLibrary(payload) {
    const body = normalizeLibraryMutation(payload);
    return this._libraryRequest('PATCH', body);
  }

  async _libraryRequest(method, body) {
    if (!this.isConfigured()) {
      throw new CloudLibraryError('请先配置云服务地址和同步令牌。', {
        code: 'CLOUD_NOT_CONFIGURED',
        status: 0,
      });
    }
    // The sync token stays in the main process. The response is reduced to the
    // library/documents shape so no credential can leak into the renderer.
    const response = await this._request(`${this.config.serverUrl}/api/sync/library`, {
      method,
      token: this.config.syncToken,
      body,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new CloudLibraryError(
        payload?.error?.message || `云端返回 ${response.status}`,
        {
          code: payload?.error?.code
            || (response.status === 409 ? 'LIBRARY_CONFLICT' : 'LIBRARY_REQUEST_FAILED'),
          status: response.status,
        },
      );
    }
    return normalizeLibraryResponse(payload);
  }

  async _request(url, { method = 'GET', token, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const init = {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout ? AbortSignal.timeout(20_000) : undefined,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error('连接云服务超时。');
      }
      throw new Error('无法连接云服务，请检查地址与网络。');
    }
  }

  async addPath(rawPath) {
    const filePath = normalizeDocumentPath(rawPath);
    const info = await readDocumentFile(filePath);
    let entry = this._document(filePath);
    if (!entry) {
      entry = {
        path: filePath,
        name: info.name,
        kind: info.kind,
        lastSyncedHash: '',
        lastSyncedAt: null,
        revision: 0,
        status: 'pending',
        lastError: null,
      };
      this.config.documents.push(entry);
      this._persist();
      this._watchDocument(entry);
    } else {
      entry.name = info.name;
      entry.kind = info.kind;
      entry.status = 'pending';
      entry.lastError = null;
      this._persist();
    }
    this._emitState();
    if (this.isConfigured()) {
      try {
        await this.syncDocument(filePath, { reason: 'add' });
      } catch {
        // The entry carries the error state; adding it is still successful.
      }
    } else {
      entry.lastError = '尚未配置云服务与同步令牌。';
      this._persist();
      this._emitState();
    }
    return this._publicState();
  }

  async removePath(rawPath) {
    const filePath = normalizeDocumentPath(rawPath);
    const index = this.config.documents.findIndex((item) => item.path === filePath);
    if (index < 0) return this._publicState();
    this.config.documents.splice(index, 1);
    this.dirty.delete(filePath);
    this._unwatchDocument(filePath);
    this._persist();
    this._emitState();
    return this._publicState();
  }

  async syncAll({ reason = 'manual' } = {}) {
    if (this.syncingAll) return this._publicState();
    if (!this.isConfigured()) throw new Error('请先配置云服务地址和同步令牌。');
    this.syncingAll = true;
    this._emitState();
    try {
      let firstError = null;
      for (const entry of [...this.config.documents]) {
        if (this.disposed) break;
        try {
          await this.syncDocument(entry.path, {
            reason: reason === 'manual' ? 'force' : reason,
          });
        } catch (error) {
          if (!firstError) firstError = error;
        }
      }
      this.config.lastSyncAt = new Date().toISOString();
      this._persist();
      if (firstError) throw firstError;
      return this._publicState();
    } finally {
      this.syncingAll = false;
      this._emitState();
    }
  }

  async syncDocument(rawPath, { reason = 'manual' } = {}) {
    const filePath = normalizeDocumentPath(rawPath);
    const entry = this._document(filePath);
    if (!entry) throw new Error('这份文件没有主动加入云端文库。');
    if (!this.isConfigured()) throw new Error('请先配置云服务地址和同步令牌。');
    if (this.uploading.has(filePath)) {
      // A slow upload can still be in flight when the debounce fires again.
      // Remember that this file changed and rerun once the current PUT ends.
      this.dirty.add(filePath);
      return this._publicState();
    }

    this.uploading.add(filePath);
    entry.status = 'pending';
    entry.lastError = null;
    this._emitState();
    try {
      const file = await readDocumentFile(filePath);
      entry.name = file.name;
      entry.kind = file.kind;
      if (file.hash === entry.lastSyncedHash && entry.revision > 0 && reason !== 'force') {
        entry.status = 'synced';
        entry.lastError = null;
        this._persist();
        return this._publicState();
      }
      const docId = documentIdForPath(filePath);
      const body = file.kind === 'html'
        ? { name: file.name, kind: 'html', content: file.text }
        // Markdown keeps the original API field so older readers stay compatible.
        : { name: file.name, markdown: file.text };
      const response = await this._request(`${this.config.serverUrl}/api/sync/documents/${docId}`, {
        method: 'PUT',
        token: this.config.syncToken,
        body,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || `同步失败（${response.status}）`);
      }
      entry.lastSyncedHash = file.hash;
      entry.lastSyncedAt = new Date().toISOString();
      entry.revision = Number(payload?.doc?.revision) || entry.revision || 1;
      entry.status = 'synced';
      entry.lastError = null;
      this.config.lastSyncAt = entry.lastSyncedAt;
      this._persist();
      this._emitState();
      return this._publicState();
    } catch (error) {
      entry.status = 'error';
      entry.lastError = cleanError(error.message || error);
      this._persist();
      this._emitState();
      throw new Error(entry.lastError);
    } finally {
      this.uploading.delete(filePath);
      this._emitState();
      const shouldRerun = this.dirty.delete(filePath)
        && !this.disposed
        && Boolean(this._document(filePath));
      if (shouldRerun) {
        setImmediate(() => {
          this.syncDocument(filePath, { reason: 'dirty' }).catch(() => {});
        });
      }
    }
  }

  _watchDocument(entry) {
    if (this.disposed || this.watchers.has(entry.path)) return;
    // fs.watch(directory) may synchronously block Electron startup on an
    // iCloud/File Provider directory. Poll only the opted-in file metadata;
    // fs.watchFile uses asynchronous stat requests and detects atomic saves.
    const listener = (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs
        || current.ctimeMs !== previous.ctimeMs
        || current.size !== previous.size
        || current.ino !== previous.ino) {
        this._scheduleDebouncedSync(entry.path);
      }
    };
    try {
      fs.watchFile(entry.path, { persistent: false, interval: 1000 }, listener);
      this.watchers.set(entry.path, {
        close: () => fs.unwatchFile(entry.path, listener),
      });
    } catch {
      // Manual sync remains available when a file cannot be watched.
    }
  }

  _unwatchDocument(filePath) {
    const watcher = this.watchers.get(filePath);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
      this.watchers.delete(filePath);
    }
    const timer = this.debounceTimers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(filePath);
    }
  }

  _scheduleDebouncedSync(filePath) {
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      if (this.disposed) return;
      this.syncDocument(filePath, { reason: 'watch' }).catch(() => {});
    }, this.debounceMs);
    timer.unref?.();
    this.debounceTimers.set(filePath, timer);
  }

  _startWatchers() {
    if (this.disposed) return;
    for (const entry of this.config.documents) this._watchDocument(entry);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.dirty.clear();
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.initialTimer = null;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    this.watchers.clear();
  }
}

module.exports = {
  CloudLibraryError,
  CloudSync,
  CONFIG_FILE,
  LIBRARY_ACTIONS,
  MAX_DOC_BYTES,
  kindForPath,
  normalizeDocumentPath,
  normalizeLibraryMutation,
  normalizeLibraryResponse,
  normalizeServerUrl,
  readDocumentFile,
  // Kept as an alias for callers that only ever sent Markdown.
  readMarkdownFile: readDocumentFile,
  validateSyncToken,
};
