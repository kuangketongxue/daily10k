/* ==========================================================
   万星日报 · 收藏夹共享模块
   ---------------------------------------------------------
   收藏列表只有一个事实源：仓库里的 data/favorites.json。
   它同时被两处消费：
     1. 浏览器直接 fetch 读取 —— 收藏列表、首页/文章页的收藏状态
     2. scripts/generate.mjs 每次生成时重写 —— 只保留全文仍存在的条目
   浏览器端不写仓库（没有凭据，前端也绝不放 token）：
   实际写入由本机 git 完成，走 sw-edit.html 这个维护页。
   ========================================================== */

const FAV_INDEX = 'data/favorites.json';
const FAV_POST = (date) => 'data/posts/' + encodeURIComponent(date) + '.json';
// 往期被收藏的全文会归档到这里；posts/ 里没有时回落到这个路径
const FAV_ARCHIVE = (date) => 'data/archive/' + encodeURIComponent(date) + '.json';
const LS_OPEN = 'daily10k:favorites:open';

/* ---------- 小工具 ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readCache(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeCache(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式/配额满时静默降级 */ }
}

/* ---------- 收藏列表 ---------- */

// 列表形状：{ updated, items: [{ date, title, oneLiner, category, stars, savedAt }] }
async function loadFavoritesIndex() {
  const res = await fetch(FAV_INDEX, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function favoriteDates(index) {
  return new Set((index && index.items ? index.items : []).map(it => it.date));
}

function isFavorited(index, date) {
  return !!date && favoriteDates(index).has(date);
}

// 归档全文：收藏夹页展开某条时按需拉取。
// 走 Cache Storage（由 sw.js 提供），任何设备首次展开后即可离线回看。
// 顺序是 archive 优先：收藏夹里每一条都被归档过，先打 archive 就不会先撞一个必然的 404。
async function loadArchivedPost(date) {
  const candidates = [FAV_ARCHIVE(date), FAV_POST(date)];
  let lastErr = null;
  for (const path of candidates) {
    const url = new URL(path, location.href).href;
    try {
      const cached = await caches.match(url);
      const res = cached || await fetch(url, { cache: 'no-cache' });
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('not found');
}

/* ---------- 收藏按钮 ---------- */

function starSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.45 6.19 20.5 7.3 14.03 2.6 9.45l6.5-.95z"
      fill="${filled ? 'currentColor' : 'none'}"
      stroke="currentColor" stroke-width="1.7"
      stroke-linejoin="round"/></svg>`;
}

// 每个槽位独立创建一个按钮，避免多个槽位（首页/文章页）争抢同一个 id
function ensureFavButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fav-btn';
  btn.hidden = true;
  return btn;
}

function paintFavButton(btn, filled, label) {
  btn.dataset.fav = filled ? '1' : '0';
  btn.classList.toggle('is-on', filled);
  btn.innerHTML = starSvg(filled) + '<span class="fav-text">' + esc(label) + '</span>';
  btn.setAttribute('aria-pressed', filled ? 'true' : 'false');
}

// 在指定容器里挂一个收藏按钮，并绑定当前日期的收藏状态
function mountFavButton(container, date, opts = {}) {
  if (!date) return null;
  const btn = ensureFavButton();
  container.appendChild(btn);

  const label = opts.label || '收藏这一期';
  const onLabel = opts.onLabel || '已收藏 · 点击取消';

  paintFavButton(btn, false, label);
  btn.hidden = false;

  loadFavoritesIndex()
    .then(idx => {
      const on = isFavorited(idx, date);
      paintFavButton(btn, on, on ? onLabel : label);
    })
    .catch(() => { btn.hidden = true; });

  btn.addEventListener('click', () => {
    // 浏览器端不能写仓库（无凭据，前端也不该有 token）。
    // 交给本机维护页，由本机 git 完成实际写入。
    // 用 location.href 而不是 window.open：不弹窗、不打断阅读，
    // 维护页上有完整命令与说明，看完再决定。
    location.href = 'sw-edit.html?date=' + encodeURIComponent(date);
  });

  return btn;
}

/* ---------- 收藏夹列表页 ---------- */

function renderFavoritesPage(root, index) {
  const items = (index && index.items ? index.items : []).slice()
    .sort((a, b) => String(b.savedAt || b.date).localeCompare(String(a.savedAt || a.date)));

  if (!items.length) {
    root.innerHTML = `
      <div class="empty">
        <p class="big" aria-hidden="true">☆</p>
        <p>收藏夹还是空的。</p>
        <p class="empty-hint">在首页或文章页点「收藏这一期」，它就会出现在这里，全文也会一直留着。</p>
      </div>`;
    return;
  }

  const addParam = new URLSearchParams(location.search).get('add');
  const openSet = readOpenDates();
  const html = items.map(it => {
    const d = esc(it.date);
    const open = it.date === addParam || openSet.has(it.date);
    return `
    <article class="fav-item${open ? ' is-open' : ''}" data-date="${d}">
      <div class="fav-head">
        <div class="fav-main">
          <p class="fav-date">${d}</p>
          <h2 class="fav-title">${esc(it.title)}</h2>
          <p class="fav-one">${esc(it.oneLiner)}</p>
          <div class="fav-tags">
            ${it.category ? `<span class="tag">${esc(it.category)}</span>` : ''}
            ${Number(it.stars) > 0 ? `<span class="fav-stars">★ ${Number(it.stars).toLocaleString('zh-CN')}</span>` : ''}
          </div>
        </div>
        <div class="fav-actions">
          <button type="button" class="fav-open" data-date="${d}" aria-expanded="${open ? 'true' : 'false'}">
            ${open ? '收起全文' : '看全文'}
          </button>
          <a class="fav-goto" href="article.html?d=${encodeURIComponent(it.date)}">原文页</a>
          <button type="button" class="fav-drop" data-date="${d}">取消收藏</button>
        </div>
      </div>
      <div class="fav-body" data-date="${d}" ${open ? '' : 'hidden'}>
        <div class="fav-loading" role="status">正在调出归档全文<span class="dots"></span></div>
      </div>
    </article>`;
  }).join('');

  root.innerHTML = `
    <p class="fav-count">共 ${items.length} 期收藏</p>
    <div class="fav-list">${html}</div>`;

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
    const post = await loadArchivedPost(date);
    body.dataset.loaded = '1';
    body.innerHTML = renderPostHtml(post, { headingTag: 'h2' });
  } catch {
    body.innerHTML = `
      <div class="empty fav-miss">
        <p>这一期的全文已经不在站点上了。</p>
        <p class="empty-hint">每天生成新一期时会清理旧全文，被收藏的期次会保留归档。
        若你刚收藏，请稍等发布完成后再刷新。</p>
      </div>`;
  }
}

// 复用文章页的排版：把 post JSON 渲染成和 article.html 一致的正文结构。
// opts.headingTag：文章页自己用 h1；收藏夹里就地展开时页面已有 h1，必须降到 h2，否则一页两个 h1。
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

// 与 article.html 相同的行内处理：先摘出代码与链接，再整体转义
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

/* ---------- 取消收藏 ---------- */

// 同收藏一样，浏览器端不直接改仓库文件：交给本机维护页处理。
// 先在本页给一个明确的「已标记」反馈再跳转 —— 直接闪走会让人以为点错了。
function dropFavorite(root, date, btn) {
  const item = root.querySelector('.fav-item[data-date="' + CSS.escape(date) + '"]');
  if (item) item.classList.add('is-leaving');
  btn.disabled = true;
  btn.textContent = '已标记取消…';
  rememberOpen(date, false);
  setTimeout(() => {
    location.href = 'sw-edit.html?date=' + encodeURIComponent(date) + '&drop=1';
  }, 450);
}
