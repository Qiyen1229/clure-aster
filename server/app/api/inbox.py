"""收件匣路由。

- /api/inbox/*：App 使用（登入 Cookie，非 GET 需 CSRF）：管理捷徑權杖、列出與確認待記帳項目
- /api/hook/inbox：iPhone 捷徑使用（Authorization: Bearer clr_…，或匯入式捷徑用的 ?t=clr_…）；不使用 Cookie，因此不需要 CSRF
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import get_client, get_current_user, get_db, rate_limit
from app.core.rate_limit import RateLimiter
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.auth import MessageResponse
from app.schema.inbox import AckRequest, AckResult, AttachmentOut, HookItem, HookResult, InboxItemOut, TokenCreate, TokenCreated, TokenOut, TokenPatch
from app.service import mail_service
from app.service.errors import ServiceError
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


@router.patch("/tokens/{token_id}", response_model=TokenOut, summary="設定 Email 轉寄的寄件人白名單")
def patch_token(token_id: int, body: TokenPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> TokenOut:
    return TokenOut.model_validate(InboxService(db).set_allow_from(user, token_id, body.allow_from))


@router.get("/items", response_model=list[InboxItemOut], summary="待確認的項目")
def items(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[InboxItemOut]:
    svc = InboxService(db)
    rows = svc.items(user)
    atts = svc.attachments_for([i.id for i in rows])
    return [InboxItemOut.model_validate(i).model_copy(update={"attachments": [AttachmentOut.model_validate(a) for a in atts.get(i.id, [])]}) for i in rows]


@router.get("/attachments/{attachment_id}", summary="下載 Email 帳單附件（App 用，確認處理後會一併刪除）")
def attachment(attachment_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> Response:
    a = InboxService(db).attachment(user, attachment_id)
    # 一律當成下載、禁止瀏覽器猜型別：附件是外人寄來的內容，不能讓它在 Aster 的網域裡被當成網頁執行
    return Response(content=a.data, media_type=a.content_type or "application/octet-stream",
                    headers={"Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})


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


@hook_router.post("/mail", response_model=HookResult, summary="Email 轉寄收帳單（收信管道把整封信 POST 到這裡）")
async def hook_mail(request: Request, client: ClientInfo = Depends(get_client), authorization: str | None = Header(None), x_aster_token: str | None = Header(None),
                    t: str | None = Query(None, max_length=80), db: Session = Depends(get_db)) -> HookResult:
    """內容可以是整封 RFC 822 信（Content-Type: message/rfc822，Cloudflare Email Worker 的 message.raw），
    或 JSON：{"from","subject","text","attachments":[{"filename","content_type","content_base64"}]}。權杖用法和 /api/hook/inbox 相同。"""
    token = x_aster_token or (authorization[7:].strip() if authorization and authorization[:7].lower() == "bearer " else None) or t
    rate_limit(hook_ip_limiter, client.ip or "?")
    svc = InboxService(db)
    user, row = svc.user_for_token(token)
    rate_limit(hook_limiter, str(row.id))
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > mail_service.MAX_RAW:
        raise ServiceError(413, "信件太大（上限 10 MB）")
    raw = await request.body()
    if len(raw) > mail_service.MAX_RAW:
        raise ServiceError(413, "信件太大（上限 10 MB）")
    if "json" in (request.headers.get("content-type") or "").lower():
        try:
            mail = mail_service.parse_json(json.loads(raw))
        except ValueError:
            raise ServiceError(422, "JSON 格式錯誤") from None
    else:
        mail = mail_service.parse_raw(raw)
    item = svc.receive_mail(user, row, mail)
    if item is None:
        return HookResult(ok=False, message="寄件人不在這組權杖的白名單內，已略過")
    return HookResult(message="已收到信件，打開 Aster 確認" + (f"（含 {len(mail.attachments)} 個附件）" if mail.attachments else ""))
