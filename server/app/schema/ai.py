"""AI 功能的請求／回應模型。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


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


# ── 理財問答、預算建議、洞察、分類整理、收據辨識 ──

SUMMARY_MAX_CHARS = 14000  # 收支摘要的上限：避免被拿來當免費的大型文字代理


def _check_summary(v: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(v, ensure_ascii=False)) > SUMMARY_MAX_CHARS:
        raise ValueError("收支摘要太大")
    return v


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=300)
    summary: dict[str, Any]

    _v = field_validator("summary")(_check_summary)


class AskResult(BaseModel):
    answer: str
    followups: list[str] = []
    quota: AiQuota


class BudgetPlanRequest(BaseModel):
    summary: dict[str, Any]
    categories: list[str] = Field(default_factory=list, max_length=120)  # 可選的支出分類名稱

    _v = field_validator("summary")(_check_summary)


class BudgetCategory(BaseModel):
    name: str
    amount: float = Field(ge=0, lt=1e10)
    reason: str = ""


class BudgetPlanResult(BaseModel):
    total: float = Field(gt=0, lt=1e10)
    categories: list[BudgetCategory]
    tips: list[str] = []
    assumption: str = ""
    quota: AiQuota


class InsightsRequest(BaseModel):
    summary: dict[str, Any]
    label: str = Field(default="", max_length=40)  # 例如「2026 年 9 月」

    _v = field_validator("summary")(_check_summary)


class InsightsResult(BaseModel):
    headline: str
    points: list[str]
    suggestion: str = ""
    quota: AiQuota


class CategorizeRequest(BaseModel):
    notes: list[str] = Field(min_length=1, max_length=40)
    categories: list[str] = Field(min_length=1, max_length=120)
    kind: Literal["expense", "income"] = "expense"

    @field_validator("notes")
    @classmethod
    def _notes(cls, v: list[str]) -> list[str]:
        return [n.strip()[:60] for n in v]


class CategorizeItem(BaseModel):
    index: int
    category: str | None


class CategorizeResult(BaseModel):
    items: list[CategorizeItem]
    quota: AiQuota


class ReceiptRequest(BaseModel):
    # data:image/jpeg;base64,…（前端已縮到長邊約 1280px）
    image: str = Field(min_length=100, max_length=1_200_000, pattern=r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")
    categories: list[str] = Field(default_factory=list, max_length=120)
    accounts: list[str] = Field(default_factory=list, max_length=40)
    today: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


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
