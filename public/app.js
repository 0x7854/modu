const STORAGE = {
  theme: 'modu.theme',
  font: 'modu.font',
  width: 'modu.width',
  follow: 'modu.follow',
  recent: 'modu.recent',
  last: 'modu.lastPath',
};

const DEFAULTS = {
  font: 17,
  width: 'normal',
  follow: false,
  recentLimit: 8,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const HTML_FRAME_TIMEOUT_MS = (() => {
  const configured = Number($('meta[name="modu-frame-timeout-ms"]')?.content);
  return Number.isFinite(configured) && configured >= 500 && configured <= 120_000
    ? configured
    : 12_000;
})();

// Local reading accepts Markdown and single-file HTML. The cloud library uses
// the same set, but deliberately does not accept .mdown/.txt.
const LOCAL_DOCUMENT_RE = /\.(?:md|markdown|html?)$/i;
const CLOUD_DOCUMENT_RE = /\.(?:md|markdown|html?)$/i;
const HTML_DOCUMENT_RE = /\.(?:html?)$/i;

const els = {
  root: document.documentElement,
  sidebar: $('#sidebar'),
  sidebarToggle: $('#sidebar-toggle'),
  sidebarClose: $('#sidebar-close'),
  scrim: $('#scrim'),
  pathForm: $('#path-form'),
  pathInput: $('#path-input'),
  pickButton: $('#pick-button'),
  welcomePickButton: $('#welcome-pick-button'),
  sampleButton: $('#sample-button'),
  recentList: $('#recent-list'),
  recentClear: $('#recent-clear'),
  fileName: $('#file-name'),
  filePath: $('#file-path'),
  identityKicker: $('#identity-kicker'),
  statusChip: $('#status-chip'),
  statusText: $('#status-text'),
  syncDetail: $('#sync-detail'),
  updatePill: $('#update-pill'),
  readerAlert: $('#reader-alert'),
  alertTitle: $('#alert-title'),
  alertDetail: $('#alert-detail'),
  alertAction: $('#alert-action'),
  readerScroll: $('#reader-scroll'),
  welcome: $('#welcome'),
  doc: $('#doc-content'),
  docEnd: $('#doc-end'),
  docKindBadge: $('#doc-kind-badge'),
  htmlModeNote: $('#html-mode-note'),
  htmlReload: $('#html-reload'),
  htmlStage: $('#html-stage'),
  htmlFrameHost: $('#html-frame-host'),
  htmlLoading: $('#html-loading'),
  htmlLoadingText: $('#html-loading-text'),
  htmlError: $('#html-error'),
  htmlErrorTitle: $('#html-error-title'),
  htmlErrorDetail: $('#html-error-detail'),
  htmlErrorRetry: $('#html-error-retry'),
  outlineColumn: $('#outline-column'),
  outline: $('#outline'),
  outlineCount: $('#outline-count'),
  outlineEmpty: $('#outline-empty'),
  progressBar: $('#progress-bar'),
  searchPanel: $('#search-panel'),
  searchInput: $('#search-input'),
  searchCount: $('#search-count'),
  searchPrev: $('#search-prev'),
  searchNext: $('#search-next'),
  searchClose: $('#search-close'),
  findTrigger: $('#find-trigger'),
  themeToggle: $('#theme-toggle'),
  settingsToggle: $('#settings-toggle'),
  settingsPanel: $('#settings-panel'),
  settingsClose: $('#settings-close'),
  settingsHtmlNote: $('#settings-html-note'),
  themeSegment: $('#theme-segment'),
  widthSegment: $('#width-segment'),
  fontRange: $('#font-range'),
  fontOutput: $('#font-output'),
  followToggle: $('#follow-toggle'),
  settingsReset: $('#settings-reset'),
  shareTrigger: $('#share-trigger'),
  shareLiveDot: $('#share-live-dot'),
  shareHtmlNote: $('#share-html-note'),
  sharePanel: $('#share-panel'),
  shareClose: $('#share-close'),
  shareEmpty: $('#share-empty'),
  shareIdle: $('#share-idle'),
  shareCurrentName: $('#share-current-name'),
  shareStart: $('#share-start'),
  shareActive: $('#share-active'),
  shareActiveName: $('#share-active-name'),
  shareOtherNote: $('#share-other-note'),
  shareAddress: $('#share-address'),
  shareLink: $('#share-link'),
  shareCopyAddress: $('#share-copy-address'),
  shareCopyLink: $('#share-copy-link'),
  shareReplace: $('#share-replace'),
  shareRevoke: $('#share-revoke'),
  cloudTrigger: $('#cloud-trigger'),
  cloudBadge: $('#cloud-badge'),
  cloudPanel: $('#cloud-panel'),
  cloudClose: $('#cloud-close'),
  cloudUnavailable: $('#cloud-unavailable'),
  cloudConfigured: $('#cloud-configured'),
  cloudAccount: $('#cloud-account'),
  cloudAccountText: $('#cloud-account-text'),
  cloudEdit: $('#cloud-edit'),
  cloudOnline: $('#cloud-online'),
  cloudLibraryRefresh: $('#cloud-library-refresh'),
  cloudFolderTree: $('#cloud-folder-tree'),
  cloudFolderCreate: $('#cloud-folder-create'),
  cloudFolderBreadcrumb: $('#cloud-folder-breadcrumb'),
  cloudFolderActions: $('#cloud-folder-actions'),
  cloudFolderRename: $('#cloud-folder-rename'),
  cloudFolderMove: $('#cloud-folder-move'),
  cloudFolderDelete: $('#cloud-folder-delete'),
  cloudLibraryState: $('#cloud-library-state'),
  cloudLibraryStateText: $('#cloud-library-state-text'),
  cloudLibraryRetry: $('#cloud-library-retry'),
  cloudOnlineDocs: $('#cloud-online-docs'),
  cloudOnlineEmpty: $('#cloud-online-empty'),
  cloudLibraryDialog: $('#cloud-library-dialog'),
  cloudLibraryForm: $('#cloud-library-form'),
  cloudLibraryKicker: $('#cloud-library-kicker'),
  cloudLibraryTitle: $('#cloud-library-title'),
  cloudLibraryCopy: $('#cloud-library-copy'),
  cloudLibrarySubject: $('#cloud-library-subject'),
  cloudLibraryNameField: $('#cloud-library-name-field'),
  cloudLibraryName: $('#cloud-library-name'),
  cloudLibraryParentField: $('#cloud-library-parent-field'),
  cloudLibraryParent: $('#cloud-library-parent'),
  cloudLibraryError: $('#cloud-library-error'),
  cloudLibrarySubmit: $('#cloud-library-submit'),
  cloudLibraryCancel: $('#cloud-library-cancel'),
  cloudLibraryClose: $('#cloud-library-close'),
  cloudAddCurrent: $('#cloud-add-current'),
  cloudSyncNow: $('#cloud-sync-now'),
  cloudDocCount: $('#cloud-doc-count'),
  cloudDocList: $('#cloud-doc-list'),
  cloudPendingNote: $('#cloud-pending-note'),
  cloudConfig: $('#cloud-config'),
  cloudServerUrl: $('#cloud-server-url'),
  cloudToken: $('#cloud-token'),
  cloudError: $('#cloud-error'),
  cloudSave: $('#cloud-save'),
  dropChoice: $('#drop-choice'),
  dropChoiceName: $('#drop-choice-name'),
  dropOpen: $('#drop-open'),
  dropAdd: $('#drop-add'),
  dropCancel: $('#drop-cancel'),
  dropOverlay: $('#drop-overlay'),
  toastRegion: $('#toast-region'),
  themeColor: $('meta[name="theme-color"]'),
};

const metaToken = $('meta[name="md-token"]')?.content || '';
const metaSamplePath = $('meta[name="md-sample-path"]')?.content || '';

const state = {
  token: metaToken,
  samplePath: metaSamplePath,
  current: null,
  serverStatus: { key: 'idle', checkedAt: null },
  connection: 'connecting',
  opening: false,
  openFailure: null,
  expired: false,
  pickerBusy: false,
  recent: [],
  theme: 'light',
  font: DEFAULTS.font,
  width: DEFAULTS.width,
  follow: DEFAULTS.follow,
  search: {
    open: false,
    query: '',
    ranges: [],
    index: 0,
    supported: typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined',
  },
  scrollAnchor: null,
  updateTimer: null,
  freshTimer: null,
  eventSource: null,
  fallbackTimer: null,
  fallbackBusy: false,
  dragDepth: 0,
  alertActionHandler: null,
  share: {
    active: null,
    loading: false,
    panelOpen: false,
  },
  dropChoicePath: '',
  html: {
    generation: 0,
    timer: null,
    frame: null,
    pending: false,
    ready: false,
    error: '',
  },
  cloud: {
    available: Boolean(window.moduDesktop?.sync),
    state: null,
    loading: false,
    panelOpen: false,
    pendingAddPath: '',
    unsubscribe: null,
    library: { revision: 0, folders: [], assignments: {} },
    libraryDocuments: [],
    libraryLoaded: false,
    libraryLoading: false,
    libraryError: '',
    libraryConflict: false,
    librarySignature: '',
    libraryRequestId: 0,
    libraryPollTimer: null,
    libraryView: { kind: 'all', folderId: '' },
    dialog: null,
    dialogBusy: false,
  },
};

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is optional; reading still works without it.
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore private-mode storage failures.
  }
}

function loadPreferences() {
  const storedTheme = safeStorageGet(STORAGE.theme);
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  state.theme = storedTheme === 'dark' || storedTheme === 'light'
    ? storedTheme
    : (systemDark ? 'dark' : 'light');

  const storedFont = Number(safeStorageGet(STORAGE.font));
  if (Number.isFinite(storedFont) && storedFont >= 14 && storedFont <= 24) {
    state.font = storedFont;
  }

  const storedWidth = safeStorageGet(STORAGE.width);
  if (['narrow', 'normal', 'wide'].includes(storedWidth)) {
    state.width = storedWidth;
  }

  state.follow = safeStorageGet(STORAGE.follow) === 'true';

  try {
    const recent = JSON.parse(safeStorageGet(STORAGE.recent) || '[]');
    if (Array.isArray(recent)) {
      state.recent = recent
        .filter((item) => item && typeof item.path === 'string' && item.path.startsWith('/'))
        .slice(0, DEFAULTS.recentLimit)
        .map((item) => ({
          path: item.path,
          name: typeof item.name === 'string' ? item.name : item.path.split('/').pop(),
          at: Number(item.at) || Date.now(),
        }));
    }
  } catch {
    state.recent = [];
  }
}

function applyPreferences({ persist = false } = {}) {
  state.font = Math.min(24, Math.max(14, Number(state.font) || DEFAULTS.font));
  els.root.dataset.theme = state.theme;
  els.root.dataset.width = state.width;
  els.root.style.setProperty('--doc-font-size', `${state.font}px`);
  els.root.style.colorScheme = state.theme;
  els.themeColor?.setAttribute('content', state.theme === 'dark' ? '#171a15' : '#f3eee3');
  els.fontRange.value = String(state.font);
  els.fontOutput.textContent = `${state.font} px`;
  els.followToggle.checked = state.follow;

  for (const button of $$('[data-theme-choice]', els.themeSegment)) {
    button.classList.toggle('is-active', button.dataset.themeChoice === state.theme);
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === state.theme));
  }
  for (const button of $$('[data-width-choice]', els.widthSegment)) {
    button.classList.toggle('is-active', button.dataset.widthChoice === state.width);
    button.setAttribute('aria-pressed', String(button.dataset.widthChoice === state.width));
  }

  const label = state.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.setAttribute('title', label);

  if (persist) {
    safeStorageSet(STORAGE.theme, state.theme);
    safeStorageSet(STORAGE.font, String(state.font));
    safeStorageSet(STORAGE.width, state.width);
    safeStorageSet(STORAGE.follow, String(state.follow));
  }
}

function formatTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatRecentTime(timestamp) {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp);
}

function basename(filePath) {
  return filePath.split('/').filter(Boolean).pop() || filePath;
}

function documentKind(doc) {
  if (doc?.kind === 'html') return 'html';
  if (doc?.kind === 'markdown') return 'markdown';
  return HTML_DOCUMENT_RE.test(doc?.path || doc?.name || '') ? 'html' : 'markdown';
}

function previewUrlIsLocal(doc) {
  const raw = typeof doc?.previewUrl === 'string' ? doc.previewUrl : '';
  if (!raw) return false;
  try {
    const parsed = new URL(raw, location.origin);
    return parsed.origin === location.origin
      && parsed.pathname === '/api/html-preview'
      && /^[A-Za-z0-9_-]{32,128}$/.test(parsed.searchParams.get('cap') || '')
      && !parsed.hash;
  } catch {
    return false;
  }
}

function showToast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  const symbol = document.createElement('span');
  symbol.className = 'toast-mark';
  symbol.textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : '·';
  const text = document.createElement('span');
  text.textContent = message;
  node.append(symbol, text);
  els.toastRegion.append(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));
  window.setTimeout(() => {
    node.classList.remove('is-visible');
    window.setTimeout(() => node.remove(), 240);
  }, kind === 'error' ? 5600 : 3800);
}

function saveRecent(doc) {
  const entry = { path: doc.path, name: doc.name, at: Date.now() };
  state.recent = [entry, ...state.recent.filter((item) => item.path !== doc.path)]
    .slice(0, DEFAULTS.recentLimit);
  safeStorageSet(STORAGE.recent, JSON.stringify(state.recent));
  safeStorageSet(STORAGE.last, doc.path);
  renderRecent();
}

