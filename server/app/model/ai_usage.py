"""AI 呼叫紀錄：每次成功的呼叫一列，額度（日／週／月）由時間區間內的筆數加總得出，不另存會重置的計數器。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.security import utcnow
from app.model.base import Base


class AiUsage(Base):
    __tablename__ = "ai_usage"
    __table_args__ = (Index("ix_ai_usage_user_created", "user_id", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    kind: Mapped[str] = mapped_column(String(32))  # 功能類型，例如 parse_entry（不記錄任何內容）
    provider: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(100), default="")
    # 這次扣幾點額度（一般 1；之後辨識圖片等較貴的功能可以 > 1）
    cost: Mapped[int] = mapped_column(Integer, default=1)
    # 預留中（尚未呼叫完成）。呼叫失敗時整列刪除，不扣使用者額度
    pending: Mapped[bool] = mapped_column(default=True)
