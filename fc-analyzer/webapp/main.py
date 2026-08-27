#!/usr/bin/env python3
"""
FC 可行性分析 — Web UI (Flask + Jinja2)
Apple-inspired design, matching FC-copilot style.
"""
import json
import os
import sys
import uuid
from datetime import datetime, date, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
SCRIPTS_DIR = BASE_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from flask import (Flask, render_template, request, jsonify,
                   redirect, url_for, session)
from markupsafe import escape

from lighting_extractor import extract_fields
from lighting_search import search_similar_issues, _case_dedupe_key
from lighting_analyzer import generate_report, format_report_markdown, build_advice_context
from feedback import collect_feedback, get_accuracy_report, format_accuracy_report, apply_learning
from alerts import (track_issue, check_alerts, get_management_dashboard,
                    format_dashboard_markdown, get_followup_reminders, format_reminders_markdown,
                    _load_json, TRACKING_FILE)

# ---------------------------------------------------------------------------
# App & config
# ---------------------------------------------------------------------------

app = Flask(__name__,
            template_folder=str(Path(__file__).parent / "templates"),
            static_folder=str(Path(__file__).parent / "static"))

# 静态资源不做长缓存，避免主题/样式更新后浏览器仍用旧文件
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

import logging
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("fc-web")

_secret_key = os.environ.get("FLASK_SECRET_KEY", "").strip()
if not _secret_key:
    _secret_key = os.urandom(32).hex()
    log.warning("FLASK_SECRET_KEY 未设置，已随机生成（重启后失效，session 将全部失效）。生产环境请设置固定密钥。")
app.secret_key = _secret_key


from infra import (BASE_DIR, DATABASE_DIR, TOKENS_FILE, SUBMISSIONS_FILE,
                   DRAFTS_FILE, REMINDERS_FILE, TEMP_UPLOADS_DIR, FEEDBACK_FILE,
                   USAGE_FILE, _load_json_db, _save_json_db, _ensure_session,
                   _bump_usage, _get_token_for_session, _set_token_for_session,
                   _clear_token_for_session)
import bp_proxy
import bp_reminders
from bp_proxy import viim_att_proxy_url

# 滚动日志文件：logs/fc-web.log（1MB × 3 份）
try:
    from logging.handlers import RotatingFileHandler
    _LOG_DIR = BASE_DIR / "logs"
    _LOG_DIR.mkdir(exist_ok=True)
    _fh = RotatingFileHandler(_LOG_DIR / "fc-web.log", maxBytes=1_000_000,
                              backupCount=3, encoding="utf-8")
    _fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(_fh)
except Exception as e:
    log.warning("日志文件 handler 初始化失败（将仅输出到控制台）: %s", e)

app.register_blueprint(bp_proxy.bp)
app.register_blueprint(bp_reminders.bp)


# ---------------------------------------------------------------------------
# Login gate middleware
# ---------------------------------------------------------------------------

PUBLIC_ROUTES = {"/", "/account", "/api/account", "/api/set-token", "/api/clear-token", "/api/feedback", "/api/reminders", "/api/reminders/list", "/api/draft", "/landing"}
API_PREFIX = "/api/"


@app.before_request
def login_gate():
    _ensure_session()
    path = request.path

    # Static files are always allowed
    if path.startswith("/static"):
        return None

    # Public routes
    if path in PUBLIC_ROUTES:
        return None

    # Check token
    token = _get_token_for_session()
    if token is None:
        # API routes return 401 JSON
        if path.startswith(API_PREFIX):
            return jsonify({"error": "unauthorized", "message": "请先设置 VIIM Token"}), 401
        # Page routes redirect to account
        return redirect(url_for("account_page"))

    # Attach client for downstream use
    try:
        from viim_client import VIIMClient
        request.viim_client = VIIMClient(token=token)
    except Exception as e:
        log.warning("VIIMClient 初始化失败: %s", e)
        if path.startswith(API_PREFIX):
            return jsonify({"error": "invalid_token", "message": "Token 初始化失败"}), 401
        return redirect(url_for("account_page"))

    return None


# ---------------------------------------------------------------------------
# Examples (existing)
# ---------------------------------------------------------------------------

EXAMPLES = [
    "前灯起雾，洗车后灯罩内凝露",
    "尾灯色差，夜间亮度不足",
    "转向灯频闪，高温时明显",
    "雾灯配光不合格，ECE R148 不达标",
    "LED模组光衰，点亮500小时后亮度下降30%",
]


# ---------------------------------------------------------------------------
# Page routes (existing)
# ---------------------------------------------------------------------------

@app.route("/")
@app.route("/landing")
def landing_page():
    """根路径即导引页：视频背景 + 入口卡片。"""
    return render_template("landing.html")


