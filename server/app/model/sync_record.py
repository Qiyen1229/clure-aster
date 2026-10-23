"""跨裝置同步：每位使用者每筆記帳資料的最新版本，以及每位使用者的遞增游標。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.security import utcnow
from app.model.base import Base


class SyncRecord(Base):
    __tablename__ = "sync_records"
    __table_args__ = (
        UniqueConstraint("user_id", "table_name", "record_key", name="uq_sync_records_user_table_key"),
        Index("ix_sync_records_user_seq", "user_id", "seq"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"))
    table_name: Mapped[str] = mapped_column(String(64))
    # 前端主鍵的 JSON 字串（複合主鍵為陣列）
    record_key: Mapped[str] = mapped_column(String(256))
    # 前端變更時間（epoch ms）；「最後寫入者勝」的依據
    updated_at: Mapped[int] = mapped_column(BigInteger)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    # 整筆資料的 JSON；刪除時為 NULL
    payload: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 該使用者範圍內遞增的序號，下載時以此為游標
    seq: Mapped[int] = mapped_column(BigInteger)
    device_id: Mapped[str] = mapped_column(String(64), default="")
    server_updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class SyncState(Base):
    __tablename__ = "sync_states"

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    last_seq: Mapped[int] = mapped_column(BigInteger, default=0)
