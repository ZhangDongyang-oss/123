#!/usr/bin/env python3
"""
灯具领域 FC 字段抽取器

基于 FC Copilot fc_extractor.py 改造，专用于灯具（前灯/尾灯/雾灯/转向灯等）。
纯规则，无 LLM，离线可跑。

输入: 一句话 FC 描述 + 当前日期
输出: 24 字段 dict（VIIM 值 / 飞书值两套）

用法:
    python lighting_extractor.py "尾灯色差：高温环境下LED色温偏移导致红光色差"
    python lighting_extractor.py "前灯起雾，洗车后灯罩内凝露" --json
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

# ---------- 加载关键词字典 ----------
SCRIPT_DIR = Path(__file__).parent
DATABASE_DIR = SCRIPT_DIR.parent / "database"
KEYWORDS_FILE = DATABASE_DIR / "lighting_keywords.json"


def _load_keywords() -> dict:
    if KEYWORDS_FILE.exists():
        return json.loads(KEYWORDS_FILE.read_text(encoding="utf-8"))
    return {}


_KW = _load_keywords()

# ---------- 区域映射 ----------
_AREA_MAP = []
for area_key, keywords in _KW.get("area_keywords", {}).items():
    area_name_map = {
        "front_light": ("EXT-Front End", "EXT-Front End", "Body-Ext. Trim", "Body Ext trim"),
        "rear_light": ("EXT-Rear End", "EXT-Rear End", "Body-Ext. Trim", "Body Ext trim"),
        "side_light": ("EXT-Side&Roof&Door", "EXT-Side&Roof&Door", "Body-Ext. Trim", "Body Ext trim"),
        "interior_light": ("INT-Door Trim", "INT-Door Trim", "Body-Int. Trim", "Body Int trim"),
        "chmsl": ("EXT-Rear End", "EXT-Rear End", "Body-Ext. Trim", "Body Ext trim"),
        "cornering_light": ("EXT-Front End", "EXT-Front End", "Body-Ext. Trim", "Body Ext trim"),
    }
    if area_key in area_name_map:
        _AREA_MAP.append((keywords, *area_name_map[area_key]))

_DEFAULT_AREA = ("EXT-Front End", "EXT-Front End", "Body-Ext. Trim", "Body Ext trim")

# ---------- 严重度线索 ----------
_SEVERITY_CLUES = []
for level, keywords in _KW.get("symptom_severity", {}).items():
    _SEVERITY_CLUES.append((level, keywords))

# 单字母严重度 → VIIM 完整取值（2026-08-21 契约漂移：S/A/B/C 升级为 5 档带后缀）
_SEVERITY_VIIM_MAP = {
    "S": "S-非常重要（安全/法规/抛锚）",
    "A": "A-重要",
    "B": "B-一般重要",
    "C": "C-一般",
    "D": "D-不重要",
}

_QUANT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(%|度|°|mm|MPa|N|℃|dB|lm|lux|cd)")

# ---------- 阶段映射 ----------
_PHASE_NEXT = {
    "CAS0": "CAS1", "CAS1": "CAS2", "CAS2": "CAS3", "CAS3": "CAS4",
    "CAS4": "AA1", "AA1": "AA2", "AA2": "V0", "V0": "V1", "V1": "V2",
    "V2": "V2", "VP": "V2", "PT": "V2", "SOP": "V2",
    # 灯具特有阶段别名
    "A面": "CAS0", "造型冻结": "CAS2", "结构设计": "CAS3",
    "模具开发": "CAS4", "OTS": "AA1", "PPAP": "AA2",
}
_PHASE_RE = re.compile(r"(CAS[0-4]|AA[12]|V[012]|VP|PT|SOP|A面|造型冻结|结构设计|模具开发|OTS|PPAP)", re.IGNORECASE)


def _is_standalone(text: str, start: int, end: int) -> bool:
    if start > 0:
        c = text[start - 1]
        if c.isascii() and c.isalnum():
            return False
    if end < len(text):
        c = text[end]
        if c.isascii() and c.isalnum():
            return False
    return True


# ---------- 区域检测 ----------
def _detect_area(text: str) -> tuple[str, str, str, str]:
    low = text.lower()
    for keys, va, fa, vd, fd in _AREA_MAP:
        for k in keys:
            if k in low:
                return va, fa, vd, fd
    return _DEFAULT_AREA


# ---------- 车型检测 ----------
# 取消默认值：识别不出则返回空字符串，由用户在核对页手动选择
_DEFAULT_CAR_MODEL = ""


def _detect_car_model(text: str) -> str:
    """从描述识别车型，未命中返回空字符串（留空待人工选择）。"""
    low = text.lower()
    if "车型F" in low:
        return "车型F-25C"
    if "车型H" in low:
        return "车型C-车型H-RHD" if "rhd" in low else "车型C-车型H"
    if "车型I" in low:
        return "车型C-车型I-EU"
    if "车型J" in low:
        return "车型C-车型J"
    if "26d" in low:
        return "车型C-U-26D-市场版" if "市场" in low else "车型C-U-26D-赛道版"
    if "车型C" in low:
        return "车型C-L"
    return _DEFAULT_CAR_MODEL


# ---------- 问题提出 CAS 号检测 ----------
# 只抽稳定的 STY 编号（如 STY000007054），其余格式边界不清晰、留空人工填
_CAS_RE = re.compile(r"(STY\s*\d+[A-Za-z0-9.]*)", re.IGNORECASE)


def _detect_cas_number(text: str) -> str:
    """从描述抽取 CAS 号（STY 编号），识别不出留空。"""
    m = _CAS_RE.search(text or "")
    return m.group(1) if m else ""


# ---------- 项目检测 ----------
# FC-造型工程问题 当前在 VIIM 中仅 DEMODIR（车型C-DIR）一个项目（2026-08-21 实测）
# 默认不填：识别不出留空，由用户在核对页手动选择
_DEFAULT_PROJECT = ""


def _detect_project(text: str) -> str:
    """从描述判断项目。识别出已知车型线索 → DEMODIR（当前唯一 FC 项目），否则留空。"""
    if _detect_car_model(text):
        return "DEMODIR"
    return _DEFAULT_PROJECT


# ---------- 严重度检测 ----------
def _detect_severity(text: str) -> str:
    low = text.lower()
    for level, clues in _SEVERITY_CLUES:
        for c in clues:
            if c in low:
                return level
    # 数值偏差检测
    for m in _QUANT_RE.finditer(text):
        try:
            num = float(m.group(1))
        except ValueError:
            continue
        unit = m.group(2)
        if unit == "%" and num >= 30:
            return "A"
        if unit == "%" and num < 10:
            return "C"
    return "A"  # 灯具默认 A（涉及法规）


# ---------- 紧急程度 ----------
def _detect_urgency(sev: str, text: str) -> tuple[str, str]:
    urgent_clues = ["紧急", "立即", "马上", "尽快", "停产", "停线", "召回", "批量", "整车"]
    low = text.lower()
    is_urgent = sev in ("S", "A") or any(c in low for c in urgent_clues)
    viim = "紧急（Urgent）" if is_urgent else "非紧急（Non-urgent）"
    feishu = "紧急" if is_urgent else "非紧急"
    return viim, feishu


# ---------- 阶段检测 ----------
def _detect_phase(text: str, default: str = "CAS2") -> str:
    for m in _PHASE_RE.finditer(text):
        if _is_standalone(text, m.start(), m.end()):
            phase = m.group(1).upper()
            # 灯具别名转标准值
            alias_map = {"A面": "CAS0", "造型冻结": "CAS2", "结构设计": "CAS3",
                         "模具开发": "CAS4", "OTS": "AA1", "PPAP": "AA2"}
            return alias_map.get(phase, phase)
    return default


# ---------- 概要生成 ----------
def _gen_summary(text: str, area: str, max_len: int = 60) -> str:
    """从描述中提取核心问题作为概要（≤20字），格式「区域+现象」。"""
    area_short = {
        "EXT-Front End": "前灯", "EXT-Rear End": "尾灯",
        "EXT-Side&Roof&Door": "侧灯", "INT-Door Trim": "内饰灯",
    }.get(area, "灯具")

    # 提取症状词
    all_symptoms = []
    for keywords in _KW.get("problem_keywords", {}).values():
        all_symptoms.extend(keywords)

    found_symptom = None
    for s in all_symptoms:
        if s in text:
            found_symptom = s
            break

    if found_symptom:
        summary = f"{area_short}{found_symptom}"
    else:
        summary = f"{area_short}问题"

    return summary[:max_len]


# ---------- 描述生成 ----------
def _gen_description(text: str, area: str, severity: str) -> str:
    """把一句话扩展为结构化描述。"""
    area_full = {
        "EXT-Front End": "前灯总成", "EXT-Rear End": "尾灯总成",
        "EXT-Side&Roof&Door": "侧灯/标志灯", "INT-Door Trim": "内饰灯具",
    }.get(area, "灯具")

    parts = [f"现象：{text}"]
    parts.append(f"区域：{area_full}")

    # 提取条件
    conditions = []
    for kw in _KW.get("trigger_keywords", {}).values():
        for k in kw:
            if k in text:
                conditions.append(k)
    if conditions:
        parts.append(f"触发条件：{'、'.join(conditions[:3])}")

    parts.append(f"严重度：{severity}")
    return "\n".join(parts)


# ---------- 零件抽取 ----------
def _extract_parts(text: str) -> list[str]:
    found = []
    for category_keywords in _KW.get("part_keywords", {}).values():
        for kw in category_keywords:
            if kw in text and kw not in found:
                found.append(kw)
    return found[:5]


# ---------- 症状抽取 ----------
def _extract_symptoms(text: str) -> list[str]:
    found = []
    for category_keywords in _KW.get("problem_keywords", {}).values():
        for kw in category_keywords:
            if kw in text and kw not in found:
                found.append(kw)
    return found[:5]


# ---------- 条件抽取 ----------
def _extract_conditions(text: str) -> list[str]:
    found = []
    for category_keywords in _KW.get("trigger_keywords", {}).values():
        for kw in category_keywords:
            if kw in text and kw not in found:
                found.append(kw)
    return found[:5]


# ---------- 主抽取入口 ----------
def extract_fields(text: str, today: date | None = None) -> dict:
    """
    从一句话描述中抽取 FC 字段。
    返回 24 字段 dict，含 viim_* 和 feishu_* 两套值。
    """
    if today is None:
        today = date.today()

    # 1. 区域
    viim_area, feishu_area, viim_dept, feishu_dept = _detect_area(text)

    # 1.5 车型
    car_model = _detect_car_model(text)

    # 1.6 项目 / CAS 号
    project_key = _detect_project(text)
    cas_number = _detect_cas_number(text)

    # 2. 严重度
    severity = _detect_severity(text)  # 单字母 S/A/B/C
    viim_severity = _SEVERITY_VIIM_MAP.get(severity, severity)  # 映射到 VIIM 完整取值

    # 3. 紧急程度
    viim_urgency, feishu_urgency = _detect_urgency(severity, text)

    # 4. 阶段
    phase = _detect_phase(text)

    # 5. 概要
    summary = _gen_summary(text, viim_area)

    # 6. 描述
    description = _gen_description(text, viim_area, viim_severity)

    # 7. 零件 / 症状 / 条件
    parts = _extract_parts(text)
    symptoms = _extract_symptoms(text)
    conditions = _extract_conditions(text)

    # 8. 日期计算
    close_date = (today + timedelta(days=14)).isoformat()
    cas_date = (today + timedelta(days=21)).isoformat()

    # 9. 阶段下一阶段
    next_phase = _PHASE_NEXT.get(phase, "V2")

    return {
        # ---- VIIM 值 ----
        "viim_project": project_key,
        "viim_issue_type": "FC-造型工程问题",
        "viim_car_model": car_model,
        "viim_department": viim_dept,
        "viim_area": viim_area,
        "viim_severity": viim_severity,
        "viim_urgency": viim_urgency,
        "viim_phase": phase,
        "viim_cas_number": cas_number,
        "viim_ti_status": "No TI",
        "viim_close_date": close_date,
        "viim_cas_date": cas_date,
        "viim_next_phase": next_phase,
        # 以下字段默认留空，由用户在核对页手动填写（识别不出不填）
        "viim_close_cas_number": "",   # 问题关闭CAS号 cf13873
        "viim_ti_part_number": "",     # 对应TI件号 cf13086
        "viim_related_owners": "",     # 关联责任人 cf10829（逗号分隔邮箱）
        "viim_assignee": "",           # 经办人 assignee

        # ---- 飞书值 ----
        "feishu_department": feishu_dept,
        "feishu_area": feishu_area,
        "feishu_severity": severity,
        "feishu_urgency": feishu_urgency,
        "feishu_phase": phase,

        # ---- 通用 ----
        "summary": summary,
        "description": description,
        "parts": parts,
        "symptoms": symptoms,
        "conditions": conditions,
        "raw_text": text,
    }


# ---------- CLI ----------
def main():
    import argparse
    ap = argparse.ArgumentParser(description="灯具 FC 字段抽取器")
    ap.add_argument("text", help="问题描述（自然语言）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    fields = extract_fields(args.text)

    if args.json:
        print(json.dumps(fields, ensure_ascii=False, indent=2))
        return 0

    print(f"概要: {fields['summary']}")
    print(f"区域: {fields['viim_area']}  |  部门: {fields['viim_department']}")
    print(f"严重度: {fields['viim_severity']}  |  紧急: {fields['viim_urgency']}")
    print(f"阶段: {fields['viim_phase']} → {fields['viim_next_phase']}")
    print(f"零件: {', '.join(fields['parts']) or '—'}")
    print(f"症状: {', '.join(fields['symptoms']) or '—'}")
    print(f"条件: {', '.join(fields['conditions']) or '—'}")
    print(f"关闭: {fields['viim_close_date']}  |  CAS: {fields['viim_cas_date']}")
    print()
    print("描述:")
    print(fields["description"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
