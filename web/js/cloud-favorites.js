/* ==========================================================================
   云端收藏 · 唯一真身（shared/cloud-favorites.js）
   --------------------------------------------------------------------------
   两个站（ai-daily / daily10k）都用这一份，由 scripts/sync-shared.py 复制，
   禁止在任一站点目录里单独手改，否则会漂移。

   安全边界（硬性，勿放宽）：
     - 本文件不含任何令牌、密钥、凭据；令牌只在运行时由用户粘贴，
       存在浏览器 localStorage，不写入代码 / 仓库 / 日志 / commit。
     - 所有网络请求只发往 api.github.com。
     - 错误信息一律脱敏，绝不回显令牌。
     - GitHub 官方：PAT 无法通过 API 创建，只能用户本人在网页生成。

   同源红利：kuangketongxue.github.io/daily10k/ 与 /ai-daily/ 是同一个
   origin，localStorage 天然共享 —— 令牌填一次，两个站都能用。

   数据文件（私有仓 kuangketongxue/kuangketongxue）：
     data/daily-favorites.json
     { "v":1, "updated":"ISO", "sites": {
         "ai-daily":  { "issues":["2026-11-12"], "items":["2026-11-12#1"] },
         "daily10k":  { "issues":["2026-11-04"], "items":[] }
     }}

   冲突正确性（关键）：多设备同时改时，简单取并集会把「已取消收藏」
   复活。这里改用「未同步操作队列」：同步前先拉云端最新状态，把本地
   还没上传过的 add / remove 按顺序重放，再整体写回；成功后才清空队列。
   断网时操作留在队列里，联上后自动补传。
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudFavorites = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    owner: 'kuangketongxue',
    repo: 'kuangketongxue',
    path: 'data/daily-favorites.json',
    branch: 'main',
    site: 'ai-daily',
    api: 'https://api.github.com'
  };

  var CFG = null;
  var LS = {
    token: 'daily-favorites:gh:token',
    local: 'daily-favorites:local:v1',
    queue: 'daily-favorites:pending:v1'
  };

  var SITES = ['ai-daily', 'daily10k'];
  var KINDS = ['issues', 'items'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // 单条新闻 id = 日期 + # + 序号，如 2026-11-12#1
  var ITEM_RE = /^\d{4}-\d{2}-\d{2}#\d{1,3}$/;

  /* ---------------- 小工具 ---------------- */

  function storage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; }
    catch (e) { return null; }
  }

  function readLS(key, fallback) {
    var s = storage();
    if (!s) return fallback;
    try {
      var raw = s.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeLS(key, value) {
    var s = storage();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }   // 隐私模式 / 配额满：静默降级，不影响阅读
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function nowISO() {
    try { return new Date().toISOString(); }
    catch (e) { return ''; }
  }

  // 正则只验格式，2026-13-01 / 2026-02-31 都能过；这里再校验是不是真日期，
  // 否则脏 id 会被写进私有仓，之后每次同步都带着它。
  function realDate(s) {
    if (!DATE_RE.test(String(s))) return false;
    var dt = new Date(String(s) + 'T00:00:00Z');
    return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === String(s);
  }

  function validId(kind, id) {
    var v = String(id == null ? '' : id).trim();
    if (kind === 'issues') return realDate(v);
    if (!ITEM_RE.test(v)) return false;
    var parts = v.split('#');
    var num = parseInt(parts[1], 10);
    return realDate(parts[0]) && num >= 1 && num <= 999;
  }

  // 排序口径：日期倒序；同一天的新闻条目按序号升序（#1、#2、#3 这样读着顺）
  function sortIds(kind, arr) {
    var list = arr.slice();
    list.sort(function (a, b) {
      if (kind === 'issues') return a < b ? 1 : (a > b ? -1 : 0);
      var pa = String(a).split('#'), pb = String(b).split('#');
      if (pa[0] !== pb[0]) return pa[0] < pb[0] ? 1 : -1;
      return parseInt(pa[1], 10) - parseInt(pb[1], 10);
    });
    return list;
  }

  /* UTF-8 <-> base64：不依赖 btoa/atob 对中文的兼容行为 */
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

  function emptyDoc() {
    var sites = {};
    for (var i = 0; i < SITES.length; i++) sites[SITES[i]] = { issues: [], items: [] };
    return { v: 1, updated: '', sites: sites };
  }

  // 任何来源（云端文件 / localStorage / 旧版本）都先过这道清洗，
  // 脏数据不会污染页面，也不会被写回仓库。
  function normalize(input) {
    var doc = emptyDoc();
    var src = input && typeof input === 'object' ? input : {};
    doc.updated = typeof src.updated === 'string' ? src.updated : '';
    var ss = src.sites && typeof src.sites === 'object' ? src.sites : {};
    for (var i = 0; i < SITES.length; i++) {
      var site = SITES[i];
      var s = ss[site] && typeof ss[site] === 'object' ? ss[site] : {};
      for (var k = 0; k < KINDS.length; k++) {
        var kind = KINDS[k];
        var arr = Array.isArray(s[kind]) ? s[kind] : [];
        var seen = {}, out = [];
        for (var n = 0; n < arr.length; n++) {
          var id = String(arr[n] == null ? '' : arr[n]).trim();
          if (!validId(kind, id) || seen[id]) continue;
          seen[id] = 1;
          out.push(id);
        }
        doc.sites[site][kind] = sortIds(kind, out);
      }
    }
    return doc;
  }

  function applyOp(doc, op) {
    var d = normalize(doc);
    var site = String(op && op.site || '');
    var kind = String(op && op.kind || '');
    var id = String(op && op.id == null ? '' : op.id).trim();
    if (SITES.indexOf(site) < 0 || KINDS.indexOf(kind) < 0 || !validId(kind, id)) return d;
    var arr = d.sites[site][kind];
    var at = arr.indexOf(id);
    if (op.action === 'add') { if (at < 0) arr.push(id); }
    else if (op.action === 'remove') { if (at >= 0) arr.splice(at, 1); }
    d.sites[site][kind] = sortIds(kind, arr);
    return d;
  }

  function applyOps(doc, ops) {
    var d = normalize(doc);
    var list = Array.isArray(ops) ? ops : [];
    for (var i = 0; i < list.length; i++) d = applyOp(d, list[i]);
    return d;
  }

  /* 短码（跨设备手动搬，纯本地字符串变换，无网络请求） */
  function encodeCode(doc) {
    var d = normalize(doc);
    return utf8ToBase64(JSON.stringify({ v: 1, sites: d.sites }))
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function decodeCode(code) {
    var clean = String(code || '').trim();
    if (!clean) throw new Error('短码是空的。');
    var b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var parsed;
    try { parsed = JSON.parse(base64ToUtf8(b64)); }
    catch (e) { throw new Error('短码格式不对，检查是否复制完整了。'); }
    if (!parsed || parsed.v !== 1 || !parsed.sites) throw new Error('短码格式不对。');
    return normalize(parsed);
  }

  // 合并 = 只补对方多出来的，不覆盖、不复活本机已取消的
  function mergeDoc(localDoc, remoteDoc) {
    var out = normalize(localDoc), r = normalize(remoteDoc);
    for (var i = 0; i < SITES.length; i++) {
      var site = SITES[i];
      for (var k = 0; k < KINDS.length; k++) {
        var kind = KINDS[k], seen = {}, merged = [];
        var a = out.sites[site][kind], b = r.sites[site][kind];
        for (var m = 0; m < a.length; m++) { seen[a[m]] = 1; merged.push(a[m]); }
        for (var n = 0; n < b.length; n++) if (!seen[b[n]]) { seen[b[n]] = 1; merged.push(b[n]); }
        out.sites[site][kind] = sortIds(kind, merged);
      }
    }
    return out;
  }

  /* ---------------- 本机即时层 ---------------- */

  function cfg() {
    if (!CFG) CFG = JSON.parse(JSON.stringify(DEFAULTS));
    return CFG;
  }

  function configure(opts) {
    var c = cfg(), o = opts || {};
    for (var key in DEFAULTS) if (Object.prototype.hasOwnProperty.call(o, key)) c[key] = o[key];
    return c;
  }

  function localDoc() { return normalize(readLS(LS.local, emptyDoc())); }

  function saveLocal(doc) {
    var d = normalize(doc);
    d.updated = nowISO();
    writeLS(LS.local, d);
    emit({ phase: 'local', doc: d });
    return d;
  }

  function pending() {
    var p = readLS(LS.queue, []);
    return Array.isArray(p) ? p : [];
  }

  function savePending(ops) { writeLS(LS.queue, Array.isArray(ops) ? ops.slice(-500) : []); }

  function list(kind, site) {
    var k = KINDS.indexOf(kind) >= 0 ? kind : 'issues';
    return localDoc().sites[String(site || cfg().site)] ? localDoc().sites[String(site || cfg().site)][k].slice() : [];
  }

  function has(kind, id, site) { return list(kind, site).indexOf(String(id)) >= 0; }

  function toggle(kind, id, action, site) {
    var s = String(site || cfg().site);
    var k = KINDS.indexOf(kind) >= 0 ? kind : 'issues';
    var clean = String(id == null ? '' : id).trim();
    if (!validId(k, clean)) return null;
    var doc = applyOp(localDoc(), { site: s, kind: k, id: clean, action: action });
    saveLocal(doc);
    var q = pending();
    // 同一目标反复点，只留最后一次意图，避免队列里自相矛盾
    q = q.filter(function (op) {
      return !(op.site === s && op.kind === k && op.id === clean);
    });
    q.push({ site: s, kind: k, id: clean, action: action, at: nowISO() });
    savePending(q);
    if (hasToken()) sync().catch(function () {});
    return doc;
  }

  function add(kind, id, site) { return toggle(kind, id, 'add', site); }
  function remove(kind, id, site) { return toggle(kind, id, 'remove', site); }

  /* ---------------- 令牌（只进 localStorage，绝不落盘到仓库） ---------------- */

  function getToken() {
    var s = storage();
    if (!s) return '';
    try { return String(s.getItem(LS.token) || '').trim(); } catch (e) { return ''; }
  }

  function hasToken() { return !!getToken(); }

  function setToken(token) {
    var s = storage();
    if (!s) return false;
    var t = String(token || '').trim();
    try {
      if (!t) s.removeItem(LS.token); else s.setItem(LS.token, t);
    } catch (e) { return false; }
    emit({ phase: t ? 'token-set' : 'token-cleared' });
    return true;
  }

  function clearToken() { return setToken(''); }

  // 直达链接只预填仓库与权限，不含任何令牌
  function tokenSetupUrl() {
    var c = cfg();
    return 'https://github.com/settings/personal-access-tokens/new'
      + '?name=' + encodeURIComponent('daily-favorites-sync')
      + '&description=' + encodeURIComponent('日报收藏云端同步（仅此仓库 Contents 读写）')
      + '&expires_in=none'
      + '&target_name=' + encodeURIComponent(c.owner)
      + '&repos=' + encodeURIComponent(c.repo)
      + '&contents=write';
  }

  /* ---------------- GitHub Contents API ---------------- */

  function apiFetch(pathname, options) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('当前环境不支持网络请求'));
    var token = getToken();
    if (!token) return Promise.reject(new Error('还没填令牌'));
    var c = cfg();
    var opts = options || {};
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
    // 令牌只在这一个请求头里出现，不进 URL、不进 body、不进日志
    headers['Authorization'] = 'Bearer ' + token;
    return fetch(c.api + pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body == null ? undefined : JSON.stringify(opts.body),
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 401) throw new Error('令牌无效或已过期，请重新生成并粘贴。');
      if (res.status === 403) throw new Error('没有权限或触发限流，请检查令牌是否只授权了这个仓库。');
      if (res.status === 404) {
        if (pathname.indexOf('/contents/') >= 0) return { __notFound: true, res: res };
        throw new Error('找不到仓库或文件，请检查仓库名与分支。');
      }
      if (opts.allow409 && res.status === 409) return { __conflict: true, res: res };
      if (!res.ok) throw new Error('GitHub 返回 HTTP ' + res.status);
      return res.json();
    });
  }

  function contentsPath() {
    var c = cfg();
    return '/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo)
      + '/contents/' + c.path.split('/').map(encodeURIComponent).join('/');
  }

  function pullRemote() {
    var ref = encodeURIComponent(cfg().branch);
    return apiFetch(contentsPath() + '?ref=' + ref + '&t=' + Date.now())
      .then(function (data) {
        if (data && data.__notFound) return { doc: emptyDoc(), sha: '' };
        var raw = data && data.content ? base64ToUtf8(data.content) : '';
        var parsed;
        try { parsed = JSON.parse(raw); } catch (e) { throw new Error('仓库里的收藏文件不是合法 JSON，已停止覆盖。'); }
        return { doc: normalize(parsed), sha: String(data.sha || '') };
      });
  }

  function pushRemote(doc, sha) {
    var c = cfg();
    var body = {
      message: 'chore(favorites): sync daily reading list ' + nowISO(),
      content: utf8ToBase64(JSON.stringify(normalize(doc), null, 2) + '\n'),
      branch: c.branch
    };
    if (sha) body.sha = sha;
    return apiFetch(contentsPath(), {
      method: 'PUT', body: body, allow409: true
    }).then(function (data) {
      if (data && data.__conflict) return { conflict: true };
      return { conflict: false, sha: data && data.content && data.content.sha ? data.content.sha : '' };
    });
  }

  /* ---------------- 同步主流程 ---------------- */

  var syncing = null;
  var lastState = { phase: 'idle', message: '未连接云端', at: '' };

  function emit(detail) {
    var payload = detail || {};
    var state = {
      phase: payload.phase || lastState.phase,
      message: payload.message || lastState.message,
      doc: payload.doc,
      at: nowISO(),
      pending: pending().length,
      token: hasToken()
    };
    lastState = { phase: state.phase, message: state.message, at: state.at };
    if (typeof document !== 'undefined' && document.dispatchEvent) {
      document.dispatchEvent(new CustomEvent('cloud:state', { detail: state }));
    }
    return state;
  }

  function state() {
    return {
      phase: lastState.phase, message: lastState.message, at: lastState.at,
      pending: pending().length, token: hasToken(), doc: localDoc()
    };
  }

  // 拉云端 → 重放未同步操作 → 写回；sha 冲突时重拉重试，最多 3 次。
  // 成功后才清空队列，失败一律保留队列（下次自动补传），绝不丢操作。
  function sync() {
    if (syncing) return syncing;
    if (!hasToken()) { emit({ phase: 'offline', message: '未填令牌，收藏只存在这台设备' }); return Promise.resolve(state()); }
    emit({ phase: 'syncing', message: '正在同步到私有仓…' });
    syncing = (function attempt(tries) {
      return pullRemote().then(function (remote) {
        var ops = pending();
        var merged = mergeDoc(remote.doc, localDoc());
        var next = applyOps(merged, ops);
        next.updated = nowISO();
        return pushRemote(next, remote.sha).then(function (result) {
          if (result.conflict) {
            if (tries >= 2) throw new Error('云端同时被另一台设备改动，稍后会自动重试。');
            return attempt(tries + 1);
          }
          saveLocal(next);
          savePending([]);
          emit({ phase: 'synced', message: '已同步到私有仓', doc: next });
          return state();
        });
      });
    })(0).catch(function (err) {
      emit({
        phase: 'error',
        message: String(err && err.message ? err.message : '同步失败') + '（' + pending().length + ' 项改动已留存，联网后自动补传）'
      });
      return state();
    }).then(function (s) { syncing = null; return s; }, function (e) { syncing = null; throw e; });
    return syncing;
  }

  // 只拉不写：新设备 / 电脑重置后第一次打开时用，把云端收藏取回本机。
  function pull() {
    if (!hasToken()) return Promise.reject(new Error('还没填令牌'));
    emit({ phase: 'syncing', message: '正在从私有仓取回收藏…' });
    return pullRemote().then(function (remote) {
      var next = applyOps(mergeDoc(remote.doc, localDoc()), pending());
      next.updated = nowISO();
      saveLocal(next);
      emit({ phase: 'synced', message: '已从私有仓取回收藏', doc: next });
      return next;
    }).catch(function (err) {
      emit({ phase: 'error', message: String(err && err.message ? err.message : '取回失败') });
      throw err;
    });
  }

  function exportCode() { return encodeCode(localDoc()); }

  // 导入 = 合并，不是覆盖；同时把新增的条目排进队列，下次同步会上传
  function importCode(code) {
    var incoming = decodeCode(code);
    var before = localDoc();
    var merged = mergeDoc(before, incoming);
    saveLocal(merged);
    var q = pending();
    for (var i = 0; i < SITES.length; i++) {
      for (var k = 0; k < KINDS.length; k++) {
        var site = SITES[i], kind = KINDS[k];
        var added = merged.sites[site][kind].filter(function (id) {
          return before.sites[site][kind].indexOf(id) < 0;
        });
        for (var n = 0; n < added.length; n++) {
          q.push({ site: site, kind: kind, id: added[n], action: 'add', at: nowISO() });
        }
      }
    }
    savePending(q);
    if (hasToken()) sync().catch(function () {});
    return merged;
  }

  /* ---------------- 对外接口 ---------------- */

  return {
    DEFAULTS: DEFAULTS,
    SITES: SITES, KINDS: KINDS,
    configure: configure, config: cfg,
    setToken: setToken, getToken: getToken, clearToken: clearToken, hasToken: hasToken,
    tokenSetupUrl: tokenSetupUrl,
    localDoc: localDoc, saveLocal: saveLocal,
    list: list, has: has, add: add, remove: remove, toggle: toggle,
    sync: sync, pull: pull, state: state, emit: emit,
    exportCode: exportCode, importCode: importCode,
    // 纯函数导出给 Node 测试
    _pure: {
      emptyDoc: emptyDoc, normalize: normalize, applyOp: applyOp, applyOps: applyOps,
      mergeDoc: mergeDoc, encodeCode: encodeCode, decodeCode: decodeCode,
      utf8ToBase64: utf8ToBase64, base64ToUtf8: base64ToUtf8, validId: validId,
      realDate: realDate, sortIds: sortIds
    }
  };
});
