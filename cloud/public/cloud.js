'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// cloud.css is loaded with media="print" plus a preload so the inline critical
// shell can paint first. Promote it as soon as this first-party script runs.
const shellStyles = document.getElementById('cloud-css');
if (shellStyles && shellStyles.media !== 'all') shellStyles.media = 'all';

const els = {
  root: document.documentElement,
  boot: $('#boot'),
  bootHint: $('#boot-hint'),
  auth: $('#auth-screen'),
  loginForm: $('#login-form'),
  loginUser: $('#login-user'),
  loginPass: $('#login-pass'),
  loginError: $('#login-error'),
  loginSubmit: $('#login-submit'),
  shell: $('#cloud-shell'),
  library: $('#library'),
  libraryToggle: $('#library-toggle'),
  libraryClose: $('#library-close'),
  scrim: $('#scrim'),
  docList: $('#doc-list'),
  libraryEmpty: $('#library-empty'),
  folderTree: $('#folder-tree'),
  folderCreate: $('#folder-create'),
  folderBreadcrumb: $('#folder-breadcrumb'),
  folderActions: $('#folder-actions'),
  folderRename: $('#folder-rename'),
  folderMove: $('#folder-move'),
  folderDelete: $('#folder-delete'),
  libraryState: $('#library-state'),
  libraryStateText: $('#library-state-text'),
  libraryStateRetry: $('#library-state-retry'),
  libraryDialog: $('#library-dialog'),
  libraryForm: $('#library-form'),
  libraryDialogKicker: $('#library-dialog-kicker'),
  libraryDialogTitle: $('#library-dialog-title'),
  libraryDialogCopy: $('#library-dialog-copy'),
  libraryDialogSubject: $('#library-dialog-subject'),
  libraryNameField: $('#library-name-field'),
  libraryName: $('#library-name'),
  libraryParentField: $('#library-parent-field'),
  libraryParent: $('#library-parent'),
  libraryDialogError: $('#library-dialog-error'),
  libraryDialogSubmit: $('#library-dialog-submit'),
  libraryDialogCancel: $('#library-dialog-cancel'),
  libraryDialogClose: $('#library-dialog-close'),
  importDoc: $('#import-doc'),
  importFile: $('#import-file'),
  shortcutSettings: $('#shortcut-settings'),
  shortcutDialog: $('#shortcut-dialog'),
  shortcutClose: $('#shortcut-close'),
  shortcutDownload: $('#shortcut-download'),
  shortcutDownloadUrl: $('#shortcut-download-url'),
  shortcutCopyDownload: $('#shortcut-copy-download'),
  shortcutUrl: $('#shortcut-url'),
  shortcutCopyUrl: $('#shortcut-copy-url'),
  shortcutTokenStatus: $('#shortcut-token-status'),
  shortcutTokenSecret: $('#shortcut-token-secret'),
  shortcutTokenValue: $('#shortcut-token-value'),
  shortcutCopyToken: $('#shortcut-copy-token'),
  shortcutTokenHint: $('#shortcut-token-hint'),
  shortcutGenerate: $('#shortcut-generate'),
  shortcutRevoke: $('#shortcut-revoke'),
  shortcutError: $('#shortcut-error'),
  userLine: $('#user-line'),
  footerUser: $('#footer-user'),
  footerStatus: $('#footer-status'),
  docTitle: $('#doc-title'),
  docKicker: $('#doc-kicker'),
  status: $('#cloud-status'),
  statusText: $('#cloud-status-text'),
  readerMeta: $('#reader-meta'),
  alert: $('#cloud-alert'),
  alertTitle: $('#cloud-alert-title'),
  alertDetail: $('#cloud-alert-detail'),
  reader: $('#reader-scroll'),
  docLoading: $('#doc-loading'),
  docLoadingText: $('#doc-loading-text'),
  welcome: $('#cloud-welcome'),
  doc: $('#cloud-doc'),
  docEnd: $('#doc-end'),
  htmlStage: $('#html-stage'),
  htmlFrameHost: $('#html-frame-host'),
  htmlFrameError: $('#html-frame-error'),
  htmlErrorTitle: $('#html-error-title'),
  htmlErrorDetail: $('#html-error-detail'),
  htmlModeNote: $('#html-mode-note'),
  edgeNav: $('#edge-nav'),
  themeToggle: $('#theme-toggle'),
  logout: $('#logout-button'),
  toastRegion: $('#toast-region'),
  themeColor: $('meta[name="theme-color"]'),
};

const POLL_MS = Math.min(
  60_000,
  Math.max(1000, Number($('meta[name="modu-poll-ms"]')?.content) || 5000),
);
const API_TIMEOUT_MS = 15_000;
const BOOTSTRAP_TIMEOUT_MS = Math.max(
  1000,
  Number($('meta[name="modu-bootstrap-timeout-ms"]')?.content) || 15_000,
);
const BOOTSTRAP_RETRY_DELAY_MS = 600;
const FRAME_TIMEOUT_MS = Math.max(
  1500,
  Number($('meta[name="modu-frame-timeout-ms"]')?.content) || 12_000,
);
const STORAGE_THEME = 'modu.cloud.theme';
const STORAGE_LAST_PREFIX = 'modu.cloud.last.';

const LIBRARY_VIEW_ALL = 'all';
const LIBRARY_VIEW_ROOT = 'root';
const LIBRARY_VIEW_FOLDER = 'folder';

// History views. One meaningful library entry sits directly behind the one
// reader entry, so the first Back (or the iOS left-edge gesture) opens the
// library instead of leaving the app. A second Back from the library is free
// to leave the app normally.
const HISTORY_STATE_KEY = 'moduCloud';
const HISTORY_STATE_VERSION = 1;

// The reserved left strip is viewport-fixed and only exists for deliberate
// edge swipes. It is intentionally wider than the old 20px so the same gesture
// works at the top, middle and bottom of the reading viewport without turning
// vertical reading into an accidental drawer drag.
const EDGE_ZONE_PX = 32;
// Horizontal intent needs only a small slop. Once locked, vertical drift never
// aborts: slow and diagonal rightward drags still belong to the drawer.
const EDGE_INTENT_SLOP_PX = 10;
const EDGE_VERTICAL_RATIO = 1.25;
const EDGE_OPEN_PX = 48;
const EDGE_OPEN_WIDTH_RATIO = 0.14;
const EDGE_OPEN_MAX_PX = 64;
// A short, fast flick still opens, but only after a real displacement.
const EDGE_FLICK_MIN_PX = 32;
const EDGE_FLICK_VELOCITY = 0.35;

// Document drag starts only from the leading grip. A small movement keeps a
// tap available for the move dialog while a deliberate drag owns the pointer.
const DOC_DRAG_START_PX = 8;
const DOC_DRAG_TREE_EDGE_PX = 28;
const DOC_DRAG_TREE_SCROLL_MAX = 12;
const DOC_DRAG_CLICK_SUPPRESS_MS = 450;

const state = {
  session: null,
  csrfToken: '',
  documents: [],
  documentSignature: '',
  currentDoc: null,
  currentMarkdown: '',
  documentRendered: false,
  bootstrapPromise: null,
  authGeneration: 0,
  documentGeneration: 0,
  documentRequest: null,
  htmlFrameGeneration: 0,
  htmlFrameTimer: null,
  htmlFramePending: false,
  pollTimer: null,
  pollCount: 0,
  positionTimer: null,
  positionSaving: false,
  loadingDocId: '',
  libraryOpen: false,
  view: 'boot',
  historyBaseCreated: false,
  edgeTouch: null,
  online: navigator.onLine !== false,
  authenticated: false,
  ignoreScrollSave: false,
  library: { revision: 0, folders: [], assignments: {} },
  libraryLoaded: false,
  libraryLoading: false,
  libraryError: '',
  libraryConflict: false,
  librarySignature: '',
  libraryRequestId: 0,
  libraryView: { kind: LIBRARY_VIEW_ALL, folderId: '' },
  libraryDialog: null,
  libraryDialogBusy: false,
  importBusy: false,
  importPending: null,
  maxDocBytes: 2 * 1024 * 1024,
  shortcutBusy: false,
  shortcutConfigured: false,
  shortcutToken: '',
  docDrag: null,
  docDragBusy: false,
  docDragSuppressClickUntil: 0,
};

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function safeSessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private browsing may block storage; reading still works.
  }
}

function safeSessionClear() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('modu.cloud.')) sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore.
  }
}

function safeLocalGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are optional.
  }
}

/* ------------------------------------------------------------ history */

function isNarrowLayout() {
  return Boolean(window.matchMedia?.('(max-width: 900px)')?.matches);
}

function makeHistoryState(view, extra = {}) {
  return { [HISTORY_STATE_KEY]: HISTORY_STATE_VERSION, view, ...extra };
}

function currentHistoryState() {
  const value = history.state;
  return value && value[HISTORY_STATE_KEY] === HISTORY_STATE_VERSION ? value : null;
}

function currentHistoryView() {
  return currentHistoryState()?.view || '';
}

function historyEntryHasBase(entry) {
  // A library entry is itself the base. Reader/auth entries only claim one
  // when this release wrote the marker, so a restored single-entry reader
  // from an older launch can be repaired instead of silently trusting that a
  // Back target still exists.
  return Boolean(entry && (entry.view === 'library' || entry.base === true));
}

function libraryUrl() {
  return `${location.pathname}${location.search}`;
}

function readerUrl(id) {
  return `#doc-${id}`;
}

function docIdFromHash() {
  const match = location.hash.match(/^#doc-([a-f0-9]{32})$/);
  return match ? match[1] : '';
}

function replaceAuthHistory({ keepUrl = false, libraryBehind = false } = {}) {
  state.view = 'auth';
  try {
    // `base` is the durable evidence that a library entry exists directly
    // behind this auth entry. `libraryBehind` alone is only a hint: older
    // releases wrote it from a current reader state without proving the base
    // was still in the back-forward list.
    const extra = libraryBehind ? { libraryBehind: true, base: true } : {};
    history.replaceState(makeHistoryState('auth', extra), '', keepUrl ? location.href : libraryUrl());
  } catch {
    // History can be unavailable in unusual embedded contexts. The auth
    // screen has already cleared every private node, so staying put is safe.
  }
}

function ensureLibraryHistory() {
  state.view = 'library';
  state.historyBaseCreated = true;
  try {
    history.replaceState(makeHistoryState('library', { base: true }), '', libraryUrl());
  } catch {
    // Never block the library screen on a history failure.
  }
  syncEdgeHitRegion();
}

function commitReaderHistory(docId) {
  if (!docId) return;
  const saved = currentHistoryState();
  const view = saved?.view || '';
  // Legacy entries without our base marker need one migration repair.
  // A restored PWA entry can carry the reader state without
  // the library entry, which used to send the first Back to an old page or out
  // of the app. Repair once by replacing the orphaned entry with a library
  // base and putting the reader on top; the marker prevents repeat growth.
  const hasBase = historyEntryHasBase(saved);
  const next = makeHistoryState('reader', { docId, base: true });
  try {
    if (view === 'reader' && hasBase) {
      // Switching documents reuses the one reader entry; Back still lands on
      // the library instead of growing one entry per document.
      if (saved?.docId !== docId || location.hash !== readerUrl(docId)) {
        history.replaceState(next, '', readerUrl(docId));
      }
    } else if (view === 'library') {
      history.pushState(next, '', readerUrl(docId));
    } else if (view === 'auth'
      && saved?.libraryBehind === true
      && state.historyBaseCreated
      && hasBase) {
      // Re-login after logout: the auth entry replaced a reader whose library
      // base is still directly behind it. Reuse that base instead of pushing
      // a second library/reader pair.
      history.replaceState(next, '', readerUrl(docId));
    } else {
      // First meaningful library entry, or a reader entry restored without a
      // base. Keep the library entry on the current slot (so its doc id is
      // available for a safe refresh/restore) and then push the reader.
      history.replaceState(makeHistoryState('library', { docId, base: true }), '', libraryUrl());
      history.pushState(next, '', readerUrl(docId));
    }
  } catch {
    // A history failure must never block reading.
  }
  state.historyBaseCreated = true;
  state.view = 'reader';
  syncEdgeHitRegion();
}

function setLibraryDrawer(open) {
  const next = Boolean(open) && isNarrowLayout();
  if (!next) cancelDocumentDrag();
  state.libraryOpen = next;
  if (next) state.edgeTouch = null;
  // A drag owns these inline styles while the finger is down. Every committed
  // open/close path clears them so a cancelled gesture can never leave a
  // half-translated panel or an invisible scrim above the reader.
  els.library.classList.remove('is-dragging');
  els.library.style.removeProperty('transform');
  els.library.classList.toggle('is-open', next);
  els.libraryToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
  els.scrim.classList.remove('is-dragging');
  els.scrim.style.removeProperty('opacity');
  els.scrim.hidden = !next;
  syncEdgeHitRegion();
}

function focusLibraryEntry() {
  const id = state.currentDoc?.id || docIdFromHash();
  const items = [...els.docList.querySelectorAll('[data-doc-id]')];
  const target = (id ? items.find((node) => node.dataset.docId === id) : null) || items[0] || null;
  if (target) {
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  } else {
    els.library.focus({ preventScroll: true });
  }
}

function openLibrary() {
  if (!state.authenticated) return;
  setLibraryDrawer(true);
  if (isNarrowLayout()) {
    requestAnimationFrame(() => focusLibraryEntry());
  } else {
    focusLibraryEntry();
  }
}

function closeLibrary() {
  setLibraryDrawer(false);
}

function dismissLibrary() {
  // Closing the history-backed library drawer returns to the preserved
  // reader without rebuilding it (HTML widget state stays intact).
  if (state.view === 'library' && state.currentDoc) {
    commitReaderHistory(state.currentDoc.id);
  }
  setLibraryDrawer(false);
  if (state.authenticated && state.currentDoc) {
    els.reader.focus({ preventScroll: true });
  }
}

function applyLibraryHistoryView({ focus = false } = {}) {
  state.view = 'library';
  state.historyBaseCreated = true;
  // Remember the visible document in the library entry itself. A refresh on
  // the library then restores that document underneath the open drawer while
  // leaving Forward able to reveal it.
  if (state.currentDoc?.id) {
    try {
      history.replaceState(
        makeHistoryState('library', { docId: state.currentDoc.id, base: true }),
        '',
        libraryUrl(),
      );
    } catch {
      // Ignore; the library view is still usable.
    }
  }
  if (isNarrowLayout()) {
    setLibraryDrawer(true);
    if (focus) requestAnimationFrame(() => focusLibraryEntry());
  } else {
    // Wide iPad landscape already shows the sidebar: never dim or cover the
    // reader with a scrim. Reveal/focus the library instead.
    setLibraryDrawer(false);
    if (focus) focusLibraryEntry();
  }
}

function applyReaderHistoryView(docId) {
  state.view = 'reader';
  setLibraryDrawer(false);
  if (!state.authenticated) return;
  if (docId && state.currentDoc?.id !== docId) {
    openDocument(docId, { silent: true, historyMode: 'none' }).catch(() => {});
    return;
  }
  els.reader.focus({ preventScroll: true });
}

function handlePopState(event) {
  const visited = event.state?.[HISTORY_STATE_KEY] === HISTORY_STATE_VERSION
    ? event.state
    : null;
  if (!state.authenticated) {
    // Logout or an expired session already cleared the private DOM. A history
    // traversal must not rebuild a reader shell or pretend a session exists.
    if (state.view !== 'auth') {
      showAuth('', {
        libraryBehind: Boolean(visited?.view === 'reader' && state.historyBaseCreated),
      });
    } else {
      replaceAuthHistory({
        libraryBehind: state.historyBaseCreated
          && visited?.libraryBehind === true
          && visited?.base === true,
      });
    }
    return;
  }

  // Traversal abandons a pending selection; its late response must not replace
  // the document visible beneath the library. Keep an existing HTML frame load.
  if (state.documentRequest || (state.loadingDocId && state.loadingDocId !== state.currentDoc?.id)) {
    cancelDocumentLoad();
    renderDocList();
  }

  const view = visited?.view || '';
  if (view === 'library') {
    applyLibraryHistoryView({ focus: true });
    return;
  }
  if (view === 'reader') {
    applyReaderHistoryView(visited.docId || docIdFromHash());
    return;
  }

  // In-document #section links create entries without our state. A non-empty
  // hash keeps the reader visible instead of turning an anchor jump into the
  // library screen.
  const id = docIdFromHash();
  if (id) {
    applyReaderHistoryView(id);
  } else if (location.hash && state.currentDoc) {
    state.view = 'reader';
    setLibraryDrawer(false);
    els.reader.focus({ preventScroll: true });
  } else {
    applyLibraryHistoryView({ focus: true });
  }
}

function syncLibraryForLayout() {
  // A rotation/resize mid-swipe should never leave a half-tracked gesture or
  // drag-only transforms/scrim behind.
  resetEdgeGesture();
  cancelDocumentDrag();
  if (!state.authenticated) {
    syncEdgeHitRegion();
    return;
  }
  if (!isNarrowLayout()) {
    setLibraryDrawer(false);
    return;
  }
  if (state.view === 'library') setLibraryDrawer(true);
  else syncEdgeHitRegion();
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function showToast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  const mark = document.createElement('span');
  mark.className = 'toast-mark';
  mark.textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : '·';
  const text = document.createElement('span');
  text.textContent = message;
  node.append(mark, text);
  els.toastRegion.append(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));
  window.setTimeout(() => {
    node.classList.remove('is-visible');
    window.setTimeout(() => node.remove(), 240);
  }, kind === 'error' ? 5600 : 3600);
}

