"""
feedback.py — Phase 5: 反馈学习系统

核心功能：
1. 收集用户对抽取结果的纠正（区域/严重度/根因/方案）
2. 存储到 feedback.json（结构化反馈记录）
3. 基于反馈自动更新：关键词库 / 严重度规则 / 案例矩阵 / patterns
4. 反馈统计：准确率、高频错误、趋势
"""
import json
import os
import sys
from datetime import datetime
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "database")
FEEDBACK_FILE = os.path.join(DATA_DIR, "feedback.json")
LEARNING_LOG = os.path.join(DATA_DIR, "learning_log.json")
KEYWORDS_FILE = os.path.join(DATA_DIR, "lighting_keywords.json")
LEARNED_KW_FILE = os.path.join(DATA_DIR, "learned_keywords.json")  # 反馈学习关键词来源登记（可删管理）
ISSUES_FILE = os.path.join(DATA_DIR, "lighting_issues.json")
PATTERNS_FILE = os.path.join(DATA_DIR, "lighting_patterns.json")


def _load_json(path, default=None):
    if default is None:
        default = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ============================================================
# 1. 反馈收集
# ============================================================

def collect_feedback(fc_text, extracted, corrections, user_id=None, viim_key=None):
    """
    收集用户纠正。

    Args:
        fc_text: 原始 FC 描述
        extracted: 系统抽取结果 dict
        corrections: 用户纠正 dict，如 {"severity": "A", "area": "EXT-Front End"}
        user_id: 用户 ID（可选）
        viim_key: VIIM 工单号（可选）

    Returns:
        feedback_id
    """
    feedback = _load_json(FEEDBACK_FILE, {"feedbacks": [], "stats": {}})
    learning_log = _load_json(LEARNING_LOG, {"entries": []})

    feedback_id = f"FB-{datetime.now().strftime('%Y%m%d%H%M%S')}-{len(feedbacks := feedback['feedbacks']):04d}"

    # 比对抽取 vs 纠正，找出差异
    diffs = {}
    key_map = {"area": "viim_area", "severity": "viim_severity", "urgent": "viim_urgency",
               "stage": "viim_phase", "part": "part", "symptom": "symptom", "condition": "condition", "regulation": "regulation"}
    for corr_key, ext_key in key_map.items():
        old_val = extracted.get(ext_key, extracted.get(corr_key, ""))
        new_val = corrections.get(corr_key)
        if new_val is not None and str(new_val) != str(old_val):
            diffs[corr_key] = {"old": old_val, "new": new_val}

    # 反馈记录
    record = {
        "id": feedback_id,
        "timestamp": datetime.now().isoformat(),
        "fc_text": fc_text,
        "extracted": {k: extracted.get(k, extracted.get(f"viim_{k}", "")) for k in ["area", "severity", "urgent", "stage", "part", "symptom"]},
        "corrections": corrections,
        "diffs": diffs,
        "diff_count": len(diffs),
        "user_id": user_id,
        "viim_key": viim_key,
        "learning_applied": False
    }

    feedback["feedbacks"].append(record)

    # 更新统计
    stats = feedback.setdefault("stats", {})
    stats.setdefault("total", 0)
    stats.setdefault("corrections", 0)
    stats.setdefault("diffs", 0)
    stats.setdefault("field_accuracy", {})
    stats.setdefault("learning_runs", 0)
    stats["total"] += 1
    if diffs:
        stats["corrections"] += 1
        stats["diffs"] += len(diffs)
        for field in diffs:
            stats["field_accuracy"][field] = stats["field_accuracy"].get(field, {"correct": 0, "wrong": 0})
            stats["field_accuracy"][field]["wrong"] += 1
    for field in ["area", "severity", "urgent", "stage"]:
        if field not in diffs:
            stats["field_accuracy"][field] = stats["field_accuracy"].get(field, {"correct": 0, "wrong": 0})
            stats["field_accuracy"][field]["correct"] += 1

    _save_json(FEEDBACK_FILE, feedback)

    # 学习日志
    learning_log["entries"].append({
        "feedback_id": feedback_id,
        "timestamp": datetime.now().isoformat(),
        "diffs": diffs,
        "applied": False
    })
    _save_json(LEARNING_LOG, learning_log)

    return feedback_id


# ============================================================
# 2. 学习应用
# ============================================================

