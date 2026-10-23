"""跨裝置同步的請求／回應模型。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

# 前端需同步的資料表（與 src/db/sync-tracking.ts 的 SYNCED_TABLES 一致）
SYNC_TABLES = frozenset({
    "accounts", "categories", "transactions", "transfers", "templates", "budgets", "budget_periods", "projects", "tags",
    "saved_filters", "recurring_rules", "installments", "people", "debts", "goals", "exchange_rates", "stocks",
    "stock_trades", "dividends", "watchlist", "portfolio_snapshots", "wishes", "settings",
})
DEVICE_ID_PATTERN = r"^[A-Za-z0-9_-]{8,64}$"
MAX_TIMESTAMP = 2**53


class SyncStatus(BaseModel):
    enabled: bool
    protocol_version: int
    message: str
    records: int = 0
    cursor: int = 0


class SyncChange(BaseModel):
    table: str = Field(max_length=64)
    key: str = Field(min_length=1, max_length=256)
    updated_at: int = Field(ge=0, le=MAX_TIMESTAMP)
    deleted: bool = False
    payload: dict[str, Any] | None = None


class SyncPushRequest(BaseModel):
    device_id: str = Field(pattern=DEVICE_ID_PATTERN)
    changes: list[SyncChange] = Field(default_factory=list, max_length=500)


class SyncPushResponse(BaseModel):
    accepted: int
    # 伺服器已有較新版本而未採用的變更：附上伺服器版本，前端直接套用
    rejected: list[SyncChange]
    cursor: int


class SyncPullResponse(BaseModel):
    changes: list[SyncChange]
    cursor: int
    has_more: bool
