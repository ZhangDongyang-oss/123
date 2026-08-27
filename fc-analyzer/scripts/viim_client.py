#!/usr/bin/env python3
"""
VIIM Jira REST 客户端（灯具 FC 可行性分析专用）

基于 FC Copilot viim_client.py 改造。
直接调 https://ticket.example.com/rest/api/2/...

凭证优先级：
  1. 环境变量 VIIM_URL / VIIM_API_TOKEN
  2. ~/.viim.env 文件
  3. 传入参数 token

用法:
    from viim_client import VIIMClient
    client = VIIMClient(token="your-token")
    result = client.create_issue(summary="...", description="...", additional_fields={...})
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ENV_FILE = Path.home() / ".viim.env"
DEFAULT_URL = "https://ticket.example.com"
TIMEOUT = 30

# 单字母严重度 → VIIM 完整取值（2026-08-21 契约漂移，与 lighting_extractor._SEVERITY_VIIM_MAP 保持一致）
_SEVERITY_VIIM_MAP = {
    "S": "S-非常重要（安全/法规/抛锚）",
    "A": "A-重要",
    "B": "B-一般重要",
    "C": "C-一般",
    "D": "D-不重要",
}


class VIIMError(Exception):
    def __init__(self, code: int, payload: dict):
        self.code = code
        self.payload = payload
        super().__init__(f"VIIM {code}: {payload}")


class VIIMClient:
    """VIIM Jira REST API 客户端。"""

    def __init__(self, token: str | None = None, url: str | None = None):
        self.url = (url or self._load_url()).rstrip("/")
        self.token = token or self._load_token()

    def _load_url(self) -> str:
        url = os.environ.get("VIIM_URL")
        if url:
            return url
        if ENV_FILE.exists():
            for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("VIIM_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        return DEFAULT_URL

    def _load_token(self) -> str:
        token = os.environ.get("VIIM_API_TOKEN")
        if token:
            return token
        if ENV_FILE.exists():
            for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("VIIM_API_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        raise RuntimeError(
            f"VIIM_API_TOKEN 未配置。请设置环境变量或创建 {ENV_FILE} 文件。\n"
            f"格式：VIIM_URL=https://ticket.example.com\\nVIIM_API_TOKEN=your-token"
        )

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.url}{path}"
        data = None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
                if not raw:
                    return {}
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8")
                err_obj = json.loads(err_body)
            except Exception:
                err_obj = {"raw": err_body if "err_body" in locals() else str(e)}
            raise VIIMError(e.code, err_obj) from e

    def get_myself(self) -> dict:
        """返回当前 token 对应的 VIIM 用户。"""
        return self._request("GET", "/rest/api/2/myself")

    def resolve_username(self, username_or_prefix: str) -> str | None:
        """查找真实 VIIM username。"""
        if not username_or_prefix:
            return None
        qs = urllib.parse.urlencode({"username": username_or_prefix, "maxResults": 5})
        try:
            users = self._request("GET", f"/rest/api/2/user/search?{qs}")
        except VIIMError:
            return None
        if not users:
            return None
        actives = [u for u in users if u.get("active")]
        pool = actives or users
        target = username_or_prefix.lower()
        for u in pool:
            email = (u.get("emailAddress") or "").lower()
            if email.split("@", 1)[0] == target or u.get("name", "").lower() == target:
                return u.get("name")
        return pool[0].get("name")

    def create_issue(
        self,
        summary: str,
        description: str,
        additional_fields: dict,
        project_key: str = "DEMODIR",
        issue_type_id: str = "10700",
        issue_type_name: str | None = None,
    ) -> dict:
        """
        在 VIIM 建一条工单。
        返回 {"key": "DIR-xxx", "id": "...", "url": "<browse url>"}。
        """
        issue_type = {"name": issue_type_name} if issue_type_name else {"id": issue_type_id}
        payload = {
            "fields": {
                "project": {"key": project_key},
                "issuetype": issue_type,
                "summary": summary,
                "description": description,
                **additional_fields,
            }
        }
        resp = self._request("POST", "/rest/api/2/issue", payload)
        key = resp.get("key")
        return {
            "key": key,
            "id": resp.get("id"),
            "url": f"{self.url}/browse/{key}" if key else None,
            "raw": resp,
        }

    def get_issue(self, key: str) -> dict | None:
        """获取单条 issue 详情。"""
        try:
            data = self._request("GET", f"/rest/api/2/issue/{urllib.parse.quote(key)}")
        except VIIMError:
            return None
        fld = data.get("fields", {})
        return {
            "key": data.get("key", key),
            "summary": (fld.get("summary") or "").strip(),
            "description": (fld.get("description") or "").strip(),
            "status": (fld.get("status", {}) or {}).get("name") or "",
            "assignee": (fld.get("assignee", {}) or {}).get("displayName") or "",
            "url": f"{self.url}/browse/{key}",
        }

    def search_issues(self, jql: str, fields: list[str] | None = None, max_results: int = 50) -> list[dict]:
        """JQL 搜索。"""
        fields_str = ",".join(fields) if fields else "summary,status,assignee,updated"
        qs = urllib.parse.urlencode({"jql": jql, "fields": fields_str, "maxResults": max_results})
        try:
            data = self._request("GET", f"/rest/api/2/search?{qs}")
            return data.get("issues") or []
        except VIIMError:
            return []

    def upload_attachment(self, issue_key: str, file_path: str, filename: str | None = None) -> list[dict]:
        """上传附件到 issue。"""
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"文件不存在: {file_path}")
        filename = filename or path.name
        url = f"{self.url}/rest/api/2/issue/{urllib.parse.quote(issue_key)}/attachments"

        # Multipart form data
        boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
        body = bytearray()
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode())
        body.extend(b"Content-Type: application/octet-stream\r\n\r\n")
        body.extend(path.read_bytes())
        body.extend(f"\r\n--{boundary}--\r\n".encode())

        req = urllib.request.Request(
            url,
            data=bytes(body),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "X-Atlassian-Token": "no-check",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            raise VIIMError(e.code, {"raw": err_body}) from e

    def build_payload(
        self,
        fields: dict,
        summary: str,
        description: str,
    ) -> dict:
        """从抽取字段构建 VIIM create_issue payload。委托给独立函数。"""
        return build_viim_payload(fields, summary, description)


def _normalize_severity(value, default: str = "A-重要") -> str:
    """把单字母严重度归一化为 VIIM 完整取值；已是完整取值则原样返回。"""
    v = (value or "").strip()
    if not v:
        return default
    return _SEVERITY_VIIM_MAP.get(v, v)


def build_viim_payload(
    fields: dict,
    summary: str,
    description: str,
) -> dict:
    """
    从抽取字段构建 VIIM create_issue payload（独立函数，无需 VIIMClient 实例）。
    fields: lighting_extractor.extract_fields() 的输出
    """
    from datetime import date, timedelta
    today = date.today()

    additional_fields = {
        # 问题提出部门
        "customfield_13082": {"value": fields.get("viim_department", "Body-Ext. Trim")},
        # 问题所属区域
        "customfield_13088": {"value": fields.get("viim_area", "EXT-Front End")},
        # 严重度
        "customfield_10621": {"value": _normalize_severity(fields.get("viim_severity"))},
        # 紧急程度
        "customfield_14001": {"value": fields.get("viim_urgency", "非紧急（Non-urgent）")},
        # 问题所属阶段
        "customfield_13089": {"value": fields.get("viim_phase", "CAS2")},
        # 对应TI状态
        "customfield_13085": {"value": fields.get("viim_ti_status", "No TI")},
        # 问题对策及方案
        "customfield_13087": description,
        # 问题要求关闭时间
        "customfield_13084": fields.get("viim_close_date",
                                        (today + timedelta(days=14)).isoformat()),
        # CAS计划输出时间
        "customfield_13876": fields.get("viim_cas_date",
                                        (today + timedelta(days=21)).isoformat()),
    }

    # 车型 / 问题提出CAS号：为空则不传（select/textfield 传空值会报错）
    car_model = (fields.get("viim_car_model") or "").strip()
    if car_model:
        additional_fields["customfield_13913"] = {"value": car_model}
    cas_number = (fields.get("viim_cas_number") or "").strip()
    if cas_number:
        additional_fields["customfield_13083"] = cas_number
    # 其余选填字段：为空则不传
    close_cas = (fields.get("viim_close_cas_number") or "").strip()
    if close_cas:
        additional_fields["customfield_13873"] = close_cas
    ti_part = (fields.get("viim_ti_part_number") or "").strip()
    if ti_part:
        additional_fields["customfield_13086"] = ti_part
    related = (fields.get("viim_related_owners") or "").strip()
    if related:
        additional_fields["customfield_10829"] = [
            {"name": e.strip()}
            for e in related.replace("；", ",").replace("，", ",").split(",") if e.strip()
        ]
    assignee = (fields.get("viim_assignee") or "").strip()
    if assignee:
        additional_fields["assignee"] = {"name": assignee}

    return {
        "summary": summary,
        "description": description,
        "additional_fields": additional_fields,
        # 项目 key（可能为空，留空则由核对页人工选择/校验）
        "project": (fields.get("viim_project") or "").strip(),
    }


def dry_run_report(payload: dict) -> str:
    """生成 dry-run 报告，供用户确认。"""
    lines = []
    lines.append("## VIIM 建单预览（Dry-Run）\n")
    lines.append(f"**概要**：{payload['summary']}")
    lines.append(f"**项目**：DIR | **类型**：FC-造型工程问题\n")

    fields = payload["additional_fields"]
    field_names = {
        "customfield_13913": "车型",
        "customfield_13082": "问题提出部门",
        "customfield_13088": "问题所属区域",
        "customfield_10621": "严重度",
        "customfield_14001": "紧急程度",
        "customfield_13089": "问题所属阶段",
        "customfield_13083": "问题提出CAS号",
        "customfield_13085": "对应TI状态",
        "customfield_13084": "问题要求关闭时间",
        "customfield_13876": "CAS计划输出时间",
    }

    lines.append("### 字段\n")
    lines.append("| 字段 | 值 |")
    lines.append("|------|-----|")
    for fid, fname in field_names.items():
        val = fields.get(fid, "")
        if isinstance(val, dict):
            val = val.get("value", str(val))
        lines.append(f"| {fname} | {val} |")

    lines.append(f"\n**描述**（前200字）：\n{payload['description'][:200]}...")

    lines.append("\n---")
    lines.append("⚠️ 以上为预览，确认后将创建**真实 VIIM 工单**。")
    lines.append("回复「提交」「发」「建单」「可以」确认创建。")

    return "\n".join(lines)


# ---------- CLI ----------
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("用法: python viim_client.py <command> [args]")
        print("  myself    - 验证 token")
        print("  search <jql> - JQL 搜索")
        print("  get <key>    - 获取 issue 详情")
        sys.exit(1)

    cmd = sys.argv[1]
    client = VIIMClient()

    if cmd == "myself":
        user = client.get_myself()
        print(f"用户: {user.get('displayName')} ({user.get('name')})")
        print(f"邮箱: {user.get('emailAddress')}")

    elif cmd == "search":
        jql = sys.argv[2] if len(sys.argv) > 2 else "project = DEMODIR AND issuetype = 'FC-造型工程问题' ORDER BY created DESC"
        issues = client.search_issues(jql, max_results=10)
        for i in issues:
            print(f"{i['key']}: {i.get('fields', {}).get('summary', '')}")

    elif cmd == "get":
        key = sys.argv[2]
        issue = client.get_issue(key)
        if issue:
            print(json.dumps(issue, ensure_ascii=False, indent=2))
        else:
            print(f"未找到 {key}")
