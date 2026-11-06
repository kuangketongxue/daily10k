#!/usr/bin/env node
/**
 * 万星日报 · 每日生成管线
 * 1. 运行时现场抓取 GitHub Trending（日榜 + 周榜）作为热度榜，逐个用 REST 复核
 *    （排除写过的、归档/派生、清单资料类、星数不足万星的），按「日均新增星数」取榜首为当日核心
 * 2. Trending 抓取失败或榜内无可写项目时，退到 Search API 实时查「近半年新晋的万星项目」
 * 3. 抓仓库事实（星数/issue/release/许可证/热度）与 README，再找 1-4 个真正同类的替代项目
 * 4. 调用 LLM 按固定 8 栏写正式深读稿，并逐个 HEAD 校验稿中链接，坏链降级为纯文本
 * 5. 输出 web/data/posts/<日期>.json 并重建 index.json（只保留当天）
 *
 * 零依赖，Node 18+。配置在 scripts/config.json，密钥可用环境变量覆盖：
 *   AI_API_KEY / AI_BASE_URL / AI_MODEL / GITHUB_TOKEN
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'web', 'data');
const POSTS_DIR = join(DATA_DIR, 'posts');
// 归档目录：被收藏的期次全文永久保留在这里，不随「当天清」规则删除。
// 收藏夹页面点开某条时读的就是这份归档，所以收藏过的文章永远能看全文。
const ARCHIVE_DIR = join(DATA_DIR, 'archive');
const FAVORITES_FILE = join(DATA_DIR, 'favorites.json');
const HISTORY_FILE = join(ROOT, 'scripts', 'history.json');
const CONFIG_FILE = join(ROOT, 'scripts', 'config.json');

const cfg = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
const AI_KEY = process.env.AI_API_KEY || cfg.apiKey;
const AI_BASE = (process.env.AI_BASE_URL || cfg.baseUrl || '').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || cfg.model;
const GH_TOKEN = process.env.GITHUB_TOKEN || cfg.githubToken || '';
const DRY_RUN = /^(1|true)$/i.test(String(process.env.DRY_RUN || ''));
if (!AI_KEY || !AI_BASE || !AI_MODEL) {
  console.error('缺少 AI 配置（config.json 或 AI_API_KEY/AI_BASE_URL/AI_MODEL）');
  process.exit(1);
}

const log = (...a) => console.log('[万星日报]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

async function gh(path, raw = false, attempt = 1) {
  const res = await fetch('https://api.github.com' + path, {
    headers: {
      'User-Agent': 'daily10k',
      'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 403/429 多为限流，5xx 为瞬时故障，都值得再试
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < 3) {
      log(`GitHub ${res.status}，${attempt * 2}s 后重试：${path}`);
      await sleep(attempt * 2000);
      return gh(path, raw, attempt + 1);
    }
    throw new Error(`GitHub ${res.status}: ${path} ${body}`);
  }
  return raw ? res.text() : res.json();
}

// 热度真源：GitHub Trending 是「此刻」的热门榜，每次运行现场抓取，日榜/周榜都抓
const TRENDING_WINDOWS = [
  { since: 'daily', label: '日榜', unit: '今日', perDay: 1 },
  { since: 'weekly', label: '周榜', unit: '本周', perDay: 7 },
];
const MIN_STARS = 10000; // 万星日报的门槛

// ── 生产可用度判据 ────────────────────────────────────────────────
// 这两年的新坑：一批「某个 AI 编程工具的配置包」（代理集合、提示词库、技能包、钩子）
// 会以极快的速度冲上趋势榜，但仓库里没有软件——几百 KB 的 Shell 和 Markdown，
// 装不了、调不到接口、也没有构建产物，谈不上生产价值。光靠星数、语言名、
// 现有的"清单类"正则都挡不住，必须看仓库里到底有没有可分发的软件形态。
const MANIFESTS = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'Gemfile', 'CMakeLists.txt', 'meson.build', 'Package.swift',
  'deno.json', 'deno.jsonc', 'vcpkg.json', 'conanfile.py', 'mix.exs', 'pubspec.yaml',
]);

// 以这些「语言」为主的仓库，多半是配置与脚本集合，而不是可分发软件
const SCRIPT_LANGS = new Set(['Shell', 'Markdown', 'YAML', 'Dockerfile', 'Batchfile', 'Roff', 'TeX']);


// 选题偏好：优先推荐对高考/考研、求职、创业、AI、投资、健身真正有用的项目。
// 只做排序权重不做硬过滤——热度榜全是无关项目时也要能出稿。
const TOPIC_LENSES = [
  { label: '高考/考研', re: /exam|study|learn|edu|quiz|flashcard|anki|math|memoriz|刷题|错题|题库|复习|考试|考研|高考|学习|笔记|背诵|单词|口语|阅读|sat\b|gre\b|toefl|ielts|物理|化学|生物/i },
  { label: '求职', re: /resume|curriculum|job|hiring|recruit|interview|career|portfolio|applicant|ats\b|求职|招聘|面试|简历|内推|岗位|校招|秋招|春招/i },
  { label: '创业', re: /startup|saas|indie|business|freelance|landing|launch|monetiz|stripe|ecommerce|shopify|no-code|solo|创业|独立开发|副业|获客|变现|开店|接单/i },
  { label: 'AI', re: /\bai\b|llm|agent|mcp\b|rag\b|diffusion|transformer|neural|gpt|claude|gemini|copilot|machine learning|deep learning|prompt|inference|fine-?tun|embedding|agentic/i },
  { label: '投资', re: /trad(e|ing)|stock|equit|quant|finance|invest|crypto|bitcoin|backtest|期权|量化|股票|基金|投资|理财|行情|财报|交易/i },
  { label: '健身', re: /fitness|workout|gym\b|running|nutrition|diet|calorie|health|sleep|yoga|strength|weight|健身|训练|跑步|增肌|减脂|饮食|热量|睡眠|瑜伽|健康/i },
];

export function topicLenses(r) {
  const text = `${r.name} ${r.description || ''} ${(r.topics || []).join(' ')}`;
  return TOPIC_LENSES.filter(l => l.re.test(text)).map(l => l.label);
}

async function httpText(url, attempt = 1) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; daily10k)', 'Accept': 'text/html' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(attempt * 2000);
      return httpText(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return res.text();
}

export function parseTrending(html) {
  const rows = [];
  for (const block of html.split(/<article class="Box-row">/).slice(1)) {
    const name = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"?#]+)"/);
    if (!name) continue;
    const gained = block.match(/([\d,]+)\s+stars?\s+(?:today|this week|this month)/);
    rows.push({
      fullName: name[1].trim(),
      gained: Number((gained?.[1] || '0').replace(/,/g, '')),
    });
  }
  return rows;
}

async function scrapeTrending() {
  const out = [];
  for (const w of TRENDING_WINDOWS) {
    try {
      const rows = parseTrending(await httpText(`https://github.com/trending?since=${w.since}`));
      if (!rows.length) throw new Error('页面结构变了，解析到 0 条');
      log(`现场抓取 Trending ${w.label}：${rows.length} 个，榜首 ${rows[0].fullName} ${w.unit}+${rows[0].gained} 星`);
      rows.forEach((r, i) => {
        if (out.some(x => x.fullName === r.fullName)) return;
        out.push({ ...r, ...w, rank: i + 1, perDay: Math.round((r.gained / w.perDay) * 10) / 10 });
      });
    } catch (e) {
      log(`Trending ${w.label} 抓取失败：${e.message}`);
    }
  }
  return out;
}

// 跳过硬凑星数的清单/资料书类仓库，优先有编程语言的真项目。
// 不把 interview 当清单标志：求职是本站的选题方向，面试/简历工具是真项目
const LISTISH = /awesome|curated|\blists? of\b|roadmap|tutorial|handbook|ebook|cheat ?sheet|\bbook\b|指南|教程|笔记|电子书|清单|资料/i;
const LIST_TOPICS = new Set([
  'awesome', 'awesome-list', 'curated-list', 'list', 'lists', 'resources',
  'tutorial', 'tutorials', 'tutorial-code', 'tutorial-exercises',
  'roadmap', 'interview-questions', 'cheat-sheet', 'cheatsheet',
  'books', 'book', 'ebook', 'free-programming-books',
]);
const isListRepo = (r) =>
  !r.language ||
  r.language === 'Markdown' ||
  (r.topics || []).some(t => LIST_TOPICS.has(t)) ||
  LISTISH.test(`${r.name} ${r.description || ''}`);

// 深度体检：语言构成 + 根目录清单。两次 API，只对排名靠前的候选做
export async function inspectRepo(fullName) {
  const [langs, root] = await Promise.all([
    gh(`/repos/${fullName}/languages`).catch(() => ({})),
    gh(`/repos/${fullName}/contents/`).catch(() => []),
  ]);
  const entries = Object.entries(langs || {}).sort((a, b) => b[1] - a[1]);
  const codeBytes = entries.reduce((sum, [, v]) => sum + v, 0);
  const topLang = entries.length ? entries[0][0] : '';
  const topShare = codeBytes ? entries[0][1] / codeBytes : 0;
  const names = Array.isArray(root) ? root.map(x => x.name) : [];
  return {
    codeBytes,
    topLang,
    topShare,
    manifest: names.find(n => MANIFESTS.has(n)) || '',
    hasCI: names.includes('.github'),
  };
}

// 生产可用度系数：>1 更像能落地的东西，<1 更像围观型配置包
export function productionFactor(info) {
  let f = 1;
  const notes = [];

  if (info.manifest) {
    f *= 1.35;
    notes.push(`有构建清单 ${info.manifest}`);
  } else {
    f *= 0.85;
    notes.push('无构建清单');
  }

  if (SCRIPT_LANGS.has(info.topLang) && info.topShare > 0.85) {
    // 脚本语言主导：有构建清单的（如 nvm）还能算可安装的 CLI 工具，
    // 没有清单的基本就是给别人用的配置/提示词集合，重罚
    if (info.manifest) {
      f *= 0.55;
      notes.push(`${info.topLang} 主导但可安装`);
    } else {
      f *= 0.2;
      notes.push(`${info.topLang} 占 ${Math.round(info.topShare * 100)}%`);
    }
  }

  if (info.codeBytes >= 2 * 1024 * 1024) {
    f *= 1.15;
    notes.push(`代码 ${Math.round(info.codeBytes / 1024)}KB`);
  } else if (info.codeBytes < 300 * 1024) {
    f *= 0.7;
    notes.push(`代码仅 ${Math.round(info.codeBytes / 1024)}KB`);
  }

  if (info.hasCI) f *= 1.08;

  return { factor: f, notes };
}

// 圈内口碑：近 120 天 Hacker News 上的讨论热度。
// GitHub 星数能被话题带起来，HN 的 points 是工程师一个个投出来的，
// 作为「真有同行在乎」的旁证。命中就加分，不命中不扣分（HN 覆盖面有限）。
async function hnBuzz(fullName) {
  const since = Math.floor((Date.now() - 120 * 864e5) / 1000);
  const q = encodeURIComponent(fullName.split('/').pop());
  const url = `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=30`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { points: 0, stories: 0 };
    const data = await res.json();
    const want = fullName.toLowerCase();
    const hits = (data.hits || []).filter(h =>
      `${h.url || ''} ${h.title || ''}`.toLowerCase().includes(want));
    return {
      points: hits.reduce((s, h) => s + (h.points || 0), 0),
      stories: hits.length,
    };
  } catch {
    return { points: 0, stories: 0 };
  }
}

// 圈内风向：用 Exa 搜「最近被公开推荐的开源项目」，从文章正文里捞出被点名的仓库。
// GitHub 星数能被话题带起来，但「有作者专门写一篇推荐文」难得多。
// 只在有 EXA_API_KEY 时启用，没有就静默跳过，不影响出稿。
const EXA_ENDPOINT = 'https://api.exa.ai/search';

async function exaSearch(query, key, includeDomains) {
  const res = await fetch(EXA_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: 10,
      startPublishedDate: new Date(Date.now() - 14 * 864e5).toISOString(),
      ...(includeDomains ? { includeDomains } : {}),
      contents: { text: { maxCharacters: 3000 } },
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

// 只认这些来源：真人写的技术社区与工程博客。
// 不加域名限定会搜回来大量 finds.dev / feed7.dev 这类「机器抓取仓库自动生成的 SEO 页」，
// 它们会把垃圾项目顶得比真项目还高（实测过，信号是反的）。
const BUZZ_DOMAINS = [
  'dev.to', 'news.ycombinator.com', 'lobste.rs', 'github.blog',
  'simonwillison.net', 'medium.com', 'hashnode.dev', 'substack.com',
];

let WEB_BUZZ = null;
async function webBuzz() {
  if (WEB_BUZZ) return WEB_BUZZ;
  const key = process.env.EXA_API_KEY;
  if (!key) {
    WEB_BUZZ = new Map();
    return WEB_BUZZ;
  }
  const queries = [
    'open source project worth using recommended',
    'open source tools I actually use in production',
  ];
  const mentions = new Map();
  for (const q of queries) {
    try {
      const results = await exaSearch(q, key, BUZZ_DOMAINS);
      for (const r of results) {
        const blob = `${r.title || ''} ${r.url || ''} ${r.text || ''}`;
        for (const m of blob.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
          if (/^(topics|search|features|about|pricing|login|orgs|sponsors|trending|collections|apps)$/i.test(m[1])) continue;
          const full = `${m[1]}/${m[2].replace(/\.git$/, '')}`.toLowerCase();
          mentions.set(full, (mentions.get(full) || 0) + 1);
        }
      }
    } catch (e) {
      log(`Exa 搜索失败（不影响出稿）：${e.message}`);
    }
  }
  log(`圈内风向：从 ${queries.length} 组推荐文里捞到 ${mentions.size} 个被点名的仓库`);
  WEB_BUZZ = mentions;
  return mentions;
}

// 给候选算最终分：热度 × 选题加成 × 生产可用度 × 圈内口碑
export async function rankCandidates(pool, heatScore) {
  const ranked = pool.map(c => ({ ...c, base: heatScore(c) }));
  ranked.sort((a, b) => b.base - a.base);

  const buzzMap = await webBuzz();

  // 只体检热度前 10：既够覆盖"当天可能出线的种子"，又不至于把 API 额度烧光
  const shortlist = ranked.slice(0, 10);
  for (const c of shortlist) {
    const info = await inspectRepo(c.repo.full_name);
    const { factor, notes } = productionFactor(info);
    c.info = info;
    c.quality = factor;
    c.notes = notes;
    c.buzz = await hnBuzz(c.repo.full_name);
    c.webMentions = buzzMap.get(c.repo.full_name.toLowerCase()) || 0;
  }
  for (const c of shortlist) {
    const boost = c.buzz.points >= 100 ? 1.25
      : c.buzz.points >= 30 ? 1.12
      : c.buzz.points > 0 ? 1.04 : 1;
    // 被推荐文点名比 HN 单帖更有分量：每出现一次 +12%，最多 +36%
    const webBoost = c.webMentions ? Math.min(1 + 0.12 * c.webMentions, 1.36) : 1;
    c.buzzBoost = boost;
    c.webBoost = webBoost;
    c.score = c.base * c.quality * boost * webBoost;
  }
  // 没体检到的深度降级：只有在体检过的候选全被判定为配置包时才轮到它们
  for (const c of ranked.slice(10)) c.score = c.base * 0.15;

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function describe(c) {
  const q = c.quality ? `质量系数 ${c.quality.toFixed(2)}` : '未体检';
  const b = c.buzz && c.buzz.stories ? `，HN ${c.buzz.stories} 帖 ${c.buzz.points} 分` : '，HN 无讨论';
  const w = c.webMentions ? `，推荐文点名 ${c.webMentions} 次` : '';
  const n = c.notes ? `（${c.notes.join('，')}）` : '';
  return `${c.repo.full_name} ★${c.repo.stargazers_count} 日均${c.heat ? c.heat.perDay : '-'} → 综合 ${Math.round(c.score)}｜${q}${n}${b}${w}`;
}


// 替代方案相关性：泛化 topic（ai/mcp/cli/语言）不构成「同类」，具体 topic 才算
const GENERIC_TOPICS = new Set([
  'ai', 'ai-agent', 'ai-agents', 'ai-tools', 'aiagent', 'agent', 'agents', 'agent-skills',
  'agentic-ai', 'autonomous-agents', 'llm', 'mcp', 'mcp-server', 'modelcontextprotocol',
  'model-context-protocol', 'claude', 'claude-code', 'codex', 'cursor', 'cli',
  'developer-tools', 'open-source', 'productivity', 'tools', 'tool', 'framework',
  'typescript', 'javascript', 'python', 'java', 'go', 'rust', 'nodejs', 'node-js',
]);
const AGENT_TOPICS = new Set([
  'mcp', 'mcp-server', 'modelcontextprotocol', 'model-context-protocol', 'llm',
  'ai', 'ai-agent', 'ai-agents', 'aiagent', 'agent', 'agents', 'agent-skills',
  'agentic-ai', 'autonomous-agents', 'claude', 'claude-code', 'codex', 'cursor', 'ai-tools',
]);
const GENERIC_WORDS = new Set([
  'based', 'using', 'built', 'with', 'from', 'that', 'this', 'your', 'into', 'over', 'under',
  'open', 'source', 'project', 'tool', 'tools', 'app', 'apps', 'application', 'applications',
  'framework', 'platform', 'system', 'systems', 'support', 'supports', 'powered', 'local',
  'first', 'fast', 'simple', 'modern', 'anything', 'models', 'model', 'language', 'languages',
  'workspace', 'work', 'team', 'teams', 'manage', 'management', 'create', 'build', 'building',
]);

function keywordsOf(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !GENERIC_WORDS.has(w))
    .map(w => w.replace(/(ing|ed|s)$/, ''));
  return new Set(words);
}

function isAgentish(r) {
  return (r.topics || []).some(t => AGENT_TOPICS.has(t)) ||
    /\bmcp\b|ai-powered|\bagents?\b|\bllm\b/i.test(r.description || '');
}

function relevance(core, r) {
  const coreTopics = new Set(core.topics || []);
  const topics = r.topics || [];
  const specific = topics.filter(t => coreTopics.has(t) && !GENERIC_TOPICS.has(t)).length;
  const generic = topics.filter(t => coreTopics.has(t) && GENERIC_TOPICS.has(t)).length;
  const coreWords = keywordsOf(`${core.name} ${core.description || ''}`);
  const candWords = keywordsOf(`${r.name} ${r.description || ''} ${topics.join(' ')}`);
  const words = [...coreWords].filter(w => candWords.has(w)).length;
  return specific * 3 + generic + words;
}

// 选题偏好优先，其次才是热度；返回 { repo, heat, themes }
async function findCandidate() {
  const history = new Set(existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : []);
  const trend = await scrapeTrending();
  const pool = [];
  let written = 0;
  let small = 0;
  for (const t of trend) {
    if (history.has(t.fullName)) { written++; continue; }
    let repo;
    try {
      repo = await gh(`/repos/${t.fullName}`);
    } catch (e) {
      log(`复核 ${t.fullName} 失败：${e.message}`);
      continue;
    }
    if (repo.archived || repo.fork || repo.disabled) continue;
    if (isListRepo(repo)) continue;
    if (repo.stargazers_count < MIN_STARS) { small++; continue; }
    pool.push({ repo, heat: t, themes: topicLenses(repo) });
  }
  if (pool.length) {
    // 先按热度排（日均新增星数 × 每命中一类选题 +50%），
    // 再对热门前 8 做深度体检与圈内口碑加权——热度只决定谁进决赛，不再决定谁当选
    const heatScore = (c) => c.heat.perDay * (1 + 0.5 * c.themes.length);
    const hottest = Math.max(...pool.map(c => c.heat.perDay));
    const preferred = pool.filter(c => c.themes.length && c.heat.perDay >= hottest * 0.25);
    const source = preferred.length ? preferred : pool;
    const ranked = await rankCandidates(source, heatScore);
    const pick = ranked[0];
    log(`热度榜 ${trend.length} 个，可写 ${pool.length} 个（已写过 ${written}，不足万星 ${small}）`);
    log('候选体检：\n  ' + ranked.slice(0, 5).map(describe).join('\n  '));
    log(`当日核心：${describe(pick)}`);
    return pick;
  }
  return findRisingFallback(history);
}

// 热度榜抓取失败/全被写过时的兜底：现场查「近半年新晋的万星项目」，仍是运行时数据
async function findRisingFallback(history) {
  log('热度榜没有可写项目，退到 Search API 实时查近半年新晋万星项目…');
  const since = new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10);
  const q = `created:>=${since} stars:>=${MIN_STARS} archived:false fork:false`;
  const items = [];
  for (let page = 1; page <= 3; page++) {
    const data = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`);
    items.push(...(data.items || []));
    if ((data.items || []).length < 100) break;
  }
  const pool = items
    .filter(r => !history.has(r.full_name) && !r.archived && !r.fork && !r.disabled && !isListRepo(r) && r.stargazers_count >= MIN_STARS)
    .map(repo => ({ repo, heat: null, themes: topicLenses(repo) }));
  if (!pool.length) throw new Error(`近半年新晋的万星项目也已写完（${items.length} 个候选），没有可写的项目了`);
  // 兜底路径同样过一遍生产可用度体检，避免退而求其次时又挑到配置包
  const ranked = await rankCandidates(pool, c => c.themes.length * 1e9 + c.repo.stargazers_count);
  const pick = ranked[0];
  log(`兜底榜 ${items.length} 个，可写 ${pool.length} 个`);
  log('候选体检：\n  ' + ranked.slice(0, 5).map(describe).join('\n  '));
  log(`当日核心：${describe(pick)}`);
  return pick;
}

async function fetchReadme(fullName) {
  try {
    return (await gh(`/repos/${fullName}/readme`, true)).slice(0, 12000);
  } catch {
    return '';
  }
}

async function fetchLatestRelease(fullName) {
  try {
    const r = await gh(`/repos/${fullName}/releases/latest`);
    return { tag: r.tag_name, date: (r.published_at || '').slice(0, 10) };
  } catch {
    return null;
  }
}

async function searchRepos(q) {
  const data = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100`);
  return data.items || [];
}

async function findAlternatives(repo) {
  const specificTopics = (repo.topics || []).filter(t => !GENERIC_TOPICS.has(t)).slice(0, 3);
  const keywords = [...keywordsOf(repo.description || '')].slice(0, 2);
  const wantsAgent = isAgentish(repo);
  const queries = [
    ...specificTopics.map(t => `topic:${t} archived:false fork:false stars:>500`),
    ...(keywords.length === 2 ? [`${keywords.join(' ')} in:name,description archived:false fork:false stars:>500`] : []),
  ];

  const seen = new Set([repo.full_name]);
  const picks = [];
  for (const q of queries) {
    try {
      for (const r of await searchRepos(q)) {
        if (seen.has(r.full_name) || r.archived || r.fork || r.disabled) continue;
        // 同名仓库基本都是转存/复制品，不能算「替代方案」
        if (isListRepo(r) || r.name.toLowerCase() === repo.name.toLowerCase()) continue;
        // 核心项目是 MCP/agent 工具时，候选也必须具备同类交付方式
        if (wantsAgent && !isAgentish(r)) continue;
        const score = relevance(repo, r);
        if (score < 3) continue;
        seen.add(r.full_name);
        picks.push({
          repo: r.full_name,
          stars: r.stargazers_count,
          license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : '未声明',
          language: r.language || '多语言',
          pushed: (r.pushed_at || '').slice(0, 10),
          description: r.description || '',
          score,
        });
      }
    } catch { /* 单个查询失败不影响整体 */ }
  }
  picks.sort((a, b) => b.score - a.score || b.stars - a.stars);
  return picks.slice(0, 4).map(({ score, ...rest }) => rest);
}

