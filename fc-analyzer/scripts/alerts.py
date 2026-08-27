"""
alerts.py — Phase 4: 问题预警与跟踪系统

核心功能：
1. FC 问题状态追踪（新建/分析中/已提交/已关闭）
2. 预警规则引擎（严重度/截止日期/趋势/根因）
3. 造型问题管理透视（按区域/严重度/阶段汇总）
4. 重点问题跟进提醒（高严重度 + 临近截止）
5. 飞书消息推送（可选）
"""
import json
import os
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "database")
ISSUES_FILE = os.path.join(DATA_DIR, "lighting_issues.json")
TRACKING_FILE = os.path.join(DATA_DIR, "fc_tracking.json")
ALERTS_FILE = os.path.join(DATA_DIR, "fc_alerts.json")
ALERT_RULES_FILE = os.path.join(DATA_DIR, "alert_rules.json")


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
# 1. 问题状态追踪
# ============================================================

STATUS_NEW = "新建"
STATUS_ANALYZING = "分析中"
STATUS_SUBMITTED = "已提交"
STATUS_CLOSED = "已关闭"
STATUS_OVERDUE = "已逾期"

SEVERITY_LABELS = {"S": "🚨 严重", "A": "⚠️ 高", "B": "📋 中", "C": "📝 低", "D": "📝 低"}


def _sev_level(value) -> str:
    """从单字母(S/A/B/C)或 VIIM 完整取值(S-非常重要… 等)中提取严重度级别，兜底 A。"""
    v = (value or "").strip()
    if v and v[0] in "SABCD":
        return v[0]
    return "A"


def track_issue(fc_text, fields, viim_key=None, status=STATUS_NEW, user_id=None):
    """
    记录 FC 问题到追踪系统。

    Args:
        fc_text: FC 描述
        fields: 抽取的字段
        viim_key: VIIM 工单号（可选）
        status: 初始状态
        user_id: 创建人
    """
    tracking = _load_json(TRACKING_FILE, {"issues": [], "stats": {}})

    issue_id = f"TRK-{datetime.now().strftime('%Y%m%d%H%M%S')}-{len(tracking['issues']):04d}"

    # 计算截止时间（默认 14 天）
    close_deadline = (datetime.now() + timedelta(days=14)).isoformat()
    cas_deadline = (datetime.now() + timedelta(days=21)).isoformat()

    issue = {
        "id": issue_id,
        "viim_key": viim_key,
        "fc_text": fc_text,
        "area": fields.get("viim_area", ""),
        "severity": _sev_level(fields.get("viim_severity")),
        "urgency": fields.get("viim_urgency", ""),
        "stage": fields.get("viim_phase", ""),
        "part": fields.get("part", ""),
        "symptom": fields.get("symptom", ""),
        "status": status,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "close_deadline": close_deadline,
        "cas_deadline": cas_deadline,
        "assigned_to": user_id,
        "alerts_sent": [],
        "notes": []
    }

    tracking["issues"].append(issue)
    _update_stats(tracking)
    _save_json(TRACKING_FILE, tracking)

    return issue_id


def update_issue_status(issue_id, new_status, note=None):
    """更新问题状态"""
    tracking = _load_json(TRACKING_FILE, {"issues": []})
    for issue in tracking["issues"]:
        if issue["id"] == issue_id:
            old_status = issue["status"]
            issue["status"] = new_status
            issue["updated_at"] = datetime.now().isoformat()
            if note:
                issue["notes"].append({
                    "time": datetime.now().isoformat(),
                    "text": note,
                    "old_status": old_status,
                    "new_status": new_status
                })
            _update_stats(tracking)
            _save_json(TRACKING_FILE, tracking)
            return True
    return False


def add_issue_note(issue_id, note):
    """给问题添加备注"""
    tracking = _load_json(TRACKING_FILE, {"issues": []})
    for issue in tracking["issues"]:
        if issue["id"] == issue_id:
            issue["notes"].append({
                "time": datetime.now().isoformat(),
                "text": note
            })
            issue["updated_at"] = datetime.now().isoformat()
            _save_json(TRACKING_FILE, tracking)
            return True
    return False


