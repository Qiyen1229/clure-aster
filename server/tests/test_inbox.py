"""收件匣：權杖建立／撤銷、捷徑送入（不需 CSRF）、列出與確認（不會重複刪）、權限隔離。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import Api


def _hook(token: str, body: dict, header: str = "bearer"):  # noqa: ANN202
    c = TestClient(app)  # 捷徑沒有 Cookie、也沒有 CSRF 標頭
    if header == "query":  # 匯入式捷徑：連結碼＝網址＋?t=權杖
        return c.post("/api/hook/inbox", params={"t": token}, json=body)
    h = {"Authorization": f"Bearer {token}"} if header == "bearer" else {"X-Aster-Token": token}
    return c.post("/api/hook/inbox", json=body, headers=h)


def test_token_create_list_revoke(api: Api) -> None:
    api.register("alice")
    r = api.post("/api/inbox/tokens", {"name": "我的 iPhone"})
    assert r.status_code == 201
    token = r.json()["token"]
    assert token.startswith("clr_") and r.json()["item"]["hint"] == token[-4:]
    listed = api.get("/api/inbox/tokens").json()
    assert len(listed) == 1 and "token" not in listed[0] and "token_hash" not in listed[0]
    assert api.c.delete(f"/api/inbox/tokens/{listed[0]['id']}", headers=api._h()).status_code == 200
    assert _hook(token, {"text": "午餐 120"}).status_code == 401


def test_hook_receive_list_and_ack(api: Api) -> None:
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    r = _hook(token, {"source": "Apple Pay", "amount": "NT$1,234.00", "merchant": "全聯福利中心", "card": "玉山 Pi 卡", "date": "2026/10/28 12:30"})
    assert r.status_code == 200 and r.json()["ok"]
    assert _hook(token, {"source": "簡訊", "text": "您的玉山卡消費 NT$560"}, header="x").status_code == 200
    assert _hook(token, {"amount": 99, "extra_field": "ignored"}, header="query").status_code == 200
    assert _hook(token, {"source": "siri"}).status_code == 422  # 沒有內容
    items = api.get("/api/inbox/items").json()
    assert [i["source"] for i in items] == ["other", "sms", "applepay"]
    assert items[2]["amount"] == "NT$1,234.00" and items[2]["card"] == "玉山 Pi 卡" and items[0]["amount"] == "99"
    ids = [i["id"] for i in items]
    assert api.post("/api/inbox/items/ack", {"ids": ids[:2]}).json()["ids"] == sorted(ids[:2])
    # 另一台裝置再確認同一筆：已經不在了，不會回傳（避免重複記帳）
    assert api.post("/api/inbox/items/ack", {"ids": ids[:2]}).json()["ids"] == []
    assert len(api.get("/api/inbox/items").json()) == 1


def test_hook_accepts_legacy_header(api: Api) -> None:
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    # 更名為 Aster 前設定的捷徑用 X-Clure-Token
    assert TestClient(app).post("/api/hook/inbox", json={"text": "午餐 1"}, headers={"X-Clure-Token": token}).status_code == 200


def test_hook_rejects_bad_token_and_isolates_users(admin_and_user) -> None:  # noqa: ANN001
    a, u = admin_and_user
    assert _hook("clr_wrong", {"text": "x 1"}).status_code == 401
    assert _hook("", {"text": "x 1"}).status_code == 401
    token = u.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    _hook(token, {"text": "午餐 120"})
    assert len(u.get("/api/inbox/items").json()) == 1
    assert a.get("/api/inbox/items").json() == []
    item_id = u.get("/api/inbox/items").json()[0]["id"]
    assert a.post("/api/inbox/items/ack", {"ids": [item_id]}).json()["ids"] == []
    tid = u.get("/api/inbox/tokens").json()[0]["id"]
    assert a.c.delete(f"/api/inbox/tokens/{tid}", headers=a._h()).status_code == 404


def test_inbox_requires_login() -> None:
    c = TestClient(app)
    assert c.get("/api/inbox/items").status_code == 401
    assert c.get("/api/inbox/tokens").status_code == 401
