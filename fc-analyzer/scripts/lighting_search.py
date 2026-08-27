#!/usr/bin/env python3
"""
灯具领域历史相似案例检索

基于 FC Copilot search_similar_issues.py 改造，专用于灯具 FC 问题。
jieba 分词 + TF-IDF 余弦相似度 + 灯具特有特征维度加分。

用法:
    python lighting_search.py "尾灯色差高温LED色温偏移"
    python lighting_search.py "前灯起雾" --area EXT-Front End --top 10 --json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path

import jieba

SCRIPT_DIR = Path(__file__).parent
DATABASE_DIR = SCRIPT_DIR.parent / "database"
KEYWORDS_FILE = DATABASE_DIR / "lighting_keywords.json"

# ---------- 特征维度权重（灯具优化版）----------
BONUS_SYMPTOM = 0.35      # 症状词：提升，光学术语更关键
BONUS_PART = 0.25         # 零件词
BONUS_AREA = 0.10         # 区域：降低，灯具区域相对集中
BONUS_CONDITION = 0.05    # 条件词
BONUS_RELATION = 0.10     # 结构关系词
BONUS_OPTICAL = 0.15      # 【新增】光学特性权重
BONUS_STANDARD = 0.08     # 【新增】法规标准权重
W_TEXT = 0.20             # TF-IDF 基础权重（降低，灯具案例少）

# 只使用人工撰写的方案
QUALITY_WEIGHT = {"human": 1.0}

# 分词过滤
_TOKEN_RE = re.compile(r"^[一-龥A-Za-z0-9]+$")
_STOPWORDS = {
    "问题", "存在", "建议", "需要", "如下", "如图", "目前", "当前", "出现",
    "导致", "影响", "整体", "情况", "进行", "考虑", "可能", "如图所示",
    "所示", "状态", "数据", "本案", "针对", "方案", "对策", "采用",
}
_RELATION_WORDS = {"搭接", "配合", "衔接", "对接", "贴合", "间隙", "干涉",
                   "重叠", "嵌入", "卡接", "螺接", "焊接", "粘接", "密封配合"}


_keywords_cache = None
_keywords_mtime = 0.0

def _load_keywords() -> dict:
    global _keywords_cache, _keywords_mtime
    try:
        mtime = os.path.getmtime(KEYWORDS_FILE)
    except OSError:
        mtime = 0.0
    if _keywords_cache is not None and mtime == _keywords_mtime:
        return _keywords_cache
    if KEYWORDS_FILE.exists():
        _keywords_cache = json.loads(KEYWORDS_FILE.read_text(encoding="utf-8"))
    else:
        _keywords_cache = {}
    _keywords_mtime = mtime
    return _keywords_cache


def _get_keyword_sets() -> tuple[set, set, set, set, set]:
    """返回 (symptom_words, part_words, condition_words, optical_words, standard_words)"""
    kw = _load_keywords()

    symptom_words = set()
    for words in kw.get("problem_keywords", {}).values():
        symptom_words.update(words)

    part_words = set()
    for words in kw.get("part_keywords", {}).values():
        part_words.update(words)

    condition_words = set()
    for words in kw.get("trigger_keywords", {}).values():
        condition_words.update(words)

    optical_words = set(kw.get("standard_keywords", {}).get("test_items", []))
    optical_words.update(symptom_words)  # 光学症状也算光学特性

    standard_words = set(kw.get("standard_keywords", {}).get("regulations", []))

    return symptom_words, part_words, condition_words, optical_words, standard_words


def _tokenize(text: str) -> list[str]:
    out = []
    for w in jieba.cut(text or ""):
        w = w.strip()
        if len(w) < 2:
            continue
        if not _TOKEN_RE.match(w):
            continue
        if w in _STOPWORDS:
            continue
        out.append(w)
    return out


def _attention_profile(query: str, query_kw: dict[str, list[str]]) -> dict[str, float]:
    """轻量注意力机制 — 灯具版本，新增光学和法规维度。"""
    tokens = _tokenize(query)
    relation_hits = [t for t in tokens if t in _RELATION_WORDS or any(r in t for r in _RELATION_WORDS)]
    profile = {
        "symptom": 1.0 + min(len(set(query_kw.get("symptom") or [])), 2) * 0.18,
        "part": 1.0 + min(len(set(query_kw.get("part") or [])), 3) * 0.15,
        "condition": 1.0 + min(len(set(query_kw.get("condition") or [])), 2) * 0.10,
        "relation": 1.0 + min(len(set(relation_hits)), 2) * 0.25,
        "optical": 1.0 + min(len(set(query_kw.get("optical") or [])), 2) * 0.20,
        "standard": 1.0 + min(len(set(query_kw.get("standard") or [])), 1) * 0.30,
        "text": 1.0,
    }
    # 短句中每个关键词更关键
    if len(tokens) <= 6:
        for k in profile:
            profile[k] *= 1.08
    elif len(tokens) >= 18:
        for k in profile:
            profile[k] *= 0.95
    return profile


def _classify_keywords(text: str) -> dict[str, list[str]]:
    """将文本分词后按特征维度分类返回。"""
    symptom_words, part_words, condition_words, optical_words, standard_words = _get_keyword_sets()
    tokens = _tokenize(text)
    result = {"symptom": [], "part": [], "condition": [], "optical": [], "standard": []}
    for t in tokens:
        if t in symptom_words:
            result["symptom"].append(t)
        elif t in part_words:
            result["part"].append(t)
        elif t in condition_words:
            result["condition"].append(t)
        if t in optical_words:
            result["optical"].append(t)
        if t in standard_words:
            result["standard"].append(t)
    return result


_corpus_cache = None   # (issues, vectors, idf)
_corpus_path = None    # resolved Path
_corpus_mtime = 0.0

def _resolve_corpus_path(issues_file: str | None) -> Path | None:
    if issues_file:
        return Path(issues_file)
    for p in [DATABASE_DIR / "issues.json", DATABASE_DIR / "lighting_issues.json"]:
        if p.exists():
            return p
    return None

def _load_corpus(issues_file: str | None = None):
    """加载语料库，计算 TF-IDF 向量。文件未变化时使用缓存。"""
    global _corpus_cache, _corpus_path, _corpus_mtime

    resolved = _resolve_corpus_path(issues_file)
    if resolved is None:
        return [], [], {}

    try:
        mtime = os.path.getmtime(resolved)
    except OSError:
        mtime = 0.0

    if _corpus_cache is not None and resolved == _corpus_path and mtime == _corpus_mtime:
        return _corpus_cache

    data = json.loads(resolved.read_text(encoding="utf-8"))

    issues = data.get("issues", [])
    issues = [i for i in issues if i.get("solution_quality") in QUALITY_WEIGHT]

    docs = []
    for i in issues:
        tokens = _tokenize(f"{i.get('summary','')} {i.get('description','')[:500]}")
        docs.append(tokens)

    N = len(docs)
    df = Counter()
    for toks in docs:
        for t in set(toks):
            df[t] += 1
    idf = {t: math.log((N + 1) / (c + 1)) + 1.0 for t, c in df.items()}

    vectors = []
    for toks in docs:
        tf = Counter(toks)
        if not tf:
            vectors.append(({}, 0.0))
            continue
        max_tf = max(tf.values())
        vec = {t: (0.5 + 0.5 * c / max_tf) * idf.get(t, 0.0) for t, c in tf.items()}
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        vectors.append((vec, norm))

    result = (issues, vectors, idf)
    _corpus_cache = result
    _corpus_path = resolved
    _corpus_mtime = mtime
    return result


def _query_vector(query: str, idf: dict[str, float]):
    toks = _tokenize(query)
    if not toks:
        return {}, 0.0
    tf = Counter(toks)
    max_tf = max(tf.values())
    vec = {t: (0.5 + 0.5 * c / max_tf) * idf.get(t, 0.0) for t, c in tf.items()}
    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    return vec, norm


def _cosine(qv, qn, dv, dn):
    if not qv or not dv:
        return 0.0
    if len(qv) < len(dv):
        small, large = qv, dv
    else:
        small, large = dv, qv
    s = 0.0
    for t, v in small.items():
        u = large.get(t)
        if u:
            s += v * u
    return s / (qn * dn)


def _case_dedupe_key(issue: dict) -> str:
    text = f"{issue.get('summary') or ''} {issue.get('solution') or ''}"
    text = re.sub(r"DIR-\d+", "", text, flags=re.I)
    text = re.sub(r"【[^】]*】", "", text)
    text = re.sub(r"[\s，,。；;：:、（）()【】\-—_]+", "", text.lower())
    return text[:120]


def search_similar_issues(
    query: str,
    area: str | None = None,
    problem_type: str | None = None,
    top: int = 5,
    min_score: float = 0.05,
    issues_file: str | None = None,
) -> list[dict]:
    """检索历史相似案例。"""
    issues, vectors, idf = _load_corpus(issues_file)
    if not issues:
        return []

    qv, qn = _query_vector(query, idf)
    query_kw = _classify_keywords(query)
    attention = _attention_profile(query, query_kw)
    relation_tokens = [t for t in _tokenize(query) if t in _RELATION_WORDS]

    MIN_TEXT_SIM = 0.03
    scored = []

    # 本查询可达的理论上限：把加权累加分归一化到 0~1，
    # 避免吻合度显示超过 100%；同一查询除以同一常数，不改变排序。
    max_bonus = W_TEXT * attention["text"] + 0.08  # 文本基础 + 问题类型匹配
    if query_kw["symptom"]:
        max_bonus += (BONUS_SYMPTOM + 0.05) * attention["symptom"]
    if query_kw["part"]:
        max_bonus += BONUS_PART * attention["part"]
    if area or query_kw["part"]:
        max_bonus += BONUS_AREA
    if query_kw["condition"]:
        max_bonus += BONUS_CONDITION * attention["condition"]
    if relation_tokens:
        max_bonus += (BONUS_RELATION + 0.03) * attention["relation"]
    if query_kw["optical"]:
        max_bonus += (BONUS_OPTICAL + 0.06) * attention["optical"]
    if query_kw["standard"]:
        max_bonus += BONUS_STANDARD * attention["standard"]

    for issue, (dv, dn) in zip(issues, vectors):
        text_sim = _cosine(qv, qn, dv, dn)
        if text_sim < MIN_TEXT_SIM:
            continue

        bonus = 0.0
        bd = {"text": round(W_TEXT * attention["text"] * text_sim, 3)}
        issue_summary = issue.get("summary") or ""
        issue_solution = issue.get("solution") or ""
        issue_desc = issue.get("description") or ""
        issue_full = f"{issue_summary} {issue_solution[:400]} {issue_desc[:200]}"
        issue_area = issue.get("area") or ""
        issue_type = issue.get("problem_type") or ""

        def _add(key: str, value: float):
            nonlocal bonus
            bonus += value
            bd[key] = round(bd.get(key, 0) + value, 3)

        # 1) 症状词匹配
        if query_kw["symptom"]:
            match_count = sum(1 for sw in query_kw["symptom"] if sw in issue_full)
            if match_count > 0:
                _add("symptom", (BONUS_SYMPTOM + min(match_count - 1, 1) * 0.05) * attention["symptom"])

        # 2) 零件词匹配
        if query_kw["part"]:
            summary_match = any(pw in issue_summary for pw in query_kw["part"])
            full_match = any(pw in issue_full for pw in query_kw["part"])
            if summary_match:
                _add("part", BONUS_PART * attention["part"])
            elif full_match:
                _add("part", BONUS_PART * 0.6 * attention["part"])

        # 3) 区域匹配
        if area and issue_area == area:
            _add("area", BONUS_AREA)
        elif not area:
            part_area_map = {
                "前灯": "EXT-Front End", "大灯": "EXT-Front End", "透镜": "EXT-Front End",
                "反射器": "EXT-Front End",
                "尾灯": "EXT-Rear End", "后灯": "EXT-Rear End", "刹车灯": "EXT-Rear End",
                "侧转向灯": "EXT-Side&Roof&Door", "翼子板灯": "EXT-Side&Roof&Door",
                "氛围灯": "INT-Door Trim", "阅读灯": "INT-Door Trim",
            }
            for pw in query_kw["part"]:
                inferred = part_area_map.get(pw)
                if inferred and inferred == issue_area:
                    _add("area", BONUS_AREA * 0.7)
                    break

        # 4) 问题类型匹配
        if issue_type:
            type_symptom_map = {
                "光衰": "光衰", "色差": "色差", "亮度": "亮度",
                "起雾": "起雾", "进水": "进水", "开裂": "开裂",
                "脱胶": "脱胶", "松动": "松动", "变形": "变形",
                "频闪": "频闪", "配光": "配光",
            }
            for sw in query_kw["symptom"]:
                expected = type_symptom_map.get(sw)
                if expected and expected in issue_type:
                    _add("type", 0.08)
                    break

        # 5) 条件词匹配
        if query_kw["condition"]:
            if any(cw in issue_full for cw in query_kw["condition"]):
                _add("condition", BONUS_CONDITION * attention["condition"])

        # 6) 结构关系词匹配
        if relation_tokens:
            rel_matches = sum(1 for rw in relation_tokens if rw in issue_full)
            if rel_matches:
                _add("relation", (BONUS_RELATION + min(rel_matches - 1, 1) * 0.03) * attention["relation"])

        # 7) 光学特性匹配（灯具新增）
        if query_kw["optical"]:
            opt_matches = sum(1 for ow in query_kw["optical"] if ow in issue_full)
            if opt_matches:
                _add("optical", (BONUS_OPTICAL + min(opt_matches - 1, 2) * 0.03) * attention["optical"])

        # 8) 法规标准匹配（灯具新增）
        if query_kw["standard"]:
            std_matches = sum(1 for sw in query_kw["standard"] if sw in issue_full)
            if std_matches:
                _add("standard", BONUS_STANDARD * attention["standard"])

        raw = W_TEXT * attention["text"] * text_sim + bonus

        # 近似精确匹配：归一化后包含关系（一模一样的问题）→ 直接 95%
        nq = re.sub(r'[^一-鿿a-z0-9]', '', query.lower())
        ns = re.sub(r'[^一-鿿a-z0-9]', '', issue_summary.lower())
        if nq and ns and (nq == ns or nq in ns or ns in nq):
            raw = max(raw, 0.95 * max_bonus)
            bd = {"exact": 0.95}

        # 归一化到 0~1 后再乘质量权重
        score = (raw / max_bonus) * QUALITY_WEIGHT.get(issue.get("solution_quality"), 0.0)
        # breakdown 同步归一化，使分项求和 = score（exact 分支已是 0.95 无需处理）
        if "exact" not in bd and max_bonus > 0:
            bd = {k: round(v / max_bonus, 3) for k, v in bd.items()}
        if score >= min_score:
            scored.append((score, text_sim, issue, bd))

    scored.sort(key=lambda x: x[0], reverse=True)
    out = []
    seen_keys = set()
    for score, text_sim, issue, bd in scored:
        dedupe_key = _case_dedupe_key(issue)
        if dedupe_key and dedupe_key in seen_keys:
            continue
        if dedupe_key:
            seen_keys.add(dedupe_key)
        out.append({
            "key": issue.get("key", ""),
            "url": issue.get("url", ""),
            "summary": issue.get("summary", ""),
            "area": issue.get("area"),
            "problem_type": issue.get("problem_type"),
            "status": issue.get("status"),
            "solution": issue.get("solution"),
            "solution_quality": issue.get("solution_quality"),
            "keywords": issue.get("keywords") or [],
            "problem_images": issue.get("problem_images") or [],
            "fix_images": issue.get("fix_images") or [],
            "root_cause": issue.get("root_cause", ""),
            "project": issue.get("project", ""),
            "responsible": issue.get("responsible", ""),
            "score": round(score, 3),
            "text_similarity": round(text_sim, 3),
            "breakdown": {k: v for k, v in bd.items() if v > 0},
            "attention": {k: round(v, 3) for k, v in attention.items()},
        })
        if len(out) >= top:
            break

    return out


# ---------- CLI ----------
def main():
    ap = argparse.ArgumentParser(description="灯具 FC 历史案例检索")
    ap.add_argument("query", help="问题描述（自然语言）")
    ap.add_argument("--area", help="VIIM 区域（如 EXT-Front End）")
    ap.add_argument("--type", dest="problem_type", help="问题类型")
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--issues-file", help="指定 issues.json 路径")
    args = ap.parse_args()

    hits = search_similar_issues(
        query=args.query,
        area=args.area,
        problem_type=args.problem_type,
        top=args.top,
        issues_file=args.issues_file,
    )

    if args.json:
        print(json.dumps(hits, ensure_ascii=False, indent=2))
        return 0

    if not hits:
        print("未找到相似案例")
        return 0

    for h in hits:
        print(f"[{h['score']:.3f}|t={h['text_similarity']:.3f}] {h['key']}: {h['summary']}")
        print(f"    area={h['area']}  type={h['problem_type']}  status={h['status']}")
        sol = (h.get("solution") or "")[:120].replace("\n", " ")
        print(f"    sol: {sol}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
