"""同步資料存取：版本紀錄的查詢與寫入、使用者游標的保留。"""
from __future__ import annotations

from sqlalchemy import func, select, tuple_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.model import SyncRecord, SyncState


class SyncRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def reserve_seq(self, user_id: int, count: int) -> int:
        """保留 count 個連續序號，回傳最後一個。

        先執行 UPDATE 取得寫入鎖（SQLite 鎖整個資料庫、PostgreSQL 鎖該列），
        同一使用者的上傳因此依序進行，序號較小的變更一定比較早提交，下載時不會漏資料。
        """
        result = self.db.execute(update(SyncState).where(SyncState.user_id == user_id).values(last_seq=SyncState.last_seq + count))
        if result.rowcount == 0:
            try:
                with self.db.begin_nested():
                    self.db.add(SyncState(user_id=user_id, last_seq=count))
            except IntegrityError:
                self.db.execute(update(SyncState).where(SyncState.user_id == user_id).values(last_seq=SyncState.last_seq + count))
        return int(self.db.scalar(select(SyncState.last_seq).where(SyncState.user_id == user_id)) or 0)

    def last_seq(self, user_id: int) -> int:
        return int(self.db.scalar(select(SyncState.last_seq).where(SyncState.user_id == user_id)) or 0)

    def get_many(self, user_id: int, pairs: list[tuple[str, str]]) -> dict[tuple[str, str], SyncRecord]:
        if not pairs:
            return {}
        out: dict[tuple[str, str], SyncRecord] = {}
        # 分批查詢，避免 SQL 參數過多
        for i in range(0, len(pairs), 200):
            chunk = pairs[i:i + 200]
            stmt = select(SyncRecord).where(
                SyncRecord.user_id == user_id,
                tuple_(SyncRecord.table_name, SyncRecord.record_key).in_(chunk),
            )
            for r in self.db.scalars(stmt):
                out[(r.table_name, r.record_key)] = r
        return out

    def add(self, record: SyncRecord) -> SyncRecord:
        self.db.add(record)
        return record

    def changes_since(self, user_id: int, since: int, limit: int) -> list[SyncRecord]:
        stmt = select(SyncRecord).where(SyncRecord.user_id == user_id, SyncRecord.seq > since)
        return list(self.db.scalars(stmt.order_by(SyncRecord.seq).limit(limit)))

    def count(self, user_id: int) -> int:
        return int(self.db.scalar(select(func.count(SyncRecord.id)).where(SyncRecord.user_id == user_id)) or 0)
