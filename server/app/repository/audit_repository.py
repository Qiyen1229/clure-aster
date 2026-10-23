"""審計日誌資料存取。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.model import AuditLog, User


class AuditRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, log: AuditLog) -> AuditLog:
        self.db.add(log)
        self.db.flush()
        return log

    def search(self, *, action: str | None, user_id: int | None, success: bool | None,
               start: datetime | None, end: datetime | None, page: int, size: int) -> tuple[list[tuple[AuditLog, str | None, str | None]], int]:
        actor = User.__table__.alias("actor")
        subject = User.__table__.alias("subject")
        stmt = (
            select(AuditLog, subject.c.username, actor.c.username)
            .outerjoin(subject, subject.c.id == AuditLog.user_id)
            .outerjoin(actor, actor.c.id == AuditLog.actor_id)
        )
        if action:
            stmt = stmt.where(AuditLog.action.like(f"{action}%"))
        if user_id is not None:
            stmt = stmt.where(AuditLog.user_id == user_id)
        if success is not None:
            stmt = stmt.where(AuditLog.success.is_(success))
        if start:
            stmt = stmt.where(AuditLog.created_at >= start)
        if end:
            stmt = stmt.where(AuditLog.created_at < end)
        total = self.db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = self.db.execute(stmt.order_by(AuditLog.id.desc()).offset((page - 1) * size).limit(size)).all()
        return [(r[0], r[1], r[2]) for r in rows], total

    def count_failed_logins_since(self, since: datetime) -> int:
        return self.db.scalar(
            select(func.count(AuditLog.id)).where(AuditLog.action == "auth.login", AuditLog.success.is_(False), AuditLog.created_at >= since)
        ) or 0
