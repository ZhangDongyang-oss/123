"""FC 可行性分析 — 提醒 Blueprint
提醒的增删改查（HTMX 片段渲染）。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from flask import Blueprint, jsonify, render_template, request, session

from infra import REMINDERS_FILE, _ensure_session, _load_json_db, _save_json_db

bp = Blueprint("reminders", __name__)


@bp.route("/api/reminders", methods=["POST"])
def api_add_reminder():
    _ensure_session()
    if request.is_json:
        data = request.json
    else:
        data = request.form.to_dict()
    fc_key = data.get("fc_key", "").strip()
    note = data.get("note", "").strip()
    remind_at = data.get("remind_at", "").strip()
    if not fc_key:
        return jsonify({"error": "FC 编号不能为空"}), 400
    reminders = _load_json_db(REMINDERS_FILE, {"reminders": []})
    reminder = {
        "id": uuid.uuid4().hex[:8],
        "fc_key": fc_key,
        "note": note,
        "remind_at": remind_at,
        "status": "pending",
        "created_at": datetime.now().isoformat(),
        "session_id": session.get("fc_sid")
    }
    reminders["reminders"].append(reminder)
    _save_json_db(REMINDERS_FILE, reminders)
    return render_template("reminder_item.html", r=reminder)


@bp.route("/api/reminders/list")
def api_list_reminders():
    reminders = _load_json_db(REMINDERS_FILE, {"reminders": []})
    items = [r for r in reminders.get("reminders", []) if r.get("session_id") == session.get("fc_sid")]
    if not items:
        return '<div style="padding:32px;text-align:center"><p class="muted">暂无提醒</p></div>'
    html = ''
    for r in sorted(items, key=lambda x: x.get("remind_at", ""), reverse=True):
        html += render_template("reminder_item.html", r=r)
    return html


@bp.route("/api/reminders/<rid>/done", methods=["POST"])
def api_reminder_done(rid):
    reminders = _load_json_db(REMINDERS_FILE, {"reminders": []})
    for r in reminders.get("reminders", []):
        if r.get("id") == rid:
            r["status"] = "done"
            break
    _save_json_db(REMINDERS_FILE, reminders)
    return jsonify({"ok": True})


@bp.route("/api/reminders/<rid>/delete", methods=["POST"])
def api_reminder_delete(rid):
    reminders = _load_json_db(REMINDERS_FILE, {"reminders": []})
    reminders["reminders"] = [r for r in reminders.get("reminders", []) if r.get("id") != rid]
    _save_json_db(REMINDERS_FILE, reminders)
    return jsonify({"ok": True})
