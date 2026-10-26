"""頻率限制：固定時間窗計數，存在資料庫（rate_limits 表）。

重啟 API 不會歸零，多個 worker 也共用同一份計數。每次檢查使用獨立的短交易，不影響請求本身的 Session。
"""
from __future__ import annotations

import time

from sqlalchemy import delete, select

from app.model import RateLimitHit


class RateLimiter:
    def __init__(self, limit: int, window_seconds: int = 60, name: str = "default") -> None:
        self.limit = limit
        self.window = int(window_seconds)
        self.name = name

    def hit(self, key: str) -> tuple[bool, int]:
        """記錄一次嘗試；回傳 (是否允許, 需等待秒數)。"""
        from app.db import session_scope

        now = int(time.time())
        k = f"{self.name}:{key}"[:200]
        for db in session_scope():
            row = db.scalar(select(RateLimitHit).where(RateLimitHit.key == k).with_for_update())
            if row is None:
                db.add(RateLimitHit(key=k, window_start=now, count=1))
                return True, 0
            if now - row.window_start >= self.window:
                row.window_start = now
                row.count = 1
                return True, 0
            if row.count >= self.limit:
                return False, max(1, self.window - (now - row.window_start))
            row.count += 1
            # 偶爾清掉過期的計數，避免表無限成長
            if now % 50 == 0:
                db.execute(delete(RateLimitHit).where(RateLimitHit.window_start < now - 3600))
        return True, 0

    def reset(self) -> None:
        from app.db import session_scope

        for db in session_scope():
            db.execute(delete(RateLimitHit).where(RateLimitHit.key.like(f"{self.name}:%")))
