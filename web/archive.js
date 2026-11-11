/* ==========================================================
   万星日报 · 往期回顾
   ---------------------------------------------------------
   数据来自 data/index.json：生成管线列出全部往期，不设条数上限，
   所以这一页能检索到任意一天，而不只是最近几期。

   搜索 / 筛选 / 按月分组都是纯函数（不碰 DOM、不发请求），
   正文仍由 article.html 按日期去 data/posts/ 取，这里只管「找得到」。

   转义复用 favorites.js 的 esc()，避免两处各写一份后逐渐漂移。
   ========================================================== */

const ARC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- 纯逻辑 ---------- */

// 搜索面：日期也要能搜（「11-07」直接定位到那一期的 haystack）
function issueHaystack(it) {
  return [it.date, it.title, it.oneLiner, it.category, it.repo, ...(it.lenses || [])]
    .join(' ').toLowerCase();
}

// 多个关键词按 AND 处理：「ai 记忆」要求两个词都命中，比整串子串匹配更好用。
// 非法日期一律丢掉——它会拼进 article.html?d=，不能让它变成死链。
function filterIssues(issues, query, lens) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (issues || []).filter(it => {
    if (!it || !ARC_DATE_RE.test(it.date || '')) return false;
    if (lens && !(it.lenses || []).includes(lens)) return false;
    if (!terms.length) return true;
    const hay = issueHaystack(it);
    return terms.every(t => hay.includes(t));
  });
}

// 筛选 chip 的顺序按「命中期数多的在前」，随数据自己演进，
// 不在前端硬编码一份选题清单（那份清单的真源在 generate.mjs）
function collectLenses(issues) {
  const count = new Map();
  for (const it of issues || []) {
    for (const l of it.lenses || []) count.set(String(l), (count.get(String(l)) || 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([label, n]) => ({ label, count: n }));
}

// 入参按日期倒序；分组后月份与组内都保持倒序
function groupByMonth(issues) {
  const sorted = [...(issues || [])].sort((a, b) => b.date.localeCompare(a.date));
  const groups = [];
  for (const it of sorted) {
    const key = it.date.slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  return groups;
}

function starsText(stars) {
  const n = Number(stars);
  return Number.isFinite(n) && n > 0 ? '★ ' + n.toLocaleString('zh-CN') : '';
}

/* ---------- 渲染 ---------- */

function arcItemHtml(it) {
  const stars = starsText(it.stars);
  const lenses = (it.lenses || []).map(l => `<span class="arc-lens">${esc(l)}</span>`).join('');
  return `
    <article class="arc-item">
      <a class="arc-link" href="article.html?d=${encodeURIComponent(it.date)}">
        <div class="arc-top">
          <time class="arc-date" datetime="${esc(it.date)}">${esc(it.date.slice(5))}</time>
          ${stars ? `<span class="arc-stars">${esc(stars)}</span>` : ''}
        </div>
        <h3 class="arc-title">${esc(it.title || '万星日报')}</h3>
        ${it.oneLiner ? `<p class="arc-one">${esc(it.oneLiner)}</p>` : ''}
        <div class="arc-tags">
          ${categoryTags(it.category)}
          ${lenses}
        </div>
        <span class="arc-go">阅读全文<span class="go" aria-hidden="true">→</span></span>
      </a>
    </article>`;
}

function arcGroupsHtml(groups) {
  return groups.map(g => `
    <section class="arc-month">
      <h2 class="arc-month-title">${esc(g.label)}<span class="arc-month-n">${g.items.length} 期</span></h2>
      <div class="arc-list">${g.items.map(arcItemHtml).join('')}</div>
    </section>`).join('');
}

function arcEmptyHtml(hasFilter) {
  return `
    <div class="empty">
      <p class="big" aria-hidden="true">☁</p>
      <p>${hasFilter ? '没有匹配的往期。' : '还没有任何往期。'}</p>
      <p class="empty-hint">${hasFilter
        ? '换个关键词，或把选题方向切回「全部」。'
        : '日报每天 5:30 前更新，生成后会永久留在这里。'}</p>
      ${hasFilter ? '<p><button type="button" class="arc-reset">清除搜索与筛选</button></p>' : ''}
    </div>`;
}

/* ---------- 页面装配 ---------- */

async function initArchivePage() {
  const root = document.getElementById('arc-root');
  const countEl = document.getElementById('arc-count');
  const lensEl = document.getElementById('arc-lenses');
  const input = document.getElementById('arc-q');
  const loading = document.getElementById('arc-loading');

  let issues = [];
  try {
    const res = await fetch('data/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const idx = await res.json();
    issues = Array.isArray(idx.issues) ? idx.issues : [];
  } catch {
    loading.hidden = true;
    countEl.textContent = '';
    root.innerHTML = `
      <div class="empty">
        <p class="big" aria-hidden="true">☁</p>
        <p>往期索引加载失败。</p>
        <p class="empty-hint">请检查网络后刷新重试。<a href="index.html">回首页看今天的</a></p>
      </div>`;
    return;
  }

  loading.hidden = true;

  const allLenses = collectLenses(issues);
  let lens = '';
  let query = '';

  lensEl.innerHTML = [{ label: '', count: issues.length }, ...allLenses]
    .map(l => `<button type="button" class="arc-chip${l.label ? '' : ' is-on'}"
      data-lens="${esc(l.label)}" aria-pressed="${l.label ? 'false' : 'true'}">
      ${esc(l.label || '全部方向')}<span class="arc-chip-n">${l.count}</span></button>`).join('');

  function paint() {
    const shown = filterIssues(issues, query, lens);
    const hasFilter = !!(query.trim() || lens);
    countEl.textContent = hasFilter
      ? `匹配 ${shown.length} / ${issues.length} 期`
      : `共 ${issues.length} 期 · 全文永久保留`;
    root.innerHTML = shown.length ? arcGroupsHtml(groupByMonth(shown)) : arcEmptyHtml(hasFilter);
    const reset = root.querySelector('.arc-reset');
    if (reset) reset.addEventListener('click', () => {
      query = ''; lens = ''; input.value = '';
      syncChips();
      paint();
      input.focus();
    });
  }

  function syncChips() {
    lensEl.querySelectorAll('.arc-chip').forEach(c => {
      const on = c.dataset.lens === lens;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  lensEl.addEventListener('click', e => {
    const chip = e.target.closest('.arc-chip');
    if (!chip) return;
    lens = chip.dataset.lens;
    syncChips();
    paint();
  });

  // 期数多了以后每次 keystroke 全量重绘会卡，稍微攒一下再渲染。
  // 输入框在 root 外面，重绘不会抢走焦点。
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = input.value; paint(); }, 120);
  });

  paint();
}