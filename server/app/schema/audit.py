"""審計日誌回應與查詢模型。"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    user_id: int | None
    username: str | None = None
    actor_id: int | None
    actor_username: str | None = None
    action: str
    success: bool
    ip: str
    user_agent: str
    detail: dict[str, Any] | None = None


class AuditLogList(BaseModel):
    items: list[AuditLogOut]
    total: int
    page: int
    size: int


class AuditQuery(BaseModel):
    action: str | None = Field(None, max_length=64)
    user_id: int | None = None
    success: bool | None = None
    date_from: date | None = None
    date_to: date | None = None
    page: int = Field(1, ge=1)
    size: int = Field(50, ge=1, le=200)