const SYSTEM_PROMPT = `你是《万星日报》的主笔，一名严谨的中文科技分析师。读者是开发者与技术决策者。文章风格：正式、专业、克制——用事实和数字说话，给出可执行的判断，不做营销式吹捧。禁止使用"赋能""颠覆""革命性"这类词。

输出要求：只输出一个 JSON 对象（不要 markdown 代码围栏、不要多余文字）。

block 类型：
{ "type": "p", "text": "段落，可用 **加粗** 和 \`行内代码\`" }
{ "type": "sub", "text": "小标题" }
{ "type": "kv", "k": "你给它：", "v": "……" }
{ "type": "code", "code": "命令或示例", "caption": "来源：README 某节" }
{ "type": "list", "items": ["……"] }
{ "type": "quote", "text": "引自 README 的原话" }

写作规范（所有批次通用）：
- 段落短，每段 1-3 句；信息密度优先，不写口水话。
- 所有数字（星数、issue 数、版本号、日期）只能使用我提供的事实，不得推测或编造；缺失就写"官方未披露"。
- 链接只能使用我提供的 URL 或 README 中明确出现的 URL。
- code 块里的命令与输出必须来自 README，并标注来源。`;

const HEADINGS = [
  '它解决什么问题', '能用来干嘛', '它是怎么做的', '怎么上手',
  '局限与风险', '替代方案', '谁该用', '出处与日期',
];
const HEADINGS_A = HEADINGS.slice(0, 4);
const HEADINGS_B = HEADINGS.slice(4);

