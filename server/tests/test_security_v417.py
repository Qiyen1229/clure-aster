"""v4.1.7：雙因素驗證（TOTP）、已登入的裝置、簽章 CSRF 與 Cookie 前綴。"""
from __future__ import annotations

import time

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import cli
from app import db as dbmod
from app.core import totp
from app.main import app
from app.model import User
from tests.conftest import PASSWORD, Api


def _set_csrf(api: Api, value: str) -> None:
    """換掉 CSRF Cookie（模擬攻擊者從子網域寫入）；沿用原本的網域，避免 httpx 產生兩個同名 Cookie。"""
    dom = next(c.domain for c in api.c.cookies.jar if c.name == "csrf_token")
    api.c.cookies.delete("csrf_token")
    api.c.cookies.set("csrf_token", value, domain=dom, path="/")


def _setup_totp(api: Api) -> tuple[str, list[str]]:
    secret = api.post("/api/auth/2fa/setup").json()["secret"]
    step = totp.current_step()
    r = api.post("/api/auth/2fa/enable", {"code": totp.code_at(secret, step)})
    assert r.status_code == 200, r.text
    return secret, r.json()["recovery_codes"]


# ── TOTP 本身（RFC 6238 附錄 B 的測試向量：SHA-1、密鑰 "12345678901234567890"） ──