@app.route("/ask")
def index():
    return render_template("index.html", examples=EXAMPLES)


@app.route("/new")
def new_page():
    return render_template("new.html")


@app.route("/history")
def history_page():
    return render_template("history.html")


@app.route("/draft/<key>")
def draft_detail(key):
    """Show draft detail page."""
    drafts = _load_json_db(DRAFTS_FILE, {"drafts": []})
    draft = None
    for d in drafts.get("drafts", []):
        if d.get("id") == key.split("-")[-1] if "-" in key else d.get("id") == key:
            draft = d
            break
    if not draft:
        # Try matching full key
        for d in drafts.get("drafts", []):
            if f"DRAFT-{d.get('id', '')}" == key:
                draft = d
                break
    if not draft:
        return render_template("draft_detail.html", draft=None, error="未找到该草稿")
    return render_template("draft_detail.html", draft=draft)


@app.route("/feedback")
def feedback_page():
    return render_template("feedback.html")


# ---------------------------------------------------------------------------
# Review context helpers (3-column confirm page)
# ---------------------------------------------------------------------------

def _build_viim_payload(fields: dict, report: dict | None = None) -> dict:
    """构造 VIIM 建单 payload，委托给 viim_client.build_viim_payload。"""
    from viim_client import build_viim_payload
    description = fields.get("description", "")
    if report and report.get("recommendation"):
        description += f"\n\n---\n历史案例推荐方案：\n{report['recommendation']}"
    summary = fields.get("summary", "")
    return build_viim_payload(fields, summary, description)


def _field_confidence(text: str, fields: dict) -> dict:
    """按抽取线索是否显式命中，估算各字段置信度（0~1）。"""
    import lighting_extractor as lex
    low = (text or "").lower()
    area_hit = fields.get("viim_area") != lex._DEFAULT_AREA[0]
    sev_hit = any(c in low for _, clues in lex._SEVERITY_CLUES for c in clues)
    phase_hit = bool(lex._PHASE_RE.search(text or ""))
    urg_hit = any(w in low for w in ["紧急", "立即", "马上", "尽快", "停产", "停线", "召回", "批量", "整车"])
    area_c = 0.8 if area_hit else 0.3
    sev_c = 0.7 if sev_hit else 0.4
    phase_c = 0.7 if phase_hit else 0.35
    urg_c = 0.7 if urg_hit else 0.4
    overall = round(0.3 * area_c + 0.25 * sev_c + 0.2 * phase_c + 0.25 * urg_c, 2)
    return {"overall": overall, "area": area_c, "severity": sev_c,
            "phase": phase_c, "urgency": urg_c}


def _merge_hits(viim_hits: list, local_hits: list, top: int = 6) -> list:
    """两路命中按分数降序合并、按归一化文本去重（两路分数均为 0~1）。"""
    merged, seen = [], set()
    for h in sorted(list(viim_hits) + list(local_hits),
                    key=lambda x: x.get("score", 0.0), reverse=True):
        dk = _case_dedupe_key(h) or h.get("key") or h.get("summary") or ""
        if dk in seen:
            continue
        seen.add(dk)
        merged.append(h)
    return merged[:top]


def _review_context(description: str, car_model: str | None = None,
                    project: str | None = None, severity: str | None = None,
                    area: str | None = None) -> dict:
    """计算核对页全部上下文：字段/置信度/案例/建议/payload。"""
    fields = extract_fields(description)
    # 提工单页显式指定的值覆盖 AI 识别
    if car_model:
        fields["viim_car_model"] = car_model
    if project:
        fields["viim_project"] = project
    if severity:
        fields["viim_severity"] = severity
    if area:
        fields["viim_area"] = area
    confidence = _field_confidence(description, fields)

    hits, source = [], "local"
    token = _get_token_for_session()
    viim_hits = []
    if token:
        try:
            from viim_search import search_viim
            viim_hits = search_viim(request.viim_client, description, top=6)
        except Exception as e:
            log.warning("VIIM search failed, using local only: %s", e)
    local_hits = search_similar_issues(query=description, area=fields["viim_area"], top=6)
    hits = _merge_hits(viim_hits, local_hits)
    source = "mixed" if (viim_hits and local_hits) else ("viim" if viim_hits else "local")

    report = generate_report(hits, query=description, area=fields["viim_area"],
                             severity=fields["viim_severity"], phase=fields["viim_phase"])
    advice = build_advice_context(report, hits, query=description,
                                  severity=fields["viim_severity"], source=source)

    # 对策方案预填：TOP-3 相似案例方案编号列表（可改）
    if not fields.get("solution"):
        sols = []
        for h in hits[:3]:
            s = (h.get("solution") or "").strip().replace("\n", " ")
            if s:
                sols.append(s[:80])
        if sols:
            fields["solution"] = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(sols))

    payload = _build_viim_payload(fields, report)
    return {"fields": fields, "confidence": confidence, "hits": hits,
            "report": report, "advice": advice, "payload": payload,
            "query": description, "source": source}


