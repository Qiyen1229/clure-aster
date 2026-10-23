"""使用者資料存取。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.model import ROLE_ADMIN, User


class UserRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, user_id: int) -> User | None:
        return self.db.get(User, user_id)

    def get_by_username(self, username: str) -> User | None:
        return self.db.scalar(select(User).where(func.lower(User.username) == username.lower()))

    def get_by_email(self, email: str) -> User | None:
        return self.db.scalar(select(User).where(User.email == email.lower()))

    def get_by_identifier(self, identifier: str) -> User | None:
        ident = identifier.strip()
        return self.get_by_email(ident) if "@" in ident else self.get_by_username(ident)

    def add(self, user: User) -> User:
        self.db.add(user)
        self.db.flush()
        return user

    def delete(self, user: User) -> None:
        """刪除使用者；其 refresh_tokens 由外鍵 ON DELETE CASCADE 一併刪除，審計日誌保留。"""
        self.db.delete(user)
        self.db.flush()

    def count(self) -> int:
        return self.db.scalar(select(func.count(User.id))) or 0

    def count_admins(self) -> int:
        return self.db.scalar(select(func.count(User.id)).where(User.role == ROLE_ADMIN)) or 0

    def search(self, *, q: str | None, status: str, role: str, now: datetime, page: int, size: int) -> tuple[list[User], int]:
        stmt = select(User)
        if q:
            like = f"%{q.lower()}%"
            stmt = stmt.where(or_(func.lower(User.username).like(like), User.email.like(like)))
        if status == "active":
            stmt = stmt.where(User.is_active.is_(True))
        elif status == "frozen":
            stmt = stmt.where(User.is_active.is_(False))
        elif status == "locked":
            stmt = stmt.where(User.locked_until.is_not(None), User.locked_until > now)
        if role in ("user", "admin"):
            stmt = stmt.where(User.role == role)
        total = self.db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = self.db.scalars(stmt.order_by(User.id.desc()).offset((page - 1) * size).limit(size)).all()
        return list(rows), total