function renderRecent() {
  els.recentList.replaceChildren();
  els.recentClear.hidden = state.recent.length === 0;

  if (!state.recent.length) {
    const empty = document.createElement('li');
    empty.className = 'recent-empty';
    empty.textContent = '打开过的文稿会安静地留在这里。';
    els.recentList.append(empty);
    return;
  }

  for (const item of state.recent) {
    const row = document.createElement('li');
    row.className = 'recent-item';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'recent-open';
    open.title = item.path;
    open.setAttribute('aria-label', `打开 ${item.path}`);

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-file');
    icon.append(use);

    const copy = document.createElement('span');
    copy.className = 'recent-copy';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    meta.textContent = `${formatRecentTime(item.at)} · ${item.path.replace(/\/[^/]+$/, '')}`;
    copy.append(name, meta);
    open.append(icon, copy);
    open.addEventListener('click', () => {
      closeMobileSidebar();
      openPath(item.path, { source: 'recent' });
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recent-remove';
    remove.setAttribute('aria-label', `从最近阅读中移除 ${item.name}`);
    remove.title = '移除此记录';
    const removeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    removeIcon.classList.add('icon');
    removeIcon.setAttribute('aria-hidden', 'true');
    const removeUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    removeUse.setAttribute('href', '#i-x');
    removeIcon.append(removeUse);
    remove.append(removeIcon);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      state.recent = state.recent.filter((entry) => entry.path !== item.path);
      safeStorageSet(STORAGE.recent, JSON.stringify(state.recent));
      if (safeStorageGet(STORAGE.last) === item.path) safeStorageRemove(STORAGE.last);
      renderRecent();
    });

    row.append(open, remove);
    els.recentList.append(row);
  }
}

async function api(path, options = {}) {
  const headers = { 'X-MD-Token': state.token };
  const init = {
    method: options.method || 'GET',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;

  const response = await fetch(path, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A malformed response should still turn into a useful error.
  }

  if (!response.ok) {
    if (response.status === 401) expireSession();
    const message = payload?.error?.message || `请求失败（${response.status}）`;
    throw new ApiError(message, payload?.error?.code || 'REQUEST_FAILED', response.status);
  }
  return payload;
}

function expireSession() {
  if (state.expired) return;
  state.expired = true;
  state.connection = 'expired';
  state.eventSource?.close();
  state.eventSource = null;
  stopFallback();
  clearHtmlTimer();
  destroyHtmlPreview();
  refreshStatusUI();
  updateAlertForState();
}

function setConnection(next) {
  if (state.expired) return;
  state.connection = next;
  refreshStatusUI();
  updateAlertForState();
}

function refreshStatusUI() {
  let kind = 'idle';
  let label = '等待打开';
  let detail = '选择一份本地 Markdown，开始安静的阅读';

  if (state.expired) {
    kind = 'error';
    label = '会话已失效';
    detail = '本地服务可能已重启，请刷新页面';
  } else if (!state.current) {
    if (state.opening) {
      kind = 'loading';
      label = '正在打开';
      detail = '正在读取原文件…';
    } else if (state.openFailure) {
      kind = 'error';
      label = '打开失败';
      detail = state.openFailure;
    } else if (state.connection === 'reconnecting') {
      kind = 'connecting';
      label = '连接中断';
      detail = '正在恢复本地实时通道…';
    }
  } else if (state.serverStatus.key === 'missing') {
    kind = 'missing';
    label = '原文件已删除';
    detail = `等待原路径恢复 · 上次检查 ${formatTime(state.serverStatus.checkedAt) || '—'}`;
  } else if (state.serverStatus.key === 'error') {
    kind = 'error';
    label = '同步遇阻';
    detail = state.serverStatus.message || '读取原文件失败';
  } else if (documentKind(state.current) === 'html' && state.html.error) {
    kind = 'error';
    label = '交互页未加载';
    detail = state.html.error;
  } else if (documentKind(state.current) === 'html' && state.html.pending) {
    kind = 'loading';
    label = '正在加载交互页';
    detail = '正在确认页面可以操作…';
  } else if (state.connection === 'reconnecting') {
    kind = 'connecting';
    label = '连接中断';
    detail = '实时通道重连中，正文保持在原处';
  } else if (state.connection === 'fallback') {
    kind = 'fallback';
    label = '轮询同步';
    detail = `实时通道已断开 · 检查于 ${formatTime(state.serverStatus.checkedAt) || '—'}`;
  } else if (state.connection === 'connecting') {
    kind = 'connecting';
    label = '正在连接';
    detail = '正在接入原文件…';
  } else if (state.statusFlash) {
    kind = 'synced';
    label = '实时同步';
    detail = state.statusFlash;
  } else if (documentKind(state.current) === 'html') {
    const checked = formatTime(state.serverStatus.checkedAt);
    kind = 'synced';
    label = '交互页就绪';
    detail = checked ? `HTML 原文件已连接 · 检查于 ${checked}` : 'HTML 原文件已连接';
  } else {
    const checked = formatTime(state.serverStatus.checkedAt);
    kind = 'synced';
    label = '实时同步';
    detail = checked ? `原文件已连接 · 检查于 ${checked}` : '原文件已连接';
  }

  els.statusChip.dataset.state = kind;
  els.statusText.textContent = label;
  els.syncDetail.textContent = detail;
  els.statusChip.title = detail;
}

function flashUpdate(text) {
  state.statusFlash = text;
  refreshStatusUI();
  window.clearTimeout(state.updateFlashTimer);
  state.updateFlashTimer = window.setTimeout(() => {
    state.statusFlash = '';
    refreshStatusUI();
  }, 5000);
}

function showUpdatePill() {
  els.updatePill.hidden = false;
  els.updatePill.classList.remove('is-visible');
  requestAnimationFrame(() => els.updatePill.classList.add('is-visible'));
  window.clearTimeout(state.updateTimer);
  state.updateTimer = window.setTimeout(() => {
    els.updatePill.classList.remove('is-visible');
    window.setTimeout(() => {
      if (!els.updatePill.classList.contains('is-visible')) els.updatePill.hidden = true;
    }, 250);
  }, 7000);
}

function hideUpdatePill() {
  els.updatePill.classList.remove('is-visible');
  window.clearTimeout(state.updateTimer);
  window.setTimeout(() => {
    if (!els.updatePill.classList.contains('is-visible')) els.updatePill.hidden = true;
  }, 250);
}

function showAlert({ kind = 'info', title, detail, actionLabel = '', action = null }) {
  els.readerAlert.hidden = false;
  els.readerAlert.dataset.kind = kind;
  els.alertTitle.textContent = title;
  els.alertDetail.textContent = detail || '';
  state.alertActionHandler = action;
  els.alertAction.hidden = !actionLabel;
  els.alertAction.textContent = actionLabel;
}

function hideAlert() {
  els.readerAlert.hidden = true;
  state.alertActionHandler = null;
}

function updateAlertForState() {
  if (state.expired) {
    showAlert({
      kind: 'error',
      title: '页面会话已失效',
      detail: '本地服务可能已重启。刷新页面会重新接入，并从最近路径恢复文稿。',
      actionLabel: '刷新页面',
      action: () => window.location.reload(),
    });
    return;
  }

  if (state.current && state.serverStatus.key === 'missing') {
    showAlert({
      kind: 'warning',
      title: '原文件已删除',
      detail: `${state.current.path} · 正在每 500ms 检查原路径，文件恢复后正文会自动续上。`,
      actionLabel: '重新检查',
      action: () => refreshFromServer(),
    });
    return;
  }

  if (state.current && state.serverStatus.key === 'error') {
    showAlert({
      kind: 'error',
      title: '同步遇到问题',
      detail: state.serverStatus.message || '读取原文件失败，正文保留为最后一次成功内容。',
      actionLabel: '重试',
      action: () => refreshFromServer(),
    });
    return;
  }

  if (documentKind(state.current) === 'html' && state.html.error) {
    showAlert({
      kind: 'warning',
      title: 'HTML 交互页没有完成加载',
      detail: state.html.error,
      actionLabel: '重新加载',
      action: () => retryHtmlPreview(),
    });
    return;
  }

  if (state.openFailure) {
    showAlert({
      kind: 'error',
      title: '无法打开这份文稿',
      detail: state.openFailure,
      actionLabel: '从访达选择',
      action: () => triggerNativePicker(),
    });
    return;
  }

  if (state.connection === 'reconnecting') {
    showAlert({
      kind: 'warning',
      title: '实时通道正在重连',
      detail: '本地连接暂时中断，正文保持在原处。墨读会自动恢复，不会误报已同步。',
      actionLabel: '立即重连',
      action: () => connectEvents(),
    });
    return;
  }

  hideAlert();
}

function setServerStatus(status) {
  if (!status) return;
  state.serverStatus = status;
  refreshStatusUI();
  updateAlertForState();
}

async function openPath(rawPath, { source = 'manual', silent = false } = {}) {
  if (state.expired) {
    showToast('页面会话已失效，请刷新后再打开。', 'error');
    return;
  }
  const filePath = String(rawPath || '').trim();
  if (!filePath.startsWith('/')) {
    const message = '请输入以 / 开头的绝对路径。';
    if (source !== 'auto') showToast(message, 'error');
    state.openFailure = message;
    refreshStatusUI();
    updateAlertForState();
    els.pathInput.focus();
    return;
  }

  const requestId = (state.openRequestId || 0) + 1;
  state.openRequestId = requestId;
  state.opening = true;
  state.openFailure = null;
  state.openingPath = filePath;
  refreshStatusUI();
  updateAlertForState();
  closeMobileSidebar();

  try {
    const payload = await api('/api/open', { method: 'POST', body: { path: filePath } });
    if (requestId !== state.openRequestId) return;

    const doc = payload.doc;
    setServerStatus(payload.status);
    state.openFailure = null;
    const samePath = state.current?.path === doc.path;
    applyDocument(doc, { reason: source === 'update' ? 'update' : 'open', preserve: samePath });
    saveRecent(doc);
    syncCloudButtons();
    window.moduDesktop?.documentOpened?.(doc.path);
    els.pathInput.value = doc.path;
    applyShareState(state.share.active);
    if (!silent && source !== 'auto') showToast(`已打开 ${doc.name}`, 'success');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    if (requestId !== state.openRequestId) return;
    const message = error.message || '打开文档失败。';
    state.openFailure = message;
    refreshStatusUI();
    updateAlertForState();
    showToast(message, 'error');
    if (!state.current) els.pathInput.value = filePath;
  } finally {
    if (requestId === state.openRequestId) {
      state.opening = false;
      refreshStatusUI();
      updateAlertForState();
    }
  }
}

function captureReadingAnchor() {
  if (!state.current || els.doc.hidden) return null;
  const container = els.readerScroll;
  const containerRect = container.getBoundingClientRect();
  const focusY = containerRect.top + Math.min(140, container.clientHeight * 0.22);
  const visibleChild = [...els.doc.children].find((child) => {
    const rect = child.getBoundingClientRect();
    return rect.bottom > focusY;
  }) || null;
  const headings = $$('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]', els.doc);
  const heading = [...headings].reverse().find((node) => node.getBoundingClientRect().top <= focusY) || null;

  const anchorNode = heading || visibleChild;
  if (!anchorNode) return null;
  return {
    headingId: heading?.id || '',
    blockKey: visibleChild?.dataset.anchor || '',
    blockOffset: visibleChild ? visibleChild.getBoundingClientRect().top - containerRect.top : 0,
    offset: anchorNode.getBoundingClientRect().top - containerRect.top,
    scrollTop: container.scrollTop,
  };
}

function restoreReadingAnchor(anchor) {
  if (!anchor) return;
  const container = els.readerScroll;
  const containerRect = container.getBoundingClientRect();
  let target = null;
  let offset = anchor.offset;
  if (anchor.blockKey) {
    try {
      target = els.doc.querySelector(`[data-anchor="${CSS.escape(anchor.blockKey)}"]`);
      if (target) offset = anchor.blockOffset;
    } catch {
      target = null;
    }
  }
  if (!target && anchor.headingId) target = document.getElementById(anchor.headingId);
  if (target) {
    const delta = target.getBoundingClientRect().top - containerRect.top - offset;
    container.scrollTop += delta;
  } else {
    container.scrollTop = anchor.scrollTop || 0;
  }
  updateProgress();
  updateActiveHeading();
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
  const duplicateCount = new Map();
  for (const child of els.doc.children) {
    if (child.id) {
      child.dataset.anchor = `id:${child.id}`;
      continue;
    }
    const signature = `${child.tagName}|${child.textContent.replace(/\s+/g, ' ').trim().slice(0, 180)}`;
    const base = hashText(signature);
    const count = duplicateCount.get(base) || 0;
    duplicateCount.set(base, count + 1);
    child.dataset.anchor = `b:${base}:${count}`;
  }
}

function collectBlockText() {
  const map = new Map();
  for (const child of els.doc.children) {
    if (!child.dataset.anchor) continue;
    map.set(child.dataset.anchor, child.textContent.replace(/\s+/g, ' ').trim());
  }
  return map;
}

function markFreshBlocks(previousBlocks) {
  if (!previousBlocks) return;
  let count = 0;
  const fresh = [];
  for (const child of els.doc.children) {
    const key = child.dataset.anchor;
    if (!key) continue;
    if (!previousBlocks.has(key) || previousBlocks.get(key) !== child.textContent.replace(/\s+/g, ' ').trim()) {
      child.classList.add('is-fresh');
      fresh.push(child);
      count += 1;
    }
  }
  window.clearTimeout(state.freshTimer);
  state.freshTimer = window.setTimeout(() => {
    for (const node of fresh) node.classList.remove('is-fresh');
  }, 3400);
  return count;
}

function addCodeCopyButtons() {
  for (const pre of $$('pre.md-code', els.doc)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = '复制';
    button.setAttribute('aria-label', '复制代码');
    button.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent || '';
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = '已复制';
        window.setTimeout(() => { button.textContent = '复制'; }, 1600);
      } catch {
        showToast('无法写入剪贴板。', 'error');
      }
    });
    pre.append(button);
  }
}

function buildOutline(headings) {
  els.outline.replaceChildren();
  const valid = Array.isArray(headings) ? headings.filter((heading) => heading && heading.id) : [];
  els.outlineCount.textContent = String(valid.length);

  if (!valid.length) {
    els.outlineEmpty.hidden = false;
    els.outline.append(els.outlineEmpty);
    return;
  }
  els.outlineEmpty.hidden = true;

  const minLevel = Math.min(...valid.map((heading) => heading.level));
  for (const heading of valid) {
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.className = `outline-link outline-level-${Math.min(6, Math.max(1, heading.level - minLevel + 1))}`;
    link.dataset.headingId = heading.id;
    link.textContent = heading.text || '未命名章节';
    link.title = heading.text || '';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      scrollToHeading(heading.id, true);
    });
    els.outline.append(link);
  }
}

