"""Refresh Token 資料存取。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import update
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
