"""Web Push 的請求／回應模型。"""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.schema.sync import DEVICE_ID_PATTERN


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=20, max_length=256)
    auth: str = Field(min_length=8, max_length=64)


class SubscribeRequest(BaseModel):
    device_id: str = Field(pattern=DEVICE_ID_PATTERN)
    endpoint: str = Field(min_length=10, max_length=1024)
    keys: PushKeys


class UnsubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1024)


class ScheduleItem(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    at: int = Field(ge=0, le=2**53)
    title: str = Field(min_length=1, max_length=120)
    body: str = Field("", max_length=300)
    url: str = Field("/", max_length=256, pattern=r"^/")


class ScheduleRequest(BaseModel):
    device_id: str = Field(pattern=DEVICE_ID_PATTERN)
    items: list[ScheduleItem] = Field(default_factory=list, max_length=200)


class PushStatus(BaseModel):
    public_key: str
    subscribed: bool
    scheduled: int
    devices: int = 0  # 這個帳號在伺服器上共有幾台訂閱中的裝置
    last_error: str = ""  # 伺服器最近一次發送失敗的原因（重啟歸零）