function scrollToHeading(id, smooth = true) {
  const target = document.getElementById(id);
  if (!target) return;
  const container = els.readerScroll;
  const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top - 34;
  container.scrollTo({ top: container.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
}

function updateActiveHeading() {
  if (!state.current || els.doc.hidden) return;
  const headings = $$('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]', els.doc);
  if (!headings.length) return;
  const container = els.readerScroll;
  const threshold = container.getBoundingClientRect().top + 110;
  let active = headings[0];
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top <= threshold) active = heading;
    else break;
  }
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
  if (atBottom) active = headings[headings.length - 1];

  let activeLink = null;
  for (const link of $$('.outline-link', els.outline)) {
    const isActive = link.dataset.headingId === active.id;
    link.classList.toggle('is-active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'location');
      activeLink = link;
    } else {
      link.removeAttribute('aria-current');
    }
  }
  if (activeLink) {
    const outlineRect = els.outline.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    if (linkRect.top < outlineRect.top || linkRect.bottom > outlineRect.bottom) {
      activeLink.scrollIntoView({ block: 'nearest' });
    }
  }
}

function updateProgress() {
  const container = els.readerScroll;
  const max = Math.max(1, container.scrollHeight - container.clientHeight);
  const ratio = Math.min(1, Math.max(0, container.scrollTop / max));
  els.progressBar.style.transform = `scaleX(${ratio})`;
  els.root.style.setProperty('--read-progress', String(ratio));
}

function updateIdentity(doc) {
  const isHtml = documentKind(doc) === 'html';
  els.fileName.textContent = doc.name;
  els.filePath.textContent = doc.dir;
  els.filePath.title = `点击复制路径：${doc.path}`;
  els.identityKicker.textContent = isHtml ? '正在体验交互页' : '正在阅读';
  document.title = `${doc.name} · 墨读`;
  els.docKindBadge.hidden = false;
  els.docKindBadge.textContent = isHtml ? 'HTML' : 'MD';
}

function applyDocumentModeUi(doc) {
  const isHtml = documentKind(doc) === 'html';
  els.root.dataset.docKind = isHtml ? 'html' : 'markdown';
  els.docKindBadge.hidden = !doc;
  if (doc) els.docKindBadge.textContent = isHtml ? 'HTML' : 'MD';
  els.htmlModeNote.hidden = !isHtml;

  // Markdown typography, outline, follow-update and theme controls have no
  // meaning for an HTML page that owns its own layout and appearance.
  for (const node of $$('[data-markdown-only]')) node.hidden = isHtml;
  els.settingsHtmlNote.hidden = !isHtml;
  els.shareHtmlNote.hidden = !isHtml;
  els.findTrigger.disabled = isHtml;
  if (isHtml) {
    closeSearch();
    closeSharePanel();
    els.outlineEmpty.innerHTML = 'HTML 交互页<br>没有 Markdown 目录。';
  } else {
    els.outlineEmpty.innerHTML = '打开文稿后，<br>章节会在这里展开。';
  }
}

function clearHtmlTimer() {
  if (!state.html.timer) return;
  window.clearTimeout(state.html.timer);
  state.html.timer = null;
}

function destroyHtmlPreview({ hideStage = true } = {}) {
  state.html.generation += 1;
  state.html.pending = false;
  state.html.ready = false;
  state.html.error = '';
  clearHtmlTimer();
  const frame = state.html.frame;
  state.html.frame = null;
  if (frame) {
    try {
      frame.remove();
    } catch {
      // The frame may already be detached.
    }
  }
  els.htmlFrameHost.replaceChildren();
  els.htmlLoading.hidden = true;
  els.htmlError.hidden = true;
  if (hideStage) els.htmlStage.hidden = true;
}

function showHtmlPreviewError(title, detail) {
  state.html.pending = false;
  state.html.ready = false;
  state.html.error = detail;
  clearHtmlTimer();
  els.htmlLoading.hidden = true;
  els.htmlErrorTitle.textContent = title;
  els.htmlErrorDetail.textContent = detail;
  els.htmlError.hidden = false;
  els.htmlStage.hidden = false;
  refreshStatusUI();
  updateAlertForState();
}

function settleHtmlPreview(generation, ok) {
  if (generation !== state.html.generation) return;
  state.html.pending = false;
  clearHtmlTimer();
  els.htmlLoading.hidden = true;
  if (ok) {
    state.html.ready = true;
    state.html.error = '';
    els.htmlError.hidden = true;
    refreshStatusUI();
    updateAlertForState();
    return;
  }
  showHtmlPreviewError(
    '交互页没有完成加载',
    '页面没有在预期时间内完成加载。请检查文件是否完整；如果它依赖相邻文件、外部字体或网络资源，请改为单文件内嵌。',
  );
}

function mountHtmlPreview(doc) {
  if (!previewUrlIsLocal(doc)) {
    destroyHtmlPreview({ hideStage: false });
    showHtmlPreviewError(
      '交互页地址无效',
      '这份 HTML 没有取得可用的本机预览地址，请重新打开这份文稿。',
    );
    return;
  }

  destroyHtmlPreview({ hideStage: false });
  els.htmlStage.hidden = false;
  els.htmlError.hidden = true;
  els.htmlLoading.hidden = false;
  els.htmlLoadingText.textContent = '正在加载交互页…';
  state.html.pending = true;
  state.html.ready = false;
  state.html.error = '';

  const generation = state.html.generation;
  const iframe = document.createElement('iframe');
  iframe.className = 'html-frame';
  iframe.id = 'html-frame';
  iframe.title = `${doc.name} 交互页`;
  iframe.dataset.generation = String(generation);
  // Scripts may run, but the page stays in an opaque origin: it cannot read the
  // reader, its token, local files or same-origin APIs. No forms/popups/top-nav.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('loading', 'eager');
  iframe.src = doc.previewUrl;

  // A load event only means the response arrived; script execution still needs
  // to be confirmed by the preview-ready bridge from the served document.
  iframe.addEventListener('load', () => {
    if (generation !== state.html.generation) return;
    els.htmlLoadingText.textContent = '页面已载入，正在确认交互状态…';
  });
  iframe.addEventListener('error', () => settleHtmlPreview(generation, false));

  state.html.frame = iframe;
  els.htmlFrameHost.replaceChildren(iframe);
  state.html.timer = window.setTimeout(
    () => settleHtmlPreview(generation, false),
    HTML_FRAME_TIMEOUT_MS,
  );
  refreshStatusUI();
  updateAlertForState();
}

function retryHtmlPreview() {
  if (documentKind(state.current) !== 'html') return;
  mountHtmlPreview(state.current);
}

function handlePreviewReady(event) {
  const frame = state.html.frame;
  if (!frame || !state.html.pending) return;
  if (event.source !== frame.contentWindow) return;
  if (Number(frame.dataset.generation) !== state.html.generation) return;
  if (!event.data || event.data.type !== 'modu-preview-ready') return;
  if (documentKind(state.current) !== 'html') return;
  settleHtmlPreview(state.html.generation, true);
}

function applyDocument(doc, { reason = 'open', preserve = false } = {}) {
  if (!doc || typeof doc !== 'object') return;
  const kind = documentKind(doc);
  if (kind === 'markdown' && typeof doc.html !== 'string') return;

  const previous = state.current;
  const samePath = previous?.path === doc.path;
  const sameRevision = samePath && previous.revision === doc.revision && previous.hash === doc.hash;

  if (sameRevision) {
    state.current = doc;
    updateIdentity(doc);
    applyDocumentModeUi(doc);
    if (kind === 'html') {
      // Same revision means the live page keeps running exactly as it is. A
      // reconnect or duplicate poll must never reset slider/fold widget state.
      refreshStatusUI();
      return;
    }
    if (state.search.open && state.search.query) runSearch({ preserveIndex: true, scroll: false });
    return;
  }

  if (kind === 'html') {
    const wasUpdate = Boolean(samePath && previous?.hash !== doc.hash);
    state.current = doc;
    updateIdentity(doc);
    applyDocumentModeUi(doc);
    els.welcome.hidden = true;
    els.doc.hidden = true;
    els.doc.innerHTML = '';
    els.docEnd.hidden = true;
    els.htmlStage.hidden = false;
    buildOutline([]);

    if (!samePath) {
      window.clearTimeout(state.updateFlashTimer);
      state.statusFlash = '';
      hideUpdatePill();
      els.readerScroll.scrollTop = 0;
    } else if (wasUpdate) {
      showUpdatePill();
      flashUpdate(`交互页已更新 · ${formatTime(doc.checkedAt)}`);
    }

    mountHtmlPreview(doc);
    // Opening an HTML page stops an active LAN share in the reader server.
    loadShareState();
    return;
  }

  destroyHtmlPreview();
  applyDocumentModeUi(doc);

  const anchor = preserve && samePath ? captureReadingAnchor() : null;
  const previousBlocks = preserve && samePath ? collectBlockText() : null;
  const wasUpdate = Boolean(samePath && previous?.hash !== doc.hash);

  els.doc.innerHTML = doc.html;
  assignBlockAnchors();
  addCodeCopyButtons();
  state.current = doc;
  updateIdentity(doc);

  els.welcome.hidden = true;
  els.doc.hidden = false;
  els.htmlStage.hidden = true;
  els.docEnd.hidden = false;
  buildOutline(doc.headings);

  if (!samePath) {
    window.clearTimeout(state.updateFlashTimer);
    state.statusFlash = '';
    hideUpdatePill();
    refreshStatusUI();
    els.readerScroll.scrollTop = 0;
  } else if (state.follow) {
    requestAnimationFrame(() => {
      els.readerScroll.scrollTop = els.readerScroll.scrollHeight;
      updateProgress();
      updateActiveHeading();
    });
  } else if (anchor) {
    requestAnimationFrame(() => restoreReadingAnchor(anchor));
  }

  if (wasUpdate && previousBlocks) {
    const changed = markFreshBlocks(previousBlocks);
    if (changed) {
      showUpdatePill();
      flashUpdate(`内容已更新 · ${formatTime(doc.checkedAt)}`);
    }
  }

  if (state.search.open && state.search.query) {
    runSearch({ preserveIndex: true, scroll: false });
  }

  requestAnimationFrame(() => {
    updateProgress();
    updateActiveHeading();
  });
}

function setWelcomeVisible() {
  destroyHtmlPreview();
  applyDocumentModeUi(null);
  els.welcome.hidden = false;
  els.doc.hidden = true;
  els.docEnd.hidden = true;
  els.fileName.textContent = '尚未打开文档';
  els.filePath.textContent = '将左侧路径粘贴到这里，或从访达选择';
  els.filePath.title = '';
  els.identityKicker.textContent = '静候一页文字';
  els.docKindBadge.hidden = true;
  document.title = '墨读 · 本地 Markdown 阅读器';
  buildOutline([]);
  els.readerScroll.scrollTop = 0;
  updateProgress();
}

function connectEvents() {
  if (state.expired) return;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  stopFallback();
  setConnection('connecting');

  const source = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  state.eventSource = source;

  source.addEventListener('open', () => {
    if (state.eventSource !== source) return;
    setConnection('live');
    stopFallback();
  });

  source.addEventListener('hello', (event) => {
    if (state.eventSource !== source) return;
    const payload = parseEvent(event);
    if (!payload) return;
    setConnection('live');
    stopFallback();
    setServerStatus(payload.status);
    if (payload.doc) {
      const samePath = state.current?.path === payload.doc.path;
      applyDocument(payload.doc, { reason: 'reconnect', preserve: samePath });
    }
  });

  source.addEventListener('doc-changed', (event) => {
    if (state.eventSource !== source) return;
    const payload = parseEvent(event);
    if (!payload?.doc) return;
    setServerStatus(payload.status);
    const samePath = state.current?.path === payload.doc.path;
    applyDocument(payload.doc, { reason: 'update', preserve: samePath });
    if (!samePath) {
      saveRecent(payload.doc);
      els.pathInput.value = payload.doc.path;
    }
    if (samePath) showUpdatePill();
    state.connection = 'live';
    refreshStatusUI();
    updateAlertForState();
  });

  source.addEventListener('doc-recovered', (event) => {
    if (state.eventSource !== source) return;
    const payload = parseEvent(event);
    if (!payload) return;
    setServerStatus(payload.status);
    if (payload.doc && payload.doc.revision !== state.current?.revision) {
      applyDocument(payload.doc, { reason: 'recovered', preserve: true });
    }
    showToast('原文件已恢复，实时同步继续。', 'success');
  });

  source.addEventListener('doc-status', (event) => {
    if (state.eventSource !== source) return;
    const payload = parseEvent(event);
    if (!payload?.status) return;
    setServerStatus(payload.status);
    if (payload.status.key === 'missing') flashUpdate('原文件已删除 · 等待恢复');
    if (payload.status.key === 'error') flashUpdate('同步暂时中断');
  });

  source.addEventListener('ping', (event) => {
    if (state.eventSource !== source) return;
    const payload = parseEvent(event);
    if (!payload?.status) return;
    state.serverStatus = payload.status;
    refreshStatusUI();
    updateAlertForState();
  });

  source.addEventListener('error', () => {
    if (state.eventSource !== source || state.expired) return;
    setConnection('reconnecting');
    startFallback();
  });
}

function parseEvent(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function startFallback() {
  if (state.expired || state.fallbackTimer) return;
  const poll = async () => {
    state.fallbackTimer = null;
    if (state.expired || state.connection === 'live') return;
    if (state.fallbackBusy) {
      state.fallbackTimer = window.setTimeout(poll, 1600);
      return;
    }
    state.fallbackBusy = true;
    try {
      const payload = await api('/api/state');
      if (state.expired || state.connection === 'live') return;
      setServerStatus(payload.status);
      if (payload.doc) {
        const samePath = state.current?.path === payload.doc.path;
        applyDocument(payload.doc, { reason: 'fallback', preserve: samePath });
      }
      state.connection = 'fallback';
      refreshStatusUI();
      updateAlertForState();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        state.connection = 'reconnecting';
        refreshStatusUI();
        updateAlertForState();
      }
    } finally {
      state.fallbackBusy = false;
      if (!state.expired && state.connection !== 'live' && !state.fallbackTimer) {
        state.fallbackTimer = window.setTimeout(poll, 1600);
      }
    }
  };
  state.fallbackTimer = window.setTimeout(poll, 200);
}

