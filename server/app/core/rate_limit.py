"""滑動視窗頻率限制（行程內記憶體）。
多個 worker 時各自計數；帳號鎖定另以資料庫計數，重啟或多 worker 皆有效。部署建議單一 worker。"""
from __future__ import annotations

import threading
import time
from collections import deque


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float = 60.0) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> tuple[bool, int]:
        """記錄一次嘗試；回傳 (是否允許, 需等待秒數)。"""
        now = time.monotonic()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False, int(self.window - (now - q[0])) + 1
            q.append(now)
            if len(self._hits) > 10000:  # 避免無限成長
                for k in [k for k, v in self._hits.items() if not v][:5000]:
                    self._hits.pop(k, None)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
