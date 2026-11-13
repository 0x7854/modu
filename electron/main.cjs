'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const { CloudSync } = require('./cloud-sync.cjs');

// Playwright cannot inject its Electron loader into a packaged executable by
// itself. Automated verification explicitly opts in with an absolute loader
// path; normal launches never set this variable.
if (process.env.MODU_PLAYWRIGHT_LOADER) {
  require(path.resolve(process.env.MODU_PLAYWRIGHT_LOADER));
}

const APP_NAME = '墨读';
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);

app.setName(APP_NAME);

function debug(...parts) {
  if (process.env.MODU_DEBUG === '1') console.error('[modu]', ...parts);
}

// The packaged app uses its normal Application Support directory. Automated
// verification can redirect the profile into a disposable workspace folder.
if (process.env.MODU_USER_DATA_DIR) {
  const profileDir = path.resolve(process.env.MODU_USER_DATA_DIR);
  app.setPath('userData', profileDir);
  app.setPath('sessionData', profileDir);
}
if (process.env.MODU_TEMP_DIR) {
  app.setPath('temp', path.resolve(process.env.MODU_TEMP_DIR));
}

let readerServer = null;
let baseUrl = null;
let mainWindow = null;
let rendererReady = false;
let pendingPaths = [];
let lastOpenedPath = null;
let startPromise = null;
let creatingWindow = null;
let quitting = false;
let cloudSync = null;

/**
 * Accept only an existing absolute Markdown or single-file HTML path. txt and
 * other extensions are deliberately excluded so the document association
 * never claims them.
 */
function normalizeDocumentPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) return null;
  if (!path.isAbsolute(trimmed)) return null;
  if (!DOCUMENT_EXTENSIONS.has(path.extname(trimmed).toLowerCase())) return null;
  return path.normalize(trimmed);
}

function extractDocumentFromArgv(argv) {
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const argument = String(args[index] || '');
    if (!argument || argument === '.' || argument.startsWith('-')) {
      const inline = argument.match(/^--modu-open=(.+)$/);
      if (inline) {
        const candidate = normalizeDocumentPath(inline[1]);
        if (candidate) return candidate;
      }
      continue;
    }
    const resolved = path.isAbsolute(argument) ? argument : path.resolve(argument);
    const candidate = normalizeDocumentPath(resolved);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendOpenPath(filePath) {
  debug('send open', filePath, 'rendererReady=', rendererReady);
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) return false;
  lastOpenedPath = filePath;
  mainWindow.webContents.send('modu:open-path', filePath);
  focusWindow();
  return true;
}

function queueOpenPath(rawPath, { fromArgv = false } = {}) {
  const filePath = normalizeDocumentPath(rawPath);
  debug('queue open', rawPath, '=>', filePath);
  if (!filePath) return false;
  if (fromArgv && !fs.existsSync(filePath)) return false;

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (rendererReady) {
      if (lastOpenedPath === filePath) {
        focusWindow();
        return true;
      }
      return sendOpenPath(filePath);
    }
    pendingPaths = pendingPaths.filter((item) => item !== filePath);
    pendingPaths.push(filePath);
    focusWindow();
    return true;
  }

  pendingPaths = pendingPaths.filter((item) => item !== filePath);
  pendingPaths.push(filePath);
  ensureWindow().catch(() => {});
  return true;
}

async function startReaderServer() {
  if (readerServer) return readerServer;

  const appRoot = app.getAppPath();
  const { createReaderServer } = await import(
    pathToFileURL(path.join(appRoot, 'lib', 'reader-server.js')).href
  );

  let samplePath = path.join(appRoot, 'welcome.md');
  const bundledSample = path.join(process.resourcesPath, 'welcome.md');
  if (app.isPackaged && fs.existsSync(bundledSample)) samplePath = bundledSample;

  const server = createReaderServer({
    rootDir: appRoot,
    samplePath,
    pollMs: 500,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.readerShutdown();
    throw new Error('本地阅读服务未能取得端口。');
  }

  readerServer = server;
  baseUrl = `http://127.0.0.1:${address.port}`;
  debug('server listening', baseUrl);
  return readerServer;
}

function openExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!OPENABLE_PROTOCOLS.has(url.protocol)) return;
    shell.openExternal(url.href).catch(() => {});
  } catch {
    // Ignore malformed URLs from document content.
  }
}

function createWindow() {
  if (!baseUrl) throw new Error('本地阅读服务尚未就绪。');

  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 780,
    minHeight: 540,
    title: APP_NAME,
    backgroundColor: '#f3eee3',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.webContents.on('did-finish-load', () => debug('did-finish-load'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (typeof targetUrl === 'string' && targetUrl.startsWith(`${baseUrl}/`)) return;
    if (targetUrl === baseUrl) return;
    event.preventDefault();
    openExternalUrl(targetUrl);
  });

  debug('creating window', baseUrl);
  mainWindow.loadURL(baseUrl).catch(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  return mainWindow;
}

async function ensureWindow() {
  await startPromise;
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusWindow();
    return mainWindow;
  }
  if (creatingWindow) return creatingWindow;
  creatingWindow = Promise.resolve().then(() => createWindow());
  try {
    return await creatingWindow;
  } finally {
    creatingWindow = null;
  }
}

