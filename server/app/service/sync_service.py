"""跨裝置同步業務邏輯：最後寫入者勝（以前端變更時間 updated_at 判斷）。

- 上傳：每筆依 (使用者, 資料表, 主鍵) upsert；只有比伺服器版本「更新」的才採用，
  其餘回傳伺服器版本讓前端覆蓋（時間相同時以伺服器既有版本為準，讓先同步的裝置優先）。
- 下載：依使用者遞增序號 seq 取回之後的變更，略過同一台裝置自己上傳的版本。
"""
from __future__ import annotations

import json
import logging

from sqlalchemy.orm import Session

from app.model import SyncRecord, User
from app.repository.sync_repository import SyncRepository
from app.schema.sync import SYNC_TABLES, SyncChange, SyncPullResponse, SyncPushResponse, SyncStatus
from app.service.errors import ServiceError

log = logging.getLogger("clure.sync")

MAX_PAYLOAD_BYTES = 256 * 1024
MAX_RECORDS_PER_USER = 500_000
PROTOCOL_VERSION = 2


def _to_change(r: SyncRecord) -> SyncChange:
    return SyncChange(
        table=r.table_name, key=r.record_key, updated_at=r.updated_at, deleted=r.deleted,
        payload=json.loads(r.payload) if r.payload and not r.deleted else None,
    )


class SyncService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = SyncRepository(db)

    def status(self, user: User) -> SyncStatus:
        return SyncStatus(
            enabled=True, protocol_version=PROTOCOL_VERSION, message="已啟用跨裝置同步",
            records=self.repo.count(user.id), cursor=self.repo.last_seq(user.id),
        )

    def push(self, user: User, device_id: str, changes: list[SyncChange]) -> SyncPushResponse:
        if not changes:
            return SyncPushResponse(accepted=0, rejected=[], cursor=self.repo.last_seq(user.id))
        encoded: list[tuple[SyncChange, str | None]] = []
        for c in changes:
            if c.table not in SYNC_TABLES:
                raise ServiceError(422, f"不支援同步的資料表：{c.table}")
            if not c.deleted and c.payload is None:
                raise ServiceError(422, "缺少資料內容")
            body = None if c.deleted else json.dumps(c.payload, ensure_ascii=False, separators=(",", ":"))
            if body is not None and len(body.encode()) > MAX_PAYLOAD_BYTES:
                raise ServiceError(413, "單筆資料過大")
            encoded.append((c, body))

        existing = self.repo.get_many(user.id, [(c.table, c.key) for c, _ in encoded])
        new_count = sum(1 for c, _ in encoded if (c.table, c.key) not in existing)
        if new_count and self.repo.count(user.id) + new_count > MAX_RECORDS_PER_USER:
            raise ServiceError(413, "同步資料筆數已達上限")

        # 先決定哪些要寫入（同一批內同一筆出現多次時，以較新的為準）
        winners: dict[tuple[str, str], tuple[SyncChange, str | None]] = {}
        rejected: dict[tuple[str, str], SyncRecord] = {}
        for c, body in encoded:
            k = (c.table, c.key)
            cur = winners.get(k)
            if cur and cur[0].updated_at >= c.updated_at:
                continue
            rec = existing.get(k)
            if rec is not None and rec.updated_at >= c.updated_at:
                rejected[k] = rec
                continue
            winners[k] = (c, body)
            rejected.pop(k, None)

        last = self.repo.reserve_seq(user.id, len(winners)) if winners else self.repo.last_seq(user.id)
        seq = last - len(winners)
        for k, (c, body) in winners.items():
            seq += 1
            rec = existing.get(k)
            if rec is None:
                rec = self.repo.add(SyncRecord(user_id=user.id, table_name=c.table, record_key=c.key, updated_at=c.updated_at,
                                               deleted=c.deleted, payload=body, seq=seq, device_id=device_id))
            else:
                rec.updated_at = c.updated_at
                rec.deleted = c.deleted
                rec.payload = body
                rec.seq = seq
                rec.device_id = device_id
        self.db.flush()
        if winners:
            log.info("同步上傳 user_id=%s 採用=%s 略過=%s", user.id, len(winners), len(rejected))
        return SyncPushResponse(accepted=len(winners), rejected=[_to_change(r) for r in rejected.values()], cursor=last)

    def pull(self, user: User, since: int, limit: int, device_id: str | None) -> SyncPullResponse:
        rows = self.repo.changes_since(user.id, since, limit)
        cursor = int(rows[-1].seq) if rows else max(since, 0)
        # 自己上傳的版本本機已有，不必再下載
        changes = [_to_change(r) for r in rows if not device_id or r.device_id != device_id]
        return SyncPullResponse(changes=changes, cursor=cursor, has_more=len(rows) == limit)
