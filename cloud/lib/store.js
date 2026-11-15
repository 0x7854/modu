import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  CloudError,
  DOC_ID_RE,
  USER_ID_RE,
  assertValidPassword,
  constantTimeEqual,
  assertValidUsername,
  hashImportToken,
  hashPassword,
  hashSyncToken,
  importTokenUserId,
  makeImportToken,
  normalizeUsername,
  randomId,
  randomToken,
  sha256,
  verifyPassword,
} from './auth.js';

const USERS_FILE = 'users.json';
const IMPORT_TOKENS_DIR = 'import-tokens';
const IMPORT_MAPS_DIR = 'imports';
const MAX_DOCS_PER_USER = 500;
const MAX_IMPORT_REQUESTS = 2000;
const IMPORT_REQUEST_ID_RE = /^[a-f0-9]{32}$/;
const IMPORT_EXTENSION_RE = /\.(?:md|markdown)$/i;
const LIBRARY_VERSION = 1;
const MAX_FOLDERS_PER_USER = 200;
const MAX_FOLDER_DEPTH = 8;
const MAX_FOLDER_NAME_LENGTH = 80;
const FOLDER_NAME_CONTROL_RE = /[/\\\u0000-\u001f\u007f-\u009f]/;
export const DOC_KINDS = new Set(['markdown', 'html']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function libraryCorrupt() {
  return new CloudError('LIBRARY_CORRUPT', '云文件夹数据损坏，请从备份恢复。', 500);
}

function normalizeFolderName(value) {
  if (typeof value !== 'string') {
    throw new CloudError('INVALID_NAME', '文件夹名必须是字符串。', 400);
  }
  const name = value.trim();
  if (
    !name
    || Array.from(name).length > MAX_FOLDER_NAME_LENGTH
    || FOLDER_NAME_CONTROL_RE.test(name)
  ) {
    throw new CloudError(
      'INVALID_NAME',
      `文件夹名需为 1–${MAX_FOLDER_NAME_LENGTH} 个字符，且不能包含斜杠或控制字符。`,
      400,
    );
  }
  return name;
}

function emptyLibrary() {
  return { version: LIBRARY_VERSION, revision: 0, folders: [], assignments: {} };
}

function publicLibrary(library) {
  return {
    revision: library.revision,
    folders: library.folders,
    assignments: library.assignments,
  };
}

/**
 * Validate a library file before it is exposed or mutated. Anything unexpected
 * is fail-closed: silently treating a corrupt file as empty would make the next
 * mutation overwrite organization data that might still be recoverable.
 */
function parseStoredLibrary(parsed) {
  try {
    if (!isPlainObject(parsed) || parsed.version !== LIBRARY_VERSION) throw libraryCorrupt();
    if (!Number.isInteger(parsed.revision) || parsed.revision < 0) throw libraryCorrupt();
    if (!Array.isArray(parsed.folders) || parsed.folders.length > MAX_FOLDERS_PER_USER) {
      throw libraryCorrupt();
    }
    if (!isPlainObject(parsed.assignments)) throw libraryCorrupt();

    const folders = [];
    const byId = new Map();
    for (const raw of parsed.folders) {
      if (!isPlainObject(raw)) throw libraryCorrupt();
      if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) throw libraryCorrupt();
      if (byId.has(raw.id)) throw libraryCorrupt();
      if (
        typeof raw.name !== 'string'
        || !raw.name
        || raw.name !== raw.name.trim()
        || Array.from(raw.name).length > MAX_FOLDER_NAME_LENGTH
        || FOLDER_NAME_CONTROL_RE.test(raw.name)
      ) {
        throw libraryCorrupt();
      }
      if (
        raw.parentId !== null
        && (typeof raw.parentId !== 'string' || !raw.parentId || raw.parentId.length > 64)
      ) {
        throw libraryCorrupt();
      }
      const folder = { id: raw.id, name: raw.name, parentId: raw.parentId };
      folders.push(folder);
      byId.set(folder.id, folder);
    }
    for (const folder of folders) {
      if (folder.parentId !== null && !byId.has(folder.parentId)) throw libraryCorrupt();
    }

    const assignments = {};
    for (const [docId, folderId] of Object.entries(parsed.assignments)) {
      if (!DOC_ID_RE.test(docId)) throw libraryCorrupt();
      if (typeof folderId !== 'string' || !byId.has(folderId)) throw libraryCorrupt();
      assignments[docId] = folderId;
    }

    for (const folder of folders) {
      let current = folder;
      let depth = 0;
      const seen = new Set();
      while (current) {
        if (seen.has(current.id)) throw libraryCorrupt();
        seen.add(current.id);
        depth += 1;
        if (depth > MAX_FOLDER_DEPTH) throw libraryCorrupt();
        current = current.parentId === null ? null : byId.get(current.parentId);
      }
    }

    return { version: LIBRARY_VERSION, revision: parsed.revision, folders, assignments };
  } catch (error) {
    if (error instanceof CloudError && error.code === 'LIBRARY_CORRUPT') throw error;
    throw libraryCorrupt();
  }
}

function kindFromName(name) {
  return /\.html?$/i.test(String(name || '')) ? 'html' : 'markdown';
}