def apply_learning(min_feedbacks=5, dry_run=False):
    """
    批量应用反馈学习。

    规则：
    - 区域纠正 → 更新关键词库（增加区域关键词）
    - 严重度纠正 → 更新严重度规则关键词
    - 症状纠正 → 更新案例矩阵（新增案例）
    - 根因纠正 → 更新 patterns.json

    Args:
        min_feedbacks: 最小反馈数（低于此数不学习）
        dry_run: 预览模式

    Returns:
        learning_report dict
    """
    feedback = _load_json(FEEDBACK_FILE, {"feedbacks": [], "stats": {}})
    unlearned = [f for f in feedback["feedbacks"] if not f.get("learning_applied")]

    if len(unlearned) < min_feedbacks:
        return {
            "status": "insufficient",
            "unlearned": len(unlearned),
            "min_required": min_feedbacks,
            "message": f"反馈数不足，需要 {min_feedbacks} 条，当前 {len(unlearned)} 条"
        }

    report = {"timestamp": datetime.now().isoformat(), "applied": [], "changes": {}}

    # --- 区域纠正：更新关键词库 ---
    area_corrections = [f for f in unlearned if "area" in f.get("diffs", {})]
    if area_corrections:
        keywords = _load_json(KEYWORDS_FILE)
        area_updates = {}
        for fb in area_corrections:
            symptom = fb["corrections"].get("symptom", fb["extracted"].get("symptom", ""))
            new_area = fb["diffs"]["area"]["new"]
            if symptom and new_area:
                area_updates.setdefault(new_area, set()).add(symptom)

        reg_add = {}
        for area, words in area_updates.items():
            area_key = area.replace("EXT-", "").lower().replace(" ", "_").replace("&", "_")
            existing = keywords.get("areas", {}).get(area_key, {}).get("keywords", [])
            new_words = [w for w in words if w not in existing]
            if new_words:
                reg_add.setdefault(area_key, []).extend(new_words)
            if new_words and not dry_run:
                keywords.setdefault("areas", {}).setdefault(area_key, {"description": area, "keywords": []})
                keywords["areas"][area_key]["keywords"].extend(new_words)
                report["changes"].setdefault("area_keywords", []).append({
                    "area": area_key, "added": new_words
                })
            elif new_words:
                report["changes"].setdefault("area_keywords", []).append({
                    "area": area_key, "would_add": new_words
                })

        if not dry_run and "area_keywords" in report.get("changes", {}):
            _save_json(KEYWORDS_FILE, keywords)
            reg = _load_json(LEARNED_KW_FILE, {"areas": {}, "severity": {}})
            now = datetime.now().isoformat()
            for ak, ws in reg_add.items():
                bucket = reg.setdefault("areas", {}).setdefault(ak, {})
                for w in ws:
                    bucket[w] = now
            _save_json(LEARNED_KW_FILE, reg)
            report["applied"].append("area_keywords")

    # --- 严重度纠正：更新关键词库 ---
    sev_corrections = [f for f in unlearned if "severity" in f.get("diffs", {})]
    if sev_corrections:
        keywords = _load_json(KEYWORDS_FILE)
        sev_updates = {}
        for fb in sev_corrections:
            symptom = fb["corrections"].get("symptom", fb["extracted"].get("symptom", ""))
            new_sev = fb["diffs"]["severity"]["new"]
            if symptom and new_sev:
                sev_updates.setdefault(new_sev, set()).add(symptom)

        reg_add = {}
        for sev, words in sev_updates.items():
            existing = keywords.get("severity", {}).get(sev, {}).get("keywords", [])
            new_words = [w for w in words if w not in existing]
            if new_words:
                reg_add.setdefault(sev, []).extend(new_words)
            if new_words and not dry_run:
                keywords.setdefault("severity", {}).setdefault(sev, {"description": "", "keywords": []})
                keywords["severity"][sev]["keywords"].extend(new_words)
                report["changes"].setdefault("severity_keywords", []).append({
                    "severity": sev, "added": new_words
                })
            elif new_words:
                report["changes"].setdefault("severity_keywords", []).append({
                    "severity": sev, "would_add": new_words
                })

        if not dry_run and "severity_keywords" in report.get("changes", {}):
            _save_json(KEYWORDS_FILE, keywords)
            reg = _load_json(LEARNED_KW_FILE, {"areas": {}, "severity": {}})
            now = datetime.now().isoformat()
            for sv, ws in reg_add.items():
                bucket = reg.setdefault("severity", {}).setdefault(sv, {})
                for w in ws:
                    bucket[w] = now
            _save_json(LEARNED_KW_FILE, reg)
            report["applied"].append("severity_keywords")

    # --- 案例矩阵：新增纠正后的案例 ---
    case_corrections = [f for f in unlearned
                        if f.get("diffs") and f.get("viim_key")]
    if case_corrections and not dry_run:
        issues_data = _load_json(ISSUES_FILE)
        issues_list = issues_data.get("issues", issues_data) if isinstance(issues_data, dict) else issues_data
        for fb in case_corrections:
            new_case = {
                "id": fb.get("viim_key", ""),
                "fc_text": fb["fc_text"],
                "area": fb["corrections"].get("area", fb["extracted"].get("area")),
                "severity": fb["corrections"].get("severity", fb["extracted"].get("severity")),
                "root_cause": fb["corrections"].get("root_cause", ""),
                "solution": fb["corrections"].get("solution", ""),
                "symptom": fb["corrections"].get("symptom", fb["extracted"].get("symptom")),
                "source": "feedback",
                "added": datetime.now().isoformat()
            }
            # 避免重复
            existing_ids = {c.get("id") for c in issues_list if isinstance(c, dict)}
            if new_case["id"] and new_case["id"] not in existing_ids:
                issues_list.append(new_case)
                report["changes"].setdefault("cases_added", []).append(new_case["id"])

        if "cases_added" in report.get("changes", {}):
            if isinstance(issues_data, dict) and "issues" in issues_data:
                issues_data["issues"] = issues_list
                _save_json(ISSUES_FILE, issues_data)
            else:
                _save_json(ISSUES_FILE, issues_list)
            report["applied"].append("cases")

    # --- patterns.json：新增根因模板 ---
    root_cause_corrections = [f for f in unlearned if f.get("corrections", {}).get("root_cause")]
    if root_cause_corrections and not dry_run:
        patterns_data = _load_json(PATTERNS_FILE)
        patterns_list = patterns_data.get("patterns", patterns_data) if isinstance(patterns_data, dict) else patterns_data
        for fb in root_cause_corrections:
            rc = fb["corrections"]["root_cause"]
            category = rc.get("category", "unknown")
            cause_text = rc.get("cause", "")
            if cause_text:
                if not isinstance(patterns_list, list):
                    patterns_list = []
                if not any(p.get("cause") == cause_text for p in patterns_list if isinstance(p, dict)):
                    patterns_list.append({
                        "cause": cause_text,
                        "description": rc.get("description", ""),
                        "fix_direction": rc.get("fix_direction", ""),
                        "fix_verb": rc.get("fix_verb", ""),
                        "source": "feedback",
                        "added": datetime.now().isoformat()
                    })
                    report["changes"].setdefault("patterns_added", []).append({
                        "category": category, "cause": cause_text
                    })
        if "patterns_added" in report.get("changes", {}):
            if isinstance(patterns_data, dict) and "patterns" in patterns_data:
                patterns_data["patterns"] = patterns_list
                _save_json(PATTERNS_FILE, patterns_data)
            else:
                _save_json(PATTERNS_FILE, patterns_list)
            report["applied"].append("patterns")

    # 标记已学习
    if not dry_run:
        feedback = _load_json(FEEDBACK_FILE, {"feedbacks": [], "stats": {}})
        for fb in feedback["feedbacks"]:
            if not fb.get("learning_applied"):
                fb["learning_applied"] = True
        feedback["stats"]["learning_runs"] = feedback["stats"].get("learning_runs", 0) + 1
        _save_json(FEEDBACK_FILE, feedback)

    report["status"] = "applied" if not dry_run else "dry_run"
    report["feedbacks_processed"] = len(unlearned)
    report["changes_count"] = sum(len(v) for v in report.get("changes", {}).values())

    return report


