"""FC 可行性分析 — 代理/上传 Blueprint
图片上传暂存、本地暂存图服务、飞书云盘图代理、VIIM 附件鉴权代理。
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from pathlib import Path

from flask import (Blueprint, jsonify, make_response, request,
                   send_from_directory)

from infra import TEMP_UPLOADS_DIR

bp = Blueprint("proxy", __name__)
log = logging.getLogger("fc-proxy")


# ---------------------------------------------------------------------------
# 飞书 tenant_access_token 缓存（P1-8）— 有效期 2h，提前 30min 刷新
# ---------------------------------------------------------------------------
_feishu_token_cache = {"token": None, "expires_at": 0.0}


def _get_feishu_token(app_id: str, app_secret: str) -> str:
    """获取飞书 tenant_access_token，带模块级缓存。"""
    now = time.time()
    if _feishu_token_cache["token"] and now < _feishu_token_cache["expires_at"]:
        return _feishu_token_cache["token"]

    import urllib.request
    token_url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
    token_data = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode()
    req = urllib.request.Request(token_url, data=token_data,
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        token_resp = json.loads(resp.read())
    new_token = token_resp["tenant_access_token"]

    # 飞书 token 有效期 2 小时，提前 30 分钟刷新
    _feishu_token_cache["token"] = new_token
    _feishu_token_cache["expires_at"] = now + 5400
    log.info("飞书 tenant_access_token 已刷新，有效期至 %s",
             time.strftime("%H:%M:%S", time.localtime(_feishu_token_cache["expires_at"])))
    return new_token


def viim_att_proxy_url(url: str) -> str:
    """VIIM 附件需带鉴权，浏览器无法直连，统一改写为本站代理地址。"""
    if not url:
        return url
    from urllib.parse import quote
    return "/api/viim-attachment?url=" + quote(url, safe="")


@bp.route("/api/upload-image", methods=["POST"])
def api_upload_image():
    """Accept multipart file upload, save to temp_uploads/, return path."""
    if "file" not in request.files:
        return jsonify({"error": "未找到文件"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "文件名为空"}), 400

    ALLOWED_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
    ext = Path(file.filename).suffix.lower() or ".png"
    if ext not in ALLOWED_EXT:
        return jsonify({"error": f"不支持的文件格式 {ext}，仅允许图片（png/jpg/gif/webp/bmp）"}), 400
    fname = f"{uuid.uuid4().hex}{ext}"
    save_path = TEMP_UPLOADS_DIR / fname
    file.save(str(save_path))

    return jsonify({"ok": True, "filename": fname,
                    "path": f"/api/uploads/{fname}",
                    "original_name": file.filename})


@bp.route("/api/uploads/<filename>")
def serve_upload(filename):
    """Serve uploaded images."""
    return send_from_directory(str(TEMP_UPLOADS_DIR), filename)


@bp.route("/api/viim-attachment")
def viim_attachment_proxy():
    """带会话 VIIM Token 代理下载附件图片（仅限 VIIM 同源 URL，防 SSRF）。"""
    import urllib.request
    from urllib.parse import urlparse
    url = request.args.get("url", "")
    client = getattr(request, "viim_client", None)
    if client is None:
        return jsonify({"error": "unauthorized"}), 401
    pu = urlparse(url)
    if pu.scheme not in ("http", "https") or pu.netloc != urlparse(client.url).netloc:
        return jsonify({"error": "url not allowed"}), 403
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {client.token}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            ct = resp.headers.get("Content-Type", "application/octet-stream")
    except Exception as e:
        return jsonify({"error": str(e)}), 502
    out = make_response(data)
    out.headers["Content-Type"] = ct
    out.headers["Cache-Control"] = "public, max-age=86400"
    return out


@bp.route("/api/feishu-image/<file_token>")
def serve_feishu_image(file_token):
    """Proxy feishu drive image with tenant access token."""
    import urllib.request
    import urllib.error

    # SSRF 防护：校验 file_token 格式，仅允许字母数字下划线连字符
    if not re.match(r'^[a-zA-Z0-9_-]{10,80}$', file_token):
        return jsonify({"error": "invalid file_token format"}), 400

    app_id = os.environ.get("FEISHU_APP_ID", "")
    app_secret = os.environ.get("FEISHU_APP_SECRET", "")

    if not app_id or not app_secret:
        log.warning("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置")
        return jsonify({"error": "feishu image proxy not configured"}), 500

    try:
        access_token = _get_feishu_token(app_id, app_secret)
    except Exception as e:
        return jsonify({"error": f"Failed to get feishu token: {e}"}), 500

    try:
        img_url = f"https://open.feishu.cn/open-apis/drive/v1/medias/{file_token}/download"
        req = urllib.request.Request(img_url, headers={"Authorization": f"Bearer {access_token}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            # 限制响应大小为 20MB，防止内存耗尽
            img_data = resp.read(20 * 1024 * 1024)
            content_type = resp.headers.get("Content-Type", "image/png")

        response = make_response(img_data)
        response.headers["Content-Type"] = content_type
        response.headers["Cache-Control"] = "public, max-age=86400"
        return response
    except urllib.error.HTTPError as e:
        return jsonify({"error": f"Feishu API error: {e.code}"}), e.code
    except Exception as e:
        return jsonify({"error": str(e)}), 500
