"""系統統計儀表板。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.request_info import ClientInfo
from app.core.security import utcnow
from app.model import User
from app.repository.audit_repository import AuditRepository
from app.repository.stats_repository import StatsRepository
from app.schema.admin import StatsOut
from app.service.audit_service import AuditService, local_day_bounds_utc


class StatsService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.stats = StatsRepository(db)
        self.audit_repo = AuditRepository(db)

    def overview(self, admin: User, client: ClientInfo) -> StatsOut:
        today_start, _ = local_day_bounds_utc()
        counts = self.stats.user_counts(today_start=today_start, now=utcnow())
        size, engine = self.stats.db_size()
        AuditService(self.db).record("admin.stats_view", client, actor_id=admin.id)
        self.db.commit()
        return StatsOut(**counts, failed_logins_today=self.audit_repo.count_failed_logins_since(today_start), db_size_bytes=size, db_engine=engine)
