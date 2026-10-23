"""管理後台：權限、使用者管理、凍結、強制登出、重設密碼、審計日誌、統計。"""
from __future__ import annotations

from tests.conftest import PASSWORD, Api


def test_non_admin_forbidden(admin_and_user) -> None:
    _, u = admin_and_user
    for url in ("/api/admin/users", "/api/admin/stats", "/api/admin/audit-logs"):
        assert u.get(url).status_code == 403
    assert Api("10.8.0.1").get("/api/admin/users").status_code == 401


def test_user_list_search_and_no_hash(admin_and_user) -> None:
    a, _ = admin_and_user
    r = a.get("/api/admin/users", params={"q": "ali"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1 and body["items"][0]["username"] == "alice"
    assert "password_hash" not in body["items"][0]


def test_freeze_blocks_existing_session_and_login(admin_and_user) -> None:
    a, u = admin_and_user
    uid = u.get("/api/auth/me").json()["id"]
    r = a.patch(f"/api/admin/users/{uid}/status", {"is_active": False, "reason": "可疑活動"})
    assert r.status_code == 200 and r.json()["is_active"] is False
    assert u.get("/api/auth/me").status_code == 401  # 立即失效
    assert u.post("/api/auth/refresh").status_code == 401
    r = Api("10.6.0.1").login("alice")
    assert r.status_code == 403 and "停用" in r.json()["detail"]
    assert a.patch(f"/api/admin/users/{uid}/status", {"is_active": True}).status_code == 200
    assert Api("10.6.0.2").login("alice").status_code == 200


def test_cannot_freeze_self(admin_and_user) -> None:
    a, _ = admin_and_user
    me = a.get("/api/auth/me").json()["id"]
    assert a.patch(f"/api/admin/users/{me}/status", {"is_active": False}).status_code == 400


def test_force_logout(admin_and_user) -> None:
    a, u = admin_and_user
    uid = u.get("/api/auth/me").json()["id"]
    assert a.post(f"/api/admin/users/{uid}/force-logout").status_code == 200
    assert u.get("/api/auth/me").status_code == 401
    assert u.post("/api/auth/refresh").status_code == 401


def test_reset_password_requires_change(admin_and_user) -> None:
    a, u = admin_and_user
    uid = u.get("/api/auth/me").json()["id"]
    r = a.post(f"/api/admin/users/{uid}/reset-password")
    temp = r.json()["temporary_password"]
    assert r.status_code == 200 and len(temp) >= 12
    assert u.get("/api/auth/me").status_code == 401
    assert Api("10.7.0.1").login("alice", PASSWORD).status_code == 401
    fresh = Api("10.7.0.2")
    r = fresh.login("alice", temp)
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    r = fresh.post("/api/auth/change-password", {"current_password": temp, "new_password": "Brand0New!"})
    assert r.status_code == 200 and r.json()["must_change_password"] is False
    # 審計日誌不得包含臨時密碼
    logs = a.get("/api/admin/audit-logs", params={"action": "admin.password_reset"}).text
    assert temp not in logs


def test_audit_logs_capture_security_events(admin_and_user) -> None:
    a, u = admin_and_user
    Api("10.5.5.5").login("alice", "Wrong1234")
    uid = u.get("/api/auth/me").json()["id"]
    a.patch(f"/api/admin/users/{uid}/status", {"is_active": False})
    r = a.get("/api/admin/audit-logs")
    actions = [(x["action"], x["success"]) for x in r.json()["items"]]
    assert ("auth.register", True) in actions
    assert ("auth.login", False) in actions
    assert ("admin.user_freeze", True) in actions
    failed = next(x for x in r.json()["items"] if x["action"] == "auth.login" and not x["success"])
    assert failed["ip"] == "10.5.5.5" and failed["user_agent"] == "pytest" and failed["username"] == "alice"
    only_failed = a.get("/api/admin/audit-logs", params={"success": "false"}).json()
    assert all(not x["success"] for x in only_failed["items"])


def test_stats(admin_and_user) -> None:
    a, _ = admin_and_user
    Api("10.5.5.6").login("alice", "Wrong1234")
    s = a.get("/api/admin/stats").json()
    assert s["total_users"] == 2 and s["admins"] == 1 and s["active_today"] == 2
    assert s["failed_logins_today"] == 1 and s["db_size_bytes"] > 0 and s["db_engine"].startswith("SQLite")


def test_sync_enabled(admin_and_user) -> None:
    _, u = admin_and_user
    assert u.get("/api/sync/status").json()["enabled"] is True
    assert u.post("/api/sync/push", {"device_id": "device-0001", "changes": []}).status_code == 200
