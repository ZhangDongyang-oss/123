#!/usr/bin/env python3
"""FC 可行性分析 — 核心管线单元测试。
缺 jieba/flask 的环节自动跳过，保证裸环境也能跑。

运行: python -m unittest discover -s tests -v   （仓库根目录）
"""
import os
import sys
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, "scripts"))
sys.path.insert(0, os.path.join(BASE_DIR, "webapp"))

try:
    import jieba  # noqa: F401
    HAS_JIEBA = True
except ImportError:
    HAS_JIEBA = False

try:
    import flask  # noqa: F401
    HAS_FLASK = True
except ImportError:
    HAS_FLASK = False


class TestExtractor(unittest.TestCase):
    @unittest.skipUnless(HAS_JIEBA, "jieba not installed")
    def test_area_detection(self):
        from lighting_extractor import extract_fields
        f = extract_fields("尾灯色差，夜间亮度不足")
        self.assertEqual(f["viim_area"], "EXT-Rear End")
        f2 = extract_fields("前灯起雾，洗车后灯罩内凝露")
        self.assertEqual(f2["viim_area"], "EXT-Front End")

    @unittest.skipUnless(HAS_JIEBA, "jieba not installed")
    def test_phase_detection(self):
        from lighting_extractor import extract_fields
        f = extract_fields("CAS2 阶段仪表板除霜开口问题")
        self.assertEqual(f["viim_phase"], "CAS2")


class TestSearch(unittest.TestCase):
    @unittest.skipUnless(HAS_JIEBA, "jieba not installed")
    def test_search_returns_hits(self):
        from lighting_search import search_similar_issues
        hits = search_similar_issues(query="前灯起雾，洗车后灯罩内凝露", top=5)
        self.assertGreater(len(hits), 0)
        scores = [h.get("score", 0) for h in hits]
        self.assertEqual(scores, sorted(scores, reverse=True))

    @unittest.skipUnless(HAS_JIEBA, "jieba not installed")
    def test_breakdown_sums_to_score(self):
        from lighting_search import search_similar_issues
        hits = search_similar_issues(query="前灯起雾，洗车后灯罩内凝露", top=3)
        for h in hits:
            bd = h.get("breakdown") or {}
            self.assertAlmostEqual(sum(bd.values()), h["score"], delta=0.01)


class TestAnalyzer(unittest.TestCase):
    @unittest.skipUnless(HAS_JIEBA, "jieba not installed")
    def test_report_and_advice(self):
        from lighting_search import search_similar_issues
        from lighting_analyzer import generate_report, build_advice_context
        q = "尾灯起雾"
        hits = search_similar_issues(query=q, top=5)
        rep = generate_report(hits, query=q)
        for key in ("root_causes", "modification_directions", "recommendation"):
            self.assertIn(key, rep)
        adv = build_advice_context(rep, hits, query=q, source="local")
        self.assertGreater(len(adv["suggestions"]), 0, "操作建议不应为空")


class TestWebHelpers(unittest.TestCase):
    @unittest.skipUnless(HAS_FLASK, "flask not installed")
    def test_confidence_bounds(self):
        import main as M
        conf = M._field_confidence("前灯起雾，CAS2，紧急", {})
        for k in ("overall", "area", "severity", "phase", "urgency"):
            self.assertTrue(0 <= conf[k] <= 1)

    @unittest.skipUnless(HAS_FLASK, "flask not installed")
    def test_payload_single_entry(self):
        import main as M
        from lighting_extractor import extract_fields
        f = extract_fields("尾灯密封不良")
        p = M._build_viim_payload(f)
        self.assertIn("additional_fields", p)
        self.assertEqual(p["additional_fields"]["customfield_13088"]["value"], f["viim_area"])


class TestPaginationAndReview(unittest.TestCase):
    @unittest.skipUnless(HAS_FLASK and HAS_JIEBA, "flask/jieba not installed")
    def test_history_pagination(self):
        import json
        import tempfile
        from pathlib import Path
        import main as M
        tmp = Path(tempfile.mkdtemp())
        (tmp / "s.json").write_text(json.dumps({"submissions": [
            {"issue_key": f"DIR-T{i:02d}", "summary": f"t{i}", "status": "已提交",
             "submitted_at": f"2026-07-{(i % 27) + 1:02d}T10:00:00", "url": "#"}
            for i in range(25)]}), encoding="utf-8")
        (tmp / "d.json").write_text(json.dumps({"drafts": []}), encoding="utf-8")
        old_s, old_d = M.SUBMISSIONS_FILE, M.DRAFTS_FILE
        M.SUBMISSIONS_FILE, M.DRAFTS_FILE = tmp / "s.json", tmp / "d.json"
        try:
            with M.app.test_request_context("/api/history/list?page=1"):
                p1 = M.api_history_list()
            with M.app.test_request_context("/api/history/list?page=2"):
                p2 = M.api_history_list()
            self.assertEqual(p1.count("data-key="), 20)
            self.assertIn("加载更多", p1)
            self.assertEqual(p2.count("data-key="), 5)
            self.assertNotIn("<table>", p2)
        finally:
            M.SUBMISSIONS_FILE, M.DRAFTS_FILE = old_s, old_d

    @unittest.skipUnless(HAS_FLASK and HAS_JIEBA, "flask/jieba not installed")
    def test_review_context(self):
        import main as M
        with M.app.test_request_context("/review", method="POST"):
            ctx = M._review_context("前灯起雾，洗车后灯罩内凝露")
        for k in ("fields", "confidence", "hits", "report", "advice", "payload"):
            self.assertIn(k, ctx)
        self.assertGreater(len(ctx["advice"]["suggestions"]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