// 分栏字数底线：prompt 要求 PART_A 1200 字、PART_B 800 字，但模型经常只写到七成。
// 与其在最后整篇作废（实测 2026-11-04 05:30 批次三次都卡在 1547~1586 字），
// 不如在分栏这一层就把实际字数反馈给模型让它扩写，重试成本低得多。
const PART_MIN_CHARS = { A: 1000, B: 650 };

const PART_A = `本次只写文章的前 4 个 section，并给出标题信息。输出 JSON：
{
  "title": "项目名：一句话点睛式标题（如 graphify：让 AI 查图，不再翻文件）",
  "oneLiner": "一句话概括它是什么、给谁用（40-60字，陈述句，不用感叹号）",
  "category": "领域标签，用 · 分隔",
  "sections": [
    { "heading": "1 它解决什么问题", "blocks": [...] },
    { "heading": "2 能用来干嘛", "blocks": [...] },
    { "heading": "3 它是怎么做的", "blocks": [...] },
    { "heading": "4 怎么上手", "blocks": [...] }
  ]
}

各栏要求：
- 1：从具体工作场景切入，说明现状痛点与它带来的改变；引用 README 原话佐证核心主张；至少 3 段。
- 2：写 2-3 个用途，每个用途用 sub 开头，配 kv（你给它/它还你），至少一个 code 块。读者最关心「{选题}」这几类方向，若本项目确实能服务其中某类，就优先写这个方向的用法；不相关就写它最真实的使用场景，不要硬蹭。
- 3：讲清架构与核心机制，可用类比，但必须说明依据（README/架构文档里的模块名、目录结构）。
- 4：真实可跑的安装与最小示例（code 块），2-3 条注意事项用 list。
这 4 栏正文合计不少于 1200 个汉字。`;

