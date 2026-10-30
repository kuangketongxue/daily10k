#!/usr/bin/env node
/**
 * 万星日报 · 每日生成管线
 * 1. GitHub Search API 找「近 N 个月创建、已破万星」的前沿项目，排除写过的
 * 2. 取星数最高的一个作为当日核心，抓仓库事实（星数/issue/release/许可证）与 README
 * 3. 再抓 1-2 个同类替代项目的事实
 * 4. 调用 LLM 按固定 8 栏写正式深读稿
 * 5. 输出 web/data/posts/<date>.json 并重建 index.json（只保留当天）
 *
 * 零依赖，Node 18+。配置在 scripts/config.json，密钥可用环境变量覆盖：
 *   AI_API_KEY / AI_BASE_URL / AI_MODEL / GITHUB_TOKEN
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'web', 'data');
const POSTS_DIR = join(DATA_DIR, 'posts');
const HISTORY_FILE = join(ROOT, 'scripts', 'history.json');
const CONFIG_FILE = join(ROOT, 'scripts', 'config.json');

const cfg = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
const AI_KEY = process.env.AI_API_KEY || cfg.apiKey;
const AI_BASE = (process.env.AI_BASE_URL || cfg.baseUrl || '').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || cfg.model;
const GH_TOKEN = process.env.GITHUB_TOKEN || cfg.githubToken || '';
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

// 星数档位，从高往低扫：上一档全部写完才降档
const STAR_TIERS = [
  { label: '百万星', min: 1000000, max: null },
  { label: '十万星', min: 100000, max: 999999 },
  { label: '万星', min: 10000, max: 99999 },
];

// 档内排序：星数取对数（压住量级差）+ 创建时间新鲜度（一年内线性衰减到 0）
function candidateScore(r) {
  const ageDays = (Date.now() - Date.parse(r.created_at)) / 86400e3;
  const freshness = Math.max(0, Math.min(1, 1 - ageDays / 365));
  return Math.log10(Math.max(1, r.stargazers_count)) + freshness;
}

async function findCandidate() {
  const history = new Set(existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : []);
  // 跳过硬凑星数的清单/资料书类仓库，优先有编程语言的真项目
  const listish = /awesome|curated|\blists? of\b|roadmap|interview|tutorial|handbook|ebook|cheat ?sheet|\bbook\b|指南|教程|笔记|电子书|清单|资料/i;
  const listTopics = new Set([
    'awesome', 'awesome-list', 'curated-list', 'list', 'lists', 'resources',
    'tutorial', 'tutorials', 'tutorial-code', 'tutorial-exercises',
    'roadmap', 'interview', 'interview-questions', 'cheat-sheet', 'cheatsheet',
    'books', 'book', 'ebook', 'free-programming-books',
  ]);
  const isList = (r) =>
    !r.language ||
    r.language === 'Markdown' ||
    (r.topics || []).some(t => listTopics.has(t)) ||
    listish.test(`${r.name} ${r.description || ''}`);

  for (const tier of STAR_TIERS) {
    const q = tier.max ? `stars:${tier.min}..${tier.max}` : `stars:>=${tier.min}`;
    let best = null;
    let bestScore = -Infinity;
    let scanned = 0;
    let written = 0;
    let skippedLists = 0;
    let total = 0;
    // 搜索接口最多返回 1000 条，按星数降序翻到最后一页才能确认这一档已扫完
    for (let page = 1; page <= 10; page++) {
      const data = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`);
      const items = data.items || [];
      total = data.total_count || total;
      scanned += items.length;
      for (const r of items) {
        if (history.has(r.full_name)) { written++; continue; }
        if (isList(r)) { skippedLists++; continue; }
        const score = candidateScore(r);
        if (score > bestScore) { bestScore = score; best = r; }
      }
      if (items.length < 100) break;
    }
    if (best) {
      log(`${tier.label}档命中：${best.full_name} ★${best.stargazers_count}，创建于 ${best.created_at.slice(0, 10)}` +
        `（该档共 ${total} 个，本次扫描 ${scanned}：已写过 ${written}，跳过清单类 ${skippedLists}）`);
      return best;
    }
    const capped = total > scanned ? `，接口上限只覆盖前 ${scanned} 个` : '';
    log(`${tier.label}档无可写项目（共 ${total} 个，扫描 ${scanned}：已写过 ${written}，跳过清单类 ${skippedLists}${capped}），降到下一档`);
  }
  throw new Error('百万/十万/万三个档位都已写完，没有可写的项目了');
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
  const data = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`);
  return data.items || [];
}

async function findAlternatives(repo) {
  const lang = repo.language ? ` language:${repo.language}` : '';
  const topic = (repo.topics || [])[0];
  const queries = [];
  if (topic) queries.push(`topic:${topic}${lang} stars:>500`);
  // 描述关键词兜底：取描述里较长的英文词做 name/description 搜
  const words = (repo.description || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['based', 'using', 'built', 'project', 'open', 'source'].includes(w))
    .slice(0, 3);
  if (words.length) queries.push(`${words.join(' ')} in:name,description stars:>1000`);
  queries.push(`${repo.name} in:name,description stars:>500`);

  const seen = new Set([repo.full_name]);
  const picks = [];
  for (const q of queries) {
    try {
      for (const r of await searchRepos(q)) {
        if (seen.has(r.full_name) || r.archived || r.fork) continue;
        // 同名仓库基本都是转存/复制品，不能算「替代方案」
        if (r.name.toLowerCase() === repo.name.toLowerCase()) continue;
        seen.add(r.full_name);
        picks.push({
          repo: r.full_name,
          stars: r.stargazers_count,
          license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : '未声明',
          language: r.language || '多语言',
          pushed: (r.pushed_at || '').slice(0, 10),
          description: r.description || '',
        });
      }
    } catch { /* 单个查询失败不影响整体 */ }
    if (picks.length >= 2) break;
  }
  return picks.slice(0, 2);
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
- 2：写 2-3 个用途，每个用途用 sub 开头，配 kv（你给它/它还你），至少一个 code 块。
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
- 6 替代方案：先判断每个「替代候选」是否真的解决同一类问题，只把确实同类的写进来（1-2 个），用 sub + kv 写清：仓库、星数、许可证、最近更新、适用场景；最后用 p 给出选择判据（"项目是 X 就选 A，需要 Y 就选本项目"）。若没有真正同类的候选：只写一个 p，内容为"按 GitHub 同类搜索暂未找到成熟的同类项目"，并补一句基于本项目的选择判据；绝对不要为了凑栏目把不相关的项目写成替代方案，也不要伪造 kv 字段或编造项目。
- 7 谁该用，谁别用：两个 list，各 2-3 条，判断必须能从前面事实推出，不写万能套话。
- 8 出处与日期：list 列出本次引用的全部来源链接（仓库首页、README、Release、Issues 页面）；最后必须有一个 p，写明"材料截至 {今天日期}。文中命令与输出均取自官方文档和样例，未在本机运行。"
这 4 栏正文合计不少于 800 个汉字。`;

function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('回复中没有 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function factsBlock(repo, release, alternatives) {
  const lines = [
    `仓库: ${repo.full_name}（https://github.com/${repo.full_name}）`,
    `描述: ${repo.description || '（无）'}`,
    `星数: ${repo.stargazers_count} / Fork: ${repo.forks_count}`,
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
    lines.push('', '替代候选（GitHub 搜索同类项目所得，事实如下）：');
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
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error(`LLM 回复为空（finish_reason=${choice?.finish_reason}）`);
  return extractJson(content);
}

