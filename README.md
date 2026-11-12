# aesthetic-profile · 审美画像

> 让 AI 记住你喜欢什么，而不是每次设计都从「请问你想要什么风格」开始。

[English](README.en.md) ｜ 中文

## 这解决什么问题

每次让 AI 做视觉（网页配色、壁纸、头像、海报、PPT、封面），它要么给你一套通用的「科技蓝」模板，
要么反问你一堆问题，问完下次又忘。原因很简单：**审美没有被存成机器能读的东西。**

这个 skill 干三件事：

1. **量出来** — 一个本地调研页，327 种可用作壁纸 / 头像 / 设计配图的视觉风格 × 14 大类，
   配真实图片、可点开放大、可搜索筛选。
2. **存下来** — 结果合并成一份带版本号、带证据的 JSON 画像，agent 直接读它做决策。
3. **长起来** — 每次设计交付后追加一条证据，画像随使用变准；旧的判断被推翻也保留痕迹。

## 为什么不是「一次问卷定终身」

用户原话：**「这个喜好是不断丰富的，不是一成不变的」**。

所以画像里每个值都必须能指回一条证据：

| 强度 | 含义 | 能做什么 |
|---|---|---|
| `strong` | 他主动说的偏好 / 明确否定 | 直接改轴值、加硬规则 |
| `medium` | 他在我给的选项里选了一个 | 调权重，不加硬规则 |
| `weak` | 他只说「行」，或我推断的 | **只记录，不改任何值** |

没有证据的字段一律 `null`，**禁止填 50 假装中性**。这条是整个设计里最重要的约束 ——
假画像比没画像更糟，因为后来的人会以为它被确认过，从而不再问。

## 示例图是怎么来的（它决定了这份东西可不可信）

第一版这里是错的：327 条风格的配图是按大类**轮流贴**的，于是「天使核（白云、羽毛、纯白大理石）」
旁边出现了星空照，「蘑菇核」旁边出现了鸟居。用户当场指出「为什么描述和图片不一致」。

现在的规则写在 `survey/styles.json` 的 `image_policy` 里，并用测试锁死：

- 只有**这张图确实是该风格实例**时才配图（`imgKind: "example"`），且必须用 `imgNote`
  写清这张图实际拍的是什么。目前 33 / 327 条满足。
- 其余 294 条**不配图**，页面显示由该风格色板生成的配色示意块，明确标注「暂无示例图」。
- 一张图最多服务 2 种风格（测试会拦住轮流贴图）。

要把剩下 294 张补齐，用免费的图库 key 按关键词搜（key 只在本机，不进仓库）：

```bash
export PIXABAY_KEY=你的key          # Windows: set PIXABAY_KEY=...
python scripts/fetch_style_images.py --dry-run      # 先看会搜什么词，不耗额度
python scripts/fetch_style_images.py --max 180     # 100 次/分钟，约两轮跑完
python scripts/build_survey_js.py && python scripts/build_catalog.py
```

图库选型（2026-11-12 实测，别走弯路）：

| 通道 | 结论 |
|---|---|
| `--provider tavily`（默认） | **推荐**。借 Tavily 搜 `pexels.com` 照片页，再用照片 ID 直连 Pexels CDN。不受 Unsplash 50 次/小时限制，Pexels 授权免费可商用，约 15 分钟跑完 |
| `--provider unsplash` | key 要过审，免费档 **50 次/小时**，327 张要跑 6~7 小时 |
| `--provider pixabay` | 注册即出 key、100 次/分钟，但官方接口要 key |
| Pexels 官方 API | 已停止签发新 key |
| Openverse / Wikimedia Commons | 部分网络下直接超时 |

`--provider tavily` 复用 `~/.workbuddy/skills/parallel-search/config.json` 里的 Tavily key，
也可以用环境变量 `TAVILY_API_KEY` 覆盖。它只用来**找照片页**，图片本体仍从 Pexels CDN 取，
所以授权链条是干净的（Pexels License），也顺带解决了「冷门词在图库里搜不到」的问题。

脚本会断点续跑（进度存 `survey/.fetch-progress.json`），每张图校验可解码并压到 1200px，
作者与出处记进 `survey/image-credits.json`。

## 快速开始

