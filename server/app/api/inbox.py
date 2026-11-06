"""收件匣路由。

- /api/inbox/*：App 使用（登入 Cookie，非 GET 需 CSRF）：管理捷徑權杖、列出與確認待記帳項目
- /api/hook/inbox：iPhone 捷徑使用（Authorization: Bearer clr_…，或匯入式捷徑用的 ?t=clr_…）；不使用 Cookie，因此不需要 CSRF
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.api.deps import get_client, get_current_user, get_db, rate_limit
from app.core.rate_limit import RateLimiter
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.auth import MessageResponse
from app.schema.inbox import AckRequest, AckResult, HookItem, HookResult, InboxItemOut, TokenCreate, TokenCreated, TokenOut
from app.service.inbox_service import InboxService

router = APIRouter(prefix="/api/inbox", tags=["inbox"])
hook_router = APIRouter(prefix="/api/hook", tags=["inbox"])
# 每組權杖每分鐘最多 30 則；錯誤的權杖以 IP 計，避免被拿來猜權杖
hook_limiter = RateLimiter(30, name="inbox-hook")
hook_ip_limiter = RateLimiter(60, name="inbox-hook-ip")


@router.get("/tokens", response_model=list[TokenOut], summary="捷徑權杖列表")
def tokens(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[TokenOut]:
    return [TokenOut.model_validate(t) for t in InboxService(db).tokens(user)]


@router.post("/tokens", response_model=TokenCreated, status_code=201, summary="建立捷徑權杖（原文只回傳這一次）")
def create_token(body: TokenCreate, user: User = Depends(get_current_user), client: ClientInfo = Depends(get_client),
                 db: Session = Depends(get_db)) -> TokenCreated:
    token, row = InboxService(db).create_token(user, body.name, client)
    return TokenCreated(token=token, item=TokenOut.model_validate(row))


@router.delete("/tokens/{token_id}", response_model=MessageResponse, summary="撤銷捷徑權杖")
def revoke_token(token_id: int, user: User = Depends(get_current_user), client: ClientInfo = Depends(get_client),
                 db: Session = Depends(get_db)) -> MessageResponse:
    InboxService(db).revoke_token(user, token_id, client)
    return MessageResponse(message="已撤銷，使用這組權杖的捷徑將無法再送出")


@router.get("/items", response_model=list[InboxItemOut], summary="待確認的項目")
def items(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[InboxItemOut]:
    return [InboxItemOut.model_validate(i) for i in InboxService(db).items(user)]


@router.post("/items/ack", response_model=AckResult, summary="已記帳或略過，從收件匣移除")
def ack(body: AckRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> AckResult:
    return AckResult(ids=InboxService(db).ack(user, body.ids))


@hook_router.post("/inbox", response_model=HookResult, summary="iPhone 捷徑送進收件匣")
def hook(body: HookItem, client: ClientInfo = Depends(get_client), authorization: str | None = Header(None), x_aster_token: str | None = Header(None),
         x_clure_token: str | None = Header(None),
         t: str | None = Query(None, max_length=80), db: Session = Depends(get_db)) -> HookResult:
    # 匯入式捷徑只有一個「連結碼」（網址＋?t=權杖），手動設定的捷徑則用 Authorization 標頭；X-Clure-Token 是更名前的標頭
    token = x_aster_token or x_clure_token or (authorization[7:].strip() if authorization and authorization[:7].lower() == "bearer " else None) or t
    rate_limit(hook_ip_limiter, client.ip or "?")
    svc = InboxService(db)
    user, row = svc.user_for_token(token)
    rate_limit(hook_limiter, str(row.id))
    svc.receive(user, row, body)
    return HookResult(message="已送到 Aster，打開 App 確認記帳")