function setStatus(kind, label, detail) {
  els.status.dataset.state = kind;
  els.statusText.textContent = label;
  els.readerMeta.textContent = detail || '';
  els.status.title = detail || label;
}

function showAlert(kind, title, detail) {
  els.alert.hidden = false;
  els.alert.dataset.kind = kind;
  els.alertTitle.textContent = title;
  els.alertDetail.textContent = detail;
}

function hideAlert() {
  els.alert.hidden = true;
}

function updateOfflineState() {
  state.online = navigator.onLine !== false;
  if (!state.session) return;
  if (state.authenticated) {
    renderLibraryState();
    renderDocList();
  }
  // Keep the "正在读取" chip while a document switch is in flight.
  if (state.loadingDocId) return;
  if (!state.online) {
    setStatus('offline', '离线', '正文不从缓存读取；其他账户的内容也不会残留');
    showAlert('warning', '当前离线', '页面壳可以离线打开，但正文只存在于服务器。恢复网络后会重新读取；不会用缓存顶替。');
    return;
  }
  if (state.currentDoc) {
    setStatus('live', '已同步', `只读 · 更新于 ${formatTime(state.currentDoc.updatedAt) || '—'}`);
  } else {
    setStatus('idle', '等待选择', '从文库选择一份文稿');
  }
  hideAlert();
}

function applyTheme(theme, { persist = false } = {}) {
  els.root.dataset.theme = theme;
  els.root.style.colorScheme = theme;
  els.themeColor?.setAttribute('content', theme === 'dark' ? '#171a15' : '#f3eee3');
  const label = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.setAttribute('title', label);
  if (persist) safeLocalSet(STORAGE_THEME, theme);
}

function initTheme() {
  const stored = safeLocalGet(STORAGE_THEME);
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  applyTheme(stored === 'light' || stored === 'dark' ? stored : (systemDark ? 'dark' : 'light'));
}

async function api(path, options = {}) {
  const requestAuthGeneration = state.authGeneration;
  const headers = { Accept: 'application/json' };
  const init = {
    method: options.method || 'GET',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.csrf) headers['X-CSRF-Token'] = state.csrfToken;
  if (options.etag) headers['If-None-Match'] = options.etag;
  if (options.keepalive) init.keepalive = true;

  // Never let a stalled network leave the boot screen spinning forever.
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : API_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = 0;
  let timedOut = false;
  if (controller) {
    init.signal = controller.signal;
    timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    let response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (options.signal?.aborted && !timedOut) {
          throw new ApiError('读取已取消。', 'ABORTED', 0);
        }
        throw new ApiError('请求超时，请检查网络后重试。', 'TIMEOUT', 0);
      }
      throw new ApiError('网络连接失败，请稍后重试。', 'NETWORK_ERROR', 0);
    }
    if (response.status === 304) return { notModified: true };
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A truncated response still becomes a useful error.
    }
    if (!response.ok) {
      if (response.status === 401
        && !options.deferUnauthorized
        && requestAuthGeneration === state.authGeneration) {
        handleUnauthorized(payload?.error?.message);
      }
      throw new ApiError(
        payload?.error?.message || `请求失败（${response.status}）`,
        payload?.error?.code || 'REQUEST_FAILED',
        response.status,
      );
    }
    return payload;
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

function handleUnauthorized(message = '登录已过期，请重新登录。') {
  if (!state.authenticated) return;
  showAuth(message);
}

/* ----------------------------------------------------------- markdown */

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function slugify(text) {
  const slug = String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}

const CLEAN_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'a', 'em', 'strong', 'del', 's', 'code', 'pre', 'span', 'small',
    'blockquote', 'ul', 'ol', 'li', 'div',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'input', 'sup', 'sub', 'kbd', 'mark',
  ],
  ALLOWED_ATTR: [
    'id', 'class', 'href', 'title', 'target', 'rel', 'start', 'align',
    'colspan', 'rowspan', 'type', 'checked', 'disabled', 'data-lang',
    'data-local-link', 'role', 'aria-label',
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'button', 'textarea', 'select', 'img'],
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'xlink:href', 'src'],
  KEEP_CONTENT: true,
};

let markdown = null;

function createMarkdownRenderer() {
  if (!window.markdownit || !window.DOMPurify) {
    throw new Error('Markdown 渲染组件未加载。');
  }
  const md = window.markdownit({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
    quotes: '“”‘’',
  });

  const defaultLinkOpen = md.renderer.rules.link_open
    || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') || '';
    if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
      token.attrSet('class', 'external-link');
    } else if (/^mailto:/i.test(href)) {
      token.attrSet('class', 'external-link');
    } else if (href.startsWith('#')) {
      token.attrSet('class', 'in-doc-link');
    } else {
      token.attrSet('href', '#');
      token.attrSet('data-local-link', href);
      token.attrSet('class', 'local-doc-link');
      token.attrSet('title', `云端不会打开本地链接：${href}`);
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const alt = token.content || '图片';
    return `<span class="md-image-blocked" role="img" aria-label="${escapeHtml(alt)}">`
      + '<strong>图片暂未同步</strong>'
      + `<small>${escapeHtml(alt)} · 云端第一版只同步 Markdown 正文，不读取 Mac 上的图片或任意本地文件</small>`
      + '</span>';
  };

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = (token.info || '').trim();
    const language = info.split(/\s+/)[0] || 'text';
    return `<pre class="md-code" data-lang="${escapeHtml(language)}"><code>${escapeHtml(token.content)}</code></pre>\n`;
  };

  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  return md;
}

function markdownToSafeHtml(source) {
  const raw = markdown.render(String(source || ''));
  return window.DOMPurify.sanitize(raw, CLEAN_CONFIG);
}

function assignHeadingIds() {
  const used = new Set();
  const headings = $$('h1, h2, h3, h4, h5, h6', els.doc);
  for (const heading of headings) {
    const text = heading.textContent || '';
    const base = slugify(text);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    heading.id = id;
  }
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function assignBlockAnchors() {
  const counts = new Map();
  for (const child of els.doc.children) {
    if (child.id) {
      child.dataset.anchor = `id:${child.id}`;
      continue;
    }
    const signature = `${child.tagName}|${(child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180)}`;
    const base = hashText(signature);
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    child.dataset.anchor = `b:${base}:${count}`;
  }
}

function capturePosition() {
  const container = els.reader;
  const max = Math.max(1, container.scrollHeight - container.clientHeight);
  const ratio = Math.min(1, Math.max(0, container.scrollTop / max));
  if (els.doc.hidden) return { anchor: '', ratio, scrollTop: container.scrollTop };
  const rect = container.getBoundingClientRect();
  const focusY = rect.top + Math.min(130, container.clientHeight * 0.22);
  const node = [...els.doc.children].find((child) => child.getBoundingClientRect().bottom > focusY) || null;
  return {
    anchor: node?.dataset.anchor || '',
    ratio,
    scrollTop: container.scrollTop,
  };
}

function applyPosition(position) {
  if (!position) return;
  const container = els.reader;
  const max = Math.max(1, container.scrollHeight - container.clientHeight);
  let target = null;
  if (position.anchor) {
    try {
      target = els.doc.querySelector(`[data-anchor="${CSS.escape(position.anchor)}"]`);
    } catch {
      target = null;
    }
  }
  state.ignoreScrollSave = true;
  if (target) {
    const rect = container.getBoundingClientRect();
    const top = target.getBoundingClientRect().top - rect.top;
    container.scrollTop += top - Math.min(130, container.clientHeight * 0.22);
  } else if (Number.isFinite(Number(position.ratio))) {
    container.scrollTop = Math.min(1, Math.max(0, Number(position.ratio))) * max;
  } else {
    container.scrollTop = Math.min(max, Math.max(0, Number(position.scrollTop) || 0));
  }
  requestAnimationFrame(() => {
    state.ignoreScrollSave = false;
  });
}

function schedulePositionSave() {
  if (!state.currentDoc || state.ignoreScrollSave) return;
  window.clearTimeout(state.positionTimer);
  state.positionTimer = window.setTimeout(() => {
    savePosition();
  }, 900);
}

async function savePosition({ keepalive = false } = {}) {
  if (!state.currentDoc || state.currentDoc.kind === 'html' || !state.csrfToken) return;
  if (state.positionSaving) return;
  const docId = state.currentDoc.id;
  state.positionSaving = true;
  try {
    await api(`/api/documents/${docId}/position`, {
      method: 'PUT',
      csrf: true,
      keepalive,
      body: capturePosition(),
    });
  } catch (error) {
    if (!keepalive && !(error instanceof ApiError && error.status === 401)) {
      // Position saving is best effort; never interrupt reading for it.
    }
  } finally {
    state.positionSaving = false;
  }
}

function documentKind(doc) {
  return doc?.kind === 'html' ? 'html' : 'markdown';
}

function applyDocumentModeUi(kind) {
  const isHtml = kind === 'html';
  els.root.dataset.docKind = isHtml ? 'html' : 'markdown';
  els.htmlModeNote.hidden = !isHtml;
  // The shell theme toggle controls Markdown typography/chrome only. An HTML
  // page owns its own appearance and cannot be restyled from the parent.
  els.themeToggle.hidden = isHtml;
  els.footerStatus.textContent = isHtml
    ? 'HTML 交互页 · 刷新后重置交互状态'
    : '云端只读 · Markdown';
}

function destroyHtmlFrame() {
  state.htmlFrameGeneration += 1;
  state.htmlFramePending = false;
  state.htmlFrameCleanup?.();
  state.htmlFrameCleanup = null;
  if (state.htmlFrameTimer) {
    window.clearTimeout(state.htmlFrameTimer);
    state.htmlFrameTimer = null;
  }
  if (els.htmlFrameHost) els.htmlFrameHost.replaceChildren();
  if (els.htmlFrameError) els.htmlFrameError.hidden = true;
  if (els.htmlStage) els.htmlStage.hidden = true;
  els.reader.classList.remove('is-html');
}

function previewUrlIsLocal(doc) {
  const raw = typeof doc?.previewUrl === 'string' ? doc.previewUrl : '';
  if (!raw) return false;
  try {
    const parsed = new URL(raw, location.origin);
    return parsed.origin === location.origin
      && parsed.pathname === `/api/documents/${doc.id}/preview`
      && !parsed.hash;
  } catch {
    return false;
  }
}

function showHtmlError(title, detail) {
  els.htmlErrorTitle.textContent = title;
  els.htmlErrorDetail.textContent = detail;
  els.htmlFrameError.hidden = false;
}

function renderHtmlDocument(doc, { preserve = false } = {}) {
  if (!previewUrlIsLocal(doc)) {
    throw new ApiError('HTML 预览地址无效，已拒绝加载。', 'BAD_PREVIEW_URL', 500);
  }
  destroyHtmlFrame();
  els.doc.hidden = true;
  els.doc.innerHTML = '';
  els.docEnd.hidden = true;
  els.welcome.hidden = true;
  els.htmlStage.hidden = false;
  els.htmlFrameError.hidden = true;
  els.reader.classList.add('is-html');
  applyDocumentModeUi('html');
  state.documentRendered = true;
  state.htmlFramePending = true;
  els.docTitle.textContent = doc.name;
  els.docKicker.textContent = 'CLOUD · HTML';
  document.title = `${doc.name} · 墨读云文档库`;
  if (els.docLoadingText) els.docLoadingText.textContent = '正在加载交互页…';
  setStatus('loading', '正在渲染', '正在打开 HTML 页面…');
  hideAlert();
  showDocumentLoading(doc.id);

  const generation = state.htmlFrameGeneration + 1;
  state.htmlFrameGeneration = generation;
  const iframe = document.createElement('iframe');
  iframe.className = 'html-frame';
  iframe.id = 'html-frame';
  iframe.title = `${doc.name} 交互预览`;
  // Deliberately only allow-scripts. No allow-same-origin, forms, popups,
  // top-navigation or downloads; the HTTP preview CSP enforces the opaque
  // origin again even when the URL is opened as a top-level document.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('loading', 'eager');
  iframe.src = doc.previewUrl;

  const settle = (ok) => {
    if (generation !== state.htmlFrameGeneration) return;
    if (!state.htmlFramePending) return;
    state.htmlFramePending = false;
    state.htmlFrameCleanup?.();
    state.htmlFrameCleanup = null;
    if (state.htmlFrameTimer) {
      window.clearTimeout(state.htmlFrameTimer);
      state.htmlFrameTimer = null;
    }
    const isActive = !state.loadingDocId || state.loadingDocId === doc.id;
    if (isActive) clearDocumentLoading();
    renderDocList();
    if (!isActive) return;
    if (ok) {
      setStatus('live', '已同步', `HTML 交互页 · 更新于 ${formatTime(doc.updatedAt) || '—'}`);
      hideAlert();
    } else {
      showHtmlError(
        '交互页加载超时',
        '预览没有在预期时间内完成。请检查网络后重试；如果页面依赖相邻文件或 CDN，请改为单文件内嵌资源。',
      );
      setStatus('error', '加载超时', 'HTML 交互页未能完成加载');
      showAlert('warning', '交互页加载超时', '仅支持单文件内嵌资源，不加载相邻文件或外部网络资源。');
    }
  };

  const ready = (event) => {
    if (event.source === iframe.contentWindow && event.data?.type === 'modu-preview-ready') settle(true);
  };
  window.addEventListener('message', ready);
  state.htmlFrameCleanup = () => window.removeEventListener('message', ready);
  iframe.addEventListener('error', () => settle(false), { once: true });
  els.htmlFrameHost.replaceChildren(iframe);
  state.htmlFrameTimer = window.setTimeout(() => settle(false), FRAME_TIMEOUT_MS);
  if (preserve) {
    // The iframe document is new after a revision update; internal widget
    // state cannot be preserved, but unchanged revisions never reload it.
  }
}

function renderDocument(doc, { preserve = false } = {}) {
  const container = els.reader;
  destroyHtmlFrame();
  applyDocumentModeUi('markdown');
  const anchor = preserve ? capturePosition() : null;
  const html = markdownToSafeHtml(doc.markdown);
  els.doc.innerHTML = html;
  state.documentRendered = true;
  assignHeadingIds();
  assignBlockAnchors();
  els.welcome.hidden = true;
  els.doc.hidden = false;
  els.docEnd.hidden = false;
  els.docTitle.textContent = doc.name;
  els.docKicker.textContent = 'CLOUD · READ ONLY';
  document.title = `${doc.name} · 墨读云文档库`;
  setStatus('live', '已同步', `只读 · 更新于 ${formatTime(doc.updatedAt) || '—'}`);
  hideAlert();
  if (preserve) {
    requestAnimationFrame(() => applyPosition(anchor || doc.position));
  } else {
    state.ignoreScrollSave = true;
    container.scrollTop = 0;
    requestAnimationFrame(() => {
      applyPosition(doc.position);
      state.ignoreScrollSave = false;
    });
  }
}

function showWelcome() {
  destroyHtmlFrame();
  applyDocumentModeUi('markdown');
  state.currentDoc = null;
  state.currentMarkdown = '';
  state.documentRendered = false;
  state.ignoreScrollSave = false;
  els.doc.hidden = true;
  els.doc.innerHTML = '';
  els.docEnd.hidden = true;
  els.welcome.hidden = false;
  els.reader.scrollTop = 0;
  els.docTitle.textContent = '选择一份文稿';
  els.docKicker.textContent = '私人文库';
  document.title = '墨读 · 私人云文档库';
  setStatus(state.online ? 'idle' : 'offline', state.online ? '等待选择' : '离线', state.online ? '从文库选择一份文稿' : '正文只存在于服务器，不从缓存读取');
  ensureLibraryHistory();
}

function documentSignature(documents) {
  return documents
    .map((doc) => [doc.id, doc.name, doc.kind || 'markdown', doc.revision, doc.size, doc.updatedAt].join(':'))
    .join('|');
}

function documentTimeoutMs() {
  const configured = Number($('meta[name="modu-document-timeout-ms"]')?.content);
  return Number.isFinite(configured) && configured >= 250 ? configured : API_TIMEOUT_MS;
}

function isDocumentLoadCurrent(id, generation, authGeneration) {
  return state.authenticated
    && state.authGeneration === authGeneration
    && state.documentGeneration === generation
    && state.loadingDocId === id;
}

function showDocumentLoading(id) {
  state.loadingDocId = id;
  if (els.docLoadingText) els.docLoadingText.textContent = '正在加载…';
  if (els.docLoading) els.docLoading.hidden = false;
  els.reader.setAttribute('aria-busy', 'true');
}

function clearDocumentLoading() {
  state.loadingDocId = '';
  if (els.docLoading) els.docLoading.hidden = true;
  els.reader.removeAttribute('aria-busy');
}

function cancelDocumentLoad() {
  state.documentGeneration += 1;
  if (state.documentRequest) {
    state.documentRequest.abort();
    state.documentRequest = null;
  }
  clearDocumentLoading();
}

// Let the loading selection/overlay paint before the synchronous Markdown
// render starts. The timeout fallback keeps background tabs from hanging.
function afterNextPaint() {
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) window.clearTimeout(timer);
      resolve();
    };
    timer = window.setTimeout(finish, 100);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } else {
      finish();
    }
  });
}