function stopFallback() {
  window.clearTimeout(state.fallbackTimer);
  state.fallbackTimer = null;
}

async function refreshFromServer() {
  if (state.expired) return;
  try {
    const payload = await api('/api/state');
    setServerStatus(payload.status);
    if (payload.doc) {
      const samePath = state.current?.path === payload.doc.path;
      applyDocument(payload.doc, { reason: 'manual', preserve: samePath });
    }
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      showToast(error.message || '暂时无法读取同步状态。', 'error');
    }
  }
}

function openSearch() {
  if (documentKind(state.current) === 'html') {
    showToast('HTML 交互页内暂不支持墨读查找；请在页面内使用它自己的查找方式。', 'info');
    return;
  }
  if (!state.current) {
    showToast('打开文稿后即可查找。', 'info');
    return;
  }
  closeSettings();
  closeCloudPanel();
  state.search.open = true;
  els.searchPanel.hidden = false;
  els.searchPanel.classList.add('is-open');
  els.findTrigger.classList.add('is-active');
  els.searchInput.focus();
  els.searchInput.select();
  if (state.search.query) runSearch({ preserveIndex: true, scroll: false });
}

function closeSearch() {
  state.search.open = false;
  els.searchPanel.hidden = true;
  els.searchPanel.classList.remove('is-open');
  els.findTrigger.classList.remove('is-active');
  clearSearchHighlights();
  if (state.search.supported) {
    CSS.highlights.delete('md-search');
    CSS.highlights.delete('md-search-active');
  }
  state.search.ranges = [];
}

function clearSearchHighlights() {
  if (state.search.supported) {
    CSS.highlights.delete('md-search');
    CSS.highlights.delete('md-search-active');
  }
}

function collectRanges(query) {
  if (!query || !state.search.supported) return [];
  const needle = query.toLocaleLowerCase('zh-CN');
  const walker = document.createTreeWalker(els.doc, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, .md-image-blocked')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const ranges = [];
  let node;
  while ((node = walker.nextNode()) && ranges.length < 1000) {
    const haystack = node.nodeValue.toLocaleLowerCase('zh-CN');
    let from = 0;
    while (ranges.length < 1000) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      ranges.push(range);
      from = index + query.length;
    }
  }
  return ranges;
}

function paintSearchHighlights() {
  if (!state.search.supported) return;
  clearSearchHighlights();
  if (!state.search.ranges.length) return;
  CSS.highlights.set('md-search', new Highlight(...state.search.ranges));
  const active = state.search.ranges[state.search.index];
  if (active) CSS.highlights.set('md-search-active', new Highlight(active));
}

function runSearch({ preserveIndex = false, scroll = true } = {}) {
  const query = els.searchInput.value;
  state.search.query = query;
  const previousIndex = state.search.index;
  state.search.ranges = collectRanges(query);
  if (!state.search.ranges.length) {
    state.search.index = 0;
  } else if (preserveIndex) {
    state.search.index = Math.min(previousIndex, state.search.ranges.length - 1);
  } else {
    state.search.index = 0;
  }

  if (!query) {
    els.searchCount.textContent = '0 / 0';
  } else if (!state.search.ranges.length) {
    els.searchCount.textContent = state.search.supported ? '无结果' : '不支持高亮';
  } else {
    els.searchCount.textContent = `${state.search.index + 1} / ${state.search.ranges.length}`;
  }

  paintSearchHighlights();
  if (scroll && state.search.ranges.length) jumpToSearchRange({ smooth: false });
}

function jumpToSearchRange({ smooth = false } = {}) {
  const range = state.search.ranges[state.search.index];
  if (!range) return;
  paintSearchHighlights();
  const rect = range.getBoundingClientRect();
  const container = els.readerScroll;
  const containerRect = container.getBoundingClientRect();
  const targetTop = container.scrollTop + rect.top - containerRect.top - container.clientHeight * 0.32;
  container.scrollTo({ top: Math.max(0, targetTop), behavior: smooth ? 'smooth' : 'auto' });
  els.searchCount.textContent = `${state.search.index + 1} / ${state.search.ranges.length}`;
}

function moveSearch(delta) {
  if (!state.search.ranges.length) return;
  state.search.index = (state.search.index + delta + state.search.ranges.length) % state.search.ranges.length;
  jumpToSearchRange({ smooth: false });
}

function openSettings() {
  closeSearch();
  closeSharePanel();
  closeCloudPanel();
  els.settingsPanel.hidden = false;
  els.settingsToggle.setAttribute('aria-expanded', 'true');
  els.settingsPanel.classList.add('is-open');
  window.setTimeout(() => els.settingsPanel.querySelector('button')?.focus(), 20);
}

function closeSettings() {
  if (els.settingsPanel.hidden) return;
  els.settingsPanel.hidden = true;
  els.settingsPanel.classList.remove('is-open');
  els.settingsToggle.setAttribute('aria-expanded', 'false');
}

function toggleSettings() {
  if (els.settingsPanel.hidden) openSettings();
  else closeSettings();
}

function openMobileSidebar() {
  els.sidebar.classList.add('is-open');
  els.scrim.hidden = false;
  document.body.classList.add('sidebar-open');
  els.sidebarToggle.setAttribute('aria-expanded', 'true');
}

function closeMobileSidebar() {
  if (!els.sidebar.classList.contains('is-open')) return;
  els.sidebar.classList.remove('is-open');
  els.scrim.hidden = true;
  document.body.classList.remove('sidebar-open');
  els.sidebarToggle.setAttribute('aria-expanded', 'false');
}

function closeTransientPanels() {
  let closed = false;
  if (!els.dropChoice.hidden) {
    closeDropChoice();
    closed = true;
  }
  if (!els.cloudPanel.hidden) {
    closeCloudPanel();
    closed = true;
  }
  if (!els.settingsPanel.hidden) {
    closeSettings();
    closed = true;
  }
  if (!els.sharePanel.hidden) {
    closeSharePanel();
    closed = true;
  }
  if (state.search.open) {
    closeSearch();
    closed = true;
  }
  if (els.sidebar.classList.contains('is-open')) {
    closeMobileSidebar();
    closed = true;
  }
  return closed;
}

function closeSharePanel() {
  if (els.sharePanel.hidden) return;
  state.share.panelOpen = false;
  els.sharePanel.hidden = true;
  els.sharePanel.classList.remove('is-open');
  els.shareTrigger.setAttribute('aria-expanded', 'false');
}

function openSharePanel() {
  closeSettings();
  closeSearch();
  closeCloudPanel();
  state.share.panelOpen = true;
  els.sharePanel.hidden = false;
  els.sharePanel.classList.add('is-open');
  els.shareTrigger.setAttribute('aria-expanded', 'true');
  loadShareState();
  window.setTimeout(() => els.sharePanel.querySelector('button')?.focus(), 20);
}

function toggleSharePanel() {
  if (els.sharePanel.hidden) openSharePanel();
  else closeSharePanel();
}

function syncShareButtons() {
  const busy = state.share.loading;
  const isHtml = documentKind(state.current) === 'html';
  els.shareStart.disabled = busy || !state.current || isHtml;
  els.shareReplace.disabled = busy || !state.current || isHtml;
  els.shareRevoke.disabled = busy;
  els.shareTrigger.disabled = isHtml;
  els.shareTrigger.title = isHtml
    ? 'HTML 交互页请通过云端文库分享；iPad 局域网只支持 Markdown'
    : '在 iPad 上阅读当前文档';
}

function applyShareState(share) {
  const active = share && share.active ? share : null;
  const isHtml = documentKind(state.current) === 'html';
  state.share.active = isHtml ? null : active;
  els.shareLiveDot.hidden = !active || isHtml;
  els.shareTrigger.classList.toggle('has-share', Boolean(active) && !isHtml);
  els.shareHtmlNote.hidden = !isHtml;

  if (isHtml) {
    els.shareEmpty.hidden = true;
    els.shareIdle.hidden = true;
    els.shareActive.hidden = true;
    els.shareOtherNote.hidden = true;
    syncShareButtons();
    return;
  }

  els.shareEmpty.hidden = Boolean(state.current) || Boolean(active);
  els.shareIdle.hidden = !state.current || Boolean(active);
  els.shareActive.hidden = !active;

  if (!active) {
    els.shareCurrentName.textContent = state.current
      ? `${state.current.name} · ${state.current.dir}`
      : '';
    syncShareButtons();
    return;
  }

  els.shareActiveName.textContent = active.name || '当前文稿';
  els.shareAddress.value = active.address || '';
  els.shareLink.value = active.link || '';

  const differs = Boolean(state.current) && (
    (active.path && active.path !== state.current.path)
    || (!active.path && active.name !== state.current.name)
  );
  els.shareOtherNote.hidden = !differs;
  els.shareReplace.hidden = !differs;

  syncShareButtons();
}

async function loadShareState({ quiet = true } = {}) {
  if (state.expired) return;
  try {
    const payload = await api('/api/share');
    applyShareState(payload.share);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    if (!quiet) showToast(error.message || '无法读取分享状态。', 'error');
  }
}

async function startShare() {
  if (state.share.loading || state.expired) return;
  if (documentKind(state.current) === 'html') {
    showToast('HTML 交互页暂不支持 iPad 局域网分享；请先把原文件明确加入云端文库。', 'info');
    return;
  }
  if (!state.current) {
    showToast('请先打开一份文稿，再开启 iPad 阅读。', 'info');
    return;
  }

  state.share.loading = true;
  syncShareButtons();
  try {
    const payload = await api('/api/share', { method: 'POST', body: {} });
    applyShareState(payload.share);
    showToast('已开启只读分享。请让 iPad 与 Mac 连接同一 WiFi。', 'success');
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      showToast(error.message || '无法开启 iPad 阅读分享。', 'error');
      await loadShareState();
    }
  } finally {
    state.share.loading = false;
    syncShareButtons();
  }
}

async function revokeShare() {
  if (state.share.loading || state.expired) return;
  state.share.loading = true;
  syncShareButtons();
  try {
    const payload = await api('/api/share/revoke', { method: 'POST', body: {} });
    applyShareState(payload.share);
    showToast('分享已撤销，原链接立即失效。', 'success');
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      showToast(error.message || '无法撤销分享。', 'error');
      await loadShareState();
    }
  } finally {
    state.share.loading = false;
    syncShareButtons();
  }
}

