#!/usr/bin/env node
/**
 * 万星日报 · 收藏夹写入工具（本机专用）
 * ----------------------------------------------------------
 * 为什么单独一个脚本：GitHub Pages 是纯静态站，浏览器端没有任何
 * 服务器可以代写入库；前端代码里也绝不能放 token。所以「收藏」这个
 * 写动作只能由本机的 git 凭据完成，浏览器只负责跳转到这里。
 *
 * 用法：
 *   node scripts/favorite.mjs add <日期>      # 收藏某一期（全文不足时自动归档）
 *   node scripts/favorite.mjs remove <日期>   # 取消收藏（归档保留，只是不再展示）
 *   node scripts/favorite.mjs list            # 看当前收藏夹
 *   node scripts/favorite.mjs sync            # 只重建索引、清理死链，不改收藏内容
 *
 * 幂等：重复收藏同一天不会产生第二条；取消不存在的收藏也不报错。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'web', 'data');
const POSTS_DIR = join(DATA_DIR, 'posts');
const ARCHIVE_DIR = join(DATA_DIR, 'archive');
const FAVORITES_FILE = join(DATA_DIR, 'favorites.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const log = (...a) => console.log('[收藏]', ...a);

function loadFavorites() {
  if (!existsSync(FAVORITES_FILE)) return { updated: '', items: [] };
  try {
    const data = JSON.parse(readFileSync(FAVORITES_FILE, 'utf8'));
    return { updated: data.updated || '', items: Array.isArray(data.items) ? data.items : [] };
  } catch (e) {
    log(`索引解析失败，按空处理：${e.message}`);
    return { updated: '', items: [] };
  }
}

function saveFavorites(fav) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FAVORITES_FILE, JSON.stringify(fav, null, 2) + '\n');
}

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

// 全文可能在 posts/（当天）或 archive/（往期被收藏过）。
// 两处都没有时返回 null —— 说明这一期从未被生成过，不该写进收藏夹。
function findPost(date) {
  const live = join(POSTS_DIR, `${date}.json`);
  if (existsSync(live)) return live;
  const archived = join(ARCHIVE_DIR, `${date}.json`);
  if (existsSync(archived)) return archived;
  return null;
}

function add(date) {
  if (!DATE_RE.test(date)) {
    console.error('日期格式应为 YYYY-MM-DD，例如 2026-11-06');
    process.exit(2);
  }
  const src = findPost(date);
  if (!src) {
    console.error(`找不到 ${date} 这一期的全文（posts/ 与 archive/ 都没有）。`);
    console.error('只有站点上真实存在过的期次才能收藏。');
    process.exit(1);
  }

  // 收藏即归档：把全文复制进 archive/，从此不再被「当天清」删掉
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  if (!existsSync(join(ARCHIVE_DIR, `${date}.json`))) {
    copyFileSync(src, join(ARCHIVE_DIR, `${date}.json`));
  }
  // 同时放回 posts/，保证 article.html?d=<日期> 现在就能打开
  mkdirSync(POSTS_DIR, { recursive: true });
  if (!existsSync(join(POSTS_DIR, `${date}.json`))) {
    copyFileSync(src, join(POSTS_DIR, `${date}.json`));
  }

  const post = JSON.parse(readFileSync(join(POSTS_DIR, `${date}.json`), 'utf8'));
  const fav = loadFavorites();
  if (fav.items.some(it => it.date === date)) {
    log(`${date} 已经在收藏夹里了，无需重复收藏`);
    return;
  }
  fav.items.push({
    date,
    title: post.title || '',
    oneLiner: post.oneLiner || '',
    category: post.category || '',
    stars: post.meta?.stars ?? '',
    savedAt: new Date().toISOString(),
  });
  fav.updated = today();
  saveFavorites(fav);
  log(`已收藏 ${date}《${post.title}》`);
  log(`全文已归档到 web/data/archive/${date}.json，不会被每日清理删掉`);
  log('下一步：git add web/data && git commit && git push，Pages 会自动发布');
}

function remove(date) {
  if (!DATE_RE.test(date)) {
    console.error('日期格式应为 YYYY-MM-DD');
    process.exit(2);
  }
  const fav = loadFavorites();
  const before = fav.items.length;
  fav.items = fav.items.filter(it => it.date !== date);
  if (fav.items.length === before) {
    log(`收藏夹里没有 ${date}，无需操作`);
    return;
  }
  fav.updated = today();
  saveFavorites(fav);
  log(`已取消收藏 ${date}`);
  log('归档全文保留在 web/data/archive/，不会自动删除（避免误删后无法恢复）');
}

function sync() {
  const fav = loadFavorites();
  // posts/ 是当天池，每天会被清；archive/ 才是收藏期次的真正归属。
  // 只按 posts/ 判断会把「仅存在于归档里」的有效收藏全部误删。
  const live = new Set([
    ...(existsSync(POSTS_DIR) ? readdirSync(POSTS_DIR).filter(f => f.endsWith('.json')) : []),
    ...(existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')) : []),
  ]);
  const kept = fav.items.filter(it => live.has(`${it.date}.json`));
  const dropped = fav.items.length - kept.length;
  if (dropped) log(`清理 ${dropped} 条死链收藏（posts/ 与 archive/ 都没有全文）`);
  saveFavorites({ updated: today(), items: kept });
  log(`收藏夹现有 ${kept.length} 条`);
}

function list() {
  const fav = loadFavorites();
  if (!fav.items.length) {
    log('收藏夹是空的');
    return;
  }
  log(`共 ${fav.items.length} 条（更新于 ${fav.updated || '未知'}）`);
  for (const it of fav.items.slice().sort((a, b) => b.date.localeCompare(a.date))) {
    console.log(`  ${it.date}  ★${it.stars || '-'}  ${it.title}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'add': add(arg); break;
  case 'remove': remove(arg); break;
  case 'list': list(); break;
  case 'sync': sync(); break;
  default:
    console.log('用法：node scripts/favorite.mjs <add|remove|list|sync> [YYYY-MM-DD]');
    process.exit(2);
}
