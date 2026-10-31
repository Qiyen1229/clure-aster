"""對外通知路由：通道管理、測試、App 事件轉送。需登入，非 GET 需 CSRF。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_client, get_current_user, get_db, rate_limit
from app.core.rate_limit import RateLimiter
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.auth import MessageResponse
from app.schema.notify import ChannelCreate, ChannelOut, ChannelPatch, EventRequest, EventResult, TestResult
from app.service.notify_service import NotifyService, to_out

router = APIRouter(prefix="/api/notify", tags=["notify"])
# 事件由 App 自動送出，每人每分鐘 20 則已經很寬裕；測試與新增設定更嚴格，避免被拿來洗頻
event_limiter = RateLimiter(20, name="notify-event")
dedupe_limiter = RateLimiter(1, window_seconds=86400, name="notify-dedupe")
test_limiter = RateLimiter(6, name="notify-test")


@router.get("/channels", response_model=list[ChannelOut], summary="通知通道列表（機密已遮罩）")
def channels(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[ChannelOut]:
    return [to_out(c) for c in NotifyService(db).channels(user)]


@router.post("/channels", response_model=ChannelOut, status_code=201, summary="新增通知通道")
def create(body: ChannelCreate, user: User = Depends(get_current_user), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> ChannelOut:
    rate_limit(test_limiter, f"create:{user.id}")
    return to_out(NotifyService(db).create(user, body, client))


@router.patch("/channels/{channel_id}", response_model=ChannelOut, summary="修改通道（開關、名稱、通知類型、換權杖）")
def update(channel_id: int, body: ChannelPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ChannelOut:
    return to_out(NotifyService(db).update(user, channel_id, body))


@router.delete("/channels/{channel_id}", response_model=MessageResponse, summary="刪除通道")
def delete(channel_id: int, user: User = Depends(get_current_user), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> MessageResponse:
    NotifyService(db).delete(user, channel_id, client)
    return MessageResponse(message="已刪除")


@router.post("/channels/{channel_id}/test", response_model=TestResult, summary="送出測試通知")
def test(channel_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> TestResult:
    rate_limit(test_limiter, f"test:{user.id}")
    r = NotifyService(db).test(user, channel_id)
    return TestResult(ok=r.ok, detail="已送出，請到對方的 App 確認" if r.ok else r.detail)


@router.post("/event", response_model=EventResult, summary="App 偵測到事件，轉送到已開啟的通道")
def event(body: EventRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> EventResult:
    rate_limit(event_limiter, str(user.id))
    if body.key and not dedupe_limiter.hit(f"{user.id}:{body.key}")[0]:
        return EventResult(channels=0, sent=0, failed=[])  # 24 小時內已轉送過同一件事
    return NotifyService(db).event(user, body)
