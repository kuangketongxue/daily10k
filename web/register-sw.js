/* 注册 Service Worker：负责静态资源与归档全文的离线缓存 */
(function () {
  if (!('serviceWorker' in navigator)) return;
  // file:// 直接打开时 Service Worker 不可用，跳过即可
  if (location.protocol === 'file:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* 注册失败不影响正常浏览，静默降级 */
    });
  });
})();