# ---------------------------------------------------------------------------
# Page routes (new)
# ---------------------------------------------------------------------------

@app.route("/account")
def account_page():
    sid = session.get("fc_sid")
    stats = _load_json_db(USAGE_FILE, {}).get(sid, {}) if sid else {}
    return render_template("account.html", stats=stats)


@app.route("/review", methods=["GET", "POST"])
def review_page():
    ctx = None
    description = ""
    car_model = project = severity = area = None
    if request.method == "POST":
        description = (request.form.get("description") or "").strip()
        car_model = (request.form.get("car_model") or "").strip()
        project = (request.form.get("project") or "").strip()
        severity = (request.form.get("severity") or "").strip()
        area = (request.form.get("area") or "").strip()
    elif request.args.get("q"):
        description = request.args.get("q", "").strip()
    if description:
        ctx = _review_context(description, car_model=car_model,
                               project=project, severity=severity, area=area)
    return render_template("review.html", **(ctx or {}))


@app.route("/submissions")
def submissions_page():
    return render_template("submissions.html")


@app.route("/reminders")
def reminders_page():
    return render_template("reminders.html")


# ---------------------------------------------------------------------------
# API — Account
# ---------------------------------------------------------------------------

@app.route("/api/account", methods=["GET", "POST"])
def api_account():
    _ensure_session()
    token = _get_token_for_session()
    result = {"has_token": token is not None, "logged_in": False, "session_id": session.get("fc_sid")}
    if token:
        try:
            from viim_client import VIIMClient
            client = VIIMClient(token=token)
            user = client.get_myself()
            result["user"] = {
                "name": user.get("displayName"),
                "email": user.get("emailAddress"),
                "username": user.get("name"),
            }
            result["display_name"] = user.get("displayName", "")
            result["username"] = user.get("name", "")
            result["token_valid"] = True
            result["logged_in"] = True
        except Exception as e:
            result["token_valid"] = False
            result["token_error"] = str(e)
    return jsonify(result)


@app.route("/api/set-token", methods=["POST"])
def api_set_token():
    _ensure_session()
    # Accept both JSON and form data
    if request.is_json:
        data = request.json
    else:
        data = request.form.to_dict()
    # Support both 'token' and 'viim_token' field names
    token = (data.get("token") or data.get("viim_token") or "").strip()
    if not token:
        return jsonify({"error": "token 不能为空"}), 400

    # Validate by calling get_myself
    try:
        from viim_client import VIIMClient
        client = VIIMClient(token=token)
        user = client.get_myself()
        user_info = {
            "name": user.get("displayName"),
            "email": user.get("emailAddress"),
            "username": user.get("name"),
        }
    except Exception as e:
        return jsonify({"error": "token 验证失败", "detail": str(e)}), 400

    _set_token_for_session(token, user_info)
    return jsonify({"ok": True, "user": user_info, "display_name": user_info.get("name", ""), "username": user_info.get("username", "")})


@app.route("/api/clear-token", methods=["POST"])
def api_clear_token():
    _ensure_session()
    _clear_token_for_session()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API — Reminders
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# API — Feedback
# ---------------------------------------------------------------------------

FEEDBACK_FILE = BASE_DIR / "database" / "feedback.json"  # 与 scripts/feedback.py 共用单一存储





@app.route("/api/draft", methods=["POST"])
def api_create_draft():
    """Create a draft FC from form data."""
    if request.is_json:
        data = request.json
    else:
        data = request.form.to_dict()
    description = data.get("description", "").strip()
    if not description:
        return jsonify({"error": "问题描述不能为空"}), 400
    fields = extract_fields(description)
    drafts = _load_json_db(DRAFTS_FILE, {"drafts": []})
    draft = {
        "id": uuid.uuid4().hex[:8],
        "summary": description[:100],
        "description": description,
        "area": data.get("area") or fields.get("viim_area", ""),
        "severity": data.get("severity") or fields.get("viim_severity", ""),
        "fields": fields,
        "status": "draft",
        "created_at": datetime.now().isoformat(),
        "session_id": session.get("fc_sid")
    }
    drafts["drafts"].append(draft)
    _save_json_db(DRAFTS_FILE, drafts)
    _bump_usage("drafts_created")
    return jsonify({"ok": True, "draft": draft})


