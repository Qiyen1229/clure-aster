"""認證流程：註冊、登入、Cookie、CSRF、頻率限制、鎖定、刷新輪替與重用偵測、登出、變更密碼。"""
from __future__ import annotations

import time

from app.core.security import decode_token
from tests.conftest import PASSWORD, Api


def test_register_sets_httponly_cookies_and_hides_hash(api: Api) -> None:
    r = api.register("bob")
    assert r.status_code == 201
    body = r.json()
    assert body["username"] == "bob" and body["role"] == "admin"  # 第一位使用者
    assert "password_hash" not in body and "password" not in body
    cookies = r.headers.get_list("set-cookie")
    access = next(c for c in cookies if c.startswith("clure_access="))
    refresh = next(c for c in cookies if c.startswith("clure_refresh="))
    assert "HttpOnly" in access and "Path=/api" in access and "samesite=lax" in access.lower()
    assert "HttpOnly" in refresh and "Path=/api/auth" in refresh
    assert api.get("/api/auth/me").json()["username"] == "bob"


def test_register_validation_and_duplicates(api: Api) -> None:
    assert api.register("x").status_code == 422  # 太短
    r = api.register("bob", password="password")  # 無數字
    assert r.status_code == 422 and "英文字母與數字" in r.json()["detail"]
    assert api.register("bob").status_code == 201
    r = Api("10.0.0.9").register("bob", email="other@example.com")
    assert r.status_code == 409 and r.json()["detail"] == "使用者名稱或 Email 已被使用"


def test_second_user_is_not_admin(admin_and_user) -> None:
    _, u = admin_and_user
    assert u.get("/api/auth/me").json()["role"] == "user"


def test_csrf_required_for_unsafe_methods(api: Api) -> None:
    r = api.c.post("/api/auth/login", json={"identifier": "a", "password": "b"})  # 沒帶標頭
    assert r.status_code == 403
    r = api.c.post("/api/auth/login", json={"identifier": "a", "password": "b"}, headers={"X-CSRF-Token": "wrong"})
    assert r.status_code == 403


def test_login_by_username_or_email_and_generic_error(api: Api) -> None:
    api.register("carol")
    fresh = Api("10.0.0.5")
    assert fresh.login("carol").status_code == 200
    assert fresh.login("CAROL@example.com").status_code == 200
    bad_user = fresh.login("nobody")
    bad_pw = fresh.login("carol", "Wrong1234")
    assert bad_user.status_code == bad_pw.status_code == 401
    assert bad_user.json()["detail"] == bad_pw.json()["detail"] == "帳號或密碼錯誤"  # 不洩漏帳號是否存在


def test_lockout_after_5_failures(api: Api) -> None:
    api.register("dave")
    attacker_ips = [f"10.1.0.{i}" for i in range(6)]  # 換 IP 也會被帳號鎖定擋下
    for ip in attacker_ips[:5]:
        assert Api(ip).login("dave", "Wrong1234").status_code == 401
    r = Api(attacker_ips[5]).login("dave", PASSWORD)  # 正確密碼也進不去
    assert r.status_code == 423 and "鎖定" in r.json()["detail"]


def test_rate_limit_5_per_minute(api: Api) -> None:
    api.register("erin")
    a = Api("10.2.0.1")
    codes = [a.login("erin", "Wrong1234").status_code for _ in range(6)]
    assert codes[-1] in (429, 423)
    r = a.login("someone-else", "Wrong1234")  # 同 IP 換帳號仍受 IP 總量限制保護
    assert r.status_code in (401, 429)


def test_refresh_rotation_and_reuse_detection(api: Api) -> None:
    api.register("frank")
    old_refresh = api.c.cookies.get("clure_refresh", path="/api/auth")
    r = api.post("/api/auth/refresh")
    assert r.status_code == 200
    new_refresh = api.c.cookies.get("clure_refresh", path="/api/auth")
    assert new_refresh and new_refresh != old_refresh
    # 攻擊者在寬限期後重用舊權杖 → 整條鏈撤銷
    from app import db as dbmod
    from app.model import RefreshToken
    from datetime import timedelta
    for s in dbmod.session_scope():
        jti = decode_token(old_refresh, "refresh")["jti"]
        row = s.get(RefreshToken, jti)
        row.revoked_at = row.revoked_at - timedelta(minutes=5)
        s.commit()
    thief = Api("10.9.9.9")
    thief.c.cookies.set("clure_refresh", old_refresh, path="/api/auth")
    assert thief.post("/api/auth/refresh").status_code == 401
    # 合法使用者的新權杖也一併失效
    assert api.post("/api/auth/refresh").status_code == 401