function folderById(id) {
  if (!id) return null;
  return state.library.folders.find((folder) => folder.id === id) || null;
}

function folderChildren(parentId) {
  return state.library.folders
    .filter((folder) => (folder.parentId || null) === (parentId || null))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

function folderDocCount(folderId) {
  return state.documents.filter((doc) => state.library.assignments[doc.id] === folderId).length;
}

function docFolderId(doc) {
  const folderId = state.library.assignments[doc.id];
  return folderId && folderById(folderId) ? folderId : '';
}

function currentFolder() {
  return state.libraryView.kind === LIBRARY_VIEW_FOLDER
    ? folderById(state.libraryView.folderId)
    : null;
}

function folderAncestors(folder) {
  const chain = [];
  const seen = new Set();
  let node = folder;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.unshift(node);
    node = node.parentId ? folderById(node.parentId) : null;
  }
  return chain;
}

function folderDescendantIds(folderId) {
  const ids = new Set();
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    for (const child of folderChildren(id)) stack.push(child.id);
  }
  return ids;
}

function docsInCurrentView() {
  const { kind, folderId } = state.libraryView;
  if (kind === LIBRARY_VIEW_ROOT) {
    return state.documents.filter((doc) => !docFolderId(doc));
  }
  if (kind === LIBRARY_VIEW_FOLDER) {
    return state.documents.filter((doc) => docFolderId(doc) === folderId);
  }
  return [...state.documents];
}

function renderDocList() {
  // Keep the reading selector: .doc-list > .doc-row > button.doc-item. The
  // drag grip and folder row are siblings, never nested buttons, and folder
  // navigation only rebuilds this list without touching the reader or HTML
  // frame. A drag begins solely from the grip; the document card retains its
  // normal tap and list scrolling.
  if (state.libraryView.kind === LIBRARY_VIEW_FOLDER
    && !folderById(state.libraryView.folderId)) {
    state.libraryView = { kind: LIBRARY_VIEW_ALL, folderId: '' };
  }
  const selectedId = state.loadingDocId || state.currentDoc?.id || '';
  const docs = docsInCurrentView();
  const children = state.libraryView.kind === LIBRARY_VIEW_FOLDER
    ? folderChildren(state.libraryView.folderId)
    : [];
  els.docList.replaceChildren();

  for (const child of children) {
    const row = document.createElement('div');
    row.className = 'doc-folder-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'doc-folder-open';
    button.dataset.folderOpen = child.id;
    button.dataset.dropFolder = child.id;
    button.setAttribute('aria-label', `打开文件夹 ${child.name}`);
    const mark = document.createElement('span');
    mark.className = 'folder-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '▸';
    const label = document.createElement('span');
    label.textContent = child.name;
    const count = document.createElement('span');
    count.className = 'folder-open-count';
    count.textContent = `${folderDocCount(child.id)} 份`;
    button.append(mark, label, count);
    button.addEventListener('click', () => setLibraryView(LIBRARY_VIEW_FOLDER, child.id));
    row.append(button);
    els.docList.append(row);
  }

  for (const doc of docs) {
    const row = document.createElement('div');
    row.className = 'doc-row';

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'doc-drag-handle';
    handle.dataset.moveDocId = doc.id;
    handle.setAttribute('aria-label', `拖动 ${doc.name} 到文件夹，或点按打开移动选项`);
    handle.setAttribute('aria-haspopup', 'dialog');
    handle.title = '拖动归类；点按打开移动选项';
    const grip = document.createElement('span');
    grip.className = 'drag-grip';
    grip.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 3; index += 1) grip.append(document.createElement('i'));
    handle.append(grip);
    handle.addEventListener('pointerdown', onDocumentDragPointerDown);
    handle.addEventListener('click', onDocumentDragHandleClick);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'doc-item';
    button.dataset.docId = doc.id;
    button.setAttribute('aria-label', `打开 ${doc.name}（${doc.kind === 'html' ? 'HTML 交互页' : 'Markdown'}）`);
    if (selectedId === doc.id) {
      button.classList.add('is-active');
      button.setAttribute('aria-current', 'page');
    }
    if (state.loadingDocId === doc.id) button.classList.add('is-loading');
    const name = document.createElement('span');
    name.className = 'doc-item-name';
    name.textContent = doc.name;
    const meta = document.createElement('span');
    meta.className = 'doc-item-meta';
    const kind = document.createElement('span');
    kind.className = 'doc-kind-badge';
    kind.textContent = doc.kind === 'html' ? 'HTML' : 'MD';
    const updated = document.createElement('span');
    updated.textContent = formatTime(doc.updatedAt) || '尚未同步';
    const size = document.createElement('span');
    size.textContent = doc.size ? `${Math.max(1, Math.round(doc.size / 1024))} KB` : '—';
    meta.append(kind, updated, size);
    button.append(name, meta);
    button.addEventListener('click', () => openDocument(doc.id));

    row.append(handle, button);
    els.docList.append(row);
  }

  const rowCount = children.length + docs.length;
  els.libraryEmpty.hidden = rowCount > 0;
  if (!rowCount) {
    const title = document.createElement('p');
    const detail = document.createElement('span');
    if (!state.documents.length) {
      title.textContent = '文库还是空的。';
      detail.textContent = '在 Mac 墨读里打开文稿，点“加入云端文库”，再手动同步或等待自动同步。';
    } else if (state.libraryView.kind === LIBRARY_VIEW_FOLDER) {
      title.textContent = '这个文件夹还没有内容。';
      detail.textContent = '可以把文稿移动进来，或在上面新建一个子文件夹。';
    } else if (state.libraryView.kind === LIBRARY_VIEW_ROOT) {
      title.textContent = '没有未归档的文稿。';
      detail.textContent = '所有文稿都已经放进文件夹；也可以在“全部文稿”里继续整理。';
    } else {
      title.textContent = '当前没有可显示的文稿。';
      detail.textContent = '请检查网络后重试，正文不会被缓存顶替。';
    }
    els.libraryEmpty.replaceChildren(title, detail);
  }
}

/* --------------------------------------------------------- session/ui */

function showBoot(message = '正在校验登录状态') {
  els.bootHint.textContent = message;
  els.auth.hidden = true;
  els.shell.hidden = true;
  els.boot.hidden = false;
}

function showAuth(message = '', { keepUrl = false, libraryBehind } = {}) {
  const priorState = currentHistoryState();
  const priorView = priorState?.view || '';
  cancelDocumentLoad();
  destroyHtmlFrame();
  applyDocumentModeUi('markdown');
  state.authGeneration += 1;
  state.bootstrapPromise = null;
  state.authenticated = false;
  state.session = null;
  state.csrfToken = '';
  state.documents = [];
  state.documentSignature = '';
  state.currentDoc = null;
  state.currentMarkdown = '';
  state.documentRendered = false;
  state.edgeTouch = null;
  closeLibrary();
  resetLibraryState();
  window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (state.positionTimer) {
    window.clearTimeout(state.positionTimer);
    state.positionTimer = null;
  }
  safeSessionClear();
  els.shell.hidden = true;
  els.boot.hidden = true;
  els.auth.hidden = false;
  els.doc.innerHTML = '';
  els.docList.replaceChildren();
  els.doc.hidden = true;
  els.welcome.hidden = false;
  els.loginPass.value = '';
  els.loginError.hidden = !message;
  els.loginError.textContent = message || '';
  els.docTitle.textContent = '选择一份文稿';
  els.docKicker.textContent = '私人文库';
  els.reader.scrollTop = 0;
  document.title = '登录 · 墨读云文档库';
  // On a first visit the document hash still chooses the post-login document,
  // so it is preserved while the login screen is shown. Logout/expiry clears
  // the hash and labels the entry as auth so Back/Forward cannot rebuild it.
  // A reader entry proves a base only when this release marked it. An auth
  // entry can preserve a base across login failures, but legacy auth entries
  // that merely claimed `libraryBehind` are repaired by the login path.
  const behind = libraryBehind === undefined
    ? (state.historyBaseCreated && (priorView === 'reader'
      || (priorView === 'auth' && priorState?.base === true)))
    : Boolean(libraryBehind);
  replaceAuthHistory({ keepUrl, libraryBehind: behind });
  window.setTimeout(() => {
    // Do not steal focus if the user has already started filling the form.
    if (state.view === 'auth' && !els.auth.hidden && !els.auth.contains(document.activeElement)) {
      els.loginUser.focus();
    }
  }, 30);
}

function showApp() {
  state.authenticated = true;
  els.auth.hidden = true;
  els.boot.hidden = true;
  els.shell.hidden = false;
  els.loginError.hidden = true;
  const username = state.session?.username || '';
  els.userLine.textContent = username ? `已登录 · ${username}` : '已登录';
  els.footerUser.textContent = username || '—';
  updateOfflineState();
  syncEdgeHitRegion();
}

function preferredDocId() {
  const hashMatch = location.hash.match(/^#doc-([a-f0-9]{32})$/);
  if (hashMatch) return hashMatch[1];
  // The library history entry carries the document it was opened over. This
  // works before the session user is known, so a refresh on the library still
  // restores the right document underneath the drawer.
  const libraryState = currentHistoryState();
  if (libraryState?.view === 'library' && /^[a-f0-9]{32}$/.test(libraryState.docId || '')) {
    return libraryState.docId;
  }
  if (!state.session) return '';
  return safeSessionGet(STORAGE_LAST_PREFIX + state.session.id) || '';
}

async function fetchBootstrapPayload() {
  const preferred = preferredDocId();
  const path = preferred
    ? `/api/bootstrap?doc=${encodeURIComponent(preferred)}`
    : '/api/bootstrap';
  try {
    return await api(path, { timeoutMs: BOOTSTRAP_TIMEOUT_MS, deferUnauthorized: true });
  } catch (error) {
    // Retry only fast network failures; a timeout already waited long enough.
    if (!(error instanceof ApiError) || error.code !== 'NETWORK_ERROR') throw error;
    await new Promise((resolve) => window.setTimeout(resolve, BOOTSTRAP_RETRY_DELAY_MS));
    return api(path, { timeoutMs: BOOTSTRAP_TIMEOUT_MS, deferUnauthorized: true });
  }
}

function applyBootstrap(payload) {
  if (!payload?.user || !Array.isArray(payload.documents)) {
    throw new ApiError('登录状态响应不完整。', 'BAD_RESPONSE', 500);
  }
  // A refresh or bfcache restore that happened while the library was open
  // must come back to the library, even though bootstrap also returns the
  // preferred document for the reader underneath.
  const rememberedLibrary = currentHistoryView() === 'library';
  state.session = payload.user;
  state.csrfToken = payload.csrfToken || '';
  state.documents = payload.documents;
  state.documentSignature = documentSignature(state.documents);
  if (Number(payload.maxDocBytes) > 0) state.maxDocBytes = Number(payload.maxDocBytes);
  if (payload.library) {
    setLibrary(payload.library, { loaded: true });
    state.libraryError = '';
  } else {
    setLibrary({ revision: 0, folders: [], assignments: {} }, { loaded: false });
    state.libraryLoaded = false;
  }
  showApp();

  const doc = payload.doc;
  if (!doc) {
    showWelcome();
    return;
  }

  const same = state.currentDoc?.id === doc.id;
  const kindChanged = documentKind(state.currentDoc) !== documentKind(doc);
  const revisionChanged = state.currentDoc?.revision !== doc.revision;
  state.currentDoc = {
    id: doc.id,
    name: doc.name,
    kind: documentKind(doc),
    revision: doc.revision,
    size: doc.size,
    updatedAt: doc.updatedAt,
    previewUrl: doc.previewUrl,
  };
  state.currentMarkdown = typeof doc.markdown === 'string' ? doc.markdown : '';
  // Bootstrap is also used by visibility/online refresh and bfcache restore;
  // only rebuild the reading pane when it is actually missing or changed.
  if (!state.documentRendered || !same || revisionChanged || kindChanged) {
    if (documentKind(doc) === 'html') {
      renderHtmlDocument({ ...doc, position: doc.position }, { preserve: same });
    } else {
      renderDocument({ ...doc, position: doc.position }, { preserve: same });
    }
  }
  safeSessionSet(STORAGE_LAST_PREFIX + state.session.id, doc.id);
  if (rememberedLibrary) {
    applyLibraryHistoryView();
  } else {
    // Idempotent: repeated bootstrap/poll/bfcache passes never add another
    // reader or library entry.
    commitReaderHistory(doc.id);
  }
  renderFolderTree();
  renderLibraryBreadcrumb();
  renderLibraryState();
  renderDocList();
  syncEdgeHitRegion();
}

async function loadBootstrap() {
  if (state.bootstrapPromise) return state.bootstrapPromise;
  const generation = state.authGeneration;
  const promise = (async () => {
    try {
      const payload = await fetchBootstrapPayload();
      // A response from before logout/account change must never restore its UI.
      if (generation !== state.authGeneration) return null;
      applyBootstrap(payload);
      return payload;
    } catch (error) {
      if (generation !== state.authGeneration) return null;
      throw error;
    }
  })();
  state.bootstrapPromise = promise;
  try {
    return await promise;
  } finally {
    if (state.bootstrapPromise === promise) state.bootstrapPromise = null;
  }
}

function suspendPrivateView() {
  cancelDocumentLoad();
  destroyHtmlFrame();
  applyDocumentModeUi('markdown');
  state.authGeneration += 1;
  state.authenticated = false;
  state.bootstrapPromise = null;
  state.edgeTouch = null;
  closeLibrary();
  resetLibraryState();
  window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.documents = [];
  state.documentSignature = '';
  state.currentDoc = null;
  state.currentMarkdown = '';
  state.documentRendered = false;
  els.doc.innerHTML = '';
  els.docList.replaceChildren();
  els.doc.hidden = true;
  els.docEnd.hidden = true;
  els.welcome.hidden = false;
  showBoot('正在校验登录状态');
}

async function revalidateRestoredView() {
  suspendPrivateView();
  try {
    await loadBootstrap();
    schedulePoll();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showAuth('');
    } else {
      showAuth(error.message || '无法连接服务器，请稍后重试。');
    }
  }
}

