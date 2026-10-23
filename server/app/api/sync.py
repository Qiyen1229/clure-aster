"""跨裝置同步 API：上傳本機變更、下載其他裝置的變更。需登入，非 GET 請求需 CSRF 標頭。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.model import User
from app.schema.sync import DEVICE_ID_PATTERN, SyncPullResponse, SyncPushRequest, SyncPushResponse, SyncStatus
from app.service.sync_service import SyncService

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.get("/status", response_model=SyncStatus, summary="同步狀態")
def sync_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> SyncStatus:
    return SyncService(db).status(user)


@router.post("/push", response_model=SyncPushResponse, summary="上傳本機變更")
def push(body: SyncPushRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> SyncPushResponse:
    return SyncService(db).push(user, body.device_id, body.changes)


@router.get("/pull", response_model=SyncPullResponse, summary="下載其他裝置的變更")
def pull(
    since: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=1000),
    device_id: str | None = Query(None, pattern=DEVICE_ID_PATTERN),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SyncPullResponse:
    return SyncService(db).pull(user, since, limit, device_id)
