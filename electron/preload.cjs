'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const openPathListeners = new Set();
const syncStateListeners = new Set();

ipcRenderer.on('modu:open-path', (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath.startsWith('/')) return;
  for (const listener of [...openPathListeners]) {
    try {
      listener(filePath);
    } catch {
      // A page listener should not break the IPC channel.
    }
  }
});

ipcRenderer.on('modu:sync-state-changed', (_event, state) => {
  if (!state || typeof state !== 'object') return;
  for (const listener of [...syncStateListeners]) {
    try {
      listener(state);
    } catch {
      // A page listener should not break the IPC channel.
    }
  }
});

function subscribe(set, callback) {
  if (typeof callback !== 'function') return () => {};
  set.add(callback);
  return () => set.delete(callback);
}

/**
 * Narrow, purpose-built bridge. There is intentionally no generic
 * ipcRenderer.send/invoke exposed to the page.
 */
contextBridge.exposeInMainWorld('moduDesktop', {
  onOpenPath(callback) {
    return subscribe(openPathListeners, callback);
  },
  ready() {
    return ipcRenderer.invoke('modu:renderer-ready');
  },
  documentOpened(filePath) {
    if (typeof filePath === 'string' && filePath.startsWith('/')) {
      ipcRenderer.send('modu:document-opened', filePath);
    }
  },
  // Electron's official replacement for the removed File.path property.
  // https://www.electronjs.org/docs/latest/api/web-utils
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  sync: {
    getState() {
      return ipcRenderer.invoke('modu:sync-state');
    },
    saveSettings(payload) {
      return ipcRenderer.invoke('modu:sync-save-settings', {
        serverUrl: typeof payload?.serverUrl === 'string' ? payload.serverUrl : '',
        token: typeof payload?.token === 'string' ? payload.token : '',
      });
    },
    addPath(filePath) {
      return ipcRenderer.invoke('modu:sync-add-path', String(filePath || ''));
    },
    removePath(filePath) {
      return ipcRenderer.invoke('modu:sync-remove-path', String(filePath || ''));
    },
    syncNow() {
      return ipcRenderer.invoke('modu:sync-now');
    },
    ping() {
      return ipcRenderer.invoke('modu:sync-ping');
    },
    getLibrary() {
      return ipcRenderer.invoke('modu:library-get');
    },
    mutateLibrary(payload) {
      const body = {
        action: typeof payload?.action === 'string' ? payload.action : '',
        revision: Number.isInteger(payload?.revision) ? payload.revision : -1,
      };
      for (const key of ['name', 'folderId', 'docId']) {
        if (typeof payload?.[key] === 'string') body[key] = payload[key];
      }
      if ('parentId' in (payload || {})) {
        body.parentId = typeof payload.parentId === 'string' ? payload.parentId : null;
      }
      return ipcRenderer.invoke('modu:library-mutate', body);
    },
    onState(callback) {
      return subscribe(syncStateListeners, callback);
    },
  },
});
