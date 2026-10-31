"""對外通知的請求／回應模型。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.outgoing import EVENTS, KINDS


class ChannelCreate(BaseModel):
    kind: str
    name: str = Field("", max_length=40)
    # 依類型不同：discord {url}、telegram {token, chat_id}、line {token, to}、webhook {url, secret?}
    config: dict[str, str]
    events: list[str] = Field(default_factory=list)

    @field_validator("kind")
    @classmethod
    def _kind(cls, v: str) -> str:
        if v not in KINDS:
            raise ValueError("不支援的通知類型")
        return v

    @field_validator("events")
    @classmethod
    def _events(cls, v: list[str]) -> list[str]:
        return [e for e in dict.fromkeys(v) if e in EVENTS]


class ChannelPatch(BaseModel):
    name: str | None = Field(None, max_length=40)
    enabled: bool | None = None
    events: list[str] | None = None
    # 要換權杖／網址時整組重送；不送就保持原樣
    config: dict[str, str] | None = None

    @field_validator("events")
    @classmethod
    def _events(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else [e for e in dict.fromkeys(v) if e in EVENTS]


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    name: str
    hint: str
    events: list[str]
    enabled: bool
    last_ok_at: datetime | None
    last_error: str


class TestResult(BaseModel):
    ok: bool
    detail: str


class EventRequest(BaseModel):
    """App 偵測到的事件（異常大額、預算超支…），由伺服器轉送到使用者開啟的通道。"""

    event: str
    title: str = Field(..., min_length=1, max_length=120)
    body: str = Field("", max_length=1000)
    level: str = "info"
    # App 內的路徑（例如 /insights）；伺服器有設定 CLURE_PUBLIC_URL 時會變成可點的完整連結
    path: str = Field("", max_length=200)
    fields: list[tuple[str, str]] = Field(default_factory=list, max_length=10)
    # 去重用：同一個 key 24 小時內只轉送一次（兩台裝置各自偵測到同一件事時不會重複通知）
    key: str = Field("", max_length=120)

    @field_validator("event")
    @classmethod
    def _event(cls, v: str) -> str:
        if v not in EVENTS:
            raise ValueError("不支援的通知類型")
        return v

    @field_validator("level")
    @classmethod
    def _level(cls, v: str) -> str:
        return v if v in ("info", "success", "warn", "alert") else "info"


class EventResult(BaseModel):
    channels: int
    sent: int
    failed: list[str]
