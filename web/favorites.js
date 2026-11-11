/* ==========================================================
   万星日报 · 收藏夹模块（纯本机存储）
   ---------------------------------------------------------
   收藏只存在这台设备的浏览器里：
     - 点「收藏这一期」立刻增删，不需要登录、不需要网络、不需要任何密钥
     - 刷新、重启浏览器都还在
     - 换设备：在旧设备点「导出收藏」拿一段短码，在新设备点「导入收藏」粘贴

   为什么用短码而不是账号同步：站点是 GitHub Pages 纯静态，
   没有任何能替浏览器写数据的通道（前端持凭据 = 密钥公开），
   所以「跨设备」只能靠用户自己搬运一次，短码是最省事的形式。

   正文按日期从 data/posts/ 现取；往期永久保留，所以任何一天都能回看。
   ========================================================== */

const LS_FAV = 'daily10k:favorites';
const LS_OPEN = 'daily10k:favorites:open';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- 小工具 ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 分类串（「AI Agent · 技能编排 · 官方示例」）拆成逐项标签，
// 首页 / 归档 / 收藏三处共用同一套拆分口径，避免一处整串、一处逐项。
function splitCategory(cat) {
  return String(cat ?? '').split(/[·\/,，]/).map(s => s.trim()).filter(Boolean);
}

function categoryTags(cat) {
  return splitCategory(cat).map(c => `<span class="tag">${esc(c)}</span>`).join('');
}

function readCache(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeCache(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式/配额满时静默降级 */ }
}

/* ---------- 收藏数据 ---------- */

function loadFavorites() {
  const raw = readCache(LS_FAV);
  if (!raw) return { items: [] };
  try {
    const d = JSON.parse(raw);
    const items = Array.isArray(d.items) ? d.items : [];
    return { items: items.filter(d => DATE_RE.test(d)) };
  } catch {
    return { items: [] };
  }
}

function saveFavorites(items) {
  const uniq = [...new Set(items)].sort().reverse();
  writeCache(LS_FAV, JSON.stringify({ items: uniq }));
  return uniq;
}

function has(items, date) { return Array.isArray(items) && items.includes(date); }

function toggleFavorite(date, action) {
  const set = new Set(loadFavorites().items);
  if (action === 'add') set.add(date); else set.delete(date);
  return saveFavorites([...set]);
}

/* ---------- 导出 / 导入（跨设备短码） ---------- */

// 码里只有日期，纯 ASCII；体积随收藏数线性增长（10 期约 60 字符）
function encodeFavorites(items) {
  const payload = JSON.stringify({ v: 1, items: [...new Set(items)].sort() });
  return btoa(payload).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeFavorites(code) {
  const clean = String(code || '').trim().replace(/[-\s]/g, m => (m === '-' ? '+' : ''));
  if (!clean) throw new Error('短码是空的。');
  let payload;
  try {
    payload = JSON.parse(atob(clean.replace(/_/g, '/')));
  } catch {
    throw new Error('短码格式不对，检查是不是复制完整了。');
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.items)) {
    throw new Error('短码格式不对。');
  }
  const items = payload.items.filter(d => DATE_RE.test(d));
  if (!items.length) throw new Error('短码里没有任何有效日期。');
  return items;
}

/* ---------- 轻提示 ---------- */

let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('fav-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fav-toast';
    el.className = 'fav-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
}

/* ---------- 收藏按钮 ---------- */

function starSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.45 6.19 20.5 7.3 14.03 2.6 9.45l6.5-.95z"
      fill="${filled ? 'currentColor' : 'none'}"
      stroke="currentColor" stroke-width="1.7"
      stroke-linejoin="round"/></svg>`;
}

function paintFavButton(btn, filled, label, busy) {
  btn.dataset.fav = filled ? '1' : '0';
  btn.dataset.busy = busy ? '1' : '0';
  btn.classList.toggle('is-on', filled);
  btn.disabled = !!busy;
  btn.innerHTML = starSvg(filled) + '<span class="fav-text">' + esc(label) + '</span>';
  btn.setAttribute('aria-pressed', filled ? 'true' : 'false');
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function mountFavButton(container, date, opts = {}) {
  if (!date || !container) return null;

  const label = opts.label || '收藏这一期';
  const onLabel = opts.onLabel || '已收藏 · 点击取消';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fav-btn';
  container.appendChild(btn);

  const on = has(loadFavorites().items, date);
  paintFavButton(btn, on, on ? onLabel : label, false);

  btn.addEventListener('click', () => {
    if (btn.dataset.busy === '1') return;
    const wasOn = btn.dataset.fav === '1';
    const next = toggleFavorite(date, wasOn ? 'remove' : 'add');
    const nowOn = has(next, date);
    paintFavButton(btn, nowOn, nowOn ? onLabel : label, false);
    if (nowOn) toast('已收藏 ' + date);
    document.dispatchEvent(new CustomEvent('favorites:changed', { detail: { items: next } }));
  });

  return btn;
}

/* ---------- 收藏夹列表页 ---------- */

function renderEmpty(root) {
  root.innerHTML = `
    <div class="empty">
      <p class="big" aria-hidden="true">☆</p>
      <p>收藏夹还是空的。</p>
      <p class="empty-hint">在首页或文章页点「收藏这一期」，它就会出现在这里。</p>
      <p class="empty-hint">收藏只存在这台设备上；换设备时用上面的「导出收藏 / 导入收藏」搬一次。</p>
    </div>`;
}

function renderFavoriteItem(post, date, open) {
  const m = post.meta || {};
  return `
    <article class="fav-item${open ? ' is-open' : ''}" data-date="${esc(date)}">
      <div class="fav-head">
        <div class="fav-main">
          <p class="fav-date">${esc(date)}</p>
          <h2 class="fav-title">${esc(post.title || '万星日报')}</h2>
          <p class="fav-one">${esc(post.oneLiner || '')}</p>
          <div class="fav-tags">
            ${categoryTags(post.category)}
            ${Number(m.stars) > 0 ? `<span class="fav-stars">★ ${Number(m.stars).toLocaleString('zh-CN')}</span>` : ''}
          </div>
        </div>
        <div class="fav-actions">
          <button type="button" class="fav-open" data-date="${esc(date)}" aria-expanded="${open ? 'true' : 'false'}">
            ${open ? '收起全文' : '看全文'}
          </button>
          <a class="fav-goto" href="article.html?d=${encodeURIComponent(date)}">原文页</a>
          <button type="button" class="fav-drop" data-date="${esc(date)}">取消收藏</button>
        </div>
      </div>
      <div class="fav-body" data-date="${esc(date)}" ${open ? '' : 'hidden'}>
        <div class="fav-loading" role="status">正在调出全文<span class="dots"></span></div>
      </div>
    </article>`;
}

function itemFailed(date) {
  return `<article class="fav-item" data-date="${esc(date)}">
     <div class="fav-head"><div class="fav-main">
       <p class="fav-date">${esc(date)}</p>
       <p class="fav-one">这一期的全文暂时读不到，可能网络不稳。</p>
     </div>
     <div class="fav-actions">
       <a class="fav-goto" href="article.html?d=${encodeURIComponent(date)}">原文页</a>
       <button type="button" class="fav-drop" data-date="${esc(date)}">取消收藏</button>
     </div></div>
   </article>`;
}

async function initFavoritesPage(root) {
  const items = loadFavorites().items;

  if (!items.length) { renderEmpty(root); return; }

  root.innerHTML = `<div class="loading" role="status">正在读取收藏夹<span class="dots"></span></div>`;

  const openSet = readOpenDates();
  const pieces = [];
  for (const date of items) {
    let post = null;
    try { post = await loadPostByDate(date); } catch { }
    pieces.push(post ? renderFavoriteItem(post, date, openSet.has(date)) : itemFailed(date));
  }

  root.innerHTML = `
    <p class="fav-count"><span class="fav-count-text">共 ${items.length} 期收藏</span></p>
    <div class="fav-list">${pieces.join('')}</div>`;

  root.querySelectorAll('.fav-open').forEach(btn => {
    btn.addEventListener('click', () => toggleFavBody(root, btn.dataset.date, btn));
  });
  root.querySelectorAll('.fav-drop').forEach(btn => {
    btn.addEventListener('click', () => dropFavorite(root, btn.dataset.date, btn));
  });

  root.querySelectorAll('.fav-item.is-open .fav-body').forEach(body => {
    fillFavBody(body, body.dataset.date);
  });
}

/* ---------- 导出 / 导入面板 ---------- */

function initSyncPanel(panel, root) {
  const body = panel.querySelector('.fav-sync-body');
  let mode = null;

  function render() {
    if (!mode) { body.hidden = true; body.innerHTML = ''; return; }
    body.hidden = false;

    if (mode === 'export') {
      body.innerHTML = `
        <p class="fav-sync-title">把这段短码复制到新设备，点「导入收藏」粘贴进去即可。</p>
        <textarea class="fav-sync-box" readonly rows="3">${esc(encodeFavorites(loadFavorites().items))}</textarea>
        <p><button type="button" class="read-btn fav-sync-copy">复制短码</button></p>`;
      body.querySelector('.fav-sync-copy').addEventListener('click', async () => {
        const box = body.querySelector('.fav-sync-box');
        try {
          await navigator.clipboard.writeText(box.value);
          toast('已复制，去新设备粘贴导入。');
        } catch {
          box.select();
          toast('已选中，按 Ctrl+C 复制。');
        }
      });
    } else {
      body.innerHTML = `
        <p class="fav-sync-title">粘贴在旧设备上导出的短码。导入会与当前收藏合并，不会覆盖。</p>
        <textarea class="fav-sync-box" rows="3" placeholder="粘贴短码"></textarea>
        <p>
          <button type="button" class="read-btn fav-sync-do">导入</button>
          <button type="button" class="fav-sync-cancel">取消</button>
        </p>
        <p class="fav-sync-err" role="alert"></p>`;
      const box = body.querySelector('.fav-sync-box');
      const errEl = body.querySelector('.fav-sync-err');

      body.querySelector('.fav-sync-do').addEventListener('click', () => {
        errEl.textContent = '';
        let added;
        try {
          added = decodeFavorites(box.value);
        } catch (e) {
          errEl.textContent = e.message || '短码不对。';
          return;
        }
        // 合并而不是替换：新设备上可能已经收藏了几期，直接覆盖会丢
        saveFavorites([...new Set([...loadFavorites().items, ...added])]);
        mode = null;
        render();
        initFavoritesPage(root);
        toast('已导入 ' + added.length + ' 期。');
      });
      body.querySelector('.fav-sync-cancel').addEventListener('click', () => { mode = null; render(); });
    }
  }

  panel.querySelectorAll('.fav-sync-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      mode = mode === act ? null : act;
      render();
    });
  });

  render();
}

/* ---------- 展开 / 取消 ---------- */

async function toggleFavBody(root, date, btn) {
  const body = root.querySelector('.fav-body[data-date="' + CSS.escape(date) + '"]');
  if (!body) return;
  const willOpen = body.hidden;
  body.hidden = !willOpen;
  btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  btn.textContent = willOpen ? '收起全文' : '看全文';
  if (willOpen) {
    rememberOpen(date, true);
    await fillFavBody(body, date);
  } else {
    rememberOpen(date, false);
  }
}

async function fillFavBody(body, date) {
  if (body.dataset.loaded === '1') return;
  try {
    const post = await loadPostByDate(date);
    body.dataset.loaded = '1';
    body.innerHTML = renderPostHtml(post, { headingTag: 'h2' });
  } catch {
    body.innerHTML = `
      <div class="empty fav-miss">
        <p>这一期的全文暂时读不到。</p>
        <p class="empty-hint">可能是网络问题，稍后刷新再试。</p>
      </div>`;
  }
}

function dropFavorite(root, date, btn) {
  const next = toggleFavorite(date, 'remove');
  const item = root.querySelector('.fav-item[data-date="' + CSS.escape(date) + '"]');
  if (item) {
    item.classList.add('is-leaving');
    setTimeout(() => {
      item.remove();
      if (!root.querySelectorAll('.fav-item').length) { initFavoritesPage(root); return; }
      const t = root.querySelector('.fav-count-text');
      if (t) t.textContent = `共 ${next.length} 期收藏`;
    }, 260);
  }
  rememberOpen(date, false);
  document.dispatchEvent(new CustomEvent('favorites:changed', { detail: { items: next } }));
}

/* ---------- 按日期取全文 ---------- */

const POST_SOURCES = ['data/posts/', 'data/archive/'];

async function loadPostByDate(date) {
  for (const dir of POST_SOURCES) {
    try {
      const res = await fetch(dir + encodeURIComponent(date) + '.json', { cache: 'no-cache' });
      if (!res.ok) continue;
      return await res.json();
    } catch { /* 换下一个来源 */ }
  }
  throw new Error('not found');
}

/* ---------- 展开状态记忆 ---------- */

function readOpenDates() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_OPEN) || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function rememberOpen(date, open) {
  const set = readOpenDates();
  if (open) set.add(date); else set.delete(date);
  writeCache(LS_OPEN, JSON.stringify([...set]));
}

/* ---------- 正文渲染（文章页与收藏夹共用） ---------- */

// opts.headingTag：文章页自己用 h1；收藏夹里就地展开时页面已有 h1，必须降到 h2。
// opts.afterTitle：插在标题与摘要之间的自定义内容（文章页用它放收藏按钮槽位）。
function renderPostHtml(p, opts = {}) {
  const m = p.meta || {};
  const stats = p.stats || {};
  const h = opts.headingTag || 'h1';

  let html = `<${h} class="a-title">${esc(p.title || '万星日报')}</${h}>
    ${opts.afterTitle || ''}
    <div class="a-summary">
      <p class="a-oneliner"><strong>一句话：</strong>${esc(p.oneLiner)}</p>
      <div class="a-metas">
        ${p.date ? `<span>${esc(p.date)}</span>` : ''}
        <span>${esc(p.category || '')}</span>
        ${m.license ? `<span>${esc(m.license)}</span>` : ''}
        ${m.language ? `<span>${esc(m.language)}</span>` : ''}
        ${m.stars ? `<span>GitHub 星数 ${Number(m.stars).toLocaleString('zh-CN')}</span>` : ''}
        ${m.trending ? `<span class="hot">Trending ${esc(m.trending.window)} #${esc(m.trending.rank)} · ${esc(m.trending.unit)}+${Number(m.trending.gained).toLocaleString('zh-CN')}★</span>` : ''}
        ${m.lenses ? `<span>适合 ${esc(m.lenses.join(' / '))}</span>` : ''}
        ${m.lastCommit ? `<span>最近提交 ${esc(m.lastCommit)}</span>` : ''}
        ${m.openIssues != null ? `<span>未关闭 Issue/PR ${Number(m.openIssues).toLocaleString('zh-CN')}</span>` : ''}
        ${m.version ? `<span>${esc(m.version)}</span>` : ''}
        ${stats.minutes ? `<span>阅读约 ${esc(stats.minutes)} 分钟</span>` : ''}
      </div>
    </div>`;

  let body = '';
  for (const sec of p.sections || []) {
    const raw = String(sec.heading ?? '');
    const mt = raw.match(/^\s*(\d{1,2})\s*[.、．]?\s+(.+)$/);
    const num = mt ? mt[1].padStart(2, '0') : '';
    const label = mt ? mt[2] : raw;
    body += `<section class="a-sec"><h2${num ? ` data-num="${num}"` : ''}>${esc(label)}</h2>`;
    for (const b of sec.blocks || []) {
      if (b.type === 'p') {
        body += `<p>${inline(b.text)}</p>`;
      } else if (b.type === 'sub') {
        body += `<h3>${esc(b.text)}</h3>`;
      } else if (b.type === 'kv') {
        body += `<p class="a-kv"><strong>${esc(b.k)}</strong>${inline(b.v)}</p>`;
      } else if (b.type === 'list') {
        body += '<ul>' + b.items.map(i => `<li>${inline(i)}</li>`).join('') + '</ul>';
      } else if (b.type === 'code') {
        body += `<pre class="a-code"><code>${esc(b.code)}</code></pre>`;
        if (b.caption) body += `<p class="a-caption">${esc(b.caption)}</p>`;
      } else if (b.type === 'quote') {
        body += `<blockquote>${inline(b.text)}</blockquote>`;
      }
    }
    body += '</section>';
  }
  html += `<div class="a-body">${body}</div>`;

  if (m.repo) {
    html += `
    <div class="a-repo">
      <p>想自己试试？项目地址：</p>
      <p><a class="repo-link" href="https://github.com/${esc(m.repo)}" target="_blank" rel="noopener">github.com/${esc(m.repo)}</a></p>
    </div>`;
  }
  if (stats.chars != null) {
    html += `
    <p class="a-stats">字数自检：正文汉字 ${Number(stats.chars).toLocaleString('zh-CN')} 字 · 命令块 ${Number(stats.codeBlocks).toLocaleString('zh-CN')} 个 · 阅读约 ${esc(stats.minutes)} 分钟 · 材料截至 ${esc(stats.asOf)}。</p>`;
  }
  return html;
}

// 先摘出行内代码和链接，再整体转义，避免 URL 吞掉后续中文/标点
function inline(s) {
  const slots = [];
  const stash = (html) => {
    slots.push(html);
    return '\u0000' + (slots.length - 1) + '\u0000';
  };
  let text = String(s ?? '');
  text = text.replace(/`([^`]+)`/g, (_, code) => stash(`<code class="ic">${esc(code)}</code>`));
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label, url) => stash(`<a class="src-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`));
  text = text.replace(/https?:\/\/[^\s<>"'`*\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g, (url) => {
    const clean = url.replace(/[.,;:!?]+$/, '');
    return stash(`<a class="src-link" href="${esc(clean)}" target="_blank" rel="noopener">${esc(clean)}</a>`) + url.slice(clean.length);
  });
  text = esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
}
