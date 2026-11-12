---
name: aesthetic-profile
description: "个人审美画像：做任何视觉产出（网页、壁纸、头像、海报、PPT、封面、配图、UI 配色）之前先读它，把「他喜欢什么」变成具体的设计决策，而不是每次重新问、也不是套通用模板。画像会随每次设计反馈持续丰富（带证据与版本号）。触发词：设计、配色、壁纸、头像、海报、封面、banner、logo、配色方案、视觉风格、找图、配图、PPT 美化、UI 风格、审美。"
agent_created: true
---

# 审美画像（Aesthetic Profile）

> 一句话：**做视觉之前先读画像，做完之后回写证据。**
> 画像不是一次性问卷的结果，是一个带版本号、带证据、会衰减也会被推翻的活文件。

## 何时必须读本 skill

命中任一条就要读，不要凭通用审美直觉开工：

- 要定配色、字体、间距、圆角、动效
- 要找图（壁纸 / 头像 / 配图 / 背景 / 封面）
- 要做 PPT、海报、banner、文档封面的视觉方案
- 要评价或挑选一组视觉方案

不适用：纯功能逻辑、数据结构、纯文字内容。

## 三步流程

### 第 1 步 · 读画像（30 秒）

读 `profile/aesthetic-profile.json`，按优先级抓四样：

| 优先级 | 字段 | 作用 |
|---|---|---|
| 1 | `hard_rules` | **硬约束，先满足它再谈喜好**。违反一条，后面做得再美也是错 |
| 2 | `contexts.<当前场景>` | 这个场景有没有单独校准过 |
| 3 | `axes` + `palette` + `keywords` | 定配色、明暗、繁简、找图关键词 |
| 4 | `liked_styles` / `disliked_styles` | 具体风格锚点，用来做选择题而不是自说自话 |

`status` 决定你有多敢下判断：

- `seed`（confidence ≤0.35）→ **大部分轴是 null**。此时**禁止假装知道**：给出 2-3 个都符合 `hard_rules` 的方向让本人选，选完立刻回写。
- `calibrated`（做过完整调研）→ 可以直接定方案，只在跨场景迁移时确认。
- `stable`（多轮实战验证）→ 直接执行，交付后仍要记一条证据。

### 第 2 步 · 把画像翻译成决策

不要停在「他喜欢冷色」这种空话上，要落到可执行数值。规则见
`references/design-checklist.md`，核心映射：

| 画像信号 | 落到什么 |
|---|---|
| `axes.temperature` 偏低 | 主色取蓝/青/紫系；暖色只做小面积点缀 |
| `axes.brightness` 偏低 | 暗底浅字；大面积底色 L* ≤ 30；避免纯白满屏 |
| `axes.density` 偏低 | 大留白、单主体；一屏最多一个视觉焦点；删掉装饰性元素 |
| `axes.saturation` 偏低 | 主色不超 3 个；高饱和只占 ≤10% 面积 |
| `axes.realism` 偏高 | 找真实摄影，不用插画/3D 渲染冒充 |
| `palette.primary` | 直接拿来当主色，不再自创配色 |
| `keywords.positive` | 直接粘进图库搜索，不要自己换词 |
| `hard_rules` | 逐条当验收项，交付前自检 |

### 第 3 步 · 交付后回写证据（这一步最容易漏，但它是画像能长大的唯一原因）

只要出现以下任一情况，就追加一条 `evidence`，并按语义升 `profile_version`：

- 他明确说喜欢 / 不喜欢某个方案（→ `design-accepted` / `design-rejected`）
- 他从多个选项里挑了一个（→ 记录挑了哪个、放弃了哪个）
- 他主动提出了画像里没有的偏好（→ 最强证据，可新增轴值）
- 他推翻旧判断（→ 旧轴值改写，旧 evidence **保留不删**，注明作废）

写法要求：`signal` 客观描述、`quote` 原话不改写、`effect` 写清画像改了什么、`strength` 如实标。
**弱证据（我推荐的、他只说「行」的）必须标 `weak`**，不许升级成主动偏好。

详细方法论：`references/enrichment.md`（含衰减、冲突、版本语义、禁止事项）。

## 硬性禁令

1. **禁止编造偏好**。没有证据就留 `null`，不要用 50 当「中性默认值」蒙过去。
2. **禁止把一次确认当强证据**。他说「行」不等于「我喜欢」。
3. **禁止乐观填充**。`confidence` 是自我评价，宁可写低。
4. **禁止跨场景套用**。壁纸偏暗 ≠ PPT 要暗；头像的干净背景 ≠ 网页要留白。
5. **禁止只给抽样精选**。他要全貌时给全景 + 分层，不要给 20 个就说「这些最好」。
7. **禁止给风格贴无关的配图**。一条风格的示例图必须是该风格的真实实例；
   没有就留空显示配色示意。**轮流贴图＝造假标签**，这是踩过的坑（见 `survey/styles.json` 的 `image_policy`）。
6. **禁止用示意图代替真实图片**，也不要给不能放大的缩略图（见 `hard_rules`）。

## 文件结构

```
aesthetic-profile/
├── SKILL.md                       ← 你正在读的这份
├── profile/
│   ├── aesthetic-profile.json     ← 画像本体（唯一真身）
│   ├── profile.schema.json        ← 数据结构约束
│   └── profile.md                 ← 人读摘要（由脚本生成，勿手改）
├── survey/
│   ├── index.html                 ← 调研页：327 种风格 + 点图放大 + 导出 JSON
│   ├── styles.json                ← 327 种视觉风格 / 14 大类（含 image_policy）
│   ├── image-credits.json         ← 示例图出处
│   └── images/                    ← 本地示例图（只放核实过的，其余留空）
├── references/
│   ├── design-checklist.md        ← 画像 → 具体设计决策
│   ├── enrichment.md              ← 画像如何持续丰富
│   └── style-catalog.md           ← 14 大类索引（快速查风格 id）
└── scripts/
    ├── profile_tool.py            ← validate / merge / render
    └── fetch_style_images.py      ← 按关键词补示例图（需自备 Pexels key）
```

## 命令

```bash
# 校验画像结构（合并前必跑）
python scripts/profile_tool.py validate

# 把调研页导出的 JSON 合并进画像（自动升版本 + 重算色板与关键词 + 重生成 md）
python scripts/profile_tool.py merge --input new-survey.json

# 从 JSON 重新生成人读摘要
python scripts/profile_tool.py render
```

## 别人怎么用这份 skill

它是**可复制的模板**，不是只能属于某一个人：

1. 打开 `survey/index.html`，按自己的喜好选，点「复制 JSON」
2. `python scripts/profile_tool.py merge --input 你保存的.json`
3. 把 `profile/aesthetic-profile.json` 里的 `owner` 改成自己

画像从 `seed` 起步很正常，它的价值在于**每次设计都往上长一层**，而不是第一次就完美。
