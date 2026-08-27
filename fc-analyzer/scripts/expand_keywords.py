#!/usr/bin/env python3
"""关键词字典自学习：从案例库/反馈/VIIM 挖掘词典缺失的高频词。

用法:
    python scripts/expand_keywords.py                 # 出候选报告（不改字典）
    python scripts/expand_keywords.py --min-df 3      # 提高门槛（默认 2）
    python scripts/expand_keywords.py --apply         # 把候选写进 lighting_keywords.json
    python scripts/expand_keywords.py --viim          # 语料加上 VIIM 最近工单（需 token）

原理：jieba 分词统计文档频率(df) → 去掉已收录/停用词 → 启发式归类
（零件/症状/条件/光学/法规/区域）→ 报告或写库。写库会 bump meta.version。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

BASE = Path(__file__).parent.parent
DB = BASE / "database"
KW_FILE = DB / "lighting_keywords.json"

sys.path.insert(0, str(BASE / "scripts"))
import jieba

_TOKEN_RE = re.compile(r"^[一-龥A-Za-z0-9]+$")
_STOP = {"问题", "存在", "建议", "需要", "如下", "如图", "目前", "当前", "出现", "导致",
         "影响", "整体", "情况", "进行", "考虑", "可能", "所示", "状态", "数据", "本案",
         "针对", "方案", "对策", "采用", "整改", "措施", "确认", "要求", "设计", "造型",
         "工程师", "客户", "市场", "车辆", "整车", "项目", "阶段", "节点", "时间",
         "试验", "测试", "盖上", "右后", "左后", "点灯", "灯饰", "一个", "本次", "该问题"}

# 启发式归类（按优先级）
RULES = [
    ("standard",  re.compile(r"GB|ECE|SAE|FMVSS|ISO|法规|标准|认证")),
    ("optical",   re.compile(r"亮度|光强|色温|色坐标|配光|均匀性|眩光|截止线|cutoff|流明|照度|透过率|反射率|光型|光束")),
    ("symptom",   re.compile(r"雾|裂|断|色差|衰|暗|亮|闪|灭|偏移|不均|超标|不足|进水|气泡|划伤|白斑|黑边|变形|松动|脱落|腐蚀|起雾|频闪|光衰|漏光|点亮")),
    ("part",      re.compile(r"灯|罩|壳|盖|框|座|阀|模组|线束|接头|支架|饰圈|基板|驱动|透镜|反射|导光|PCB|连接器|电路板|透镜组")),
    ("condition", re.compile(r"后$|时$|中$|高温|低温|振动|冲击|盐雾|洗车|下雨|点灯|开关|启动|行驶|装配|运输|试验|测试")),
    ("area",      re.compile(r"^(前|尾|后|侧|顶|内饰|牌照|前备箱|后备箱).{0,3}灯")),
]


def load_corpus(use_viim: bool) -> list[dict]:
    issues = json.loads((DB / "lighting_issues.json").read_text(encoding="utf-8")).get("issues", [])
    if use_viim:
        try:
            sys.path.insert(0, str(BASE / "webapp"))
            from viim_client import VIIMClient
            c = VIIMClient()
            raw = c.search_issues(jql="project = DEMODIR ORDER BY created DESC",
                                  fields=["summary", "description"], max_results=200)
            for it in raw:
                f = it.get("fields", {}) or {}
                issues.append({"key": it.get("key", ""), "summary": f.get("summary") or "",
                               "description": (f.get("description") or "")[:500],
                               "solution": "", "source": "viim"})
            print(f"[info] VIIM 语料 +{len(raw)} 条")
        except Exception as e:
            print(f"[warn] VIIM 不可用，仅本地语料: {e}")
    return issues


def existing_terms(kw: dict) -> set[str]:
    out = set()
    for grp in ("area_keywords", "part_keywords", "problem_keywords",
                "trigger_keywords", "standard_keywords", "symptom_severity"):
        v = kw.get(grp, {})
        if isinstance(v, dict):
            for words in v.values():
                out.update(words)
        elif isinstance(v, list):
            out.update(v)
    out.update(kw.get("relation_words", []))
    return out


def classify(word: str) -> str | None:
    for name, rx in RULES:
        if rx.search(word):
            return name
    return None


def mine(min_df: int, use_viim: bool) -> list[dict]:
    kw = json.loads(KW_FILE.read_text(encoding="utf-8"))
    have = existing_terms(kw)
    issues = load_corpus(use_viim)

    df: Counter = Counter()
    examples: dict[str, list[str]] = {}
    for i in issues:
        text = f"{i.get('summary') or ''} {i.get('description') or ''} {i.get('solution') or ''}"
        toks = {t for t in jieba.cut(text) if len(t) >= 2 and _TOKEN_RE.match(t) and t not in _STOP}
        for t in toks:
            df[t] += 1
            if t not in have and len(examples.get(t, [])) < 3:
                examples.setdefault(t, []).append(i.get("key", ""))

    cands = []
    for word, n in df.most_common():
        if n < min_df or word in have:
            continue
        cat = classify(word)
        if not cat:
            continue
        cands.append({"word": word, "df": n, "cat": cat, "examples": examples.get(word, [])})
    return cands


# 归类 → 字典桶
BUCKET = {
    "symptom": ("problem_keywords", "mechanical"),
    "optical": ("problem_keywords", "optical"),
    "part": ("part_keywords", "structural"),
    "condition": ("trigger_keywords", "environment"),
    "standard": ("standard_keywords", "regulations"),
    "area": ("area_keywords", "front_light"),
}


def apply(cands: list[dict]):
    kw = json.loads(KW_FILE.read_text(encoding="utf-8"))
    added = 0
    for c in cands:
        grp, sub = BUCKET[c["cat"]]
        bucket = kw.setdefault(grp, {}).setdefault(sub, [])
        if c["word"] not in bucket:
            bucket.append(c["word"])
            added += 1
    kw.setdefault("meta", {})["version"] = str(float(kw.get("meta", {}).get("version", "1.0")) + 0.1)
    KW_FILE.write_text(json.dumps(kw, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] 写入 {added} 个新词，version → {kw['meta']['version']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-df", type=int, default=2)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--viim", action="store_true")
    ap.add_argument("--top", type=int, default=60)
    args = ap.parse_args()

    cands = mine(args.min_df, args.viim)
    if args.apply:
        apply(cands)
        return

    print(f"# 候选新词（df≥{args.min_df}，共 {len(cands)} 个，展示前 {args.top}）\n")
    cur = None
    for c in cands[:args.top]:
        if c["cat"] != cur:
            cur = c["cat"]
            print(f"\n## {cur}")
        print(f"- **{c['word']}**  df={c['df']}  例: {', '.join(c['examples'])}")


if __name__ == "__main__":
    main()