@app.route("/api/draft/<did>/submit", methods=["POST"])
def api_draft_submit(did):
    """草稿提交到 VIIM：成功后写提交记录并移除该草稿。"""
    drafts = _load_json_db(DRAFTS_FILE, {"drafts": []})
    draft = next((d for d in drafts.get("drafts", []) if d.get("id") == did), None)
    if not draft:
        return jsonify({"error": "未找到该草稿"}), 404
    fields = dict(draft.get("fields") or {})
    if not fields.get("description"):
        fields["description"] = draft.get("description", "")
    if not fields.get("summary"):
        fields["summary"] = draft.get("summary", "")
    payload = _build_viim_payload(fields)
    try:
        result = request.viim_client.create_issue(
            summary=payload.get("summary", ""),
            description=payload.get("description", ""),
            additional_fields=payload.get("additional_fields", {}),
        )
    except Exception as e:
        return jsonify({"error": "VIIM 提交失败", "detail": str(e)}), 500

    subs = _load_json_db(SUBMISSIONS_FILE, {"submissions": []})
    subs["submissions"].append({
        "id": uuid.uuid4().hex[:12],
        "issue_key": result.get("key"),
        "issue_url": result.get("url"),
        "summary": payload.get("summary", ""),
        "submitted_at": datetime.now().isoformat(),
        "payload": payload,
    })
    _save_json_db(SUBMISSIONS_FILE, subs)

    drafts["drafts"] = [d for d in drafts.get("drafts", []) if d.get("id") != did]
    _save_json_db(DRAFTS_FILE, drafts)
    return jsonify({"ok": True, "key": result.get("key"), "url": result.get("url")})


# ---------------------------------------------------------------------------
# API — Analyze / Dryrun (existing)
# ---------------------------------------------------------------------------

@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    # Handle both JSON and form data (HTMX sends form data)
    if request.is_json:
        data = request.json
    else:
        data = request.form.to_dict()
    query = data.get("query", "")
    if query:
        _bump_usage("total")
    fields = extract_fields(query)

    # 双路检索：本地案例库必跑；有 token 时 VIIM 实时也跑；按分数合并去重，
    # 避免 VIIM 弱相关结果屏蔽本地精确命中（两路分数均已归一化到 0~1）
    local_hits = search_similar_issues(query=query, area=fields["viim_area"], top=5)
    viim_hits = []
    token = _get_token_for_session()
    if token:
        try:
            from viim_search import search_viim
            from viim_client import VIIMClient
            client = VIIMClient(token=token)
            viim_hits = search_viim(client, query, top=5)
        except Exception as e:
            log.warning("VIIM search failed, using local only: %s", e)
    hits = _merge_hits(viim_hits, local_hits)
    source = "mixed" if (viim_hits and local_hits) else ("viim" if viim_hits else "local")

    report = generate_report(hits, query=query, area=fields["viim_area"],
                             severity=fields["viim_severity"], phase=fields["viim_phase"])
    report_md = format_report_markdown(report)
    
    # Return HTML for HTMX requests
    if request.headers.get('HX-Request'):
        advice = build_advice_context(
            report, hits, query=query,
            severity=fields.get("viim_severity"), source=source)

        # 底部一句话概览：命中数 + 数据源 + 主区域
        area_txt = report.get("summary", {}).get("area") or ""
        src_txt = {"viim": "VIIM 实时检索", "local": "本地案例库",
                   "mixed": "VIIM + 本地案例库合并"}.get(source, "本地案例库")
        overview = f"共命中 {len(hits)} 条相似案例 · 数据源：{src_txt}"
        if area_txt:
            overview += f" · 主要区域：{area_txt}"

        return render_template("report.html",
                               hits=hits,
                               query=query,
                               summary=overview,
                               root_causes=advice["root_causes"],
                               directions=advice["directions"],
                               boundaries=advice["boundaries"],
                               suggestions=advice["suggestions"],
                               source=source)
    
    return jsonify({"fields": fields, "hits": hits, "report": report, "report_md": report_md, "source": source})


