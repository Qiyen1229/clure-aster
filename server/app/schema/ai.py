"""AI 功能的請求／回應模型。"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class QuotaWindow(BaseModel):
    limit: int  # 0＝不限
    used: int
    remaining: int | None  # 不限時為 None
    resets_at: datetime  # UTC；前端自行轉為本地時間


class AiQuota(BaseModel):
    daily: QuotaWindow
    weekly: QuotaWindow
    monthly: QuotaWindow


class AiStatus(BaseModel):
    enabled: bool  # 管理員是否開啟
    configured: bool  # 是否至少有一個供應商設定了 Key
    available: bool  # enabled 且 configured 且全站額度未用完
    message: str
    quota: AiQuota


class ParseEntryRequest(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    # 只送名稱，讓模型從使用者既有的分類與帳戶中挑選（不送金額與帳目）
    categories: list[str] = Field(default_factory=list, max_length=120)
    accounts: list[str] = Field(default_factory=list, max_length=40)
    today: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class ParsedEntry(BaseModel):
    type: Literal["expense", "income", "transfer"] = "expense"
    amount: float = Field(gt=0, lt=1e12)
    note: str = ""
    category: str | None = None
    account: str | None = None
    to_account: str | None = None  # 轉帳的轉入帳戶
    date: str | None = None  # YYYY-MM-DD


class ParseEntryResult(BaseModel):
    entries: list[ParsedEntry]
    quota: AiQuota


# ── 管理員 ──

class AiProviderInfo(BaseModel):
    name: str
    model: str
    configured: bool
    cooling_down: bool  # 連續失敗後暫時跳過


class AiAdminOut(BaseModel):
    enabled: bool
    user_daily: int
    user_weekly: int
    user_monthly: int
    global_daily: int
    # 目前生效值是否來自後台（否則沿用 .env 預設）
    overridden: bool
    providers: list[AiProviderInfo]
    used_today: int
    used_today_by_provider: dict[str, int]


class AiAdminUpdate(BaseModel):
    enabled: bool | None = None
    user_daily: int | None = Field(None, ge=0, le=100000)
    user_weekly: int | None = Field(None, ge=0, le=100000)
    user_monthly: int | None = Field(None, ge=0, le=100000)
    global_daily: int | None = Field(None, ge=0, le=1000000)


# ── 主控台 ──

class ConsoleProvider(BaseModel):
    name: str
    model: str
    base_host: str  # 只顯示網域，不含路徑
    configured: bool
    key_hint: str  # 例如 ••••ab12；沒設定時為空
    cooling_down: bool
    cooldown_remaining_s: int
    ok: int  # 自上次 API 重啟的成功／失敗次數
    fail: int
    last_ok_at: float | None  # epoch 秒
    last_fail_at: float | None
    last_error: str
    last_latency_ms: int | None


class UsageTotals(BaseModel):
    today: int
    week: int
    month: int


class UserUsage(BaseModel):
    user_id: int
    username: str
    today: int
    week: int
    month: int


class RecentCall(BaseModel):
    at: datetime  # UTC
    username: str
    kind: str
    provider: str
    model: str
    cost: int


class DayCount(BaseModel):
    date: str  # YYYY-MM-DD（台北）
    count: int


class AiConsole(BaseModel):
    settings: AiAdminOut
    providers: list[ConsoleProvider]
    totals: UsageTotals
    by_user: list[UserUsage]
    recent: list[RecentCall]
    daily: list[DayCount]
    timezone: str
    server_time: datetime


class TestRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=32)


class TestResult(BaseModel):
    name: str
    ok: bool
    latency_ms: int | None
    detail: str