async function copyShareValue(value, input, label) {
  const text = String(value || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label}已复制。`, 'success');
    return;
  } catch {
    // Fall through to the selection-based copy for older WebKit.
  }
  try {
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
    if (document.execCommand('copy')) {
      showToast(`${label}已复制。`, 'success');
      return;
    }
  } catch {
    // The user can still select the field manually.
  }
  showToast('无法自动复制，请长按或拖选链接后复制。', 'error');
}

function cloudBridge() {
  return window.moduDesktop?.sync || null;
}

function cleanBridgeError(error) {
  return String(error?.message || error || '云端同步失败。')
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '');
}

function cloudDocForCurrent() {
  const current = state.current;
  if (!current) return null;
  return (state.cloud.state?.documents || []).find((doc) => doc.path === current.path) || null;
}

/* ------------------------------------------------------ cloud library */

function cloudLibraryPollMs() {
  const configured = Number($('meta[name="modu-cloud-library-poll-ms"]')?.content);
  return Number.isFinite(configured) && configured >= 250
    ? Math.min(60_000, configured)
    : 15_000;
}

function normalizeCloudLibrary(raw) {
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

function setCloudLibrary(raw, { loaded = true } = {}) {
  const library = normalizeCloudLibrary(raw);
  state.cloud.library = library;
  state.cloud.libraryLoaded = loaded;
  state.cloud.librarySignature = JSON.stringify({
    revision: library.revision,
    folders: library.folders,
    assignments: library.assignments,
  });
  if (state.cloud.libraryView.kind === 'folder'
    && !cloudFolderById(state.cloud.libraryView.folderId)) {
    state.cloud.libraryView = { kind: 'all', folderId: '' };
  }
}

function cloudFolderById(id) {
  if (!id) return null;
  return state.cloud.library.folders.find((folder) => folder.id === id) || null;
}

function cloudFolderChildren(parentId) {
  return state.cloud.library.folders
    .filter((folder) => (folder.parentId || null) === (parentId || null))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

function cloudFolderDocCount(folderId) {
  return state.cloud.libraryDocuments.filter((doc) => state.cloud.library.assignments[doc.id] === folderId).length;
}

function cloudDocFolderId(doc) {
  const folderId = state.cloud.library.assignments[doc.id];
  return folderId && cloudFolderById(folderId) ? folderId : '';
}

function cloudCurrentFolder() {
  return state.cloud.libraryView.kind === 'folder'
    ? cloudFolderById(state.cloud.libraryView.folderId)
    : null;
}

function cloudFolderAncestors(folder) {
  const chain = [];
  const seen = new Set();
  let node = folder;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.unshift(node);
    node = node.parentId ? cloudFolderById(node.parentId) : null;
  }
  return chain;
}

function cloudFolderDescendantIds(folderId) {
  const ids = new Set();
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    for (const child of cloudFolderChildren(id)) stack.push(child.id);
  }
  return ids;
}

function cloudDocsInView() {
  const { kind, folderId } = state.cloud.libraryView;
  if (kind === 'root') {
    return state.cloud.libraryDocuments.filter((doc) => !cloudDocFolderId(doc));
  }
  if (kind === 'folder') {
    return state.cloud.libraryDocuments.filter((doc) => cloudDocFolderId(doc) === folderId);
  }
  return [...state.cloud.libraryDocuments];
}

function syncCloudLibraryButtons() {
  const bridge = cloudBridge();
  const disabled = !bridge
    || typeof bridge.getLibrary !== 'function'
    || !state.cloud.state?.configured
    || state.cloud.libraryLoading
    || state.cloud.dialogBusy
    || !state.cloud.libraryLoaded
    || navigator.onLine === false;
  if (els.cloudFolderCreate) els.cloudFolderCreate.disabled = disabled;
  for (const button of [els.cloudFolderRename, els.cloudFolderMove, els.cloudFolderDelete]) {
    if (button) button.disabled = disabled;
  }
  if (els.cloudLibraryRefresh) {
    els.cloudLibraryRefresh.disabled = !bridge
      || typeof bridge.getLibrary !== 'function'
      || !state.cloud.state?.configured
      || state.cloud.libraryLoading;
  }
}

function renderCloudLibraryState() {
  if (!els.cloudLibraryState) return;
  let kind = '';
  let message = '';
  let retry = false;
  if (!state.cloud.state?.configured) {
    message = '';
  } else if (typeof cloudBridge()?.getLibrary !== 'function') {
    kind = 'error';
    message = '当前桌面版没有文件夹接口。文稿仍可同步，文件夹操作暂不可用。';
  } else if (navigator.onLine === false) {
    kind = 'offline';
    message = '当前离线。文件夹保持上次成功读取的内容；恢复网络后可刷新。';
  } else if (state.cloud.libraryConflict) {
    kind = 'conflict';
    message = '云端文库已在其他设备更新。已刷新为最新版本，请确认后重试；不会自动覆盖。';
  } else if (state.cloud.libraryLoading) {
    kind = 'loading';
    message = '正在刷新云端文件夹…';
  } else if (state.cloud.libraryError) {
    kind = 'error';
    message = state.cloud.libraryError;
    retry = true;
  } else if (!state.cloud.libraryLoaded) {
    kind = 'error';
    message = '尚未读取云端文件夹。点“刷新”重试；文稿同步不受影响。';
    retry = true;
  }
  els.cloudLibraryState.hidden = !message;
  if (message) {
    els.cloudLibraryState.dataset.kind = kind;
    els.cloudLibraryStateText.textContent = message;
  }
  els.cloudLibraryRetry.hidden = !retry;
  syncCloudLibraryButtons();
}

function renderCloudFolderTree() {
  if (!els.cloudFolderTree) return;
  els.cloudFolderTree.replaceChildren();
  const view = state.cloud.libraryView;
  const addFilter = (kind, label, count, mark) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cloud-folder-filter';
    button.dataset.libraryView = kind;
    button.setAttribute('aria-current', String(view.kind === kind));
    const markNode = document.createElement('span');
    markNode.className = 'cloud-folder-mark';
    markNode.setAttribute('aria-hidden', 'true');
    markNode.textContent = mark;
    const name = document.createElement('span');
    name.textContent = label;
    const countNode = document.createElement('span');
    countNode.className = 'cloud-folder-count';
    countNode.textContent = String(count);
    button.append(markNode, name, countNode);
    button.addEventListener('click', () => setCloudLibraryView(kind));
    els.cloudFolderTree.append(button);
  };

  addFilter('all', '全部文稿', state.cloud.libraryDocuments.length, '全');
  if (state.cloud.libraryLoaded) {
    const unfiled = state.cloud.libraryDocuments.filter((doc) => !cloudDocFolderId(doc)).length;
    addFilter('root', '未归档', unfiled, '根');
    const addBranch = (parentId, depth) => {
      if (depth > 12) return;
      for (const folder of cloudFolderChildren(parentId)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cloud-folder-item';
        button.dataset.folderId = folder.id;
        button.style.setProperty('--folder-depth', String(depth));
        button.setAttribute('aria-current', String(view.kind === 'folder' && view.folderId === folder.id));
        const mark = document.createElement('span');
        mark.className = 'cloud-folder-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '▸';
        const name = document.createElement('span');
        name.textContent = folder.name;
        const count = document.createElement('span');
        count.className = 'cloud-folder-count';
        count.textContent = String(cloudFolderDocCount(folder.id));
        button.append(mark, name, count);
        button.addEventListener('click', () => setCloudLibraryView('folder', folder.id));
        els.cloudFolderTree.append(button);
        addBranch(folder.id, depth + 1);
      }
    };
    addBranch(null, 0);
    if (!state.cloud.library.folders.length) {
      const empty = document.createElement('p');
      empty.className = 'cloud-folder-empty';
      empty.textContent = '还没有文件夹。点“新建”开始整理。';
      els.cloudFolderTree.append(empty);
    }
  } else {
    const note = document.createElement('p');
    note.className = 'cloud-folder-empty';
    note.textContent = '尚未读取文件夹。';
    els.cloudFolderTree.append(note);
  }
  syncCloudLibraryButtons();
}

function renderCloudFolderBreadcrumb() {
  if (!els.cloudFolderBreadcrumb) return;
  if (state.cloud.libraryView.kind === 'folder'
    && !cloudFolderById(state.cloud.libraryView.folderId)) {
    state.cloud.libraryView = { kind: 'all', folderId: '' };
  }
  const folder = cloudCurrentFolder();
  const docs = cloudDocsInView();
  const count = document.createElement('span');
  count.className = 'cloud-crumb-count';
  count.textContent = `${docs.length} 份`;
  if (state.cloud.libraryView.kind === 'folder' && folder) {
    const chain = cloudFolderAncestors(folder);
    const nodes = [];
    chain.forEach((entry, index) => {
      if (index > 0) {
        const separator = document.createElement('span');
        separator.className = 'cloud-crumb-sep';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '/';
        nodes.push(separator);
      }
      if (index === chain.length - 1) {
        const current = document.createElement('span');
        current.className = 'cloud-crumb-current';
        current.textContent = entry.name;
        nodes.push(current);
      } else {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'cloud-crumb-link';
        link.textContent = entry.name;
        link.setAttribute('aria-label', `打开文件夹 ${entry.name}`);
        link.addEventListener('click', () => setCloudLibraryView('folder', entry.id));
        nodes.push(link);
      }
    });
    els.cloudFolderBreadcrumb.replaceChildren(...nodes, count);
    els.cloudFolderActions.hidden = false;
  } else {
    const current = document.createElement('span');
    current.className = 'cloud-crumb-current';
    current.textContent = state.cloud.libraryView.kind === 'root' ? '未归档' : '全部文稿';
    els.cloudFolderBreadcrumb.replaceChildren(current, count);
    els.cloudFolderActions.hidden = true;
  }
  syncCloudLibraryButtons();
}

function renderCloudOnlineDocs() {
  if (!els.cloudOnlineDocs) return;
  const docs = cloudDocsInView();
  els.cloudOnlineDocs.replaceChildren();
  for (const doc of docs) {
    const row = document.createElement('li');
    row.className = 'cloud-online-item';
    const info = document.createElement('div');
    info.className = 'cloud-online-info';
    const name = document.createElement('span');
    name.className = 'cloud-online-name';
    name.textContent = doc.name;
    name.title = doc.name;
    const meta = document.createElement('span');
    meta.className = 'cloud-online-meta';
    const kind = document.createElement('span');
    kind.className = 'doc-kind-badge cloud-doc-kind';
    kind.textContent = documentKind(doc) === 'html' ? 'HTML' : 'MD';
    const time = document.createElement('span');
    time.textContent = doc.updatedAt ? formatTime(doc.updatedAt) : '云端文稿';
    const folderName = cloudDocFolderId(doc)
      ? cloudFolderById(cloudDocFolderId(doc))?.name
      : '未归档';
    const folder = document.createElement('span');
    folder.className = 'cloud-online-folder';
    folder.textContent = folderName || '未归档';
    meta.append(kind, folder, time);
    info.append(name, meta);

    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'cloud-online-move';
    move.dataset.moveDocId = doc.id;
    move.textContent = '移动';
    move.setAttribute('aria-label', `移动 ${doc.name} 到其他文件夹`);
    move.disabled = !state.cloud.libraryLoaded
      || state.cloud.libraryLoading
      || state.cloud.dialogBusy
      || navigator.onLine === false;
    move.addEventListener('click', () => openCloudLibraryDialog('move-document', { docId: doc.id }));

    row.append(info, move);
    els.cloudOnlineDocs.append(row);
  }
  els.cloudOnlineEmpty.hidden = docs.length > 0;
  if (!docs.length) {
    if (!state.cloud.libraryDocuments.length) {
      els.cloudOnlineEmpty.textContent = '云端还没有文稿。从本机加入后，这里会列出全部在线文稿。';
    } else if (state.cloud.libraryView.kind === 'folder') {
      els.cloudOnlineEmpty.textContent = '这个文件夹还没有文稿。可把文稿移动进来，或新建子文件夹。';
    } else if (state.cloud.libraryView.kind === 'root') {
      els.cloudOnlineEmpty.textContent = '没有未归档的文稿。';
    } else {
      els.cloudOnlineEmpty.textContent = '当前没有可显示的云端文稿。';
    }
  }
  syncCloudLibraryButtons();
}

function renderCloudLibrary() {
  if (!els.cloudOnline) return;
  const available = Boolean(cloudBridge())
    && Boolean(state.cloud.state?.configured);
  els.cloudOnline.hidden = !available;
  if (!available) {
    els.cloudFolderTree.replaceChildren();
    els.cloudFolderBreadcrumb.replaceChildren();
    els.cloudFolderActions.hidden = true;
    els.cloudLibraryState.hidden = true;
    els.cloudOnlineDocs.replaceChildren();
    els.cloudOnlineEmpty.hidden = true;
    syncCloudLibraryButtons();
    return;
  }
  renderCloudFolderTree();
  renderCloudFolderBreadcrumb();
  renderCloudLibraryState();
  renderCloudOnlineDocs();
}

function setCloudLibraryView(kind, folderId = '') {
  if (kind === 'folder' && !cloudFolderById(folderId)) return;
  if (kind === 'root' && !state.cloud.libraryLoaded) return;
  state.cloud.libraryView = kind === 'folder'
    ? { kind, folderId }
    : { kind, folderId: '' };
  renderCloudFolderTree();
  renderCloudFolderBreadcrumb();
  renderCloudLibraryState();
  renderCloudOnlineDocs();
}

function cloudLibraryErrorFromEnvelope(error) {
  const failure = new Error(error?.message || '云端文件夹操作失败。');
  failure.code = error?.code || 'LIBRARY_REQUEST_FAILED';
  failure.status = Number(error?.status) || 0;
  return failure;
}

async function refreshCloudLibrary({ quiet = false } = {}) {
  const bridge = cloudBridge();
  if (!bridge || typeof bridge.getLibrary !== 'function') {
    state.cloud.libraryLoaded = false;
    renderCloudLibrary();
    return false;
  }
  if (!state.cloud.state?.configured) {
    state.cloud.libraryLoaded = false;
    state.cloud.libraryDocuments = [];
    state.cloud.library = { revision: 0, folders: [], assignments: {} };
    renderCloudLibrary();
    return false;
  }
  const requestId = state.cloud.libraryRequestId + 1;
  state.cloud.libraryRequestId = requestId;
  const serverUrl = state.cloud.state?.serverUrl || '';
  const serverUser = state.cloud.state?.serverUser || '';
  state.cloud.libraryLoading = true;
  if (!quiet) renderCloudLibraryState();
  try {
    const result = await bridge.getLibrary();
    if (requestId !== state.cloud.libraryRequestId) return false;
    if (serverUrl !== (state.cloud.state?.serverUrl || '')
      || serverUser !== (state.cloud.state?.serverUser || '')) {
      return false;
    }
    if (!result || result.ok !== true) {
      throw cloudLibraryErrorFromEnvelope(result?.error);
    }
    if (Array.isArray(result.documents)) state.cloud.libraryDocuments = result.documents;
    if (result.library) setCloudLibrary(result.library, { loaded: true });
    state.cloud.libraryError = '';
    return true;
  } catch (error) {
    if (requestId !== state.cloud.libraryRequestId) return false;
    state.cloud.libraryError = navigator.onLine === false
      ? '当前离线，文件夹保持上次成功读取的内容。恢复网络后重试。'
      : (error.message || '无法读取云端文件夹。');
    if (!quiet) showToast(state.cloud.libraryError, 'error');
    return false;
  } finally {
    if (requestId === state.cloud.libraryRequestId) {
      state.cloud.libraryLoading = false;
      renderCloudFolderTree();
      renderCloudFolderBreadcrumb();
      renderCloudLibraryState();
      renderCloudOnlineDocs();
      if (isCloudLibraryDialogOpen()) syncCloudLibraryDialog();
    }
  }
}

async function mutateCloudLibrary(payload) {
  const bridge = cloudBridge();
  if (!bridge || typeof bridge.mutateLibrary !== 'function') {
    throw new Error('当前桌面版没有文件夹接口。');
  }
  if (navigator.onLine === false) throw new Error('当前离线，无法整理文件夹。');
  const result = await bridge.mutateLibrary({
    ...payload,
    revision: Number.isInteger(payload.revision) ? payload.revision : state.cloud.library.revision,
  });
  if (!result || result.ok !== true) throw cloudLibraryErrorFromEnvelope(result?.error);
  if (Array.isArray(result.documents)) state.cloud.libraryDocuments = result.documents;
  if (result.library) setCloudLibrary(result.library, { loaded: true });
  state.cloud.libraryConflict = false;
  state.cloud.libraryError = '';
  return result;
}

function startCloudLibraryPoll() {
  stopCloudLibraryPoll();
  if (!state.cloud.panelOpen
    || !state.cloud.state?.configured
    || typeof cloudBridge()?.getLibrary !== 'function') return;
  state.cloud.libraryPollTimer = window.setTimeout(async () => {
    state.cloud.libraryPollTimer = null;
    if (!state.cloud.panelOpen) return;
    if (!document.hidden && navigator.onLine !== false) {
      await refreshCloudLibrary({ quiet: true });
    }
    startCloudLibraryPoll();
  }, cloudLibraryPollMs());
}

function stopCloudLibraryPoll() {
  if (state.cloud.libraryPollTimer) {
    window.clearTimeout(state.cloud.libraryPollTimer);
    state.cloud.libraryPollTimer = null;
  }
}

/* -------------------------------------------------- cloud library dialog */

function isCloudLibraryDialogOpen() {
  return Boolean(els.cloudLibraryDialog && !els.cloudLibraryDialog.hidden);
}

function setCloudLibraryError(message, kind = 'error') {
  els.cloudLibraryError.hidden = !message;
  els.cloudLibraryError.dataset.kind = kind;
  els.cloudLibraryError.textContent = message || '';
}

function populateCloudParentSelect(selectedId, excludeIds = new Set(), rootLabel = '未归档（根目录）') {
  els.cloudLibraryParent.replaceChildren();
  const root = document.createElement('option');
  root.value = '';
  root.textContent = rootLabel;
  els.cloudLibraryParent.append(root);
  const addBranch = (parentId, depth) => {
    if (depth > 12) return;
    for (const folder of cloudFolderChildren(parentId)) {
      if (excludeIds.has(folder.id)) continue;
      const option = document.createElement('option');
      option.value = folder.id;
      option.textContent = `${'— '.repeat(depth)}${folder.name}`;
      els.cloudLibraryParent.append(option);
      addBranch(folder.id, depth + 1);
    }
  };
  addBranch(null, 0);
  if (selectedId && cloudFolderById(selectedId) && !excludeIds.has(selectedId)) {
    els.cloudLibraryParent.value = selectedId;
  } else {
    els.cloudLibraryParent.value = '';
  }
}

function validateCloudFolderName(raw) {
  const name = String(raw || '').trim();
  const length = Array.from(name).length;
  if (!name) return { ok: false, message: '请填写文件夹名称。' };
  if (length > 80) return { ok: false, message: '文件夹名称不能超过 80 个字符。' };
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, message: '文件夹名称不能包含斜杠或控制字符。' };
  }
  return { ok: true, name };
}

function renderCloudLibraryDialog(initial = true) {
  const dialog = state.cloud.dialog;
  if (!dialog) return;
  const folder = dialog.folderId ? cloudFolderById(dialog.folderId) : null;
  const doc = dialog.docId
    ? state.cloud.libraryDocuments.find((entry) => entry.id === dialog.docId) || null
    : null;
  els.cloudLibraryNameField.hidden = true;
  els.cloudLibraryParentField.hidden = true;
  els.cloudLibrarySubject.hidden = true;
  els.cloudLibrarySubmit.disabled = false;
  els.cloudLibrarySubmit.classList.remove('is-danger');

  if (dialog.mode === 'create-folder') {
    els.cloudLibraryKicker.textContent = 'NEW FOLDER';
    els.cloudLibraryTitle.textContent = '新建文件夹';
    els.cloudLibraryCopy.textContent = '文件夹只整理云端文库，不移动 Mac 上的原文件，也不改变同步设置。';
    els.cloudLibraryNameField.hidden = false;
    els.cloudLibraryParentField.hidden = false;
    els.cloudLibrarySubmit.textContent = '创建文件夹';
    if (initial) {
      els.cloudLibraryName.value = '';
      const selected = state.cloud.libraryView.kind === 'folder'
        ? state.cloud.libraryView.folderId
        : '';
      populateCloudParentSelect(selected, new Set(), '根目录（无上级）');
    }
  } else if (dialog.mode === 'rename-folder') {
    if (!folder) return closeCloudLibraryDialog();
    els.cloudLibraryKicker.textContent = 'RENAME FOLDER';
    els.cloudLibraryTitle.textContent = '重命名文件夹';
    els.cloudLibraryCopy.textContent = '只改变云端文件夹名称；文稿归类与本地文件保持不变。';
    els.cloudLibraryNameField.hidden = false;
    els.cloudLibrarySubmit.textContent = '保存名称';
    if (initial) els.cloudLibraryName.value = folder.name;
  } else if (dialog.mode === 'move-folder') {
    if (!folder) return closeCloudLibraryDialog();
    els.cloudLibraryKicker.textContent = 'MOVE FOLDER';
    els.cloudLibraryTitle.textContent = '移动文件夹';
    els.cloudLibraryCopy.textContent = '选择新的上级位置。不能把文件夹移动到它自己或它的子文件夹里。';
    els.cloudLibraryParentField.hidden = false;
    els.cloudLibrarySubmit.textContent = '移动文件夹';
    if (initial) populateCloudParentSelect(folder.parentId, cloudFolderDescendantIds(folder.id), '根目录（无上级）');
  } else if (dialog.mode === 'delete-folder') {
    if (!folder) return closeCloudLibraryDialog();
    els.cloudLibraryKicker.textContent = 'DELETE FOLDER';
    els.cloudLibraryTitle.textContent = '删除文件夹';
    els.cloudLibraryCopy.textContent = '只删除文件夹本身。里面的子文件夹和文稿会自动移到上一级，文稿不会被删除。';
    els.cloudLibrarySubject.hidden = false;
    els.cloudLibrarySubject.textContent = folder.name;
    els.cloudLibrarySubmit.textContent = '确认删除文件夹';
    els.cloudLibrarySubmit.classList.add('is-danger');
  } else if (dialog.mode === 'move-document') {
    if (!doc) return closeCloudLibraryDialog();
    els.cloudLibraryKicker.textContent = 'MOVE DOCUMENT';
    els.cloudLibraryTitle.textContent = '移动文稿';
    els.cloudLibraryCopy.textContent = '只改变云端文库中的归类，不移动 Mac 上的原文件，也不改变同步配置。';
    els.cloudLibrarySubject.hidden = false;
    els.cloudLibrarySubject.textContent = doc.name;
    els.cloudLibraryParentField.hidden = false;
    els.cloudLibrarySubmit.textContent = '移动文稿';
    if (initial) populateCloudParentSelect(cloudDocFolderId(doc));
  }
  syncCloudLibraryDialog();
}

function syncCloudLibraryDialog() {
  const dialog = state.cloud.dialog;
  if (!dialog) return;
  const folder = dialog.folderId ? cloudFolderById(dialog.folderId) : null;
  const doc = dialog.docId
    ? state.cloud.libraryDocuments.find((entry) => entry.id === dialog.docId) || null
    : null;
  if ((dialog.mode.includes('folder') && dialog.mode !== 'create-folder' && !folder)
    || (dialog.mode === 'move-document' && !doc)) {
    setCloudLibraryError('这份内容已在其他设备被移动或删除。已刷新文库，请关闭后重新选择。', 'conflict');
    els.cloudLibrarySubmit.disabled = true;
    return;
  }
  if (!els.cloudLibraryParentField.hidden) {
    const previous = els.cloudLibraryParent.value;
    const exclude = dialog.mode === 'move-folder' && folder
      ? cloudFolderDescendantIds(folder.id)
      : new Set();
    populateCloudParentSelect(previous, exclude);
  }
}

function openCloudLibraryDialog(mode, { folderId = '', docId = '' } = {}) {
  if (!state.cloud.state?.configured || !state.cloud.libraryLoaded) return;
  if (navigator.onLine === false) {
    showToast('当前离线，无法整理文件夹。', 'error');
    return;
  }
  if (isCloudLibraryDialogOpen()) closeCloudLibraryDialog({ restoreFocus: false });
  state.cloud.dialog = {
    mode,
    folderId,
    docId,
    baseRevision: state.cloud.library.revision,
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  state.cloud.dialogBusy = false;
  setCloudLibraryError('');
  els.cloudLibraryForm.reset();
  renderCloudLibraryDialog();
  els.cloudLibraryDialog.hidden = false;
  const target = !els.cloudLibraryNameField.hidden
    ? els.cloudLibraryName
    : (!els.cloudLibraryParentField.hidden ? els.cloudLibraryParent : els.cloudLibrarySubmit);
  window.setTimeout(() => target?.focus(), 20);
  syncCloudLibraryButtons();
}

function closeCloudLibraryDialog({ restoreFocus = true } = {}) {
  if (!isCloudLibraryDialogOpen()) {
    state.cloud.dialog = null;
    state.cloud.dialogBusy = false;
    return;
  }
  const opener = state.cloud.dialog?.opener;
  els.cloudLibraryDialog.hidden = true;
  state.cloud.dialog = null;
  state.cloud.dialogBusy = false;
  setCloudLibraryError('');
  syncCloudLibraryButtons();
  if (restoreFocus && opener?.isConnected) {
    window.setTimeout(() => opener.focus({ preventScroll: true }), 0);
  }
}

async function submitCloudLibraryDialog() {
  const dialog = state.cloud.dialog;
  if (!dialog || state.cloud.dialogBusy) return;
  if (navigator.onLine === false) {
    setCloudLibraryError('当前离线，无法保存。恢复网络后重试。', 'offline');
    return;
  }

  const checkedName = validateCloudFolderName(els.cloudLibraryName.value);
  let action = '';
  let payload = {};
  if (dialog.mode === 'create-folder') {
    if (!checkedName.ok) return setCloudLibraryError(checkedName.message);
    action = 'createFolder';
    payload = { action, name: checkedName.name, parentId: els.cloudLibraryParent.value || null };
  } else if (dialog.mode === 'rename-folder') {
    if (!checkedName.ok) return setCloudLibraryError(checkedName.message);
    if (!cloudFolderById(dialog.folderId)) {
      setCloudLibraryError('该文件夹已不存在。请关闭后刷新。');
      return;
    }
    action = 'renameFolder';
    payload = { action, folderId: dialog.folderId, name: checkedName.name };
  } else if (dialog.mode === 'move-folder') {
    if (!cloudFolderById(dialog.folderId)) {
      setCloudLibraryError('该文件夹已不存在。请关闭后刷新。');
      return;
    }
    const parentId = els.cloudLibraryParent.value || null;
    if (parentId && cloudFolderDescendantIds(dialog.folderId).has(parentId)) {
      setCloudLibraryError('不能把文件夹移动到它自己或它的子文件夹里。');
      return;
    }
    if (parentId && !cloudFolderById(parentId)) {
      setCloudLibraryError('目标文件夹已不存在。请重新选择。');
      return;
    }
    action = 'moveFolder';
    payload = { action, folderId: dialog.folderId, parentId };
  } else if (dialog.mode === 'delete-folder') {
    if (!cloudFolderById(dialog.folderId)) {
      setCloudLibraryError('该文件夹已不存在。请关闭后刷新。');
      return;
    }
    action = 'deleteFolder';
    payload = { action, folderId: dialog.folderId };
  } else if (dialog.mode === 'move-document') {
    const doc = state.cloud.libraryDocuments.find((entry) => entry.id === dialog.docId);
    if (!doc) {
      setCloudLibraryError('这份文稿已不在文库。请关闭后刷新。');
      return;
    }
    const folderId = els.cloudLibraryParent.value || null;
    if (folderId && !cloudFolderById(folderId)) {
      setCloudLibraryError('目标文件夹已不存在。请重新选择。');
      return;
    }
    action = 'moveDocument';
    payload = { action, docId: doc.id, folderId };
  } else {
    return;
  }

  const beforeFolder = dialog.folderId ? cloudFolderById(dialog.folderId) : null;
  const beforeDoc = dialog.docId
    ? state.cloud.libraryDocuments.find((entry) => entry.id === dialog.docId) || null
    : null;
  state.cloud.dialogBusy = true;
  els.cloudLibrarySubmit.disabled = true;
  els.cloudLibrarySubmit.textContent = '正在保存…';
  setCloudLibraryError('');
  let conflicted = false;
  try {
    await mutateCloudLibrary({ ...payload, revision: dialog.baseRevision });
    if (dialog.mode === 'delete-folder' && beforeFolder) {
      state.cloud.libraryView = beforeFolder.parentId
        ? { kind: 'folder', folderId: beforeFolder.parentId }
        : { kind: 'all', folderId: '' };
    }
    closeCloudLibraryDialog();
    renderCloudLibrary();
    showToast(action === 'moveDocument'
      ? `已移动 ${beforeDoc?.name || '文稿'}。`
      : action === 'deleteFolder'
        ? '文件夹已删除；文稿与子文件夹已保留。'
        : '云端文件夹已更新。', 'success');
    if (state.cloud.panelOpen) startCloudLibraryPoll();
  } catch (error) {
    if (error.code === 'LIBRARY_CONFLICT' || error.status === 409) {
      conflicted = true;
      state.cloud.libraryConflict = true;
      await refreshCloudLibrary({ quiet: true });
      if (!isCloudLibraryDialogOpen()) return;
      // Keep the typed local edit but submit the next deliberate click against
      // the refreshed revision. No conflict is replayed automatically.
      state.cloud.dialog.baseRevision = state.cloud.library.revision;
      syncCloudLibraryDialog();
      setCloudLibraryError(
        '云端文库已在其他设备更新，已载入最新文件夹。请确认后再次提交，不会自动覆盖。',
        'conflict',
      );
    } else {
      if (error.status === 404) await refreshCloudLibrary({ quiet: true });
      setCloudLibraryError(error.message || '保存失败，请检查网络后重试。');
    }
  } finally {
    if (isCloudLibraryDialogOpen()) {
      state.cloud.dialogBusy = false;
      els.cloudLibrarySubmit.disabled = false;
      const current = state.cloud.dialog;
      if (current) {
        els.cloudLibrarySubmit.textContent = conflicted
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
      syncCloudLibraryDialog();
      syncCloudLibraryButtons();
    }
  }
}

function resetCloudLibrary({ render = true } = {}) {
  stopCloudLibraryPoll();
  closeCloudLibraryDialog({ restoreFocus: false });
  state.cloud.libraryRequestId += 1;
  state.cloud.library = { revision: 0, folders: [], assignments: {} };
  state.cloud.libraryDocuments = [];
  state.cloud.libraryLoaded = false;
  state.cloud.libraryLoading = false;
  state.cloud.libraryError = '';
  state.cloud.libraryConflict = false;
  state.cloud.librarySignature = '';
  state.cloud.libraryView = { kind: 'all', folderId: '' };
  if (render) renderCloudLibrary();
}

function syncCloudButtons() {
  const configured = Boolean(state.cloud.state?.configured);
  const currentDoc = cloudDocForCurrent();
  const currentIsSupported = Boolean(state.current)
    && CLOUD_DOCUMENT_RE.test(state.current.path || state.current.name || '');
  els.cloudAddCurrent.disabled = !currentIsSupported || !configured || state.cloud.loading || Boolean(currentDoc);
  els.cloudAddCurrent.title = currentIsSupported
    ? '把当前这一份文稿明确加入云端文库'
    : '只支持 .md / .markdown / .html / .htm 文稿';
  els.cloudSyncNow.disabled = !configured || state.cloud.loading
    || Boolean(state.cloud.state?.syncing)
    || !(state.cloud.state?.documents || []).length;
  els.cloudSave.disabled = state.cloud.loading;
  els.cloudSave.classList.toggle('is-busy', state.cloud.loading);
  els.cloudEdit.disabled = state.cloud.loading;
}

function renderCloudLibraryIfNeeded() {
  const available = Boolean(cloudBridge()) && Boolean(state.cloud.state?.configured);
  // Upload state events redraw the local sync list frequently. Do not rebuild
  // the online folder tree (and steal focus) unless its visibility or loaded
  // state actually changed; library refreshes render it themselves.
  if (!state.cloud.libraryLoaded || els.cloudOnline.hidden !== !available) {
    renderCloudLibrary();
  }
}

function renderCloudState(cloudState = state.cloud.state) {
  state.cloud.state = cloudState;
  const available = state.cloud.available && Boolean(cloudBridge());
  els.cloudUnavailable.hidden = available;
  if (!available) {
    els.cloudConfigured.hidden = true;
    els.cloudConfig.hidden = true;
    els.cloudBadge.hidden = true;
    syncCloudButtons();
    renderCloudLibrary();
    return;
  }

  const configured = Boolean(cloudState?.configured);
  els.cloudConfigured.hidden = !configured;
  els.cloudConfig.hidden = configured && !els.cloudConfig.dataset.forceOpen;
  if (!configured) {
    els.cloudConfig.hidden = false;
    els.cloudConfig.dataset.forceOpen = '';
    els.cloudAccountText.textContent = '尚未配置云服务';
  }

  if (configured) {
    const docs = cloudState.documents || [];
    const hasError = docs.some((doc) => doc.status === 'error');
    const syncing = Boolean(cloudState.syncing) || docs.some((doc) => doc.status === 'pending');
    const who = cloudState.serverUser || '已连接';
    els.cloudAccountText.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = who;
    els.cloudAccountText.append(strong, document.createTextNode(` · ${cloudState.serverUrl || ''}`));
    els.cloudAccount.dataset.state = hasError ? 'error' : syncing ? 'syncing' : 'connected';
    els.cloudDocCount.textContent = String(docs.length);

    els.cloudDocList.replaceChildren();
    if (!docs.length) {
      const empty = document.createElement('li');
      empty.className = 'cloud-empty';
      empty.textContent = '还没有主动加入的文稿。打开一份 Markdown 或单文件 HTML，再点上面的“加入当前文稿”。';
      els.cloudDocList.append(empty);
    }
    for (const doc of docs) {
      const row = document.createElement('li');
      row.className = 'cloud-doc-item';

      const info = document.createElement('div');
      info.className = 'cloud-doc-info';
      const name = document.createElement('span');
      name.className = 'cloud-doc-name';
      name.textContent = doc.name;
      name.title = doc.path;
      const meta = document.createElement('span');
      meta.className = 'cloud-doc-meta';
      const docKind = documentKind(doc);
      const kindBadge = document.createElement('span');
      kindBadge.className = 'doc-kind-badge cloud-doc-kind';
      kindBadge.textContent = docKind === 'html' ? 'HTML' : 'MD';
      const statusLabel = doc.status === 'synced'
        ? '已同步'
        : doc.status === 'pending'
          ? '同步中'
          : '同步失败';
      const status = document.createElement('span');
      status.className = 'cloud-doc-status';
      status.dataset.status = doc.status;
      status.textContent = statusLabel;
      const time = document.createElement('span');
      time.textContent = doc.lastSyncedAt ? formatTime(doc.lastSyncedAt) : '尚未同步';
      meta.append(kindBadge, status, time);
      info.append(name, meta);

      if (doc.lastError) {
        const error = document.createElement('span');
        error.className = 'cloud-doc-error';
        error.textContent = doc.lastError;
        error.title = doc.lastError;
        info.append(error);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cloud-doc-remove';
      remove.title = '从本地同步列表移除（云端已上传副本保留）';
      remove.setAttribute('aria-label', `从云端文库列表移除 ${doc.name}`);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.classList.add('icon');
      icon.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-x');
      icon.append(use);
      remove.append(icon);
      remove.addEventListener('click', () => removeCloudDocument(doc.path, doc.name));

      row.append(info, remove);
      els.cloudDocList.append(row);
    }

    const pendingPath = state.cloud.pendingAddPath;
    els.cloudPendingNote.hidden = !pendingPath;
    if (pendingPath) {
      els.cloudPendingNote.textContent = `保存配置后会加入：${pendingPath}`;
    }

    els.cloudBadge.hidden = docs.length === 0;
    els.cloudBadge.dataset.state = hasError ? 'error' : (syncing ? 'syncing' : 'synced');
    els.cloudBadge.title = hasError ? '有文稿同步失败' : (syncing ? '正在同步' : '云端已同步');
    els.cloudTrigger.classList.toggle('has-cloud-error', hasError);
    els.cloudToken.placeholder = '已保存，留空保持不变';
    if (document.activeElement !== els.cloudServerUrl) {
      els.cloudServerUrl.value = cloudState.serverUrl || '';
    }
  } else {
    els.cloudDocList.replaceChildren();
    els.cloudDocCount.textContent = '0';
    els.cloudBadge.hidden = true;
    els.cloudTrigger.classList.remove('has-cloud-error');
    els.cloudToken.placeholder = '粘贴 Mac 同步令牌';
    els.cloudConfig.dataset.forceOpen = '1';
    if (!els.cloudServerUrl.value && cloudState?.serverUrl) {
      els.cloudServerUrl.value = cloudState.serverUrl;
    }
  }
  syncCloudButtons();
  renderCloudLibraryIfNeeded();
}

async function refreshCloudState() {
  const bridge = cloudBridge();
  if (!bridge) {
    state.cloud.available = false;
    renderCloudState(null);
    return null;
  }
  try {
    const cloudState = await bridge.getState();
    renderCloudState(cloudState);
    return cloudState;
  } catch (error) {
    state.cloud.available = false;
    showToast(cleanBridgeError(error), 'error');
    renderCloudState(null);
    return null;
  }
}

function subscribeCloudState() {
  const bridge = cloudBridge();
  if (!bridge || state.cloud.unsubscribe) return;
  state.cloud.unsubscribe = bridge.onState((cloudState) => {
    const previous = state.cloud.state;
    const accountChanged = Boolean(previous) && (
      previous.serverUrl !== cloudState?.serverUrl
      || previous.serverUser !== cloudState?.serverUser
      || Boolean(previous.configured) !== Boolean(cloudState?.configured)
    );
    if (accountChanged) resetCloudLibrary({ render: false });
    if (state.cloud.panelOpen || cloudState?.documents?.length) renderCloudState(cloudState);
    if (accountChanged && state.cloud.panelOpen && cloudState?.configured && !state.cloud.loading) {
      refreshCloudLibrary().catch(() => {});
      startCloudLibraryPoll();
    }
  });
}

async function saveCloudSettings() {
  const bridge = cloudBridge();
  if (!bridge || state.cloud.loading) return;
  const serverUrl = els.cloudServerUrl.value.trim();
  const token = els.cloudToken.value.trim();
  if (!serverUrl) {
    els.cloudError.hidden = false;
    els.cloudError.textContent = '请填写云服务地址。';
    return;
  }
  if (!token && !state.cloud.state?.configured) {
    els.cloudError.hidden = false;
    els.cloudError.textContent = '请填写同步令牌。';
    return;
  }
  state.cloud.loading = true;
  els.cloudError.hidden = true;
  syncCloudButtons();
  try {
    const result = await bridge.saveSettings({ serverUrl, token });
    state.cloud.loading = false;
    els.cloudToken.value = '';
    els.cloudConfig.dataset.forceOpen = '';
    resetCloudLibrary({ render: false });
    renderCloudState(result.state);
    showToast(`已连接云端：${result.ping?.user?.username || '同步账号'}`, 'success');
    if (state.cloud.panelOpen && result.state?.configured) {
      refreshCloudLibrary().catch(() => {});
      startCloudLibraryPoll();
    }
    if (state.cloud.pendingAddPath) {
      const pending = state.cloud.pendingAddPath;
      state.cloud.pendingAddPath = '';
      els.cloudPendingNote.hidden = true;
      await addPathToCloud(pending, { source: 'drop' });
    }
  } catch (error) {
    state.cloud.loading = false;
    els.cloudError.hidden = false;
    els.cloudError.textContent = cleanBridgeError(error);
  } finally {
    state.cloud.loading = false;
    syncCloudButtons();
  }
}

async function addPathToCloud(filePath, { source = 'manual' } = {}) {
  const bridge = cloudBridge();
  if (!bridge) {
    showToast('云端同步仅在 Mac 桌面版可用。', 'error');
    return;
  }
  if (!filePath || !filePath.startsWith('/')) {
    showToast('没有取得可加入的本地文稿路径。', 'error');
    return;
  }
  if (!CLOUD_DOCUMENT_RE.test(filePath)) {
    showToast('只有 .md / .markdown / .html / .htm 可以加入云端文库。', 'error');
    return;
  }
  if (!state.cloud.state?.configured) {
    state.cloud.pendingAddPath = filePath;
    openCloudPanel();
    els.cloudConfig.dataset.forceOpen = '1';
    els.cloudConfig.hidden = false;
    els.cloudError.hidden = false;
    els.cloudError.textContent = '请先填写云服务地址与同步令牌；保存后会加入这份文稿。';
    els.cloudPendingNote.hidden = false;
    els.cloudPendingNote.textContent = `保存配置后会加入：${filePath}`;
    els.cloudServerUrl.focus();
    return;
  }

  state.cloud.loading = true;
  syncCloudButtons();
  try {
    const cloudState = await bridge.addPath(filePath);
    renderCloudState(cloudState);
    const added = (cloudState.documents || []).find((doc) => doc.path === filePath);
    if (added?.status === 'error') {
      showToast(added.lastError || '已加入列表，但同步失败。', 'error');
    } else {
      showToast(source === 'drop'
        ? '已加入云端文库并开始同步。'
        : '已将当前文稿加入云端文库。', 'success');
    }
  } catch (error) {
    showToast(cleanBridgeError(error), 'error');
  } finally {
    state.cloud.loading = false;
    syncCloudButtons();
  }
}

async function addCurrentToCloud() {
  if (!state.current) {
    showToast('请先打开一份 Markdown 或 HTML。', 'info');
    return;
  }
  await addPathToCloud(state.current.path, { source: 'current' });
}

async function removeCloudDocument(filePath, name) {
  const bridge = cloudBridge();
  if (!bridge || state.cloud.loading) return;
  state.cloud.loading = true;
  syncCloudButtons();
  try {
    const cloudState = await bridge.removePath(filePath);
    renderCloudState(cloudState);
    showToast(`已从本地同步列表移除 ${name}；云端副本仍保留。`, 'info');
  } catch (error) {
    showToast(cleanBridgeError(error), 'error');
  } finally {
    state.cloud.loading = false;
    syncCloudButtons();
  }
}

async function syncCloudNow() {
  const bridge = cloudBridge();
  if (!bridge || state.cloud.loading) return;
  state.cloud.loading = true;
  syncCloudButtons();
  try {
    const cloudState = await bridge.syncNow();
    renderCloudState(cloudState);
    showToast('手动同步完成。', 'success');
  } catch (error) {
    await refreshCloudState();
    showToast(cleanBridgeError(error), 'error');
  } finally {
    state.cloud.loading = false;
    syncCloudButtons();
  }
}

function openCloudPanel() {
  closeSettings();
  closeSharePanel();
  closeSearch();
  state.cloud.panelOpen = true;
  els.cloudPanel.hidden = false;
  els.cloudPanel.classList.add('is-open');
  els.cloudTrigger.setAttribute('aria-expanded', 'true');
  refreshCloudState().then(() => {
    if (!state.cloud.panelOpen) return;
    refreshCloudLibrary().catch(() => {});
    startCloudLibraryPoll();
  });
  window.setTimeout(() => els.cloudPanel.querySelector('button')?.focus(), 20);
}

function closeCloudPanel() {
  if (els.cloudPanel.hidden) return;
  state.cloud.panelOpen = false;
  stopCloudLibraryPoll();
  closeCloudLibraryDialog({ restoreFocus: false });
  els.cloudPanel.hidden = true;
  els.cloudPanel.classList.remove('is-open');
  els.cloudTrigger.setAttribute('aria-expanded', 'false');
}

function toggleCloudPanel() {
  if (els.cloudPanel.hidden) openCloudPanel();
  else closeCloudPanel();
}

async function initializeCloudSync() {
  const bridge = cloudBridge();
  if (!bridge) {
    state.cloud.available = false;
    renderCloudState(null);
    return;
  }
  state.cloud.available = true;
  subscribeCloudState();
  await refreshCloudState();
}

async function triggerNativePicker() {
  if (state.pickerBusy || state.expired) return;
  state.pickerBusy = true;
  const buttons = [els.pickButton, els.welcomePickButton].filter(Boolean);
  for (const button of buttons) {
    button.disabled = true;
    button.classList.add('is-busy');
  }
  const original = els.pickButton.querySelector('span')?.textContent;
  if (els.pickButton.querySelector('span')) els.pickButton.querySelector('span').textContent = '等待选择…';
  try {
    const payload = await api('/api/pick', { method: 'POST', body: {} });
    if (payload.path) await openPath(payload.path, { source: 'picker' });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    if (error.code === 'PICKER_CANCELLED') {
      showToast('已取消选择。', 'info');
    } else {
      showToast(error.message || '无法打开文件选择器，请改用路径输入。', 'error');
      els.pathInput.focus();
    }
  } finally {
    state.pickerBusy = false;
    for (const button of buttons) {
      button.disabled = false;
      button.classList.remove('is-busy');
    }
    if (els.pickButton.querySelector('span')) {
      els.pickButton.querySelector('span').textContent = original || '从访达选择';
    }
  }
}

function pickFilePathFromDrop(event) {
  const transfer = event.dataTransfer;
  if (!transfer) return '';
  const uriList = transfer.getData('text/uri-list') || '';
  const plain = transfer.getData('text/plain') || '';
  const candidates = `${uriList}\n${plain}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  for (const candidate of candidates) {
    if (candidate.startsWith('file://')) {
      try {
        const url = new URL(candidate);
        if (url.hostname && url.hostname !== 'localhost') continue;
        const decoded = decodeURIComponent(url.pathname);
        if (decoded.startsWith('/')) return decoded;
      } catch {
        // Try the next line.
      }
    } else if (candidate.startsWith('/') && /\.[a-z0-9]+$/i.test(candidate)) {
      return candidate;
    }
  }
  return '';
}

