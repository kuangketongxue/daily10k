/* ==========================================================
   万星日报 · 每期打分 1~10（2026-11-27 重建）
   ---------------------------------------------------------
   分数越高 = 你越满意这一期推送的内容；越高分的主题，以后越优先推送。
   存储：localStorage（本机），配了 GitHub 令牌后自动同步到私有仓，
        电脑重置/换设备后填回令牌即可恢复，评分也会被每日选品读取。
   令牌只由用户粘贴、只进浏览器 localStorage，代码里不含任何凭据。
   ========================================================== */
(function (root) {
  'use strict';
  var LS = 'daily10k:ratings';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var syncing = null;

  function loadAll() {
    try {
      var d = JSON.parse(localStorage.getItem(LS) || '{}');
      var out = {};
      Object.keys(d || {}).forEach(function (k) {
        var v = Number(d[k]);
        if (DATE_RE.test(k) && v >= 0 && v <= 10) out[k] = v;
      });
      return out;
    } catch (e) { return {}; }
  }

  function saveAll(obj) {
    try { localStorage.setItem(LS, JSON.stringify(obj)); } catch (e) { /* 隐私模式降级 */ }
  }

  function get(date) { return Number(loadAll()[date] || 0); }

  function set(date, v) {
    if (!DATE_RE.test(date)) return;
    var all = loadAll();
    if (v > 0) all[date] = Math.max(1, Math.min(10, Math.round(v)));
    else delete all[date];
    saveAll(all);
    emitSync();
    document.dispatchEvent(new CustomEvent('rating:changed', { detail: { date: date, value: all[date] || 0 } }));
  }

  /* ---------- 云同步 ----------
     写到 daily10k 仓库自己的 web/data/ratings.json（不是私有仓）：
     每日选品脚本就在这个仓里跑，只有放这里它才读得到你的偏好。
     复用收藏的同一个 GitHub 令牌（生成令牌时把 daily10k 仓库也勾上即可）。
     ⚠️ 这个文件在公开仓，只存「日期→分数」，不含任何隐私内容。 */
  function token() {
    var CF = root.CloudFavorites;
    return CF && CF.hasToken ? CF.getToken() : '';
  }

  function headers(tok) {
    var h = { 'Accept': 'application/vnd.github+json' };
    if (tok) h['Authorization'] = 'Bearer ' + tok;
    return h;
  }

  function apiUrl() {
    return {
      url: 'https://api.github.com/repos/kuangketongxue/daily10k/contents/web/data/ratings.json',
      branch: 'main',
    };
  }

  function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(b) {
    return decodeURIComponent(escape(atob(String(b || '').replace(/\n/g, ''))));
  }

  // 拉取云端评分并合并（云端没有的本地项保留）
  function pull() {
    var tok = token();
    if (!tok) return Promise.resolve(loadAll());
    var u = apiUrl();
    return fetch(u.url + '?ref=' + encodeURIComponent(u.branch), { headers: headers(tok), cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.content) return loadAll();
        var remote = {};
        try { remote = JSON.parse(b64decode(j.content)) || {}; } catch (e) { remote = {}; }
        var merged = Object.assign({}, remote, loadAll()); // 本地优先（本机最新）
        saveAll(merged);
        return merged;
      });
  }

  // 推送本地评分（整体覆盖，评分是小数据、无并发编辑场景）
  function push() {
    var tok = token();
    if (!tok) return Promise.resolve(false);
    var u = apiUrl();
    var body = loadAll();
    return fetch(u.url + '?ref=' + encodeURIComponent(u.branch), { headers: headers(tok), cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cur) {
        var payload = {
          message: 'update daily10k ratings', 
          content: b64encode(JSON.stringify(body, null, 2)),
          branch: u.branch,
        };
        if (cur && cur.sha) payload.sha = cur.sha;
        return fetch(u.url, {
          method: 'PUT',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers(tok)),
          body: JSON.stringify(payload),
        });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return true;
      });
  }

  function sync() {
    if (syncing) return syncing;
    if (!token()) return Promise.resolve(false);
    syncing = push().catch(function () { return false; }).then(function (x) { syncing = null; return x; });
    return syncing;
  }

  var syncTimer = null;
  function emitSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { sync(); }, 600); // 连点只同步最后一次
  }

  /* ---------- UI：1~10 按钮 ---------- */
  function mount(container, date) {
    if (!container || !date) return;
    var cur = get(date);
    var box = document.createElement('div');
    box.className = 'rate-box';
    var label = document.createElement('span');
    label.className = 'rate-label';
    label.textContent = '这期值得';
    box.appendChild(label);

    var stars = document.createElement('span');
    stars.className = 'rate-stars';
    for (var i = 1; i <= 10; i++) {
      (function (n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'rate-btn' + (n <= cur ? ' is-on' : '');
        b.dataset.v = String(n);
        b.textContent = String(n);
        b.setAttribute('aria-label', '给这期打 ' + n + ' 分');
        b.setAttribute('aria-pressed', n <= cur ? 'true' : 'false');
        b.addEventListener('click', function () {
          var next = get(date) === n ? 0 : n; // 再点同分 = 取消
          set(date, next);
          box.querySelectorAll('.rate-btn').forEach(function (x) {
            var v = Number(x.dataset.v);
            x.classList.toggle('is-on', v <= next);
            x.setAttribute('aria-pressed', v <= next ? 'true' : 'false');
          });
          pts.textContent = next ? next + ' / 10' : '未评分';
          hint.hidden = !next;
        });
        stars.appendChild(b);
      })(i);
    }
    box.appendChild(stars);

    var pts = document.createElement('span');
    pts.className = 'rate-points';
    pts.textContent = cur ? cur + ' / 10' : '未评分';
    box.appendChild(pts);
    container.appendChild(box);

    var hint = document.createElement('p');
    hint.className = 'rate-hint';
    hint.innerHTML = '分越高，以后越优先推送这类内容；已同步到你的私有仓，换设备可恢复。';
    hint.hidden = !cur;
    container.appendChild(hint);
  }

  root.D10Ratings = { get: get, set: set, all: loadAll, pull: pull, sync: sync, mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