@app.route("/api/viim-detail/<key>")
def api_viim_detail(key):
    """获取 VIIM FC 文件全部信息。"""
    token = _get_token_for_session()
    if not token:
        return jsonify({"error": "未设置 VIIM Token"}), 401
    try:
        from viim_client import VIIMClient
        client = VIIMClient(token=token)
        # 获取完整 issue
        data = client._request("GET", f"/rest/api/2/issue/{key}")
        fld = data.get("fields", {})

        # 提取所有有用字段
        result = {
            "key": data.get("key", key),
            "summary": (fld.get("summary") or "").strip(),
            "description": (fld.get("description") or "").strip(),
            "status": (fld.get("status", {}) or {}).get("name") or "",
            "assignee": (fld.get("assignee", {}) or {}).get("displayName") or "",
            "reporter": (fld.get("reporter", {}) or {}).get("displayName") or "",
            "priority": (fld.get("priority", {}) or {}).get("name") or "",
            "created": (fld.get("created") or "")[:19].replace("T", " "),
            "updated": (fld.get("updated") or "")[:19].replace("T", " "),
            "resolution": (fld.get("resolution", {}) or {}).get("name") or "",
            "url": f"{client.url}/browse/{key}",
            "attachments": [],
            "comments": [],
            "custom_fields": {},
        }

        # 附件
        for att in (fld.get("attachment") or []):
            result["attachments"].append({
                "filename": att.get("filename", ""),
                "url": viim_att_proxy_url(att.get("content", "")),
                "mimeType": att.get("mimeType", ""),
                "size": att.get("size", 0),
            })

        # 评论（取最新 5 条）
        comments = (fld.get("comment", {}) or {}).get("comments") or []
        for c in comments[-5:]:
            result["comments"].append({
                "author": (c.get("author", {}) or {}).get("displayName") or "",
                "body": (c.get("body") or "")[:500],
                "created": (c.get("created") or "")[:19].replace("T", " "),
            })

        # 自定义字段（常见的 FC 相关字段）
        for cf_key, cf_val in fld.items():
            if cf_key.startswith("customfield_") and cf_val:
                # 尝试提取有意义的值
                if isinstance(cf_val, dict):
                    val = cf_val.get("value") or cf_val.get("name") or str(cf_val)
                elif isinstance(cf_val, list):
                    vals = []
                    for item in cf_val:
                        if isinstance(item, dict):
                            vals.append(item.get("value") or item.get("name") or str(item))
                        else:
                            vals.append(str(item))
                    val = ", ".join(vals)
                else:
                    val = str(cf_val)
                if val and val != "None":
                    result["custom_fields"][cf_key] = val

        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dryrun", methods=["POST"])
def api_dryrun():
    data = request.json
    query = data.get("query", "")
    fields = extract_fields(query)
    hits = search_similar_issues(query=query, area=fields["viim_area"], top=5)
    report = generate_report(hits, query=query, area=fields["viim_area"],
                             severity=fields["viim_severity"], phase=fields["viim_phase"])
    report_md = format_report_markdown(report)

    payload = _build_viim_payload(fields, report)
    return jsonify({"fields": fields, "report_md": report_md, "payload": payload})


# ---------------------------------------------------------------------------
# API — Review (new)
# ---------------------------------------------------------------------------

@app.route("/api/review", methods=["POST"])
def api_review():
    """Take query + optional overrides, return full field analysis + VIIM payload for review."""
    data = request.json
    query = data.get("query", "")
    area_override = data.get("area")
    severity_override = data.get("severity")

    fields = extract_fields(query)
    if area_override:
        fields["viim_area"] = area_override
    if severity_override:
        fields["viim_severity"] = severity_override

    hits = search_similar_issues(query=query, area=fields["viim_area"], top=5)
    report = generate_report(hits, query=query, area=fields["viim_area"],
                             severity=fields["viim_severity"], phase=fields["viim_phase"])
    report_md = format_report_markdown(report)

    payload = _build_viim_payload(fields, report)
    return jsonify({"fields": fields, "hits": hits, "report": report,
                    "report_md": report_md, "payload": payload})


@app.route("/api/report-check", methods=["GET"])
def api_report_check():
    """按报告模板检查问题完整性 + 流程状态。filter: all|mine|overdue"""
    from report_checker import run_check
    template_id = request.args.get("template")
    limit = int(request.args.get("limit", 100))
    filter_type = request.args.get("filter", "all")

    assignee = None
    overdue_only = False
    if filter_type == "mine":
        try:
            me = request.viim_client.get_myself()
            assignee = me.get("name") or (me.get("emailAddress") or "").split("@")[0]
        except Exception:
            assignee = None
    elif filter_type == "overdue":
        overdue_only = True

    result = run_check(template_id=template_id, limit=limit,
                       client=getattr(request, "viim_client", None),
                       assignee=assignee, overdue_only=overdue_only)
    return jsonify(result)


# ---------------------------------------------------------------------------
# API — Submit (new)
# ---------------------------------------------------------------------------