# ============================================================
# 2.5 学习关键词管理（来源登记 + 可删）
# ============================================================

def list_learned_keywords():
    """列出反馈学习写入关键词库的词（带来源登记时间），倒序。"""
    reg = _load_json(LEARNED_KW_FILE, {"areas": {}, "severity": {}})
    items = []
    for kind in ("areas", "severity"):
        for group, words in (reg.get(kind) or {}).items():
            for word, ts in (words or {}).items():
                items.append({"kind": kind, "group": group, "word": word, "added": ts})
    items.sort(key=lambda x: x.get("added", ""), reverse=True)
    return items


def delete_learned_keyword(kind, group, word):
    """从关键词库与来源登记中移除一个学习关键词。成功返回 True。"""
    if kind not in ("areas", "severity") or not group or not word:
        return False
    reg = _load_json(LEARNED_KW_FILE, {"areas": {}, "severity": {}})
    bucket = (reg.get(kind) or {}).get(group) or {}
    if word not in bucket:
        return False
    del bucket[word]
    _save_json(LEARNED_KW_FILE, reg)
    keywords = _load_json(KEYWORDS_FILE)
    grp = (keywords.get(kind) or {}).get(group)
    if grp and word in (grp.get("keywords") or []):
        grp["keywords"].remove(word)
        _save_json(KEYWORDS_FILE, keywords)
    return True


