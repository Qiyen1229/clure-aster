"""管理後台請求／回應模型。"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AdminUserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    email: str
    role: str
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None
    last_seen_at: datetime | None
    failed_login_count: int
    locked_until: datetime | None
    must_change_password: bool


class UserListResponse(BaseModel):
    items: list[AdminUserOut]
    total: int
    page: int
    size: int


class UserListQuery(BaseModel):
    q: str | None = Field(None, max_length=254)
    status: Literal["all", "active", "frozen", "locked"] = "all"
    role: Literal["all", "user", "admin"] = "all"
    page: int = Field(1, ge=1)
    size: int = Field(20, ge=1, le=100)


class StatusUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_active: bool
    reason: str | None = Field(None, max_length=200)


class ResetPasswordResponse(BaseModel):
    temporary_password: str
    message: str


class StatsOut(BaseModel):
    total_users: int
    active_users: int
    frozen_users: int
    admins: int
    active_today: int
    new_users_today: int
    failed_logins_today: int
    locked_accounts: int
    db_size_bytes: int
    db_engine: str
    # 部署設定提醒（開放註冊、預設密碼等）
    warnings: list[str] = []
