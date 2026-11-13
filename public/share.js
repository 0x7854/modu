const STORAGE = {
  theme: 'modu.share.theme',
  font: 'modu.share.font',
  width: 'modu.share.width',
  token: 'modu.share.token',
};

const DEFAULTS = {
  font: 17,
  width: 'normal',
  pollMs: 700,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  root: document.documentElement,
  reader: $('#share-reader'),
  doc: $('#share-doc'),
  loading: $('#share-loading'),
  auth: $('#share-auth'),
  authTitle: $('#share-auth-title'),
  authDetail: $('#share-auth-detail'),
  end: $('#share-end'),
  fileName: $('#share-file-name'),
  fileMeta: $('#share-file-meta'),
  status: $('#share-status'),
  statusText: $('#share-status-text'),
  syncDetail: $('#share-sync-detail'),
  alert: $('#share-alert'),
  alertTitle: $('#share-alert-title'),
  alertDetail: $('#share-alert-detail'),
  progress: $('#share-progress'),
  updatePill: $('#share-update-pill'),
  outline: $('#share-outline'),
  outlineEmpty: $('#share-outline-empty'),
  outlinePanel: $('#share-outline-panel'),
  outlineToggle: $('#share-outline-toggle'),
  outlineClose: $('#share-outline-close'),
  scrim: $('#share-scrim'),
  settings: $('#share-settings'),
  settingsToggle: $('#share-settings-toggle'),
  settingsClose: $('#share-settings-close'),
  themeToggle: $('#share-theme-toggle'),
  themeSegment: $('#share-theme-segment'),
  widthSegment: $('#share-width-segment'),
  fontRange: $('#share-font-range'),
  fontOutput: $('#share-font-output'),
  themeColor: $('meta[name="theme-color"]'),
  toastRegion: $('#share-toast-region'),
};

const state = {
  token: '',
  doc: null,
  status: { key: 'idle', code: null, message: null, checkedAt: null },
  connection: 'connecting',
  ended: false,
  busy: false,
  timer: null,
  pollMs: DEFAULTS.pollMs,
  offlineCount: 0,
  theme: 'light',
  font: DEFAULTS.font,
  width: DEFAULTS.width,
  outlineOpen: false,
  settingsOpen: false,
  updateTimer: null,
  pendingAnchor: null,
  anchorTimer: null,
  assetUrls: [],
  imageObserver: null,
  assetGeneration: 0,
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
    // Preferences are optional.
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
    // Private browsing may block it; the URL fragment still works once.
  }
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
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

/**
 * The token arrives in the URL fragment, which browsers never send to a
 * server or include in Referer. Store it for reloads, then immediately remove
 * it from the visible/copyable address.
 */