function getDesktopDroppedPath(event) {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return { path: '', reason: 'no-file' };
  const bridge = window.moduDesktop;
  if (typeof bridge?.getPathForFile !== 'function') {
    return { path: '', reason: 'no-bridge' };
  }
  for (const file of files) {
    let filePath = '';
    try {
      filePath = bridge.getPathForFile(file) || '';
    } catch {
      filePath = '';
    }
    if (!filePath) continue;
    if (!LOCAL_DOCUMENT_RE.test(filePath)) {
      return { path: '', reason: 'unsupported', name: file.name };
    }
    return { path: filePath, reason: '' };
  }
  return { path: '', reason: 'no-path' };
}

function showDropChoice(filePath) {
  if (!filePath || !filePath.startsWith('/') || !LOCAL_DOCUMENT_RE.test(filePath)) {
    showToast('只支持拖入 .md / .markdown / .html / .htm 文件。', 'error');
    return;
  }
  state.dropChoicePath = filePath;
  els.dropChoiceName.textContent = `${basename(filePath)} · ${filePath}`;
  els.dropChoice.hidden = false;
  els.dropOpen.focus();
}

function closeDropChoice() {
  if (els.dropChoice.hidden) return;
  els.dropChoice.hidden = true;
  state.dropChoicePath = '';
}

