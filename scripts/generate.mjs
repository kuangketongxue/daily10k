#!/usr/bin/env node
/**
 * 万星日报 · 每日生成管线
 * 1. GitHub Search API 找「近 N 个月创建、已破万星」的前沿项目
 * 2. 排除已写过的，取星数最高的一个作为当日核心
 * 3. 拉 README，调用 LLM 按固定栏目写中文深读稿
 * 4. 输出 web/data/posts/<date>.json 并重建 index.json
 *
 * 零依赖，Node 18+。配置在 scripts/config.json，密钥可用环境变量覆盖：
 *   AI_API_KEY / AI_BASE_URL / AI_MODEL / GITHUB_TOKEN
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function gh(path) {
  const res = await fetch('https://api.github.com' + path, {
    headers: {
      'User-Agent': 'daily10k',
      'Accept': 'application/vnd.github+json',
      ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${path} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function findCandidate(days = 180, minStars = 10000) {
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const q = `created:>${since} stars:>${minStars}`;
  const data = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`);
  const history = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : [];
  const items = (data.items || []).filter(r => !history.includes(r.full_name));
  if (!items.length) throw new Error(`近 ${days} 天没有新的万星项目（或都已写过）`);
  return items[0];
}

async function fetchReadme(fullName) {
  const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
    headers: {
      'User-Agent': 'daily10k',
      'Accept': 'application/vnd.github.raw+json',
      ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
    },
  });
  if (!res.ok) return '';
  const text = await res.text();
  return text.slice(0, 9000);
}

const SYSTEM_PROMPT = `你是一位顶级中文科技专栏作者，为「万星日报」写每日一篇的 GitHub 万星开源项目深读稿。文风参照高质量中文科技日报：克制、具体、不堆形容词、不喊口号、每个论断都有依据（来自 README 或仓库事实）。

输出要求：只输出一个 JSON 对象（不要 markdown 代码围栏、不要多余文字），结构如下：
{
  "title": "项目名：一句话点睛式标题（如 graphify：让 AI 查图，不再翻文件）",
  "oneLiner": "一句话概括这个项目是什么、给谁用（40-60字）",
  "category": "领域标签，用 · 分隔，如 AI · 效能 · 阅读",
  "readMinutes": 数字（预计阅读分钟数 5-12）,
  "sections": [
    {
      "heading": "1 它解决什么问题",
      "blocks": [
        { "type": "p", "text": "段落，可用 **加粗** 和 \`行内代码\`" },
        { "type": "sub", "text": "小标题，如 用途一 · AI：读懂一个陌生的开源项目" },
        { "type": "kv", "k": "你给它：", "v": "……" },
        { "type": "code", "code": "安装/使用示例", "caption": "官方 README 的真实输出或命令" },
        { "type": "list", "items": ["……"] },
        { "type": "quote", "text": "引自 README 的原话" }
      ]
    }
  ]
}

固定写 4 个 section，标题必须是：
1 它解决什么问题
2 能用来干嘛
3 它是怎么做的
4 怎么上手

写作规范：
- 第 1 节：从一个具体使用场景切入（如"你接手一个上万行的项目，问 AI……"），解释现状的痛和它带来的改变。
- 第 2 节：写 2-3 个用途，每个用途用 sub + 两个 kv（你给它 / 它还你）展开，尽量用 README 里的真实命令、真实输出做 code 块。
- 第 3 节：讲清核心原理/架构，用类比但不过度简化。
- 第 4 节：给出真实可跑的安装命令和最小上手示例（code 块），以及 2-3 条注意事项（list）。
- 数字要真实：星数、语言、许可证等用我提供的事实，不要编造。
- 段落短，多用具体名词，少用"赋能""颠覆"这类词。`;

function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('回复中没有 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function writeArticle(repo, readme) {
  const facts = [
    `仓库: ${repo.full_name}`,
    `描述: ${repo.description || '（无）'}`,
    `星数: ${repo.stargazers_count}`,
    `语言: ${repo.language || '多语言'}`,
    `许可证: ${repo.license?.spdx_id || '未声明'}`,
    `创建时间: ${repo.created_at?.slice(0, 10)}`,
    `最近推送: ${repo.pushed_at?.slice(0, 10)}`,
    `主页: ${repo.homepage || '无'}`,
    `话题: ${(repo.topics || []).join(', ')}`,
  ].join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `今日核心项目的事实信息：\n${facts}\n\nREADME 内容（可能截断）：\n${readme || '（未能获取 README，请基于事实信息谨慎写作，不要编造命令）'}` },
  ];

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(AI_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
        body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.6, max_tokens: 6000 }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text().catch(() => '')}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM 回复为空');
      const post = extractJson(content);
      for (const k of ['title', 'oneLiner', 'category', 'sections']) {
        if (!post[k]) throw new Error(`缺少字段 ${k}`);
      }
      return post;
    } catch (e) {
      lastErr = e;
      log(`写稿第 ${attempt} 次失败：${e.message}`);
      await sleep(3000);
    }
  }
  throw lastErr;
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
  writeFileSync(join(DATA_DIR, 'index.json'), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), issues }, null, 2));
}

// 只保留当天一条：删除往期文章 JSON，不做归档
function pruneOldPosts(date) {
  if (!existsSync(POSTS_DIR)) return;
  for (const f of readdirSync(POSTS_DIR)) {
    if (f.endsWith('.json') && f !== `${date}.json`) {
      unlinkSync(join(POSTS_DIR, f));
    }
  }
}

async function main() {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  log('开始生成', date, '这一期…');

  const repo = await findCandidate();
  log(`当日核心项目：${repo.full_name} ★${repo.stargazers_count}`);

  const readme = await fetchReadme(repo.full_name);
  log(`README 拉取完成（${readme.length} 字符），开始写稿…`);

  const article = await writeArticle(repo, readme);
  const post = {
    date,
    ...article,
    meta: {
      repo: repo.full_name,
      stars: repo.stargazers_count,
      language: repo.language || undefined,
      license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : undefined,
      lastCommit: repo.pushed_at?.slice(0, 10),
      version: undefined,
    },
  };

  mkdirSync(POSTS_DIR, { recursive: true });
  writeFileSync(join(POSTS_DIR, `${date}.json`), JSON.stringify(post, null, 2));
  pruneOldPosts(date);

  const history = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : [];
  if (!history.includes(repo.full_name)) history.push(repo.full_name);
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  rebuildIndex();
  log(`完成：web/data/posts/${date}.json（当日仅保留这一条）`);
}

main().catch(e => { console.error(e); process.exit(1); });