async function genPart(partPrompt, expect, facts, readme) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${partPrompt.replace('{今天日期}', today())}\n\n项目事实：\n${facts}\n\nREADME（可能截断）：\n${readme || '（未能获取 README，不要编造命令与输出）'}`,
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
      return part;
    } catch (e) {
      lastErr = e;
      log(`写稿第 ${attempt} 次失败：${e.message}`);
      await sleep(3000);
    }
  }
  throw lastErr;
}

async function writeArticle(repo, readme, release, alternatives) {
  const facts = factsBlock(repo, release, alternatives);
  const partA = await genPart(PART_A, HEADINGS_A, facts, readme);
  const partB = await genPart(PART_B, HEADINGS_B, facts, readme);

  const post = {
    title: partA.title,
    oneLiner: partA.oneLiner,
    category: partA.category,
    sections: [...partA.sections, ...partB.sections],
  };
  if (!post.title || !post.oneLiner || !post.category) throw new Error('标题信息缺失');

  const st = computeStats(post);
  if (st.chars < 1600) throw new Error(`正文过短（${st.chars} 字）`);
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

function rebuildIndex() {
  const posts = loadAllPosts().sort((a, b) => b.date.localeCompare(a.date));
  const issues = posts.map(p => ({
    date: p.date,
    title: p.title,
    oneLiner: p.oneLiner,
    category: p.category,
    stars: p.meta?.stars ?? '',
  }));
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'index.json'), JSON.stringify({ updated: today(), issues }, null, 2));
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

  const repo = await findCandidate();
  log(`当日核心项目：${repo.full_name} ★${repo.stargazers_count}`);

  const [readme, release, alternatives] = await Promise.all([
    fetchReadme(repo.full_name),
    fetchLatestRelease(repo.full_name),
    findAlternatives(repo),
  ]);
  log(`README ${readme.length} 字符，Release：${release ? release.tag : '无'}，替代候选 ${alternatives.length} 个，开始写稿…`);

  const article = await writeArticle(repo, readme, release, alternatives);
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
    },
    stats: computeStats(article),
  };

  mkdirSync(POSTS_DIR, { recursive: true });
  writeFileSync(join(POSTS_DIR, `${date}.json`), JSON.stringify(post, null, 2));
  pruneOldPosts(date);

  const history = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : [];
  if (!history.includes(repo.full_name)) history.push(repo.full_name);
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  rebuildIndex();
  log(`完成：web/data/posts/${date}.json（正文 ${post.stats.chars} 字，命令块 ${post.stats.codeBlocks} 个，阅读约 ${post.stats.minutes} 分钟）`);
}

const isEntry = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (isEntry) main().catch(e => { console.error(e); process.exit(1); });
