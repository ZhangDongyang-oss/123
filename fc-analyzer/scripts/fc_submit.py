#!/usr/bin/env python3
"""
FC 可行性分析 — 完整提交流程

一句话描述 → 实体抽取 → 案例检索 → 报告生成 → VIIM 建单预览 → 确认提交

用法:
    # 交互模式
    python fc_submit.py

    # 单步模式：生成报告
    python fc_submit.py report "前灯起雾，洗车后灯罩内凝露"

    # 单步模式：dry-run（预览 VIIM payload）
    python fc_submit.py dryrun "前灯起雾"

    # 单步模式：提交（需确认）
    python fc_submit.py submit "前灯起雾" --confirm
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from lighting_extractor import extract_fields
from lighting_search import search_similar_issues
from lighting_analyzer import generate_report, format_report_markdown
from viim_client import VIIMClient, build_viim_payload, dry_run_report, VIIMError
from feedback import collect_feedback, get_accuracy_report, format_accuracy_report
from alerts import track_issue, check_alerts, get_management_dashboard, format_dashboard_markdown, get_followup_reminders, format_reminders_markdown


def full_pipeline(
    query: str,
    submit: bool = False,
    token: str | None = None,
) -> dict:
    """
    完整流水线：抽取 → 检索 → 报告 → (可选)提交。

    返回:
    {
        "fields": {...},           # 抽取的字段
        "hits": [...],             # 检索结果
        "report": {...},           # 分析报告
        "report_md": "...",        # Markdown 报告
        "payload": {...},          # VIIM payload（dry-run）
        "payload_md": "...",       # VIIM 预览 Markdown
        "viim_result": {...},      # 提交结果（submit=True 时）
    }
    """
    # Step 1: 实体抽取
    fields = extract_fields(query)

    # Step 2: 历史案例检索
    hits = search_similar_issues(
        query=query,
        area=fields["viim_area"],
        top=5,
    )

    # Step 3: 可行性分析报告
    report = generate_report(
        hits,
        query=query,
        area=fields["viim_area"],
        severity=fields["viim_severity"],
        phase=fields["viim_phase"],
    )
    report_md = format_report_markdown(report)

    # Step 4: 构建 VIIM payload
    summary = fields["summary"]
    description = fields["description"]
    if report["recommendation"]:
        description += f"\n\n---\n历史案例推荐方案：\n{report['recommendation']}"

    client = VIIMClient(token=token) if token else None
    payload = build_viim_payload(fields, summary, description)

    payload_md = dry_run_report(payload)

    result = {
        "fields": fields,
        "hits": hits,
        "report": report,
        "report_md": report_md,
        "payload": payload,
        "payload_md": payload_md,
        "viim_result": None,
    }

    # Step 5: 提交（如果确认）
    if submit and client:
        try:
            viim_result = client.create_issue(
                summary=payload["summary"],
                description=payload["description"],
                additional_fields=payload["additional_fields"],
            )
            result["viim_result"] = viim_result
        except VIIMError as e:
            result["viim_result"] = {"error": str(e), "code": e.code, "payload": e.payload}

    return result


def save_submission(result: dict, output_dir: str | None = None):
    """保存提交记录到本地。"""
    if output_dir is None:
        output_dir = str(SCRIPT_DIR.parent / "database" / "submissions")
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    from datetime import datetime
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"submission_{ts}.json"

    # 清理不可序列化的内容
    save_data = {
        "timestamp": ts,
        "query": result["fields"].get("raw_text", ""),
        "fields": result["fields"],
        "hits_count": len(result["hits"]),
        "hits_top3": result["hits"][:3],
        "report": result["report"],
        "payload_summary": result["payload"]["summary"],
        "viim_result": result["viim_result"],
    }

    filepath = Path(output_dir) / filename
    filepath.write_text(json.dumps(save_data, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(filepath)


# ---------- CLI ----------
def main():
    if len(sys.argv) < 2:
        print("用法:")
        print("  python fc_submit.py report \"问题描述\"")
        print("  python fc_submit.py dryrun \"问题描述\"")
        print("  python fc_submit.py submit \"问题描述\" --token <VIIM_TOKEN>")
        print("  python fc_submit.py collect \"描述\" '{\"severity\": \"A\"}'")
        print("  python fc_submit.py track \"问题描述\"")
        print("  python fc_submit.py alerts")
        print("  python fc_submit.py dashboard")
        print("  python fc_submit.py reminders")
        print("  python fc_submit.py stats")
        return 0

    cmd = sys.argv[1]
    query = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else ""

    # 不需要 query 的命令
    no_query_cmds = ("stats", "alerts", "dashboard", "reminders")
    if cmd in no_query_cmds:
        if cmd == "stats":
            report = get_accuracy_report()
            print(format_accuracy_report(report))
        elif cmd == "alerts":
            alerts = check_alerts()
            if alerts:
                print(f"🔔 {len(alerts)} 条新预警：\n")
                for a in alerts:
                    print(f"  {a['level']} {a['message']}")
            else:
                print("✅ 暂无新预警")
        elif cmd == "dashboard":
            dashboard = get_management_dashboard()
            print(format_dashboard_markdown(dashboard))
        elif cmd == "reminders":
            reminders = get_followup_reminders()
            print(format_reminders_markdown(reminders))
        return 0

    if not query:
        print("错误：请提供问题描述")
        return 1

    # 解析 token
    token = None
    if "--token" in sys.argv:
        idx = sys.argv.index("--token")
        if idx + 1 < len(sys.argv):
            token = sys.argv[idx + 1]

    if cmd == "report":
        result = full_pipeline(query, submit=False, token=token)
        print(result["report_md"])

    elif cmd == "dryrun":
        result = full_pipeline(query, submit=False, token=token)
        print(result["report_md"])
        print("\n" + "=" * 60 + "\n")
        print(result["payload_md"])

    elif cmd == "submit":
        confirm = "--confirm" in sys.argv
        if not confirm:
            result = full_pipeline(query, submit=False, token=token)
            print(result["payload_md"])
            print("\n添加 --confirm 参数确认提交。")
            return 0

        result = full_pipeline(query, submit=True, token=token)
        if result["viim_result"]:
            if "error" in result["viim_result"]:
                print(f"❌ 提交失败: {result['viim_result']['error']}")
            else:
                vr = result["viim_result"]
                print(f"✅ 提交成功！")
                print(f"   工单号: {vr['key']}")
                print(f"   链接: {vr['url']}")
                # 保存记录
                path = save_submission(result)
                print(f"   记录已保存: {path}")
        else:
            print("❌ 未配置 VIIM token，无法提交。请用 --token 参数或设置 VIIM_API_TOKEN 环境变量。")

    elif cmd == "collect":
        # 收集反馈: python fc_submit.py collect "描述" '{"severity": "A"}'
        if len(sys.argv) < 4:
            print("用法: python fc_submit.py collect '描述' '{\"severity\": \"A\", \"area\": \"EXT-Front End\"}'")
            return 1
        corrections_str = sys.argv[3]
        try:
            corrections = json.loads(corrections_str)
        except json.JSONDecodeError:
            print(f"❌ 纠正参数 JSON 解析失败: {corrections_str}")
            return 1

        # 先抽取
        result = full_pipeline(query, submit=False, token=token)
        extracted = result["fields"]

        # 收集反馈
        fb_id = collect_feedback(
            fc_text=query,
            extracted=extracted,
            corrections=corrections,
            user_id=token,
            viim_key=corrections.get("viim_key")
        )
        print(f"✅ 反馈已收集: {fb_id}")
        print(f"   系统抽取: area={extracted['viim_area']}, severity={extracted['viim_severity']}")
        print(f"   用户纠正: {corrections}")
        # 显示差异
        from feedback import _load_json, FEEDBACK_FILE
        fb = _load_json(FEEDBACK_FILE, {"feedbacks": []})
        last = fb["feedbacks"][-1] if fb["feedbacks"] else {}
        if last.get("diffs"):
            print(f"   差异字段: {list(last['diffs'].keys())}")
        else:
            print(f"   ✨ 无差异，抽取完全正确！")

    elif cmd == "track":
        # 追踪问题
        result = full_pipeline(query, submit=False, token=token)
        issue_id = track_issue(query, result["fields"], user_id=token)
        print(f"✅ 问题已追踪: {issue_id}")
        print(f"   区域: {result['fields']['viim_area']}, 严重度: {result['fields']['viim_severity']}")
        alerts = check_alerts()
        if alerts:
            print(f"   🔔 触发 {len(alerts)} 条预警：")
            for a in alerts:
                print(f"      {a['level']} {a['message']}")

    else:
        print(f"未知命令: {cmd}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