function normalizeDocKind(value) {
  return DOC_KINDS.has(value) ? value : 'markdown';
}

/** Old metadata predates `kind`; infer it without rewriting existing files. */
function normalizedMetaKind(meta) {
  if (DOC_KINDS.has(meta?.kind)) return meta.kind;
  if (/\.html$/i.test(String(meta?.contentFile || ''))) return 'html';
  return kindFromName(meta?.name);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    authVersion: user.authVersion || '0',
    createdAt: user.createdAt,
    syncTokenRotatedAt: user.syncTokenRotatedAt || null,
  };
}

function publicImportTokenInfo(record, { valid = false } = {}) {
  if (!record) return { configured: false, valid: false, tokenInfo: null };
  const tokenInfo = {
    configured: true,
    valid: Boolean(valid),
    createdAt: record.createdAt || null,
    rotatedAt: record.rotatedAt || null,
  };
  return { configured: true, valid: Boolean(valid), tokenInfo };
}

function userIsDisabled(user) {
  return Boolean(user?.disabled) || Boolean(user?.disabledAt) || user?.active === false;
}

function mapFsError(error, code = 'STORAGE_ERROR') {
  if (error instanceof CloudError) return error;
  if (error?.code === 'ENOENT') return new CloudError('NOT_FOUND', '文档不存在。', 404);
  return new CloudError(code, '存储读写失败。', 500);
}