@app.route("/api/submit", methods=["POST"])
def api_submit():
    """Take confirmed payload and submit to VIIM. Save result to submissions.json."""
    data = request.json
    payload = data.get("payload")
    if not payload:
        return jsonify({"error": "缺少 payload"}), 400

    project_key = (payload.get("project") or "").strip()
    if not project_key:
        return jsonify({"error": "未选择项目（project），请回核对页选择后提交"}), 400

    try:
        result = request.viim_client.create_issue(
            summary=payload.get("summary", ""),
            description=payload.get("description", ""),
            additional_fields=payload.get("additional_fields", {}),
            project_key=project_key,
        )
    except Exception as e:
        return jsonify({"error": "VIIM 提交失败", "detail": str(e)}), 500

    # 附件随单上传（temp_uploads 中的临时文件）
    uploaded, attach_errors = [], []
    for fname in (data.get("attachments") or []):
        p = TEMP_UPLOADS_DIR / Path(str(fname)).name
        if not p.exists():
            attach_errors.append(f"{fname}: 临时文件不存在")
            continue
        try:
            request.viim_client.upload_attachment(result.get("key"), str(p))
            uploaded.append(fname)
        except Exception as e:
            attach_errors.append(f"{fname}: {e}")

    # Save to submissions
    subs = _load_json_db(SUBMISSIONS_FILE, {"submissions": []})
    record = {
        "id": uuid.uuid4().hex[:12],
        "issue_key": result.get("key"),
        "issue_url": result.get("url"),
        "summary": payload.get("summary", ""),
        "submitted_at": datetime.now().isoformat(),
        "payload": payload,
    }
    subs["submissions"].append(record)
    _save_json_db(SUBMISSIONS_FILE, subs)

    return jsonify({"ok": True, "issue_key": result.get("key"),
                    "issue_url": result.get("url"), "record_id": record["id"],
                    "attachments_uploaded": uploaded, "attachment_errors": attach_errors})


@app.route("/api/submissions", methods=["POST"])
def api_submissions():
    """Return submissions history."""
    subs = _load_json_db(SUBMISSIONS_FILE, {"submissions": []})
    return jsonify(subs)


@app.route("/api/submissions/list")
def api_submissions_list():
    """Return submissions list as HTML for HTMX."""
    subs = _load_json_db(SUBMISSIONS_FILE, {"submissions": []})
    items = subs.get("submissions", [])
    if not items:
        return '<div style="padding:48px;text-align:center"><p class="muted">暂无提交记录</p></div>'
    rows = []
    for s in reversed(items):
        badge_class = 'badge-green' if s.get('status') == '已提交' else 'badge-amber'
        rows.append(f'''
        <tr>
          <td><span class="case-key">{escape(s.get('fc_key', '-'))}</span></td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{escape(s.get('summary', '-'))}</td>
          <td><span class="badge {badge_class}">{escape(s.get('status', '-'))}</span></td>
          <td class="muted" style="font-size:12px">{escape(str(s.get('submitted_at', '-'))[:10])}</td>
          <td><a href="{escape(s.get('url', '#'))}" target="_blank" class="btn-ghost btn-sm">查看</a></td>
        </tr>
        ''')
    return f'''
    <table class="history-table">
      <thead><tr><th>FC Key</th><th>问题</th><th>状态</th><th>时间</th><th></th></tr></thead>
      <tbody>{''.join(rows)}</tbody>
    </table>
    '''