function takeToken() {
  let token = '';
  try {
    const rawHash = location.hash ? location.hash.slice(1) : '';
    if (rawHash) {
      const params = new URLSearchParams(rawHash);
      token = params.get('t') || params.get('token') || '';
      if (!token && !rawHash.includes('=')) token = rawHash;
    }
    if (token) safeSessionSet(STORAGE.token, token);
    else token = safeSessionGet(STORAGE.token) || '';
    if (location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch {
    token = token || safeSessionGet(STORAGE.token) || '';
  }
  return token;
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

  for (const button of $$('[data-theme-choice]', els.themeSegment)) {
    const active = button.dataset.themeChoice === state.theme;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  for (const button of $$('[data-width-choice]', els.widthSegment)) {
    const active = button.dataset.widthChoice === state.width;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }

  const label = state.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.setAttribute('title', label);

  if (persist) {
    safeStorageSet(STORAGE.theme, state.theme);
    safeStorageSet(STORAGE.font, String(state.font));
    safeStorageSet(STORAGE.width, state.width);
  }
}

async function api(path) {
  const response = await fetch(path, {
    method: 'GET',
    headers: {
      'X-MD-Token': state.token,
      Accept: 'application/json',
    },
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The status code still tells us what happened.
  }
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message || `请求失败（${response.status}）`,
      payload?.error?.code || 'REQUEST_FAILED',
      response.status,
    );
  }
  return payload;
}

function setStatusUI(kind, label, detail) {
  els.status.dataset.state = kind;
  els.statusText.textContent = label;
  els.syncDetail.textContent = detail;
  els.status.title = detail;
}

function renderStatus() {
  if (!state.token) {
    setStatusUI('error', '需要完整链接', '分享链接不完整，请在 Mac 上重新复制');
    return;
  }
  if (state.ended) {
    setStatusUI('error', '分享已结束', 'Mac 上的分享已撤销或墨读已退出');
    return;
  }
  if (state.connection === 'offline') {
    setStatusUI('connecting', '连接中断', '正在重试 · 请保持 Mac 运行且在同一 WiFi');
    return;
  }
  if (!state.doc) {
    setStatusUI('loading', '正在连接', '正在读取 Mac 上分享的文稿…');
    return;
  }
  if (state.status.key === 'missing') {
    setStatusUI('missing', '原文件已删除', `等待原路径恢复 · 上次检查 ${formatTime(state.status.checkedAt) || '—'}`);
    return;
  }
  if (state.status.key === 'error') {
    setStatusUI('error', '同步遇阻', state.status.message || '读取原文件失败');
    return;
  }
  if (state.status.key === 'synced') {
    const checked = formatTime(state.status.checkedAt);
    setStatusUI('synced', '实时同步', checked ? `只读 · 检查于 ${checked}` : '只读 · 原文件已连接');
    return;
  }
  setStatusUI('connecting', '正在连接', '等待 Mac 上的墨读…');
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

function renderAlert() {
  if (!state.token) {
    hideAlert();
    return;
  }
  if (state.ended) {
    showAlert(
      'error',
      '分享已结束',
      'Mac 上的分享已撤销或墨读已退出。请在 Mac 上重新点击“iPad 阅读”，再复制新的链接打开。',
    );
    return;
  }
  if (state.connection === 'offline') {
    const detail = state.offlineCount >= 6
      ? '连续无法连接。分享可能已撤销，或 Mac 已退出、休眠、不在同一 WiFi。此页会继续每 0.7 秒重试。'
      : 'Mac 可能暂时休眠或网络抖动。正文保持在原处，连接恢复后会自动续上。';
    showAlert('warning', '连接中断', detail);
    return;
  }
  if (!state.doc) {
    hideAlert();
    return;
  }
  if (state.status.key === 'missing') {
    showAlert(
      'warning',
      '原文件已删除',
      'Mac 上的原文件被删除或移动，正文保留为最后一次成功内容。文件恢复后会自动续上。',
    );
    return;
  }
  if (state.status.key === 'error') {
    showAlert(
      'error',
      '同步遇到问题',
      state.status.message || '读取原文件失败，正文保留为最后一次成功内容。',
    );
    return;
  }
  hideAlert();
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

function captureAnchor() {
  if (!state.doc || els.doc.hidden) return null;
  const container = els.reader;
  const containerRect = container.getBoundingClientRect();
  const focusY = containerRect.top + Math.min(140, container.clientHeight * 0.22);
  const children = [...els.doc.children].filter((child) => child.dataset.anchor);
  const node = children.find((child) => child.getBoundingClientRect().bottom > focusY) || null;
  if (!node) return { key: '', offset: 0, scrollTop: container.scrollTop };
  const anchor = {
    key: node.dataset.anchor,
    offset: node.getBoundingClientRect().top - containerRect.top,
    scrollTop: container.scrollTop,
  };
  if (window.__MODU_SHARE_DEBUG__) console.log('capture-anchor', anchor, focusY);
  return anchor;
}

function restoreAnchor(anchor) {
  if (!anchor) return;
  const container = els.reader;
  if (anchor.key) {
    let target = null;
    try {
      target = els.doc.querySelector(`[data-anchor="${CSS.escape(anchor.key)}"]`);
    } catch {
      target = null;
    }
    if (target) {
      const containerRect = container.getBoundingClientRect();
      const targetTop = target.getBoundingClientRect().top - containerRect.top;
      const delta = targetTop - anchor.offset;
      if (window.__MODU_SHARE_DEBUG__) {
        console.log('restore-anchor', { key: anchor.key, targetKey: target.dataset.anchor, before: container.scrollTop, targetTop, offset: anchor.offset, delta });
      }
      container.scrollTop += delta;
      updateProgress();
      updateActiveHeading();
      return;
    }
  }
  container.scrollTop = anchor.scrollTop || 0;
  updateProgress();
  updateActiveHeading();
}

function rememberAnchor(anchor) {
  if (!anchor) return;
  state.pendingAnchor = { anchor, until: Date.now() + 3000 };
  window.clearTimeout(state.anchorTimer);
  state.anchorTimer = window.setTimeout(() => {
    state.pendingAnchor = null;
  }, 3000);
}

function cancelPendingAnchor() {
  state.pendingAnchor = null;
  window.clearTimeout(state.anchorTimer);
  state.anchorTimer = null;
}

function restorePendingAnchor() {
  const pending = state.pendingAnchor;
  if (!pending) return;
  if (Date.now() > pending.until) {
    cancelPendingAnchor();
    return;
  }
  requestAnimationFrame(() => restoreAnchor(pending.anchor));
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
    }, 240);
  }, 6000);
}