const PART_B = `本次只写文章的后 4 个 section。输出 JSON：
{ "sections": [
    { "heading": "5 局限与风险", "blocks": [...] },
    { "heading": "6 替代方案", "blocks": [...] },
    { "heading": "7 谁该用，谁别用", "blocks": [...] },
    { "heading": "8 出处与日期", "blocks": [...] }
] }

各栏要求：
- 5 局限与风险：必须给具体事实——未关闭 Issue 与 PR 数量、最近提交时间、是否开发者预览/频繁破坏性变更、README 里提到的限制或安全要求、是否借开源推广商业产品。每条都写清"所以你要注意什么"。用 list。
- 6 替代方案：先判断每个「替代候选」是否真的解决同一类问题，只把确实同类的写进来（1-2 个），候选多于两个时优先星数更高、最近仍有推送的；用 sub + kv 写清：仓库、星数、许可证、最近更新、适用场景；最后用 p 给出选择判据（"项目是 X 就选 A，需要 Y 就选本项目"）。若没有真正同类的候选：只写一个 p，内容为"按 GitHub 同类搜索暂未找到成熟的同类项目"，并补一句基于本项目的选择判据；绝对不要为了凑栏目把不相关的项目写成替代方案，也不要伪造 kv 字段或编造项目。
- 7 谁该用，谁别用：两个 list，各 2-3 条，判断必须能从前面事实推出，不写万能套话。
- 8 出处与日期：list 列出本次引用的全部来源链接（仓库首页、README、Release、Issues 页面）；最后必须有一个 p，写明"材料截至 {今天日期}。文中命令与输出均取自官方文档和样例，未在本机运行。"
这 4 栏正文合计不少于 800 个汉字。

所有链接必须写成 [标签](URL) 形式，标签用「仓库首页」「README」「Releases 页面」「Issues 页面」「项目主页」这类人类可读名称，不要把 URL 本身当链接文本。`;

