// 本机收藏的纯逻辑测试（不联网、不需要后端）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../web/favorites.js', import.meta.url), 'utf8');
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
vm.runInContext(code + `
;globalThis.__api = {
  loadFavorites, saveFavorites, toggleFavorite, has,
  encodeFavorites, decodeFavorites, readOpenDates, rememberOpen,
};`, ctx);
const api = sandbox.__api;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (d ? '  «' + d + '»' : '')); } };

// ---- 空状态 ----
check('初始为空', api.loadFavorites().items.length === 0);

// ---- 增删 ----
let items = api.toggleFavorite('2026-11-04', 'add');
check('添加成功', api.has(items, '2026-11-04') && items.length === 1, JSON.stringify(items));

items = api.toggleFavorite('2026-11-06', 'add');
check('第二条排在前面（倒序）', items[0] === '2026-11-06' && items[1] === '2026-11-04', JSON.stringify(items));

items = api.toggleFavorite('2026-11-04', 'add');
check('重复添加不产生重复项', items.filter(d => d === '2026-11-04').length === 1, JSON.stringify(items));

items = api.toggleFavorite('2026-11-04', 'remove');
check('取消收藏', !api.has(items, '2026-11-04') && items.length === 1, JSON.stringify(items));

// ---- 脏数据容错 ----
store.set('daily10k:favorites', JSON.stringify({ items: ['2026-11-01', 'bad-date', 123, '2026-11-02'] }));
const cleaned = api.loadFavorites();
check('非法日期被过滤', cleaned.items.length === 2 && cleaned.items.includes('2026-11-02'), JSON.stringify(cleaned));

store.set('daily10k:favorites', '{ 坏掉的 json');
check('坏 JSON 按空处理', api.loadFavorites().items.length === 0);

store.delete('daily10k:favorites');

// ---- 短码往返 ----
const sample = ['2026-11-04', '2026-11-06'];
const shortCode = api.encodeFavorites(sample);
check('短码只含 URL 安全字符', /^[A-Za-z0-9_-]+$/.test(shortCode), shortCode);
check('短码可往返', JSON.stringify(api.decodeFavorites(shortCode)) === JSON.stringify(['2026-11-04', '2026-11-06']));

// 短码顺序不影响结果（内部会排序）
const reordered = api.encodeFavorites(['2026-11-06', '2026-11-04']);
check('顺序不同但结果一致', JSON.stringify(api.decodeFavorites(reordered)) === JSON.stringify(api.decodeFavorites(shortCode)));

// ---- 短码容错 ----
const expectThrow = (label, fn, want) => {
  try { fn(); check(label, false, '没有抛错'); }
  catch (e) { check(label, (e.message || '').includes(want), e.message); }
};
expectThrow('空短码报错', () => api.decodeFavorites(''), '空');
expectThrow('乱码报错', () => api.decodeFavorites('这不是短码!!'), '格式不对');
expectThrow('坏 base64 报错', () => api.decodeFavorites('AAAA'), '格式不对');
expectThrow('非 v1 报错', () => api.decodeFavorites(btoa(JSON.stringify({ v: 99, items: ['2026-11-01'] }))), '格式不对');
expectThrow('无有效日期报错', () => api.decodeFavorites(api.encodeFavorites(['x'])), '没有');

// 真实短码粘贴时常带空格/换行
check('容忍空格与换行', api.decodeFavorites('  ' + shortCode + ' \n') === api.decodeFavorites(shortCode) ||
  JSON.stringify(api.decodeFavorites('  ' + shortCode + ' \n')) === JSON.stringify(api.decodeFavorites(shortCode)));

// ---- 展开状态 ----
api.rememberOpen('2026-11-04', true);
api.rememberOpen('2026-11-06', true);
api.rememberOpen('2026-11-04', false);
check('展开状态增删正确', api.readOpenDates().has('2026-11-06') && !api.readOpenDates().has('2026-11-04'));

// ---- 存储里没有密钥类内容 ----
const raw = store.get('daily10k:favorites') || '';
check('存储内容只有日期', !/token|passcode|secret|password/i.test(raw), raw);

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