def test_logout_revokes_refresh(api: Api) -> None:
    api.register("gina")
    refresh = api.c.cookies.get("clure_refresh", path="/api/auth")
    assert api.post("/api/auth/logout").status_code == 200
    assert api.get("/api/auth/me").status_code == 401
    replay = Api("10.3.0.1")
    replay.c.cookies.set("clure_refresh", refresh, path="/api/auth")
    assert replay.post("/api/auth/refresh").status_code == 401


def test_change_password_logs_out_other_devices(api: Api) -> None:
    api.register("hank")
    other = Api("10.4.0.1")
    assert other.login("hank").status_code == 200
    r = api.post("/api/auth/change-password", {"current_password": "bad", "new_password": "NewPassw0rd"})
    assert r.status_code == 400
    r = api.post("/api/auth/change-password", {"current_password": PASSWORD, "new_password": "NewPassw0rd"})
    assert r.status_code == 200
    assert api.get("/api/auth/me").status_code == 200  # 目前裝置維持登入
    assert other.get("/api/auth/me").status_code == 401  # 其他裝置被登出
    assert Api("10.4.0.2").login("hank", "NewPassw0rd").status_code == 200


def test_access_token_is_short_lived() -> None:
    from app.core.config import get_settings
    from app.core.security import create_token
    tok, _, exp = create_token(user_id=1, role="user", token_version=0, token_type="access")
    payload = decode_token(tok, "access")
    assert payload and payload["exp"] - payload["iat"] == get_settings().access_token_minutes * 60
    assert decode_token(tok, "refresh") is None  # 類型不可混用
    assert time.time() < payload["exp"]


def test_validation_errors_are_chinese(api: Api) -> None:
    r = api.register("jack", email="not-an-email")
    assert r.status_code == 422 and r.json()["detail"] == "Email 格式不正確"
    r = api.post("/api/auth/register", {"username": "jack", "email": "j@example.com"})
    assert r.json()["detail"] == "請填寫密碼"
    r = api.post("/api/auth/register", {"username": "jack", "email": "j@example.com", "password": "Abcdefg1", "extra": 1})
    assert r.json()["detail"] == "包含不允許的欄位"
    r = api.post("/api/auth/register", {"username": "jack", "email": "j@example.com", "password": "Ab1"})
    assert r.json()["detail"] == "密碼至少需要 8 個字元"


def test_validation_error_never_echoes_password(api: Api) -> None:
    r = api.post("/api/auth/register", {"username": "ivan", "email": "bad", "password": "SuperSecret999"})
    assert r.status_code == 422
    assert "SuperSecret999" not in r.text


def test_proxy_auth_check(api: Api) -> None:
    # nginx auth_request：未登入 401、登入後 204
    assert api.get("/api/auth/check").status_code == 401
    r = api.register("carol")
    # 報價代理在 /proxy/：Access Token Cookie 必須是整個網站路徑，瀏覽器才會送到 /proxy/
    access = [h for h in r.headers.get_list("set-cookie") if h.startswith("clure_access=") and "Max-Age=0" not in h and 'max-age=0' not in h.lower()]
    assert access and "Path=/;" in access[0]
    # 同時清除 1.2.1 以前 Path=/api 的舊 Cookie
    assert any(h.startswith("clure_access=") and "Path=/api" in h and "max-age=0" in h.lower() for h in r.headers.get_list("set-cookie"))
    assert api.get("/api/auth/check").status_code == 204


def test_cf_connecting_ip_header_recognized() -> None:
    from unittest.mock import Mock
    from app.core.request_info import client_info

    req = Mock()
    req.client.host = "172.64.0.1"  # Cloudflare IP
    req.headers = {"cf-connecting-ip": "203.0.113.195", "user-agent": "test"}
    c = client_info(req)
    assert c.ip == "203.0.113.195"