def _update_stats(tracking):
    """更新追踪统计"""
    issues = tracking["issues"]
    now = datetime.now()
    stats = {
        "total": len(issues),
        "by_status": {},
        "by_severity": {},
        "by_area": {},
        "overdue_count": 0,
        "upcoming_deadline_count": 0
    }
    for issue in issues:
        s = issue.get("status", STATUS_NEW)
        stats["by_status"][s] = stats["by_status"].get(s, 0) + 1

        sev = issue.get("severity", "A")
        stats["by_severity"][sev] = stats["by_severity"].get(sev, 0) + 1

        area = issue.get("area", "Unknown")
        stats["by_area"][area] = stats["by_area"].get(area, 0) + 1

        # 逾期检查
        if issue.get("close_deadline"):
            try:
                deadline = datetime.fromisoformat(issue["close_deadline"])
                if now > deadline and s not in (STATUS_CLOSED, STATUS_OVERDUE):
                    stats["overdue_count"] += 1
                elif (deadline - now).days <= 3 and s not in (STATUS_CLOSED,):
                    stats["upcoming_deadline_count"] += 1
            except (ValueError, TypeError):
                pass

    tracking["stats"] = stats


# ============================================================
# 2. 预警规则引擎
# ============================================================

def check_alerts():
    """
    检查所有预警规则，返回需要发送的预警列表。

    规则：
    1. 新 FC 创建 → 📋 通知
    2. 严重度=S → 🚨 紧急
    3. ≤3天到截止 → ⏰ 催办
    4. 同区域连续3个FC → 📊 趋势
    5. 同一根因≥3次 → 🔍 根因
    """
    tracking = _load_json(TRACKING_FILE, {"issues": []})
    alerts_data = _load_json(ALERTS_FILE, {"alerts": []})
    issues = tracking.get("issues", [])

    now = datetime.now()
    alerts = []

    # 已发送的预警 ID 集合（去重）
    sent_ids = {a.get("ref_id") for a in alerts_data.get("alerts", [])}

    for issue in issues:
        issue_id = issue["id"]
        status = issue.get("status", STATUS_NEW)
        severity = issue.get("severity", "A")

        # 跳过已关闭
        if status in (STATUS_CLOSED,):
            continue

        # 规则 1: 新 FC（未发送过新 FC 预警）
        if status == STATUS_NEW and f"new_{issue_id}" not in sent_ids:
            alerts.append({
                "type": "new_fc",
                "level": "📋 通知",
                "ref_id": f"new_{issue_id}",
                "issue_id": issue_id,
                "message": f"📋 新 FC 问题：{issue['area']} - {issue['fc_text'][:30]}",
                "target": "工程群",
                "timestamp": now.isoformat()
            })

        # 规则 2: 严重度=S
        if severity == "S" and f"sev_s_{issue_id}" not in sent_ids:
            alerts.append({
                "type": "severity_s",
                "level": "🚨 紧急",
                "ref_id": f"sev_s_{issue_id}",
                "issue_id": issue_id,
                "message": f"🚨 严重问题（S级）：{issue['area']} - {issue['fc_text'][:30]}",
                "target": issue.get("assigned_to", "责任人"),
                "action": "@责任人",
                "timestamp": now.isoformat()
            })

        # 规则 3: ≤3天到截止
        if issue.get("close_deadline"):
            try:
                deadline = datetime.fromisoformat(issue["close_deadline"])
                days_left = (deadline - now).days
                if 0 <= days_left <= 3 and f"deadline_{issue_id}" not in sent_ids:
                    alerts.append({
                        "type": "deadline",
                        "level": "⏰ 催办",
                        "ref_id": f"deadline_{issue_id}",
                        "issue_id": issue_id,
                        "message": f"⏰ 截止提醒：{issue['area']} - 还剩 {days_left} 天关闭",
                        "target": issue.get("assigned_to", "责任人"),
                        "action": "提醒责任人",
                        "timestamp": now.isoformat()
                    })
                elif days_left < 0 and f"overdue_{issue_id}" not in sent_ids:
                    alerts.append({
                        "type": "overdue",
                        "level": "🚨 逾期",
                        "ref_id": f"overdue_{issue_id}",
                        "issue_id": issue_id,
                        "message": f"🚨 已逾期 {abs(days_left)} 天：{issue['area']} - {issue['fc_text'][:30]}",
                        "target": issue.get("assigned_to", "责任人"),
                        "action": "立即处理",
                        "timestamp": now.isoformat()
                    })
            except (ValueError, TypeError):
                pass

    # 规则 4: 同区域连续3个FC
    area_counts = {}
    recent_issues = sorted(issues, key=lambda x: x.get("created_at", ""), reverse=True)[:20]
    for issue in recent_issues:
        area = issue.get("area", "")
        if area:
            area_counts.setdefault(area, []).append(issue)

    for area, area_issues in area_counts.items():
        open_issues = [i for i in area_issues if i.get("status") not in (STATUS_CLOSED,)]
        if len(open_issues) >= 3:
            trend_id = f"trend_{area}_{now.strftime('%Y%m%d')}"
            if trend_id not in sent_ids:
                alerts.append({
                    "type": "trend",
                    "level": "📊 趋势预警",
                    "ref_id": trend_id,
                    "message": f"📊 趋势预警：{area} 连续 {len(open_issues)} 个未关闭 FC",
                    "target": "区域负责人",
                    "action": "推送区域负责人",
                    "timestamp": now.isoformat(),
                    "details": [i["fc_text"][:30] for i in open_issues[:5]]
                })

    # 规则 5: 同一根因≥3次（从 patterns 或历史案例中检查）
    issues_data = _load_json(ISSUES_FILE, {"issues": []})
    all_issues = issues_data.get("issues", issues_data) if isinstance(issues_data, dict) else issues_data
    root_cause_freq = {}
    for issue in all_issues:
        if isinstance(issue, dict) and issue.get("root_cause"):
            rc = issue["root_cause"]
            root_cause_freq[rc] = root_cause_freq.get(rc, 0) + 1

    for rc, count in root_cause_freq.items():
        if count >= 3:
            rc_id = f"rootcause_{hash(rc) % 10000}_{now.strftime('%Y%m%d')}"
            if rc_id not in sent_ids:
                alerts.append({
                    "type": "root_cause",
                    "level": "🔍 根因预警",
                    "ref_id": rc_id,
                    "message": f"🔍 重复根因（{count}次）：{rc[:50]}",
                    "target": "质量工程师",
                    "action": "推送质量工程师",
                    "timestamp": now.isoformat()
                })

    # 保存预警
    if alerts:
        alerts_data.setdefault("alerts", []).extend(alerts)
        _save_json(ALERTS_FILE, alerts_data)

    return alerts


