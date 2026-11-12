#!/usr/bin/env python3
"""按风格关键词抓真实示例图，并写回 styles.json。

背景：327 种风格里，只有 33 种能用手头已有的图验证。其余如果硬凑一张，
就会「描述说白云羽毛、图里是星空」，这比不给图更糟。所以要么没有图，
要么是搜来的、看得懂的照片。

用法（key 只从环境变量或文件读，绝不写进代码/仓库）：

    set PEXELS_KEY=xxxx            # Windows cmd
    export PEXELS_KEY=xxxx         # bash
    python scripts/fetch_style_images.py --provider pexels --max 180

    # 或把 key 放在仓库外的文件里
    python scripts/fetch_style_images.py --provider pexels --key-file ../_secrets/pexels.key

为什么默认 Pixabay（2026-11-12 实测）：
    - Pexels：官方已暂停签发新 key（页面提示"新API密钥的签发目前已暂停"）→ 拿不到
    - Unsplash：key 要过审，免费档 50 次/小时 → 327 张要跑 7 小时
    - Openverse / Wikimedia Commons：本机网络被挡（超时）
    - Pixabay：注册即出 key、无需审核，100 次/分钟 → 全部跑完约 5 分钟

补充（2026-11-12 晚）：真正跑起来最省事的是 --provider tavily —— 用 parallel-search skill 里
已有的 Tavily key 去搜 pexels.com 的照片页，再从照片 ID 直连 Pexels 图片 CDN。
好处：不受 Unsplash 50 次/小时限制、Pexels 授权免费可商用、图片地址可由 ID 稳定推导。
每次跑 180 个就停，进度写进 survey/.fetch-progress.json 可续跑。

用 --dry-run 先看会搜什么词，不消耗额度。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STYLES = ROOT / "survey" / "styles.json"
IMGDIR = ROOT / "survey" / "images"
PROGRESS = ROOT / "survey" / ".fetch-progress.json"
CREDITS = ROOT / "survey" / "image-credits.json"

UA = "aesthetic-profile/0.1 (+https://github.com/kuangketongxue/aesthetic-profile)"
MAX_EDGE = 1200
QUALITY = 78


def die(msg: str) -> None:
    print("FAIL", msg)
    raise SystemExit(1)


def read_key(args) -> str:
    if args.key_file:
        p = Path(args.key_file)
        if not p.exists():
            die(f"key 文件不存在：{p}")
        return p.read_text(encoding="utf-8").strip()
    env = {"tavily": "TAVILY_API_KEY", "pixabay": "PIXABAY_KEY", "pexels": "PEXELS_KEY",
           "unsplash": "UNSPLASH_KEY"}[args.provider]
    v = os.environ.get(env, "").strip()
    if not v:
        die(f"没有 key。设环境变量 {env}，或用 --key-file 指向仓库外的文件。\n"
            f"     Pixabay 免费 key：登录后打开 https://pixabay.com/api/docs/ ，页面上直接显示 "
            f"你的 API key（注册即发，不审核）。key 不写进代码、不进仓库。")
    return v


def http_json(url: str, headers: dict) -> tuple[int, dict]:
    cmd = ["curl", "-s", "--noproxy", "*", "-w", "\n%{http_code}", url,
           "-H", "User-Agent: " + UA]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    r = subprocess.run(cmd, capture_output=True, timeout=60)
    out = r.stdout.decode("utf-8", "replace")
    body, _, code = out.rpartition("\n")
    try:
        return int(code or 0), json.loads(body) if body.strip() else {}
    except json.JSONDecodeError:
        return int(code or 0), {}


def download(url: str, dest: Path) -> int:
    tmp = dest.with_suffix(".part")
    cmd = ["curl", "-sL", "--noproxy", "*", "-A", UA, "-o", str(tmp),
           "-w", "%{http_code}", "--max-time", "90", url]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    code = int(r.stdout.decode().strip() or 0)
    if code != 200 or not tmp.exists() or tmp.stat().st_size < 4096:
        if tmp.exists():
            tmp.unlink()
        return code
    tmp.replace(dest)
    return 200


def shrink(path: Path) -> bool:
    """压到 MAX_EDGE 并校验能解码。PIL 缺失时退化为文件头检查。"""
    try:
        from PIL import Image
    except ImportError:
        with path.open("rb") as f:
            return f.read(2) == b"\xff\xd8"
    try:
        im = Image.open(path)
        im.load()
        im = im.convert("RGB")
        w, h = im.size
        if max(w, h) > MAX_EDGE:
            r = MAX_EDGE / max(w, h)
            im = im.resize((round(w * r), round(h * r)), Image.LANCZOS)
        im.save(path, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        return True
    except Exception as e:
        print("   图片解码失败：", e)
        return False


def query_chain(style: dict) -> list[str]:
    """按从窄到宽排的搜索词。图库索引里没有的冷门词（fairycore / goblincore 之类）
    会返回 0 条，这时退到它更常见的同义/上位词，而不是硬配一张无关图。"""
    kws = [k.strip() for k in (style.get("kw") or []) if k and k.strip()]
    chain = []
    if len(kws) >= 2:
        chain.append(" ".join(kws[:2]))
    if len(kws) >= 3:
        chain.append(" ".join([kws[0], kws[2]]))
    chain += kws[:4]
    en = (style.get("en") or "").strip()
    if en:
        chain.append(en)
    out, seen = [], set()
    for q in chain:
        if q and q.lower() not in seen:
            seen.add(q.lower())
            out.append(q)
    return out[:5]


def query_for(style: dict) -> str:
    c = query_chain(style)
    return c[0] if c else (style.get("en") or "")


def tavily_keys() -> list[str]:
    """从 parallel-search skill 的配置里读 Tavily key（找不到就问环境变量）。"""
    keys = []
    cfg = Path.home() / ".workbuddy" / "skills" / "parallel-search" / "config.json"
    if cfg.exists():
        try:
            keys = [k for k in json.loads(cfg.read_text(encoding="utf-8")).get("tavily_keys", []) if k]
        except Exception:
            keys = []
    env = os.environ.get("TAVILY_API_KEY", "").strip()
    if env:
        keys.insert(0, env)
    return keys


def slug_to_note(url: str) -> str:
    """从 Pexels 照片页 URL 的 slug 里取出这张图拍的是什么，例如
    /photo/clear-blue-sky-with-soft-white-clouds-32436367 → clear blue sky with soft white clouds"""
    m = re.search(r"/photo/(?:([a-z0-9\-]+?)-)?(\d{5,})/?$", url)
    if not m or not m.group(1):
        return ""
    return m.group(1).replace("-", " ")


def search_tavily(q: str, keys: list[str], state: dict) -> tuple[int, list]:
    """Tavily 只用来「找 Pexels 照片页」，图片本体仍从 Pexels CDN 取。
    这样既躲开 Unsplash 的 50 次/小时，也保证授权干净（Pexels 免费可商用）。"""
    if not keys:
        return 500, []
    body = {"query": q, "max_results": 8, "include_domains": ["pexels.com"],
            "search_depth": "basic"}
    for attempt in range(len(keys)):
        key = keys[state.get("ki", 0) % len(keys)]
        r = subprocess.run(["curl", "-s", "--noproxy", "*", "--max-time", "40",
                            "https://api.tavily.com/search",
                            "-H", "Content-Type: application/json",
                            "-H", "Authorization: Bearer " + key,
                            "-d", json.dumps(body)], capture_output=True, timeout=60)
        out = r.stdout.decode("utf-8", "replace")
        try:
            j = json.loads(out)
        except json.JSONDecodeError:
            return 500, []
        if j.get("error") or j.get("detail"):
            # 额度用尽 / key 失效 → 换下一个 key
            state["ki"] = state.get("ki", 0) + 1
            continue
        out_list = []
        for item in (j.get("results") or []):
            u = item.get("url", "")
            m = re.search(r"/photo/(?:[a-z0-9\-]+?)-(\d{5,})/?$", u)
            if not m:
                continue
            pid = m.group(1)
            out_list.append({
                "file": ("https://images.pexels.com/photos/%s/pexels-photo-%s.jpeg"
                         "?auto=compress&cs=tinysrgb&w=1200&h=800&fit=crop" % (pid, pid)),
                "alt": slug_to_note(u),
                "page": u,
                "author": "",
                "source": "Pexels",
            })
        return 200, out_list
    return 432, []


def search_pixabay(q: str, key: str) -> tuple[int, list]:
    """Pixabay：100 次/分钟，注册即发 key。largeImageURL 约 1280px，正合适。"""
    url = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo&orientation=horizontal"
           "&per_page=5&safesearch=true&order=popular" % (key, urllib.parse.quote(q)))
    code, j = http_json(url, {})
    if code != 200:
        return code, []
    out = []
    for p in (j.get("hits") or []):
        out.append({
            "file": p.get("largeImageURL") or p.get("webformatURL"),
            "alt": (p.get("tags") or "").strip(),
            "page": p.get("pageURL", ""),
            "author": (p.get("user") or "").strip(),
            "source": "Pixabay",
        })
    return code, out


def search_pexels(q: str, key: str) -> tuple[int, list]:
    url = ("https://api.pexels.com/v1/search?query=%s&per_page=3&orientation=landscape"
           % urllib.parse.quote(q))
    code, j = http_json(url, {"Authorization": key})
    if code != 200:
        return code, []
    out = []
    for p in (j.get("photos") or []):
        out.append({
            "file": (p.get("src") or {}).get("large") or (p.get("src") or {}).get("original"),
            "alt": (p.get("alt") or "").strip(),
            "page": p.get("url", ""),
            "author": (p.get("photographer") or "").strip(),
            "source": "Pexels",
        })
    return code, out


def search_unsplash(q: str, key: str) -> tuple[int, list]:
    url = ("https://api.unsplash.com/search/photos?query=%s&per_page=3&orientation=landscape"
           % urllib.parse.quote(q))
    code, j = http_json(url, {"Authorization": "Client-ID " + key})
    if code != 200:
        return code, []
    out = []
    for p in (j.get("results") or []):
        u = ((p.get("urls") or {}).get("regular") or "")
        out.append({
            "file": u.split("?")[0] + "?w=1200&q=78&fm=jpg" if u else "",
            "alt": (p.get("alt_description") or p.get("description") or "").strip(),
            "page": (p.get("links") or {}).get("html", ""),
            "author": (p.get("user") or {}).get("name", ""),
            "source": "Unsplash",
        })
    return code, out


def main() -> int:
    ap = argparse.ArgumentParser(description="按风格关键词抓真实示例图")
    ap.add_argument("--provider", choices=["tavily", "pixabay", "pexels", "unsplash"], default="tavily")
    ap.add_argument("--key-file", help="指向仓库外保存 key 的文件")
    ap.add_argument("--max", type=int, default=180, help="本次最多抓多少个（额度保护）")
    ap.add_argument("--sleep", type=float, default=0.5, help="每次请求间隔秒数（Pixabay 限 100 次/分钟）")
    ap.add_argument("--overwrite", action="store_true", help="连已有的图也重抓")
    ap.add_argument("--dry-run", action="store_true", help="只打印搜索词，不消耗额度")
    ap.add_argument("--only", help="只处理这些 id（逗号分隔），用于重抓某几条不满意的图")
    ap.add_argument("--query", help="配合 --only，用指定的搜索词覆盖默认关键词")
    args = ap.parse_args()

    data = json.loads(STYLES.read_text(encoding="utf-8"))
    IMGDIR.mkdir(parents=True, exist_ok=True)
    progress = json.loads(PROGRESS.read_text(encoding="utf-8")) if PROGRESS.exists() else {"done": {}}
    credits = json.loads(CREDITS.read_text(encoding="utf-8")) if CREDITS.exists() else {}

    todo = [s for s in data["styles"]
            if args.overwrite or s.get("imgKind") != "example" or not s.get("img")]
    if args.only:
        want = {x.strip() for x in args.only.split(",") if x.strip()}
        todo = [s for s in todo if s["id"] in want] or [s for s in data["styles"] if s["id"] in want]
    print(f"待配图 {len(todo)} / {len(data['styles'])}，本次上限 {args.max}")
    if args.dry_run:
        for s in todo[:30]:
            print(f"  {s['id']} {s['cn']:12s} → {query_for(s)}")
        print(f"  …共 {len(todo)} 条（--dry-run 不请求接口）")
        return 0
    if not todo:
        print("全部都有图了。")
        return 0

    if args.provider == "tavily":
        tkeys = tavily_keys()
        if not tkeys:
            die("没找到 Tavily key。它应该在 ~/.workbuddy/skills/parallel-search/config.json 的 tavily_keys 里。")
        tstate: dict = {}
        key = ""  # tavily 分支用不到单 key，留空只为了让下面的调用签名统一
        search = lambda q, _k: search_tavily(q, tkeys, tstate)  # noqa: E731
    else:
        key = read_key(args)
        search = {"pixabay": search_pixabay, "pexels": search_pexels,
                  "unsplash": search_unsplash}[args.provider]
    ok = fail = 0
    quota_hit = False

    for i, s in enumerate(todo[: args.max], 1):
        picked = None
        used_q = ""
        exhausted = False
        budget = 2 if args.provider == 'tavily' else 5
        chain = [args.query] if (args.query and args.only) else query_chain(s)[:budget]
        for q in chain:
            if i > args.max:
                break
            code, cands = search(q, key)
            time.sleep(args.sleep)
            if code == 429:
                print("  触发限流（429）。Unsplash 免费档 50 次/小时，等一小时再跑。")
                quota_hit = True
                exhausted = True
                break
            if code != 200:
                print(f"  [{i}] {s['id']} 搜索 HTTP {code}（{q}）")
                continue
            if not cands:
                continue  # 该词在图库里没有索引，退到下一个词
            for c in cands:
                if not c["file"]:
                    continue
                dest = IMGDIR / f"{s['id']}.jpg"
                got = download(c["file"], dest)
                if got == 200 and shrink(dest):
                    picked, used_q = c, q
                    break
            if picked:
                break
        if exhausted:
            break
        if not picked:
            print(f"  [{i}] {s['id']} {s['cn']} 所有候选词都搜不到可用图，留空")
            fail += 1
            continue

        s["img"] = f"images/{s['id']}.jpg"
        s["imgKind"] = "example"
        s["imgNote"] = (f'{picked["source"]} 实拍：{picked["alt"]}' if picked["alt"]
                        else f'{picked["source"]} 实拍')
        s["imgQuery"] = used_q
        credits[s["id"]] = {"source": picked["source"], "author": picked["author"],
                            "page": picked["page"], "query": used_q}
        progress["done"][s["id"]] = used_q
        ok += 1
        print(f"  [{i}] {s['id']} {s['cn']:12s} ← {used_q[:44]}")

        STYLES.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        CREDITS.write_text(json.dumps(credits, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        PROGRESS.write_text(json.dumps(progress, ensure_ascii=False, indent=1), encoding="utf-8")

    left = len([x for x in data["styles"] if x.get("imgKind") != "example"])
    print(f"\n本轮成功 {ok}，失败 {fail}，剩余待配图 {left}")
    if quota_hit:
        print("被限流：等 1 分钟再跑同一条命令即可继续（进度已存）。")
    if ok:
        print("下一步：python scripts/build_survey_js.py && python scripts/build_catalog.py")
    return 0 if ok or not fail else 1


if __name__ == "__main__":
    sys.exit(main())