# ============================================================
# 3. 统计报告
# ============================================================

def get_accuracy_report():
    """生成反馈统计报告"""
    feedback = _load_json(FEEDBACK_FILE, {"feedbacks": [], "stats": {}})
    stats = feedback.get("stats", {})

    total = stats.get("total", 0)
    corrections = stats.get("corrections", 0)
    accuracy = (total - corrections) / total * 100 if total else 0

    # 各字段准确率
    field_acc = {}
    for field, counts in stats.get("field_accuracy", {}).items():
        correct = counts.get("correct", 0)
        wrong = counts.get("wrong", 0)
        field_total = correct + wrong
        field_acc[field] = {
            "accuracy": round(correct / field_total * 100, 1) if field_total else 0,
            "correct": correct,
            "wrong": wrong,
            "total": field_total
        }

    # 高频错误
    error_freq = {}
    for fb in feedback["feedbacks"]:
        for field, diff in fb.get("diffs", {}).items():
            key = f"{field}: {diff['old']} → {diff['new']}"
            error_freq[key] = error_freq.get(key, 0) + 1
    top_errors = sorted(error_freq.items(), key=lambda x: -x[1])[:10]

    # 近期趋势（最近 20 条）
    recent = feedback["feedbacks"][-20:]
    recent_accuracy = (len(recent) - sum(1 for f in recent if f.get("diffs"))) / len(recent) * 100 if recent else 0

    return {
        "overall_accuracy": round(accuracy, 1),
        "total_feedbacks": total,
        "corrections": corrections,
        "field_accuracy": field_acc,
        "top_errors": top_errors,
        "recent_accuracy": round(recent_accuracy, 1),
        "learning_runs": stats.get("learning_runs", 0)
    }


def format_accuracy_report(report):
    """格式化统计报告"""
    lines = ["# 📊 反馈学习统计报告\n"]
    lines.append(f"**总体准确率**: {report['overall_accuracy']}% ({report['total_feedbacks'] - report['corrections']}/{report['total_feedbacks']})")
    lines.append(f"**近期准确率** (最近20条): {report['recent_accuracy']}%")
    lines.append(f"**学习运行次数**: {report['learning_runs']}\n")

    lines.append("## 各字段准确率\n")
    lines.append("| 字段 | 准确率 | 正确 | 错误 |")
    lines.append("|------|--------|------|------|")
    for field, acc in sorted(report["field_accuracy"].items()):
        lines.append(f"| {field} | {acc['accuracy']}% | {acc['correct']} | {acc['wrong']} |")

    if report["top_errors"]:
        lines.append("\n## 高频错误 Top-10\n")
        lines.append("| 错误模式 | 次数 |")
        lines.append("|----------|------|")
        for err, count in report["top_errors"]:
            lines.append(f"| {err} | {count} |")

    return "\n".join(lines)


# ============================================================
# CLI
# ============================================================

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="反馈学习系统")
    sub = parser.add_subparsers(dest="cmd")

    # 统计
    sub.add_parser("stats", help="查看反馈统计")

    # 学习
    learn_p = sub.add_parser("learn", help="应用反馈学习")
    learn_p.add_argument("--min", type=int, default=3, help="最小反馈数")
    learn_p.add_argument("--dry-run", action="store_true", help="预览模式")

    args = parser.parse_args()

    if args.cmd == "stats":
        report = get_accuracy_report()
        print(format_accuracy_report(report))
    elif args.cmd == "learn":
        result = apply_learning(min_feedbacks=args.min, dry_run=args.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        parser.print_help()