function bindEvents() {
  window.addEventListener('message', handlePreviewReady);

  els.htmlReload.addEventListener('click', () => retryHtmlPreview());
  els.htmlErrorRetry.addEventListener('click', () => retryHtmlPreview());

  els.pathForm.addEventListener('submit', (event) => {
    event.preventDefault();
    openPath(els.pathInput.value, { source: 'manual' });
  });

  for (const button of [els.pickButton, els.welcomePickButton]) {
    button?.addEventListener('click', triggerNativePicker);
  }

  els.sampleButton.addEventListener('click', () => {
    if (!state.samplePath) {
      showToast('示例文稿路径不可用。', 'error');
      return;
    }
    openPath(state.samplePath, { source: 'sample' });
  });

  els.sampleButton.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openPath(state.samplePath, { source: 'sample' });
  });

  els.recentClear.addEventListener('click', () => {
    state.recent = [];
    safeStorageRemove(STORAGE.recent);
    safeStorageRemove(STORAGE.last);
    renderRecent();
  });

  els.themeToggle.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyPreferences({ persist: true });
  });

  for (const button of $$('[data-theme-choice]', els.themeSegment)) {
    button.addEventListener('click', () => {
      state.theme = button.dataset.themeChoice;
      applyPreferences({ persist: true });
    });
  }

  for (const button of $$('[data-width-choice]', els.widthSegment)) {
    button.addEventListener('click', () => {
      const anchor = captureReadingAnchor();
      state.width = button.dataset.widthChoice;
      applyPreferences({ persist: true });
      requestAnimationFrame(() => restoreReadingAnchor(anchor));
    });
  }

  els.fontRange.addEventListener('input', () => {
    const anchor = captureReadingAnchor();
    state.font = Number(els.fontRange.value);
    applyPreferences({ persist: true });
    requestAnimationFrame(() => restoreReadingAnchor(anchor));
  });

  els.followToggle.addEventListener('change', () => {
    state.follow = els.followToggle.checked;
    applyPreferences({ persist: true });
    showToast(state.follow ? '已开启跟随更新：新内容到达时滚到文末。' : '已关闭跟随更新：更新时保持阅读位置。', 'info');
  });

  els.settingsReset.addEventListener('click', () => {
    state.theme = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
    state.font = DEFAULTS.font;
    state.width = DEFAULTS.width;
    state.follow = DEFAULTS.follow;
    applyPreferences({ persist: true });
    showToast('阅读设置已恢复默认。', 'success');
  });

  els.settingsToggle.addEventListener('click', toggleSettings);
  els.settingsClose.addEventListener('click', closeSettings);
  els.shareTrigger.addEventListener('click', toggleSharePanel);
  els.shareClose.addEventListener('click', closeSharePanel);
  els.shareStart.addEventListener('click', () => startShare());
  els.shareReplace.addEventListener('click', () => startShare());
  els.shareRevoke.addEventListener('click', revokeShare);
  els.shareCopyAddress.addEventListener('click', () => {
    copyShareValue(els.shareAddress.value, els.shareAddress, '局域网地址');
  });
  els.shareCopyLink.addEventListener('click', () => {
    copyShareValue(els.shareLink.value, els.shareLink, '分享链接');
  });

  els.cloudTrigger.addEventListener('click', toggleCloudPanel);
  els.cloudClose.addEventListener('click', closeCloudPanel);
  els.cloudEdit.addEventListener('click', () => {
    const forceOpen = !els.cloudConfig.dataset.forceOpen;
    els.cloudConfig.dataset.forceOpen = forceOpen ? '1' : '';
    els.cloudConfig.hidden = !forceOpen;
    if (forceOpen) els.cloudServerUrl.focus();
  });
  els.cloudSave.addEventListener('click', saveCloudSettings);
  els.cloudAddCurrent.addEventListener('click', addCurrentToCloud);
  els.cloudSyncNow.addEventListener('click', syncCloudNow);
  els.cloudServerUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') els.cloudToken.focus();
  });
  els.cloudToken.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveCloudSettings();
  });
  els.cloudLibraryRefresh.addEventListener('click', () => refreshCloudLibrary());
  els.cloudLibraryRetry.addEventListener('click', () => refreshCloudLibrary());
  els.cloudFolderCreate.addEventListener('click', () => openCloudLibraryDialog('create-folder'));
  els.cloudFolderRename.addEventListener('click', () => {
    const folder = cloudCurrentFolder();
    if (folder) openCloudLibraryDialog('rename-folder', { folderId: folder.id });
  });
  els.cloudFolderMove.addEventListener('click', () => {
    const folder = cloudCurrentFolder();
    if (folder) openCloudLibraryDialog('move-folder', { folderId: folder.id });
  });
  els.cloudFolderDelete.addEventListener('click', () => {
    const folder = cloudCurrentFolder();
    if (folder) openCloudLibraryDialog('delete-folder', { folderId: folder.id });
  });
  els.cloudLibraryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitCloudLibraryDialog();
  });
  els.cloudLibraryCancel.addEventListener('click', () => closeCloudLibraryDialog());
  els.cloudLibraryClose.addEventListener('click', () => closeCloudLibraryDialog());
  els.cloudLibraryDialog.addEventListener('click', (event) => {
    if (event.target === els.cloudLibraryDialog) closeCloudLibraryDialog();
  });

  els.dropOpen.addEventListener('click', () => {
    const filePath = state.dropChoicePath;
    closeDropChoice();
    if (filePath) openPath(filePath, { source: 'drop' });
  });
  els.dropAdd.addEventListener('click', () => {
    const filePath = state.dropChoicePath;
    closeDropChoice();
    if (filePath) addPathToCloud(filePath, { source: 'drop' });
  });
  els.dropCancel.addEventListener('click', closeDropChoice);

  els.findTrigger.addEventListener('click', openSearch);
  els.searchClose.addEventListener('click', closeSearch);
  els.searchInput.addEventListener('input', () => runSearch({ preserveIndex: false, scroll: true }));
  els.searchPrev.addEventListener('click', () => moveSearch(-1));
  els.searchNext.addEventListener('click', () => moveSearch(1));
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      moveSearch(event.shiftKey ? -1 : 1);
    }
  });

  els.updatePill.addEventListener('click', hideUpdatePill);
  els.alertAction.addEventListener('click', () => {
    const action = state.alertActionHandler;
    if (action) action();
  });

  els.sidebarToggle.addEventListener('click', () => {
    if (els.sidebar.classList.contains('is-open')) closeMobileSidebar();
    else openMobileSidebar();
  });
  els.sidebarClose.addEventListener('click', closeMobileSidebar);
  els.scrim.addEventListener('click', closeMobileSidebar);

  els.filePath.addEventListener('click', async () => {
    if (!state.current) return;
    try {
      await navigator.clipboard.writeText(state.current.path);
      showToast('已复制文稿路径。', 'success');
    } catch {
      showToast('无法写入剪贴板。', 'error');
    }
  });

  els.readerScroll.addEventListener('scroll', () => {
    updateProgress();
    updateActiveHeading();
  }, { passive: true });

  els.doc.addEventListener('click', (event) => {
    const localLink = event.target.closest('a[data-local-link]');
    if (localLink) {
      event.preventDefault();
      showToast(`本地文档链接：${localLink.dataset.localLink}。请通过左侧路径打开目标文件。`, 'info');
      return;
    }
    const anchor = event.target.closest('a[href^="#"]');
    if (anchor) {
      const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
      if (id && document.getElementById(id)) {
        event.preventDefault();
        scrollToHeading(id, true);
      }
    }
  });

  document.addEventListener('click', (event) => {
    // Folder navigation rebuilds the clicked button itself, so contains(target)
    // can be false by the time this document-level listener runs. The composed
    // path still remembers the panel ancestor that owned the click.
    const path = event.composedPath();
    if (!els.settingsPanel.hidden
      && !path.includes(els.settingsPanel)
      && !path.includes(els.settingsToggle)) {
      closeSettings();
    }
    if (!els.sharePanel.hidden
      && !path.includes(els.sharePanel)
      && !path.includes(els.shareTrigger)) {
      closeSharePanel();
    }
    if (!els.cloudPanel.hidden
      && !isCloudLibraryDialogOpen()
      && !path.includes(els.cloudPanel)
      && !path.includes(els.cloudTrigger)) {
      closeCloudPanel();
    }
  });

  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (isCloudLibraryDialogOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCloudLibraryDialog();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', els.cloudLibraryDialog)
          .filter((node) => node.offsetParent !== null);
        if (focusable.length) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
    }
    if (meta && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      triggerNativePicker();
      return;
    }
    if (meta && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === 'Escape') {
      if (closeTransientPanels()) {
        event.preventDefault();
      }
    }
  });

  window.addEventListener('dragover', (event) => {
    if (![...(event.dataTransfer?.types || [])].some((type) => type === 'Files' || type === 'text/uri-list' || type === 'text/plain')) return;
    event.preventDefault();
    els.dropOverlay.hidden = false;
    requestAnimationFrame(() => els.dropOverlay.classList.add('is-visible'));
  });

  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget) return;
    state.dragDepth = 0;
    els.dropOverlay.classList.remove('is-visible');
    window.setTimeout(() => {
      if (!els.dropOverlay.classList.contains('is-visible')) els.dropOverlay.hidden = true;
    }, 180);
  });

  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    els.dropOverlay.classList.remove('is-visible');
    window.setTimeout(() => { els.dropOverlay.hidden = true; }, 180);

    const hasDesktopBridge = typeof window.moduDesktop?.getPathForFile === 'function';
    if (hasDesktopBridge && event.dataTransfer?.files?.length) {
      const desktopDrop = getDesktopDroppedPath(event);
      if (desktopDrop.path) {
        showDropChoice(desktopDrop.path);
        return;
      }
      const fallbackPath = pickFilePathFromDrop(event);
      if (fallbackPath && LOCAL_DOCUMENT_RE.test(fallbackPath)) {
        showDropChoice(fallbackPath);
        return;
      }
      if (desktopDrop.reason === 'unsupported') {
        showToast(`只支持拖入 .md / .markdown / .html / .htm 文件（${desktopDrop.name || '当前文件'}）。`, 'error');
      } else {
        showToast('没有从拖入的文件取得本地路径；请改用“从访达选择”。', 'error');
      }
      return;
    }

    const droppedPath = pickFilePathFromDrop(event);
    if (droppedPath) {
      openPath(droppedPath, { source: 'drop' });
      return;
    }
    if (event.dataTransfer?.files?.length) {
      showToast('浏览器出于隐私不会暴露拖入文件的本地路径。请使用“从访达选择”或粘贴绝对路径。', 'error');
      return;
    }
    showToast('没有识别到可读取的本地路径。', 'error');
  });

  window.addEventListener('online', () => {
    if (state.cloud.panelOpen) {
      refreshCloudLibrary().catch(() => {});
      startCloudLibraryPoll();
    } else {
      renderCloudLibraryState();
    }
  });
  window.addEventListener('offline', () => {
    renderCloudLibraryState();
    renderCloudFolderTree();
    renderCloudFolderBreadcrumb();
    renderCloudOnlineDocs();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.cloud.panelOpen) {
      refreshCloudLibrary({ quiet: true }).catch(() => {});
    }
  });

  window.addEventListener('pagehide', () => {
    stopCloudLibraryPoll();
    destroyHtmlPreview();
    state.eventSource?.close();
    stopFallback();
  });
}

