"""FC 可行性分析 — 基础设施层
路径常量 / JSON 存储（带文件锁） / 会话与 VIIM Token 管理（加密存储） / .env 加载。
main.py 与各 blueprint 共用，避免循环依赖。
"""
from __future__ import annotations

import json
import logging
import os
import platform
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from flask import session

log = logging.getLogger("fc-infra")

BASE_DIR = Path(__file__).parent.parent


def _load_env_file():
    """自动加载项目根目录或 webapp 目录下的 .env（KEY=VALUE），不覆盖已有环境变量。"""
    for cand in (BASE_DIR / ".env", Path(__file__).parent / ".env"):
        if not cand.exists():
            continue
        try:
            for line in cand.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k, v = k.strip(), v.strip().strip('"\'')
                if k and k not in os.environ:
                    os.environ[k] = v
        except Exception:
            pass
        break


_load_env_file()

# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------
DATABASE_DIR = Path(__file__).parent / "database"
TOKENS_FILE = DATABASE_DIR / "session_tokens.json"
SUBMISSIONS_FILE = DATABASE_DIR / "submissions.json"
DRAFTS_FILE = DATABASE_DIR / "drafts.json"
REMINDERS_FILE = DATABASE_DIR / "reminders.json"
TEMP_UPLOADS_DIR = DATABASE_DIR / "temp_uploads"
FEEDBACK_FILE = BASE_DIR / "database" / "feedback.json"  # 与 scripts/feedback.py 共用单一存储

DATABASE_DIR.mkdir(parents=True, exist_ok=True)
TEMP_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Token 加密（P0-2）— 可选依赖 cryptography，未安装时 fallback 明文
# ---------------------------------------------------------------------------
_fernet = None

def _init_fernet():
    """尝试初始化 Fernet 加密器，失败则 _fernet 保持 None（明文 fallback）。"""
    global _fernet
    if _fernet is not None:
        return
    key = os.environ.get("TOKEN_ENCRYPTION_KEY", "").strip()
    if not key:
        log.warning("TOKEN_ENCRYPTION_KEY 未设置，Token 将以明文存储。"
                     " 生产环境请运行 python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" 生成密钥。")
        return
    try:
        from cryptography.fernet import Fernet
        _fernet = Fernet(key.encode())
        log.info("Token 加密已启用（Fernet）")
    except ImportError:
        log.warning("未安装 cryptography 库，Token 将以明文存储。可运行 pip install cryptography 启用加密。")
    except Exception as e:
        log.warning("TOKEN_ENCRYPTION_KEY 格式错误（%s），Token 将以明文存储。", e)


def _encrypt_token(token: str) -> str:
    """加密 Token 值。未配置加密时原样返回。"""
    _init_fernet()
    if _fernet is None:
        return token
    return _fernet.encrypt(token.encode()).decode()


def _decrypt_token(token: str) -> str:
    """解密 Token 值。未配置加密时原样返回。"""
    _init_fernet()
    if _fernet is None:
        return token
    try:
        return _fernet.decrypt(token.encode()).decode()
    except Exception:
        return token  # 兼容未加密的旧数据


# ---------------------------------------------------------------------------
# JSON helpers（P0-7）— 带文件锁 + atomic write
# ---------------------------------------------------------------------------

# Windows 无 fcntl，用 msvcrt 实现文件锁；都不可用时 fallback 无锁。
# 锁信号量使用独立的 .lock 文件：Windows 下数据文件本身不能被保持打开，
# 否则随后的 os.replace 原子替换会报 [WinError 5] 拒绝访问。
try:
    import fcntl

    def _lock_file(f, exclusive=False):
        """POSIX 文件锁。exclusive=True 为排他锁（写），False 为共享锁（读）。"""
        fcntl.flock(f.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)

    def _unlock_file(f):
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)

