"""FastAPI 應用程式進入點。"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api import admin, ai, auth, einvoice, health, inbox, push, sync
from app.api.cookies import CSRF_COOKIE, CSRF_HEADER, set_csrf_cookie
from app.core.config import get_settings
from app.core.logging import mask_email, setup_logging
from app.core.security import hash_password, new_csrf_token, utcnow
from app.db import session_scope
from app.model import ROLE_ADMIN, User
from app.repository.user_repository import UserRepository
from app.schema.auth import validate_password_strength
from app.service.app_settings import registration_open
from app.service.errors import ServiceError

log = logging.getLogger("aster")


FIELD_LABELS = {"username": "使用者名稱", "email": "Email", "password": "密碼", "new_password": "新密碼", "current_password": "目前密碼",
                "identifier": "帳號", "is_active": "狀態", "reason": "原因", "page": "頁碼", "size": "每頁筆數", "q": "搜尋字串"}


def translate_validation_error(e: dict) -> str:
    """把 Pydantic 驗證錯誤轉為繁體中文；自訂 ValueError 已是中文，直接使用。"""
    loc = [str(x) for x in e.get("loc", [])]
    label = FIELD_LABELS.get(loc[-1], "欄位") if loc else "欄位"
    t = e.get("type", "")
    ctx = e.get("ctx") or {}
    if t == "value_error":
        return str(e.get("msg", "")).removeprefix("Value error, ")
    if t == "missing":
        return f"請填寫{label}"
    if t == "string_too_short":
        return f"{label}至少需要 {ctx.get('min_length', '')} 個字元"
    if t == "string_too_long":
        return f"{label}最多 {ctx.get('max_length', '')} 個字元"
    if t in ("int_parsing", "int_type", "bool_parsing", "bool_type", "date_parsing", "date_from_datetime_parsing", "string_type"):
        return f"{label}格式不正確"
    if t in ("greater_than_equal", "less_than_equal", "greater_than", "less_than"):
        return f"{label}超出允許範圍"
    if t == "extra_forbidden":
        return "包含不允許的欄位"
    if t == "literal_error":
        return f"{label}的值不在允許的選項中"
    return "輸入資料格式錯誤"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def bootstrap_admin() -> None:
    """依環境變數建立第一位管理員（已存在則略過，不會覆寫密碼）。"""
    s = get_settings()
    if not (s.admin_username and s.admin_email and s.admin_password):
        return
    validate_password_strength(s.admin_password)
    for db in session_scope():
        repo = UserRepository(db)
        if repo.get_by_username(s.admin_username) or repo.get_by_email(s.admin_email):
            return
        repo.add(User(username=s.admin_username, email=s.admin_email.lower(), password_hash=hash_password(s.admin_password),
                      role=ROLE_ADMIN, password_changed_at=utcnow()))
        db.commit()
        log.info("已建立預設管理員 %s（%s）", s.admin_username, mask_email(s.admin_email))


def run_migrations() -> None:
    """套用資料庫遷移到最新版本。熱重載時新版程式碼若附帶遷移，也會在重新載入時自動執行。"""
    s = get_settings()
    if not s.auto_migrate or s.env == "test":
        return
    from alembic import command
    from alembic.config import Config

    root = Path(__file__).resolve().parent.parent
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    cfg.attributes["configure_logger"] = False
    logging.getLogger("alembic").setLevel(logging.WARNING)
    command.upgrade(cfg, "head")
    log.info("資料庫結構已是最新版本")


def warn_insecure_defaults() -> None:
    """啟動時檢查危險的預設值，並寫進日誌（docker compose logs api 可看到）。"""
    s = get_settings()
    if s.env != "production":
        return
    from sqlalchemy import func, select

    for db in session_scope():
        users = int(db.scalar(select(func.count(User.id))) or 0)
        if registration_open(db, s) and users > 0:
            log.warning("⚠ 已有 %s 位使用者但仍開放註冊；只給自己和家人使用時，請在管理後台關閉「開放註冊」", users)
        if s.first_user_admin and users == 0:
            log.warning("⚠ 系統還沒有使用者：第一位註冊的人會成為管理員，請立刻自己先註冊，或設定 CLURE_ADMIN_* 並把 CLURE_FIRST_USER_ADMIN 設為 false")
    if "change-me" in s.database_url:
        log.warning("⚠ 資料庫密碼仍是預設的 change-me，請更改 POSTGRES_PASSWORD")


@asynccontextmanager
async def lifespan(_: FastAPI):
    setup_logging(get_settings().log_level)
    run_migrations()
    bootstrap_admin()
    try:
        warn_insecure_defaults()
    except Exception:  # noqa: BLE001 — 只是提醒，不影響啟動
        log.debug("略過安全檢查", exc_info=True)
    task = None
    if get_settings().env != "test":
        from app.service.push_service import push_loop

        task = asyncio.create_task(push_loop())
    yield
    if task:
        task.cancel()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="Aster API", version="2.2.4", lifespan=lifespan,
        docs_url="/api/docs" if s.env != "production" else None, redoc_url=None, openapi_url="/api/openapi.json" if s.env != "production" else None,
    )

    @app.middleware("http")
    async def csrf_middleware(request: Request, call_next):  # noqa: ANN001, ANN202
        """Double-submit CSRF：非 GET 的 /api 請求必須帶與 Cookie 相同的 X-CSRF-Token。"""
        cookie = request.cookies.get(CSRF_COOKIE)
        # /api/hook/：iPhone 捷徑以權杖驗證、不使用 Cookie，沒有 CSRF 風險
        if request.url.path.startswith("/api/hook/"):
            return await call_next(request)
        if request.url.path.startswith("/api/") and request.method not in SAFE_METHODS:
            header = request.headers.get(CSRF_HEADER)
            if not cookie or not header or cookie != header:
                return JSONResponse({"detail": "安全驗證失敗，請重新整理頁面後再試"}, status_code=403)
        response = await call_next(request)
        if not cookie:
            set_csrf_cookie(response, request, new_csrf_token())
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    @app.exception_handler(ServiceError)
    async def _service_error(_: Request, exc: ServiceError) -> JSONResponse:
        return JSONResponse({"detail": exc.message}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # 只回傳欄位與繁體中文訊息，不回傳使用者輸入的原值（避免密碼出現在回應或日誌中）
        errors = [{"field": ".".join(str(x) for x in e.get("loc", [])[1:]), "message": translate_validation_error(e)} for e in exc.errors()]
        return JSONResponse({"detail": errors[0]["message"] if errors else "輸入資料格式錯誤", "errors": errors}, status_code=422)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("未處理的錯誤 path=%s", request.url.path, exc_info=exc)
        return JSONResponse({"detail": "伺服器發生錯誤，請稍後再試"}, status_code=500)

    for r in (health.router, auth.router, admin.router, sync.router, push.router, einvoice.router, ai.router, inbox.router, inbox.hook_router):
        app.include_router(r)
    return app


app = create_app()
