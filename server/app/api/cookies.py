"""Cookie 設定：Access／Refresh Token 皆為 HttpOnly；CSRF Token 供前端讀取後放入標頭（double-submit）。"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Request, Response

from app.core.config import get_settings

ACCESS_COOKIE = "clure_access"
REFRESH_COOKIE = "clure_refresh"
CSRF_COOKIE = "csrf_token"
CSRF_HEADER = "x-csrf-token"
ACCESS_PATH = "/api"
REFRESH_PATH = "/api/auth"


def is_secure(request: Request) -> bool:
    s = get_settings()
    if s.cookie_secure != "auto":
        return s.cookie_secure == "true"
    proto = request.headers.get("x-forwarded-proto", "") if s.trust_proxy_headers else ""
    return request.url.scheme == "https" or proto.split(",")[0].strip() == "https"


def _max_age(exp: datetime) -> int:
    return max(0, int((exp.replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)).total_seconds()))


def set_auth_cookies(response: Response, request: Request, *, access: str, access_exp: datetime, refresh: str, refresh_exp: datetime) -> None:
    s = get_settings()
    secure = is_secure(request)
    response.set_cookie(ACCESS_COOKIE, access, max_age=_max_age(access_exp), path=ACCESS_PATH, httponly=True, secure=secure, samesite=s.cookie_samesite)
    response.set_cookie(REFRESH_COOKIE, refresh, max_age=_max_age(refresh_exp), path=REFRESH_PATH, httponly=True, secure=secure, samesite=s.cookie_samesite)


def clear_auth_cookies(response: Response, request: Request) -> None:
    s = get_settings()
    secure = is_secure(request)
    response.delete_cookie(ACCESS_COOKIE, path=ACCESS_PATH, httponly=True, secure=secure, samesite=s.cookie_samesite)
    response.delete_cookie(REFRESH_COOKIE, path=REFRESH_PATH, httponly=True, secure=secure, samesite=s.cookie_samesite)


def set_csrf_cookie(response: Response, request: Request, value: str) -> None:
    response.set_cookie(CSRF_COOKIE, value, max_age=60 * 60 * 24 * 30, path="/", httponly=False, secure=is_secure(request), samesite="strict")