except ImportError:
    try:
        import msvcrt

        def _lock_file(f, exclusive=False):
            """Windows 文件锁。锁定 .lock 文件第 1 字节作为信号量（阻塞等待）。"""
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)

        def _unlock_file(f):
            try:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            except Exception:
                pass

    except ImportError:
        def _lock_file(f, exclusive=False):
            pass

        def _unlock_file(f):
            pass


@contextmanager
def _db_lock(path: Path, exclusive: bool):
    """跨平台读写锁：信号量是独立的 <文件名>.lock，数据文件本身不被保持打开，
    保证 Windows 下 os.replace 原子替换可用。"""
    lf = open(str(path) + ".lock", "a+")
    try:
        _lock_file(lf, exclusive=exclusive)
        try:
            yield
        finally:
            _unlock_file(lf)
    finally:
        lf.close()


def _load_json_db(path: Path | str, default=None):
    """读取 JSON 文件（带共享锁防并发读写冲突）。"""
    if default is None:
        default = {}
    path = Path(path) if not isinstance(path, Path) else path
    if not path.exists():
        return default
    try:
        with _db_lock(path, exclusive=False):
            with open(path, "r", encoding="utf-8") as f:
                return json.loads(f.read())
    except (json.JSONDecodeError, OSError):
        return default


def _save_json_db(path: Path | str, data):
    """写入 JSON 文件（带排他锁 + atomic write，防并发写入丢失数据）。"""
    path = Path(path) if not isinstance(path, Path) else path
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with _db_lock(path, exclusive=True):
            # 写入临时文件后原子替换，避免写到一半断电导致文件损坏
            fd, tmp_path = tempfile.mkstemp(
                dir=str(path.parent), suffix=".tmp", prefix=".json_"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as tmp:
                    tmp.write(json.dumps(data, ensure_ascii=False, indent=2))
                os.replace(tmp_path, str(path))
            except BaseException:
                # 写入失败时清理临时文件
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
    except OSError as e:
        log.error("写入 JSON 文件失败 %s: %s", path, e)
        raise


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------
def _ensure_session():
    """Ensure a session cookie `fc_sid` exists."""
    if "fc_sid" not in session:
        session["fc_sid"] = uuid.uuid4().hex


def _get_token_for_session() -> str | None:
    """Return VIIM token for current session, or None."""
    sid = session.get("fc_sid")
    if not sid:
        return None
    tokens = _load_json_db(TOKENS_FILE, {})
    raw = tokens.get(sid, {}).get("token")
    if raw is None:
        return None
    return _decrypt_token(raw)


def _set_token_for_session(token: str, user_info: dict | None = None):
    sid = session.get("fc_sid")
    if not sid:
        return
    tokens = _load_json_db(TOKENS_FILE, {})
    entry = {"token": _encrypt_token(token), "updated_at": datetime.now().isoformat()}
    if user_info:
        entry["user"] = user_info
    tokens[sid] = entry
    _save_json_db(TOKENS_FILE, tokens)


def _clear_token_for_session():
    sid = session.get("fc_sid")
    if not sid:
        return
    tokens = _load_json_db(TOKENS_FILE, {})
    tokens.pop(sid, None)
    _save_json_db(TOKENS_FILE, tokens)


# ---------------------------------------------------------------------------
# Usage stats — 按会话计数（分析次数 / 工单创建数）
# ---------------------------------------------------------------------------
USAGE_FILE = DATABASE_DIR / "usage.json"


def _bump_usage(counter: str, sid: str | None = None):
    """当前会话的使用统计 +1。counter: total（分析）/ drafts_created（工单创建）。"""
    sid = sid or session.get("fc_sid")
    if not sid:
        return
    try:
        db = _load_json_db(USAGE_FILE, {})
        e = db.setdefault(sid, {"total": 0, "drafts_created": 0})
        e[counter] = e.get(counter, 0) + 1
        e["updated_at"] = datetime.now().isoformat()
        _save_json_db(USAGE_FILE, db)
    except Exception as ex:
        log.warning("使用统计记录失败: %s", ex)
