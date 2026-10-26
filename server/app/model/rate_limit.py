"""頻率限制計數（固定時間窗）。存在資料庫，API 重啟或多個 worker 時仍一致。"""
from __future__ import annotations

from sqlalchemy import BigInteger, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.model.base import Base


class RateLimitHit(Base):
    __tablename__ = "rate_limits"

    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    # 時間窗起點（epoch 秒）
    window_start: Mapped[int] = mapped_column(BigInteger)
    count: Mapped[int] = mapped_column(Integer, default=0)