# ============================================================
# 3. 造型问题管理透视
# ============================================================

def get_management_dashboard():
    """
    生成管理透视看板数据。

    返回：
    - 按区域统计
    - 按严重度统计
    - 按阶段统计
    - 重点问题列表
    - 趋势分析
    """
    tracking = _load_json(TRACKING_FILE, {"issues": []})
    issues = tracking.get("issues", [])
    now = datetime.now()

    # 按区域
    by_area = {}
    for issue in issues:
        area = issue.get("area", "Unknown")
        by_area.setdefault(area, {"total": 0, "open": 0, "overdue": 0, "severities": {}})
        by_area[area]["total"] += 1
        if issue.get("status") not in (STATUS_CLOSED,):
            by_area[area]["open"] += 1
        sev = issue.get("severity", "A")
        by_area[area]["severities"][sev] = by_area[area]["severities"].get(sev, 0) + 1
        # 逾期
        if issue.get("close_deadline"):
            try:
                deadline = datetime.fromisoformat(issue["close_deadline"])
                if now > deadline and issue.get("status") not in (STATUS_CLOSED,):
                    by_area[area]["overdue"] += 1
            except (ValueError, TypeError):
                pass

    # 按严重度
    by_severity = {}
    for issue in issues:
        sev = issue.get("severity", "A")
        by_severity.setdefault(sev, {"total": 0, "open": 0, "overdue": 0})
        by_severity[sev]["total"] += 1
        if issue.get("status") not in (STATUS_CLOSED,):
            by_severity[sev]["open"] += 1

    # 按阶段
    by_stage = {}
    for issue in issues:
        stage = issue.get("stage", "Unknown")
        by_stage.setdefault(stage, {"total": 0, "open": 0})
        by_stage[stage]["total"] += 1
        if issue.get("status") not in (STATUS_CLOSED,):
            by_stage[stage]["open"] += 1

    # 重点问题（S级 + 逾期 + 临近截止）
    critical_issues = []
    for issue in issues:
        if issue.get("status") in (STATUS_CLOSED,):
            continue
        is_critical = False
        reasons = []

        if issue.get("severity") == "S":
            is_critical = True
            reasons.append("S级严重")

        if issue.get("close_deadline"):
            try:
                deadline = datetime.fromisoformat(issue["close_deadline"])
                days_left = (deadline - now).days
                if days_left < 0:
                    is_critical = True
                    reasons.append(f"逾期{abs(days_left)}天")
                elif days_left <= 3:
                    is_critical = True
                    reasons.append(f"还剩{days_left}天")
            except (ValueError, TypeError):
                pass

        if is_critical:
            critical_issues.append({
                "id": issue["id"],
                "area": issue.get("area", ""),
                "severity": issue.get("severity", ""),
                "fc_text": issue.get("fc_text", "")[:50],
                "status": issue.get("status", ""),
                "deadline": issue.get("close_deadline", ""),
                "reasons": reasons
            })

    # 趋势（最近 7 天每天新增数）
    trend = {}
    for issue in issues:
        try:
            created = datetime.fromisoformat(issue["created_at"])
            day_key = created.strftime("%Y-%m-%d")
            if (now - created).days <= 7:
                trend[day_key] = trend.get(day_key, 0) + 1
        except (ValueError, TypeError):
            pass

    return {
        "timestamp": now.isoformat(),
        "summary": {
            "total": len(issues),
            "open": sum(1 for i in issues if i.get("status") not in (STATUS_CLOSED,)),
            "overdue": sum(1 for i in issues if i.get("status") not in (STATUS_CLOSED,)
                          and i.get("close_deadline")
                          and datetime.fromisoformat(i["close_deadline"]) < now),
            "critical": len(critical_issues)
        },
        "by_area": by_area,
        "by_severity": by_severity,
        "by_stage": by_stage,
        "critical_issues": critical_issues,
        "trend_7d": trend
    }