async function login(username, password) {
  cancelDocumentLoad();
  state.authGeneration += 1;
  state.bootstrapPromise = null;
  els.loginSubmit.disabled = true;
  els.loginError.hidden = true;
  try {
    const payload = await api('/api/login', {
      method: 'POST',
      body: { username, password },
    });
    state.session = payload.user;
    state.csrfToken = payload.csrfToken;
    showApp();
    setStatus('loading', '正在载入', '一次请求取回文库与正文…');
    await loadBootstrap();
    schedulePoll();
    if (state.authenticated) window.setTimeout(registerServiceWorker, 900);
    return true;
  } catch (error) {
    showAuth(error instanceof ApiError && error.status === 401
      ? '用户名或密码不正确。'
      : (error.message || '登录失败，请重试。'), { keepUrl: true });
    return false;
  } finally {
    els.loginSubmit.disabled = false;
  }
}

async function logout() {
  cancelDocumentLoad();
  renderDocList();
  state.authGeneration += 1;
  state.bootstrapPromise = null;
  els.logout.disabled = true;
  try {
    await api('/api/logout', { method: 'POST', csrf: true, body: {} });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      showToast(error.message || '退出失败，请检查网络后重试。', 'error');
      els.logout.disabled = false;
      updateOfflineState();
      return;
    }
  }
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
    for (const registration of registrations) {
      registration.active?.postMessage({ type: 'clear-document-cache' });
    }
  } catch {
    // The shell cache contains no private content.
  }
  state.session = null;
  state.csrfToken = '';
  state.currentDoc = null;
  state.currentMarkdown = '';
  state.importPending = null;
  closeShortcutDialog({ restoreFocus: false });
  safeSessionClear();
  els.doc.innerHTML = '';
  els.docList.replaceChildren();
  els.shell.hidden = true;
  els.boot.hidden = true;
  showAuth('已退出登录，当前正文已从页面清除。');
}

/* ------------------------------------------------------------- library */

function normalizeLibrary(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const revision = Number.isInteger(source.revision) && source.revision >= 0
    ? source.revision
    : 0;
  const folders = [];
  const ids = new Set();
  if (Array.isArray(source.folders)) {
    for (const folder of source.folders) {
      if (!folder || typeof folder.id !== 'string' || !folder.id || ids.has(folder.id)) continue;
      if (typeof folder.name !== 'string' || !folder.name) continue;
      ids.add(folder.id);
      folders.push({
        id: folder.id,
        name: folder.name,
        parentId: typeof folder.parentId === 'string' && folder.parentId ? folder.parentId : null,
      });
    }
  }
  // Treat orphaned/cyclic parents as root rather than trusting a malformed
  // response into an infinite tree render.
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    if (folder.parentId && (folder.parentId === folder.id || !byId.has(folder.parentId))) {
      folder.parentId = null;
    }
  }
  for (const folder of folders) {
    const seen = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId) {
      if (seen.has(parentId) || !byId.has(parentId)) {
        folder.parentId = null;
        break;
      }
      seen.add(parentId);
      parentId = byId.get(parentId).parentId;
    }
  }
  const assignments = {};
  if (source.assignments && typeof source.assignments === 'object' && !Array.isArray(source.assignments)) {
    for (const [docId, folderId] of Object.entries(source.assignments)) {
      if (typeof docId === 'string' && docId && typeof folderId === 'string' && folderId) {
        assignments[docId] = folderId;
      }
    }
  }
  return { revision, folders, assignments };
}

function librarySignature(library) {
  return JSON.stringify({
    revision: library.revision,
    folders: library.folders,
    assignments: library.assignments,
  });
}

function setLibrary(raw, { loaded = true } = {}) {
  const next = normalizeLibrary(raw);
  const signature = librarySignature(next);
  const closed = signature !== state.librarySignature;
  state.library = next;
  state.libraryLoaded = loaded;
  state.librarySignature = signature;
  if (state.libraryView.kind === LIBRARY_VIEW_FOLDER
    && !folderById(state.libraryView.folderId)) {
    state.libraryView = { kind: LIBRARY_VIEW_ALL, folderId: '' };
  }
  return closed;
}

function applyLibraryPayload(payload, { render = true } = {}) {
  if (Array.isArray(payload?.documents)) {
    const nextSignature = documentSignature(payload.documents);
    state.documentSignature = nextSignature;
    state.documents = payload.documents;
  }
  if (payload?.library && typeof payload.library === 'object') {
    setLibrary(payload.library, { loaded: true });
  }
  if (!render) return;
  renderFolderTree();
  renderLibraryBreadcrumb();
  renderLibraryState();
  renderDocList();
  if (isLibraryDialogOpen()) syncLibraryDialogOptions();
}

function syncLibraryActionButtons() {
  const disabled = !state.online
    || state.libraryLoading
    || state.libraryDialogBusy
    || !state.libraryLoaded;
  els.folderCreate.disabled = disabled;
  for (const button of [els.folderRename, els.folderMove, els.folderDelete]) {
    button.disabled = disabled;
  }
  syncImportAndShortcutButtons();
}

function renderFolderTree() {
  els.folderTree.replaceChildren();
  const view = state.libraryView;

  const addFilter = (kind, label, count, mark) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'folder-filter';
    button.dataset.libraryView = kind;
    if (kind === LIBRARY_VIEW_ROOT) button.dataset.dropRoot = '1';
    button.setAttribute('aria-current', String(view.kind === kind));
    const markNode = document.createElement('span');
    markNode.className = 'folder-mark';
    markNode.setAttribute('aria-hidden', 'true');
    markNode.textContent = mark;
    const name = document.createElement('span');
    name.textContent = label;
    const countNode = document.createElement('span');
    countNode.className = 'folder-count';
    countNode.textContent = String(count);
    button.append(markNode, name, countNode);
    button.addEventListener('click', () => setLibraryView(kind));
    els.folderTree.append(button);
  };

  addFilter(LIBRARY_VIEW_ALL, '全部文稿', state.documents.length, '全');
  if (state.libraryLoaded) {
    const unfiled = state.documents.filter((doc) => !docFolderId(doc)).length;
    addFilter(LIBRARY_VIEW_ROOT, '未归档', unfiled, '根');

    const addBranch = (parentId, depth) => {
      if (depth > 12) return;
      for (const folder of folderChildren(parentId)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'folder-item';
        button.dataset.folderId = folder.id;
        button.dataset.dropFolder = folder.id;
        button.style.setProperty('--folder-depth', String(depth));
        button.setAttribute('aria-current', String(
          view.kind === LIBRARY_VIEW_FOLDER && view.folderId === folder.id,
        ));
        const mark = document.createElement('span');
        mark.className = 'folder-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '▸';
        const name = document.createElement('span');
        name.textContent = folder.name;
        const count = document.createElement('span');
        count.className = 'folder-count';
        count.textContent = String(folderDocCount(folder.id));
        button.append(mark, name, count);
        button.addEventListener('click', () => setLibraryView(LIBRARY_VIEW_FOLDER, folder.id));
        els.folderTree.append(button);
        addBranch(folder.id, depth + 1);
      }
    };
    addBranch(null, 0);
    if (!state.library.folders.length) {
      const empty = document.createElement('p');
      empty.className = 'folder-empty';
      empty.textContent = '还没有文件夹。点“新建文件夹”开始整理。';
      els.folderTree.append(empty);
    }
  } else {
    const note = document.createElement('p');
    note.className = 'folder-empty';
    note.textContent = state.libraryError
      ? '云端暂未返回文件夹信息。文稿仍可阅读，稍后可重试。'
      : '正在读取云端文件夹…';
    els.folderTree.append(note);
  }
  syncLibraryActionButtons();
}

function renderLibraryBreadcrumb() {
  if (state.libraryView.kind === LIBRARY_VIEW_FOLDER
    && !folderById(state.libraryView.folderId)) {
    state.libraryView = { kind: LIBRARY_VIEW_ALL, folderId: '' };
  }
  const folder = currentFolder();
  const docs = docsInCurrentView();
  const count = document.createElement('span');
  count.className = 'crumb-count';
  count.textContent = `${docs.length} 份`;

  if (state.libraryView.kind === LIBRARY_VIEW_FOLDER && folder) {
    const chain = folderAncestors(folder);
    const nodes = [];
    chain.forEach((entry, index) => {
      if (index > 0) {
        const separator = document.createElement('span');
        separator.className = 'crumb-sep';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '/';
        nodes.push(separator);
      }
      if (index === chain.length - 1) {
        const current = document.createElement('span');
        current.className = 'crumb-current';
        current.textContent = entry.name;
        nodes.push(current);
      } else {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'crumb-link';
        link.textContent = entry.name;
        link.setAttribute('aria-label', `打开文件夹 ${entry.name}`);
        link.addEventListener('click', () => setLibraryView(LIBRARY_VIEW_FOLDER, entry.id));
        nodes.push(link);
      }
    });
    els.folderBreadcrumb.replaceChildren(...nodes, count);
    els.folderActions.hidden = false;
  } else {
    const current = document.createElement('span');
    current.className = 'crumb-current';
    current.textContent = state.libraryView.kind === LIBRARY_VIEW_ROOT ? '未归档' : '全部文稿';
    els.folderBreadcrumb.replaceChildren(current, count);
    els.folderActions.hidden = true;
  }
  syncLibraryActionButtons();
}

function renderLibraryState() {
  let kind = '';
  let message = '';
  let retry = false;
  if (!state.online) {
    kind = 'offline';
    message = '当前离线。文件夹与移动操作暂不可用；文稿正文不会被缓存顶替，恢复网络后可刷新。';
    retry = true;
  } else if (state.libraryConflict) {
    kind = 'conflict';
    message = '云端文库已在其他设备更新。已刷新为最新版本，请确认后重试；不会自动覆盖。';
  } else if (state.libraryLoading) {
    kind = 'loading';
    message = '正在刷新云端文件夹…';
  } else if (state.libraryError) {
    kind = 'error';
    message = state.libraryError;
    retry = true;
  } else if (!state.libraryLoaded) {
    kind = 'error';
    message = '云端暂未返回文件夹信息。文稿仍可阅读；刷新可重试。';
    retry = true;
  }
  els.libraryState.hidden = !message;
  if (message) {
    els.libraryState.dataset.kind = kind;
    els.libraryStateText.textContent = message;
  }
  els.libraryStateRetry.hidden = !retry;
  syncLibraryActionButtons();
}

function setLibraryView(kind, folderId = '') {
  if (kind === LIBRARY_VIEW_FOLDER && !folderById(folderId)) return;
  if (kind === LIBRARY_VIEW_ROOT && !state.libraryLoaded) return;
  state.libraryView = kind === LIBRARY_VIEW_FOLDER
    ? { kind, folderId }
    : { kind, folderId: '' };
  renderFolderTree();
  renderLibraryBreadcrumb();
  renderLibraryState();
  renderDocList();
  els.docList.scrollTop = 0;
}

async function mutateLibrary(payload) {
  if (!state.authenticated || !state.libraryLoaded) {
    throw new ApiError('云端文件夹尚未就绪。', 'LIBRARY_NOT_READY', 0);
  }
  if (!state.online) {
    throw new ApiError('当前离线，无法整理文件夹。恢复网络后重试。', 'OFFLINE', 0);
  }
  const generation = state.authGeneration;
  const body = {
    ...payload,
    revision: Number.isInteger(payload.revision) ? payload.revision : state.library.revision,
  };
  const response = await api('/api/library', {
    method: 'PATCH',
    csrf: true,
    body,
  });
  if (generation !== state.authGeneration) {
    throw new ApiError('登录状态已变更。', 'ABORTED', 0);
  }
  if (!response?.library) {
    throw new ApiError('云端返回的文件夹数据不完整。', 'BAD_RESPONSE', 500);
  }
  state.libraryConflict = false;
  state.libraryError = '';
  applyLibraryPayload(response);
  return response;
}

async function refreshLibrary({ quiet = false } = {}) {
  if (!state.authenticated) return false;
  const authGeneration = state.authGeneration;
  const requestId = state.libraryRequestId + 1;
  state.libraryRequestId = requestId;
  state.libraryLoading = true;
  if (!quiet) renderLibraryState();
  try {
    const payload = await api('/api/library');
    if (requestId !== state.libraryRequestId || authGeneration !== state.authGeneration) {
      return false;
    }
    if (!payload?.library) {
      throw new ApiError('云端返回的文件夹数据不完整。', 'BAD_RESPONSE', 500);
    }
    state.libraryError = '';
    setLibrary(payload.library, { loaded: true });
    applyLibraryPayload({ documents: state.documents }, { render: false });
    renderFolderTree();
    renderLibraryBreadcrumb();
    renderDocList();
    if (isLibraryDialogOpen()) syncLibraryDialogOptions();
    return true;
  } catch (error) {
    if (requestId !== state.libraryRequestId || authGeneration !== state.authGeneration) {
      return false;
    }
    if (error instanceof ApiError && error.status === 401) return false;
    if (!state.online || (error instanceof ApiError && error.code === 'NETWORK_ERROR')) {
      state.libraryError = '当前离线，文件夹保持上次成功读取的内容。恢复网络后重试。';
    } else {
      state.libraryError = error.message || '无法读取云端文件夹。';
    }
    if (!quiet) showToast(state.libraryError, 'error');
    return false;
  } finally {
    if (requestId === state.libraryRequestId) {
      state.libraryLoading = false;
      renderLibraryState();
      renderDocList();
    }
  }
}

