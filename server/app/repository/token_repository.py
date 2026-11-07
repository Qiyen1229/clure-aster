"""Refresh Token 資料存取。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.model import RefreshToken


class TokenRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, token: RefreshToken) -> RefreshToken:
        self.db.add(token)
        self.db.flush()
        return token

    def get(self, jti: str) -> RefreshToken | None:
        return self.db.get(RefreshToken, jti)

    def revoke_family(self, family_id: str, now: datetime) -> None:
        self.db.execute(update(RefreshToken).where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))

    def revoke_all_for_user(self, user_id: int, now: datetime) -> None:
        self.db.execute(update(RefreshToken).where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))

    # ───── 已登入的裝置 ─────
    def family_active(self, family_id: str, now: datetime) -> bool:
        """這條權杖鏈（一台裝置）還有沒撤銷、沒過期的 Refresh Token。"""
        return self.db.scalar(select(RefreshToken.id).where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > now).limit(1)) is not None

    def active_for_user(self, user_id: int, now: datetime) -> list[RefreshToken]:
        return list(self.db.scalars(select(RefreshToken).where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > now)
                                    .order_by(RefreshToken.created_at.desc())).all())

    def family_started(self, family_id: str) -> datetime | None:
        return self.db.scalar(select(func.min(RefreshToken.created_at)).where(RefreshToken.family_id == family_id))

    def family_owned_by(self, family_id: str, user_id: int) -> bool:
        return self.db.scalar(select(RefreshToken.id).where(RefreshToken.family_id == family_id, RefreshToken.user_id == user_id).limit(1)) is not None
