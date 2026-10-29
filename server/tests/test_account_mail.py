"""忘記密碼（寄信＋一次性連結）、註冊信箱網域檢查、管理員建帳。"""
from __future__ import annotations

import re

import pytest

from app.core import mailer
from app.core.config import get_settings
from tests.conftest import PASSWORD, Api


@pytest.fixture
def outbox(monkeypatch) -> list[tuple[str, str, str]]:  # noqa: ANN001
    sent: list[tuple[str, str, str]] = []
    monkeypatch.setattr(mailer, "mail_configured", lambda: True)
    monkeypatch.setattr("app.service.auth_service.mail_configured", lambda: True)
    monkeypatch.setattr("app.service.auth_service.send_mail", lambda to, subject, body: sent.append((to, subject, body)))
    return sent


def _token(body: str) -> str:
    m = re.search(r"token=([\w-]+)", body)
    assert m
    return m.group(1)


def test_forgot_password_flow(admin_and_user, outbox) -> None:  # noqa: ANN001
    _, u = admin_and_user
    anon = Api("10.1.0.1")
    r = anon.post("/api/auth/forgot-password", {"identifier": "alice@example.com"})
    assert r.status_code == 200
    assert len(outbox) == 1 and outbox[0][0] == "alice@example.com"
    assert outbox[0][2].count("https://aster.test/reset-password?token=") == 1
    token = _token(outbox[0][2])
    # 帳號不存在：回一樣的訊息、不寄信
    r2 = anon.post("/api/auth/forgot-password", {"identifier": "nobody@example.com"})
    assert r2.status_code == 200 and r2.json() == r.json() and len(outbox) == 1
    # 設定新密碼：舊密碼失效、舊登入被登出、連結只能用一次
    assert anon.post("/api/auth/reset-password", {"token": token, "new_password": "Newpass99"}).status_code == 200
    assert Api("10.1.0.2").login("alice", PASSWORD).status_code == 401
    assert Api("10.1.0.3").login("alice", "Newpass99").status_code == 200
    assert u.get("/api/auth/me").status_code == 401
    assert anon.post("/api/auth/reset-password", {"token": token, "new_password": "Another123"}).status_code == 400


def test_new_reset_link_invalidates_old_and_bad_token(admin_and_user, outbox) -> None:  # noqa: ANN001
    anon = Api("10.1.1.1")
    anon.post("/api/auth/forgot-password", {"identifier": "alice"})
    anon.post("/api/auth/forgot-password", {"identifier": "alice"})
    assert len(outbox) == 2
    assert anon.post("/api/auth/reset-password", {"token": _token(outbox[0][2]), "new_password": "Newpass99"}).status_code == 400
    assert anon.post("/api/auth/reset-password", {"token": "x" * 40, "new_password": "Newpass99"}).status_code == 400
    assert anon.post("/api/auth/reset-password", {"token": _token(outbox[1][2]), "new_password": "weak"}).status_code == 422
    assert anon.post("/api/auth/reset-password", {"token": _token(outbox[1][2]), "new_password": "Newpass99"}).status_code == 200


def test_forgot_info_contact_admin_when_mail_off(api: Api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr("app.api.auth.mail_configured", lambda: False)
    r = api.get("/api/auth/forgot-info").json()
    assert r == {"mail": False, "contact": "giter003@gmail.com"}
    monkeypatch.setattr("app.api.auth.mail_configured", lambda: True)
    assert api.get("/api/auth/forgot-info").json()["mail"] is True


def test_forgot_password_rate_limited_and_requires_mail(admin_and_user, outbox, monkeypatch) -> None:  # noqa: ANN001
    anon = Api("10.1.2.1")
    codes = [anon.post("/api/auth/forgot-password", {"identifier": "alice"}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    monkeypatch.setattr("app.service.auth_service.mail_configured", lambda: False)
    assert Api("10.1.2.2").post("/api/auth/forgot-password", {"identifier": "someone-else"}).status_code == 503


def test_register_rejects_nonexistent_domain(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("CLURE_EMAIL_CHECK_DNS", "true")
    get_settings.cache_clear()
    try:
        from email_validator import EmailUndeliverableError

        def fake(email, **kw):  # noqa: ANN001, ANN003, ANN202
            if kw.get("check_deliverability") and email.endswith("@no-such-domain.com"):
                raise EmailUndeliverableError("The domain name no-such-domain.com does not exist.")
            from email_validator import validate_email as real
            return real(email, check_deliverability=False)
        monkeypatch.setattr("app.schema.auth.validate_email", fake)
        a = Api("10.1.3.1")
        r = a.register("carol", "carol@no-such-domain.com")
        assert r.status_code == 422 and "網域" in r.json()["detail"]
        assert a.register("carol", "carol@example.com").status_code == 201
    finally:
        monkeypatch.delenv("CLURE_EMAIL_CHECK_DNS")
        get_settings.cache_clear()


def test_admin_creates_account(admin_and_user) -> None:  # noqa: ANN001
    a, u = admin_and_user
    assert u.post("/api/admin/users", {"username": "bob", "email": "bob@example.com"}).status_code == 403
    r = a.post("/api/admin/users", {"username": "bob", "email": "Bob@Example.com"})
    assert r.status_code == 201
    body = r.json()
    assert body["user"]["email"] == "bob@example.com" and body["user"]["must_change_password"] is True and body["user"]["role"] == "user"
    temp = body["temporary_password"]
    assert temp
    me = Api("10.1.4.1")
    assert me.login("bob", temp).json()["must_change_password"] is True
    # 重複、指定密碼、指定管理員
    assert a.post("/api/admin/users", {"username": "BOB", "email": "x@example.com"}).status_code == 409
    assert a.post("/api/admin/users", {"username": "dave", "email": "bob@example.com"}).status_code == 409
    r = a.post("/api/admin/users", {"username": "dave", "email": "dave@example.com", "password": "Daveloves1", "role": "admin"})
    assert r.status_code == 201 and r.json()["temporary_password"] is None and r.json()["user"]["role"] == "admin"
    assert Api("10.1.4.2").login("dave", "Daveloves1").status_code == 200
    assert a.post("/api/admin/users", {"username": "eve", "email": "eve@example.com", "password": "short"}).status_code == 422
    logs = a.get("/api/admin/audit-logs").json()
    assert "Daveloves1" not in str(logs) and temp not in str(logs)


def test_admin_mail_status_and_test(admin_and_user, monkeypatch) -> None:  # noqa: ANN001
    a, _ = admin_and_user
    assert a.get("/api/admin/mail").json()["configured"] is False
    assert a.post("/api/admin/mail/test", {"to": "me@example.com"}).status_code == 502
    sent: list[str] = []
    monkeypatch.setattr("app.service.admin_service.send_mail", lambda to, s, b: sent.append(to))
    assert a.post("/api/admin/mail/test", {"to": "me@example.com"}).status_code == 200 and sent == ["me@example.com"]
