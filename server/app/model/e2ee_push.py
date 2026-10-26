"""端對端加密同步的金鑰資訊、Web Push 訂閱與排程。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.security import utcnow
from app.model.base import Base


class SyncKey(Base):
    """端對端加密：伺服器只保存「鹽」與「驗證用密文」，永遠拿不到密碼或金鑰。"""

    __tablename__ = "sync_keys"

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    salt: Mapped[str] = mapped_column(String(64), default="")
    iterations: Mapped[int] = mapped_column(Integer, default=0)
    # 以金鑰加密的固定字串，前端用來確認密碼正確
    check: Mapped[str] = mapped_column(Text, default="")
    # 每次啟用／更換密碼遞增，讓其他裝置知道需要重新輸入
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (UniqueConstraint("endpoint", name="uq_push_subscriptions_endpoint"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str] = mapped_column(String(64), default="")
    endpoint: Mapped[str] = mapped_column(String(1024))
    p256dh: Mapped[str] = mapped_column(String(256))
    auth: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PushSchedule(Base):
    """前端排好的未來提醒（每日記帳、繳款日、續約…），到時間由伺服器發送推播。"""

    __tablename__ = "push_schedules"
    __table_args__ = (
        UniqueConstraint("user_id", "device_id", "item_id", name="uq_push_schedules_item"),
        Index("ix_push_schedules_due", "sent", "at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"))
    device_id: Mapped[str] = mapped_column(String(64))
    item_id: Mapped[str] = mapped_column(String(128))
    # 發送時間（epoch ms）
    at: Mapped[int] = mapped_column(BigInteger)
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(String(300), default="")
    url: Mapped[str] = mapped_column(String(256), default="/")
    sent: Mapped[bool] = mapped_column(Boolean, default=False)
