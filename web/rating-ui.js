/* ==========================================================================
   万星日报 · 打分控件（web/rating-ui.js）
   --------------------------------------------------------------------------
   依赖 ratings.js（全局 window.DailyRatings）。把一个空容器交给 mountRating，
   它负责渲染 1~10 的按钮、读回本机已打分、点击后写入并反馈同步状态。
   首页今日卡片与文章页共用这一份，避免两处逻辑漂移。
   ========================================================================== */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var TOKEN_SETUP_HREF = 'favorites.html'; // 收藏夹页里有令牌配置入口

  // meta: { date, repo, title, lenses, category }
  function mountRating(el, meta) {
    if (!el || !meta || !/^\d{4}-\d{2}-\d{2}$/.test(String(meta.date || ''))) return;
    var DR = window.DailyRatings;
    if (!DR) { el.textContent = ''; return; }

    var date = String(meta.date);
    var current = DR.get(date);
    var chosen = current ? current.score : 0;

    function paint(statusText) {
      var byToken = DR.hasToken();
      var html = '<div class="rate-box" role="group" aria-label="给这一期打分">'
        + '<span class="rate-label">这期值得</span>'
        + '<span class="rate-stars">';
      for (var i = 1; i <= 10; i++) {
        var on = i <= chosen;
        html += '<button type="button" class="rate-btn' + (on ? ' is-on' : '') + '"'
          + ' data-score="' + i + '" aria-label="' + i + ' 分"'
          + ' aria-pressed="' + (i === chosen ? 'true' : 'false') + '"'
          + ' title="' + i + ' 分">' + i + '</button>';
      }
      html += '</span><span class="rate-points">' + (chosen ? chosen + '/10' : '未评分') + '</span></div>';
      if (!byToken) {
        html += '<p class="rate-hint">分数已存本机。想让推荐学到你喜欢什么，需'
          + '<a href="' + TOKEN_SETUP_HREF + '">配置同步令牌</a>后才会进仓库。</p>';
      } else if (statusText) {
        html += '<p class="rate-hint rate-status">' + esc(statusText) + '</p>';
      }
      el.innerHTML = html;

      el.querySelectorAll('.rate-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var score = Number(btn.getAttribute('data-score'));
          try {
            DR.rate(date, score, {
              repo: meta.repo, title: meta.title, lenses: meta.lenses, category: meta.category
            });
            chosen = score;
            paint('已记 ' + score + ' 分' + (DR.hasToken() ? '，正在同步' : ''));
          } catch (e) {
            paint('打分失败：' + (e && e.message ? e.message : '未知错误'));
          }
        });
      });
    }

    // 云端同步完成后刷新状态提示（本机分数在 rate() 里已即时落地）
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('ratings:state', function (ev) {
        var st = ev && ev.detail;
        if (!st || !el.isConnected) return;
        var msg = '';
        if (st.phase === 'synced') msg = '已同步，下次归档后推荐会参考';
        else if (st.phase === 'error') msg = st.message;
        if (msg) paint(msg);
      });
    }

    paint('');
    // 有令牌时静默补传本机尚未上云的打分
    if (DR.hasToken()) DR.sync().catch(function () {});
  }

  window.mountRating = mountRating;
})();
