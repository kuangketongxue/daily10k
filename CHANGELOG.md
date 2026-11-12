# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化。

画像本身的版本单独记在 `profile/aesthetic-profile.json` 的 `profile_version`，
这里记的是 **skill / 工具链**的版本，两者不要混。

## [0.2.0] - 2026-11-12

327 种风格补齐 284 张示例图。

### 新增

- `scripts/fetch_style_images.py --provider tavily`（默认）：借 Tavily 搜 `pexels.com` 照片页，
  再由照片 ID 直连 Pexels CDN。**绕开 Unsplash 免费档 50 次/小时**，且 Pexels 授权免费可商用；
  配 2 个 Tavily key 轮换、搜索词从窄到宽回退（`angelcore` 这类图库里没有索引的冷门词自动退到
  `white clouds` 等可搜词），实际使用的搜索词写入 `imgQuery`，可逐条审计。
- `--only s314 --query "..."`：对某条不满意的图单独重抓，不用重跑全量。
- `scripts/normalize_images.py`：统一压到长边 900px / q72，图片总量 36.2MB → 17.9MB。

### 结果

- 284 / 327 有真实示例图；43 条无图，全部是「用途类」条目（信息图、PPT 封面、各类壁纸、
  社媒配图等）—— 图库里没有一种照片能代表「PPT 封面」，留空显示配色示意比硬配更诚实。
- 抽样核对 69 张：没有「完全无关」的图，约 85% 直接对得上，约 15% 偏宽泛（如
  `fairycore` 退到 `fireflies` 后拿到浮萍照）。窄词的准确率天然低于宽词，这是检索的固有代价。
- 远端仓库 315 个文件 / 19.5MB，随机 5 张图 sha256 与本地完全一致。

## [0.1.1] - 2026-11-12

### 修正

- 🔴 **配图张冠李戴**：0.1.0 里 327 条风格的示例图是按大类轮流贴的，导致「天使核（白云/羽毛）」
  配了星空照。用户当场指出。现在 `imgKind` 只能是 `example` / `none`，`example` 必须带
  `imgNote` 说明这张图实际拍的是什么；一张图最多服务 2 种风格（测试拦截）。
- 同步清空未经核实的配图：33 / 327 条保留真实示例，其余 294 条改为配色示意并标注「暂无示例图」。

### 新增

- `scripts/fetch_style_images.py`：按风格关键词从 Pixabay / Pexels / Unsplash 搜真实示例图（默认 Pixabay：
  实测 Pexels 已停发新 key、Unsplash 免费档 50 次/小时、Openverse 与 Wikimedia 在本机被挡），断点续跑、
  额度保护、逐张校验可解码并压缩；作者与出处写入 `survey/image-credits.json`。
- `scripts/fetch_style_images.py` 增加 `--provider tavily`（默认）：借 Tavily 搜 pexels.com 照片页 +
  照片 ID 直连 Pexels CDN，绕开 Unsplash 50 次/小时限制；带 2 个 key 自动轮换、搜索词从窄到宽回退、
  实际搜索词写进 `imgQuery` 可审计。
- `survey/index.html`：无图风格显示色板渐变块 + 「暂无示例图」；灯箱只在有图风格之间翻页。
- 测试增至 25 个（新增 `imgKind` 自洽、配图不重复、`image_policy` 存在）。

## [0.1.0] - 2026-11-12

首个可用版本。

### 新增

- `SKILL.md`：三步流程（读画像 → 翻译决策 → 回写证据）+ 六条硬性禁令
- `profile/aesthetic-profile.json`：版本化画像，8 个连续轴、liked/disliked、硬规则、分场景、证据日志
- `profile/profile.schema.json`：数据契约；**`null` 是合法值**，未测量就不许填
- `survey/index.html`：327 种视觉风格 / 14 大类，搜索筛选、点图放大灯箱、多选、
  4 道二选一、生成画像、导出机器可读 JSON
- `survey/styles.json` + `picks.json`：风格清单与 25 张视觉偏好图（真身）
- `survey/images/`：39 张本地参考图（压缩至 6.3MB，全部离线可打开）
- `references/design-checklist.md`：轴值 → 配色 / 明暗 / 繁简 / 找图的具体数值
- `references/enrichment.md`：证据强度、衰减、冲突处理、版本语义、禁止事项
- `references/style-catalog.md`：327 条索引（自动生成）
- `scripts/profile_tool.py`：`validate` / `merge` / `render`，零依赖
- `scripts/build_survey_js.py`：JSON → 浏览器可用的 `.js`，带 `--check` 防漂移
- `scripts/build_catalog.py`：生成风格索引
- `tests/test_profile_tool.py`：22 个测试，防「画像说谎」「重复合并升版本」「JS 与 JSON 漂移」

### 设计取舍

- 只做 4 道二选一，放弃一次测满 8 个轴 —— 避免选择疲劳，剩余轴留给真实设计反馈
- 调研页不依赖任何远程资源，双击即用（`file://` 下 `fetch` 会被拦，所以数据用 `<script>` 注入）
