# 万星日报（Daily 10K）

每天只讲一个 GitHub 万星热门项目的中文深读日报。内容在北京时间 5:30 前自动更新，当天内容当天清，只保留一篇。

**线上地址**：https://kuangketongxue.github.io/daily10k/

## 怎么运作

- `scripts/generate.mjs`（零依赖，Node 18+）：
  1. **现场抓热度**：每次运行时抓 `github.com/trending` 的日榜与周榜，逐个用 GitHub REST 复核（排除写过的、归档/派生/禁用仓库、清单资料类仓库），只留万星以上；抓取失败或榜内无可写项目时，退到 Search API 实时查「近半年新晋的万星项目」；
  2. **按用途挑**：先按命中「高考/考研、求职、创业、AI、投资、健身」这六类实用方向的数量排序，同档再按日均新增星数（日榜 ÷1、周榜 ÷7）排序，取第一名做当日核心；
  3. 抓仓库事实（星数、未关闭 Issue/PR、最新 Release、许可证、Trending 排名与当日新增星数）与 README，再取 1-2 个真正同类的替代项目（按具体 topic 与描述关键词筛选，核心是 MCP/agent 工具时要求候选具备同类交付方式）；
  4. 调用 LLM 按固定 8 栏写正式深读稿：它解决什么问题 / 能用来干嘛 / 它是怎么做的 / 怎么上手 / 局限与风险 / 替代方案 / 谁该用谁别用 / 出处与日期；出稿前逐个探活正文链接，404/410 的降级为纯文本；
  5. 输出 `web/data/posts/<日期>.json`，删除往期，重建 `web/data/index.json`，并写入页尾自检（字数/命令块/阅读时长）。
- `.github/workflows/daily.yml`：GitHub 的 `schedule` 不保证准点，实测（2026-10-30~11-02）有 3~4 小时排队延迟，单靠「北京 5:30」那一批必然迟到。所以在北京 00:00~07:30 之间排了 6 批（UTC 16:00 / 17:30 / 19:00 / 21:30 / 22:30 / 23:30），哪批先跑起来就先出稿，其余批次命中「当天已生成」后几秒退出；延迟 5.5 小时以内都能在 5:30 前发出。
- `.github/workflows/pages.yml`：`web/` 有变更时自动发布到 GitHub Pages；因为 bot 用默认
  `GITHUB_TOKEN` 推送的提交不会触发 `push` 事件，它还会在 `daily-report` 跑完后直接发布一次。

## 本地手动跑一次

```bash
AI_API_KEY=你的key AI_BASE_URL=https://token.sensenova.cn/v1 AI_MODEL=sensenova-6.8-flash-lite node scripts/generate.mjs
```

（也可以把配置直接写在 `scripts/config.json`，不要把它提交到公开仓库。）

## 线上配置（已完成）

仓库：`kuangketongxue/daily10k`（公开），Pages 源已设为 GitHub Actions，Secrets 已配好
（`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`）。想立刻出新一期：Actions → daily-report → Run workflow。

想先验证密钥和整条链路、但不出新一期：同样在 Actions → daily-report → Run workflow 里勾选
`dry_run`。它会完整跑选品、抓取、写稿与校验，但不写入 `web/data`、不提交。

## 目录

```
web/                  站点（纯静态，Pages 直接托管）
  index.html          今日日报（首屏 hero + 今日卡片）
  article.html        文章页（图片头带 + 正文）
  404.html            自定义 404
  favicon.svg
  style.css
  img/                首屏背景图（Pexels License）
    hero-sky.webp       桌面 2000px
    hero-sky-sm.webp    移动 900px
    hero-sky.jpg        不支持 WebP 时的兜底
  data/index.json     当日索引
  data/posts/*.json   当日文章（每天只有一份）
scripts/
  generate.mjs        生成管线
  config.json         本地配置（含密钥，勿提交公开仓库）
  history.json        已写过的仓库清单（防重复）
```