function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('回复中没有 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function factsBlock(repo, release, alternatives, heat, themes) {
  const lines = [
    `仓库: ${repo.full_name}（https://github.com/${repo.full_name}）`,
    `描述: ${repo.description || '（无）'}`,
    `星数: ${repo.stargazers_count} / Fork: ${repo.forks_count}`,
    ...(heat ? [`热度: GitHub Trending ${heat.label}第 ${heat.rank} 名，${heat.unit}新增 ${heat.gained} 星（本次生成时现场抓取）`] : []),
    `读者关心的方向: ${themes.length ? themes.join('、') : '无明确命中'}`,
    `未关闭的 Issue 与 PR: ${repo.open_issues_count}`,
    `语言: ${repo.language || '多语言'} / 许可证: ${repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : '未声明'}`,
    `创建: ${repo.created_at?.slice(0, 10)} / 最近推送: ${repo.pushed_at?.slice(0, 10)}`,
    `最新 Release: ${release ? `${release.tag}（${release.date}）` : '无正式 Release'}`,
    `主页: ${repo.homepage || '无'}`,
    `话题: ${(repo.topics || []).join(', ') || '无'}`,
    `Issues 页面: https://github.com/${repo.full_name}/issues`,
    `Releases 页面: https://github.com/${repo.full_name}/releases`,
  ];
  if (alternatives.length) {
    lines.push('', '替代候选（GitHub 搜索同类项目所得，按同类 topic 与关键词筛出；只能从中挑确实同类的 1-2 个，优先星数更高、最近仍有推送的）：');
    for (const a of alternatives) {
      lines.push(`- ${a.repo} ★${a.stars}，${a.license}，${a.language}，最近推送 ${a.pushed}：${a.description}（https://github.com/${a.repo}）`);
    }
  } else {
    lines.push('', '替代候选：无（GitHub 按同类话题搜索未找到成熟项目）');
  }
  return lines.join('\n');
}