function renderInitial(initialPath = null) {
  applyPreferences();
  applyDocumentModeUi(null);
  renderRecent();
  if (!state.samplePath) els.sampleButton.disabled = true;
  refreshStatusUI();
  syncShareButtons();
  syncCloudButtons();
  initializeCloudSync().catch(() => {});
  if (!state.token || state.token === '__MD_TOKEN__') {
    showAlert({
      kind: 'error',
      title: '页面未获得访问令牌',
      detail: '请通过本地服务打开墨读，而不是直接打开 HTML 文件。',
    });
    return;
  }

  if (initialPath) {
    els.pathInput.value = initialPath;
  } else {
    const lastPath = safeStorageGet(STORAGE.last);
    if (lastPath) {
      els.pathInput.value = lastPath;
      openPath(lastPath, { source: 'auto', silent: true });
    }
  }
  connectEvents();
  loadShareState();
  if (initialPath) openPath(initialPath, { source: 'desktop', silent: true });
}

async function initializeDesktop() {
  const bridge = window.moduDesktop;
  if (!bridge) return null;
  bridge.onOpenPath((filePath) => {
    openPath(filePath, { source: 'desktop', silent: true });
  });
  try {
    const initialPath = await bridge.ready();
    return typeof initialPath === 'string' && initialPath.startsWith('/') ? initialPath : null;
  } catch {
    return null;
  }
}

bindEvents();
initializeDesktop()
  .then((initialPath) => renderInitial(initialPath))
  .catch(() => renderInitial(null));
