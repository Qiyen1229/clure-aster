"""認證相關請求／回應模型。回應模型不含 password_hash 等敏感欄位。"""
from __future__ import annotations

import re
from datetime import datetime

from email_validator import EmailNotValidError, validate_email
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")


def validate_password_strength(pw: str) -> str:
    if len(pw) < 8 or len(pw) > 128:
        raise ValueError("密碼長度需為 8–128 個字元")
    if not re.search(r"[A-Za-z]", pw) or not re.search(r"\d", pw):
        raise ValueError("密碼需同時包含英文字母與數字")
    return pw


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    username: str = Field(min_length=3, max_length=32)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        if not USERNAME_RE.match(v):
            raise ValueError("使用者名稱只能使用英文、數字、底線、點與連字號（3–32 字元）")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        try:
            return validate_email(v, check_deliverability=False).normalized.lower()
        except EmailNotValidError as e:
            raise ValueError("Email 格式不正確") from e

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        return validate_password_strength(v)

    @model_validator(mode="after")
    def _not_same(self) -> "RegisterRequest":
        if self.password.lower() == self.username.lower():
            raise ValueError("密碼不可與使用者名稱相同")
        return self


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    identifier: str = Field(min_length=1, max_length=254, description="使用者名稱或 Email")
    password: str = Field(min_length=1, max_length=128)


class ChangePasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def _password(cls, v: str) -> str:
        return validate_password_strength(v)


class UserPublic(BaseModel):
    """回傳給使用者本人的資料。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    email: str
    role: str
    must_change_password: bool
    created_at: datetime
    last_login_at: datetime | None


class MessageResponse(BaseModel):
    message: str