function hideUpdatePill() {
  els.updatePill.classList.remove('is-visible');
  window.clearTimeout(state.updateTimer);
  window.setTimeout(() => {
    if (!els.updatePill.classList.contains('is-visible')) els.updatePill.hidden = true;
  }, 240);
}

function updateIdentity(doc) {
  els.fileName.textContent = doc.name;
  els.fileMeta.textContent = '只读 · 当前分享的文稿';
  document.title = `${doc.name} · 墨读 iPad 阅读`;
}

function revokeAssets() {
  state.assetGeneration += 1;
  state.imageObserver?.disconnect();
  state.imageObserver = null;
  for (const url of state.assetUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Already revoked.
    }
  }
  state.assetUrls = [];
}

async function loadShareImage(img, generation) {
  const relative = img.dataset.shareAsset;
  if (!relative) return;
  try {
    const response = await fetch(`/api/share/asset?p=${encodeURIComponent(relative)}`, {
      method: 'GET',
      headers: { 'X-MD-Token': state.token },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (response.status === 401) {
      endShare();
      return;
    }
    if (!response.ok) throw new Error(`image ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not an image');
    const url = URL.createObjectURL(blob);
    if (generation !== state.assetGeneration) {
      URL.revokeObjectURL(url);
      return;
    }
    state.assetUrls.push(url);
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        // Keep the reserved box honest even if the file's dimensions changed.
        img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      }
      img.classList.add('is-ready');
      restorePendingAnchor();
    };
    img.onerror = () => {
      img.classList.add('is-missing');
      restorePendingAnchor();
    };
    img.src = url;
  } catch {
    if (generation === state.assetGeneration) {
      img.classList.add('is-missing');
      img.title = '图片不可读取或不在文档目录内';
      restorePendingAnchor();
    }
  }
}

function captureImageRatios() {
  const ratios = new Map();
  for (const img of els.doc.querySelectorAll('img[data-share-asset]')) {
    const relative = img.dataset.shareAsset;
    if (!relative || !img.src.startsWith('blob:')) continue;
    if (img.clientWidth > 0 && img.clientHeight > 0) {
      ratios.set(relative, { width: img.clientWidth, height: img.clientHeight });
    }
  }
  return ratios;
}

function applyImageRatios(ratios) {
  if (!ratios.size) return;
  for (const img of els.doc.querySelectorAll('img[data-share-asset]')) {
    const size = ratios.get(img.dataset.shareAsset);
    if (!size) continue;
    // Reserve the previous rendered box before the new blob arrives, so an
    // update does not collapse tall images and shove the reading position up.
    img.style.aspectRatio = `${size.width} / ${size.height}`;
  }
}

function loadImages() {
  revokeAssets();
  const generation = state.assetGeneration;
  const images = [...els.doc.querySelectorAll('img[data-share-asset]')];
  if (!images.length) return;

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        loadShareImage(entry.target, generation);
      }
    }, { root: els.reader, rootMargin: '500px 0px' });
    state.imageObserver = observer;
    for (const image of images) observer.observe(image);
  } else {
    for (const image of images) loadShareImage(image, generation);
  }
}

function applyDoc(doc) {
  if (!doc || typeof doc.html !== 'string') return;
  const same = state.doc
    && state.doc.hash === doc.hash
    && state.doc.revision === doc.revision;

  if (same) {
    state.doc = doc;
    updateIdentity(doc);
    return;
  }

  const preserve = Boolean(state.doc);
  const anchor = preserve ? captureAnchor() : null;
  const imageRatios = preserve ? captureImageRatios() : new Map();
  state.doc = doc;
  els.doc.innerHTML = doc.html;
  applyImageRatios(imageRatios);
  assignBlockAnchors();
  buildOutline(doc.headings);
  updateIdentity(doc);

  els.loading.hidden = true;
  els.auth.hidden = true;
  els.doc.hidden = false;
  els.end.hidden = false;

  if (!preserve) {
    els.reader.scrollTop = 0;
  } else if (anchor) {
    requestAnimationFrame(() => restoreAnchor(anchor));
  }
  if (preserve) showUpdatePill();

  loadImages();
  requestAnimationFrame(() => {
    updateProgress();
    updateActiveHeading();
  });
}

function buildOutline(headings) {
  els.outline.replaceChildren();
  const valid = Array.isArray(headings)
    ? headings.filter((heading) => heading && heading.id)
    : [];

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
      closeOutline();
      scrollToHeading(heading.id);
    });
    els.outline.append(link);
  }
}

function scrollToHeading(id) {
  const target = document.getElementById(id);
  if (!target) return;
  const container = els.reader;
  const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top - 28;
  container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
}

function updateActiveHeading() {
  if (!state.doc || els.doc.hidden) return;
  const headings = $$('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]', els.doc);
  if (!headings.length) return;
  const container = els.reader;
  const threshold = container.getBoundingClientRect().top + 100;
  let active = headings[0];
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top <= threshold) active = heading;
    else break;
  }
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
  if (atBottom) active = headings[headings.length - 1];

  for (const link of $$('.outline-link', els.outline)) {
    const isActive = link.dataset.headingId === active.id;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

function updateProgress() {
  const container = els.reader;
  const max = Math.max(1, container.scrollHeight - container.clientHeight);
  const ratio = Math.min(1, Math.max(0, container.scrollTop / max));
  els.progress.style.transform = `scaleX(${ratio})`;
}

function openOutline() {
  closeSettings();
  state.outlineOpen = true;
  els.outlinePanel.classList.add('is-open');
  els.outlinePanel.setAttribute('aria-hidden', 'false');
  els.outlineToggle.setAttribute('aria-expanded', 'true');
  els.scrim.hidden = false;
  document.body.classList.add('share-outline-open');
}

function closeOutline() {
  if (!state.outlineOpen) return;
  state.outlineOpen = false;
  els.outlinePanel.classList.remove('is-open');
  els.outlinePanel.setAttribute('aria-hidden', 'true');
  els.outlineToggle.setAttribute('aria-expanded', 'false');
  els.scrim.hidden = true;
  document.body.classList.remove('share-outline-open');
}

function openSettings() {
  closeOutline();
  state.settingsOpen = true;
  els.settings.hidden = false;
  els.settings.classList.add('is-open');
  els.settingsToggle.setAttribute('aria-expanded', 'true');
  window.setTimeout(() => els.settings.querySelector('button')?.focus(), 20);
}

function closeSettings() {
  if (!state.settingsOpen) return;
  state.settingsOpen = false;
  els.settings.hidden = true;
  els.settings.classList.remove('is-open');
  els.settingsToggle.setAttribute('aria-expanded', 'false');
}

function endShare() {
  if (state.ended) return;
  state.ended = true;
  state.connection = 'ended';
  window.clearTimeout(state.timer);
  state.timer = null;
  revokeAssets();
  els.loading.hidden = true;
  if (!state.doc) {
    els.auth.hidden = false;
    els.authTitle.textContent = '分享已结束';
    els.authDetail.textContent = 'Mac 上的分享已撤销或墨读已退出。请在 Mac 上重新点击“iPad 阅读”，再复制新的链接打开。';
  }
  renderStatus();
  renderAlert();
}

function schedulePoll() {
  if (state.ended) return;
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(poll, Math.min(1000, Math.max(500, state.pollMs)));
}

async function poll() {
  if (state.ended || state.busy) return;
  state.busy = true;
  const previousStatus = state.status.key;
  const wasOffline = state.connection === 'offline';
  const hadDoc = Boolean(state.doc);

  try {
    const payload = await api('/api/share/state');
    if (!payload || !payload.doc) throw new Error('missing snapshot');
    const hint = Number(payload.pollMs);
    if (Number.isFinite(hint) && hint >= 500 && hint <= 1000) state.pollMs = hint;

    state.connection = 'live';
    state.offlineCount = 0;
    state.status = payload.status || { key: 'synced', checkedAt: null };
    applyDoc(payload.doc);

    if (previousStatus === 'missing' && state.status.key === 'synced') {
      showToast('原文件已恢复，实时同步继续。', 'success');
    } else if (wasOffline && hadDoc) {
      showToast('连接已恢复。', 'success');
    }

    renderStatus();
    renderAlert();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      endShare();
      return;
    }
    state.connection = 'offline';
    state.offlineCount += 1;
    renderStatus();
    renderAlert();
  } finally {
    state.busy = false;
    schedulePoll();
  }
}

function bindEvents() {
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
      const anchor = captureAnchor();
      state.width = button.dataset.widthChoice;
      applyPreferences({ persist: true });
      requestAnimationFrame(() => restoreAnchor(anchor));
    });
  }

  els.fontRange.addEventListener('input', () => {
    const anchor = captureAnchor();
    state.font = Number(els.fontRange.value);
    applyPreferences({ persist: true });
    requestAnimationFrame(() => restoreAnchor(anchor));
  });

  els.settingsToggle.addEventListener('click', () => {
    if (state.settingsOpen) closeSettings();
    else openSettings();
  });
  els.settingsClose.addEventListener('click', closeSettings);
  els.outlineToggle.addEventListener('click', () => {
    if (state.outlineOpen) closeOutline();
    else openOutline();
  });
  els.outlineClose.addEventListener('click', closeOutline);
  els.scrim.addEventListener('click', closeOutline);
  els.updatePill.addEventListener('click', hideUpdatePill);

  els.reader.addEventListener('scroll', () => {
    updateProgress();
    updateActiveHeading();
  }, { passive: true });

  els.doc.addEventListener('click', (event) => {
    const localLink = event.target.closest('a[data-local-link]');
    if (localLink) {
      event.preventDefault();
      showToast('共享模式下不会打开 Mac 上的其他文档。', 'info');
      return;
    }
    const anchor = event.target.closest('a[href^="#"]');
    if (anchor) {
      const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
      if (id && document.getElementById(id)) {
        event.preventDefault();
        scrollToHeading(id);
      }
    }
  });

  document.addEventListener('click', (event) => {
    if (!els.settings.hidden
      && !els.settings.contains(event.target)
      && !els.settingsToggle.contains(event.target)) {
      closeSettings();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.settingsOpen) {
      closeSettings();
      event.preventDefault();
    } else if (state.outlineOpen) {
      closeOutline();
      event.preventDefault();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.ended) return;
    window.clearTimeout(state.timer);
    poll();
  });

  window.addEventListener('online', () => {
    if (state.ended) return;
    window.clearTimeout(state.timer);
    poll();
  });

  window.addEventListener('pagehide', () => {
    window.clearTimeout(state.timer);
    state.timer = null;
    revokeAssets();
  });
}

function renderInitial() {
  loadPreferences();
  applyPreferences();
  bindEvents();

  state.token = takeToken();
  if (!state.token) {
    els.loading.hidden = true;
    els.doc.hidden = true;
    els.end.hidden = true;
    els.auth.hidden = false;
    els.authTitle.textContent = '需要完整的分享链接';
    els.authDetail.textContent = '请在 Mac 的墨读中点击“iPad 阅读”，复制完整链接后再打开。链接里的密钥只用于这一份文稿。';
    renderStatus();
    renderAlert();
    return;
  }

  renderStatus();
  renderAlert();
  poll();
}

renderInitial();
