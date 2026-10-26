"""Web Push 路由：公開金鑰與狀態、訂閱、取消、排程、測試。需登入，非 GET 需 CSRF。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_client, get_current_user, get_db
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.auth import MessageResponse
from app.schema.push import PushStatus, ScheduleRequest, SubscribeRequest, UnsubscribeRequest
from app.schema.sync import DEVICE_ID_PATTERN
from app.service.push_service import PushService

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/status", response_model=PushStatus, summary="推播公開金鑰與狀態")
def status(device_id: str | None = Query(None, pattern=DEVICE_ID_PATTERN), user: User = Depends(get_current_user),
           db: Session = Depends(get_db)) -> PushStatus:
    return PushService(db).status(user, device_id)


@router.post("/subscribe", response_model=MessageResponse, summary="訂閱推播")
def subscribe(body: SubscribeRequest, user: User = Depends(get_current_user), client: ClientInfo = Depends(get_client),
              db: Session = Depends(get_db)) -> MessageResponse:
    PushService(db).subscribe(user, body, client)
    return MessageResponse(message="已啟用推播")


@router.post("/unsubscribe", response_model=MessageResponse, summary="取消推播")
def unsubscribe(body: UnsubscribeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MessageResponse:
    PushService(db).unsubscribe(user, body.endpoint)
    return MessageResponse(message="已取消推播")


@router.post("/schedule", response_model=MessageResponse, summary="排定未來的提醒")
def schedule(body: ScheduleRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MessageResponse:
    n = PushService(db).schedule(user, body)
    return MessageResponse(message=f"已排定 {n} 則提醒")


@router.post("/test", response_model=MessageResponse, summary="發送測試推播")
def test(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MessageResponse:
    n = PushService(db).send_to_user(user.id, {"title": "Clure 測試推播 🔔", "body": "收到這則通知代表背景推播設定成功", "url": "/settings/notifications", "tag": "test"})
    return MessageResponse(message=f"已送出到 {n} 台裝置" if n else "沒有可用的推播裝置")