/* ------------------------------------------------- import / shortcut */

const IMPORT_BUTTON_LABEL = '导入 Markdown';

function isShortcutDialogOpen() {
  return Boolean(els.shortcutDialog && !els.shortcutDialog.hidden);
}

function setShortcutError(message) {
  els.shortcutError.hidden = !message;
  els.shortcutError.textContent = message || '';
}

function syncImportAndShortcutButtons() {
  const offline = !state.authenticated || !state.online;
  els.importDoc.disabled = state.importBusy || offline;
  els.importDoc.textContent = state.importBusy ? '正在导入…' : IMPORT_BUTTON_LABEL;
  els.shortcutSettings.disabled = state.shortcutBusy || offline;
  els.shortcutGenerate.disabled = state.shortcutBusy || offline;
  els.shortcutRevoke.disabled = state.shortcutBusy || offline || !state.shortcutConfigured;
}

function randomImportRequestId() {
  const bytes = new Uint8Array(16);
  try {
    window.crypto.getRandomValues(bytes);
  } catch {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function importFileFingerprint(file) {
  return [file.name, file.size, file.lastModified || 0].join(':');
}

async function importMarkdownFile(file) {
  if (!file || state.importBusy || !state.authenticated) return;
  if (!state.online) {
    showToast('当前离线，无法导入。恢复网络后重试。', 'error');
    return;
  }
  const importName = String(file.name || '').trim();
  const extension = /\.[^./\\]*$/.exec(importName)?.[0] || '';
  if (!importName || (extension && !/^\.(?:md|markdown|txt)$/i.test(extension))) {
    showToast('请选择 Markdown 或纯文本文件，不支持此文件后缀。', 'error');
    return;
  }
  const maxBytes = Number(state.maxDocBytes) || 2 * 1024 * 1024;
  if (Number.isFinite(file.size) && file.size > maxBytes) {
    showToast(`文件超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`, 'error');
    return;
  }

  const authGeneration = state.authGeneration;
  const fingerprint = importFileFingerprint(file);
  // Reuse the requestId after a network/timeout failure so a retry cannot create
  // a second document. A deliberately selected different file gets a new id.
  const requestId = state.importPending?.fingerprint === fingerprint
    ? state.importPending.requestId
    : randomImportRequestId();
  state.importPending = { fingerprint, requestId };
  state.importBusy = true;
  syncImportAndShortcutButtons();

  try {
    const markdown = await file.text();
    showToast(`正在导入 ${file.name}…`, 'info');
    const payload = await api('/api/import/documents', {
      method: 'POST',
      csrf: true,
      timeoutMs: 60_000,
      body: { name: file.name, markdown, requestId },
    });
    if (authGeneration !== state.authGeneration || !state.authenticated) return;
    if (!payload?.doc?.id) {
      throw new ApiError('导入响应不完整。', 'BAD_RESPONSE', 500);
    }
    state.importPending = null;
    await loadDocuments({ autoOpen: false });
    await openDocument(payload.doc.id, { force: true, silent: true });
    showToast(`已导入 ${payload.doc.name}`, 'success');
  } catch (error) {
    // Keep the id only for failures where the server may have committed but the
    // response was lost. A validation error should allow a corrected file to
    // reuse the same requestId without a false conflict.
    const retryable = error instanceof ApiError
      && (error.status === 0 || error.status >= 500);
    if (!retryable) state.importPending = null;
    showToast(error.message || '导入失败，请检查网络后重试。', 'error');
  } finally {
    state.importBusy = false;
    syncImportAndShortcutButtons();
  }
}

function renderShortcutStatus(payload) {
  const configured = Boolean(payload?.configured);
  const valid = configured && Boolean(payload?.valid);
  state.shortcutConfigured = configured;
  if (!configured) {
    els.shortcutTokenStatus.textContent = '尚未生成';
  } else if (valid) {
    const rotated = formatTime(payload?.tokenInfo?.rotatedAt);
    els.shortcutTokenStatus.textContent = rotated ? `已启用 · ${rotated}` : '已启用';
  } else {
    els.shortcutTokenStatus.textContent = '已失效，请重新生成';
  }
  els.shortcutGenerate.textContent = configured ? '轮换令牌' : '生成令牌';
  els.shortcutRevoke.hidden = !configured;
  els.shortcutTokenHint.textContent = configured && !valid
    ? '密码重置或账户状态变化后，旧令牌会立即失效；重新生成即可。'
    : '令牌只用于创建新文档，不能读取现有文档，也不要在聊天或公开页面中分享。';
  syncImportAndShortcutButtons();
}

async function refreshShortcutStatus() {
  const authGeneration = state.authGeneration;
  state.shortcutBusy = true;
  setShortcutError('');
  syncImportAndShortcutButtons();
  try {
    const payload = await api('/api/import/token');
    if (!isShortcutDialogOpen()
      || authGeneration !== state.authGeneration
      || !state.authenticated) return;
    renderShortcutStatus(payload);
  } catch (error) {
    if (!isShortcutDialogOpen()
      || authGeneration !== state.authGeneration
      || !state.authenticated) return;
    els.shortcutTokenStatus.textContent = '无法读取状态';
    setShortcutError(error.message || '无法读取仅导入令牌状态。');
  } finally {
    state.shortcutBusy = false;
    syncImportAndShortcutButtons();
  }
}

let shortcutDownloadFile = null;
let shortcutDownloadPreparing = false;

async function prepareShortcutDownload() {
  if (shortcutDownloadPreparing) return;
  shortcutDownloadPreparing = true;
  shortcutDownloadFile = null;
  els.shortcutDownload.disabled = true;
  els.shortcutDownload.textContent = '正在准备文件…';
  try {
    const response = await fetch('/shortcuts/Open-in-Modu.shortcut', {
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('download failed');
    const blob = await response.blob();
    const file = new File([blob], '用墨读打开.shortcut', { type: 'application/x-apple-shortcut' });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      shortcutDownloadFile = file;
      els.shortcutDownload.textContent = '保存快捷指令文件';
    } else {
      els.shortcutDownload.textContent = '复制下载链接，在 Safari 中安装';
    }
  } catch {
    els.shortcutDownload.textContent = '复制下载链接，在 Safari 中安装';
  } finally {
    shortcutDownloadPreparing = false;
    els.shortcutDownload.disabled = false;
  }
}

async function saveShortcutDownload() {
  if (!shortcutDownloadFile) {
    return copyShortcutValue(els.shortcutDownloadUrl.value, els.shortcutDownloadUrl, '下载链接（请粘贴到 Safari 地址栏）');
  }
  // File is prefetched: invoke share inside the click activation, before any await.
  try {
    await navigator.share({ files: [shortcutDownloadFile] });
  } catch (error) {
    if (error.name !== 'AbortError') {
      setShortcutError('系统暂不支持保存此文件。请复制下载链接，在 Safari 地址栏中粘贴打开。');
    }
  }
}

function openShortcutDialog() {
  if (!state.authenticated || !state.online) return;
  state.shortcutToken = '';
  state.shortcutConfigured = false;
  els.shortcutTokenSecret.hidden = true;
  els.shortcutTokenValue.value = '';
  els.shortcutUrl.value = location.origin;
  els.shortcutDownloadUrl.value = new URL('/shortcuts/Open-in-Modu.shortcut', location.origin).href;
  prepareShortcutDownload();
  els.shortcutTokenStatus.textContent = '正在读取…';
  els.shortcutGenerate.textContent = '生成令牌';
  els.shortcutRevoke.hidden = true;
  els.shortcutRevoke.disabled = true;
  setShortcutError('');
  els.shortcutDialog.hidden = false;
  syncEdgeHitRegion();
  syncImportAndShortcutButtons();
  refreshShortcutStatus();
  requestAnimationFrame(() => els.shortcutClose.focus({ preventScroll: true }));
}

function closeShortcutDialog({ restoreFocus = true } = {}) {
  if (!isShortcutDialogOpen()) return;
  els.shortcutDialog.hidden = true;
  state.shortcutToken = '';
  els.shortcutTokenValue.value = '';
  els.shortcutTokenSecret.hidden = true;
  setShortcutError('');
  syncEdgeHitRegion();
  if (restoreFocus && state.authenticated) {
    els.shortcutSettings.focus({ preventScroll: true });
  }
}

async function generateShortcutToken() {
  if (state.shortcutBusy || !state.authenticated) return;
  const authGeneration = state.authGeneration;
  state.shortcutBusy = true;
  setShortcutError('');
  syncImportAndShortcutButtons();
  try {
    const payload = await api('/api/import/token', {
      method: 'POST',
      csrf: true,
      body: {},
    });
    if (authGeneration !== state.authGeneration || !state.authenticated) return;
    if (!payload?.token) {
      throw new ApiError('令牌响应不完整。', 'BAD_RESPONSE', 500);
    }
    state.shortcutToken = payload.token;
    state.shortcutConfigured = true;
    els.shortcutTokenValue.value = payload.token;
    els.shortcutTokenSecret.hidden = false;
    els.shortcutTokenStatus.textContent = '已生成，请立即复制';
    els.shortcutGenerate.textContent = '轮换令牌';
    els.shortcutRevoke.hidden = false;
    els.shortcutTokenHint.textContent = '这个令牌只显示一次。关闭对话框后无法再次查看；请立即粘贴到快捷指令。';
    showToast('已生成仅导入令牌，请立即复制到快捷指令。', 'success');
    els.shortcutTokenValue.focus({ preventScroll: true });
    els.shortcutTokenValue.select();
  } catch (error) {
    setShortcutError(error.message || '生成令牌失败，请稍后重试。');
  } finally {
    state.shortcutBusy = false;
    syncImportAndShortcutButtons();
  }
}

async function revokeShortcutToken() {
  if (state.shortcutBusy || !state.authenticated) return;
  const authGeneration = state.authGeneration;
  state.shortcutBusy = true;
  setShortcutError('');
  syncImportAndShortcutButtons();
  try {
    await api('/api/import/token', {
      method: 'DELETE',
      csrf: true,
      body: {},
    });
    if (authGeneration !== state.authGeneration || !state.authenticated) return;
    state.shortcutToken = '';
    state.shortcutConfigured = false;
    els.shortcutTokenValue.value = '';
    els.shortcutTokenSecret.hidden = true;
    els.shortcutTokenStatus.textContent = '尚未生成';
    els.shortcutGenerate.textContent = '生成令牌';
    els.shortcutRevoke.hidden = true;
    els.shortcutTokenHint.textContent = '令牌只用于创建新文档，不能读取现有文档，也不要在聊天或公开页面中分享。';
    showToast('已撤销仅导入令牌，快捷指令将无法继续导入。', 'success');
  } catch (error) {
    setShortcutError(error.message || '撤销令牌失败，请稍后重试。');
  } finally {
    state.shortcutBusy = false;
    syncImportAndShortcutButtons();
  }
}

async function copyShortcutValue(value, input, label) {
  if (!value) {
    showToast('没有可复制的内容。', 'info');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      input.focus({ preventScroll: true });
      input.select();
      document.execCommand('copy');
    }
    showToast(`${label}已复制。`, 'success');
  } catch {
    input.focus({ preventScroll: true });
    input.select();
    showToast('无法自动复制，请手动选择文本复制。', 'error');
  }
}

/* ------------------------------------------------------ library dialog */

function isLibraryDialogOpen() {
  return Boolean(els.libraryDialog && !els.libraryDialog.hidden);
}

function setLibraryDialogError(message, kind = 'error') {
  els.libraryDialogError.hidden = !message;
  els.libraryDialogError.dataset.kind = kind;
  els.libraryDialogError.textContent = message || '';
}

function populateLibraryParentSelect(selectedId, excludeIds = new Set(), rootLabel = '未归档（根目录）') {
  els.libraryParent.replaceChildren();
  const root = document.createElement('option');
  root.value = '';
  root.textContent = rootLabel;
  els.libraryParent.append(root);

  const addBranch = (parentId, depth) => {
    if (depth > 12) return;
    for (const folder of folderChildren(parentId)) {
      if (excludeIds.has(folder.id)) continue;
      const option = document.createElement('option');
      option.value = folder.id;
      option.textContent = `${'— '.repeat(depth)}${folder.name}`;
      els.libraryParent.append(option);
      addBranch(folder.id, depth + 1);
    }
  };
  addBranch(null, 0);
  if (selectedId && state.library.folders.some((folder) => folder.id === selectedId)
    && !excludeIds.has(selectedId)) {
    els.libraryParent.value = selectedId;
  } else {
    els.libraryParent.value = '';
  }
}

function validateFolderName(raw) {
  const name = String(raw || '').trim();
  const length = Array.from(name).length;
  if (!name) return { ok: false, message: '请填写文件夹名称。' };
  if (length > 80) return { ok: false, message: '文件夹名称不能超过 80 个字符。' };
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, message: '文件夹名称不能包含斜杠或控制字符。' };
  }
  return { ok: true, name };
}

function renderLibraryDialog(initial = true) {
  const dialog = state.libraryDialog;
  if (!dialog) return;
  const folder = dialog.folderId ? folderById(dialog.folderId) : null;
  const doc = dialog.docId
    ? state.documents.find((entry) => entry.id === dialog.docId) || null
    : null;
  const mode = dialog.mode;
  els.libraryNameField.hidden = true;
  els.libraryParentField.hidden = true;
  els.libraryDialogSubject.hidden = true;
  els.libraryDialogSubmit.classList.remove('is-danger');
  els.libraryDialogSubmit.disabled = false;

  if (mode === 'create-folder') {
    els.libraryDialogKicker.textContent = 'NEW FOLDER';
    els.libraryDialogTitle.textContent = '新建文件夹';
    els.libraryDialogCopy.textContent = '文件夹只整理云端文库，不会移动 Mac 上的原文件，也不会改变同步设置。';
    els.libraryNameField.hidden = false;
    els.libraryParentField.hidden = false;
    els.libraryDialogSubmit.textContent = '创建文件夹';
    if (initial) {
      els.libraryName.value = '';
      const selected = state.libraryView.kind === LIBRARY_VIEW_FOLDER
        ? state.libraryView.folderId
        : '';
      populateLibraryParentSelect(selected, new Set(), '根目录（无上级）');
    }
  } else if (mode === 'rename-folder') {
    if (!folder) return closeLibraryDialog();
    els.libraryDialogKicker.textContent = 'RENAME FOLDER';
    els.libraryDialogTitle.textContent = '重命名文件夹';
    els.libraryDialogCopy.textContent = '只改变云端文件夹名称；文稿归类与本地文件保持不变。';
    els.libraryNameField.hidden = false;
    els.libraryDialogSubmit.textContent = '保存名称';
    if (initial) els.libraryName.value = folder.name;
  } else if (mode === 'move-folder') {
    if (!folder) return closeLibraryDialog();
    els.libraryDialogKicker.textContent = 'MOVE FOLDER';
    els.libraryDialogTitle.textContent = '移动文件夹';
    els.libraryDialogCopy.textContent = '选择新的上级位置。不能把文件夹移动到它自己或它的子文件夹里。';
    els.libraryParentField.hidden = false;
    els.libraryDialogSubmit.textContent = '移动文件夹';
    if (initial) populateLibraryParentSelect(folder.parentId, folderDescendantIds(folder.id), '根目录（无上级）');
  } else if (mode === 'delete-folder') {
    if (!folder) return closeLibraryDialog();
    els.libraryDialogKicker.textContent = 'DELETE FOLDER';
    els.libraryDialogTitle.textContent = '删除文件夹';
    els.libraryDialogCopy.textContent = '只删除文件夹本身。里面的子文件夹和文稿会自动移到上一级，文稿不会被删除。';
    els.libraryDialogSubject.hidden = false;
    els.libraryDialogSubject.textContent = folder.name;
    els.libraryDialogSubmit.textContent = '确认删除文件夹';
    els.libraryDialogSubmit.classList.add('is-danger');
  } else if (mode === 'move-document') {
    if (!doc) return closeLibraryDialog();
    els.libraryDialogKicker.textContent = 'MOVE DOCUMENT';
    els.libraryDialogTitle.textContent = '移动文稿';
    els.libraryDialogCopy.textContent = '只改变云端文库中的归类，不移动 Mac 上的原文件，也不改变同步配置。';
    els.libraryDialogSubject.hidden = false;
    els.libraryDialogSubject.textContent = doc.name;
    els.libraryParentField.hidden = false;
    els.libraryDialogSubmit.textContent = '移动文稿';
    if (initial) populateLibraryParentSelect(docFolderId(doc));
  }
  syncLibraryDialogOptions();
}

