#!/usr/bin/env python3
"""零依赖测试：python tests/test_profile_tool.py（或 python -m unittest discover tests）

测的是「画像不会说谎」这件事：
- 没证据不许填轴值
- 一份导出只能合并一次，重复合并不升版本
- 单个选择推不出偏好（样本 < 2 返回 None）
- 风格库与图片引用不能有断裂
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import profile_tool as pt  # noqa: E402

SURVEY_EXPORT = {
    "kind": "aesthetic-profile-survey",
    "schema_version": "1.0",
    "generated": "2026-11-20",
    "answers": [{"id": "q1", "value": 0}, {"id": "q2", "value": 1}],
    "style_likes": ["s001", "s002"],
    "image_likes": ["w11"],
    "dims": {
        "temp": {"cool": 4, "warm": 1},
        "light": {"dark": 5},
        "density": {"minimal": 3, "rich": 2},
        "texture": {"photo": 3, "render": 2},
    },
    "groups": {"氛围与情绪": 2},
    "palette": ["#0b1a2b", "#123b52", "#2a7d8c", "#5fd0e0"],
    "keywords": ["dark 3d abstract", "gradient mesh"],
}


class TempRepo:
    """把仓库复制到临时目录跑合并，绝不污染真画像。"""

    def __enter__(self) -> Path:
        self.dir = Path(tempfile.mkdtemp(prefix="aesthetic-profile-test-"))
        shutil.copytree(ROOT / "profile", self.dir / "profile")
        shutil.copytree(ROOT / "survey", self.dir / "survey", ignore=shutil.ignore_patterns("images"))
        (self.dir / "scripts").mkdir()
        shutil.copy2(ROOT / "scripts" / "profile_tool.py", self.dir / "scripts")
        return self.dir

    def __exit__(self, *exc):
        shutil.rmtree(self.dir, ignore_errors=True)


class TestRatio(unittest.TestCase):
    def test_single_vote_is_not_a_preference(self):
        self.assertIsNone(pt.ratio({"cool": 1}, "cool", "warm"), "一票不能算偏好")

    def test_zero_votes(self):
        self.assertIsNone(pt.ratio({}, "cool", "warm"))

    def test_half(self):
        self.assertEqual(pt.ratio({"cool": 1, "warm": 1}, "cool", "warm"), 50)

    def test_all_one_side(self):
        self.assertEqual(pt.ratio({"dark": 5}, "bright", "dark"), 0)


class TestVersion(unittest.TestCase):
    def test_bump(self):
        self.assertEqual(pt.bump_version("0.1.0", "patch"), "0.1.1")
        self.assertEqual(pt.bump_version("0.1.0", "minor"), "0.2.0")
        self.assertEqual(pt.bump_version("0.1.0", "major"), "1.0.0")


class TestProfileShape(unittest.TestCase):
    def test_real_profile_validates(self):
        data = json.loads((ROOT / "profile" / "aesthetic-profile.json").read_text(encoding="utf-8"))
        schema = json.loads((ROOT / "profile" / "profile.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(pt.validate(data, schema), [])

    def test_no_invented_axis_values_in_seed(self):
        """seed 状态下每个轴要么有证据支撑，要么是 null——不能凭空给数。"""
        data = json.loads((ROOT / "profile" / "aesthetic-profile.json").read_text(encoding="utf-8"))
        filled = {k: v for k, v in data["axes"].items() if v is not None}
        if data["status"] == "seed" and filled:
            surveys = [e for e in data["evidence"] if e["source"] == "survey"]
            self.assertTrue(surveys, f"seed 画像里有轴值 {filled}，却没有任何调研证据")

    def test_evidence_has_required_fields(self):
        data = json.loads((ROOT / "profile" / "aesthetic-profile.json").read_text(encoding="utf-8"))
        for i, ev in enumerate(data["evidence"]):
            for key in ("date", "source", "signal", "strength"):
                self.assertIn(key, ev, f"evidence[{i}] 缺 {key}")
            self.assertIn(ev["strength"], ("weak", "medium", "strong"))

    def test_no_confidence_one(self):
        data = json.loads((ROOT / "profile" / "aesthetic-profile.json").read_text(encoding="utf-8"))
        self.assertLessEqual(data.get("confidence") or 0, 0.95, "审美会变，置信度不该写满")


class TestMerge(unittest.TestCase):
    def test_merge_computes_axes_and_bumps_version(self):
        with TempRepo() as repo:
            p = repo / "profile" / "aesthetic-profile.json"
            before = json.loads(p.read_text(encoding="utf-8"))

            rc = subprocess.run(
                [sys.executable, str(repo / "scripts" / "profile_tool.py"), "merge",
                 "--input", self._write(repo)],
                capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(rc.returncode, 0, rc.stdout + rc.stderr)

            after = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual(after["axes"]["temperature"], 80)   # cool 4 / (4+1)
            self.assertEqual(after["axes"]["brightness"], 0)     # 全 dark
            self.assertEqual(after["axes"]["density"], 40)       # rich 2 / 5
            self.assertEqual(after["axes"]["realism"], 60)       # photo 3 / 5
            self.assertIsNone(after["axes"]["saturation"], "没数据的轴必须保持 null")
            self.assertEqual(len(after["liked_styles"]), 2)
            self.assertEqual(after["palette"]["primary"], ["#0b1a2b", "#123b52", "#2a7d8c"])
            self.assertNotEqual(after["profile_version"], before["profile_version"])
            self.assertEqual(len(after["evidence"]), len(before["evidence"]) + 1)

    def test_merge_twice_is_noop(self):
        with TempRepo() as repo:
            path = self._write(repo)
            cmd = [sys.executable, str(repo / "scripts" / "profile_tool.py"), "merge", "--input", path]
            subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
            p = repo / "profile" / "aesthetic-profile.json"
            first = p.read_text(encoding="utf-8")
            rc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(rc.returncode, 0)
            self.assertEqual(p.read_text(encoding="utf-8"), first, "重复合并不该改任何东西")
            self.assertIn("无变化", rc.stdout)

    def test_merge_rejects_non_survey_file(self):
        with TempRepo() as repo:
            bad = repo / "bad.json"
            bad.write_text(json.dumps({"kind": "something-else"}), encoding="utf-8")
            rc = subprocess.run(
                [sys.executable, str(repo / "scripts" / "profile_tool.py"), "merge", "--input", str(bad)],
                capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(rc.returncode, 1)
            self.assertIn("不是调研导出文件", rc.stdout)

    @staticmethod
    def _write(repo: Path) -> str:
        p = repo / "export.json"
        p.write_text(json.dumps(SURVEY_EXPORT, ensure_ascii=False), encoding="utf-8")
        return str(p)


class TestSurveyData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.styles = json.loads((ROOT / "survey" / "styles.json").read_text(encoding="utf-8"))
        cls.picks = json.loads((ROOT / "survey" / "picks.json").read_text(encoding="utf-8"))

    def test_style_count_matches_declared_total(self):
        self.assertEqual(len(self.styles["styles"]), self.styles["total"])

    def test_group_counts_add_up(self):
        self.assertEqual(sum(g["count"] for g in self.styles["groups"]), self.styles["total"])

    def test_ids_unique_and_well_formed(self):
        ids = [s["id"] for s in self.styles["styles"]]
        self.assertEqual(len(ids), len(set(ids)), "风格 id 有重复")
        for i in ids:
            self.assertRegex(i, r"^s\d{3}$")

    def test_chinese_names_unique(self):
        cn = [s["cn"] for s in self.styles["styles"]]
        dup = {x for x in cn if cn.count(x) > 1}
        self.assertFalse(dup, f"同名风格会混淆画像：{dup}")

    def test_every_style_has_keywords_and_colors(self):
        for s in self.styles["styles"]:
            self.assertTrue(s["kw"], f"{s['id']} 没有找图关键词")
            self.assertGreaterEqual(len(s["colors"]), 2, f"{s['id']} 色板不足")

    def test_referenced_images_exist(self):
        names = {s["img"] for s in self.styles["styles"] if s.get("img")}
        names |= {p["file"] for p in self.picks["picks"]}
        missing = [n for n in names if not (ROOT / "survey" / n).exists()]
        self.assertFalse(missing, f"缺图：{missing[:5]}")

    def test_image_kind_matches_reality(self):
        """imgKind=example 必须有图有图注；imgKind=none 必须真的没有图。"""
        for s in self.styles["styles"]:
            kind = s.get("imgKind")
            self.assertIn(kind, ("example", "none"), f"{s['id']} imgKind 非法")
            if kind == "example":
                self.assertTrue(s["img"], f"{s['id']} 标了 example 却没图")
                self.assertTrue(s.get("imgNote"), f"{s['id']} 有图却没写这张图实际是什么（等于没核实）")
            else:
                self.assertFalse(s["img"], f"{s['id']} 标了 none 却还挂着图")

    def test_example_images_are_not_shared_by_many_styles(self):
        """一张图最多服务 2 种风格——轮流贴图就是这次翻车的根因。"""
        from collections import Counter
        c = Counter(s["img"] for s in self.styles["styles"] if s.get("img"))
        over = {k: v for k, v in c.items() if v > 2}
        self.assertFalse(over, f"一张图被贴给太多种风格：{over}")

    def test_image_policy_is_documented(self):
        self.assertIn("image_policy", self.styles, "缺 image_policy 说明配图规则")

    def test_generated_js_matches_json(self):
        """styles.js 由 styles.json 生成，不能各说各话。"""
        rc = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_survey_js.py"), "--check"],
                            capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(rc.returncode, 0, rc.stdout)


class TestSurveyPageContract(unittest.TestCase):
    """调研页导出的 JSON 字段必须和 merge 期待的完全一致——这是跨语言的接口。"""

    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "survey" / "index.html").read_text(encoding="utf-8")

    def test_export_button_exists(self):
        self.assertIn('id="btn-json"', self.html)
        self.assertIn("__surveyExport", self.html)

    def test_export_payload_covers_merge_inputs(self):
        block = self.html[self.html.index("window.__surveyExport"):]
        end = block.index("keywords:kws") + len("keywords:kws")
        block = block[: end]
        for key in ("kind", "generated", "answers", "style_likes", "image_likes",
                    "dims", "palette", "keywords"):
            self.assertIn(key, block, f"导出缺 {key}，merge 会读不到")
        self.assertIn("aesthetic-profile-survey", block)

    def test_no_remote_asset_dependency(self):
        """允许外链跳转，但不许 <script src=http> / <img src=http>，否则离线打开就废。"""
        remote_scripts = re.findall(r'<script[^>]+src="https?://', self.html)
        remote_imgs = re.findall(r'<img[^>]+src="https?://', self.html)
        self.assertEqual(remote_scripts, [], "不能依赖远程脚本")
        self.assertEqual(remote_imgs, [], "不能依赖远程图片")


if __name__ == "__main__":
    unittest.main(verbosity=2)
