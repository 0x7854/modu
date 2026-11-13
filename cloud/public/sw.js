'use strict';

// The offline cache contains only the public app shell and its static assets.
// It never caches /api responses, Markdown/HTML bodies, session data, or anything
// account-specific, so an offline page cannot reveal another account.
const VERSION = 'modu-cloud-v1.3.0-r13';
const SHELL_CACHE = `${VERSION}-shell`;

// Install every execution dependency before activation. In WebKit the worker
// may not reuse the page's HTTP cache; omitting vendor scripts makes the next
// PWA launch wait for a second download. Icons remain optional runtime assets.
const CORE_SHELL = [
  '/',
  '/cloud.css',
  '/cloud.js',
  '/vendor/markdown-it.min.js',
  '/vendor/purify.min.js',
];

// Public runtime-cacheable assets. Deliberately an allow-list: unknown
// same-origin paths (including anything private) always go to the network.
const PUBLIC_ASSETS = new Set([
  ...CORE_SHELL,
  '/manifest.webmanifest',
  '/favicon.svg',
  '/vendor/markdown-it.min.js',
  '/vendor/purify.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/maskable-512.png',
]);

const NAV_TIMEOUT_MS = 12_000;
const ASSET_TIMEOUT_MS = 12_000;

const OFFLINE_HTML = `<!doctype html><html lang="zh-CN" data-theme="light"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f3eee3"><title>墨读 · 暂时离线</title>
<style>
html,body{margin:0;min-height:100%;background:#f2ede2;color:#4d4e43;
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
body{display:grid;place-content:center;justify-items:center;gap:14px;padding:24px;text-align:center}
.seal{display:grid;place-items:center;width:58px;height:58px;border-radius:15px;
background:#55725b;color:#f7f0e1;font-family:"Songti SC","STSong",serif;font-size:31px}
p{margin:0;font-size:13px;line-height:1.7;color:#858578}
a{color:#3d5a44;font-size:12px}
@media (prefers-color-scheme:dark){html{background:#151711;color:#c3bfb2}
body{background:#151711}p{color:#8b8c7e}.seal{background:#90ab8e}a{color:#b4c9b1}}
</style></head><body><span class="seal" aria-hidden="true">墨</span>
<p>暂时无法连接墨读云文档库。<br>正文只存在于服务器，不从缓存读取。</p>
<a href="/">重新加载</a></body></html>`;

function withTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function putIfOk(cache, request, response) {
  if (response && response.ok && response.type === 'basic') {
    try {
      await cache.put(request, response.clone());
    } catch {
      // Quota or opaque errors must not break the response path.
    }
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const previous = (await caches.keys()).filter(key => key !== SHELL_CACHE &&
      ['modu-cloud-v1.1.0-r2-shell', 'modu-cloud-v1.1.0-r3-shell', 'modu-cloud-v1.1.0-r4-shell',
        'modu-cloud-v1.1.0-r5-shell', 'modu-cloud-v1.1.0-r6-shell', 'modu-cloud-v1.2.0-r7-shell', 'modu-cloud-v1.2.0-r8-shell', 'modu-cloud-v1.2.0-r9-shell', 'modu-cloud-v1.2.0-r10-shell', 'modu-cloud-v1.2.0-r11-shell', 'modu-cloud-v1.3.0-r12-shell'].includes(key));
    await Promise.all(CORE_SHELL.map(async (url) => {
      // These vendor versions are unchanged from r2–r6; reuse only their
      // known public copies, never an HTML/script from a different release.
      if (url.startsWith('/vendor/')) {
        for (const key of previous) {
          const response = await (await caches.open(key)).match(url);
          if (response?.ok) { await cache.put(url, response); return; }
        }
      }
      const response = await withTimeout(new Request(url, {
        cache: url.startsWith('/vendor/') ? 'force-cache' : 'reload',
      }), 30_000);
      if (!response.ok || response.type !== 'basic') throw new Error('Incomplete public shell');
      await cache.put(url, response);
    }));
    // A failed core download leaves the previous worker active. Never claim
    // a complete installation while a required renderer is missing.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const upgraded = keys.some(key => key.startsWith('modu-cloud-') && key !== SHELL_CACHE);
    await Promise.all(keys
      .filter((key) => key.startsWith('modu-cloud-') && key !== SHELL_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
    // Old pages have no controllerchange handler. Claiming updates their
    // network worker, but leaves the old Markdown-only renderer in memory.
    // Navigate only top-level app windows once, after a complete upgrade;
    // preserve the selected-document hash and never navigate preview frames.
    if (upgraded) {
      const windows = await self.clients.matchAll({ type: 'window' });
      windows.forEach(client => {
        const url = new URL(client.url);
        if (client.frameType !== 'top-level' || url.origin !== self.location.origin
          || !['/', '/index.html'].includes(url.pathname)) return;
        // A same-URL navigation with #doc may be treated as fragment-only.
        // Change the query once per release to force a real shell reload.
        url.searchParams.set('modu-shell', VERSION);
        // Do not await navigation inside activate: its fetch may need the
        // activation event to finish before the new worker can serve it.
        client.navigate(url.href).catch(() => {});
      });
    }
  })());
});

// Logout clears private DOM/session state in the page. Keep this strictly
// public shell so signing in again never discards downloaded app resources.

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Private data always goes to the network. The service worker deliberately
  // has no offline response and no cache entry for these endpoints.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Versioned shell: no navigation re-download competes with private data.
    // registerServiceWorker checks for a new worker after the first screen;
    // releases must bump VERSION to install a coherent new shell.
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match('/');
      if (cached) return cached;
      try {
        const response = await withTimeout(request, NAV_TIMEOUT_MS);
        return await putIfOk(cache, '/', response);
      } catch {
        return new Response(OFFLINE_HTML, { status: 503, headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        }});
      }
    })());
    return;
  }

  if (!PUBLIC_ASSETS.has(url.pathname)) {
    // Unknown/private-looking paths are never cached.
    return;
  }

  // Public versioned assets: cache-first; updates arrive via a new worker.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await withTimeout(request, ASSET_TIMEOUT_MS);
      return await putIfOk(cache, request, response);
    } catch {
      return Response.error();
    }
  })());
});
