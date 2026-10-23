"""指令列工具：建立管理員、刪除使用者（保護最後一位管理員）、審計紀錄。"""
from __future__ import annotations

from sqlalchemy import select

from app import cli
from app import db as dbmod
from app.model import AuditLog, RefreshToken, User
from tests.conftest import Api


def _users() -> dict[str, User]:
    for s in dbmod.session_scope():
        return {u.username: u for u in s.scalars(select(User))}
    return {}


def test_create_admin_and_delete_old_admin(monkeypatch, admin_and_user) -> None:
    monkeypatch.setenv("CLURE_NEW_PASSWORD", "NewAdmin123")
    assert cli.create_admin("boss", "Boss@Example.com") == 0
    users = _users()
    assert users["boss"].role == "admin" and users["boss"].email == "boss@example.com"
    assert Api("10.20.0.1").login("boss", "NewAdmin123").status_code == 200
    assert cli.delete_user("admin") == 0
    assert "admin" not in _users()
    for s in dbmod.session_scope():
        assert s.scalar(select(RefreshToken).where(RefreshToken.user_id == users["admin"].id)) is None  # 權杖一併刪除
        actions = {a.action for a in s.scalars(select(AuditLog))}
        assert {"admin.cli_create_admin", "admin.cli_delete_user"} <= actions


def test_cannot_delete_last_admin(admin_and_user) -> None:
    assert cli.delete_user("admin") == 1
    assert "admin" in _users()


def test_create_admin_rejects_weak_password(monkeypatch) -> None:
    monkeypatch.setenv("CLURE_NEW_PASSWORD", "short")
    assert cli.create_admin("weak", "weak@example.com") == 1
    monkeypatch.setenv("CLURE_NEW_PASSWORD", "weakuser1")
    assert cli.create_admin("weakuser1", "w@example.com") == 1  # 與帳號相同
