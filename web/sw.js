/* ==========================================================
   万星日报 · Service Worker
   ---------------------------------------------------------
   只做两件事：
     1. 首屏静态资源缓存（离线可打开首页骨架）
     2. 归档全文缓存 —— 收藏夹页展开某条时把它对应的
        data/posts/<日期>.json 存进 Cache Storage，
        之后任何设备断网也能回看（缓存的是站点自己域内的响应）
   不拦截写操作，不碰仓库。
   ========================================================== */

const VERSION = 'daily10k-v1';
const SHELL = [
  './',
  'index.html',
  'article.html',
  'favorites.html',
  'style.css',
  'favorites.js',
  'favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 归档全文：缓存优先，回落网络，成功后写回缓存。
  // posts/ 是当天池，archive/ 是被收藏期次的永久归档，两者都要缓存。
  if (url.pathname.includes('/data/posts/') || url.pathname.includes('/data/archive/')) {
    if (!url.pathname.endsWith('.json')) return;
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // 收藏索引：网络优先，失败时用缓存（保证离线也能看到收藏列表）
  if (url.pathname.endsWith('/data/favorites.json')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
    return;
  }

  // 其余静态资源：缓存优先（首屏骨架），后台更新
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok && (url.protocol === 'https:')) {
          caches.open(VERSION).then(c => c.put(req, res.clone()));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