def test_totp_rfc6238_vectors() -> None:
    import base64
    secret = base64.b32encode(b"12345678901234567890").decode()
    for t, expect in ((59, "287082"), (1111111109, "081804"), (1111111111, "050471"), (1234567890, "005924"), (2000000000, "279037")):
        assert totp.code_at(secret, t // 30) == expect
    assert totp.verify(secret, "287082", now=59) == 59 // 30
    assert totp.verify(secret, "287082", last_step=59 // 30, now=59) is None  # 同一個週期不能用兩次
    assert totp.verify(secret, "287082", now=59 + 300) is None  # 太舊
    assert totp.verify(secret, "28708", now=59) is None and totp.verify(secret, "abcdef", now=59) is None


# ── 開啟、登入、備援碼、關閉 ──

def test_enable_login_needs_code_and_recovery_code_is_single_use(api: Api) -> None:
    api.register("tina")
    assert api.get("/api/auth/2fa").json() == {"enabled": False, "recovery_left": 0}
    secret, codes = _setup_totp(api)
    assert api.get("/api/auth/2fa").json() == {"enabled": True, "recovery_left": 8}
    assert len(codes) == 8 and all(len(c) == 9 and c[4] == "-" for c in codes)
    for s in dbmod.session_scope():  # 密鑰是加密存的，資料庫裡看不到明文
        u = s.scalar(select(User).where(User.username == "tina"))
        assert u.totp_secret.startswith("v1.") and secret not in u.totp_secret and codes[0] not in u.totp_recovery

    other = Api("10.50.0.1")
    r = other.login("tina")  # 只有密碼
    assert r.status_code == 401 and r.headers.get("x-totp-required") == "1"
    assert other.get("/api/auth/me").status_code == 401  # 沒有登入
    r = other.c.post("/api/auth/login", json={"identifier": "tina", "password": PASSWORD, "totp": "000000"}, headers=other._h())
    assert r.status_code == 401 and "驗證碼" in r.json()["detail"]
    good = totp.code_at(secret, totp.current_step() + 1)  # 下一個週期的碼（在容許範圍內）
    r = other.c.post("/api/auth/login", json={"identifier": "tina", "password": PASSWORD, "totp": good}, headers=other._h())
    assert r.status_code == 200 and r.json()["totp_enabled"] is True
    # 同一個碼不能再登入第二次
    third = Api("10.50.0.2")
    r = third.c.post("/api/auth/login", json={"identifier": "tina", "password": PASSWORD, "totp": good}, headers=third._h())
    assert r.status_code == 401
    # 備援碼：用一次就作廢
    r = third.c.post("/api/auth/login", json={"identifier": "tina", "password": PASSWORD, "totp": codes[0].upper()}, headers=third._h())
    assert r.status_code == 200
    fourth = Api("10.50.0.3")
    r = fourth.c.post("/api/auth/login", json={"identifier": "tina", "password": PASSWORD, "totp": codes[0]}, headers=fourth._h())
    assert r.status_code == 401
    assert api.get("/api/auth/2fa").json()["recovery_left"] == 7


def test_wrong_codes_lock_the_account_and_disable_needs_password_and_code(api: Api) -> None:
    api.register("uma")
    secret, _ = _setup_totp(api)
    for i in range(5):  # 連續 5 次驗證碼錯誤也會鎖定帳號（不能繞過密碼鎖定去猜 6 位數）
        a = Api(f"10.51.0.{i + 1}")
        a.c.post("/api/auth/login", json={"identifier": "uma", "password": PASSWORD, "totp": "000000"}, headers=a._h())
    late = Api("10.51.1.1")
    r = late.c.post("/api/auth/login", json={"identifier": "uma", "password": PASSWORD, "totp": totp.code_at(secret, totp.current_step())}, headers=late._h())
    assert r.status_code == 423
    assert api.post("/api/auth/2fa/disable", {"password": "wrong-pass", "code": totp.code_at(secret, totp.current_step() + 1)}).status_code == 400
    assert api.post("/api/auth/2fa/disable", {"password": PASSWORD, "code": "123456"}).status_code == 400
    assert api.post("/api/auth/2fa/disable", {"password": PASSWORD, "code": totp.code_at(secret, totp.current_step() + 1)}).status_code == 200
    assert api.get("/api/auth/2fa").json()["enabled"] is False


def test_setup_requires_valid_first_code_and_cli_reset(api: Api) -> None:
    api.register("vera")
    assert api.post("/api/auth/2fa/enable", {"code": "123456"}).status_code == 409  # 還沒按「開始設定」
    api.post("/api/auth/2fa/setup")
    assert api.post("/api/auth/2fa/enable", {"code": "000000"}).status_code == 400
    assert api.get("/api/auth/2fa").json()["enabled"] is False  # 沒通過就不會啟用，不會把自己鎖在門外
    secret = None
    for s in dbmod.session_scope():
        from app.core import secretbox
        secret = secretbox.open_(s.scalar(select(User).where(User.username == "vera")).totp_secret)["s"]
    assert api.post("/api/auth/2fa/enable", {"code": totp.code_at(secret, totp.current_step())}).status_code == 200
    assert api.post("/api/auth/2fa/setup").status_code == 409  # 已啟用要先關閉
    assert Api("10.52.0.2").login("vera").status_code == 401
    assert cli.reset_2fa("vera") == 0
    assert Api("10.52.0.3").login("vera").status_code == 200
    assert cli.reset_2fa("nobody") == 1


# ── 已登入的裝置 ──

def test_sessions_list_and_remote_logout_is_immediate(api: Api) -> None:
    api.register("wendy")
    phone = Api("10.53.0.1")
    phone.c.headers["User-Agent"] = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)"
    assert phone.login("wendy").status_code == 200
    rows = api.get("/api/auth/sessions").json()
    assert len(rows) == 2 and [r["current"] for r in rows] == [True, False]
    assert rows[1]["ip"] == "10.53.0.1" and "iPhone" in rows[1]["user_agent"]
    assert phone.get("/api/auth/me").status_code == 200
    # 自己這一台不能用這個踢（要用登出）；踢別台後，那台的 Access Token 立刻失效（不用等 15 分鐘）
    assert api.c.delete(f"/api/auth/sessions/{rows[0]['id']}", headers=api._h()).status_code == 400
    assert api.c.delete(f"/api/auth/sessions/{rows[1]['id']}", headers=api._h()).status_code == 200
    assert phone.get("/api/auth/me").status_code == 401
    assert phone.post("/api/auth/refresh").status_code == 401
    assert len(api.get("/api/auth/sessions").json()) == 1
    # 別人的裝置踢不到
    eve = Api("10.53.0.9")
    eve.register("eve")
    assert eve.c.delete(f"/api/auth/sessions/{rows[0]['id']}", headers=eve._h()).status_code == 404
    assert api.get("/api/auth/me").status_code == 200


def test_sessions_require_login() -> None:
    c = TestClient(app)
    assert c.get("/api/auth/sessions").status_code == 401
    assert c.get("/api/auth/2fa").status_code == 401


# ── 簽章 CSRF 與 Cookie 前綴 ──

def test_csrf_is_signed_and_bound_to_the_user(api: Api) -> None:
    api.register("xavier")
    other = Api("10.54.0.1")
    other.register("yolanda")
    own = api.c.cookies.get("csrf_token")
    assert own and own.count(".") == 1
    # 1) 攻擊者（Cookie Tossing）自己編一個隨機值，Cookie 與標頭一致也不行
    _set_csrf(api, "attacker-chosen-random-string")
    r = api.c.post("/api/auth/change-password", json={"current_password": "x", "new_password": "NewPassw0rd"}, headers={"X-CSRF-Token": "attacker-chosen-random-string"})
    assert r.status_code == 403
    # 2) 拿自己帳號合法簽發的 Token 塞給受害者：簽章綁的是另一位使用者，也不行
    foreign = other.c.cookies.get("csrf_token")
    _set_csrf(api, foreign)
    r = api.c.post("/api/auth/change-password", json={"current_password": "x", "new_password": "NewPassw0rd"}, headers={"X-CSRF-Token": foreign})
    assert r.status_code == 403
    # 403 的回應會發一個綁定正確使用者的新 Token，前端重試就會過
    fresh = api.c.cookies.get("csrf_token")
    assert fresh not in (own, foreign)
    r = api.c.post("/api/auth/change-password", json={"current_password": "x", "new_password": "NewPassw0rd"}, headers={"X-CSRF-Token": fresh})
    assert r.status_code == 400  # 過了 CSRF，是密碼不對


def test_https_uses_host_and_secure_prefixes() -> None:
    c = TestClient(app, base_url="https://aster.test", headers={"X-Real-IP": "10.55.0.1", "User-Agent": "pytest"})
    r = c.get("/api/health")
    assert any(h.startswith("__Host-csrf_token=") and "Secure" in h and "Path=/" in h and "Domain" not in h for h in r.headers.get_list("set-cookie"))
    csrf = c.cookies.get("__Host-csrf_token")
    r = c.post("/api/auth/register", json={"username": "zed", "email": "zed@example.com", "password": PASSWORD}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 201
    cookies = r.headers.get_list("set-cookie")
    access = next(h for h in cookies if h.startswith("__Host-clure_access=") and "Max-Age=0" not in h)
    assert "Secure" in access and "HttpOnly" in access and "Path=/" in access and "Domain" not in access
    refresh = next(h for h in cookies if h.startswith("__Secure-clure_refresh=") and "Max-Age=0" not in h)
    assert "Secure" in refresh and "HttpOnly" in refresh and "Path=/api/auth" in refresh
    assert c.get("/api/auth/me").status_code == 200  # 新名稱的 Cookie 能正常登入
    # 登入後 CSRF Token 換成綁定這位使用者的
    csrf2 = c.cookies.get("__Host-csrf_token")
    assert csrf2 != csrf
    assert c.post("/api/auth/logout", headers={"X-CSRF-Token": csrf2}).status_code == 200


def test_legacy_cookie_names_still_refresh_once_then_migrate() -> None:
    """升級前（HTTPS、舊名稱）登入的人：Refresh Token 還在舊名稱的 Cookie，刷新時暫時接受，換發後改用新名稱。"""
    plain = TestClient(app, headers={"X-Real-IP": "10.56.0.1", "User-Agent": "pytest"})
    plain.get("/api/health")
    r = plain.post("/api/auth/register", json={"username": "olga", "email": "olga@example.com", "password": PASSWORD}, headers={"X-CSRF-Token": plain.cookies.get("csrf_token")})
    old_refresh = plain.cookies.get("clure_refresh", path="/api/auth")
    c = TestClient(app, base_url="https://aster.test", headers={"X-Real-IP": "10.56.0.2", "User-Agent": "pytest"})
    c.cookies.set("clure_refresh", old_refresh, path="/api/auth")
    c.get("/api/auth/me")  # 取得綁定該使用者的 CSRF（refresh 只送到 /api/auth）
    r = c.post("/api/auth/refresh", headers={"X-CSRF-Token": c.cookies.get("__Host-csrf_token")})
    assert r.status_code == 200
    assert any(h.startswith("__Secure-clure_refresh=") and "Max-Age=0" not in h for h in r.headers.get_list("set-cookie"))
    assert c.get("/api/auth/me").status_code == 200


def test_login_works_with_a_stale_refresh_cookie_left_in_the_browser() -> None:
    """被踢掉／登出的瀏覽器還留著舊的 Refresh Cookie：/api/health 發的是 anon Token、/api/auth/* 卻帶著舊 Refresh——登入不能卡在 CSRF。"""
    a = Api("10.60.0.1")
    a.register("kim")
    stale = a.c.cookies.get("clure_refresh", path="/api/auth")
    b = Api("10.60.0.2")  # 乾淨的瀏覽器：先逛過登入頁（/api/health 拿 anon Token）
    b.c.cookies.set("clure_refresh", stale, path="/api/auth")  # 只剩殘留的 Refresh（Access 已經過期被丟掉）
    assert b.login("kim").status_code == 200
    # 登入後 Token 換成綁定該使用者的，之後的請求都正常
    assert b.get("/api/auth/me").status_code == 200
    assert b.post("/api/auth/change-password", {"current_password": "x", "new_password": "NewPassw0rd"}).status_code == 400


def test_refresh_still_works_after_access_cookie_expired() -> None:
    a = Api("10.61.0.1")
    a.register("lena")
    a.c.cookies.delete("clure_access")  # Access Token 到期，瀏覽器丟掉了 Cookie
    assert a.get("/api/auth/me").status_code == 401
    assert a.post("/api/auth/refresh").status_code == 200  # 刷新帶的是登入時發的 Token，仍然過得了
    assert a.get("/api/auth/me").status_code == 200