async function callLLM(messages) {
  const res = await fetch(AI_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
    // 官方文档：思考模式与 JSON 模式不建议同开；关思考用 reasoning_effort=none
    // （该端点的 thinking 只接受对象形态，字符串 "disabled" 会 400）
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 16384,
      reasoning_effort: 'none',
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`LLM ${res.status}: ${body}`);
    err.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error(`LLM 回复为空（finish_reason=${choice?.finish_reason}）`);
  return extractJson(content);
}

const BLOCK_TYPES = new Set(['p', 'sub', 'kv', 'code', 'list', 'quote']);

function validateBlocks(part) {
  for (const sec of part.sections) {
    if (!Array.isArray(sec.blocks) || !sec.blocks.length) throw new Error(`「${sec.heading}」没有内容`);
    for (const b of sec.blocks) {
      if (!b || !BLOCK_TYPES.has(b.type)) throw new Error(`未知 block 类型：${b && b.type}`);
      if (b.type === 'p' || b.type === 'sub' || b.type === 'quote') {
        if (!String(b.text || '').trim()) throw new Error(`空的 ${b.type} block`);
      } else if (b.type === 'kv') {
        if (!b.k || !b.v) throw new Error('kv block 缺少 k 或 v');
      } else if (b.type === 'code') {
        if (!String(b.code || '').trim()) throw new Error('code block 为空');
      } else if (b.type === 'list') {
        if (!Array.isArray(b.items) || !b.items.length) throw new Error('list block 为空');
      }
    }
  }
}

// 单栏正文字数（只数汉字，与页尾自检口径一致）
function partChars(part) {
  const cjk = (s) => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;
  let n = 0;
  for (const sec of part.sections || []) {
    for (const b of sec.blocks || []) n += cjk(textOf(b));
  }
  return n;
}

async function genPart(partPrompt, expect, facts, readme, themes, minChars) {
  const intro = partPrompt
    .replace('{今天日期}', today())
    .replace('{选题}', themes.length ? themes.join('、') : '通用读者');
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${intro}\n\n项目事实：\n${facts}\n\nREADME（可能截断）：\n${readme || '（未能获取 README，不要编造命令与输出）'}`,
    },
  ];
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const part = await callLLM(messages);
      if (!Array.isArray(part.sections) || part.sections.length < 4) {
        throw new Error(`栏目不足（${part.sections?.length ?? 0}/4）`);
      }
      const badIdx = expect.findIndex((name, idx) => !String(part.sections[idx]?.heading || '').includes(name));
      if (badIdx !== -1) throw new Error(`第 ${badIdx + 1} 栏应为「${expect[badIdx]}」，实得「${part.sections[badIdx]?.heading ?? '空'}」`);
      part.sections = part.sections.slice(0, 4);
      validateBlocks(part);
      const chars = partChars(part);
      if (chars < minChars) throw new Error(`字数不足（${chars}/${minChars}）`);
      return part;
    } catch (e) {
      lastErr = e;
      const wait = Math.max(e.status === 429 ? 15000 : 3000, e.retryAfterMs || 0);
      log(`写稿第 ${attempt} 次失败：${e.message}（${Math.round(wait / 1000)}s 后重试）`);
      // 字数不够时把差距反馈给模型让它扩写，而不是原样重发一遍
      if (/^字数不足/.test(e.message) && attempt < 3) {
        const got = Number(e.message.match(/\d+/)?.[0] || 0);
        messages.push({
          role: 'user',
          content: `你上一稿正文只有 ${got} 个汉字，少于本栏要求的 ${minChars} 字。请扩写：在不编造事实、不新增链接、不重复已写内容的前提下，补充具体场景、机制细节与依据，保持段落短小。只输出同样的 JSON。`,
        });
      }
      await sleep(wait);
    }
  }
  throw lastErr;
}

// 出处栏必须以截至日期收尾；模型漏写时补上，不因一句话整篇失败
function ensureAsOf(post, date) {
  const last = post.sections[post.sections.length - 1];
  if (!last) return;
  if (!Array.isArray(last.blocks)) last.blocks = [];
  if (last.blocks.some(b => /材料截至/.test(textOf(b)))) return;
  last.blocks.push({ type: 'p', text: `材料截至 ${date}。文中命令与输出均取自官方文档和样例，未在本机运行。` });
}

// 模型可能编造链接，或照抄 README 里已失效的主页；出稿前逐个探活，
// 只把「确定不存在」（404/410）的链接降级为纯文本，网络抖动不算坏链。
const URL_RE = /https?:\/\/[^\s<>"'`) \]\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g;

