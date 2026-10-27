"""收件匣：iPhone 捷徑（Apple Pay 交易、銀行簡訊、Siri）送來的待記帳項目，以及捷徑專用權杖。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.security import utcnow
from app.model.base import Base


class InboxToken(Base):
    """捷徑專用權杖：只能「送進收件匣」，不能讀取帳目；伺服器只存 SHA-256 雜湊，隨時可撤銷。"""

    __tablename__ = "inbox_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # 權杖末四碼，讓使用者分辨是哪一組
    hint: Mapped[str] = mapped_column(String(8), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class InboxItem(Base):
    """一則待記帳項目。App 確認記帳或略過後刪除；30 天沒處理自動清除。"""

    __tablename__ = "inbox_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("inbox_tokens.id", ondelete="SET NULL"), nullable=True)
    # applepay／sms／siri／email／other
    source: Mapped[str] = mapped_column(String(16), default="other")
    text: Mapped[str] = mapped_column(String(1000), default="")
    amount: Mapped[str] = mapped_column(String(40), default="")
    merchant: Mapped[str] = mapped_column(String(120), default="")
    card: Mapped[str] = mapped_column(String(80), default="")
    # 捷徑傳來的交易時間（原樣保存，由 App 解析）
    occurred: Mapped[str] = mapped_column(String(40), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