def format_dashboard_markdown(dashboard):
    """格式化管理看板为 Markdown"""
    lines = ["# 📊 FC 问题管理看板\n"]

    s = dashboard["summary"]
    lines.append(f"**总计**: {s['total']} | **进行中**: {s['open']} | **逾期**: {s['overdue']} | **重点**: {s['critical']}\n")

    # 按区域
    lines.append("## 按区域分布\n")
    lines.append("| 区域 | 总计 | 进行中 | 逾期 | S级 | A级 | B级 |")
    lines.append("|------|------|--------|------|-----|-----|-----|")
    for area, data in sorted(dashboard["by_area"].items()):
        sev = data["severities"]
        lines.append(f"| {area} | {data['total']} | {data['open']} | {data['overdue']} | "
                     f"{sev.get('S', 0)} | {sev.get('A', 0)} | {sev.get('B', 0)} |")

    # 按严重度
    lines.append("\n## 按严重度分布\n")
    lines.append("| 严重度 | 总计 | 进行中 |")
    lines.append("|--------|------|--------|")
    for sev in ["S", "A", "B", "C"]:
        data = dashboard["by_severity"].get(sev, {"total": 0, "open": 0})
        label = SEVERITY_LABELS.get(sev, sev)
        lines.append(f"| {label} | {data['total']} | {data['open']} |")

    # 重点问题
    if dashboard["critical_issues"]:
        lines.append("\n## 🔴 重点问题\n")
        lines.append("| ID | 区域 | 严重度 | 状态 | 描述 | 原因 |")
        lines.append("|----|----|--------|------|------|------|")
        for ci in dashboard["critical_issues"][:10]:
            reasons = ", ".join(ci["reasons"])
            lines.append(f"| {ci['id'][-8:]} | {ci['area']} | {ci['severity']} | {ci['status']} | {ci['fc_text']} | {reasons} |")

    # 7天趋势
    if dashboard["trend_7d"]:
        lines.append("\n## 📈 近7天趋势\n")
        lines.append("| 日期 | 新增 |")
        lines.append("|------|------|")
        for day in sorted(dashboard["trend_7d"].keys()):
            count = dashboard["trend_7d"][day]
            bar = "█" * count
            lines.append(f"| {day} | {bar} {count} |")

    return "\n".join(lines)


# ============================================================
# 4. 重点问题跟进提醒
# ============================================================

def get_followup_reminders():
    """
    获取需要跟进的重点问题提醒列表。

    返回：
    - 逾期问题
    - ≤3天到期
    - S级未关闭
    - 长期未更新（>7天）
    """
    tracking = _load_json(TRACKING_FILE, {"issues": []})
    issues = tracking.get("issues", [])
    now = datetime.now()

    reminders = []

    for issue in issues:
        if issue.get("status") in (STATUS_CLOSED,):
            continue

        # 逾期
        if issue.get("close_deadline"):
            try:
                deadline = datetime.fromisoformat(issue["close_deadline"])
                days_left = (deadline - now).days
                if days_left < 0:
                    reminders.append({
                        "type": "overdue",
                        "level": "🚨",
                        "issue_id": issue["id"],
                        "area": issue.get("area", ""),
                        "severity": issue.get("severity", ""),
                        "message": f"逾期 {abs(days_left)} 天：{issue['fc_text'][:40]}",
                        "days_overdue": abs(days_left)
                    })
                elif days_left <= 3:
                    reminders.append({
                        "type": "deadline_soon",
                        "level": "⏰",
                        "issue_id": issue["id"],
                        "area": issue.get("area", ""),
                        "severity": issue.get("severity", ""),
                        "message": f"还剩 {days_left} 天：{issue['fc_text'][:40]}",
                        "days_left": days_left
                    })
            except (ValueError, TypeError):
                pass

        # S级未关闭
        if issue.get("severity") == "S":
            reminders.append({
                "type": "severity_s",
                "level": "🚨",
                "issue_id": issue["id"],
                "area": issue.get("area", ""),
                "severity": "S",
                "message": f"S级待处理：{issue['fc_text'][:40]}"
            })

        # 长期未更新
        if issue.get("updated_at"):
            try:
                updated = datetime.fromisoformat(issue["updated_at"])
                if (now - updated).days > 7:
                    reminders.append({
                        "type": "stale",
                        "level": "📋",
                        "issue_id": issue["id"],
                        "area": issue.get("area", ""),
                        "severity": issue.get("severity", ""),
                        "message": f"已 {(now - updated).days} 天未更新：{issue['fc_text'][:40]}",
                        "days_stale": (now - updated).days
                    })
            except (ValueError, TypeError):
                pass

    # 按优先级排序：逾期 > 截止临近 > S级 > 未更新
    priority = {"overdue": 0, "deadline_soon": 1, "severity_s": 2, "stale": 3}
    reminders.sort(key=lambda x: (priority.get(x["type"], 99), -x.get("days_overdue", x.get("days_left", 0))))

    return reminders


