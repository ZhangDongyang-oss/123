#!/usr/bin/env python3
"""从飞书多维表格导入灯具历史工单到 lighting_issues.json"""
import json
import sys
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Add parent to path
BASE_DIR = Path(__file__).parent.parent
OUTPUT_FILE = BASE_DIR / "database" / "lighting_issues.json"


def parse_text_field(field_val):
    if not field_val:
        return ""
    if isinstance(field_val, str):
        return field_val.strip()
    if isinstance(field_val, list):
        parts = []
        for item in field_val:
            if isinstance(item, dict):
                parts.append(item.get("text", ""))
            else:
                parts.append(str(item))
        return "".join(parts).strip()
    return str(field_val).strip()


def parse_multi_select(field_val):
    if not field_val:
        return []
    if isinstance(field_val, list):
        return [str(v).strip() for v in field_val if v]
    return [str(field_val).strip()]


def parse_person(field_val):
    if not field_val:
        return ""
    if isinstance(field_val, list) and field_val:
        return field_val[0].get("name", "")
    return ""


def ts_to_date(ts):
    if not ts:
        return ""
    try:
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone(timedelta(hours=8)))
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return ""


def extract_images(field_val):
    """Extract image URLs (via proxy) from attachment field."""
    if not field_val or not isinstance(field_val, list):
        return []
    urls = []
    for item in field_val:
        if isinstance(item, dict) and item.get("file_token"):
            ft = item["file_token"]
            # Use proxy URL for frontend display
            urls.append(f"/api/feishu-image/{ft}")
    return urls


def extract_links(field_val):
    if not field_val or not isinstance(field_val, list):
        return []
    links = []
    for item in field_val:
        if isinstance(item, dict):
            url = item.get("link") or item.get("url", "")
            text = item.get("text", "")
            if url:
                links.append({"text": text, "url": url})
    return links


def classify_area(lighting_types, problem_desc):
    type_str = " ".join(parse_multi_select(lighting_types)).lower()
    desc = parse_text_field(problem_desc).lower()
    combined = type_str + " " + desc

    if any(k in combined for k in ["前灯", "大灯", "前大灯", "headlamp", "前照灯", "前组合灯", "近光灯", "远光灯"]):
        return "EXT-Front End"
    if any(k in combined for k in ["尾灯", "后灯", "贯穿灯", "后组合灯", "后贯穿灯", "尾灯饰板"]):
        return "EXT-Rear End"
    if any(k in combined for k in ["转向灯", "雾灯", "侧灯", "翼子板灯"]):
        return "EXT-Side&Roof&Door"
    if any(k in combined for k in ["牌照灯", "高位灯", "示廓灯"]):
        return "EXT-Rear End"
    if any(k in combined for k in ["内饰灯", "阅读灯", "氛围灯", "室内灯"]):
        return "INT-Door Trim"
    return "EXT-Front End"


def classify_problem_type(problem_types, solution):
    types = parse_multi_select(problem_types)
    sol = parse_text_field(solution).lower()

    type_map = {
        "光学": "光学", "密封": "密封", "水管理": "密封", "工艺": "工艺",
        "外观": "外观", "性能": "性能", "异响": "异响", "电气": "LED失效",
        "结构": "结构", "可靠性": "可靠性",
    }
    for t in types:
        if t in type_map:
            return type_map[t]

    if any(k in sol for k in ["密封", "漏水", "进水", "起雾", "凝露"]):
        return "密封"
    if any(k in sol for k in ["led", "灯珠", "不亮", "闪烁", "开路", "短路"]):
        return "LED失效"
    if any(k in sol for k in ["间隙", "面差", "装配"]):
        return "装配间隙"
    if any(k in sol for k in ["色差", "颜色", "色温"]):
        return "色差"
    return "其他"


def extract_keywords(text):
    """Simple keyword extraction."""
    keywords = []
    keyword_list = [
        "起雾", "凝露", "漏水", "进水", "色差", "异响", "间隙", "面差",
        "LED", "灯珠", "不亮", "闪烁", "开路", "短路", "密封", "气密",
        "焊接", "振动", "碰撞", "断裂", "出粉", "白斑", "功耗", "法规",
        "装配", "铆接", "异物", "灰尘", "颜色", "漏光", "光学", "配光",
        "售后", "PPM", "涂胶", "打胶", "泡棉", "螺栓", "螺钉", "安装",
    ]
    text_lower = text.lower()
    for kw in keyword_list:
        if kw.lower() in text_lower:
            keywords.append(kw)
    return keywords


def transform_record(record, idx):
    """Transform a bitable record to our format."""
    fields = record.get("fields", {})
    record_id = record.get("record_id", "")

    summary = parse_text_field(fields.get("问题描述", ""))
    solution = parse_text_field(fields.get("优化方案", ""))
    root_cause = parse_text_field(fields.get("原因分析", ""))
    lighting_types = fields.get("灯具类型", [])
    problem_types = fields.get("问题类型", [])
    project = parse_text_field(fields.get("项目", []))
    seq = parse_text_field(fields.get("序号", ""))
    responsible = parse_person(fields.get("责任人", ""))
    create_date = ts_to_date(fields.get("创建日期"))
    close_date = ts_to_date(fields.get("实际关闭时间"))
    cad_version = parse_text_field(fields.get("对应数模版本", []))
    resolved = parse_text_field(fields.get("是否完全解决/落地方案", []))

    # Images
    problem_images = extract_images(fields.get("问题图示-描述清晰问题", []))
    fix_images = extract_images(fields.get("整改后问题图示-描述清晰问题", []))

    # Links
    attachments = extract_links(fields.get("附件-汇报资料", []))

    area = classify_area(lighting_types, summary)
    problem_type = classify_problem_type(problem_types, solution)
    keywords = extract_keywords(summary + " " + solution)

    return {
        "key": f"DIR-{idx:04d}",
        "viim_key": seq if seq else record_id,
        "summary": summary,
        "description": summary,
        "area": area,
        "problem_type": problem_type,
        "status": "Closed" if close_date else "Open",
        "solution": solution,
        "root_cause": root_cause,
        "solution_quality": "human",
        "keywords": keywords,
        "project": project,
        "lighting_types": parse_multi_select(lighting_types),
        "responsible": responsible,
        "create_date": create_date,
        "close_date": close_date,
        "cad_version": cad_version,
        "resolved": resolved,
        "problem_images": problem_images,
        "fix_images": fix_images,
        "attachments": attachments,
        "source": "飞书多维表格-量产灯问题清单",
    }


def main():
    # Read records from stdin (piped JSON)
    data = json.load(sys.stdin)
    records = data.get("records", [])

    print(f"Input records: {len(records)}")

    issues = []
    for i, record in enumerate(records, 1):
        try:
            issue = transform_record(record, i)
            issues.append(issue)
        except Exception as e:
            print(f"  ⚠️ Record {i} error: {e}", file=sys.stderr)

    output = {
        "meta": {
            "description": "灯具领域 FC 历史工单（从飞书多维表格导入）",
            "version": "3.0.0",
            "created": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d"),
            "source": "飞书多维表格-量产灯问题清单",
            "total": len(issues),
        },
        "issues": issues,
    }

    OUTPUT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Wrote {len(issues)} issues to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
