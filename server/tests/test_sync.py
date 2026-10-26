"""跨裝置同步：上傳、下載、最後寫入者勝、使用者隔離、驗證。"""
from __future__ import annotations

from tests.conftest import Api

DEV_A = "device-aaaa-1111"
DEV_B = "device-bbbb-2222"


def change(key: str, at: int, **payload) -> dict:  # noqa: ANN003
    return {"table": "transactions", "key": f'"{key}"', "updated_at": at, "deleted": False, "payload": {"id": key, **payload}}


def push(api: Api, device: str, changes: list[dict]):  # noqa: ANN201
    return api.post("/api/sync/push", {"device_id": device, "changes": changes})


def pull(api: Api, since: int = 0, device: str | None = None):  # noqa: ANN201
    params = {"since": since, **({"device_id": device} if device else {})}
    return api.get("/api/sync/pull", params=params)


def test_requires_login_and_csrf() -> None:
    anon = Api("10.9.0.1")
    assert anon.get("/api/sync/pull").status_code == 401
    u = Api("10.9.0.2")
    u.register("bob")
    r = u.c.post("/api/sync/push", json={"device_id": DEV_A, "changes": []})  # 沒帶 CSRF 標頭
    assert r.status_code == 403


def test_push_then_pull_from_other_device(api: Api) -> None:
    api.register("alice")
    r = push(api, DEV_A, [change("t1", 1000, note="早餐"), change("t2", 1000, note="午餐")])
    assert r.status_code == 200 and r.json()["accepted"] == 2 and r.json()["cursor"] == 2
    # 另一台裝置從頭下載
    body = pull(api, 0, DEV_B).json()
    assert {c["payload"]["note"] for c in body["changes"]} == {"早餐", "午餐"}
    assert body["cursor"] == 2 and body["has_more"] is False
    # 同一台裝置不會收到自己的變更，但游標仍會前進
    own = pull(api, 0, DEV_A).json()
    assert own["changes"] == [] and own["cursor"] == 2
    # 游標之後沒有新變更
    assert pull(api, 2, DEV_B).json()["changes"] == []


def test_last_writer_wins(api: Api) -> None:
    api.register("alice")
    push(api, DEV_A, [change("t1", 2000, note="新")])
    r = push(api, DEV_B, [change("t1", 1500, note="舊")]).json()
    assert r["accepted"] == 0 and r["rejected"][0]["payload"]["note"] == "新"
    # 時間相同：保留伺服器既有版本
    r = push(api, DEV_B, [change("t1", 2000, note="同時")]).json()
    assert r["accepted"] == 0
    r = push(api, DEV_B, [change("t1", 2500, note="更新")]).json()
    assert r["accepted"] == 1
    assert pull(api, 0, DEV_A).json()["changes"][0]["payload"]["note"] == "更新"


def test_delete_propagates(api: Api) -> None:
    api.register("alice")
    push(api, DEV_A, [change("t1", 1000, note="x")])
    r = push(api, DEV_A, [{"table": "transactions", "key": '"t1"', "updated_at": 1100, "deleted": True, "payload": None}])
    assert r.json()["accepted"] == 1
    c = pull(api, 0, DEV_B).json()["changes"][0]
    assert c["deleted"] is True and c["payload"] is None


def test_users_are_isolated() -> None:
    a = Api("10.9.1.1")
    a.register("alice")
    push(a, DEV_A, [change("t1", 1000, note="alice 的帳")])
    b = Api("10.9.1.2")
    b.register("bob")
    assert pull(b, 0, DEV_B).json()["changes"] == []
    # 相同主鍵也互不影響
    push(b, DEV_B, [change("t1", 900, note="bob 的帳")])
    assert pull(a, 0, DEV_B).json()["changes"][0]["payload"]["note"] == "alice 的帳"


def test_validation(api: Api) -> None:
    api.register("alice")
    bad_table = {"table": "users", "key": '"1"', "updated_at": 1, "payload": {"id": 1}}
    assert push(api, DEV_A, [bad_table]).status_code == 422
    assert push(api, "x", []).status_code == 422  # 裝置代碼格式
    no_payload = {"table": "tags", "key": '"1"', "updated_at": 1, "deleted": False, "payload": None}
    assert push(api, DEV_A, [no_payload]).status_code == 422
    big = change("t1", 1, note="x" * 300_000)
    assert push(api, DEV_A, [big]).status_code == 413


def test_pagination(api: Api) -> None:
    api.register("alice")
    push(api, DEV_A, [change(f"t{i}", 1000 + i) for i in range(30)])
    r = api.get("/api/sync/pull", params={"since": 0, "limit": 20, "device_id": DEV_B}).json()
    assert len(r["changes"]) == 20 and r["has_more"] is True
    r2 = api.get("/api/sync/pull", params={"since": r["cursor"], "limit": 20, "device_id": DEV_B}).json()
    assert len(r2["changes"]) == 10 and r2["has_more"] is False
    st = api.get("/api/sync/status").json()
    assert st["enabled"] is True and st["records"] == 30 and st["cursor"] == 30


def test_deleting_user_removes_sync_data(api: Api) -> None:
    api.register("alice")
    push(api, DEV_A, [change("t1", 1000)])
    from app.db import session_scope
    from app.model import SyncRecord, User
    from sqlalchemy import func, select
    for db in session_scope():
        db.delete(db.scalars(select(User)).first())
        db.flush()
        assert db.scalar(select(func.count(SyncRecord.id))) == 0


def test_status_reports_server_time_and_clamps_future_clock(api: Api) -> None:
    import time

    api.register("alice")
    st = api.get("/api/sync/status").json()
    assert abs(st["server_time"] - int(time.time() * 1000)) < 60_000
    far = int(time.time() * 1000) + 10 * 365 * 86400 * 1000  # 裝置時鐘快了 10 年
    push(api, DEV_A, [change("t1", far, note="快")])
    rec = pull(api, 0, DEV_B).json()["changes"][0]
    assert rec["updated_at"] < far - 86400 * 1000
    # 時鐘正常的另一台裝置之後的修改仍然可以覆蓋
    r = push(api, DEV_B, [change("t1", int(time.time() * 1000) + 1000, note="正常")]).json()
    assert r["accepted"] == 1


def test_tombstone_purge_requires_reset(api: Api) -> None:
    from datetime import timedelta

    from app import db as dbmod
    from app.core.security import utcnow
    from app.model import SyncRecord, User
    from app.service.sync_service import SyncService

    api.register("alice")
    push(api, DEV_A, [change("t1", 1000, note="a"), change("t2", 1000, note="b")])
    push(api, DEV_A, [{"table": "transactions", "key": '"t1"', "updated_at": 2000, "deleted": True, "payload": None}])
    for s in dbmod.session_scope():
        for r in s.query(SyncRecord).filter(SyncRecord.deleted.is_(True)):
            r.server_updated_at = utcnow() - timedelta(days=200)
        s.flush()
        user = s.query(User).one()
        assert SyncService(s).purge_if_due(user, force=True) == 1
    # 游標早於清除點的裝置 → reset；從頭（since=0）或已看過的裝置正常
    assert pull(api, 1, DEV_B).json()["reset"] is True
    full = pull(api, 0, DEV_B).json()
    assert full["reset"] is False and [c["key"] for c in full["changes"]] == ['"t2"']
    assert pull(api, 3, DEV_B).json()["reset"] is False
