"""認證路由：註冊、登入、刷新、登出、目前使用者、變更密碼。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.api.cookies import REFRESH_COOKIE, clear_auth_cookies, set_auth_cookies
from app.api.deps import get_client, get_current_user, get_db, get_optional_user, login_account_limiter, login_ip_limiter, rate_limit, register_limiter
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.auth import ChangePasswordRequest, LoginRequest, MessageResponse, RegisterRequest, UserPublic
from app.service.auth_service import AuthService, IssuedTokens

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _respond(response: Response, request: Request, tokens: IssuedTokens) -> None:
    set_auth_cookies(response, request, access=tokens.access_token, access_exp=tokens.access_expires,
                     refresh=tokens.refresh_token, refresh_exp=tokens.refresh_expires)
    response.headers["Cache-Control"] = "no-store"


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
