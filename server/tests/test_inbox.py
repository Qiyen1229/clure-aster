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


# ── v4.1.4：Email 轉寄收帳單（方案 A） ──

def _mail(sender: str = "玉山銀行 <service@esunbank.com.tw>", subject: str = "10 月信用卡電子帳單", body: str = "您本期應繳金額 NT$12,345", attach: bool = True) -> bytes:
    from email.message import EmailMessage

    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = sender, "u1@mail.example.com", subject
    m.set_content(body)
    if attach:
        m.add_attachment("日期,說明,金額\n2026/10/05,全聯,350\n".encode("utf-8"), maintype="text", subtype="csv", filename="statement.csv")
        m.add_attachment(b"%PDF-1.4 fake", maintype="application", subtype="pdf", filename="帳單.pdf")
        m.add_attachment(b"MZ\x90\x00", maintype="application", subtype="x-msdownload", filename="virus.exe")  # 不收
    return m.as_bytes()


def _post_mail(token: str, raw: bytes, **kw):  # noqa: ANN202
    c = TestClient(app)
    return c.post("/api/hook/mail", content=raw, headers={"Authorization": f"Bearer {token}", "Content-Type": "message/rfc822"}, **kw)


def test_mail_forward_creates_item_with_attachments_and_ack_deletes_them(api: Api) -> None:
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "Email 轉寄"}).json()["token"]
    r = _post_mail(token, _mail())
    assert r.status_code == 200 and r.json()["ok"] and "2 個附件" in r.json()["message"]
    items = api.get("/api/inbox/items").json()
    assert len(items) == 1 and items[0]["source"] == "email" and items[0]["merchant"] == "玉山銀行"
    assert "10 月信用卡電子帳單" in items[0]["text"] and "NT$12,345" in items[0]["text"] and "virus.exe" in items[0]["text"]  # 被略過的附件有註明
    atts = items[0]["attachments"]
    assert [a["filename"] for a in atts] == ["statement.csv", "帳單.pdf"] and atts[0]["size"] > 0
    dl = api.c.get(f"/api/inbox/attachments/{atts[0]['id']}", headers=api._h())
    assert dl.status_code == 200 and "全聯" in dl.content.decode() and dl.headers["x-content-type-options"] == "nosniff" and dl.headers["content-disposition"] == "attachment"
    assert api.post("/api/inbox/items/ack", {"ids": [items[0]["id"]]}).json()["ids"] == [items[0]["id"]]
    assert api.c.get(f"/api/inbox/attachments/{atts[0]['id']}", headers=api._h()).status_code == 404  # 附件隨項目刪除


def test_mail_attachments_are_private_to_the_owner(api: Api) -> None:
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "Email"}).json()["token"]
    _post_mail(token, _mail())
    att_id = api.get("/api/inbox/items").json()[0]["attachments"][0]["id"]
    api.register("bob")
    assert api.c.get(f"/api/inbox/attachments/{att_id}", headers=api._h()).status_code == 404


def test_mail_sender_allowlist_skips_others_without_error(api: Api) -> None:
    api.register("alice")
    created = api.post("/api/inbox/tokens", {"name": "Email"}).json()
    token, tid = created["token"], created["item"]["id"]
    patched = api.c.patch(f"/api/inbox/tokens/{tid}", json={"allow_from": "@esunbank.com.tw, cathaybk.com.tw"}, headers=api._h())
    assert patched.status_code == 200 and patched.json()["allow_from"] == "esunbank.com.tw, cathaybk.com.tw"
    ok = _post_mail(token, _mail(sender="e-bill@mail.esunbank.com.tw", attach=False))  # 子網域也算
    assert ok.json()["ok"] is True
    spam = _post_mail(token, _mail(sender="promo@spam.example", subject="中獎了", attach=False))
    assert spam.status_code == 200 and spam.json()["ok"] is False
    assert len(api.get("/api/inbox/items").json()) == 1


def test_mail_json_html_only_and_limits(api: Api) -> None:
    import base64

    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "Email"}).json()["token"]
    c = TestClient(app)
    body = {"from": "a@bank.tw", "subject": "消費通知", "html": "<p>您於 <b>全家</b> 消費 NT$85</p><script>x()</script>",
            "attachments": [{"filename": "s.png", "content_type": "image/png", "content_base64": base64.b64encode(b"\x89PNG....").decode()}]}
    r = c.post("/api/hook/mail", json=body, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.json()["ok"]
    item = api.get("/api/inbox/items").json()[0]
    assert "全家" in item["text"] and "x()" not in item["text"] and "<b>" not in item["text"] and item["attachments"][0]["filename"] == "s.png"
    assert c.post("/api/hook/mail", content=b"", headers={"Authorization": f"Bearer {token}", "Content-Type": "message/rfc822"}).status_code == 422  # 空信
    assert c.post("/api/hook/mail", content=b"x", headers={"Authorization": "Bearer clr_wrong", "Content-Type": "message/rfc822"}).status_code == 401
    big = b"A" * (11 * 1024 * 1024)
    assert c.post("/api/hook/mail", content=big, headers={"Authorization": f"Bearer {token}", "Content-Type": "message/rfc822"}).status_code == 413
