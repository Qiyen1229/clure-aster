"""管理後台請求／回應模型。"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schema.auth import USERNAME_RE, normalize_email, validate_password_strength


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


class CreateUserRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    username: str = Field(min_length=3, max_length=32)
    email: str = Field(min_length=3, max_length=254)
    role: Literal["user", "admin"] = "user"
    password: str | None = Field(None, max_length=128, description="空白＝自動產生臨時密碼")

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        if not USERNAME_RE.match(v):
            raise ValueError("使用者名稱只能使用英文、數字、底線、點與連字號（3–32 字元）")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return normalize_email(v)

    @field_validator("password")
    @classmethod
    def _password(cls, v: str | None) -> str | None:
        return validate_password_strength(v) if v else None


class CreateUserResponse(BaseModel):
    user: AdminUserOut
    temporary_password: str | None = None
    message: str


class MailStatus(BaseModel):
    configured: bool
    host: str
    sender: str
    public_url: str
    dns_check: bool


class MailTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    to: str = Field(min_length=3, max_length=254)

    @field_validator("to")
    @classmethod
    def _to(cls, v: str) -> str:
        return normalize_email(v)


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


class SystemSettingsOut(BaseModel):
    allow_registration: bool
    # .env 的 CLURE_ALLOW_REGISTRATION；後台改過後以後台為準
    allow_registration_default: bool
    allow_registration_overridden: bool


class SystemSettingsUpdate(BaseModel):
    allow_registration: bool | None = None
