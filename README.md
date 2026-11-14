# 万星日报（Daily 10K）

每天只讲一个 GitHub 万星热门项目的中文深读日报。内容在北京时间 5:30 前自动更新，**往期全文永久保留**，越积越多，随时回顾检索任意一天。

**线上地址**：https://kuangketongxue.github.io/daily10k/

## 怎么运作

- `scripts/generate.mjs`（零依赖，Node 18+）：
  1. **先看收藏夹**：读 `scripts/starred.json`（由本机归档任务每天写入，见下节「收藏夹归档」），把 star 过、且还没写过的项目作为第一优先候选。这是全站唯一带真实偏好的信号——公共榜单只知道什么热，不知道你要什么。
  2. **再看公共热度**：抓 `github.com/trending` 的日榜与周榜，逐个用 GitHub REST 复核（排除写过的、归档/派生/禁用仓库、清单资料类仓库），只留万星以上；同时把每天见到的候选沉淀进 `scripts/pool.json` 保留 30 天、热度按日衰减 15%——掉榜的项目一个月内仍可再竞争，不再「落榜一次即永别」（`storytold/craft-anything` 32K 星就是这么被漏掉的）。
  3. **过三道闸**：
     - **信息增量**：星数 >80K 打 0.65 折、>40K 打 0.82 折。192K 星的 `anthropics/skills` 对读者近乎零新增信息，3K 星的专用工具才可能是他真缺的。
     - **AI 配额**：近 7 天 AI 占比 >60% 时把 AI 候选压到 0.65，<35% 时补到 1.15。不降 AI 权重（AI 仍是最值得学的板块），只防它独占版面。
     - **生产可用度**：看仓库里到底有没有可分发的软件（构建清单、语言构成、CI）；>500MB 的仓库按数据集降权，而不是因为「代码量大」加分。
  4. **按用途挑**：先按命中「高考/考研、求职、创业、AI、投资、健身」这六类实用方向的数量排序，同档再按日均新增星数（日榜 ÷1、周榜 ÷7）排序，取第一名做当日核心。
  5. **补一个小众精选**：主稿守万星门槛，另从 1000~9999 星区间挑一个工具放副位（优先取最近收藏的），附一段 AI 写的推荐语。生成失败就用仓库原描述兜底，绝不拖垮主稿。
  6. 抓仓库事实（星数、未关闭 Issue/PR、最新 Release、许可证、Trending 排名与当日新增星数）与 README，再取 1-2 个真正同类的替代项目（按具体 topic 与描述关键词筛选，核心是 MCP/agent 工具时要求候选具备同类交付方式）。
  7. 调用 LLM 按固定 8 栏写正式深读稿：它解决什么问题 / 能用来干嘛 / 它是怎么做的 / 怎么上手 / 局限与风险 / 替代方案 / 谁该用谁别用 / 出处与日期；出稿前逐个探活正文链接，404/410 的降级为纯文本。
  8. 输出 `web/data/posts/<日期>.json`，**不删任何往期**，重建 `web/data/index.json`（列出全部期次，含选题方向、仓库名与小众精选，供回顾页检索），并写入页尾自检（字数/命令块/阅读时长）。

选品还会叠加两路「同行口碑」信号（命中才加权，不命中不扣分）：

- **Hacker News**：近 120 天相关讨论的 points 与帖数（`hn.algolia.com`）；
- **Exa 推荐文**：搜 dev.to / HN / lobste.rs / github.blog 等真人技术社区里「最近被公开推荐的开源项目」，从正文里捞出被点名的仓库，每被点名一次 +12%（上限 +36%）。需要 `EXA_API_KEY`，没有就静默跳过。

写稿的字数门禁是分层的：前 4 栏、后 4 栏各自有字数底线，达不到时把「实际字数 / 目标字数」回喂给模型让它扩写，而不是原样重发；全部写完后再过一道总字数底线。这样避免「整篇作废重跑三遍仍然差几十个字」的情况（2026-11-04 05:30 批次就栽在这上面）。
- `.github/workflows/daily.yml`：GitHub 的 `schedule` 不保证准点，实测（2026-10-30~11-02）有 3~4 小时排队延迟，单靠「北京 5:30」那一批必然迟到。所以在北京 00:00~07:30 之间排了 6 批（UTC 16:00 / 17:30 / 19:00 / 21:30 / 22:30 / 23:30），哪批先跑起来就先出稿，其余批次命中「当天已生成」后几秒退出；延迟 5.5 小时以内都能在 5:30 前发出。另加一批北京 10:00（UTC 02:00）补跑，早间全部失败时当天仍有一次机会。任一批次失败都会自动开一个 issue 告警（同一天不重复开），不会静默失败。
- `.github/workflows/pages.yml`：`web/` 有变更时自动发布到 GitHub Pages；因为 bot 用默认
  `GITHUB_TOKEN` 推送的提交不会触发 `push` 事件，它还会在 `daily-report` 跑完后直接发布一次。

