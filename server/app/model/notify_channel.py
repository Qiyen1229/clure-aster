"""對外通知通道（Discord／Telegram／LINE／Webhook）。機密以 AES-GCM 加密後存放（core/secretbox.py）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.security import utcnow
from app.model.base import Base


class NotifyChannel(Base):
    __tablename__ = "notify_channels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(40))
    # 加密後的設定（網址、權杖）；明文永遠不寫進資料庫
    secret: Mapped[str] = mapped_column(Text)
    # 遮罩後的提示，列表上顯示用（例如「…a1b2c3」）
    hint: Mapped[str] = mapped_column(String(80), default="")
    # 開啟的通知類型（逗號分隔）
    events: Mapped[str] = mapped_column(String(120), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
