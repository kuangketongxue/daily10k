#!/usr/bin/env python3
"""把示例图统一压到适合放进仓库的尺寸。

为什么要单独一步：抓图脚本为了画质保留 1200px，327 张加起来 ≈45MB，仓库太重。
但压太小，「点开放大」就糊了。900px 长边 + q72 是折中：单张约 45-60KB，
全部约 16MB，放大看细节仍然够。

    python scripts/normalize_images.py            # 压缩并回读校验
    python scripts/normalize_images.py --dry-run  # 只看体积会变成多少
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMGDIR = ROOT / "survey" / "images"
STYLES = ROOT / "survey" / "styles.json"
MAX_EDGE = 900
QUALITY = 72


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-edge", type=int, default=MAX_EDGE)
    ap.add_argument("--quality", type=int, default=QUALITY)
    args = ap.parse_args()

    try:
        from PIL import Image
    except ImportError:
        print("FAIL 需要 Pillow：pip install pillow")
        return 1

    data = json.loads(STYLES.read_text(encoding="utf-8"))
    used = {s["img"] for s in data["styles"] if s.get("img")}
    files = sorted(p for p in IMGDIR.glob("*.jpg") if f"images/{p.name}" in used)
    before = sum(p.stat().st_size for p in files)
    print(f"待处理 {len(files)} 张，当前 {before/1024/1024:.1f} MB")
    if args.dry_run:
        print(f"--dry-run：预计压到 {before*0.35/1024/1024:.1f} MB 左右，不写盘")
        return 0

    done = bad = 0
    for p in files:
        try:
            im = Image.open(p)
            im.load()
            im = im.convert("RGB")
            w, h = im.size
            if max(w, h) > args.max_edge:
                r = args.max_edge / max(w, h)
                im = im.resize((max(1, round(w * r)), max(1, round(h * r))), Image.LANCZOS)
            im.save(p, "JPEG", quality=args.quality, optimize=True, progressive=True)
            # 回读确认还能解码
            Image.open(p).load()
            done += 1
        except Exception as e:
            print("  失败", p.name, e)
            bad += 1

    after = sum(p.stat().st_size for p in files)
    print(f"完成 {done}，失败 {bad}｜{before/1024/1024:.1f} MB → {after/1024/1024:.1f} MB")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
