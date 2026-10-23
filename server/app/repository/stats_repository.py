"""系統統計查詢。"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.model import ROLE_ADMIN, User


class StatsRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def user_counts(self, *, today_start: datetime, now: datetime) -> dict[str, int]:
        def c(*conds) -> int:  # noqa: ANN002
            return self.db.scalar(select(func.count(User.id)).where(*conds)) or 0
        return {
            "total_users": c(),
            "active_users": c(User.is_active.is_(True)),
            "frozen_users": c(User.is_active.is_(False)),
            "admins": c(User.role == ROLE_ADMIN),
            "active_today": c(User.last_seen_at.is_not(None), User.last_seen_at >= today_start),
            "new_users_today": c(User.created_at >= today_start),
            "locked_accounts": c(User.locked_until.is_not(None), User.locked_until > now),
        }

    def db_size(self) -> tuple[int, str]:
        bind = self.db.get_bind()
        dialect = bind.dialect.name
        if dialect == "sqlite":
            path = bind.url.database
            if path and path != ":memory:":
                total = 0
                for suffix in ("", "-wal", "-shm"):
                    p = Path(path + suffix)
                    if p.exists():
                        total += p.stat().st_size
                return total, "SQLite"
            page = self.db.execute(text("PRAGMA page_count")).scalar() or 0
            size = self.db.execute(text("PRAGMA page_size")).scalar() or 0
            return int(page) * int(size), "SQLite（記憶體）"
        if dialect == "postgresql":
            return int(self.db.execute(text("SELECT pg_database_size(current_database())")).scalar() or 0), "PostgreSQL"
        return 0, dialect
