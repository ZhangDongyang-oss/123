#!/usr/bin/env python3
"""
灯具领域 FC 可行性分析报告生成器

基于 FC Copilot analyzer.py 改造，专用于灯具。
输入: search_similar_issues 返回的 hits 列表
输出: 结构化可行性分析报告（根因 / 修改方向 / 数值线索 / 一句话总结）

纯规则、无 LLM、无网络副作用。

用法:
    from lighting_analyzer import generate_report
    report = generate_report(hits, query="尾灯色差", area="EXT-Rear End")
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
PATTERNS_FILE = BASE_DIR / "database" / "lighting_patterns.json"


@lru_cache(maxsize=1)
def _load_patterns() -> list[dict]:
    if not PATTERNS_FILE.exists():
        return []
    return json.loads(PATTERNS_FILE.read_text(encoding="utf-8")).get("patterns", [])


def _dominant_area_type(hits: list[dict]) -> tuple[str | None, str | None]:
    areas = Counter(h.get("area") for h in hits if h.get("area"))
    types = Counter(h.get("problem_type") for h in hits if h.get("problem_type"))
    area = areas.most_common(1)[0][0] if areas else None
    ptype = types.most_common(1)[0][0] if types else None
    return area, ptype


# 灯具工程动词归类
_VERB_PATTERNS = [
    ("调整", ["调整", "修改", "改动", "重新设计", "更改", "调改"]),
    ("增加", ["增加", "新增", "添加", "增设", "增大", "扩大", "加宽", "加深", "加厚"]),
    ("减小", ["减小", "缩小", "缩短", "降低", "减少", "变窄", "变薄"]),
    ("优化", ["优化", "改善", "改进", "完善"]),
    ("避让", ["避让", "避开", "回避", "让位", "避免"]),
    ("更换", ["更换", "替换", "切换"]),
    ("加强", ["加强", "强化", "增强"]),
    ("取消", ["取消", "去掉", "移除", "删除"]),
    ("参考", ["参考", "follow", "依照", "按照", "依据"]),
    ("保证", ["保证", "确保", "保持", "维持", "需要", "必须"]),
    ("建议", ["建议", "推荐", "拟"]),
    ("对策", ["对策", "方案"]),
    # 灯具特有动词
    ("配光", ["配光", "调整焦距", "光学面型"]),
    ("密封", ["密封", "防水", "透气"]),
    ("散热", ["散热", "热管理", "降功率"]),
    ("固定", ["固定", "卡接", "螺接", "紧固"]),
]


def cluster_root_causes(hits: list[dict]) -> dict:
    """
    返回:
    {
      "source": "patterns" | "keywords" | "empty",
      "causes": [{"cause": str, "frequency": int, "example_keys": [..]}],
      "levels": {"primary": [...], "secondary": [...], "edge": [...]},
      "note": ""
    }
    """
    if not hits:
        return {"source": "empty", "causes": [], "levels": {}, "note": ""}

    area, ptype = _dominant_area_type(hits)

    # 优先级 1: patterns.json 命中
    if area and ptype:
        for p in _load_patterns():
            if p.get("area") == area and p.get("problem_type") == ptype:
                related = p.get("related_issues") or [h["key"] for h in hits[:3]]
                causes = [
                    {"cause": cause, "frequency": None, "example_keys": related[:3]}
                    for cause in p.get("common_causes", [])
                ]
                return {
                    "source": "patterns",
                    "causes": causes,
                    "levels": _classify_levels(causes),
                    "note": f"来自 {area} / {ptype} 已沉淀根因模板",
                }

    # 优先级 2: 关键词聚合
    kw_to_keys: dict[str, list[str]] = defaultdict(list)
    for h in hits:
        for kw in h.get("keywords") or []:
            kw_to_keys[kw].append(h["key"])
    if kw_to_keys:
        ranked = sorted(kw_to_keys.items(), key=lambda x: -len(x[1]))[:8]
        causes = [
            {"cause": kw, "frequency": len(keys), "example_keys": keys[:3]}
            for kw, keys in ranked
        ]
        return {
            "source": "keywords",
            "causes": causes,
            "levels": _classify_levels(causes),
            "note": "⚠️ 该区域暂未沉淀根因模板，下方为命中案例的高频关键词聚合",
        }

    # 优先级 3: root_cause 字段聚合（本地案例库兜底）
    rc_to_keys: dict[str, list[str]] = defaultdict(list)
    for h in hits:
        rc = (h.get("root_cause") or "").strip()
        if rc:
            rc_to_keys[rc].append(h.get("key", ""))
    if rc_to_keys:
        ranked = sorted(rc_to_keys.items(), key=lambda x: -len(x[1]))[:8]
        causes = [
            {"cause": rc, "frequency": len(keys), "example_keys": keys[:3]}
            for rc, keys in ranked
        ]
        return {
            "source": "root_cause",
            "causes": causes,
            "levels": _classify_levels(causes),
            "note": "来自命中案例的根因字段聚合",
        }

    return {"source": "empty", "causes": [], "levels": {}, "note": "命中案例未提取到关键词"}


def _classify_levels(causes: list[dict]) -> dict:
    if not causes:
        return {"primary": [], "secondary": [], "edge": []}
    freqs = [c.get("frequency") for c in causes]
    if all(f is None for f in freqs):
        return {"primary": causes, "secondary": [], "edge": []}
    valid = [f for f in freqs if f is not None]
    if not valid:
        return {"primary": causes, "secondary": [], "edge": []}
    max_f = max(valid)
    primary, secondary, edge = [], [], []
    for c in causes:
        f = c.get("frequency")
        if f is None:
            primary.append(c)
        elif f >= max_f * 0.67:
            primary.append(c)
        elif f >= max_f * 0.34:
            secondary.append(c)
        else:
            edge.append(c)
    return {"primary": primary, "secondary": secondary, "edge": edge}


_LEADING_PHRASES = ["建议", "推荐", "拟", "对策：", "对策:", "对策", "方案：", "方案:", "方案", "需要", "必须"]


def _strip_leading(text: str) -> str:
    s = text.strip()
    s = re.sub(r"^\d+[\.\、\)）]\s*", "", s)
    for ph in _LEADING_PHRASES:
        if s.startswith(ph):
            s = s[len(ph):].lstrip("，,：: 、")
            break
    return s


def extract_modification_directions(hits: list[dict]) -> list[dict]:
    """扫描 solution 做动词归类。"""
    bucket: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for h in hits:
        sol_raw = (h.get("solution") or "").strip()
        if not sol_raw:
            continue
        sol = _strip_leading(sol_raw)
        first_60 = sol[:60].replace("\r", " ").replace("\n", " ")
        matched = None
        for canonical, prefixes in _VERB_PATTERNS:
            for p in prefixes:
                if p in first_60[:15]:
                    matched = canonical
                    break
            if matched:
                break
        if matched:
            bucket[matched].append((h["key"], first_60))
        else:
            bucket["其他"].append((h["key"], first_60))

    out = []
    for verb, items in bucket.items():
        out.append({
            "verb": verb,
            "count": len(items),
            "examples": [
                {"key": k, "snippet": s + ("…" if len(s) >= 60 else "")}
                for k, s in items[:3]
            ],
        })
    out.sort(key=lambda x: -x["count"])
    return out[:6]


# 数值提取
_NUM_RE = re.compile(
    r"(?P<op>≥|≤|>|<|大于|小于|不超过|不少于|至少|最大|最小|约|约为)?\s*"
    r"(?P<num>\d+(?:\.\d+)?)\s*"
    r"(?P<unit>mm|cm|度|°|%|N\b|MPa|kg|秒|s\b|分钟|℃|dB|lm|lux|cd|K\b)"
)
_UNIT_RANGES = {
    "mm": (0.1, 500), "cm": (0.1, 200), "度": (0.1, 360), "°": (0.1, 360),
    "%": (0.1, 100), "N": (0.1, 10000), "MPa": (0.01, 1000), "kg": (0.01, 1000),
    "秒": (0.01, 600), "s": (0.01, 600), "分钟": (0.01, 600),
    "℃": (-60, 200), "dB": (0.1, 150), "lm": (1, 100000), "lux": (1, 100000),
    "cd": (0.1, 1000000), "K": (1000, 10000),
}


def extract_compromise_boundaries(hits: list[dict]) -> list[dict]:
    """从 solution 中提取数值线索。"""
    by_unit: dict[str, list[dict]] = defaultdict(list)
    for h in hits:
        sol = h.get("solution") or ""
        for m in _NUM_RE.finditer(sol):
            unit = m.group("unit")
            try:
                num = float(m.group("num"))
            except ValueError:
                continue
            lo, hi = _UNIT_RANGES.get(unit, (None, None))
            if lo is not None and (num < lo or num > hi):
                continue
            by_unit[unit].append({
                "op": m.group("op") or "=",
                "num": num,
                "unit": unit,
                "key": h.get("key", ""),
                "context": sol[max(0, m.start() - 20):m.end() + 20].replace("\n", " "),
            })

    out = []
    for unit, samples in by_unit.items():
        nums = [s["num"] for s in samples]
        out.append({
            "metric": unit,
            "samples": samples[:4],
            "min": min(nums),
            "max": max(nums),
        })
    return out


def generate_report(
    hits: list[dict],
    query: str = "",
    area: str | None = None,
    severity: str | None = None,
    phase: str | None = None,
) -> dict:
    """
    生成完整可行性分析报告。

    返回:
    {
      "summary": {...},
      "root_causes": {...},
      "modification_directions": [...],
      "compromise_boundaries": [...],
      "recommendation": str,
      "disclaimer": str,
    }
    """
    root_causes = cluster_root_causes(hits)
    directions = extract_modification_directions(hits)
    boundaries = extract_compromise_boundaries(hits)

    # 生成推荐方案
    recommendation = ""
    if hits:
        top = hits[0]
        sol = top.get("solution") or ""
        recommendation = f"基于 {len(hits)} 条相似案例，推荐方案（来源 {top.get('key','')}）：\n{sol[:200]}"
    else:
        recommendation = "暂无相似案例，建议工程师根据经验评估。"

    # 免责声明
    hit_count = len(hits)
    disclaimer = f"基于 {hit_count} 条历史案例分析"
    if hit_count < 3:
        disclaimer += "（样本量较少，仅供参考）"

    return {
        "summary": {
            "query": query,
            "area": area,
            "severity": severity,
            "phase": phase,
            "hit_count": hit_count,
        },
        "root_causes": root_causes,
        "modification_directions": directions,
        "compromise_boundaries": boundaries,
        "recommendation": recommendation,
        "disclaimer": disclaimer,
    }


def format_report_markdown(report: dict) -> str:
    """将报告 dict 格式化为 Markdown 文本。"""
    lines = []
    s = report["summary"]
    lines.append("## FC 可行性分析报告\n")
    lines.append(f"**查询**：{s.get('query', '')}")
    lines.append(f"**区域**：{s.get('area', '—')} | **严重度**：{s.get('severity', '—')} | **阶段**：{s.get('phase', '—')}")
    lines.append(f"**命中案例**：{s.get('hit_count', 0)} 条\n")

    # 根因
    rc = report["root_causes"]
    lines.append("### 根因分析\n")
    if rc["causes"]:
        levels = rc.get("levels", {})
        for level_name, level_key in [("主因", "primary"), ("次因", "secondary"), ("边缘因", "edge")]:
            items = levels.get(level_key, [])
            if items:
                lines.append(f"**{level_name}**：")
                for c in items:
                    freq = c.get("frequency")
                    freq_str = f"（{freq}次）" if freq else ""
                    lines.append(f"- {c['cause']}{freq_str}")
                lines.append("")

    # 修改方向
    dirs = report["modification_directions"]
    if dirs:
        lines.append("### 工程修改方向\n")
        lines.append("| 方向 | 次数 | 示例 |")
        lines.append("|------|------|------|")
        for d in dirs:
            ex = d["examples"][0]["snippet"] if d["examples"] else ""
            lines.append(f"| {d['verb']} | {d['count']} | {ex} |")
        lines.append("")

    # 数值线索
    bounds = report["compromise_boundaries"]
    if bounds:
        lines.append("### 量化数值线索\n")
        lines.append("| 指标 | 范围 | 来源 |")
        lines.append("|------|------|------|")
        for b in bounds:
            keys = ", ".join(s["key"] for s in b["samples"][:2])
            lines.append(f"| {b['metric']} | {b['min']}~{b['max']} | {keys} |")
        lines.append("")

    # 推荐方案
    lines.append("### 推荐方案\n")
    lines.append(report.get("recommendation", ""))

    # 免责
    lines.append(f"\n---\n*{report.get('disclaimer', '')}*")

    return "\n".join(lines)


def build_advice_context(
    report: dict,
    hits: list[dict],
    query: str = "",
    severity: str | None = None,
    source: str = "local",
) -> dict:
    """
    把 generate_report 的结构化结果转成「工程师建议」栏可直接渲染的内容。

    返回:
    {
      "root_causes": [{"text": str, "level": "primary|secondary|edge"}],
      "directions": [str],    # 解决方向
      "boundaries": [str],    # 边界条件（量化线索）
      "suggestions": [str],   # 操作建议（规则生成，永不为空地兜底）
    }
    """
    # ── 根因 ──
    root_causes: list[dict] = []
    rc = report.get("root_causes") or {}
    if isinstance(rc, dict):
        levels = rc.get("levels", {})
        level_of: dict[str, str] = {}
        for lv in ("primary", "secondary"):
            for c in levels.get(lv, []):
                level_of.setdefault(c.get("cause", ""), lv)
        for c in rc.get("causes", []):
            text = (c.get("cause") or "").strip()
            if not text:
                continue
            freq = c.get("frequency")
            freq_str = f"（{freq} 例）" if freq else ""
            keys = c.get("example_keys") or []
            key_str = f"，如 {keys[0]}" if keys else ""
            root_causes.append({
                "text": f"{text}{freq_str}{key_str}",
                "level": level_of.get(text, "edge"),
            })

    # ── 解决方向 ──
    directions: list[str] = []
    for d in report.get("modification_directions") or []:
        if isinstance(d, dict):
            verb = d.get("verb") or d.get("direction") or ""
            count = d.get("count")
            examples = d.get("examples") or []
            ex_str = ""
            if examples:
                e = examples[0]
                ex_str = f"，如「{(e.get('snippet') or '').strip()[:50]}」（{e.get('key', '')}）"
            count_str = f"（{count} 例）" if count else ""
            if verb:
                directions.append(f"{verb}{count_str}{ex_str}")
        else:
            directions.append(str(d))

    # ── 边界条件 ──
    boundaries: list[str] = []
    for b in report.get("compromise_boundaries") or []:
        if isinstance(b, dict):
            metric = b.get("metric") or ""
            lo, hi = b.get("min"), b.get("max")
            keys = ", ".join(s.get("key", "") for s in (b.get("samples") or [])[:2] if s.get("key"))
            range_str = f"{lo}" if lo == hi else f"{lo}~{hi}"
            src = f"（来源：{keys}）" if keys else ""
            if metric:
                boundaries.append(f"{metric} 历史范围 {range_str}{src}，新方案需满足同类指标")
        else:
            boundaries.append(str(b))

    # ── 操作建议（规则生成） ──
    suggestions: list[str] = []
    n = len(hits)
    if n:
        top = hits[0]
        score = top.get("score")
        key = top.get("key", "")
        if isinstance(score, (int, float)) and score > 0:
            pct = int(round(score * 100)) if score <= 1 else int(score)
            if pct >= 60:
                suggestions.append(f"与历史案例 {key} 高度相似（{pct}%），可优先参考该案例解决方案，并核对车型/阶段差异点。")
            elif pct >= 35:
                suggestions.append(f"与案例 {key} 中度相似（{pct}%），建议对比问题背景与边界条件后再参考其方案。")
            else:
                suggestions.append(f"最相似案例 {key} 相似度仅 {pct}%，建议以工程师经验评估为主、历史案例为辅。")
        if n < 3:
            suggestions.append(f"命中样本较少（{n} 条），建议在描述中补充区域、现象与触发条件后重新检索。")
        else:
            suggestions.append(f"已命中 {n} 条相似案例，样本量可作为方案评审参考依据。")
        sev_lvl = str(severity or "").strip()
        if sev_lvl and sev_lvl[0] in ("S", "A"):
            suggestions.append("该问题严重度较高，建议尽快组织 DRE 与供应商评审，并纳入跟踪直至闭环。")
        if root_causes:
            top_causes = "、".join(c["text"].split("（")[0] for c in root_causes[:3])
            suggestions.append(f"建议优先排查高频根因方向：{top_causes}。")
        if directions:
            first_verb = directions[0].split("（")[0]
            suggestions.append(f"历史案例最常用的整改手段为「{first_verb}」，可作为方案起点。")
        if boundaries:
            suggestions.append("注意历史案例中的量化边界（见上方边界条件），方案验证需覆盖同类指标。")
        if source == "viim":
            suggestions.append("案例来自 VIIM 实时检索，点击工单号可查看完整处理过程与附件。")
        else:
            suggestions.append("案例来自本地案例库（量产灯问题清单），如需最新进展请到 VIIM 中核对。")
    else:
        suggestions.append("未命中相似案例：建议在描述中补充区域（如前灯/尾灯）、现象与触发条件后重试。")
        suggestions.append("如已配置 VIIM Token，请确认 Token 有效以启用实时检索扩大案例范围。")

    return {
        "root_causes": root_causes,
        "directions": directions,
        "boundaries": boundaries,
        "suggestions": suggestions,
    }


# ---------- CLI ----------
if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(BASE_DIR / "scripts"))
    from lighting_search import search_similar_issues

    query = sys.argv[1] if len(sys.argv) > 1 else "前灯起雾"
    hits = search_similar_issues(query=query, top=5)
    report = generate_report(hits, query=query)
    print(format_report_markdown(report))
