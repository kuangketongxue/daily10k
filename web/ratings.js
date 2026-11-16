/* ==========================================================================
   万星日报 · 每期打分（1~10）· 唯一真身（web/ratings.js）
   --------------------------------------------------------------------------
   目的：给每期日报打 1~10 分，作为「我喜欢什么」的直接证据，喂给选品纠偏。
   打分不是点赞：它要能改、要按日期唯一（一期一分）、要能跨设备带过去。

   落库通道：复用 CloudFavorites 的同一枚 PAT 令牌（同源 localStorage，
   用户在收藏夹页配置一次全站通用），通过 GitHub Contents API 直接写私有仓
   kuangketongxue/kuangketongxue 的 data/daily-ratings.json。
   静态站前端不存令牌到代码/仓库/日志；令牌只从 localStorage 读取，
   只出现在 api.github.com 的 Authorization 头里。

   没配令牌时打分只存本机（localStorage），并在界面上明确提示「不会进仓库、
   推荐暂时学不到」——绝不假装已经同步。配好令牌后本机分数会自动补传。

   冲突正确性：多设备改同一期时按 ratedAt 取最新的一条，不取并集、不复活旧分。
   PUT 拿到 409 就重拉重放，最多 3 次。

   数据格式 data/daily-ratings.json：
     { "v":1, "updated":"ISO",
       "items": { "2026-11-16": { "score":8, "repo":"o/r", "title":"...",
                                  "lenses":["AI"], "category":"...", "ratedAt":"ISO" } } }
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DailyRatings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CFG = {
    owner: 'kuangketongxue',
    repo: 'kuangketongxue',
    path: 'data/daily-ratings.json',
    branch: 'main',
    api: 'https://api.github.com'
  };
  // 与 CloudFavorites 完全相同的令牌键：同源共享，配置一次两处可用。
  var TOKEN_KEY = 'daily-favorites:gh:token';
  var LS_RATINGS = 'daily10k:ratings:v1';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* ---------------- 小工具（与 cloud-favorites.js 同款，已验证） ---------------- */

  function storage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; }
    catch (e) { return null; }
  }
  function readLS(key, fallback) {
    var s = storage();
    if (!s) return fallback;
    try { var raw = s.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
    catch (e) { return fallback; }
  }
  function writeLS(key, value) {
    var s = storage();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }
  function nowISO() { try { return new Date().toISOString(); } catch (e) { return ''; } }
  function getToken() {
    var s = storage();
    if (!s) return '';
    try { return String(s.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function hasToken() { return !!getToken(); }

  function utf8ToBase64(str) {
    var bytes;
    if (typeof TextEncoder !== 'undefined') bytes = new TextEncoder().encode(str);
    else {
      var utf8 = unescape(encodeURIComponent(str)), arr = [];
      for (var i = 0; i < utf8.length; i++) arr.push(utf8.charCodeAt(i));
      bytes = arr;
    }
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '';
    for (var j = 0; j < bytes.length; j += 3) {
      var b0 = bytes[j], b1 = bytes[j + 1], b2 = bytes[j + 2];
      var n = (b0 << 16) | ((b1 == null ? 0 : b1) << 8) | (b2 == null ? 0 : b2);
      out += alphabet.charAt((n >> 18) & 63) + alphabet.charAt((n >> 12) & 63);
      out += b1 == null ? '=' : alphabet.charAt((n >> 6) & 63);
      out += b2 == null ? '=' : alphabet.charAt(n & 63);
    }
    return out;
  }
  function base64ToUtf8(b64) {
    var clean = String(b64 || '').replace(/\s/g, '');
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var bytes = [];
    for (var i = 0; i < clean.length; i += 4) {
      var c0 = alphabet.indexOf(clean.charAt(i));
      var c1 = alphabet.indexOf(clean.charAt(i + 1));
      var c2 = clean.charAt(i + 2) === '=' ? -1 : alphabet.indexOf(clean.charAt(i + 2));
      var c3 = clean.charAt(i + 3) === '=' ? -1 : alphabet.indexOf(clean.charAt(i + 3));
      if (c0 < 0 || c1 < 0) continue;
      var n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
      bytes.push((n >> 16) & 255);
      if (c2 >= 0) bytes.push((n >> 8) & 255);
      if (c3 >= 0) bytes.push(n & 255);
    }
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(new Uint8Array(bytes));
    var s = '';
    for (var k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  /* ---------------- 数据模型（纯函数，可单测） ---------------- */

  function emptyDoc() { return { v: 1, updated: '', items: {} }; }

  function normalize(input) {
    var doc = emptyDoc();
    var src = input && typeof input === 'object' ? input : {};
    doc.updated = typeof src.updated === 'string' ? src.updated : '';
    var items = src.items && typeof src.items === 'object' && !Array.isArray(src.items) ? src.items : {};
    for (var date in items) {
      if (!Object.prototype.hasOwnProperty.call(items, date) || !DATE_RE.test(date)) continue;
      var it = items[date] && typeof items[date] === 'object' ? items[date] : {};
      var score = Number(it.score);
      if (!isFinite(score) || score < 1 || score > 10) continue;
      var lenses = Array.isArray(it.lenses) ? it.lenses.filter(function (x) { return typeof x === 'string'; }) : [];
      doc.items[date] = {
        score: Math.round(score),
        repo: typeof it.repo === 'string' ? it.repo : '',
        title: typeof it.title === 'string' ? it.title : '',
        lenses: lenses,
        category: typeof it.category === 'string' ? it.category : '',
        ratedAt: typeof it.ratedAt === 'string' ? it.ratedAt : ''
      };
    }
    return doc;
  }

  // 合并：同一日期按 ratedAt 取最新；ratedAt 相同时取本地（刚点的这次）
  function mergeDoc(local, remote) {
    var out = normalize(local), r = normalize(remote), date;
    for (date in r.items) {
      if (!Object.prototype.hasOwnProperty.call(r.items, date)) continue;
      var a = out.items[date], b = r.items[date];
      if (!a || String(b.ratedAt || '') > String(a.ratedAt || '')) out.items[date] = b;
    }
    return out;
  }

  function localDoc() { return normalize(readLS(LS_RATINGS, emptyDoc())); }
  function saveLocal(doc) {
    var d = normalize(doc);
    d.updated = nowISO();
    writeLS(LS_RATINGS, d);
    emit({ phase: 'local', doc: d });
    return d;
  }

  /* ---------------- 事件 ---------------- */
  var lastState = { phase: 'idle', message: '', at: '' };
  var syncing = null;
  function emit(detail) {
    var p = detail || {};
    lastState = {
      phase: p.phase || lastState.phase,
      message: p.message || lastState.message,
      at: nowISO()
    };
    if (typeof document !== 'undefined' && document.dispatchEvent) {
      document.dispatchEvent(new CustomEvent('ratings:state', {
        detail: Object.assign({}, lastState, { doc: p.doc, token: hasToken() })
      }));
    }
    return lastState;
  }
  function state() {
    return { phase: lastState.phase, message: lastState.message, at: lastState.at, token: hasToken(), doc: localDoc() };
  }

  /* ---------------- GitHub Contents API ---------------- */

  function apiFetch(pathname, options) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('当前环境不支持网络请求'));
    var token = getToken();
    if (!token) return Promise.reject(new Error('还没填令牌'));
    var opts = options || {};
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    };
    return fetch(CFG.api + pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body == null ? undefined : JSON.stringify(opts.body),
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 401) throw new Error('令牌无效或已过期，请重新生成并粘贴。');
      if (res.status === 403) throw new Error('没有权限或触发限流，请检查令牌是否只授权了这个仓库的 Contents 读写。');
      if (res.status === 404) {
        if (pathname.indexOf('/contents/') >= 0) return { __notFound: true };
        throw new Error('找不到仓库或文件。');
      }
      if (opts.allow409 && res.status === 409) return { __conflict: true };
      if (!res.ok) throw new Error('GitHub 返回 HTTP ' + res.status);
      return res.json();
    });
  }
  function contentsPath() {
    return '/repos/' + encodeURIComponent(CFG.owner) + '/' + encodeURIComponent(CFG.repo)
      + '/contents/' + CFG.path.split('/').map(encodeURIComponent).join('/');
  }
  function pullRemote() {
    return apiFetch(contentsPath() + '?ref=' + encodeURIComponent(CFG.branch) + '&t=' + Date.now())
      .then(function (data) {
        if (data && data.__notFound) return { doc: emptyDoc(), sha: '' };
        var raw = data && data.content ? base64ToUtf8(data.content) : '';
        var parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) { throw new Error('仓库里的打分文件不是合法 JSON，已停止覆盖，请人工检查。'); }
        return { doc: normalize(parsed), sha: String(data.sha || '') };
      });
  }
  function pushRemote(doc, sha) {
    return apiFetch(contentsPath(), {
      method: 'PUT',
      allow409: true,
      body: {
        message: 'chore(ratings): sync daily10k issue ratings ' + nowISO(),
        content: utf8ToBase64(JSON.stringify(normalize(doc), null, 2) + '\n'),
        branch: CFG.branch,
        sha: sha || undefined
      }
    }).then(function (data) {
      if (data && data.__conflict) return { conflict: true };
      return { conflict: false };
    });
  }

  // 拉云端 → 与本机合并 → 写回；409 重拉重试，最多 3 次；成功才认本机为已同步。
  function sync() {
    if (syncing) return syncing;
    if (!hasToken()) {
      emit({ phase: 'offline', message: '未填令牌，打分只存这台设备，推荐暂时学不到' });
      return Promise.resolve(state());
    }
    emit({ phase: 'syncing', message: '正在把打分同步到私有仓…' });
    syncing = (function attempt(tries) {
      return pullRemote().then(function (remote) {
        var next = mergeDoc(localDoc(), remote.doc);
        next.updated = nowISO();
        return pushRemote(next, remote.sha).then(function (result) {
          if (result.conflict) {
            if (tries >= 2) throw new Error('云端同时被另一台设备改动，稍后会自动重试。');
            return attempt(tries + 1);
          }
          saveLocal(next);
          emit({ phase: 'synced', message: '打分已同步到私有仓，下次归档会让推荐学会', doc: next });
          return state();
        });
      });
    })(0).catch(function (err) {
      emit({ phase: 'error', message: String(err && err.message ? err.message : '同步失败') + '（分数已留在本机，配好令牌后会自动补传）' });
      return state();
    }).then(function (s) { syncing = null; return s; }, function (e) { syncing = null; throw e; });
    return syncing;
  }

  /* ---------------- 对外：打分 ---------------- */

  // meta: { repo, title, lenses, category } —— 一起写进去，纠偏时不必再回查索引
  function rate(date, score, meta) {
    if (!DATE_RE.test(String(date))) throw new Error('日期格式应为 YYYY-MM-DD');
    var n = Number(score);
    if (!isFinite(n) || n < 1 || n > 10) throw new Error('分数必须是 1~10');
    var doc = localDoc(), m = meta || {};
    doc.items[String(date)] = {
      score: Math.round(n),
      repo: String(m.repo || ''),
      title: String(m.title || ''),
      lenses: Array.isArray(m.lenses) ? m.lenses.filter(function (x) { return typeof x === 'string'; }) : [],
      category: String(m.category || ''),
      ratedAt: nowISO()
    };
    saveLocal(doc);
    if (hasToken()) sync().catch(function () {});
    return doc;
  }
  function get(date) { return localDoc().items[String(date)] || null; }
  function list() { return localDoc().items; }

  return {
    CFG: CFG, DATE_RE: DATE_RE,
    hasToken: hasToken, getToken: getToken,
    state: state, sync: sync,
    rate: rate, get: get, list: list,
    localDoc: localDoc, saveLocal: saveLocal,
    _pure: { normalize: normalize, mergeDoc: mergeDoc, utf8ToBase64: utf8ToBase64, base64ToUtf8: base64ToUtf8 }
  };
});
