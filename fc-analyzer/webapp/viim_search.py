"""VIIM 实时搜索适配器 — 用 JQL 搜索 VIIM 全库。

替代本地 lighting_search，通过用户 token 实时检索 VIIM。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from viim_client import VIIMClient


# ── 关键词提取（复用 fc_extractor 的逻辑） ──────────────────────

_SYNONYMS = {
    "前灯": ["前灯", "大灯", "headlamp", "前照灯", "前组合灯"],
    "尾灯": ["尾灯", "后灯", "taillight", "后组合灯", "贯穿灯", "贯穿尾灯"],
    "转向灯": ["转向灯", "turn signal"],
    "雾灯": ["雾灯", "fog lamp"],
    "日行灯": ["日行灯", "DRL"],
    "LED": ["LED", "led", "灯珠", "光源"],
    "起雾": ["起雾", "凝露", "结露", "雾气", "水雾"],
    "色差": ["色差", "颜色不一致", "色温"],
    "亮度": ["亮度", "光照", "发光", "暗", "亮"],
    "密封": ["密封", "漏水", "进水", "气密", "防水"],
    "间隙": ["间隙", "面差", "段差", "配合"],
    "异响": ["异响", "噪声", "噪音", "吱吱", "咔嗒"],
    "振动": ["振动", "震动", "抖动"],
    "开裂": ["开裂", "裂纹", "断裂", "破裂"],
    "脱落": ["脱落", "掉漆", "剥落", "脱胶"],
    "漏光": ["漏光", "光线泄漏"],
    "闪烁": ["闪烁", "频闪", "闪烁"],
}

_AREA_KEYWORDS = {
    "EXT-Front End": ["前灯", "大灯", "headlamp", "前照灯", "前组合灯", "近光灯", "远光灯",
                       "日行灯", "DRL", "前转向", "前雾灯", "透镜", "灯碗"],
    "EXT-Rear End": ["尾灯", "后灯", "贯穿灯", "后组合灯", "后转向灯", "后雾灯",
                      "倒车灯", "刹车灯", "制动灯", "高位制动灯", "牌照灯"],
    "EXT-Side&Roof&Door": ["侧转向灯", "翼子板灯", "照地灯", "迎宾灯", "门板灯"],
    "INT-Door Trim": ["内饰灯", "阅读灯", "氛围灯", "顶灯", "室内灯"],
}


def _extract_search_keywords(text: str) -> dict[str, list[str]]:
    """从 FC 描述中提取搜索关键词。"""
    text_lower = text.lower()

    # 症状词
    symptoms = []
    for canonical, variants in _SYNONYMS.items():
        if any(v.lower() in text_lower for v in variants):
            symptoms.append(canonical)

    # 零件词（取原文中的关键词）
    parts = []
    for area, keywords in _AREA_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in text_lower:
                parts.append(kw)
                break

    # 区域
    area = None
    for a, keywords in _AREA_KEYWORDS.items():
        if any(kw.lower() in text_lower for kw in keywords):
            area = a
            break

    return {"symptoms": symptoms, "parts": parts, "area": area}


def _build_jql(keywords: dict[str, list[str]], text: str) -> str:
    """从关键词构建 VIIM JQL 查询。"""
    conditions = []

    # 用原文做全文搜索（最宽松）
    # 提取中文关键词做 summary ~ 搜索
    chinese_words = re.findall(r'[\u4e00-\u9fff]{2,}', text)
    if chinese_words:
        # 取最长的 3 个词做 OR 搜索
        words = sorted(chinese_words, key=len, reverse=True)[:3]
        summary_clauses = [f'summary ~ "{w}"' for w in words]
        conditions.append(f'({" OR ".join(summary_clauses)})')

    # 限制灯具项目（可选，如果 VIIM 有项目字段）
    # conditions.append('project = LIGHTING')

    if not conditions:
        # 兜底：用原文前 20 字符
        conditions.append(f'summary ~ "{text[:20]}"')

    jql = " AND ".join(conditions)
    jql += " ORDER BY updated DESC"
    return jql


def _score_hit(issue: dict, keywords: dict[str, list[str]], text: str) -> float:
    """计算 VIIM 搜索结果与查询的匹配度分数 (0-1)。"""
    summary = (issue.get("summary") or "").lower()
    description = (issue.get("description") or "").lower()
    full_text = f"{summary} {description}"
    text_lower = text.lower()

    score = 0.0

    # 1) 症状词匹配 (权重最高)
    symptom_matches = sum(1 for s in keywords["symptoms"] if s.lower() in full_text)
    if symptom_matches:
        score += 0.30 * min(symptom_matches / max(len(keywords["symptoms"]), 1), 1.0)

    # 2) 零件词匹配
    part_matches = sum(1 for p in keywords["parts"] if p.lower() in full_text)
    if part_matches:
        score += 0.25 * min(part_matches / max(len(keywords["parts"]), 1), 1.0)

    # 3) 区域匹配
    if keywords["area"]:
        # 检查 summary 是否包含该区域的关键词
        area_kws = _AREA_KEYWORDS.get(keywords["area"], [])
        if any(kw.lower() in summary for kw in area_kws):
            score += 0.15

    # 4) 文本覆盖度（查询字符被命中文本覆盖的比例；一模一样的问题 → ≈1。
    #    替代 Jaccard：避免命中工单的长描述把分母撑大，导致同源工单得分偏低）
    query_chars = set(re.findall(r'[\u4e00-\u9fff]', text_lower))
    hit_chars = set(re.findall(r'[\u4e00-\u9fff]', full_text))
    if query_chars:
        coverage = len(query_chars & hit_chars) / len(query_chars)
        score += 0.30 * coverage

    # 5) 近似精确匹配：归一化后存在包含关系（一模一样的问题）→ 直接判同源 95%
    nq = re.sub(r'[^一-鿿a-z0-9]', '', text_lower)
    ns = re.sub(r'[^一-鿿a-z0-9]', '', summary)
    if nq and ns and (nq == ns or nq in ns or ns in nq):
        score = max(score, 0.95)

    return min(score, 1.0)


def search_viim(
    client: VIIMClient,
    query: str,
    top: int = 5,
) -> list[dict]:
    """实时搜索 VIIM，返回带匹配度的相似案例列表。"""
    keywords = _extract_search_keywords(query)
    jql = _build_jql(keywords, query)

    # 搜索 VIIM（取多一些，后面会筛选排序）
    raw_issues = client.search_issues(
        jql=jql,
        fields=["summary", "description", "status", "assignee", "priority",
                "attachment", "comment", "created", "updated", "resolution",
                "customfield_10000", "customfield_10001", "customfield_10002"],
        max_results=50,
    )

    # 打分排序
    scored = []
    for issue in raw_issues:
        fld = issue.get("fields", {})
        hit = {
            "key": issue.get("key", ""),
            "summary": (fld.get("summary") or "").strip(),
            "description": (fld.get("description") or "").strip()[:500],
            "status": (fld.get("status", {}) or {}).get("name") or "",
            "assignee": (fld.get("assignee", {}) or {}).get("displayName") or "",
            "priority": (fld.get("priority", {}) or {}).get("name") or "",
            "created": (fld.get("created") or "")[:10],
            "updated": (fld.get("updated") or "")[:10],
            "resolution": (fld.get("resolution", {}) or {}).get("name") or "",
            "url": f"{client.url}/browse/{issue.get('key', '')}",
            "attachments": [],
        }

        # 提取附件（图片）—— VIIM 附件需鉴权，统一改写为本站代理地址
        attachments = fld.get("attachment") or []
        for att in attachments:
            if att.get("mimeType", "").startswith("image/"):
                from urllib.parse import quote
                content = att.get("content", "") or ""
                thumb = att.get("thumbnail", "") or content
                hit["attachments"].append({
                    "filename": att.get("filename", ""),
                    "url": "/api/viim-attachment?url=" + quote(content, safe="") if content else "",
                    "thumbnail": "/api/viim-attachment?url=" + quote(thumb, safe="") if thumb else "",
                    "size": att.get("size", 0),
                })

        # 计算匹配度
        score = _score_hit(hit, keywords, query)
        hit["score"] = round(score, 3)
        scored.append(hit)

    # 按分数排序，取 top
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top]