@app.route("/api/history/list")
def api_history_list():
    """Return history list as HTML for HTMX."""
    # Load drafts and submissions
    drafts = _load_json_db(DRAFTS_FILE, {"drafts": []})
    subs = _load_json_db(SUBMISSIONS_FILE, {"submissions": []})
    items = []
    for d in drafts.get("drafts", []):
        items.append({
            "key": d.get("fc_key", "DRAFT-" + d.get("id", "?")[:8]),
            "summary": d.get("summary", ""),
            "status": "草稿",
            "created": d.get("created_at", ""),
            "source": "draft"
        })
    for s in subs.get("submissions", []):
        items.append({
            "key": s.get("fc_key", "-"),
            "summary": s.get("summary", ""),
            "status": s.get("status", "已提交"),
            "created": s.get("submitted_at", ""),
            "url": s.get("url", ""),
            "source": "submission"
        })
    if not items:
        return '<div style="padding:48px;text-align:center"><p class="muted">暂无记录</p><p class="muted" style="font-size:13px;margin-top:4px">去「问一下」提个问题试试</p></div>'
    # Sort by created desc
    items.sort(key=lambda x: x.get("created", ""), reverse=True)

    page = max(1, request.args.get("page", 1, type=int))
    page_size = 20
    total = len(items)
    page_items = items[(page - 1) * page_size: page * page_size]
    remaining = total - page * page_size

    rows = []
    for item in page_items:
        if item["status"] == "草稿":
            badge_class = "badge-amber"
            link = f'/draft/{escape(item["key"])}'
        elif item["status"] == "已提交":
            badge_class = "badge-green"
            link = escape(item.get("url", "#"))
        else:
            badge_class = "badge"
            link = escape(item.get("url", "#"))
        if item["source"] == "draft":
            del_btn = ('<button type="button" class="btn-danger-ghost btn-sm" '
                       'data-draft-key="' + escape(item["key"]) + '" '
                       'onclick="delDraft(this.dataset.draftKey, this)">删除</button>')
        else:
            del_btn = ""
        rows.append(f'''
        <tr data-key="{escape(item['key'])}" data-status="{escape(item['status'])}">
          <td><span class="case-key">{escape(item['key'])}</span></td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{escape(item['summary'])}</td>
          <td><span class="badge {badge_class}">{escape(item['status'])}</span></td>
          <td class="muted" style="font-size:12px">{escape(str(item.get('created', '-'))[:10])}</td>
          <td><div class="table-actions"><a href="{link}" target="_blank" class="btn-ghost btn-sm">查看</a>{del_btn}</div></td>
        </tr>
        ''')
    if remaining > 0:
        rows.append(f'''
        <tr class="loadmore-row"><td colspan="5" style="text-align:center;padding:14px">
          <button type="button" class="btn-secondary btn-sm" data-page="{page + 1}" onclick="loadMoreHistory(this)">加载更多（剩余 {remaining} 条）</button>
        </td></tr>
        ''')

    body = ''.join(rows)
    if page > 1:
        return body
    return f'''
    <table>
      <thead><tr><th>FC Key</th><th>问题</th><th>状态</th><th>时间</th><th style="text-align:right">操作</th></tr></thead>
      <tbody>{body}</tbody>
    </table>
    '''


@app.route("/api/history/delete", methods=["POST"])
def api_history_delete():
    """删除草稿（仅草稿可删，提交记录不可删）。"""
    data = request.json or {}
    key = (data.get("key") or "").strip()
    if not key.startswith("DRAFT-"):
        return jsonify({"error": "仅草稿可删除"}), 400
    did = key[len("DRAFT-"):]
    drafts = _load_json_db(DRAFTS_FILE, {"drafts": []})
    before = len(drafts.get("drafts", []))
    drafts["drafts"] = [
        d for d in drafts.get("drafts", [])
        if d.get("id", "")[:8] != did and (d.get("fc_key") or "") != key
    ]
    if len(drafts.get("drafts", [])) == before:
        return jsonify({"error": "未找到该草稿"}), 404
    _save_json_db(DRAFTS_FILE, drafts)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API — Image upload (new)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# API — Draft support (new)
# ---------------------------------------------------------------------------

@app.route("/api/save-draft", methods=["POST"])
def api_save_draft():
    """存入草稿库：写入 drafts 列表（工作台可见）；form_state 记录会话草稿号，重复保存更新同一条不重复创建。"""
    _ensure_session()
    data = request.json
    sid = session.get("fc_sid")
    db = _load_json_db(DRAFTS_FILE, {"drafts": []})
    drafts = db.setdefault("drafts", [])
    state = db.setdefault("form_state", {}).setdefault(sid, {})
    now = datetime.now().isoformat()
    desc = (data.get("description") or "").strip()
    draft_id = state.get("draft_id")
    existing = next((d for d in drafts if d.get("id") == draft_id), None) if draft_id else None
    if existing:
        existing.update({
            "summary": (data.get("summary") or desc)[:100],
            "description": desc,
            "area": data.get("viim_area", ""),
            "severity": data.get("viim_severity", ""),
            "fields": data,
            "updated_at": now,
        })
        draft = existing
    else:
        draft = {
            "id": uuid.uuid4().hex[:8],
            "summary": (data.get("summary") or desc)[:100],
            "description": desc,
            "area": data.get("viim_area", ""),
            "severity": data.get("viim_severity", ""),
            "fields": data,
            "status": "draft",
            "created_at": now,
            "session_id": sid,
        }
        drafts.append(draft)
        state["draft_id"] = draft["id"]
    state["saved_at"] = now
    _save_json_db(DRAFTS_FILE, db)
    return jsonify({"ok": True, "draft_id": draft["id"]})


@app.route("/api/load-draft", methods=["POST"])
def api_load_draft():
    """Retrieve saved draft for current session."""
    _ensure_session()
    sid = session.get("fc_sid")
    db = _load_json_db(DRAFTS_FILE, {"drafts": []})
    draft = db.get("form_state", {}).get(sid)
    if draft:
        return jsonify({"ok": True, "draft": draft["data"], "saved_at": draft["saved_at"]})
    return jsonify({"ok": True, "draft": None})


# ---------------------------------------------------------------------------
# API — Tracking & alerts (existing)
# ---------------------------------------------------------------------------

