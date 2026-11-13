import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.txt', '.html', '.htm']);
export const HTML_EXTENSIONS = new Set(['.html', '.htm']);

export function kindForExtension(extension) {
  return HTML_EXTENSIONS.has(String(extension || '').toLowerCase()) ? 'html' : 'markdown';
}

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
]);

export class ReaderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ReaderError';
    this.code = code;
    this.status = status;
  }
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function mapFsError(error, fallbackCode = 'READ_FAILED') {
  if (error instanceof ReaderError) return error;
  if (error?.code === 'ENOENT') return new ReaderError('FILE_MISSING', '文件不存在或已被移动。', 404);
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new ReaderError('FILE_FORBIDDEN', '没有权限读取这个文件。', 403);
  }
  if (error?.code === 'ELOOP') {
    return new ReaderError('SYMLINK_BLOCKED', '出于安全考虑，不读取符号链接文件。', 403);
  }
  return new ReaderError(fallbackCode, error?.message || '读取文件失败。', 500);
}

/**
 * Validate an explicitly supplied absolute document path. The final path
 * component must be a regular file, never a symlink.
 */
export function inspectDocPath(rawPath) {
  if (typeof rawPath !== 'string') {
    throw new ReaderError('INVALID_PATH', '请提供文档的绝对路径。', 400);
  }
  const requestedPath = rawPath.trim();
  if (!requestedPath) {
    throw new ReaderError('INVALID_PATH', '请提供文档的绝对路径。', 400);
  }
  if (requestedPath.length > 4096 || requestedPath.includes('\0')) {
    throw new ReaderError('INVALID_PATH', '路径格式无效。', 400);
  }
  if (!path.isAbsolute(requestedPath)) {
    throw new ReaderError('PATH_NOT_ABSOLUTE', '请输入以 / 开头的绝对路径。', 400);
  }
  const extension = path.extname(requestedPath).toLowerCase();
  if (!DOC_EXTENSIONS.has(extension)) {
    throw new ReaderError('UNSUPPORTED_TYPE', '仅支持 .md、.markdown、.mdown、.txt、.html 和 .htm 文件。', 415);
  }

  let lstat;
  try {
    lstat = fs.lstatSync(requestedPath);
  } catch (error) {
    throw mapFsError(error);
  }
  if (lstat.isSymbolicLink()) {
    throw new ReaderError('SYMLINK_BLOCKED', '出于安全考虑，不打开符号链接文件。', 403);
  }
  if (!lstat.isFile()) {
    throw new ReaderError('NOT_A_FILE', '这个路径不是普通文件。', 400);
  }

  let realPath;
  try {
    realPath = fs.realpathSync(requestedPath);
  } catch (error) {
    throw mapFsError(error);
  }
  const stat = fs.statSync(realPath);
  if (stat.size > MAX_DOC_BYTES) {
    throw new ReaderError('FILE_TOO_LARGE', `文档超过 ${(MAX_DOC_BYTES / 1024 / 1024).toFixed(0)} MB 限制。`, 413);
  }

  return {
    requestedPath,
    realPath,
    realDir: path.dirname(realPath),
    name: path.basename(requestedPath),
    extension,
    kind: kindForExtension(extension),
    stat,
  };
}

/**
 * Read with O_NOFOLLOW so a file swapped for a symlink between validation and
 * read cannot escape the path the reader was explicitly given.
 */
export async function readDocFile(doc) {
  let handle;
  try {
    handle = await fsp.open(doc.realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ReaderError('NOT_A_FILE', '这个路径不是普通文件。', 400);
    }
    if (stat.size > MAX_DOC_BYTES) {
      throw new ReaderError('FILE_TOO_LARGE', `文档超过 ${(MAX_DOC_BYTES / 1024 / 1024).toFixed(0)} MB 限制。`, 413);
    }
    const buffer = await handle.readFile();
    if (buffer.length > MAX_DOC_BYTES) {
      throw new ReaderError('FILE_TOO_LARGE', `文档超过 ${(MAX_DOC_BYTES / 1024 / 1024).toFixed(0)} MB 限制。`, 413);
    }
    return { buffer, stat };
  } catch (error) {
    throw mapFsError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeRelativeImageRef(rawSrc) {
  if (typeof rawSrc !== 'string') return null;
  let value = rawSrc.trim();
  if (!value || value.length > 2048 || value.includes('\0')) return null;

  value = value.split('#')[0].split('?')[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }

  if (
    !value ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return null;
  }
  return value;
}

/**
 * Resolve a relative image URL against the document's real directory. Only
 * regular raster images inside that directory are allowed. Traversal, symlinks
 * and non-image extensions are rejected.
 */
export function resolveImage(doc, rawSrc) {
  const relativeRef = normalizeRelativeImageRef(rawSrc);
  if (!relativeRef) {
    throw new ReaderError('ASSET_REJECTED', '仅允许文档目录内的本地相对图片。', 403);
  }

  const candidate = path.resolve(doc.realDir, relativeRef);
  if (!isInside(doc.realDir, candidate)) {
    throw new ReaderError('ASSET_OUTSIDE', '图片路径超出了文档所在目录。', 403);
  }

  const extension = path.extname(candidate).toLowerCase();
  const mime = IMAGE_TYPES.get(extension);
  if (!mime) {
    throw new ReaderError('ASSET_TYPE', '不支持的图片格式。', 415);
  }

  let lstat;
  try {
    lstat = fs.lstatSync(candidate);
  } catch (error) {
    throw mapFsError(error, 'ASSET_MISSING');
  }
  if (lstat.isSymbolicLink()) {
    throw new ReaderError('ASSET_SYMLINK', '出于安全考虑，不加载符号链接图片。', 403);
  }
  if (!lstat.isFile()) {
    throw new ReaderError('ASSET_NOT_FILE', '图片路径不是普通文件。', 400);
  }
  if (lstat.size > MAX_ASSET_BYTES) {
    throw new ReaderError('ASSET_TOO_LARGE', '图片超过大小限制。', 413);
  }

  let realAsset;
  try {
    realAsset = fs.realpathSync(candidate);
  } catch (error) {
    throw mapFsError(error, 'ASSET_MISSING');
  }
  if (!isInside(doc.realDir, realAsset)) {
    throw new ReaderError('ASSET_OUTSIDE', '图片解析后超出了文档所在目录。', 403);
  }

  return {
    absolutePath: realAsset,
    relativePath: path.relative(doc.realDir, realAsset),
    mime,
    size: lstat.size,
    mtimeMs: lstat.mtimeMs,
  };
}

export async function readAsset(asset) {
  let handle;
  try {
    handle = await fsp.open(asset.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) {
      throw new ReaderError('ASSET_TOO_LARGE', '图片不可读取或超过大小限制。', 413);
    }
    return await handle.readFile();
  } catch (error) {
    throw mapFsError(error, 'ASSET_READ_FAILED');
  } finally {
    await handle?.close().catch(() => {});
  }
}