function openLibraryDialog(mode, { folderId = '', docId = '' } = {}) {
  if (!state.authenticated || !state.libraryLoaded) return;
  if (!state.online) {
    showToast('当前离线，无法整理文件夹。', 'error');
    return;
  }
  cancelDocumentDrag();
  if (isLibraryDialogOpen()) closeLibraryDialog({ restoreFocus: false });
  resetEdgeGesture();
  state.libraryDialog = {
    mode,
    folderId,
    docId,
    baseRevision: state.library.revision,
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  state.libraryDialogBusy = false;
  setLibraryDialogError('');
  els.libraryForm.reset();
  renderLibraryDialog();
  els.libraryDialog.hidden = false;
  document.body.classList.add('library-dialog-open');
  syncEdgeHitRegion();
  const focusTarget = !els.libraryNameField.hidden
    ? els.libraryName
    : (!els.libraryParentField.hidden ? els.libraryParent : els.libraryDialogSubmit);
  window.setTimeout(() => focusTarget?.focus(), 20);
}

function closeLibraryDialog({ restoreFocus = true } = {}) {
  if (!isLibraryDialogOpen()) {
    state.libraryDialog = null;
    state.libraryDialogBusy = false;
    return;
  }
  const opener = state.libraryDialog?.opener;
  els.libraryDialog.hidden = true;
  document.body.classList.remove('library-dialog-open');
  state.libraryDialog = null;
  state.libraryDialogBusy = false;
  setLibraryDialogError('');
  syncEdgeHitRegion();
  if (restoreFocus && opener?.isConnected) {
    window.setTimeout(() => opener.focus({ preventScroll: true }), 0);
  }
}

function syncLibraryDialogOptions() {
  const dialog = state.libraryDialog;
  if (!dialog) return;
  const folder = dialog.folderId ? folderById(dialog.folderId) : null;
  const doc = dialog.docId
    ? state.documents.find((entry) => entry.id === dialog.docId) || null
    : null;
  if ((dialog.mode.includes('folder') && dialog.mode !== 'create-folder' && !folder)
    || (dialog.mode === 'move-document' && !doc)) {
    setLibraryDialogError('这份内容已在其他设备被移动或删除。已刷新文库，请关闭后重新选择。', 'conflict');
    els.libraryDialogSubmit.disabled = true;
    return;
  }
  if (!els.libraryParentField.hidden) {
    const previous = els.libraryParent.value;
    const exclude = dialog.mode === 'move-folder' && folder
      ? folderDescendantIds(folder.id)
      : new Set();
    populateLibraryParentSelect(
      previous,
      exclude,
      dialog.mode === 'move-document' ? '未归档（根目录）' : '根目录（无上级）',
    );
  }
}

async function submitLibraryDialog() {
  const dialog = state.libraryDialog;
  if (!dialog || state.libraryDialogBusy) return;
  if (!state.online) {
    setLibraryDialogError('当前离线，无法保存。恢复网络后重试。', 'offline');
    return;
  }

  let action = '';
  let payload = {};
  const asyncName = validateFolderName(els.libraryName.value);
  if (dialog.mode === 'create-folder') {
    if (!asyncName.ok) return setLibraryDialogError(asyncName.message);
    action = 'createFolder';
    payload = {
      action,
      name: asyncName.name,
      parentId: els.libraryParent.value || null,
    };
  } else if (dialog.mode === 'rename-folder') {
    if (!asyncName.ok) return setLibraryDialogError(asyncName.message);
    if (!folderById(dialog.folderId)) {
      setLibraryDialogError('该文件夹已不存在。请关闭后刷新。');
      return;
    }
    action = 'renameFolder';
    payload = { action, folderId: dialog.folderId, name: asyncName.name };
  } else if (dialog.mode === 'move-folder') {
    if (!folderById(dialog.folderId)) {
      setLibraryDialogError('该文件夹已不存在。请关闭后刷新。');
      return;
    }
    const parentId = els.libraryParent.value || null;
    if (parentId && folderDescendantIds(dialog.folderId).has(parentId)) {
      setLibraryDialogError('不能把文件夹移动到它自己或它的子文件夹里。');
      return;
    }
    if (parentId && !folderById(parentId)) {
      setLibraryDialogError('目标文件夹已不存在。请重新选择。');
      return;
    }
    action = 'moveFolder';
    payload = { action, folderId: dialog.folderId, parentId };
  } else if (dialog.mode === 'delete-folder') {
    if (!folderById(dialog.folderId)) {
      setLibraryDialogError('该文件夹已不存在。请关闭后刷新。');
      return;
    }
    action = 'deleteFolder';
    payload = { action, folderId: dialog.folderId };
  } else if (dialog.mode === 'move-document') {
    const doc = state.documents.find((entry) => entry.id === dialog.docId);
    if (!doc) {
      setLibraryDialogError('这份文稿已不在文库。请关闭后刷新。');
      return;
    }
    const folderId = els.libraryParent.value || null;
    if (folderId && !folderById(folderId)) {
      setLibraryDialogError('目标文件夹已不存在。请重新选择。');
      return;
    }
    action = 'moveDocument';
    payload = { action, docId: doc.id, folderId };
  } else {
    return;
  }

  const beforeFolder = dialog.folderId ? folderById(dialog.folderId) : null;
  const beforeDoc = dialog.docId
    ? state.documents.find((entry) => entry.id === dialog.docId) || null
    : null;
  state.libraryDialogBusy = true;
  els.libraryDialogSubmit.disabled = true;
  els.libraryDialogSubmit.textContent = '正在保存…';
  setLibraryDialogError('');
  let conflicted = false;
  try {
    await mutateLibrary({ ...payload, revision: dialog.baseRevision });
    if (dialog.mode === 'delete-folder' && beforeFolder) {
      state.libraryView = beforeFolder.parentId
        ? { kind: LIBRARY_VIEW_FOLDER, folderId: beforeFolder.parentId }
        : { kind: LIBRARY_VIEW_ALL, folderId: '' };
    }
    closeLibraryDialog();
    renderFolderTree();
    renderLibraryBreadcrumb();
    renderLibraryState();
    renderDocList();
    showToast(action === 'moveDocument'
      ? `已移动 ${beforeDoc?.name || '文稿'}。`
      : action === 'deleteFolder'
        ? '文件夹已删除；文稿与子文件夹已保留。'
        : '云端文件夹已更新。', 'success');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    if (error instanceof ApiError && error.code === 'LIBRARY_CONFLICT') {
      conflicted = true;
      state.libraryConflict = true;
      await refreshLibrary({ quiet: true });
      if (!isLibraryDialogOpen()) return;
      // The user's local edit is kept, while the next explicit click submits
      // against the freshly fetched revision. Nothing is replayed silently.
      state.libraryDialog.baseRevision = state.library.revision;
      syncLibraryDialogOptions();
      setLibraryDialogError(
        '云端文库已在其他设备更新，已载入最新文件夹。请确认后再次提交，不会自动覆盖。',
        'conflict',
      );
    } else {
      if (error instanceof ApiError && error.status === 404) {
        await refreshLibrary({ quiet: true });
      }
      setLibraryDialogError(error.message || '保存失败，请检查网络后重试。');
    }
  } finally {
    if (isLibraryDialogOpen()) {
      state.libraryDialogBusy = false;
      els.libraryDialogSubmit.disabled = false;
      const current = state.libraryDialog;
      if (current) {
        els.libraryDialogSubmit.textContent = conflicted
          ? '确认后重试'
          : current.mode === 'delete-folder'
            ? '确认删除文件夹'
            : current.mode === 'move-folder'
              ? '移动文件夹'
              : current.mode === 'move-document'
                ? '移动文稿'
                : current.mode === 'rename-folder'
                  ? '保存名称'
                  : '创建文件夹';
      }
      syncLibraryDialogOptions();
    }
  }
}

function openMoveDocumentDialog(docId) {
  openLibraryDialog('move-document', { docId });
}

/* ------------------------------------------------------- document drag */

function canStartDocumentDrag() {
  return state.authenticated
    && state.libraryLoaded
    && state.online
    && !state.libraryLoading
    && !state.libraryDialogBusy
    && !state.docDragBusy
    && !isLibraryDialogOpen();
}

function documentDropTargetAt(clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const node = document.elementFromPoint(clientX, clientY);
  if (!(node instanceof Element)) return null;
  const root = node.closest('[data-drop-root]');
  if (root) return { element: root, folderId: null };
  const folderNode = node.closest('[data-drop-folder]');
  if (!folderNode) return null;
  const folderId = folderNode.dataset.dropFolder || '';
  if (!folderId || !folderById(folderId)) return null;
  return { element: folderNode, folderId };
}

function clearDocumentDropTarget(drag) {
  drag.target?.element?.classList.remove('is-drop-target');
  drag.target = null;
}

function updateDocumentDropTarget(drag) {
  const target = documentDropTargetAt(drag.lastX, drag.lastY);
  const currentFolderId = drag.currentFolderId || null;
  if (!target || (target.folderId || null) === currentFolderId) {
    clearDocumentDropTarget(drag);
    return;
  }
  if (drag.target?.element !== target.element) {
    clearDocumentDropTarget(drag);
    target.element.classList.add('is-drop-target');
  }
  drag.target = target;
}

function createDocumentDragGhost(drag) {
  const ghost = document.createElement('div');
  ghost.className = 'doc-drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  const grip = document.createElement('span');
  grip.className = 'drag-grip';
  for (let index = 0; index < 3; index += 1) grip.append(document.createElement('i'));
  const label = document.createElement('span');
  label.className = 'doc-item-name';
  label.textContent = drag.docName;
  ghost.append(grip, label);
  document.body.append(ghost);
  drag.ghost = ghost;
  positionDocumentDragGhost(drag);
}

function positionDocumentDragGhost(drag) {
  if (!drag.ghost) return;
  const margin = 8;
  const width = drag.ghost.offsetWidth || 0;
  const height = drag.ghost.offsetHeight || 0;
  const left = edgeClamp(drag.lastX + 14, margin, Math.max(margin, window.innerWidth - width - margin));
  const top = edgeClamp(drag.lastY - 18, margin, Math.max(margin, window.innerHeight - height - margin));
  drag.ghost.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function stopDocumentDragAutoScroll(drag) {
  if (!drag.autoScrollFrame) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(drag.autoScrollFrame);
  drag.autoScrollFrame = 0;
}

// Only the folder tree auto-scrolls. The finger may stay still at an edge, so
// this is a frame loop rather than a pointermove-only calculation.
function startDocumentDragAutoScroll(drag) {
  if (drag.autoScrollFrame || !els.folderTree) return;
  const step = () => {
    if (state.docDrag !== drag || !drag.dragging) {
      drag.autoScrollFrame = 0;
      return;
    }
    const rect = els.folderTree.getBoundingClientRect();
    const withinX = drag.lastX >= rect.left - 18 && drag.lastX <= rect.right + 18;
    let delta = 0;
    if (withinX && drag.lastY >= rect.top - 18 && drag.lastY <= rect.bottom + 18) {
      if (drag.lastY < rect.top + DOC_DRAG_TREE_EDGE_PX) {
        delta = -Math.ceil((rect.top + DOC_DRAG_TREE_EDGE_PX - drag.lastY) / 3);
      } else if (drag.lastY > rect.bottom - DOC_DRAG_TREE_EDGE_PX) {
        delta = Math.ceil((drag.lastY - (rect.bottom - DOC_DRAG_TREE_EDGE_PX)) / 3);
      }
    }
    delta = edgeClamp(delta, -DOC_DRAG_TREE_SCROLL_MAX, DOC_DRAG_TREE_SCROLL_MAX);
    if (delta) {
      const before = els.folderTree.scrollTop;
      els.folderTree.scrollTop = before + delta;
      if (els.folderTree.scrollTop !== before) updateDocumentDropTarget(drag);
    }
    drag.autoScrollFrame = requestAnimationFrame(step);
  };
  drag.autoScrollFrame = requestAnimationFrame(step);
}

function beginDocumentDrag(drag) {
  drag.dragging = true;
  drag.row = drag.handle.closest('.doc-row');
  drag.row?.classList.add('is-dragging');
  drag.handle.classList.add('is-dragging');
  document.body.classList.add('library-doc-dragging');
  // The library drawer owns the left edge while open; cancelling any stale
  // edge state keeps the two gestures from ever sharing a finger.
  resetEdgeGesture();
  createDocumentDragGhost(drag);
  startDocumentDragAutoScroll(drag);
}

function cleanupDocumentDrag(drag) {
  stopDocumentDragAutoScroll(drag);
  clearDocumentDropTarget(drag);
  drag.ghost?.remove();
  drag.ghost = null;
  drag.row?.classList.remove('is-dragging');
  drag.handle?.classList.remove('is-dragging');
  document.body.classList.remove('library-doc-dragging');
  try {
    if (drag.handle?.hasPointerCapture?.(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
  } catch {
    // Synthetic or already-released pointers have nothing to release.
  }
  if (state.docDrag === drag) state.docDrag = null;
}

function endDocumentDrag({ target = null, cancelled = false } = {}) {
  const drag = state.docDrag;
  if (!drag) return;
  const wasDragging = drag.dragging;
  const snapshot = {
    docId: drag.docId,
    docName: drag.docName,
    baseRevision: drag.baseRevision,
    currentFolderId: drag.currentFolderId || null,
  };
  cleanupDocumentDrag(drag);
  if (!wasDragging) return;
  // A real drag must never become a document tap on release. The capture-phase
  // click guard in bindEvents consumes the compatibility click.
  state.docDragSuppressClickUntil = Date.now() + DOC_DRAG_CLICK_SUPPRESS_MS;
  if (cancelled || !target) return;
  const folderId = target.folderId || null;
  if (folderId === snapshot.currentFolderId) {
    showToast('文稿已在这个文件夹。', 'info');
    return;
  }
  if (folderId && !folderById(folderId)) {
    showToast('目标文件夹已不存在，请刷新后重试。', 'error');
    return;
  }
  void moveDocumentByDrop(snapshot.docId, folderId, snapshot.baseRevision, snapshot.docName);
}

function cancelDocumentDrag() {
  const drag = state.docDrag;
  if (!drag) return false;
  endDocumentDrag({ cancelled: true });
  return true;
}

function onDocumentDragPointerDown(event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (state.docDrag) {
    cancelDocumentDrag();
    return;
  }
  if (!event.isPrimary) return;
  if (!canStartDocumentDrag()) return;
  const handle = event.currentTarget;
  const docId = handle?.dataset?.moveDocId || '';
  const doc = state.documents.find((entry) => entry.id === docId);
  if (!doc) return;
  const drag = {
    docId,
    docName: doc.name,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    baseRevision: state.library.revision,
    currentFolderId: docFolderId(doc) || null,
    handle,
    row: null,
    ghost: null,
    target: null,
    autoScrollFrame: 0,
    dragging: false,
  };
  state.docDrag = drag;
  resetEdgeGesture();
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic pointer events and some older WebKit builds do not support
    // capture; the window-level move/up listeners still own the sequence.
  }
}

function onDocumentDragPointerMove(event) {
  const drag = state.docDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  if (!drag.dragging) {
    const distance = Math.hypot(drag.lastX - drag.startX, drag.lastY - drag.startY);
    if (distance < DOC_DRAG_START_PX) return;
    beginDocumentDrag(drag);
  }
  if (event.cancelable) event.preventDefault();
  positionDocumentDragGhost(drag);
  updateDocumentDropTarget(drag);
}

function onDocumentDragPointerUp(event) {
  const drag = state.docDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  if (event.cancelable && drag.dragging) event.preventDefault();
  const target = drag.dragging ? documentDropTargetAt(event.clientX, event.clientY) : null;
  endDocumentDrag({ target });
}

function onDocumentDragPointerCancel(event) {
  const drag = state.docDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  cancelDocumentDrag();
}

function onAnyDocumentPointerDown(event) {
  // A second finger anywhere must abandon the drag rather than let one finger
  // scroll or pinch while the other still owns a floating document.
  const drag = state.docDrag;
  if (!drag || event.pointerId === drag.pointerId) return;
  cancelDocumentDrag();
}

function onDocumentDragHandleClick(event) {
  if (Date.now() < state.docDragSuppressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const docId = event.currentTarget?.dataset?.moveDocId || '';
  if (!docId) return;
  event.preventDefault();
  openMoveDocumentDialog(docId);
}

async function moveDocumentByDrop(docId, folderId, baseRevision, docName) {
  if (!state.authenticated) return;
  if (!state.online) {
    showToast('当前离线，文稿未移动。恢复网络后重试。', 'error');
    return;
  }
  if (state.docDragBusy) {
    showToast('上一次移动仍在保存，请稍后重试。', 'info');
    return;
  }
  if (!state.documents.some((entry) => entry.id === docId)) {
    showToast('这份文稿已不在文库。', 'error');
    return;
  }
  if (folderId && !folderById(folderId)) {
    showToast('目标文件夹已不存在，请刷新后重试。', 'error');
    return;
  }
  state.docDragBusy = true;
  try {
    await mutateLibrary({
      action: 'moveDocument',
      docId,
      folderId,
      revision: baseRevision,
    });
    showToast(`已移动 ${docName}。`, 'success');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    if (error instanceof ApiError && error.code === 'LIBRARY_CONFLICT') {
      // Never replay a drag against a new revision: show the refreshed state
      // and let the user decide whether to try again.
      state.libraryConflict = true;
      await refreshLibrary({ quiet: true });
      showToast('云端文库已在其他设备更新，已刷新；本次拖动未保存，请重试。', 'error');
      return;
    }
    if (error instanceof ApiError && error.status === 404) {
      await refreshLibrary({ quiet: true }).catch(() => {});
    }
    showToast(error.message || '移动失败，请检查网络后重试。', 'error');
  } finally {
    state.docDragBusy = false;
    if (state.authenticated) renderDocList();
  }
}

function resetLibraryState() {
  cancelDocumentDrag();
  closeShortcutDialog({ restoreFocus: false });
  state.importBusy = false;
  state.importPending = null;
  state.docDragBusy = false;
  state.docDragSuppressClickUntil = 0;
  closeLibraryDialog({ restoreFocus: false });
  state.libraryRequestId += 1;
  state.library = { revision: 0, folders: [], assignments: {} };
  state.libraryLoaded = false;
  state.libraryLoading = false;
  state.libraryError = '';
  state.libraryConflict = false;
  state.librarySignature = '';
  state.libraryView = { kind: LIBRARY_VIEW_ALL, folderId: '' };
  els.folderTree.replaceChildren();
  els.folderBreadcrumb.replaceChildren();
  els.folderActions.hidden = true;
  els.libraryState.hidden = true;
  els.libraryStateRetry.hidden = true;
  els.libraryEmpty.hidden = true;
}

async function loadDocuments({ autoOpen = true } = {}) {
  // A bootstrap request already carries the list; do not race it with a
  // second list fetch during startup or restore.
  if (state.bootstrapPromise) return state.documents;
  const authGeneration = state.authGeneration;
  const payload = await api('/api/documents', { timeoutMs: BOOTSTRAP_TIMEOUT_MS });
  // A list response that started before logout/account change must not
  // repopulate the next screen with the previous account's documents.
  if (authGeneration !== state.authGeneration || !state.authenticated) return state.documents;
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  if (Number(payload.maxDocBytes) > 0) state.maxDocBytes = Number(payload.maxDocBytes);
  const nextSignature = documentSignature(documents);
  const changed = nextSignature !== state.documentSignature;
  state.documents = documents;
  state.documentSignature = nextSignature;
  let libraryChanged = false;
  if (payload.library && typeof payload.library === 'object') {
    const before = state.librarySignature;
    setLibrary(payload.library, { loaded: true });
    libraryChanged = before !== state.librarySignature;
    state.libraryError = '';
  }
  if (changed || libraryChanged) {
    renderFolderTree();
    renderLibraryBreadcrumb();
    renderDocList();
    if (isLibraryDialogOpen()) syncLibraryDialogOptions();
  }
  renderLibraryState();
  const known = documents.some((doc) => doc.id === state.currentDoc?.id);
  if (state.currentDoc && !known) showWelcome();
  if (autoOpen
    && !state.currentDoc
    && !state.loadingDocId
    && documents.length
    && currentHistoryView() !== 'library') {
    const preferred = preferredDocId();
    const candidate = documents.find((doc) => doc.id === preferred) || documents[0];
    await openDocument(candidate.id, { silent: true });
  }
  return state.documents;
}

async function openDocument(id, { silent = false, force = false, historyMode = 'auto' } = {}) {
  if (!state.authenticated) return;
  const commitHistory = () => {
    if (historyMode !== 'none') commitReaderHistory(id);
  };

  // Re-selecting the document already on screen must not rebuild the long
  // reading pane. If another document is still loading, cancel it and return
  // to the visible document immediately.
  if (state.currentDoc?.id === id && !force) {
    if (state.loadingDocId && state.loadingDocId !== id) {
      cancelDocumentLoad();
      renderDocList();
      updateOfflineState();
    }
    commitHistory();
    closeLibrary();
    els.reader.focus({ preventScroll: true });
    return;
  }
  if (state.loadingDocId === id) {
    commitHistory();
    closeLibrary();
    els.reader.focus({ preventScroll: true });
    return;
  }

  const authGeneration = state.authGeneration;
  const generation = state.documentGeneration + 1;
  state.documentGeneration = generation;
  if (state.documentRequest) {
    state.documentRequest.abort();
    state.documentRequest = null;
  }

  // Immediate feedback: select the card, close the iPad drawer so the reader
  // is visible, and paint the overlay before any synchronous Markdown work.
  // History moves with the visible reader; a failed load is rolled back below.
  commitHistory();
  showDocumentLoading(id);
  renderDocList();
  closeLibrary();
  hideAlert();
  setStatus('loading', '正在读取', '从云端取回文稿信息…');
  await afterNextPaint();
  if (!isDocumentLoadCurrent(id, generation, authGeneration)) return;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  state.documentRequest = controller;
  try {
    const payload = await api(`/api/documents/${id}`, {
      timeoutMs: documentTimeoutMs(),
      signal: controller?.signal,
    });
    if (!isDocumentLoadCurrent(id, generation, authGeneration)) return;
    if (!payload?.doc || payload.doc.id !== id) {
      throw new ApiError('文档响应不完整。', 'BAD_RESPONSE', 500);
    }
    const same = state.currentDoc?.id === payload.doc.id;
    const kind = documentKind(payload.doc);
    if (kind === 'html') {
      renderHtmlDocument({
        ...payload.doc,
        position: payload.doc.position,
      }, { preserve: same });
    } else {
      renderDocument({
        ...payload.doc,
        position: payload.doc.position,
      }, { preserve: same });
    }
    state.currentDoc = {
      id: payload.doc.id,
      name: payload.doc.name,
      kind,
      revision: payload.doc.revision,
      size: payload.doc.size,
      updatedAt: payload.doc.updatedAt,
      previewUrl: payload.doc.previewUrl,
    };
    state.currentMarkdown = typeof payload.doc.markdown === 'string' ? payload.doc.markdown : '';
    state.positionData = payload.doc.position;
    syncEdgeHitRegion();
    if (state.session) {
      safeSessionSet(STORAGE_LAST_PREFIX + state.session.id, id);
    }
    if (!silent) showToast(`已打开 ${payload.doc.name}`, 'success');
    schedulePoll();
    els.reader.focus({ preventScroll: true });
  } catch (error) {
    // A newer click, logout or restore already owns the UI. Never let this
    // request write an error or content over that newer state.
    if (!isDocumentLoadCurrent(id, generation, authGeneration)) return;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized(error.message);
      return;
    }
    // If a switch failed, point history back at the document still visible
    // instead of leaving a reader URL for content that never loaded.
    const restoreHistory = () => {
      if (historyMode === 'none') return;
      if (state.currentDoc
        && currentHistoryView() === 'reader'
        && currentHistoryState()?.docId === id) {
        commitReaderHistory(state.currentDoc.id);
      } else if (!state.currentDoc) {
        ensureLibraryHistory();
      }
    };
    if (error instanceof ApiError && (error.status === 404 || error.code === 'DOCUMENT_NOT_FOUND')) {
      showToast('这份文稿已不在云端文库。', 'error');
      await loadDocuments().catch(() => {});
      restoreHistory();
      return;
    }
    setStatus('error', '读取失败', error.message || '无法读取云端文稿。');
    showAlert('error', '无法读取文稿', error.message || '请检查网络后重试。');
    restoreHistory();
  } finally {
    if (state.documentRequest === controller) state.documentRequest = null;
    if (generation === state.documentGeneration) {
      // An HTML frame owns the overlay until its load/timeout settles.
      if (!state.htmlFramePending || state.loadingDocId !== state.currentDoc?.id) clearDocumentLoading();
      // Restore the card highlight to the document actually still displayed.
      renderDocList();
    }
  }
}

/* --------------------------------------------------------------- poll */

async function pollDocument() {
  if (!state.authenticated || !state.currentDoc || state.loadingDocId) return;
  const id = state.currentDoc.id;
  const revision = state.currentDoc.revision;
  const authGeneration = state.authGeneration;
  const generation = state.documentGeneration;
  const stillCurrent = () => state.authenticated
    && state.authGeneration === authGeneration
    && state.documentGeneration === generation
    && !state.loadingDocId
    && state.currentDoc?.id === id
    && state.currentDoc?.revision === revision;
  try {
    const result = await api(`/api/documents/${id}`, {
      etag: `"rev-${revision}"`,
    });
    if (!stillCurrent()) return;
    if (result.notModified) {
      setStatus('live', '已同步', `${state.currentDoc.kind === 'html' ? 'HTML · ' : '只读 · '}检查于 ${formatTime(new Date().toISOString())}`);
      hideAlert();
      return;
    }
    if (!result?.doc) return;
    const kind = documentKind(result.doc);
    const changed = result.doc.revision !== state.currentDoc.revision
      || kind !== state.currentDoc.kind;
    state.currentDoc = {
      id: result.doc.id,
      name: result.doc.name,
      kind,
      revision: result.doc.revision,
      size: result.doc.size,
      updatedAt: result.doc.updatedAt,
      previewUrl: result.doc.previewUrl,
    };
    state.currentMarkdown = typeof result.doc.markdown === 'string' ? result.doc.markdown : '';
    if (changed) {
      if (kind === 'html') {
        // Only a revision change reaches here: unchanged polls return 304 and
        // never reload the iframe, preserving widget state.
        renderHtmlDocument(result.doc, { preserve: true });
      } else {
        renderDocument(result.doc, { preserve: true });
      }
      showToast(kind === 'html'
        ? 'HTML 页面已更新，交互状态已重置。'
        : '云端文稿已更新，阅读位置已尽量保留。', 'success');
    }
    renderDocList();
  } catch (error) {
    // A delayed poll for A must not report an error or restore content after
    // the user has switched to B, logged out, or restored a new session.
    if (!stillCurrent()) return;
    if (error instanceof ApiError && error.status === 401) return;
    if (error instanceof ApiError && error.status === 404) {
      showWelcome();
      await loadDocuments().catch(() => {});
      return;
    }
    setStatus('offline', '连接中断', '正在重试；正文保留在当前页面，不从缓存冒充');
    showAlert('warning', '连接中断', '云端暂时不可达。页面会继续重试；不会缓存或展示其他账户的内容。');
  }
}

function schedulePoll(delay = POLL_MS) {
  window.clearTimeout(state.pollTimer);
  if (!state.authenticated) return;
  state.pollTimer = window.setTimeout(async () => {
    if (!state.authenticated) return;
    if (document.hidden) {
      schedulePoll();
      return;
    }
    state.pollCount += 1;
    await pollDocument();
    if (state.authenticated && state.pollCount % 3 === 0) {
      try {
        await loadDocuments();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return;
      }
    }
    schedulePoll();
  }, delay);
}

/* -------------------------------------------------------- edge gesture */

function findTouch(list, identifier) {
  for (let index = 0; index < list.length; index += 1) {
    const touch = list[index];
    if (touch && touch.identifier === identifier) return touch;
  }
  return null;
}

function isReaderGestureTarget(target) {
  return !(target instanceof Element)
    || !target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="slider"], video, audio');
}

function hasTouchInput() {
  // This strip exists only to suppress a touch-only browser gesture. Do not
  // cover left-edge controls for mouse/keyboard users on a narrow window.
  return navigator.maxTouchPoints > 0 || /iPad|iPhone|iPod/.test(navigator.userAgent || '');
}

function canUseEdgeGesture() {
  return state.authenticated
    && Boolean(state.currentDoc)
    && !state.libraryOpen
    && state.view !== 'library'
    && !isLibraryDialogOpen()
    && !isShortcutDialogOpen()
    && isNarrowLayout()
    && hasTouchInput()
    && !els.shell.hidden;
}

function syncEdgeHitRegion() {
  const armed = canUseEdgeGesture();
  if (!els.edgeNav) return;
  els.edgeNav.hidden = !armed;
  if (!armed) state.edgeTouch = null;
}

function edgeClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function edgeOpenDistance(width) {
  return Math.min(EDGE_OPEN_MAX_PX, Math.max(EDGE_OPEN_PX, width * EDGE_OPEN_WIDTH_RATIO));
}

// Clear every drag-only style. Normal CSS transitions then take the drawer
// back to its committed open/closed position; the scrim is always either
// hidden or owned by an actually open drawer.
function resetEdgeGesture() {
  state.edgeTouch = null;
  if (!els.library) return;
  els.library.classList.remove('is-dragging');
  els.library.style.removeProperty('transform');
  els.scrim.classList.remove('is-dragging');
  els.scrim.style.removeProperty('opacity');
  els.scrim.hidden = !state.libraryOpen;
}

function applyEdgeDrag(edge, dx) {
  const width = edge.width || 1;
  const distance = Math.max(0, dx);
  const progress = edgeClamp(distance / width, 0, 1);
  const translate = Math.min(0, -width + distance);
  els.library.classList.add('is-dragging');
  els.library.style.transform = `translateX(${translate.toFixed(2)}px)`;
  els.scrim.hidden = false;
  els.scrim.classList.add('is-dragging');
  els.scrim.style.opacity = String(edgeClamp(progress * 2.4, 0, 1));
}

function onEdgeTouchStart(event) {
  if (event.touches.length !== 1) {
    // A second finger immediately cancels the gesture; multi-touch zoom and
    // two-finger scrolling must keep working.
    resetEdgeGesture();
    return;
  }
  if (!canUseEdgeGesture()) return;
  if (!isReaderGestureTarget(event.target)) return;
  const touch = event.touches[0];
  // The CSS strip grows with the left safe-area inset; compare against its
  // real viewport edge so the whole reserved area stays usable.
  const edgeRight = els.edgeNav.getBoundingClientRect().right || EDGE_ZONE_PX;
  if (touch.clientX > edgeRight || touch.clientX < 0) {
    if (state.edgeTouch) resetEdgeGesture();
    return;
  }

  // WebKit's edge-back gesture starts on touchstart; cancelling the first
  // move is too late and lets the whole document slide. The transparent
  // hit region exists so this can be a narrow, non-passive preventDefault:
  // https://bugs.webkit.org/show_bug.cgi?id=240892
  if (event.cancelable) event.preventDefault();
  const width = Math.max(1, els.library.getBoundingClientRect().width || 1);
  state.edgeTouch = {
    identifier: touch.identifier,
    startX: touch.clientX,
    startY: touch.clientY,
    lastX: touch.clientX,
    lastY: touch.clientY,
    startedAt: Date.now(),
    width,
    openDistance: edgeOpenDistance(width),
    locked: false,
  };
}

// touchmove/touchend live on window so a locked edge sequence keeps receiving
// events even after the moving drawer covers the narrow start element.
function onEdgeTouchMove(event) {
  const edge = state.edgeTouch;
  if (!edge) return;
  if (event.touches.length !== 1) {
    resetEdgeGesture();
    return;
  }
  const touch = findTouch(event.touches, edge.identifier);
  if (!touch) {
    resetEdgeGesture();
    return;
  }
  edge.lastX = touch.clientX;
  edge.lastY = touch.clientY;
  const dx = touch.clientX - edge.startX;
  const dy = touch.clientY - edge.startY;

  if (!edge.locked) {
    // Leftward movement is not this gesture.
    if (dx < -EDGE_INTENT_SLOP_PX) {
      resetEdgeGesture();
      return;
    }
    // A clear initial vertical intent belongs to the reader. Wait in the
    // ambiguous zone so a diagonal rightward drag can still lock later.
    if (Math.abs(dy) > EDGE_INTENT_SLOP_PX
      && Math.abs(dy) > Math.abs(dx) * EDGE_VERTICAL_RATIO) {
      resetEdgeGesture();
      return;
    }
    if (dx < EDGE_INTENT_SLOP_PX || dx < Math.abs(dy) * 0.8) return;
    edge.locked = true;
  }

  // Once horizontal intent is locked, vertical drift and slow motion never
  // abort it. The finger keeps the browser's native Back gesture suppressed
  // while the drawer follows.
  if (event.cancelable) event.preventDefault();
  applyEdgeDrag(edge, dx);
}

function onEdgeTouchEnd(event) {
  const edge = state.edgeTouch;
  if (!edge) return;
  const touch = findTouch(event.changedTouches, edge.identifier);
  if (touch) {
    edge.lastX = touch.clientX;
    edge.lastY = touch.clientY;
  }
  if (event.touches.length > 0) {
    resetEdgeGesture();
    return;
  }
  state.edgeTouch = null;
  if (!edge.locked) {
    resetEdgeGesture();
    return;
  }

  const dx = edge.lastX - edge.startX;
  const duration = Math.max(1, Date.now() - edge.startedAt);
  const velocity = dx / duration;
  const opensByDistance = dx >= edge.openDistance;
  const opensByFlick = dx >= EDGE_FLICK_MIN_PX && velocity >= EDGE_FLICK_VELOCITY;
  if (!canUseEdgeGesture() || !(opensByDistance || opensByFlick)) {
    // Commit the closed state so the inline drag transform transitions back
    // home and the scrim can never remain over the reader.
    setLibraryDrawer(false);
    return;
  }
  openLibrary();
}

function onEdgeTouchCancel() {
  resetEdgeGesture();
}

function onAnyTouchStart(event) {
  // A second finger can start outside the reserved strip, so observe starts
  // passively at window level purely to cancel an active single-finger drag.
  if (state.edgeTouch && event.touches.length !== 1) resetEdgeGesture();
}

function isStandalonePwa() {
  if (window.navigator.standalone === true) return true;
  try {
    return Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches
      || window.matchMedia?.('(display-mode: fullscreen)')?.matches);
  } catch {
    return false;
  }
}

// In standalone mode the leading edge belongs to the app. During boot,
// in the already-open library, or on wide screens there is no drawer strip
// to claim it. Keep repeated edge swipes from falling through to old pages.
// Do not touch Safari tabs, login, dialogs, controls, or multi-touch gestures.
function shouldGuardPwaEdge(target) {
  if (!isStandalonePwa()) return false;
  if (!state.authenticated) return !els.boot.hidden && els.auth.hidden;
  if (els.shell.hidden || isLibraryDialogOpen() || isShortcutDialogOpen()) return false;
  if (!isReaderGestureTarget(target)) return false;
  return !canUseEdgeGesture();
}

function pwaEdgeRight() {
  if (!els.edgeNav) return EDGE_ZONE_PX;
  const width = Number.parseFloat(getComputedStyle(els.edgeNav).width);
  return Number.isFinite(width) && width > 0 ? width : EDGE_ZONE_PX;
}

function onPwaEdgeTouchStart(event) {
  if (!shouldGuardPwaEdge(event.target) || event.touches.length !== 1) return;
  const touch = event.touches[0];
  if (!touch || touch.clientX < 0 || touch.clientX > pwaEdgeRight()) return;
  if (event.cancelable) event.preventDefault();
}

/* ------------------------------------------------------------- events */

function bindEvents() {
  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = els.loginUser.value.trim();
    const password = els.loginPass.value;
    if (!username || !password) {
      els.loginError.hidden = false;
      els.loginError.textContent = '请输入用户名和密码。';
      return;
    }
    await login(username, password);
  });

  els.themeToggle.addEventListener('click', () => {
    applyTheme(els.root.dataset.theme === 'dark' ? 'light' : 'dark', { persist: true });
  });

  $('#html-retry').addEventListener('click', () => {
    if (state.currentDoc?.kind === 'html') openDocument(state.currentDoc.id, {force: true});
  });

  els.logout.addEventListener('click', logout);
  els.libraryToggle.addEventListener('click', () => {
    if (state.libraryOpen) dismissLibrary();
    else openLibrary();
  });
  els.libraryClose.addEventListener('click', dismissLibrary);
  els.scrim.addEventListener('click', dismissLibrary);

  els.folderCreate.addEventListener('click', () => openLibraryDialog('create-folder'));
  els.folderRename.addEventListener('click', () => {
    if (currentFolder()) openLibraryDialog('rename-folder', { folderId: currentFolder().id });
  });
  els.folderMove.addEventListener('click', () => {
    if (currentFolder()) openLibraryDialog('move-folder', { folderId: currentFolder().id });
  });
  els.folderDelete.addEventListener('click', () => {
    if (currentFolder()) openLibraryDialog('delete-folder', { folderId: currentFolder().id });
  });
  els.importDoc.addEventListener('click', () => {
    if (state.importBusy || !state.authenticated) return;
    els.importFile.click();
  });
  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files?.[0] || null;
    // Clear immediately so selecting the same file again still fires change.
    els.importFile.value = '';
    if (file) await importMarkdownFile(file);
  });
  els.shortcutSettings.addEventListener('click', openShortcutDialog);
  els.shortcutClose.addEventListener('click', () => closeShortcutDialog());
  els.shortcutDownload.addEventListener('click', saveShortcutDownload);
  els.shortcutCopyDownload.addEventListener('click', () => copyShortcutValue(els.shortcutDownloadUrl.value, els.shortcutDownloadUrl, '下载链接（请粘贴到 Safari 地址栏）'));
  els.shortcutDialog.addEventListener('click', (event) => {
    if (event.target === els.shortcutDialog) closeShortcutDialog();
  });
  els.shortcutGenerate.addEventListener('click', generateShortcutToken);
  els.shortcutRevoke.addEventListener('click', revokeShortcutToken);
  els.shortcutCopyUrl.addEventListener('click', () => {
    copyShortcutValue(els.shortcutUrl.value, els.shortcutUrl, '服务 URL');
  });
  els.shortcutCopyToken.addEventListener('click', () => {
    copyShortcutValue(
      state.shortcutToken || els.shortcutTokenValue.value,
      els.shortcutTokenValue,
      '仅导入令牌',
    );
  });
  els.libraryStateRetry.addEventListener('click', () => refreshLibrary());
  els.libraryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitLibraryDialog();
  });
  els.libraryDialogCancel.addEventListener('click', () => closeLibraryDialog());
  els.libraryDialogClose.addEventListener('click', () => closeLibraryDialog());
  els.libraryDialog.addEventListener('click', (event) => {
    if (event.target === els.libraryDialog) closeLibraryDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (state.docDrag && event.key === 'Escape') {
      event.preventDefault();
      cancelDocumentDrag();
      return;
    }
    const openDialog = isLibraryDialogOpen()
      ? els.libraryDialog
      : (isShortcutDialogOpen() ? els.shortcutDialog : null);
    if (!openDialog) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (openDialog === els.libraryDialog) closeLibraryDialog();
      else closeShortcutDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', openDialog)
      .filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  els.reader.addEventListener('scroll', () => {
    updateOfflineStateIfNeeded();
    schedulePositionSave();
  }, { passive: true });

  window.addEventListener('popstate', handlePopState);

  // Only the narrow edge strip starts the drawer gesture. Keeping the start
  // off document leaves the rest of the reader's scrolling and pinch zoom
  // native, and places the non-passive touchstart above the sandboxed iframe
  // whose events never bubble. Move/end listeners sit on window so the
  // sequence stays captured once the moving panel covers the strip.
  if (els.edgeNav) {
    els.edgeNav.addEventListener('touchstart', onEdgeTouchStart, { passive: false });
  }
  // Claim PWA edge touches when the regular drawer strip is not active.
  window.addEventListener('touchstart', onPwaEdgeTouchStart, { passive: false, capture: true });
  window.addEventListener('touchstart', onAnyTouchStart, { passive: true });
  window.addEventListener('touchmove', onEdgeTouchMove, { passive: false });
  window.addEventListener('touchend', onEdgeTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onEdgeTouchCancel, { passive: true });

  // Document drag owns one pointer from the leading grip. Window-level
  // move/up/cancel listeners keep the sequence alive even if a background
  // refresh replaces the list row underneath the finger.
  window.addEventListener('pointermove', onDocumentDragPointerMove, { passive: false });
  window.addEventListener('pointerup', onDocumentDragPointerUp, { passive: false });
  window.addEventListener('pointercancel', onDocumentDragPointerCancel, { passive: true });
  window.addEventListener('pointerdown', onAnyDocumentPointerDown, { passive: true });
  window.addEventListener('blur', () => cancelDocumentDrag());
  // The compatibility click after a real drag is swallowed in the capture
  // phase, before either the grip or the document card can act on it.
  document.addEventListener('click', (event) => {
    if (!state.docDragSuppressClickUntil) return;
    if (Date.now() > state.docDragSuppressClickUntil) {
      state.docDragSuppressClickUntil = 0;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    state.docDragSuppressClickUntil = 0;
  }, true);

  window.addEventListener('resize', () => {
    syncLibraryForLayout();
    window.clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(() => savePosition(), 500);
  });

  window.addEventListener('online', () => {
    updateOfflineState();
    if (state.authenticated) {
      loadDocuments().catch(() => {});
      schedulePoll(30);
    }
  });

  window.addEventListener('offline', updateOfflineState);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resetEdgeGesture();
      cancelDocumentDrag();
      savePosition({ keepalive: true });
      return;
    }
    if (state.authenticated) {
      schedulePoll(50);
      loadDocuments().catch(() => {});
    }
  });

  window.addEventListener('pagehide', () => {
    resetEdgeGesture();
    cancelDocumentDrag();
    savePosition({ keepalive: true });
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  });

  window.addEventListener('pageshow', (event) => {
    // A bfcache snapshot keeps the previous account's DOM in memory. Hide and
    // clear it first, then revalidate the cookie with one bootstrap request.
    // This is as safe as the old full reload, but without the black reload
    // wait every time the PWA is resumed.
    if (event.persisted) revalidateRestoredView();
  });

  document.addEventListener('click', (event) => {
    const localLink = event.target.closest('a[data-local-link]');
    if (localLink) {
      event.preventDefault();
      showToast(`云端不会打开本地链接：${localLink.dataset.localLink}`, 'info');
    }
  });
}