## 往期回顾

**往期全文一律不删**：任何日期的 `article.html?d=<日期>` 都能打开，`data/index.json` 列出全部期次、**不设条数上限**（截断会让早期期次文件还在、却再也找不到入口）。
单篇约 14KB，一年 5MB 上下；索引每条约 400 字节，一年约 145KB（Pages 传输时还会压缩），GitHub Pages 完全扛得住。

- `web/archive.html` + `web/archive.js`：往期回顾页。按月分组列出全部期次，支持关键词搜索（标题 / 一句话 / 分类 / 仓库名 / 日期，多个词按 AND）与选题方向筛选，实时显示匹配数。搜索、筛选、分组都是纯函数；正文仍由 `article.html` 按日期去 `data/posts/` 取，这一页只管「找得到」。
- 首页今日卡片下方有「最近往期」5 条与「查看全部 N 期」入口；文章页底部有「更早一期 / 更晚一期」导航，读完可以直接接着翻。标签不写「上一期」——在回顾语境里它指向哪边是有歧义的。

为什么不再走「按收藏归档 + 当天清」：收藏状态存在访问者本机的 localStorage 里，生成管线无从知道谁收藏了哪期，挑保留对象这条路根本走不通。全留反而更简单，也不再依赖「用户先收藏、我们才保留」。

`tests/archive-index.test.mjs`：索引无条数上限、字段完整性，以及搜索 / 筛选 / 按月分组的纯逻辑。

```bash
node tests/archive-index.test.mjs
```

## 收藏夹归档（GitHub star）

`scripts/starred.json` 是选品的第一优先信号，由本机的归档任务每天 18:00 生成写入本仓库。它同时也是「电脑彻底重置后收藏不会丢」的保险：全量快照、README 全文与每日变更日志存在私有仓库 `kuangketongxue/kuangketongxue` 的 `stars/` 目录下。

- 生成端：`kuangketongxue/kuangketongxue` 仓库的 `tools/star-archive/fetch.mjs`
- 数据端：本仓库 `scripts/starred.json`（只保留选品需要的字段）
- 归档端：`stars/snapshot.json`（全量元数据 + 收藏时间）、`stars/readme/<owner>__<repo>.md`（README 全文，作者删库也不怕）、`stars/changelog/<日期>.md`（每日新增/取消）

该文件缺失时选品照常运行，只是跳过第一优先，直接走公共热度。

## 收藏夹

往期全文永久保留，所以收藏夹里的任何一条都不会点开 404。

- `web/favorites.html`：收藏夹页。顶部有「导出收藏 / 导入收藏」，点「看全文」就地展开正文（与文章页同一套排版），也可跳原文页；「取消收藏」移除条目。
- `web/favorites.js`：收藏存储、收藏按钮、导出导入短码、正文渲染的共享模块。
- `web/sw.js` + `web/register-sw.js`：Service Worker。两个缓存分开管——骨架缓存带版本号（部署时由 `pages.yml` 注入 commit SHA，每次部署自动换新），全文缓存单独一个，**不随版本升级清空**。策略也不是一刀切：按日期的全文缓存优先（离线必读），`index.json` 网络优先 + 1.5 秒超时回落（保证当天内容新鲜，又不让弱网卡住首屏），页面骨架先用缓存后台更新。
- `web/sw-edit.html`：旧「跑命令收藏」页面的说明页（收藏已改为本机直接点），保留路径避免旧链接 404。

### 收藏为什么存在本机，而不是云端

收藏状态只存在访问者自己设备的 localStorage 里：点一下就增删，不需要登录、不需要网络、不需要任何密钥。

原因是 GitHub Pages 是纯静态托管，**浏览器端拿不到任何能写入的通道**：

