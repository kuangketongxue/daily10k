/* 注册 Service Worker：负责静态资源与归档全文的离线缓存 */
(function () {
  if (!('serviceWorker' in navigator)) return;
  // file:// 直接打开时 Service Worker 不可用，跳过即可
  if (location.protocol === 'file:') return;

  window.addEventListener('load', () => {
    // updateViaCache: 'none' 很关键：默认情况下浏览器检查 sw.js 有没有更新时
    // 会走 HTTP 缓存（GitHub Pages 给的是 10 分钟），改完缓存策略可能几小时内
    // 都不生效。关掉它，每次访问都拿真正的 sw.js 比对。
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {
      /* 注册失败不影响正常浏览，静默降级 */
    });
  });
})();
