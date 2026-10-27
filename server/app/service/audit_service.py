"""審計日誌服務：統一寫入與查詢。detail 只放可公開的描述性資訊。"""
from __future__ import annotations

import json
import logging
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.request_info import ClientInfo
from app.model import AuditLog
from app.repository.audit_repository import AuditRepository
from app.schema.audit import AuditLogList, AuditLogOut, AuditQuery

log = logging.getLogger("aster.audit")
_FORBIDDEN_KEYS = {"password", "new_password", "current_password", "token", "refresh_token", "access_token", "temporary_password"}


def local_day_bounds_utc(d: datetime | None = None) -> tuple[datetime, datetime]:
    """設定時區中「今天」的起訖時間（轉為 UTC naive）。"""
    tz = ZoneInfo(get_settings().timezone)
    local_now = (d or datetime.now(tz)).astimezone(tz)
    start_local = datetime.combine(local_now.date(), time.min, tzinfo=tz)
    start = start_local.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
    return start, start + timedelta(days=1)


class AuditService:
    def __init__(self, db: Session) -> None:
        self.repo = AuditRepository(db)

    def record(self, action: str, client: ClientInfo, *, success: bool = True, user_id: int | None = None,
               actor_id: int | None = None, detail: dict[str, Any] | None = None) -> None:
        safe = {k: v for k, v in (detail or {}).items() if k not in _FORBIDDEN_KEYS}
        self.repo.add(AuditLog(
            action=action, success=success, user_id=user_id, actor_id=actor_id, ip=client.ip,
            user_agent=client.user_agent, detail=json.dumps(safe, ensure_ascii=False) if safe else None,
        ))
        log.info("audit action=%s success=%s user_id=%s actor_id=%s ip=%s", action, success, user_id, actor_id, client.ip)

    def search(self, q: AuditQuery) -> AuditLogList:
        tz = ZoneInfo(get_settings().timezone)
        to_utc = lambda d: datetime.combine(d, time.min, tzinfo=tz).astimezone(ZoneInfo("UTC")).replace(tzinfo=None)  # noqa: E731
        start = to_utc(q.date_from) if q.date_from else None
        end = to_utc(q.date_to) + timedelta(days=1) if q.date_to else None
        rows, total = self.repo.search(action=q.action, user_id=q.user_id, success=q.success, start=start, end=end, page=q.page, size=q.size)
        items = []
        for row, username, actor_username in rows:
            items.append(AuditLogOut(
                id=row.id, created_at=row.created_at, user_id=row.user_id, username=username, actor_id=row.actor_id,
                actor_username=actor_username, action=row.action, success=row.success, ip=row.ip, user_agent=row.user_agent,
                detail=json.loads(row.detail) if row.detail else None,
            ))
        return AuditLogList(items=items, total=total, page=q.page, size=q.size)
