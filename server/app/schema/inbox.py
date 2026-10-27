"""收件匣的請求／回應模型。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SOURCES = ("applepay", "sms", "siri", "email", "other")
SOURCE_ALIASES = {"apple_pay": "applepay", "wallet": "applepay", "錢包": "applepay", "message": "sms", "簡訊": "sms", "語音": "siri", "mail": "email"}


def _clip(v: object, n: int) -> str:
    """捷徑送來的值可能是數字、空值或很長的文字：一律轉成去頭尾空白的字串並截斷"""
    if v is None:
        return ""
    return str(v).strip()[:n]


class HookItem(BaseModel):
    """iPhone 捷徑送進收件匣的內容；欄位都可以省略，但至少要有文字或金額。"""

    model_config = ConfigDict(extra="ignore")

    source: str = "other"
    text: str = ""
    amount: str = ""
    merchant: str = ""
    card: str = ""
    date: str = ""

    @field_validator("source", mode="before")
    @classmethod
    def _source(cls, v: object) -> str:
        s = _clip(v, 16).lower().replace(" ", "")
        s = SOURCE_ALIASES.get(s, s)
        return s if s in SOURCES else "other"

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, v: object) -> str:
        return _clip(v, 1000)

    @field_validator("amount", "date", mode="before")
    @classmethod
    def _short(cls, v: object) -> str:
        return _clip(v, 40)

    @field_validator("merchant", mode="before")
    @classmethod
    def _merchant(cls, v: object) -> str:
        return _clip(v, 120)

    @field_validator("card", mode="before")
    @classmethod
    def _card(cls, v: object) -> str:
        return _clip(v, 80)

    @model_validator(mode="after")
    def _not_empty(self) -> HookItem:
        if not (self.text or self.amount or self.merchant):
            raise ValueError("內容是空的：請至少傳送文字或金額")
        return self


class HookResult(BaseModel):
    ok: bool = True
    message: str


class TokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class TokenOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    hint: str
    created_at: datetime
    last_used_at: datetime | None


class TokenCreated(BaseModel):
    """權杖原文只在建立時回傳這一次"""

    token: str
    item: TokenOut


class InboxItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str
    text: str
    amount: str
    merchant: str
    card: str
    occurred: str
    created_at: datetime


class AckRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=200)


class AckResult(BaseModel):
    """實際刪除的項目；另一台裝置已處理過的不會出現在這裡（避免重複記帳）"""

    ids: list[int]