def format_reminders_markdown(reminders):
    """格式化跟进提醒"""
    if not reminders:
        return "✅ 暂无需要跟进的重点问题\n"

    lines = [f"# 📋 重点问题跟进提醒（{len(reminders)} 项）\n"]

    # 按类型分组
    by_type = {}
    for r in reminders:
        by_type.setdefault(r["type"], []).append(r)

    if "overdue" in by_type:
        lines.append(f"\n## 🚨 逾期（{len(by_type['overdue'])} 项）\n")
        for r in by_type["overdue"]:
            lines.append(f"- **{r['issue_id'][-8:]}** [{r['area']}] {r['message']}")

    if "deadline_soon" in by_type:
        lines.append(f"\n## ⏰ 即将到期（{len(by_type['deadline_soon'])} 项）\n")
        for r in by_type["deadline_soon"]:
            lines.append(f"- **{r['issue_id'][-8:]}** [{r['area']}] {r['message']}")

    if "severity_s" in by_type:
        lines.append(f"\n## 🚨 S级待处理（{len(by_type['severity_s'])} 项）\n")
        for r in by_type["severity_s"]:
            lines.append(f"- **{r['issue_id'][-8:]}** [{r['area']}] {r['message']}")

    if "stale" in by_type:
        lines.append(f"\n## 📋 长期未更新（{len(by_type['stale'])} 项）\n")
        for r in by_type["stale"]:
            lines.append(f"- **{r['issue_id'][-8:]}** [{r['area']}] {r['message']}")

    return "\n".join(lines)


# ============================================================
# CLI
# ============================================================

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="FC 问题预警与跟踪")
    sub = parser.add_subparsers(dest="cmd")

    # 检查预警
    sub.add_parser("check", help="检查预警规则")

    # 管理看板
    sub.add_parser("dashboard", help="管理透视看板")

    # 跟进提醒
    sub.add_parser("reminders", help="重点问题跟进提醒")

    # 列出追踪问题
    sub.add_parser("list", help="列出追踪问题")

    args = parser.parse_args()

    if args.cmd == "check":
        alerts = check_alerts()
        if alerts:
            print(f"🔔 {len(alerts)} 条新预警：\n")
            for a in alerts:
                print(f"  {a['level']} {a['message']}")
        else:
            print("✅ 暂无新预警")

    elif args.cmd == "dashboard":
        dashboard = get_management_dashboard()
        print(format_dashboard_markdown(dashboard))

    elif args.cmd == "reminders":
        reminders = get_followup_reminders()
        print(format_reminders_markdown(reminders))

    elif args.cmd == "list":
        tracking = _load_json(TRACKING_FILE, {"issues": []})
        issues = tracking.get("issues", [])
        if not issues:
            print("📭 暂无追踪问题")
        else:
            print(f"📋 追踪问题列表（{len(issues)} 条）\n")
            print(f"| {'ID':<12} | {'区域':<20} | {'严重度':<4} | {'状态':<6} | {'描述':<30} |")
            print(f"|{'-'*14}|{'-'*22}|{'-'*6}|{'-'*8}|{'-'*32}|")
            for issue in issues[-20:]:
                print(f"| {issue['id'][-12:]} | {issue.get('area',''):<20} | {issue.get('severity',''):<4} | {issue.get('status',''):<6} | {issue.get('fc_text','')[:30]:<30} |")

    else:
        parser.print_help()
