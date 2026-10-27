"""依賴注入：資料庫 Session、客戶端資訊、目前使用者、管理員權限、頻率限制。"""
from __future__ import annotations

from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.cookies import ACCESS_COOKIE
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.core.request_info import ClientInfo, client_info
from app.db import session_scope
from app.model import ROLE_ADMIN, User
from app.service.auth_service import AuthService

_settings = get_settings()
login_ip_limiter = RateLimiter(_settings.login_rate_limit_per_minute * 4, name="login-ip")  # 同一 IP 嘗試多個帳號
login_account_limiter = RateLimiter(_settings.login_rate_limit_per_minute, name="login-acct")  # 同一 IP＋帳號：每分鐘 5 次
register_limiter = RateLimiter(_settings.register_rate_limit_per_minute, name="register")


def get_db() -> Iterator[Session]:
    yield from session_scope()


def get_client(request: Request) -> ClientInfo:
    return client_info(request)


def rate_limit(limiter: RateLimiter, key: str) -> None:
    ok, wait = limiter.hit(key)
    if not ok:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"嘗試次數過多，請於 {wait} 秒後再試", headers={"Retry-After": str(wait)})


def get_optional_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    return AuthService(db).authenticate_access(request.cookies.get(ACCESS_COOKIE))


def get_current_user(user: User | None = Depends(get_optional_user)) -> User:
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "請先登入")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != ROLE_ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "需要管理員權限")
    return user


def reset_rate_limits() -> None:
    """測試用"""
    for l in (login_ip_limiter, login_account_limiter, register_limiter):
        l.reset()
    from app.api.einvoice import carrier_limiter

    carrier_limiter.reset()
