"""頻率限制：計數必須真的寫入資料庫（曾因在 session_scope 迴圈內提前 return 而跳過 commit，導致永遠不會攔截）。"""
from __future__ import annotations

from app.core.rate_limit import RateLimiter


def test_limiter_blocks_after_limit() -> None:
    lim = RateLimiter(3, name="t-block")
    assert [lim.hit("k")[0] for _ in range(5)] == [True, True, True, False, False]
    assert lim.hit("k")[1] >= 1  # 回傳需等待的秒數


def test_limiter_keys_are_independent_and_reset() -> None:
    lim = RateLimiter(1, name="t-keys")
    assert lim.hit("a")[0] and not lim.hit("a")[0]
    assert lim.hit("b")[0]
    lim.reset()
    assert lim.hit("a")[0]


def test_limiter_window_rolls_over(monkeypatch) -> None:  # noqa: ANN001
    import time as t

    lim = RateLimiter(1, window_seconds=60, name="t-win")
    assert lim.hit("x")[0] and not lim.hit("x")[0]
    real = t.time()
    monkeypatch.setattr("app.core.rate_limit.time.time", lambda: real + 61)
    assert lim.hit("x")[0]  # 新的時間窗重新計數