```bash
git clone https://github.com/kuangketongxue/aesthetic-profile.git
cd aesthetic-profile

# 1. 打开调研页（双击即可，无需服务器、无需联网）
#    survey/index.html  →  选风格 / 点图放大  →  生成画像  →  导出 JSON

# 2. 合并进画像（自动算轴值、色板、关键词，并升版本）
python scripts/profile_tool.py merge --input ~/Downloads/aesthetic-survey-2026-11-12.json

# 3. 看结果
python scripts/profile_tool.py validate
python scripts/profile_tool.py render      # 生成 profile/profile.md
```

零依赖：只用 Python 标准库，Python 3.9+。Windows / macOS / Linux 都能跑。

## agent 怎么用它

把整个目录放进 `~/.workbuddy/skills/`（或 Claude Code 的 skills 目录）即可，`SKILL.md` 会被自动加载。

它规定了一个三步流程：

1. **读画像** —— 先看 `hard_rules`（硬约束优先于喜好），再看当前场景有没有单独校准过
2. **翻译成决策** —— 轴值 → 配色 / 明暗 / 繁简 / 找图关键词，见 `references/design-checklist.md`
3. **回写证据** —— 交付后追加一条，这是画像能长大的唯一原因

还写了一串硬性禁令：不许编造偏好、不许把「他没反对」当「他喜欢」、不许跨场景套用（壁纸偏暗 ≠ PPT 要暗）。

## 目录

```
SKILL.md                       agent 入口：何时读、怎么读、怎么回写
profile/
  aesthetic-profile.json       画像本体（唯一真身）
  profile.schema.json          数据结构约束（含「null 是合法值」的说明）
  profile.md                   人读摘要（由 render 生成）
survey/
  index.html                   调研页：327 风格 / 14 大类 / 点图放大 / 导出 JSON
  styles.json                  风格清单（真身，含 image_policy）
  picks.json                   25 张视觉偏好图数据
  images/                      本地示例图（已压缩，离线可打开）
  image-credits.json           示例图作者与出处（Pexels / Unsplash）
references/
  design-checklist.md          画像 → 具体设计数值
  enrichment.md                证据、衰减、冲突、版本语义
  style-catalog.md             14 大类索引（快速查 id 与关键词）
scripts/
  profile_tool.py              validate / merge / render
  fetch_style_images.py        按关键词抓真实示例图（需自备图库 key）
  build_survey_js.py           JSON → 浏览器可直接用的 .js
  build_catalog.py             生成 style-catalog.md
tests/
  test_profile_tool.py         25 个测试，守护「画像不说谎、配图不张冠李戴」
```

## 设计取向（为什么长这样）

- **不做打分问卷**。10 个问题算不出审美；真实的做法是给全景让人挑，再问少数几个能定轴的二选一。
- **8 个连续轴而非标签**。标签（「极简」「赛博」）互斥且含混；轴值（0-100）能组合、能迁移、能算距离。
- **硬规则单列**。偏好是「倾向」，硬规则是「底线」；混在一起就会用「他喜欢暗色」去解释「不能用示意图」。
- **分场景**。同一个人的壁纸和 PPT 常常相反，`contexts` 彼此独立。
- **可 fork**。画像属于个人，仓库属于模板：改 `owner`、重跑调研，就是另一个人的画像。

## 已知局限

- 调研页只有 4 道二选一，能定的轴有限（温度 / 明暗 / 繁简 / 写实度），其余 4 个轴（饱和、对比、有机、年代）
  需要靠后续设计反馈补。**这是设计取舍，不是遗漏** —— 多问会让人选择疲劳。
- 风格参考图是图库摄影，不是艺术史原作，只能表达氛围，不能代表流派技法。
- 327 种不可能覆盖「所有」风格。清单是活的：新风格自己做一次调研就能加进来。

## 图片授权

参考图来自 [Unsplash](https://unsplash.com/license) 与 [Pexels](https://www.pexels.com/license) 免费可商用图库，
已全部下载到本地并逐张验证可打开，仅作氛围参考。清单与匹配数据以 MIT 协议开源；图片本身遵循各自图库协议。

## License

MIT © [kuangketongxue](https://github.com/kuangketongxue)