@app.route("/api/track", methods=["POST"])
def api_track():
    data = request.json
    query = data.get("query", "")
    fields = extract_fields(query)
    issue_id = track_issue(query, fields)
    alerts = check_alerts()
    return jsonify({"issue_id": issue_id, "area": fields["viim_area"],
                    "severity": fields["viim_severity"], "alerts": alerts})


@app.route("/api/tracking", methods=["POST"])
def api_tracking():
    tracking = _load_json(TRACKING_FILE, {"issues": []})
    return jsonify(tracking)


@app.route("/api/alerts", methods=["POST"])
def api_alerts():
    alerts = check_alerts()
    return jsonify({"alerts": alerts})


@app.route("/api/alerts/reminders", methods=["POST"])
def api_alerts_reminders():
    reminders = get_followup_reminders()
    return jsonify({"reminders": reminders})


@app.route("/api/dashboard", methods=["POST"])
def api_dashboard():
    dashboard = get_management_dashboard()
    return jsonify(dashboard)


@app.route("/api/feedback", methods=["POST"])
def api_feedback():
    data = request.json if request.is_json else request.form.to_dict()
    query = data.get("query", "")
    rating = data.get("rating", "")
    corrections = data.get("corrections", {})
    fields = extract_fields(query)
    fb_id = collect_feedback(fc_text=query, extracted=fields, corrections=corrections)

    from feedback import _load_json as fb_load, FEEDBACK_FILE
    fb = fb_load(FEEDBACK_FILE, {"feedbacks": []})
    last = fb["feedbacks"][-1] if fb["feedbacks"] else {}
    diffs = list(last.get("diffs", {}).keys())

    return jsonify({"ok": True, "feedback_id": fb_id, "extracted": {
        "area": fields["viim_area"], "severity": fields["viim_severity"]
    }, "diffs": diffs})


@app.route("/api/feedback/cases")
def api_feedback_cases():
    """列出反馈学习新增的案例（source=feedback），按加入时间倒序。"""
    from feedback import ISSUES_FILE, _load_json
    data = _load_json(ISSUES_FILE, [])
    issues = data.get("issues", data) if isinstance(data, dict) else data
    learned = [c for c in issues if isinstance(c, dict) and c.get("source") == "feedback"]
    learned.sort(key=lambda c: c.get("added", ""), reverse=True)
    return jsonify({"cases": learned})


@app.route("/api/feedback/cases/delete", methods=["POST"])
def api_feedback_cases_delete():
    """删除反馈学习新增的案例（按 id）；知识库原有案例不可删。"""
    from feedback import ISSUES_FILE, _load_json, _save_json
    cid = ((request.json or {}).get("id") or "").strip()
    if not cid:
        return jsonify({"error": "缺少 id"}), 400
    data = _load_json(ISSUES_FILE, [])
    is_dict = isinstance(data, dict) and "issues" in data
    issues = data.get("issues") if is_dict else data
    before = len(issues)
    issues = [c for c in issues
              if not (isinstance(c, dict) and c.get("source") == "feedback"
                      and str(c.get("id", "")) == cid)]
    if len(issues) == before:
        return jsonify({"error": "未找到该案例，或仅可删除反馈学习新增的案例"}), 404
    if is_dict:
        data["issues"] = issues
    else:
        data = issues
    _save_json(ISSUES_FILE, data)
    return jsonify({"ok": True})


@app.route("/api/feedback/keywords")
def api_feedback_keywords():
    """列出反馈学习写入关键词库的词（带来源登记）。"""
    from feedback import list_learned_keywords
    return jsonify({"keywords": list_learned_keywords()})


@app.route("/api/feedback/keywords/delete", methods=["POST"])
def api_feedback_keywords_delete():
    """删除一个反馈学习写入的关键词（同时从关键词库移除）。"""
    from feedback import delete_learned_keyword
    d = request.json or {}
    ok = delete_learned_keyword((d.get("kind") or "").strip(),
                                (d.get("group") or "").strip(),
                                (d.get("word") or "").strip())
    if not ok:
        return jsonify({"error": "未找到该学习关键词"}), 404
    return jsonify({"ok": True})


@app.route("/api/learn", methods=["POST"])
def api_learn():
    data = request.json
    result = apply_learning(
        min_feedbacks=data.get("min_feedbacks", 3),
        dry_run=data.get("dry_run", False)
    )
    return jsonify(result)


@app.route("/api/stats", methods=["POST"])
def api_stats():
    report = get_accuracy_report()
    return jsonify(report)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()
    log.info("FC feasibility web UI: http://localhost:%s", args.port)
    app.run(host=args.host, port=args.port, debug=False)
