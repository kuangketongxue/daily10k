/* ==========================================================
   万星日报 · Service Worker
   ---------------------------------------------------------
   两个缓存，互不牵连：
     SHELL   静态骨架 + 收藏索引 + 今日索引 —— 版本化，每次部署整体换新
     ARCHIVE 被收藏期次的全文 —— 永不随版本升级清空
   （曾经把两者放同一个 cache，一旦改版本号，用户攒下的归档全文全被删掉，
     正好把「收藏永久可回看」这个卖点清掉了。）

   三类内容的策略不同，不能一刀切：
     data/posts|archive/*.json  → 缓存优先（按日期不可变，且离线必须能读）
     data/index.json / favorites.json → 网络优先 + 1.5 秒超时回落
                                  （首页必须拿到当天的最新一期，否则第二次
                                    打开会看到昨天的稿子；弱网时又不能干等）
     页面骨架 / 静态资源          → 先用缓存、后台更新
                                  （骨架不含当天内容，卡在网络请求上只会让首屏变慢）
   ========================================================== */

// 部署时由 .github/workflows/pages.yml 替换成 commit SHA；本地未替换时回落成 dev
const RAW_VERSION = '__SW_VERSION__';
const VERSION = RAW_VERSION.indexOf('__') === 0 ? 'dev' : RAW_VERSION;

const SHELL_CACHE = 'daily10k-shell-' + VERSION;
const ARCHIVE_CACHE = 'daily10k-archive-v1';

const SHELL = [
  './',
  'index.html',
  'article.html',
  'favorites.html',
  'style.css',
  'favorites.js',
  'register-sw.js',
  'favicon.svg',
  'manifest.webmanifest',
  // 首页数据也预缓存：SW 是在首次页面加载之后才装好的，不预缓存的话
  // 用户「只访问过一次」就断网，会看到一片空白。
  // 收藏列表已改为走后端 API（跨域，本 SW 不拦截），不再预缓存静态 favorites.json。
  'data/index.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      // 单个文件 404 不该让整个 SW 装不上（旧版用 addAll，一个缺失就全盘失败）
      Promise.allSettled(SHELL.map(path => cache.add(new Request(path, { cache: 'reload' }))))
    ).then(() => self.skipWaiting())
  );
});

// 旧版把骨架和归档全文混在同一个 daily10k-v1 里。升级时先把里面的全文挪到
// ARCHIVE_CACHE 再删，用户此前攒下的离线归档不会因这次改版丢失。
async function migrateLegacyCache() {
  const LEGACY = 'daily10k-v1';
  if (!(await caches.has(LEGACY))) return;
  const from = await caches.open(LEGACY);
  const to = await caches.open(ARCHIVE_CACHE);
  const keys = await from.keys();
  let moved = 0;
  for (const req of keys) {
    const p = new URL(req.url).pathname;
    if (!p.endsWith('.json')) continue;
    if (p.indexOf('/data/posts/') < 0 && p.indexOf('/data/archive/') < 0) continue;
    const res = await from.match(req);
    if (!res) continue;
    await to.put(req, res);
    moved++;
  }
  if (moved) console.log('[sw] 已从旧缓存迁移 ' + moved + ' 篇存档全文');
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    migrateLegacyCache()
      .catch(() => { /* 迁移失败不影响清理 */ })
      .then(() => caches.keys())
      .then(keys => Promise.all(
        keys
          // 只清过期的 shell；ARCHIVE_CACHE 与收藏全文一律保留。
          // 'daily10k-v1' 是旧版把骨架和归档混在一起的那个缓存，迁移完就要清掉，
          // 否则它会永远留在磁盘上占空间。
          .filter(k => (k.indexOf('daily10k-shell-') === 0 || k === 'daily10k-v1') && k !== SHELL_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- 三种取数策略 ---------- */

// 缓存优先：按日期的全文内容不会变，离线也要能读
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

// 网络优先：每日更新的数据，必须让用户先看到最新的；断网才用缓存兜底。
// 带超时：手机弱网时 fetch 可能长时间悬着不返回，首页会一直卡在「加载今日日报」，
// 超过 ms 就先把缓存拿出来用，网络的响应到了再更新缓存给下一次。
async function networkFirst(req, cacheName, fallbackUrl, ms = 1500) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);

  // 网络这一路始终挂着 catch：请求失败要变成 null，不能变成未处理的 rejection，
  // 更不能让整个 respondWith 永久悬着（那样页面会永远停在「加载中」）
  let timer;
  const net = fetch(req, { cache: 'no-store' })
    .then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  // 两条路都设上限：无论有没有缓存，都不允许无限等待
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  const res = await Promise.race([net, timeout]);
  clearTimeout(timer);

  if (res) return res;
  if (hit) return hit;
  if (fallbackUrl) {
    const fb = await cache.match(fallbackUrl);
    if (fb) return fb;
  }
  return new Response('', { status: 504, statusText: 'offline' });
}

// 页面骨架：缓存优先、后台更新。
// 骨架 HTML 不承载当天内容（正文和标题都是 index.json 拉的），所以先给页面
// 比先要「最新 HTML」重要得多 —— 弱网下直接要网络会把首页卡在加载态。
async function navigateShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  if (hit) return hit;

  const res = await net;
  if (res) return res;

  const fb = await cache.match('index.html');
  if (fb) return fb;
  return new Response('', { status: 504, statusText: 'offline' });
}

// 先用缓存、后台顺手更新：样式表/脚本这类改了也不致命的资源
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}

/* ---------- 路由 ---------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // 1. 被收藏的期次全文 / 当天全文：按日期不可变
  if (path.endsWith('.json') && (path.indexOf('/data/posts/') >= 0 || path.indexOf('/data/archive/') >= 0)) {
    event.respondWith(cacheFirst(req, ARCHIVE_CACHE));
    return;
  }

  // 2. 今日索引：首页门面，必须是新的
  if (path.endsWith('/data/index.json')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // 3. 收藏索引：同样以线上为准，断网回落缓存
  if (path.endsWith('/data/favorites.json')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // 4. 页面导航：骨架缓存优先，断网也能立刻出页面
  if (req.mode === 'navigate') {
    event.respondWith(navigateShell(req));
    return;
  }

  // 5. 其余同源静态资源
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});