async function linkStatus(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; daily10k)' },
      });
      if (res.status === 405 && method === 'HEAD') continue;
      return res.status;
    } catch {
      if (method === 'HEAD') continue;
      return 0;
    }
  }
  return 0;
}

function textRefs(post) {
  const refs = [];
  for (const sec of post.sections) {
    for (const b of sec.blocks || []) {
      for (const k of ['text', 'v', 'caption']) if (typeof b[k] === 'string') refs.push({ obj: b, key: k });
      if (Array.isArray(b.items)) b.items.forEach((item, i) => { if (typeof item === 'string') refs.push({ obj: b.items, key: i }); });
    }
  }
  return refs;
}

export async function pruneDeadLinks(post) {
  const refs = textRefs(post);
  const urls = new Set();
  for (const { obj, key } of refs) {
    for (const m of String(obj[key]).match(URL_RE) || []) urls.add(m.replace(/[.,;:!?]+$/, ''));
  }
  const dead = new Set();
  await Promise.all([...urls].map(async u => {
    const status = await linkStatus(u);
    if (status === 404 || status === 410) dead.add(u);
  }));
  if (!dead.size) return 0;
  for (const { obj, key } of refs) {
    let s = String(obj[key]);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => (dead.has(url) ? label : m));
    s = s.replace(URL_RE, (m) => {
      const clean = m.replace(/[.,;:!?]+$/, '');
      return dead.has(clean) ? m.slice(clean.length) : m;
    });
    obj[key] = s.replace(/[ \t]{2,}/g, ' ').trim();
  }
  log(`链接探活：移除 ${dead.size} 个失效链接（${[...dead].join('、')}）`);
  return dead.size;
}

async function writeArticle(repo, readme, release, alternatives, heat, themes) {
  const facts = factsBlock(repo, release, alternatives, heat, themes);
  const partA = await genPart(PART_A, HEADINGS_A, facts, readme, themes, PART_MIN_CHARS.A);
  const partB = await genPart(PART_B, HEADINGS_B, facts, readme, themes, PART_MIN_CHARS.B);

  const post = {
    title: partA.title,
    oneLiner: partA.oneLiner,
    category: partA.category,
    sections: [...partA.sections, ...partB.sections],
  };
  if (!post.title || !post.oneLiner || !post.category) throw new Error('标题信息缺失');
  ensureAsOf(post, today());
  await pruneDeadLinks(post);

  const st = computeStats(post);
  // 分栏已在 genPart 内逐栏校验并反馈扩写，这里只留最后一道底线
  if (st.chars < 1500) throw new Error(`正文过短（${st.chars} 字）`);
  return post;
}

function textOf(b) {
  return [b.text, b.v, b.caption, ...(b.items || [])].filter(Boolean).join(' ');
}

// 页尾自检：字数 / 代码块 / 阅读时长，全部由生成结果实测
function computeStats(post) {
  const cjk = (s) => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;
  let chars = 0;
  let codeBlocks = 0;
  for (const sec of post.sections) {
    for (const b of sec.blocks || []) {
      chars += cjk(textOf(b));
      if (b.type === 'code') codeBlocks++;
    }
  }
  const minutes = Math.max(3, Math.round((chars / 400 + codeBlocks * 0.75) * 10) / 10);
  return { chars, codeBlocks, minutes, asOf: today() };
}

function loadAllPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8')));
}

// 读收藏夹索引。文件不存在（还没人收藏过）时返回空列表，不报错。
function loadFavorites() {
  if (!existsSync(FAVORITES_FILE)) return { updated: '', items: [] };
  try {
    const data = JSON.parse(readFileSync(FAVORITES_FILE, 'utf8'));
    return { updated: data.updated || '', items: Array.isArray(data.items) ? data.items : [] };
  } catch (e) {
    log(`收藏索引解析失败，按空处理：${e.message}`);
    return { updated: '', items: [] };
  }
}

