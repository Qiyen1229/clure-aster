"""AI 額度：每位使用者的日／週／月上限，加上全站每日上限（保護上游免費額度）。

- 重置時間以 CLURE_TIMEZONE（預設 Asia/Taipei）為準：每日 00:00、每週一 00:00、每月 1 日 00:00。
- 用量＝時間區間內 ai_usage 的 cost 加總，不另存計數器，所以沒有「忘記重置」的問題。
- 呼叫前先「預留」一列（立即提交，讓同時進來的請求看得到），成功才保留，失敗整列刪除、不扣額度。
  預留與檢查之間仍有極小的競爭空間，最壞情況是多放行一兩次，不影響正確性。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import utcnow
from app.model import ROLE_ADMIN, AiUsage, AppSetting
from app.schema.ai import AiQuota, QuotaWindow
from app.service.errors import ServiceError

KEYS = ("ai_enabled", "ai_user_daily", "ai_user_weekly", "ai_user_monthly", "ai_global_daily", "ai_admin_daily", "ai_admin_weekly", "ai_admin_monthly")
PENDING_TTL = timedelta(minutes=2)  # 預留後超過這個時間仍未完成（例如程序中斷）就不再計入
WINDOW_NAMES = {"daily": "今日", "weekly": "本週", "monthly": "本月"}


@dataclass
class Limits:
    enabled: bool
    user_daily: int
    user_weekly: int
    user_monthly: int
    global_daily: int
    admin_daily: int
    admin_weekly: int
    admin_monthly: int
    overridden: bool

    def for_role(self, role: str) -> tuple[int, int, int]:
        """(每日, 每週, 每月) 上限：管理員與一般使用者分開設定。"""
        if role == ROLE_ADMIN:
            return self.admin_daily, self.admin_weekly, self.admin_monthly
        return self.user_daily, self.user_weekly, self.user_monthly


def read_limits(db: Session) -> Limits:
    s = get_settings()
    rows = {r.key: r.value for r in db.scalars(select(AppSetting).where(AppSetting.key.in_(KEYS)))}

    def num(key: str, default: int) -> int:
        try:
            return max(0, int(rows[key])) if key in rows else default
        except ValueError:
            return default

    return Limits(
        enabled=rows["ai_enabled"] == "1" if "ai_enabled" in rows else True,
        user_daily=num("ai_user_daily", s.ai_user_daily), user_weekly=num("ai_user_weekly", s.ai_user_weekly),
        user_monthly=num("ai_user_monthly", s.ai_user_monthly), global_daily=num("ai_global_daily", s.ai_global_daily),
        admin_daily=num("ai_admin_daily", s.ai_admin_daily), admin_weekly=num("ai_admin_weekly", s.ai_admin_weekly),
        admin_monthly=num("ai_admin_monthly", s.ai_admin_monthly), overridden=bool(rows),
    )


def _tz() -> ZoneInfo:
    return ZoneInfo(get_settings().timezone)


def _to_utc(local: datetime) -> datetime:
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def window_bounds(now: datetime | None = None) -> dict[str, tuple[datetime, datetime]]:
    """回傳 {daily|weekly|monthly: (開始, 下次重置)}，皆為 UTC naive（和資料庫一致）。"""
    tz = _tz()
    local = (now.replace(tzinfo=timezone.utc) if now else datetime.now(timezone.utc)).astimezone(tz)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    week = day - timedelta(days=day.weekday())  # 週一
    month = day.replace(day=1)
    next_month = (month.replace(year=month.year + 1, month=1) if month.month == 12 else month.replace(month=month.month + 1))
    # 用「年月日」重建本地時間再轉換，避免跨夏令時間時加減 timedelta 出錯
    nxt = lambda d, days: _to_utc((d + timedelta(days=days)).replace(hour=0, minute=0))  # noqa: E731
    return {
        "daily": (_to_utc(day), nxt(day, 1)),
        "weekly": (_to_utc(week), nxt(week, 7)),
        "monthly": (_to_utc(month), _to_utc(next_month)),
    }


def _used(db: Session, since: datetime, user_id: int | None = None) -> int:
    q = select(func.coalesce(func.sum(AiUsage.cost), 0)).where(AiUsage.created_at >= since)
    if user_id is not None:
        q = q.where(AiUsage.user_id == user_id)
    # 預留中但太久沒完成的不計
    q = q.where((AiUsage.pending.is_(False)) | (AiUsage.created_at >= utcnow() - PENDING_TTL))
    return int(db.scalar(q) or 0)


def _window(limit: int, used: int, resets_at: datetime) -> QuotaWindow:
    return QuotaWindow(limit=limit, used=used, remaining=None if limit == 0 else max(0, limit - used), resets_at=resets_at)


def quota_for(db: Session, user_id: int, role: str, limits: Limits | None = None) -> AiQuota:
    lim = limits or read_limits(db)
    d, w, m = lim.for_role(role)
    b = window_bounds()
    return AiQuota(
        daily=_window(d, _used(db, b["daily"][0], user_id), b["daily"][1]),
        weekly=_window(w, _used(db, b["weekly"][0], user_id), b["weekly"][1]),
        monthly=_window(m, _used(db, b["monthly"][0], user_id), b["monthly"][1]),
    )


def global_used_today(db: Session) -> int:
    return _used(db, window_bounds()["daily"][0])


def global_exhausted(db: Session, limits: Limits) -> bool:
    return limits.global_daily > 0 and global_used_today(db) >= limits.global_daily


def _reset_text(resets_at: datetime) -> str:
    local = resets_at.replace(tzinfo=timezone.utc).astimezone(_tz())
    return local.strftime("%m/%d %H:%M")


def reserve(db: Session, user_id: int, kind: str, cost: int = 1, role: str = "user") -> AiUsage:
    """預留額度；超過任何一層上限就拒絕（429），不會寫入。"""
    limits = read_limits(db)
    if not limits.enabled:
        raise ServiceError(503, "管理員已關閉 AI 功能")
    db.execute(delete(AiUsage).where(AiUsage.pending.is_(True), AiUsage.created_at < utcnow() - PENDING_TTL))
    row = AiUsage(user_id=user_id, kind=kind, cost=cost, pending=True)
    db.add(row)
    db.flush()
    b = window_bounds()
    over: str | None = None
    d, w, m = limits.for_role(role)
    for name, limit in (("daily", d), ("weekly", w), ("monthly", m)):
        if limit > 0 and _used(db, b[name][0], user_id) > limit:
            over = f"{WINDOW_NAMES[name]} AI 額度已用完（{limit} 次），{_reset_text(b[name][1])} 重置"
            break
    if over is None and limits.global_daily > 0 and _used(db, b["daily"][0]) > limits.global_daily:
        over = "今日全站 AI 額度已用完，明天 00:00 重置"
    if over:
        db.delete(row)
        db.commit()
        raise ServiceError(429, over)
    db.commit()  # 立即提交，讓同時進來的請求看得到這次預留
    return row


def confirm(db: Session, row: AiUsage, provider: str, model: str) -> None:
    row.pending = False
    row.provider = provider
    row.model = model[:100]
    db.commit()


def release(db: Session, row: AiUsage) -> None:
    db.delete(row)
    db.commit()
