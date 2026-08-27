#!/usr/bin/env python3
"""VIIM 工单分析 — 状态清点 / 时长排行 / 趋势节奏 / 晨会五分类推送。

数据源策略：VIIM 实时优先（需 token），本地 submissions/drafts 兜底。

用法:
    python scripts/viim_analytics.py            # 本地数据分析
    python scripts/viim_analytics.py --viim     # VIIM 实时优先
    python scripts/viim_analytics.py --push     # 输出晨会五分类推送文本
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
WEB_DB = BASE_DIR / "webapp" / "database"

# FC 造型问题 workflow 状态集（2026-08-21 实测，见 references/viim-field-mapping.md）
STATUS_CLOSED = ("已关闭", "让步接受", "取消")
STATUS_ACTIVE = (
    "新增待握手",
    "造型变更FC失效", "工程深入研究", "工程TI更新", "造型已改待确认",
    "待高层决策", "上升讨论", "SE内部讨论", "待设计方案更新-Designer", "待CAS输出-数模师",
)


def _load(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return default


def load_local_issues() -> list[dict]:
    subs = _load(WEB_DB / "submissions.json", {"submissions": []})
    drafts = _load(WEB_DB / "drafts.json", {"drafts": []})
    issues = []
    for s in subs.get("submissions", []):
        issues.append({
            "key": s.get("issue_key", "-"),
            "summary": s.get("summary", ""),
            "status": s.get("status", "已提交"),
            "priority": "",
            "created": (s.get("submitted_at") or "")[:10],
            "updated": (s.get("submitted_at") or "")[:10],
        })
    for d in drafts.get("drafts", []):
        issues.append({
            "key": "DRAFT-" + (d.get("id") or "?")[:8],
            "summary": d.get("summary", ""),
            "status": "草稿",
            "priority": "",
            "created": (d.get("created_at") or "")[:10],
            "updated": (d.get("created_at") or "")[:10],
        })
    return issues


def load_viim_issues() -> list[dict]:
    sys.path.insert(0, str(BASE_DIR / "scripts"))
    from viim_client import VIIMClient
    client = VIIMClient()
    raw = client.search_issues(
        jql="project = DEMODIR ORDER BY created DESC",
        fields=["summary", "status", "priority", "created", "updated"],
        max_results=100,
    )
    issues = []
    for it in raw:
        f = it.get("fields", {}) or {}
        issues.append({
            "key": it.get("key", ""),
            "summary": (f.get("summary") or "")[:60],
            "status": (f.get("status") or {}).get("name") or "",
            "priority": (f.get("priority") or {}).get("name") or "",
            "created": (f.get("created") or "")[:10],
            "updated": (f.get("updated") or "")[:10],
        })
    return issues


def status_summary(issues: list[dict]) -> Counter:
    return Counter(i.get("status") or "未知" for i in issues)


def duration_ranking(issues: list[dict], top: int = 5) -> list[dict]:
    rows = []
    for i in issues:
        try:
            c = datetime.strptime(i["created"], "%Y-%m-%d")
            u = datetime.strptime(i["updated"], "%Y-%m-%d")
        except (ValueError, KeyError):
            continue
        rows.append({"key": i["key"], "summary": i["summary"],
                     "status": i["status"], "days": (u - c).days})
    rows.sort(key=lambda r: -r["days"])
    return rows[:top]


def trend_rhythm(issues: list[dict], weeks: int = 6) -> list[dict]:
    today = date.today()
    out = []
    for w in range(weeks - 1, -1, -1):
        start = today - timedelta(days=today.weekday() + 7 * w)
        end = start + timedelta(days=7)
        n = sum(1 for i in issues if i.get("created") and start.isoformat() <= i["created"] < end.isoformat())
        out.append({"week": start.isoformat(), "count": n})
    return out


def morning_push(issues: list[dict]) -> str:
    today = date.today()
    week_ago = (today - timedelta(days=7)).isoformat()
    overdue = (today - timedelta(days=14)).isoformat()

    red = [i for i in issues if i.get("priority") in ("S", "Blocker", "Critical")
           and i.get("status") not in STATUS_CLOSED and i.get("status") != ""]
    orange = [i for i in issues if i.get("created", "9999") <= overdue
              and i.get("status") not in STATUS_CLOSED and i.get("status") != "草稿"]
    blue = [i for i in issues if i.get("status") in STATUS_ACTIVE]
    green = [i for i in issues if i.get("status") in STATUS_CLOSED and i.get("updated", "") >= week_ago]
    purple = [i for i in issues if i.get("status") == "草稿"]

    lines = [f"## FC 晨会看板（{today.isoformat()}）", ""]
    lines.append(f"🔴 严重未闭 {len(red)} 条")
    lines += [f"  - {i['key']} {i['summary']}" for i in red[:3]]
    lines.append(f"🟠 超期未闭(>14天) {len(orange)} 条")
    lines += [f"  - {i['key']} {i['summary']}" for i in orange[:3]]
    lines.append(f"🔵 进行中 {len(blue)} 条")
    lines.append(f"🟢 本周关闭 {len(green)} 条")
    lines.append(f"🟣 待核对草稿 {len(purple)} 条")
    lines += [f"  - {i['key']} {i['summary']}" for i in purple[:3]]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--viim", action="store_true", help="VIIM 实时优先")
    ap.add_argument("--push", action="store_true", help="输出晨会五分类推送")
    args = ap.parse_args()

    issues, source = [], "local"
    if args.viim:
        try:
            issues = load_viim_issues()
            source = "viim"
        except Exception as e:
            print(f"[WARN] VIIM 不可用，降级本地: {e}", file=sys.stderr)
    if not issues:
        issues = load_local_issues()

    if args.push:
        print(morning_push(issues))
        return

    print(f"数据源: {source} | 工单数: {len(issues)}\n")
    print("== 状态清点 ==")
    for st, n in status_summary(issues).most_common():
        print(f"  {st}: {n}")
    print("\n== 处理时长 TOP5 ==")
    for r in duration_ranking(issues):
        print(f"  {r['key']} {r['days']}天 [{r['status']}] {r['summary']}")
    print("\n== 近6周新建趋势 ==")
    for t in trend_rhythm(issues):
        print(f"  {t['week']}  {'#' * t['count']} ({t['count']})")


if __name__ == "__main__":
    main()