function updateOfflineStateIfNeeded() {
  if (!state.online) return;
  if (!navigator.onLine) updateOfflineState();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  } catch {
    // PWA offline shell is an enhancement; reading works without it.
  }
}

async function initialize() {
  initTheme();
  bindEvents();
  // A reload keeps the browser's history stack. Only trust a reader/auth
  // entry when this release explicitly marked its library base;
  // a restored PWA entry may have kept the view state without the Back target.
  const initialState = currentHistoryState();
  state.historyBaseCreated = historyEntryHasBase(initialState);
  // cloud.js runs before deferred renderer dependencies so edge protection is
  // already active on cold launches. Rendering waits for their script pass.
  if ((!window.markdownit || !window.DOMPurify) && document.readyState !== 'complete') {
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  try {
    markdown = createMarkdownRenderer();
  } catch (error) {
    els.boot.hidden = true;
    showAuth(error.message || '渲染组件加载失败，请刷新页面。', { keepUrl: true });
    return;
  }
  // One authenticated request returns session + library + first/preferred doc.
  // The old session -> documents -> document chain is gone from startup.
  try {
    await loadBootstrap();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showAuth('', { keepUrl: true });
    } else {
      showAuth(error.message || '无法连接服务器，请稍后重试。', { keepUrl: true });
    }
    // A login screen must not start background downloads that compete with
    // the user's imminent login/bootstrap. Register after a successful login.
    return;
  }
  schedulePoll();
  // Register/update the shell worker after the first screen is usable so its
  // install downloads do not compete with the bootstrap request.
  window.setTimeout(registerServiceWorker, 900);
}

initialize().catch((error) => {
  els.boot.hidden = true;
  showAuth(error.message || '页面初始化失败，请刷新重试。', { keepUrl: true });
});
