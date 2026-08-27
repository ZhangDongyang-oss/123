#!/usr/bin/env python3
"""
报告模板检查器 — 按预设模板检查 FC 问题的报告完整性 + 流程状态。

数据源：VIIM 实时工单优先（需 token），本地 submissions/drafts 兜底。

模板定义见 database/report_templates.json（必含字段清单）。

用法:
    python scripts/report_checker.py               # 检查全部
    python scripts/report_checker.py --template default --limit 50
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
DATABASE_DIR = BASE_DIR / "database"
WEB_DB = BASE_DIR / "webapp" / "database"
TEMPLATES_FILE = DATABASE_DIR / "report_templates.json"

# 中文字段名 → {viim 键（draft fields 用）, cf（VIIM customfield id，submission/VIIM 用）}
FIELDS = {
    "概要":            {"viim": "summary",              "cf": "summary"},
    "描述":            {"viim": "description",          "cf": "description"},
    "车型":            {"viim": "viim_car_model",       "cf": "customfield_13913"},
    "问题提出部门":    {"viim": "viim_department",      "cf": "customfield_13082"},
    "问题所属区域":    {"viim": "viim_area",            "cf": "customfield_13088"},
    "问题严重度":      {"viim": "viim_severity",        "cf": "customfield_10621"},
    "紧急程度":        {"viim": "viim_urgency",         "cf": "customfield_14001"},
    "问题所属阶段":    {"viim": "viim_phase",           "cf": "customfield_13089"},
    "问题提出CAS号":   {"viim": "viim_cas_number",      "cf": "customfield_13083"},
    "问题关闭阶段":    {"viim": "viim_next_phase",      "cf": "customfield_13872"},
    "问题关闭CAS号":   {"viim": "viim_close_cas_number","cf": "customfield_13873"},
    "对应TI状态":      {"viim": "viim_ti_status",       "cf": "customfield_13085"},
    "对应TI件号":      {"viim": "viim_ti_part_number",  "cf": "customfield_13086"},
    "问题对策及方案":  {"viim": "solution",             "cf": "customfield_13087"},
    "问题要求关闭时间":{"viim": "viim_close_date",      "cf": "customfield_13084"},
    "CAS计划输出时间": {"viim": "viim_cas_date",        "cf": "customfield_13876"},
    "总布置责任人":    {"viim": "overall_email",        "cf": "customfield_12950"},
    "造型责任人":      {"viim": "design_email",         "cf": "customfield_12951"},
    "工程责任人":      {"viim": "engineer_email",       "cf": "customfield_13835"},
    "关联责任人":      {"viim": "viim_related_owners",  "cf": "customfield_10829"},
    "经办人":          {"viim": "viim_assignee",        "cf": "assignee"},
}

# 流程状态分类（与 viim_analytics 保持一致）
STATUS_CLOSED = ("已关闭", "让步接受", "取消")
STATUS_ACTIVE = (
    "新增待握手",
    "造型变更FC失效", "工程深入研究", "工程TI更新", "造型已改待确认",
    "待高层决策", "上升讨论", "SE内部讨论", "待设计方案更新-Designer", "待CAS输出-数模师",
)


def _load_json(path: Path, default=None):
    if default is None:
        default = {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def load_template(template_id: str | None = None) -> dict:
    """加载模板；未指定则用 default_template。"""
    data = _load_json(TEMPLATES_FILE, {"default_template": "default", "templates": []})
    tid = template_id or data.get("default_template", "default")
    for t in data.get("templates", []):
        if t.get("id") == tid:
            return t
    # 兜底：无模板文件时给一个内置默认
    return {
        "id": tid,
        "name": "灯具FC标准模板",
        "required": [
            "概要", "描述", "车型", "问题所属区域", "问题严重度",
            "问题所属阶段", "问题对策及方案",
            "总布置责任人", "造型责任人", "工程责任人",
        ],
    }


def _jira_val(v) -> str:
    """把 Jira 字段值（dict/list/str）归一化为字符串。"""
    if v is None:
        return ""
    if isinstance(v, dict):
        return str(v.get("value") or v.get("displayName") or v.get("name") or "").strip()
    if isinstance(v, list):
        parts = []
        for x in v:
            if isinstance(x, dict):
                parts.append(x.get("displayName") or x.get("name") or x.get("value") or "")
            else:
                parts.append(str(x))
        return ", ".join(p for p in parts if p)
    return str(v).strip()


def field_value(name: str, issue: dict, source: str) -> str:
    """从指定来源取字段值。source: draft | submission | viim"""
    spec = FIELDS.get(name)
    if not spec:
        return ""
    if source == "draft":
        return str(issue.get("fields", {}).get(spec["viim"]) or "").strip()
    if source == "submission":
        af = (issue.get("payload") or {}).get("additional_fields") or {}
        return _jira_val(af.get(spec["cf"]))
    if source == "viim":
        return _jira_val((issue.get("fields") or {}).get(spec["cf"]))
    return ""


def check_completeness(issue: dict, template: dict, source: str) -> dict:
    """检查单条问题对照模板的完整性。"""
    required = template.get("required", [])
    missing, present = [], []
    for name in required:
        val = field_value(name, issue, source)
        if val:
            present.append(name)
        else:
            missing.append(name)
    total = len(required) or 1
    return {
        "missing": missing,
        "present": present,
        "completeness": round(len(present) / total, 3),
    }


def classify_status(status: str) -> str:
    """把 VIIM 状态归为 待办/处理中/完成/未知。"""
    s = status or ""
    if s in STATUS_CLOSED:
        return "完成"
    if s in STATUS_ACTIVE:
        return "处理中" if s != "新增待握手" else "待办"
    if s in ("草稿", "已提交"):
        return "本地"
    return "未知"


def collect_viim_issues(client, limit: int = 100) -> list[dict]:
    """从 VIIM 拉 FC 工单，转成统一 issue dict。"""
    fields = [spec["cf"] for spec in FIELDS.values()]
    fields += ["status", "created", "updated", "priority"]
    raw = client.search_issues(
        jql='issuetype = "FC-造型工程问题" ORDER BY created DESC',
        fields=fields, max_results=limit,
    )
    issues = []
    for it in raw:
        f = it.get("fields", {}) or {}
        issues.append({
            "key": it.get("key", ""),
            "summary": (f.get("summary") or "")[:80],
            "status": (f.get("status") or {}).get("name") or "",
            "created": (f.get("created") or "")[:10],
            "updated": (f.get("updated") or "")[:10],
            "url": f"{client.url}/browse/{it.get('key')}" if it.get("key") else "",
            "fields": f,
        })
    return issues


def collect_local_issues() -> list[dict]:
    """从本地 submissions/drafts 收集，转成统一 issue dict。"""
    issues = []
    subs = _load_json(WEB_DB / "submissions.json", {"submissions": []})
    for s in subs.get("submissions", []):
        issues.append({
            "key": s.get("issue_key", "-"),
            "summary": (s.get("summary") or "")[:80],
            "status": "已提交",
            "created": (s.get("submitted_at") or "")[:10],
            "updated": (s.get("submitted_at") or "")[:10],
            "url": s.get("issue_url", ""),
            "payload": s.get("payload") or {},
        })
    drafts = _load_json(WEB_DB / "drafts.json", {"drafts": []})
    for d in drafts.get("drafts", []):
        issues.append({
            "key": "DRAFT-" + (str(d.get("id") or "?"))[:8],
            "summary": (d.get("summary") or "")[:80],
            "status": "草稿",
            "created": (d.get("created_at") or "")[:10],
            "updated": (d.get("created_at") or "")[:10],
            "url": "",
            "fields": d.get("fields") or {},
        })
    return issues


def _source_of(issue: dict) -> str:
    if "payload" in issue:
        return "submission"
    f = issue.get("fields") or {}
    keys = list(f.keys())
    if any(k.startswith("viim_") for k in keys):
        return "draft"
    return "viim"


def run_check(template_id: str | None = None, limit: int = 100, client=None,
              assignee: str | None = None, overdue_only: bool = False) -> dict:
    """执行完整检查，返回汇总结果。assignee 只看某责任人；overdue_only 只看超期未闭。"""
    template = load_template(template_id)

    issues, source = [], "local"
    if client is not None:
        try:
            issues = collect_viim_issues(client, limit=limit)
            source = "viim"
        except Exception as e:
            issues = []
    if not issues:
        issues = collect_local_issues()
        source = "local" if issues else "none"

    rows = []
    for it in issues:
        src = _source_of(it)
        comp = check_completeness(it, template, src)
        st = it.get("status") or ""
        # 三责任人用户名（用于"我负责的"筛选）
        owners = []
        for nm in ("总布置责任人", "造型责任人", "工程责任人"):
            v = field_value(nm, it, src)
            if v:
                owners.append(v)
        # 打开天数（用于"超期未闭"筛选）
        days_open = None
        created = it.get("created") or ""
        if created:
            try:
                days_open = (date.today() - date.fromisoformat(created)).days
            except ValueError:
                days_open = None
        rows.append({
            "key": it.get("key", ""),
            "summary": it.get("summary", ""),
            "status": st,
            "status_category": classify_status(st),
            "completeness": comp["completeness"],
            "missing": comp["missing"],
            "missing_count": len(comp["missing"]),
            "required_count": len(template.get("required", [])),
            "url": it.get("url", ""),
            "source": src,
            "owners": owners,
            "days_open": days_open,
        })

    # 筛选
    if assignee:
        rows = [r for r in rows if assignee in r.get("owners", [])]
    if overdue_only:
        # 未完成 且 打开超过 14 天（对应"问题要求关闭时间"默认 +14 天）
        rows = [r for r in rows if r.get("status_category") != "完成"
                and (r.get("days_open") is None or r.get("days_open") > 14)]

    # 状态分布 + 完整性分布
    status_counts = {}
    complete = incomplete = 0
    for r in rows:
        status_counts[r["status_category"]] = status_counts.get(r["status_category"], 0) + 1
        if r["missing_count"] == 0:
            complete += 1
        else:
            incomplete += 1

    return {
        "template": {"id": template.get("id"), "name": template.get("name")},
        "source": source,
        "total": len(rows),
        "complete": complete,
        "incomplete": incomplete,
        "status_counts": status_counts,
        "issues": rows,
    }


def _print_report(result: dict):
    print(f"模板: {result['template']['name']} | 数据源: {result['source']} | 共 {result['total']} 条")
    print(f"完整 {result['complete']} 条 / 缺项 {result['incomplete']} 条")
    print("状态分布:", result["status_counts"])
    print()
    for r in result["issues"]:
        miss = "、".join(r["missing"]) if r["missing"] else "✅ 完整"
        print(f"[{r['key']}] {r['status']}({r['status_category']}) 完整度 {int(r['completeness']*100)}% 缺: {miss}")
        print(f"    {r['summary']}")


def main():
    ap = argparse.ArgumentParser(description="报告模板检查器")
    ap.add_argument("--template", default=None, help="模板 id")
    ap.add_argument("--limit", type=int, default=100, help="VIIM 拉取条数上限")
    args = ap.parse_args()

    sys.path.insert(0, str(BASE_DIR / "scripts"))
    client = None
    try:
        from viim_client import VIIMClient
        # 优先从 webapp 会话存储读 token（无 TOKEN_ENCRYPTION_KEY 时明文）
        tokens = _load_json(WEB_DB / "session_tokens.json", {})
        token = None
        if tokens:
            first = next(iter(tokens.values()), {})
            token = first.get("token") if isinstance(first, dict) else None
        client = VIIMClient(token=token) if token else VIIMClient()
    except Exception:
        client = None

    result = run_check(template_id=args.template, limit=args.limit, client=client)
    _print_report(result)


if __name__ == "__main__":
    main()
