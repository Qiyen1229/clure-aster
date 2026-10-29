"""認證路由：註冊、登入、刷新、登出、目前使用者、變更密碼。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import Response as PlainResponse
from sqlalchemy.orm import Session

from app.api.cookies import REFRESH_COOKIE, clear_auth_cookies, set_auth_cookies
from app.api.deps import get_client, get_current_user, get_db, get_optional_user, login_account_limiter, login_ip_limiter, rate_limit, register_limiter, reset_account_limiter, reset_ip_limiter
from app.core.config import get_settings
from app.core.mailer import mail_configured
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.auth import ChangePasswordRequest, ForgotPasswordRequest, LoginRequest, MessageResponse, RegisterRequest, ResetPasswordRequest, UserPublic
from app.service.app_settings import registration_open
from app.service.auth_service import AuthService, IssuedTokens

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _respond(response: Response, request: Request, tokens: IssuedTokens) -> None:
    set_auth_cookies(response, request, access=tokens.access_token, access_exp=tokens.access_expires,
                     refresh=tokens.refresh_token, refresh_exp=tokens.refresh_expires)
    response.headers["Cache-Control"] = "no-store"


@router.get("/registration", summary="是否開放註冊（登入頁決定要不要顯示註冊連結）")
def registration(db: Session = Depends(get_db)) -> dict[str, bool]:
    return {"open": registration_open(db)}


@router.post("/register", response_model=UserPublic, status_code=201, summary="註冊")
def register(body: RegisterRequest, request: Request, response: Response, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> User:
    rate_limit(register_limiter, client.ip)
    user, tokens = AuthService(db).register(body, client)
    _respond(response, request, tokens)
    return user


@router.post("/login", response_model=UserPublic, summary="登入")
def login(body: LoginRequest, request: Request, response: Response, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> User:
    rate_limit(login_ip_limiter, client.ip)
    rate_limit(login_account_limiter, f"{client.ip}:{body.identifier.lower()}")
    user, tokens = AuthService(db).login(body, client)
    _respond(response, request, tokens)
    return user


@router.get("/forgot-info", summary="忘記密碼的方式：寄信重設，或聯絡管理員")
def forgot_info() -> dict[str, object]:
    s = get_settings()
    return {"mail": mail_configured() and bool(s.public_url), "contact": s.admin_contact_email}


@router.post("/forgot-password", response_model=MessageResponse, summary="忘記密碼：寄重設連結")
def forgot_password(body: ForgotPasswordRequest, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> MessageResponse:
    rate_limit(reset_ip_limiter, client.ip)
    rate_limit(reset_account_limiter, body.identifier.lower())
    AuthService(db).request_reset(body.identifier, client)
    return MessageResponse(message="如果這個帳號存在，重設密碼的信已寄出，請到信箱查看（也看看垃圾郵件）")


@router.post("/reset-password", response_model=MessageResponse, summary="用信中的連結設定新密碼")
def reset_password(body: ResetPasswordRequest, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> MessageResponse:
    rate_limit(reset_ip_limiter, client.ip)
    AuthService(db).reset_password(body, client)
    return MessageResponse(message="密碼已重設，請用新密碼登入")


@router.post("/refresh", response_model=UserPublic, summary="刷新權杖（輪替）")
def refresh(request: Request, response: Response, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> User:
    user, tokens = AuthService(db).refresh(request.cookies.get(REFRESH_COOKIE), client)
    _respond(response, request, tokens)
    return user


@router.post("/logout", response_model=MessageResponse, summary="登出")
def logout(request: Request, response: Response, client: ClientInfo = Depends(get_client), user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)) -> MessageResponse:
    AuthService(db).logout(request.cookies.get(REFRESH_COOKIE), user, client)
    clear_auth_cookies(response, request)
    return MessageResponse(message="已登出")


@router.get("/me", response_model=UserPublic, summary="目前使用者")
def me(response: Response, user: User = Depends(get_current_user)) -> User:
    response.headers["Cache-Control"] = "no-store"
    return user


@router.post("/change-password", response_model=UserPublic, summary="變更密碼")
def change_password(body: ChangePasswordRequest, request: Request, response: Response, client: ClientInfo = Depends(get_client),
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
    tokens = AuthService(db).change_password(user, body, client)
    _respond(response, request, tokens)
    return user


@router.get("/check", status_code=204, summary="登入檢查（nginx auth_request 用）", include_in_schema=False)
def check(user: User | None = Depends(get_optional_user)) -> PlainResponse:
    """已登入（Access Token 有效）回 204，否則 401。關閉 proxy_require_login 時一律 204。"""
    if user or not get_settings().proxy_require_login:
        return PlainResponse(status_code=204)
    return PlainResponse(status_code=401)
