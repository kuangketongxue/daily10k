# 万星日报（Daily 10K）

每天只讲一个 GitHub 万星前沿项目的中文深读日报。每天北京时间 5:30 自动更新，当天内容当天清，只保留一篇。

**线上地址**：https://kuangketongxue.github.io/daily10k/

## 怎么运作

- `scripts/generate.mjs`（零依赖，Node 18+）：
  1. 用 GitHub Search API 找「近 180 天创建、星数已破 1 万」的前沿项目，排除写过的（`scripts/history.json`），跳过清单/资料书类仓库，取星数最高的一个；
  2. 抓取仓库事实（星数、未关闭 Issue/PR、最新 Release、许可证）与 README，再取 1-2 个同类替代项目；
  3. 调用 LLM 按固定 8 栏写正式深读稿：它解决什么问题 / 能用来干嘛 / 它是怎么做的 / 怎么上手 / 局限与风险 / 替代方案 / 谁该用谁别用 / 出处与日期；
  4. 输出 `web/data/posts/<日期>.json`，删除往期，重建 `web/data/index.json`，并写入页尾自检（字数/命令块/阅读时长）。
- `.github/workflows/daily.yml`：每天 UTC 21:30（北京 5:30）跑上面的脚本并提交数据变更。
- `.github/workflows/pages.yml`：`web/` 有变更时自动发布到 GitHub Pages。

## 本地手动跑一次

```bash
AI_API_KEY=你的key AI_BASE_URL=https://token.sensenova.cn/v1 AI_MODEL=sensenova-6.8-flash-lite node scripts/generate.mjs
```

（也可以把配置直接写在 `scripts/config.json`，不要把它提交到公开仓库。）

## 线上配置（已完成）

仓库：`kuangketongxue/daily10k`（公开），Pages 源已设为 GitHub Actions，Secrets 已配好
（`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`）。想立刻出新一期：Actions → daily-report → Run workflow。

## 目录

```
web/                  站点（纯静态，Pages 直接托管）
  index.html          今日日报
  article.html        文章页
  style.css
  data/index.json     当日索引
  data/posts/*.json   当日文章（每天只有一份）
scripts/
  generate.mjs        生成管线
  config.json         本地配置（含密钥，勿提交公开仓库）
  history.json        已写过的仓库清单（防重复）
```
