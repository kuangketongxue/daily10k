// 往期索引与回顾页纯逻辑测试（不联网、不需要真实密钥）
// 重点守住两条：① 索引不再有 30 期上限 ② 搜索/筛选/分组的行为与转义
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (d ? '  «' + d + '»' : '')); }
};

// generate.mjs 在缺少 AI 配置时会 process.exit(1)，导入前先塞占位值。
// 这里只调用 rebuildIndex()，不会触到任何网络或 LLM。
process.env.AI_API_KEY = 'test';
process.env.AI_BASE_URL = 'http://localhost';
process.env.AI_MODEL = 'test';
const { rebuildIndex } = await import('../scripts/generate.mjs');

/* ---------- 索引：无条数上限 ---------- */

const tmp = mkdtempSync(join(tmpdir(), 'daily10k-index-'));
try {
  const postsDir = join(tmp, 'posts');
  mkdirSync(postsDir, { recursive: true });

  // 45 期，跨 3 个月：既超过旧的 30 期上限，也能验证按月分组
  const dates = [];
  const start = Date.UTC(2026, 6, 20);
  for (let i = 0; i < 45; i++) {
    const date = new Date(start + i * 864e5).toISOString().slice(0, 10);
    dates.push(date);
    writeFileSync(join(postsDir, `${date}.json`), JSON.stringify({
      date,
      title: `proj-${i}：标题`,
      oneLiner: `unique-token-${i}`,
      category: 'AI · 工具',
      meta: {
        repo: `org/repo-${i}`,
        stars: 10000 + i,
        lenses: i % 2 ? ['AI'] : ['高考/考研', 'AI'],
      },
    }));
  }

  rebuildIndex(tmp);
  const idx = JSON.parse(readFileSync(join(tmp, 'index.json'), 'utf8'));

  check('45 期全部进索引（旧的 30 期上限已拆除）', idx.issues.length === 45, String(idx.issues.length));
  check('索引按日期倒序', idx.issues[0].date === dates[44] && idx.issues[44].date === dates[0],
    idx.issues[0].date + ' … ' + idx.issues[44].date);
  check('每条都带 repo（供关键词搜索）', idx.issues.every(i => i.repo === `org/repo-${i.title.match(/\d+/)[0]}`));
  check('每条都带 lenses 数组（供选题筛选）', idx.issues.every(i => Array.isArray(i.lenses) && i.lenses.includes('AI')));
  check('星数原样保留', idx.issues.every(i => typeof i.stars === 'number' && i.stars >= 10000));
  check('索引不含正文（体积只随期数线性增长）', idx.issues.every(i => !('sections' in i)));

  /* ---------- 回顾页纯逻辑 ---------- */

  // archive.js 复用 favorites.js 的 esc()，按页面的真实加载顺序先喂 favorites.js
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: { addEventListener() {}, createElement() {}, getElementById() { return null; }, body: { appendChild() {} } },
    window: {},
    btoa, atob, console,
    CSS: { escape: s => s },
    CustomEvent: class {},
  };
  const ctx = vm.createContext(sandbox);
  for (const f of ['../web/favorites.js', '../web/archive.js']) {
    vm.runInContext(readFileSync(join(HERE, f), 'utf8'), ctx, { filename: f });
  }
  vm.runInContext(`;globalThis.__arc = {
    filterIssues, collectLenses, groupByMonth, issueHaystack, starsText, arcItemHtml, arcGroupsHtml,
  };`, ctx);
  const arc = sandbox.__arc;
  const issues = idx.issues;

  check('无搜索无筛选时全量返回', arc.filterIssues(issues, '', '').length === 45);
  check('关键词命中唯一一期', arc.filterIssues(issues, 'unique-token-7', '').length === 1);
  check('搜索面包含仓库名', arc.filterIssues(issues, 'org/repo-12', '')[0]?.date === dates[12]);
  check('搜索面包含日期', arc.filterIssues(issues, dates[20], '')[0]?.date === dates[20]);
  check('搜索不分大小写', arc.filterIssues(issues, 'UNIQUE-TOKEN-7', '').length === 1);

  // 多词 AND：两个词都命中才算，而不是把整串当子串
  check('多词按 AND（都命中）', arc.filterIssues(issues, 'unique-token-7 AI', '').length === 1);
  check('多词按 AND（一个不命中则为空）', arc.filterIssues(issues, 'unique-token-7 求职', '').length === 0);
  check('前后空格与连续空格被忽略', arc.filterIssues(issues, '  unique-token-7   AI  ', '').length === 1);

  check('选题筛选只留命中该方向的期次', arc.filterIssues(issues, '', '高考/考研').length === 23);
  check('筛选与搜索可叠加', arc.filterIssues(issues, 'unique-token-8', '高考/考研').length === 1);
  check('不存在的方向返回空', arc.filterIssues(issues, '', '健身').length === 0);

  const lenses = arc.collectLenses(issues);
  check('方向按命中期数排序', lenses[0].label === 'AI' && lenses[0].count === 45
    && lenses[1].label === '高考/考研' && lenses[1].count === 23, JSON.stringify(lenses));
  check('空索引的方向列表为空', arc.collectLenses([]).length === 0);

  const groups = arc.groupByMonth(arc.filterIssues(issues, '', ''));
  check('45 期分成 3 个月', groups.length === 3, groups.map(g => g.key).join(','));
  check('月份倒序', groups[0].key === '2026-09' && groups[2].key === '2026-07', groups.map(g => g.key).join(','));
  check('月份标签去掉前导零', groups[2].label === '2026 年 7 月', groups[2].label);
  check('组内期数合计等于总数', groups.reduce((s, g) => s + g.items.length, 0) === 45);
  check('组内仍按日期倒序', groups.every(g =>
    g.items.every((it, i) => i === 0 || g.items[i - 1].date > it.date)));

  // 非法日期会拼进 article.html?d=，必须在漏斗里就丢掉
  const dirty = [...issues, { date: 'bad-date', title: 'x' }, { date: '', title: 'y' }, null];
  check('非法日期与空条目被过滤', arc.filterIssues(dirty, '', '').length === 45);
  check('空索引不报错', arc.filterIssues([], '', '').length === 0 && arc.groupByMonth([]).length === 0);
  check('null 索引不报错', arc.filterIssues(null, '', '').length === 0);

  check('星数格式化', arc.starsText(192212) === '★ 192,212', arc.starsText(192212));
  check('星数缺失时不渲染徽章', arc.starsText('') === '' && arc.starsText(0) === '' && arc.starsText('abc') === '');

  /* ---------- 转义 ---------- */

  const evil = {
    date: '2026-11-11',
    title: '<img src=x onerror=alert(1)>',
    oneLiner: '"><script>alert(2)</script>',
    category: '&<>"\'',
    stars: 100,
    repo: 'org/repo',
    lenses: ['<b>AI</b>'],
  };
  const html = arc.arcItemHtml(evil);
  check('标题被转义', !html.includes('<img src=x') && html.includes('&lt;img'), html.slice(0, 200));
  check('一句话被转义', !html.includes('<script>alert(2)') && html.includes('&lt;script'));
  check('分类与方向被转义', html.includes('&amp;&lt;&gt;&quot;&#39;') && html.includes('&lt;b&gt;AI&lt;/b&gt;'));
  check('日期用 encodeURIComponent 拼进链接', html.includes('article.html?d=2026-11-11'));
  check('分组标题被转义', !arc.arcGroupsHtml([{ key: '2026-11', label: '<script>x</script>', items: [evil] }]).includes('<script>x</script>'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);