- 前端放 GitHub token = 把密钥公开（仓库是 public，任何人 F12 就能看到），改私有仓库也一样。
- 走 GitHub OAuth 需要跳 `github.com` 授权页，而该域名在当前网络下不通。
- 结论：要么有个服务端代写（本方案没采用），要么用户自己搬运一次。

所以跨设备用**短码**：旧设备「导出收藏」得到一段 base64url 文本，新设备「导入收藏」粘贴，两边收藏**合并**（不覆盖）。
短码里只有日期，不含任何个人信息。

### 收藏数据的边界

- 只存日期（`daily10k:favorites`）与展开状态（`daily10k:favorites:open`），都只在本地。
- 换浏览器、换设备、清缓存会丢 —— 这是纯本地方案的固有代价，用导出导入对冲。
- 站点正文永远公开；收藏行为本身不产生任何网络请求（导出导入也是纯本地字符串转换）。

`tests/local-favorites.test.mjs`：收藏增删、脏数据容错、短码往返与容错，18 项。

```bash
node tests/local-favorites.test.mjs
```

## 站点基础文件

- `web/robots.txt`、`web/sitemap.xml`：给搜索引擎看的入口。注意本站是 GitHub Pages 的**项目站点**，
  爬虫只读域名根目录的 `/robots.txt`，`/daily10k/robots.txt` 不会生效。收录按页区分：首页 / 文章 /
  往期回顾是公开内容，允许收录（带 canonical、og 与 sitemap）；收藏夹 / 404 / 收藏说明是个人化或工具页，
  靠各自的 `<meta name="robots" content="noindex">` 排除。`sitemap.xml` 需要在 Search Console 里手动提交。
- `web/manifest.webmanifest`：PWA 清单，配合 Service Worker 可以「添加到主屏幕」。
- `web/404.html`：GitHub Pages 的自定义 404，路径用绝对路径 `/daily10k/`（子路径下相对路径会解析错）。

## 本地手动跑一次

```bash
AI_API_KEY=你的key AI_BASE_URL=https://token.sensenova.cn/v1 AI_MODEL=sensenova-6.8-flash-lite node scripts/generate.mjs
```

（也可以把配置直接写在 `scripts/config.json`，不要把它提交到公开仓库。）

## 线上配置（已完成）

仓库：`kuangketongxue/daily10k`（公开），Pages 源已设为 GitHub Actions，Secrets 已配好
（`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` / `EXA_API_KEY`）。想立刻出新一期：Actions → daily-report → Run workflow。

想先验证密钥和整条链路、但不出新一期：同样在 Actions → daily-report → Run workflow 里勾选
`dry_run`。它会完整跑选品、抓取、写稿与校验，但不写入 `web/data`、不提交。

## 目录

```
web/                  站点（纯静态，Pages 直接托管）
  index.html          今日日报（首屏 hero + 今日卡片 + 最近往期 5 条）
  article.html        文章页（图片头带 + 正文 + 收藏按钮 + 相邻期次导航）
  archive.html        往期回顾页（按月分组 + 关键词搜索 + 选题方向筛选）
  favorites.html      收藏夹页（就地展开全文）
  sw-edit.html        收藏操作说明页（本机写入入口）
  404.html            自定义 404
  favicon.svg
  style.css
  favorites.js        收藏模块（列表 / 按钮 / 正文渲染 / esc 转义）
  archive.js          往期回顾（搜索 / 筛选 / 分组纯函数 + 页面装配）
  sw.js               Service Worker（离线缓存归档全文）
  register-sw.js      Service Worker 注册
  img/                首屏背景图（Pexels License）
    hero-sky.webp       桌面 2000px
    hero-sky-sm.webp    移动 900px
    hero-sky.jpg        不支持 WebP 时的兜底
  data/index.json     全部期次索引（不设上限，含 lenses / repo 供检索）
  data/posts/*.json   文章全文（永久保留，不删往期）
  data/archive/*.json 早期「收藏即归档」留下的副本（前端只作兜底，不再写入）
  data/favorites.json 旧收藏索引（收藏已改本机 localStorage，不再使用）
scripts/
  generate.mjs        生成管线
  favorite.mjs        收藏写入工具（本机专用）
  config.json         本地配置（含密钥，勿提交公开仓库）
  history.json        已写过的仓库清单（防重复）
tests/
  local-favorites.test.mjs  收藏增删 / 脏数据容错 / 短码往返
  archive-index.test.mjs    索引无上限 / 搜索 / 筛选 / 按月分组
```