async function atomicWriteFile(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${path.basename(file)}.${randomId(6)}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, file);
    await fsp.chmod(file, mode);
    // Persist the directory entry as well as the file contents on POSIX.
    let dirHandle;
    try {
      dirHandle = await fsp.open(dir, 'r');
      await dirHandle.sync();
    } catch {
      // Some platforms/filesystems do not allow fsync on a directory.
    } finally {
      await dirHandle?.close().catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class CloudStore {
  constructor(dataDir, { maxDocBytes = 2 * 1024 * 1024 } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.docsDir = path.join(this.dataDir, 'docs');
    this.librariesDir = path.join(this.dataDir, 'libraries');
    this.importTokensDir = path.join(this.dataDir, IMPORT_TOKENS_DIR);
    this.importMapsDir = path.join(this.dataDir, IMPORT_MAPS_DIR);
    this.usersFile = path.join(this.dataDir, USERS_FILE);
    this.maxDocBytes = maxDocBytes;
    this.usersCache = null;
    this.usersMtimeMs = -1;
    this.docLocks = new Map();
    this.libraryLocks = new Map();
    this.importLocks = new Map();
  }

  /**
   * Serialize read-compare-write operations for one user's folder library.
   * Documents live in a separate file, so uploads and position saves never race
   * with organization and cannot overwrite it.
   */
  async _withLibraryLock(userId, task) {
    const key = userId;
    const previous = this.libraryLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.libraryLocks.set(key, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.libraryLocks.get(key) === tail) this.libraryLocks.delete(key);
    }
  }

  /**
   * Serialize read-modify-write operations for one document. Position saves and
   * sync uploads can arrive at the same time; without this, both read the same
   * old meta and one overwrites the other's revision or position.
   */
  async _withDocLock(userId, docId, task) {
    const key = `${userId}/${docId}`;
    const previous = this.docLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.docLocks.set(key, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.docLocks.get(key) === tail) this.docLocks.delete(key);
    }
  }

  /**
   * Import idempotency maps and per-user import tokens are separate from
   * users.json and document metadata. Serialize every read-change-write for one
   * user so two quick Shortcut retries cannot create two mappings or race a
   * token rotation against an import.
   */
  async _withImportLock(userId, task) {
    const key = userId;
    const previous = this.importLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.importLocks.set(key, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.importLocks.get(key) === tail) this.importLocks.delete(key);
    }
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.dataDir, 0o700).catch(() => {});
    await fsp.mkdir(this.docsDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.docsDir, 0o700).catch(() => {});
    await fsp.mkdir(this.importTokensDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.importTokensDir, 0o700).catch(() => {});
    await fsp.mkdir(this.importMapsDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.importMapsDir, 0o700).catch(() => {});
    const users = await this._loadUsers();
    if (!fs.existsSync(this.usersFile)) {
      await this._persistUsers(users);
    } else {
      await fsp.chmod(this.usersFile, 0o600).catch(() => {});
    }
    return this;
  }

  async _loadUsers({ force = false } = {}) {
    let stat = null;
    try {
      stat = await fsp.stat(this.usersFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw mapFsError(error);
    }
    if (!force && this.usersCache && stat && stat.mtimeMs === this.usersMtimeMs) {
      return this.usersCache;
    }
    if (!stat) {
      this.usersCache = { version: 1, users: [] };
      this.usersMtimeMs = -1;
      return this.usersCache;
    }
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(this.usersFile, 'utf8'));
    } catch {
      throw new CloudError('USERS_CORRUPT', '用户数据文件无法解析，请从备份恢复。', 500);
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.users)) {
      throw new CloudError('USERS_CORRUPT', '用户数据文件格式不正确。', 500);
    }
    this.usersCache = parsed;
    this.usersMtimeMs = stat.mtimeMs;
    return parsed;
  }

  async _persistUsers(data) {
    await atomicWriteFile(this.usersFile, `${JSON.stringify(data, null, 2)}\n`, 0o600);
    const stat = await fsp.stat(this.usersFile);
    this.usersMtimeMs = stat.mtimeMs;
    this.usersCache = data;
  }

  async listUsers() {
    const { users } = await this._loadUsers();
    return users.map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
  }

  async addUser(username, password) {
    const normalized = assertValidUsername(username);
    assertValidPassword(password);
    const data = await this._loadUsers({ force: true });
    if (data.users.some((user) => user.username === normalized)) {
      throw new CloudError('USER_EXISTS', '这个用户名已存在。', 409);
    }
    const syncToken = randomToken(32);
    const user = {
      id: randomId(12),
      username: normalized,
      authVersion: randomId(8),
      password: await hashPassword(password),
      syncTokenHash: hashSyncToken(syncToken),
      createdAt: new Date().toISOString(),
      syncTokenRotatedAt: new Date().toISOString(),
    };
    data.users.push(user);
    await this._persistUsers(data);
    await fsp.mkdir(path.join(this.docsDir, user.id), { recursive: true, mode: 0o700 });
    return { user: publicUser(user), syncToken };
  }

  async verifyLogin(username, password) {
    const normalized = normalizeUsername(username);
    if (!normalized || !password) return null;
    const { users } = await this._loadUsers({ force: true });
    const user = users.find((entry) => entry.username === normalized);
    if (!user) return null;
    if (!(await verifyPassword(password, user.password))) return null;
    return publicUser(user);
  }

  async getUser(userId, { fresh = false } = {}) {
    if (!USER_ID_RE.test(String(userId || ''))) return null;
    const { users } = await this._loadUsers({ force: fresh });
    const user = users.find((entry) => entry.id === userId);
    return user ? publicUser(user) : null;
  }

  async findBySyncToken(token) {
    const raw = String(token || '');
    if (raw.length < 32 || raw.length > 256) return null;
    const digest = hashSyncToken(raw);
    const { users } = await this._loadUsers({ force: true });
    const user = users.find((entry) => (
      typeof entry.syncTokenHash === 'string'
      && constantTimeEqual(entry.syncTokenHash, digest)
    ));
    return user ? publicUser(user) : null;
  }

  async rotateSyncToken(userId) {
    if (!USER_ID_RE.test(String(userId || ''))) {
      throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
    }
    const data = await this._loadUsers({ force: true });
    const user = data.users.find((entry) => entry.id === userId);
    if (!user) throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
    const syncToken = randomToken(32);
    user.syncTokenHash = hashSyncToken(syncToken);
    user.syncTokenRotatedAt = new Date().toISOString();
    await this._persistUsers(data);
    return { user: publicUser(user), syncToken };
  }

  /* --------------------------------------------------- import-only tokens */

  _importTokenPath(userId) {
    if (!USER_ID_RE.test(String(userId || ''))) {
      throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
    }
    return path.join(this.importTokensDir, `${userId}.json`);
  }

  async _readImportTokenRecord(userId) {
    const file = this._importTokenPath(userId);
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw mapFsError(error);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CloudError('IMPORT_TOKEN_CORRUPT', '仅导入令牌文件损坏。', 500);
    }
    if (
      !isPlainObject(parsed)
      || parsed.version !== 1
      || parsed.userId !== userId
      || typeof parsed.tokenHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(parsed.tokenHash)
      || typeof parsed.authVersion !== 'string'
    ) {
      throw new CloudError('IMPORT_TOKEN_CORRUPT', '仅导入令牌文件格式不正确。', 500);
    }
    return parsed;
  }

  async _currentUserRecord(userId) {
    const { users } = await this._loadUsers({ force: true });
    return users.find((entry) => entry.id === userId) || null;
  }

  async getImportTokenInfo(userId) {
    const record = await this._readImportTokenRecord(userId);
    if (!record) return publicImportTokenInfo(null);
    const user = await this._currentUserRecord(userId);
    const valid = Boolean(
      user
      && !userIsDisabled(user)
      && String(user.authVersion || '0') === record.authVersion,
    );
    return publicImportTokenInfo(record, { valid });
  }

  async issueImportToken(userId) {
    return this._withImportLock(userId, async () => {
      const user = await this._currentUserRecord(userId);
      if (!user) throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
      if (userIsDisabled(user)) {
        throw new CloudError('ACCOUNT_DISABLED', '账户已被禁用。', 403);
      }
      const existing = await this._readImportTokenRecord(userId);
      const token = makeImportToken(userId);
      const now = new Date().toISOString();
      const record = {
        version: 1,
        userId,
        tokenHash: hashImportToken(token),
        authVersion: String(user.authVersion || '0'),
        createdAt: existing?.createdAt || now,
        rotatedAt: now,
      };
      // Hash-only, atomic, 0600. The clear token exists only in this return
      // value and in the immediate HTTP response.
      await atomicWriteFile(
        this._importTokenPath(userId),
        `${JSON.stringify(record, null, 2)}\n`,
        0o600,
      );
      return { token, ...publicImportTokenInfo(record, { valid: true }) };
    });
  }

  async revokeImportToken(userId) {
    return this._withImportLock(userId, async () => {
      await fsp.rm(this._importTokenPath(userId), { force: true });
      return publicImportTokenInfo(null);
    });
  }

  async verifyImportToken(token) {
    const userId = importTokenUserId(token);
    if (!userId) return null;
    let record;
    try {
      record = await this._readImportTokenRecord(userId);
    } catch {
      // A corrupt token file must fail closed, never become a wildcard.
      return null;
    }
    if (!record || record.userId !== userId) return null;
    if (!constantTimeEqual(record.tokenHash, hashImportToken(token))) return null;
    const user = await this._currentUserRecord(userId);
    if (!user || userIsDisabled(user)) return null;
    // Password reset rotates authVersion. The import token is intentionally
    // invalidated with every older login session.
    if (String(user.authVersion || '0') !== record.authVersion) return null;
    return publicUser(user);
  }

  /* ------------------------------------------------------ import documents */

  _importMapPath(userId) {
    if (!USER_ID_RE.test(String(userId || ''))) {
      throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
    }
    return path.join(this.importMapsDir, `${userId}.json`);
  }

  async _readImportMap(userId) {
    const file = this._importMapPath(userId);
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, userId, entries: {} };
      throw mapFsError(error);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CloudError('IMPORT_INDEX_CORRUPT', '导入幂等记录损坏。', 500);
    }
    if (
      !isPlainObject(parsed)
      || parsed.version !== 1
      || parsed.userId !== userId
      || !isPlainObject(parsed.entries)
    ) {
      throw new CloudError('IMPORT_INDEX_CORRUPT', '导入幂等记录格式不正确。', 500);
    }
    return parsed;
  }

  _pruneImportMap(map) {
    const entries = Object.entries(map.entries);
    if (entries.length <= MAX_IMPORT_REQUESTS) return;
    entries
      .sort((left, right) => String(left[1].createdAt || '').localeCompare(String(right[1].createdAt || '')))
      .slice(0, entries.length - MAX_IMPORT_REQUESTS)
      .forEach(([requestId]) => delete map.entries[requestId]);
  }

  async importDocument(userId, { name, markdown, requestId } = {}) {
    if (typeof name !== 'string') {
      throw new CloudError('INVALID_NAME', '文档名无效。', 400);
    }
    let docName = name.trim();
    if (
      !docName
      || docName === '.' || docName === '..'
      || docName.length > 200
      || /[/\\\u0000-\u001f\u007f]/.test(docName)
    ) {
      throw new CloudError('INVALID_NAME', '文档名无效。', 400);
    }
    // Share sheets may supply a basename or a plain-text filename for MD.
    // Normalize only these textual names; never overwrite an existing file.
    if (!IMPORT_EXTENSION_RE.test(docName) && !path.extname(docName)) docName += '.md';
    else if (/\.txt$/i.test(docName)) {
      docName = docName.slice(0, -4);
      if (!IMPORT_EXTENSION_RE.test(docName)) docName += '.md';
    }
    if (docName.length > 200) throw new CloudError('INVALID_NAME', '文档名过长。', 400);
    if (!IMPORT_EXTENSION_RE.test(docName)) {
      throw new CloudError('UNSUPPORTED_TYPE', '请选择 Markdown 或纯文本文件，不支持此文件后缀。', 415);
    }
    if (typeof markdown !== 'string' || markdown.includes('\u0000')) {
      throw new CloudError('INVALID_MARKDOWN', '未读取到有效的纯文本正文。', 400);
    }
    if (Buffer.byteLength(markdown, 'utf8') > this.maxDocBytes) {
      throw new CloudError(
        'DOCUMENT_TOO_LARGE',
        `文档超过 ${(this.maxDocBytes / 1024 / 1024).toFixed(0)} MB 限制。`,
        413,
      );
    }
    let idempotencyKey = '';
    if (requestId !== undefined && requestId !== null && requestId !== '') {
      if (typeof requestId !== 'string' || !IMPORT_REQUEST_ID_RE.test(requestId)) {
        throw new CloudError('INVALID_REQUEST_ID', 'requestId 需为 32 位小写十六进制。', 400);
      }
      idempotencyKey = requestId;
    }
    const payloadHash = sha256(JSON.stringify({ name: docName, markdown }));

    return this._withImportLock(userId, async () => {
      const map = idempotencyKey ? await this._readImportMap(userId) : null;
      if (idempotencyKey) {
        const existing = map.entries[idempotencyKey];
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new CloudError(
              'IMPORT_CONFLICT',
              '同一 requestId 已用于不同内容，请使用新的 requestId。',
              409,
            );
          }
          try {
            const meta = await this._readMeta(userId, existing.docId);
            return {
              replayed: true,
              doc: {
                id: meta.id,
                name: meta.name,
                kind: 'markdown',
                revision: Number(meta.revision) || 1,
                size: Number(meta.size) || 0,
                updatedAt: meta.updatedAt || meta.createdAt || null,
              },
            };
          } catch (error) {
            // The mapped document was removed out of band. Its id would be
            // unsafe to reuse if metadata now exists, so create a fresh doc and
            // replace only this requestId's mapping.
            if (!(error instanceof CloudError) || error.code !== 'DOCUMENT_NOT_FOUND') throw error;
          }
        }
      }

      let docId = '';
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = randomId(16);
        try {
          await this._readMeta(userId, candidate);
        } catch (error) {
          if (error instanceof CloudError && error.code === 'DOCUMENT_NOT_FOUND') {
            docId = candidate;
            break;
          }
          throw error;
        }
      }
      if (!docId) {
        throw new CloudError('DOCUMENT_ID_EXHAUSTED', '暂时无法生成文档标识，请重试。', 503);
      }

      const saved = await this.upsertDocument(
        userId,
        docId,
        { name: docName, markdown, kind: 'markdown' },
        { createOnly: true },
      );
      if (idempotencyKey) {
        map.entries[idempotencyKey] = {
          docId: saved.doc.id,
          payloadHash,
          createdAt: new Date().toISOString(),
        };
        this._pruneImportMap(map);
        await atomicWriteFile(
          this._importMapPath(userId),
          `${JSON.stringify(map, null, 2)}\n`,
          0o600,
        );
      }
      return { replayed: false, doc: saved.doc };
    });
  }

  async resetPassword(userId, password) {
    if (!USER_ID_RE.test(String(userId || ''))) {
      throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
    }
    assertValidPassword(password);
    const data = await this._loadUsers({ force: true });
    const user = data.users.find((entry) => entry.id === userId);
    if (!user) throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
    user.password = await hashPassword(password);
    // Existing login sessions compare this version on every request. Rotating
    // it revokes sessions issued before the password reset.
    user.authVersion = randomId(8);
    await this._persistUsers(data);
    return publicUser(user);
  }

  _userDocsDir(userId) {
    if (!USER_ID_RE.test(String(userId || ''))) {
      throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
    }
    return path.join(this.docsDir, userId);
  }

  _docPaths(userId, docId) {
    if (!DOC_ID_RE.test(String(docId || ''))) {
      throw new CloudError('INVALID_DOCUMENT_ID', '文档标识无效。', 400);
    }
    const dir = this._userDocsDir(userId);
    return {
      dir,
      meta: path.join(dir, `${docId}.json`),
    };
  }

  _contentPath(userId, docId, meta) {
    const dir = this._userDocsDir(userId);
    const contentFile = meta?.contentFile || `${docId}.md`;
    if (!/^[a-f0-9]{32}(?:\.r\d+)?\.(?:md|html)$/.test(contentFile)) {
      throw new CloudError('DOCUMENT_CORRUPT', '文档内容文件名损坏。', 500);
    }
    return path.join(dir, contentFile);
  }

  async _readMeta(userId, docId) {
    const paths = this._docPaths(userId, docId);
    try {
      const raw = await fsp.readFile(paths.meta, 'utf8');
      const meta = JSON.parse(raw);
      if (!meta || meta.id !== docId || typeof meta.name !== 'string') {
        throw new Error('bad meta');
      }
      meta.kind = normalizedMetaKind(meta);
      return meta;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new CloudError('DOCUMENT_NOT_FOUND', '文库中没有这份文档。', 404);
      }
      if (error instanceof CloudError) throw error;
      throw new CloudError('DOCUMENT_CORRUPT', '文档元数据损坏。', 500);
    }
  }

  async _countDocuments(userId) {
    try {
      const entries = await fsp.readdir(this._userDocsDir(userId));
      return entries.filter((name) => name.endsWith('.json')).length;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw mapFsError(error);
    }
  }

  async listDocuments(userId) {
    const dir = this._userDocsDir(userId);
    let entries = [];
    try {
      entries = await fsp.readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw mapFsError(error);
    }
    const metas = [];
    for (const entry of entries) {
      const match = entry.match(/^([a-f0-9]{32})\.json$/);
      if (!match) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, entry), 'utf8'));
        if (!meta || meta.id !== match[1] || typeof meta.name !== 'string') continue;
        metas.push({
          id: meta.id,
          name: meta.name,
          kind: normalizedMetaKind(meta),
          revision: Number(meta.revision) || 1,
          size: Number(meta.size) || 0,
          updatedAt: meta.updatedAt || meta.createdAt || null,
          positionUpdatedAt: meta.position?.updatedAt || null,
        });
      } catch {
        // Skip one broken entry rather than making the whole library unreadable.
      }
    }
    metas.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return metas;
  }

  async getDocument(userId, docId) {
    return this._withDocLock(userId, docId, async () => {
      const meta = await this._readMeta(userId, docId);
      let body;
      try {
        body = await fsp.readFile(this._contentPath(userId, docId, meta), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new CloudError('DOCUMENT_NOT_FOUND', '文档正文文件不存在。', 404);
        }
        throw mapFsError(error);
      }
      const kind = normalizedMetaKind(meta);
      return {
        ...meta,
        kind,
        ...(kind === 'html' ? { html: body } : { markdown: body }),
        position: meta.position || null,
      };
    });
  }

  async upsertDocument(userId, docId, { name, markdown, content, kind } = {}, { createOnly = false } = {}) {
    const docName = String(name || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim();
    if (!docName || docName.length > 200 || /[/\\]/.test(docName)) {
      throw new CloudError('INVALID_NAME', '文档名无效。', 400);
    }
    if (kind !== undefined && !DOC_KINDS.has(kind)) {
      throw new CloudError('UNSUPPORTED_TYPE', '文档类型只能是 markdown 或 html。', 415);
    }
    const docKind = kind === undefined ? kindFromName(docName) : normalizeDocKind(kind);
    if (docKind === 'html') {
      if (!/\.html?$/i.test(docName)) {
        throw new CloudError('UNSUPPORTED_TYPE', 'HTML 文稿必须使用 .html 或 .htm 扩展名。', 415);
      }
    } else if (!/\.(?:md|markdown)$/i.test(docName)) {
      throw new CloudError('UNSUPPORTED_TYPE', '云端文库只接收 .md/.markdown 或单文件 .html/.htm。', 415);
    }
    const rawContent = docKind === 'html'
      ? (typeof content === 'string' ? content : (typeof markdown === 'string' ? markdown : null))
      : (typeof markdown === 'string' ? markdown : null);
    if (rawContent === null) {
      throw new CloudError(
        docKind === 'html' ? 'INVALID_HTML' : 'INVALID_MARKDOWN',
        docKind === 'html' ? '缺少 HTML 正文。' : '缺少 Markdown 正文。',
        400,
      );
    }
    const body = Buffer.from(rawContent, 'utf8');
    if (body.length > this.maxDocBytes) {
      throw new CloudError(
        'DOCUMENT_TOO_LARGE',
        `文档超过 ${(this.maxDocBytes / 1024 / 1024).toFixed(0)} MB 限制。`,
        413,
      );
    }
    const paths = this._docPaths(userId, docId);
    await fsp.mkdir(paths.dir, { recursive: true, mode: 0o700 });
    const hash = sha256(body);

    return this._withDocLock(userId, docId, async () => {
      let previous = null;
      try {
        previous = await this._readMeta(userId, docId);
      } catch (error) {
        if (!(error instanceof CloudError) || error.code !== 'DOCUMENT_NOT_FOUND') throw error;
        const count = await this._countDocuments(userId);
        if (count >= MAX_DOCS_PER_USER) {
          throw new CloudError('LIBRARY_FULL', `每个账户最多 ${MAX_DOCS_PER_USER} 份文档。`, 413);
        }
      }

      if (previous && createOnly) {
        // Import promises a brand-new document id. Refuse rather than turn an
        // id collision into an overwrite of somebody's existing revision.
        throw new CloudError('DOCUMENT_EXISTS', '文档标识已存在，请重新导入。', 409);
      }

      if (previous && normalizedMetaKind(previous) !== docKind) {
        // Never silently reinterpret an old Markdown document as runnable HTML
        // (or the reverse) for the same path-derived document id.
        throw new CloudError(
          'DOCUMENT_KIND_MISMATCH',
          '同一文档 ID 的文稿类型不能从 Markdown 改为 HTML，或反向变更。',
          409,
        );
      }

      if (previous && previous.hash === hash) {
        if (previous.name !== docName) {
          previous.name = docName;
          previous.updatedAt = new Date().toISOString();
          await atomicWriteFile(paths.meta, `${JSON.stringify(previous, null, 2)}\n`, 0o600);
          return {
            unchanged: true,
            renamed: true,
            doc: {
              id: previous.id,
              name: previous.name,
              kind: docKind,
              revision: previous.revision,
              size: previous.size,
              updatedAt: previous.updatedAt,
            },
          };
        }
        return {
          unchanged: true,
          renamed: false,
          doc: {
            id: previous.id,
            name: previous.name,
            kind: docKind,
            revision: previous.revision,
            size: previous.size,
            updatedAt: previous.updatedAt,
          },
        };
      }

      const createdAt = previous?.createdAt || new Date().toISOString();
      const revision = (Number(previous?.revision) || 0) + 1;
      const contentFile = `${docId}.r${revision}.${docKind === 'html' ? 'html' : 'md'}`;
      const meta = {
        version: 3,
        id: docId,
        name: docName,
        kind: docKind,
        revision,
        size: body.length,
        hash,
        contentFile,
        createdAt,
        updatedAt: new Date().toISOString(),
        position: previous?.position || null,
      };
      const previousContent = previous ? this._contentPath(userId, docId, previous) : null;
      const nextContent = this._contentPath(userId, docId, meta);

      // Content is an immutable revision file; meta is the single atomic
      // pointer. A crash before the meta rename leaves an orphan revision file
      // while readers still see the previous complete revision.
      await atomicWriteFile(nextContent, body, 0o600);
      await atomicWriteFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, 0o600);
      if (previousContent && previousContent !== nextContent) {
        await fsp.rm(previousContent, { force: true }).catch(() => {});
      }
      return {
        unchanged: false,
        renamed: Boolean(previous && previous.name !== docName),
        doc: {
          id: meta.id,
          name: meta.name,
          kind: meta.kind,
          revision: meta.revision,
          size: meta.size,
          updatedAt: meta.updatedAt,
        },
      };
    });
  }

  async updatePosition(userId, docId, position = {}) {
    return this._withDocLock(userId, docId, async () => {
      const meta = await this._readMeta(userId, docId);
      const anchor = typeof position.anchor === 'string'
        ? position.anchor.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160)
        : '';
      let ratio = Number(position.ratio);
      if (!Number.isFinite(ratio)) ratio = 0;
      ratio = Math.min(1, Math.max(0, ratio));
      let scrollTop = Number(position.scrollTop);
      if (!Number.isFinite(scrollTop)) scrollTop = 0;
      scrollTop = Math.min(10_000_000, Math.max(0, scrollTop));
      meta.position = {
        anchor,
        ratio,
        scrollTop,
        updatedAt: new Date().toISOString(),
      };
      const paths = this._docPaths(userId, docId);
      await atomicWriteFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, 0o600);
      return meta.position;
    });
  }

  _libraryPath(userId) {
    if (!USER_ID_RE.test(String(userId || ''))) {
      throw new CloudError('USER_NOT_FOUND', '用户不存在。', 404);
    }
    return path.join(this.librariesDir, `${userId}.json`);
  }

  async _readLibrary(userId) {
    const file = this._libraryPath(userId);
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyLibrary();
      throw mapFsError(error);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw libraryCorrupt();
    }
    return parseStoredLibrary(parsed);
  }

  async _persistLibrary(userId, library) {
    await atomicWriteFile(
      this._libraryPath(userId),
      `${JSON.stringify(library, null, 2)}\n`,
      0o600,
    );
  }

  async getLibrary(userId) {
    return publicLibrary(await this._readLibrary(userId));
  }

  _libraryFolderMap(library) {
    return new Map(library.folders.map((folder) => [folder.id, folder]));
  }

  _libraryFolder(byId, folderId) {
    if (typeof folderId !== 'string' || !folderId) {
      throw new CloudError('INVALID_FOLDER_ID', '文件夹标识无效。', 400);
    }
    const folder = byId.get(folderId);
    if (!folder) throw new CloudError('FOLDER_NOT_FOUND', '文件夹不存在。', 404);
    return folder;
  }

  _libraryParent(byId, value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !value) {
      throw new CloudError('INVALID_PARENT', '父文件夹参数无效。', 400);
    }
    const parent = byId.get(value);
    if (!parent) throw new CloudError('FOLDER_NOT_FOUND', '文件夹不存在。', 404);
    return parent;
  }

  _libraryDepth(byId, folderId) {
    let depth = 0;
    let current = byId.get(folderId);
    const seen = new Set();
    while (current) {
      if (seen.has(current.id)) throw libraryCorrupt();
      seen.add(current.id);
      depth += 1;
      current = current.parentId === null ? null : byId.get(current.parentId);
    }
    return depth;
  }

  _librarySubtreeHeight(folders, rootId) {
    const children = new Map();
    for (const folder of folders) {
      if (folder.parentId === null) continue;
      const list = children.get(folder.parentId) || [];
      list.push(folder.id);
      children.set(folder.parentId, list);
    }
    let height = 0;
    const stack = [{ id: rootId, level: 1 }];
    while (stack.length) {
      const { id, level } = stack.pop();
      height = Math.max(height, level);
      for (const childId of children.get(id) || []) {
        stack.push({ id: childId, level: level + 1 });
      }
    }
    return height;
  }

  _assertLibrarySiblingName(library, parentId, name, excludeId = null) {
    const duplicate = library.folders.some((folder) => (
      folder.parentId === parentId
      && folder.id !== excludeId
      && folder.name === name
    ));
    if (duplicate) {
      throw new CloudError('FOLDER_EXISTS', '同一层已存在同名文件夹。', 409);
    }
  }

  _libraryCreateFolder(library, payload) {
    if (library.folders.length >= MAX_FOLDERS_PER_USER) {
      throw new CloudError('LIBRARY_FULL', `每个账户最多 ${MAX_FOLDERS_PER_USER} 个文件夹。`, 400);
    }
    const name = normalizeFolderName(payload.name);
    const byId = this._libraryFolderMap(library);
    const parent = this._libraryParent(byId, payload.parentId);
    const parentId = parent ? parent.id : null;
    const parentDepth = parent ? this._libraryDepth(byId, parent.id) : 0;
    if (parentDepth + 1 > MAX_FOLDER_DEPTH) {
      throw new CloudError('FOLDER_DEPTH_EXCEEDED', `文件夹层级不能超过 ${MAX_FOLDER_DEPTH} 层。`, 400);
    }
    this._assertLibrarySiblingName(library, parentId, name);
    let id = randomId(8);
    while (byId.has(id)) id = randomId(8);
    library.folders.push({ id, name, parentId });
  }

  _libraryRenameFolder(library, payload) {
    const byId = this._libraryFolderMap(library);
    const folder = this._libraryFolder(byId, payload.folderId);
    const name = normalizeFolderName(payload.name);
    this._assertLibrarySiblingName(library, folder.parentId, name, folder.id);
    folder.name = name;
  }

  _libraryMoveFolder(library, payload) {
    const byId = this._libraryFolderMap(library);
    const folder = this._libraryFolder(byId, payload.folderId);
    const parent = this._libraryParent(byId, payload.parentId);
    let current = parent;
    while (current) {
      if (current.id === folder.id) {
        throw new CloudError('CYCLE', '不能把文件夹移动到自身或其子文件夹中。', 400);
      }
      current = current.parentId === null ? null : byId.get(current.parentId);
    }
    const parentId = parent ? parent.id : null;
    this._assertLibrarySiblingName(library, parentId, folder.name, folder.id);
    const parentDepth = parent ? this._libraryDepth(byId, parent.id) : 0;
    const height = this._librarySubtreeHeight(library.folders, folder.id);
    if (parentDepth + height > MAX_FOLDER_DEPTH) {
      throw new CloudError('FOLDER_DEPTH_EXCEEDED', `文件夹层级不能超过 ${MAX_FOLDER_DEPTH} 层。`, 400);
    }
    folder.parentId = parentId;
  }

  _libraryDeleteFolder(library, payload) {
    const byId = this._libraryFolderMap(library);
    const folder = this._libraryFolder(byId, payload.folderId);
    const parentId = folder.parentId;
    const children = library.folders.filter((entry) => entry.parentId === folder.id);
    // Reparenting direct children must not create two same-named siblings. Fail
    // the whole deletion rather than silently renaming or dropping a folder.
    const remainingNames = new Set(
      library.folders
        .filter((entry) => entry.id !== folder.id && entry.parentId === parentId)
        .map((entry) => entry.name),
    );
    for (const child of children) {
      if (remainingNames.has(child.name)) {
        throw new CloudError(
          'FOLDER_EXISTS',
          '删除后会出现同层同名文件夹，请先重命名其中一个。',
          409,
        );
      }
    }

    library.folders = library.folders.filter((entry) => entry.id !== folder.id);
    for (const child of library.folders) {
      if (child.parentId === folder.id) child.parentId = parentId;
    }
    // Documents themselves are never deleted; only their organization changes.
    for (const [docId, assignedFolderId] of Object.entries(library.assignments)) {
      if (assignedFolderId !== folder.id) continue;
      if (parentId === null) delete library.assignments[docId];
      else library.assignments[docId] = parentId;
    }
  }

  async _libraryMoveDocument(userId, library, payload) {
    if (typeof payload.docId !== 'string' || !DOC_ID_RE.test(payload.docId)) {
      throw new CloudError('INVALID_DOCUMENT_ID', '文档标识无效。', 400);
    }
    // Reading the authoritative metadata both checks ownership (all paths are
    // scoped to this user) and rejects assignments to documents that do not
    // exist. It never writes document metadata or content.
    await this._readMeta(userId, payload.docId);
    let folderId = null;
    if (payload.folderId !== undefined && payload.folderId !== null) {
      const byId = this._libraryFolderMap(library);
      folderId = this._libraryFolder(byId, payload.folderId).id;
    }
    if (folderId === null) delete library.assignments[payload.docId];
    else library.assignments[payload.docId] = folderId;
  }

  async mutateLibrary(userId, payload = {}) {
    this._libraryPath(userId);
    if (!isPlainObject(payload)) {
      throw new CloudError('INVALID_ACTION', '云文件夹操作无效。', 400);
    }
    if (!Number.isInteger(payload.revision) || payload.revision < 0) {
      throw new CloudError('INVALID_REVISION', '缺少有效的云文件夹版本号。', 400);
    }
    const actions = new Set([
      'createFolder',
      'renameFolder',
      'moveFolder',
      'deleteFolder',
      'moveDocument',
    ]);

    return this._withLibraryLock(userId, async () => {
      const library = await this._readLibrary(userId);
      if (payload.revision !== library.revision) {
        throw new CloudError(
          'LIBRARY_CONFLICT',
          '云文件夹已在其他设备更新，请刷新后重试。',
          409,
        );
      }
      if (typeof payload.action !== 'string' || !actions.has(payload.action)) {
        throw new CloudError('INVALID_ACTION', '云文件夹操作无效。', 400);
      }
      switch (payload.action) {
        case 'createFolder':
          this._libraryCreateFolder(library, payload);
          break;
        case 'renameFolder':
          this._libraryRenameFolder(library, payload);
          break;
        case 'moveFolder':
          this._libraryMoveFolder(library, payload);
          break;
        case 'deleteFolder':
          this._libraryDeleteFolder(library, payload);
          break;
        case 'moveDocument':
          await this._libraryMoveDocument(userId, library, payload);
          break;
        default:
          throw new CloudError('INVALID_ACTION', '云文件夹操作无效。', 400);
      }
      library.revision += 1;
      await this._persistLibrary(userId, library);
      return publicLibrary(library);
    });
  }

  async countDocuments(userId) {
    return this._countDocuments(userId);
  }
}

export {
  publicUser,
  MAX_DOCS_PER_USER,
  MAX_FOLDERS_PER_USER,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_LENGTH,
};