// 归档仍被收藏、但全文已经不在 posts/ 里的期次。
// 站点是「当天清」，往期全文会被删；这里从归档目录把它恢复回 posts/，
// 收藏夹里的链接才不会点开是 404。已归档的直接复用，没有归档的只能标记缺失。
function restoreArchivedFavorites(favorites) {
  if (!favorites.items.length) return;
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archived = new Set(readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')));
  const live = new Set(readdirSync(POSTS_DIR).filter(f => f.endsWith('.json')));

  let restored = 0;
  for (const it of favorites.items) {
    const file = `${it.date}.json`;
    if (live.has(file)) continue;              // 还在当天池里，不用管
    if (!archived.has(file)) continue;         // 从没归档过，无从恢复
    copyFileSync(join(ARCHIVE_DIR, file), join(POSTS_DIR, file));
    restored++;
  }
  if (restored) log(`从归档恢复 ${restored} 期被收藏的文章全文`);
}

// 重建收藏索引：丢掉全文已不存在、也没归档的条目（点开必然 404 的死链不留）。
// 判据必须同时看 posts/ 与 archive/ —— 只有归档没有当天副本是完全正常的状态。
function rebuildFavorites(favorites) {
  if (!existsSync(FAVORITES_FILE)) return;
  const live = new Set([
    ...readdirSync(POSTS_DIR).filter(f => f.endsWith('.json')),
    ...(existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')) : []),
  ]);
  const kept = favorites.items.filter(it => live.has(`${it.date}.json`));
  const dropped = favorites.items.length - kept.length;
  if (dropped) log(`清理 ${dropped} 条死链收藏（全文已不存在且无归档）`);
  writeFileSync(FAVORITES_FILE, JSON.stringify({ updated: today(), items: kept }, null, 2) + '\n');
}

// 把仍被收藏的往期全文挪进归档目录，然后才执行「当天清」的删除。
// 顺序不能反：先删后归档会把要保留的全文一起删掉。
function archiveFavorites(date, favorites) {
  if (!favorites.items.length) return;
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const it of favorites.items) {
    if (it.date === date) continue;            // 当天这篇不会被 prune 删，不用归档
    const file = `${it.date}.json`;
    const src = join(POSTS_DIR, file);
    if (existsSync(src)) copyFileSync(src, join(ARCHIVE_DIR, file));
  }
}

function rebuildIndex() {
  // 往期不再删除，索引只列最近 30 期：首页只取第一条，
  // 但留一点历史给「往前翻」用，同时避免 index.json 随天数无限膨胀。
  const posts = loadAllPosts().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  const issues = posts.map(p => ({
    date: p.date,
    title: p.title,
    oneLiner: p.oneLiner,
    category: p.category,
    stars: p.meta?.stars ?? '',
  }));
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'index.json'), JSON.stringify({ updated: today(), issues }, null, 2) + '\n');
}

// 只保留当天一条：删除往期文章 JSON，不做归档
function pruneOldPosts(date) {
  if (!existsSync(POSTS_DIR)) return;
  for (const f of readdirSync(POSTS_DIR)) {
    if (f.endsWith('.json') && f !== `${date}.json`) unlinkSync(join(POSTS_DIR, f));
  }
}

export async function main() {
  const date = today();
  log('开始生成', date, '这一期…');

  // 定时任务在北京时间一天内有多批（16:00~23:30 UTC，见 daily.yml）；
  // 当天已生成时后面的批次直接跳过，手动运行不受影响
  if (!DRY_RUN && process.env.GITHUB_EVENT_NAME === 'schedule' && existsSync(join(POSTS_DIR, `${date}.json`))) {
    log(`今日 ${date} 的日报已存在，跳过本次定时批次`);
    return;
  }

  const { repo, heat, themes } = await findCandidate();
  log(`当日核心项目：${repo.full_name} ★${repo.stargazers_count}`);

  const [readme, release, alternatives] = await Promise.all([
    fetchReadme(repo.full_name),
    fetchLatestRelease(repo.full_name),
    findAlternatives(repo),
  ]);
  log(`README ${readme.length} 字符，Release：${release ? release.tag : '无'}，替代候选 ${alternatives.length} 个，开始写稿…`);

  const article = await writeArticle(repo, readme, release, alternatives, heat, themes);
  const post = {
    date,
    ...article,
    meta: {
      repo: repo.full_name,
      stars: repo.stargazers_count,
      language: repo.language || undefined,
      license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : undefined,
      lastCommit: repo.pushed_at?.slice(0, 10),
      openIssues: repo.open_issues_count,
      version: release ? release.tag : undefined,
      trending: heat ? { window: heat.label, rank: heat.rank, gained: heat.gained, unit: heat.unit } : undefined,
      lenses: themes.length ? themes : undefined,
    },
    stats: computeStats(article),
  };

  if (DRY_RUN) {
    log(`DRY_RUN 校验通过：${post.title}`);
    log(`8 栏：${post.sections.map(s => s.heading).join(' / ')}`);
    log(`核心项目 ${repo.full_name} ★${repo.stargazers_count}${heat ? `（Trending ${heat.label} #${heat.rank}，${heat.unit}+${heat.gained}）` : ''}；` +
      `命中选题 ${themes.join('/') || '无'}；正文 ${post.stats.chars} 字，命令块 ${post.stats.codeBlocks} 个；` +
      `替代候选 ${alternatives.map(a => a.repo).join('、') || '无'}；未写入任何文件。`);
    return;
  }

  mkdirSync(POSTS_DIR, { recursive: true });
  writeFileSync(join(POSTS_DIR, `${date}.json`), JSON.stringify(post, null, 2));

  // 收藏状态已挪到线上后端（Cloudflare KV），生成管线不再知道「谁收藏了哪期」，
  // 所以「按收藏归档 + 当天清」这条路走不通了 —— 一清，收藏夹点开就是 404。
  // 改成永久保留全部往期：单篇约 14KB，一年 5MB 上下，GitHub Pages 完全扛得住。
  // 好处是任何日期的链接永远打得开，也不再依赖「用户先收藏、我们才保留」。
  // （下面的 archiveFavorites / pruneOldPosts / restoreArchivedFavorites /
  //   rebuildFavorites 已停用，函数保留只为兼容历史数据，无人再调用。）
  const history = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : [];
  if (!history.includes(repo.full_name)) history.push(repo.full_name);
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');

  rebuildIndex();
  log(`完成：web/data/posts/${date}.json（正文 ${post.stats.chars} 字，命令块 ${post.stats.codeBlocks} 个，阅读约 ${post.stats.minutes} 分钟）`);
}

const isEntry = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (isEntry) main().catch(e => { console.error(e); process.exit(1); });