function stopReaderServer() {
  if (!readerServer) return;
  const server = readerServer;
  readerServer = null;
  baseUrl = null;
  try {
    server.readerShutdown();
  } catch {
    // The server may already be closing.
  }
  try {
    server.close(() => {});
  } catch {
    // Already closed.
  }
}

// open-file can arrive before app.whenReady() on a cold Finder launch. Register
// it immediately and hold the path until the renderer announces it is ready.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  debug('open-file', filePath);
  queueOpenPath(filePath);
});

app.on('second-instance', (_event, argv) => {
  const fromArgv = extractDocumentFromArgv(argv);
  if (fromArgv) queueOpenPath(fromArgv, { fromArgv: true });
  else ensureWindow().catch(() => {});
});

ipcMain.handle('modu:renderer-ready', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    return null;
  }
  rendererReady = true;
  debug('renderer ready, pending', pendingPaths);
  if (pendingPaths.length) {
    const nextPath = pendingPaths[pendingPaths.length - 1];
    pendingPaths = [];
    lastOpenedPath = nextPath;
    focusWindow();
    return nextPath;
  }
  return lastOpenedPath;
});

ipcMain.on('modu:document-opened', (event, filePath) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
  const normalized = normalizeDocumentPath(filePath);
  if (normalized) lastOpenedPath = normalized;
});

/* ------------------------------------------------------- cloud library */

function requireMainSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('不允许的调用来源。');
  }
}

function requireCloudSync() {
  if (!cloudSync) throw new Error('云端同步尚未就绪。');
  return cloudSync;
}

function sendCloudState(state) {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) return;
  mainWindow.webContents.send('modu:sync-state-changed', state);
}

ipcMain.handle('modu:sync-state', (event) => {
  requireMainSender(event);
  return requireCloudSync().getState();
});

ipcMain.handle('modu:sync-save-settings', async (event, payload) => {
  requireMainSender(event);
  const result = await requireCloudSync().saveSettings({
    serverUrl: typeof payload?.serverUrl === 'string' ? payload.serverUrl : '',
    token: typeof payload?.token === 'string' ? payload.token : '',
  });
  sendCloudState(result.state);
  return result;
});

ipcMain.handle('modu:sync-add-path', async (event, filePath) => {
  requireMainSender(event);
  if (typeof filePath !== 'string') throw new Error('文件路径无效。');
  const state = await requireCloudSync().addPath(filePath);
  sendCloudState(state);
  return state;
});

ipcMain.handle('modu:sync-remove-path', async (event, filePath) => {
  requireMainSender(event);
  if (typeof filePath !== 'string') throw new Error('文件路径无效。');
  const state = await requireCloudSync().removePath(filePath);
  sendCloudState(state);
  return state;
});

ipcMain.handle('modu:sync-now', async (event) => {
  requireMainSender(event);
  const state = await requireCloudSync().syncAll({ reason: 'manual' });
  sendCloudState(state);
  return state;
});

ipcMain.handle('modu:sync-ping', async (event) => {
  requireMainSender(event);
  return requireCloudSync().ping();
});

function safeLibraryError(error) {
  return String(error?.message || '云端文件夹操作失败。')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}

async function libraryEnvelope(task) {
  try {
    return await task();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: String(error?.code || 'LIBRARY_REQUEST_FAILED').slice(0, 80),
        status: Number(error?.status) || 0,
        message: safeLibraryError(error),
      },
    };
  }
}

ipcMain.handle('modu:library-get', async (event) => {
  requireMainSender(event);
  return libraryEnvelope(() => requireCloudSync().getLibrary());
});

ipcMain.handle('modu:library-mutate', async (event, payload) => {
  requireMainSender(event);
  return libraryEnvelope(() => requireCloudSync().mutateLibrary(payload));
});

const hasSingleInstanceLock = process.env.MODU_DISABLE_SINGLE_INSTANCE === '1'
  ? true
  : app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('window-all-closed', () => {
    // A closed reading window leaves 墨读 resident in the Dock. Quit from the
    // app menu terminates the process and the local server.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    ensureWindow().catch(() => {});
  });

  app.on('before-quit', () => {
    quitting = true;
    cloudSync?.dispose();
    stopReaderServer();
  });

  app.on('will-quit', () => {
    quitting = true;
    cloudSync?.dispose();
    stopReaderServer();
  });

  app.whenReady().then(async () => {
    debug('app ready');
    if (quitting) return;
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    if (process.platform === 'darwin' && app.dock) app.dock.show();

    try {
      cloudSync = new CloudSync({ userDataDir: app.getPath('userData') });
      await cloudSync.init();
      cloudSync.on('state', sendCloudState);
    } catch (error) {
      console.error('墨读：云端同步初始化失败，本地阅读仍可使用。', error);
      cloudSync = null;
    }

    const argvPath = extractDocumentFromArgv(process.argv);
    if (argvPath) queueOpenPath(argvPath, { fromArgv: true });

    startPromise = startReaderServer();
    await startPromise;
    await ensureWindow();
    debug('window ready');
  }).catch((error) => {
    console.error('墨读：启动失败。', error);
    stopReaderServer();
    app.quit();
  });
}
