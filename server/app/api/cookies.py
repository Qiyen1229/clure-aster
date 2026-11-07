"""Cookie 設定：Access／Refresh Token 皆為 HttpOnly；CSRF Token 供前端讀取後放入標頭（簽章版 double-submit）。

HTTPS 時 Cookie 名稱加上瀏覽器強制的前綴，擋掉「子網域 Cookie Tossing」（同網域下被攻陷的子網域寫入同名 Cookie）：
- `__Host-`（要求 Secure、Path=/、沒有 Domain）：Access Token、CSRF Token——只能由這個主機自己設定，子網域寫不進來
- `__Secure-`：Refresh Token——為了限縮送出範圍它的 Path 是 /api/auth，不符合 `__Host-` 的 Path=/ 規定，退而求其次要求 Secure
HTTP（本機開發、測試）瀏覽器不接受這些前綴，維持原本的名稱。

CSRF Token 是「簽章」的：`隨機值.HMAC(伺服器金鑰, 隨機值 + 綁定對象)`，綁定對象是目前登入的使用者（沒登入是 anon）。
攻擊者就算能寫入 Cookie，也造不出有效簽章；從自己的帳號拿來的有效 Token 綁的是他的使用者，也過不了受害者的請求。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timezone

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import Request, Response

from app.core.config import get_settings
from app.core.security import token_subject

_ACCESS = "clure_access"
_REFRESH = "clure_refresh"
_CSRF = "csrf_token"
CSRF_HEADER = "x-csrf-token"
# Access Token 需要送到 /api 與 /proxy（nginx auth_request 以它判斷報價代理的登入狀態），因此用整個網站路徑。
# 1.2.1 以前是 /api：登入、刷新、登出時一併刪除舊路徑的 Cookie，避免同名 Cookie 並存。
ACCESS_PATH = "/"
LEGACY_ACCESS_PATH = "/api"
REFRESH_PATH = "/api/auth"


def is_secure(request: Request) -> bool:
    s = get_settings()
    if s.cookie_secure != "auto":
        return s.cookie_secure == "true"
    proto = request.headers.get("x-forwarded-proto", "") if s.trust_proxy_headers else ""
    return request.url.scheme == "https" or proto.split(",")[0].strip() == "https"


def access_name(request: Request) -> str:
    return f"__Host-{_ACCESS}" if is_secure(request) else _ACCESS


def refresh_name(request: Request) -> str:
    return f"__Secure-{_REFRESH}" if is_secure(request) else _REFRESH


def csrf_name(request: Request) -> str:
    return f"__Host-{_CSRF}" if is_secure(request) else _CSRF


def read_access(request: Request) -> str | None:
    return request.cookies.get(access_name(request))


def read_refresh(request: Request) -> str | None:
    """Refresh Token。升級到前綴版之前登入的人還帶著舊名稱的 Cookie：只在刷新與登出時暫時接受，換發後就改用新名稱。"""
    return request.cookies.get(refresh_name(request)) or request.cookies.get(_REFRESH)


def _max_age(exp: datetime) -> int:
    return max(0, int((exp.replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)).total_seconds()))


def set_auth_cookies(response: Response, request: Request, *, access: str, access_exp: datetime, refresh: str, refresh_exp: datetime, user_id: int | None = None) -> None:
    s = get_settings()
    secure = is_secure(request)
    response.delete_cookie(_ACCESS, path=LEGACY_ACCESS_PATH, httponly=True, secure=secure, samesite=s.cookie_samesite)
    if secure:  # 升級前的舊名稱：登入後就不再需要
        response.delete_cookie(_ACCESS, path=ACCESS_PATH, httponly=True, secure=True, samesite=s.cookie_samesite)
        response.delete_cookie(_REFRESH, path=REFRESH_PATH, httponly=True, secure=True, samesite=s.cookie_samesite)
    response.set_cookie(access_name(request), access, max_age=_max_age(access_exp), path=ACCESS_PATH, httponly=True, secure=secure, samesite=s.cookie_samesite)
    response.set_cookie(refresh_name(request), refresh, max_age=_max_age(refresh_exp), path=REFRESH_PATH, httponly=True, secure=secure, samesite=s.cookie_samesite)
    if user_id is not None:  # CSRF Token 綁定登入的使用者
        set_csrf_cookie(response, request, new_csrf_token(f"u:{user_id}"))


def clear_auth_cookies(response: Response, request: Request) -> None:
    s = get_settings()
    secure = is_secure(request)
    for name, path in ((access_name(request), ACCESS_PATH), (_ACCESS, LEGACY_ACCESS_PATH), (_ACCESS, ACCESS_PATH), (refresh_name(request), REFRESH_PATH), (_REFRESH, REFRESH_PATH)):
        response.delete_cookie(name, path=path, httponly=True, secure=secure, samesite=s.cookie_samesite)
    set_csrf_cookie(response, request, new_csrf_token("anon"))  # 登出後回到「沒登入」的 CSRF Token


# ───── 簽章 CSRF ─────

def _csrf_key() -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"aster-csrf-v1").derive(get_settings().resolved_jwt_secret().encode())


def _sign(nonce: str, binding: str) -> str:
    mac = hmac.new(_csrf_key(), f"{nonce}.{binding}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac[:18]).decode().rstrip("=")


def new_csrf_token(binding: str) -> str:
    nonce = secrets.token_urlsafe(16)
    return f"{nonce}.{_sign(nonce, binding)}"


def csrf_valid(value: str | None, binding: str) -> bool:
    if not value or value.count(".") != 1 or len(value) > 120:
        return False
    nonce, sig = value.split(".")
    return hmac.compare_digest(sig, _sign(nonce, binding))


def csrf_binding(request: Request) -> str:
    """目前請求綁定的對象：Access Token（Path=/，每個請求都會帶）的使用者；
    Access Token 過期被瀏覽器丟掉時（刷新請求）改看 Refresh Token；都沒有是 anon。到期與否不重要，只要簽章是真的。"""
    sub = token_subject(read_access(request) or "", "access") or token_subject(read_refresh(request) or "", "refresh")
    return f"u:{sub}" if sub else "anon"


def set_csrf_cookie(response: Response, request: Request, value: str) -> None:
    response.set_cookie(csrf_name(request), value, max_age=60 * 60 * 24 * 30, path="/", httponly=False, secure=is_secure(request), samesite="strict")
