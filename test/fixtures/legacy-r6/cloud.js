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
const STORAGE_THEME = 'modu.cloud.theme';
const STORAGE_LAST_PREFIX = 'modu.cloud.last.';

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
  pollTimer: null,
  pollCount: 0,
  positionTimer: null,
  positionSaving: false,
  loadingDocId: '',
  libraryOpen: false,
  online: navigator.onLine !== false,
  authenticated: false,
  ignoreScrollSave: false,
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
  if (!state.currentDoc || !state.csrfToken) return;
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

function renderDocument(doc, { preserve = false } = {}) {
  const container = els.reader;
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
}

function documentSignature(documents) {
  return documents
    .map((doc) => [doc.id, doc.name, doc.revision, doc.size, doc.updatedAt].join(':'))
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

function renderDocList() {
  els.docList.replaceChildren();
  els.libraryEmpty.hidden = state.documents.length > 0;
  const selectedId = state.loadingDocId || state.currentDoc?.id || '';
  for (const doc of state.documents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'doc-item';
    button.dataset.docId = doc.id;
    button.setAttribute('aria-label', `打开 ${doc.name}`);
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
    const updated = document.createElement('span');
    updated.textContent = formatTime(doc.updatedAt) || '尚未同步';
    const size = document.createElement('span');
    size.textContent = doc.size ? `${Math.max(1, Math.round(doc.size / 1024))} KB` : '—';
    meta.append(updated, size);
    button.append(name, meta);
    button.addEventListener('click', () => openDocument(doc.id));
    els.docList.append(button);
  }
}

/* --------------------------------------------------------- session/ui */

function showBoot(message = '正在校验登录状态') {
  els.bootHint.textContent = message;
  els.auth.hidden = true;
  els.shell.hidden = true;
  els.boot.hidden = false;
}

function showAuth(message = '') {
  cancelDocumentLoad();
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
  closeLibrary();
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
  window.setTimeout(() => els.loginUser.focus(), 30);
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
}

function preferredDocId() {
  const hashMatch = location.hash.match(/^#doc-([a-f0-9]{32})$/);
  if (hashMatch) return hashMatch[1];
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
  state.session = payload.user;
  state.csrfToken = payload.csrfToken || '';
  state.documents = payload.documents;
  state.documentSignature = documentSignature(state.documents);
  showApp();

  const doc = payload.doc;
  if (!doc) {
    showWelcome();
    return;
  }

  const same = state.currentDoc?.id === doc.id;
  const revisionChanged = state.currentDoc?.revision !== doc.revision;
  state.currentDoc = {
    id: doc.id,
    name: doc.name,
    revision: doc.revision,
    size: doc.size,
    updatedAt: doc.updatedAt,
  };
  state.currentMarkdown = doc.markdown;
  // Bootstrap is also used by visibility/online refresh and bfcache restore;
  // only rebuild the reading pane when it is actually missing or changed.
  if (!state.documentRendered || !same || revisionChanged) {
    renderDocument({ ...doc, position: doc.position }, { preserve: same });
  }
  safeSessionSet(STORAGE_LAST_PREFIX + state.session.id, doc.id);
  if (location.hash !== `#doc-${doc.id}`) {
    history.replaceState(null, '', `#doc-${doc.id}`);
  }
  renderDocList();
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
  state.authGeneration += 1;
  state.authenticated = false;
  state.bootstrapPromise = null;
  closeLibrary();
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
    if (state.authenticated) window.setTimeout(registerServiceWorker, 900);
    return true;
  } catch (error) {
    showAuth(error instanceof ApiError && error.status === 401
      ? '用户名或密码不正确。'
      : (error.message || '登录失败，请重试。'));
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
  safeSessionClear();
  els.doc.innerHTML = '';
  els.docList.replaceChildren();
  els.shell.hidden = true;
  els.boot.hidden = true;
  showAuth('已退出登录，当前正文已从页面清除。');
  history.replaceState(null, '', '/');
}

/* ------------------------------------------------------------- library */

function openLibrary() {
  state.libraryOpen = true;
  els.library.classList.add('is-open');
  els.scrim.hidden = false;
  els.libraryToggle.setAttribute('aria-expanded', 'true');
}

function closeLibrary() {
  if (!state.libraryOpen) return;
  state.libraryOpen = false;
  els.library.classList.remove('is-open');
  els.scrim.hidden = true;
  els.libraryToggle.setAttribute('aria-expanded', 'false');
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
  const nextSignature = documentSignature(documents);
  const changed = nextSignature !== state.documentSignature;
  state.documents = documents;
  state.documentSignature = nextSignature;
  if (changed) renderDocList();
  const known = documents.some((doc) => doc.id === state.currentDoc?.id);
  if (state.currentDoc && !known) showWelcome();
  if (autoOpen && !state.currentDoc && !state.loadingDocId && documents.length) {
    const preferred = preferredDocId();
    const candidate = documents.find((doc) => doc.id === preferred) || documents[0];
    await openDocument(candidate.id, { silent: true });
  }
  return state.documents;
}

async function openDocument(id, { silent = false } = {}) {
  if (!state.authenticated) return;

  // Re-selecting the document already on screen must not rebuild the long
  // reading pane. If another document is still loading, cancel it and return
  // to the visible document immediately.
  if (state.currentDoc?.id === id) {
    if (state.loadingDocId) {
      cancelDocumentLoad();
      renderDocList();
      updateOfflineState();
    }
    closeLibrary();
    els.reader.focus({ preventScroll: true });
    return;
  }
  if (state.loadingDocId === id) {
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
  showDocumentLoading(id);
  renderDocList();
  closeLibrary();
  hideAlert();
  setStatus('loading', '正在读取', '从云端取回 Markdown 正文…');
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
    renderDocument({
      ...payload.doc,
      position: payload.doc.position,
    }, { preserve: same });
    state.currentDoc = {
      id: payload.doc.id,
      name: payload.doc.name,
      revision: payload.doc.revision,
      size: payload.doc.size,
      updatedAt: payload.doc.updatedAt,
    };
    state.currentMarkdown = payload.doc.markdown;
    state.positionData = payload.doc.position;
    if (state.session) {
      safeSessionSet(STORAGE_LAST_PREFIX + state.session.id, id);
    }
    history.replaceState(null, '', `#doc-${id}`);
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
    if (error instanceof ApiError && (error.status === 404 || error.code === 'DOCUMENT_NOT_FOUND')) {
      showToast('这份文稿已不在云端文库。', 'error');
      await loadDocuments().catch(() => {});
      return;
    }
    setStatus('error', '读取失败', error.message || '无法读取云端文稿。');
    showAlert('error', '无法读取文稿', error.message || '请检查网络后重试。');
  } finally {
    if (state.documentRequest === controller) state.documentRequest = null;
    if (generation === state.documentGeneration) {
      clearDocumentLoading();
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
      setStatus('live', '已同步', `只读 · 检查于 ${formatTime(new Date().toISOString())}`);
      hideAlert();
      return;
    }
    if (!result?.doc) return;
    const changed = result.doc.revision !== state.currentDoc.revision;
    state.currentDoc = {
      id: result.doc.id,
      name: result.doc.name,
      revision: result.doc.revision,
      size: result.doc.size,
      updatedAt: result.doc.updatedAt,
    };
    state.currentMarkdown = result.doc.markdown;
    if (changed) {
      renderDocument(result.doc, { preserve: true });
      showToast('云端文稿已更新，阅读位置已尽量保留。', 'success');
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

  els.logout.addEventListener('click', logout);
  els.libraryToggle.addEventListener('click', () => {
    if (state.libraryOpen) closeLibrary();
    else openLibrary();
  });
  els.libraryClose.addEventListener('click', closeLibrary);
  els.scrim.addEventListener('click', closeLibrary);

  els.reader.addEventListener('scroll', () => {
    updateOfflineStateIfNeeded();
    schedulePositionSave();
  }, { passive: true });

  window.addEventListener('resize', () => {
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
      savePosition({ keepalive: true });
      return;
    }
    if (state.authenticated) {
      schedulePoll(50);
      loadDocuments().catch(() => {});
    }
  });

  window.addEventListener('pagehide', () => {
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
  try {
    markdown = createMarkdownRenderer();
  } catch (error) {
    els.boot.hidden = true;
    showAuth(error.message || '渲染组件加载失败，请刷新页面。');
    return;
  }
  // One authenticated request returns session + library + first/preferred doc.
  // The old session -> documents -> document chain is gone from startup.
  try {
    await loadBootstrap();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showAuth('');
    } else {
      showAuth(error.message || '无法连接服务器，请稍后重试。');
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
  showAuth(error.message || '页面初始化失败，请刷新重试。');
});
