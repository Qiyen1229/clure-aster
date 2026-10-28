"""端對端加密設定與 Web Push：加密格式可被瀏覽器端解開、訂閱網址白名單、排程與到期發送。"""
from __future__ import annotations

import time

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core import webpush
from tests.conftest import Api

DEV = "device-aaaa-1111"


def test_e2ee_keys_roundtrip(api: Api) -> None:
    api.register("alice")
    assert api.get("/api/sync/keys").json() is None
    bad = api.c.put("/api/sync/keys", json={"enabled": True, "salt": "", "iterations": 1, "check": ""}, headers=api._h())
    assert bad.status_code == 422
    r = api.c.put("/api/sync/keys", json={"enabled": True, "salt": "c2FsdA", "iterations": 310000, "check": "abc"}, headers=api._h())
    assert r.status_code == 200 and r.json()["version"] == 1
    st = api.get("/api/sync/status").json()
    assert st["e2ee"]["salt"] == "c2FsdA" and st["e2ee"]["iterations"] == 310000
    api.c.put("/api/sync/keys", json={"enabled": False}, headers=api._h())
    assert api.get("/api/sync/status").json()["e2ee"] is None


def _decrypt(body: bytes, ua_priv: ec.EllipticCurvePrivateKey, auth: bytes) -> bytes:
    """瀏覽器端（RFC 8291）的解密，用來驗證伺服器加密正確。"""
    salt, idlen = body[:16], body[20]
    as_pub = body[21:21 + idlen]
    ct = body[21 + idlen:]
    ua_pub = ua_priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = ua_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    ikm = HKDF(hashes.SHA256(), 32, auth, b"WebPush: info\x00" + ua_pub + as_pub).derive(shared)
    cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    pt = AESGCM(cek).decrypt(nonce, ct, None)
    return pt.rstrip(b"\x00")[:-1]


def test_webpush_encryption_decrypts() -> None:
    ua = ec.generate_private_key(ec.SECP256R1())
    pub = ua.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = b"0123456789abcdef"
    body = webpush.encrypt('{"title":"記帳"}'.encode(), webpush.b64u(pub), webpush.b64u(auth))
    assert _decrypt(body, ua, auth).decode() == '{"title":"記帳"}'
    h = webpush.vapid_headers("https://fcm.googleapis.com/fcm/send/x", "mailto:a@b.c")
    assert h["Authorization"].startswith("vapid t=")


def _sub_body() -> dict:
    ua = ec.generate_private_key(ec.SECP256R1())
    pub = ua.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"device_id": DEV, "endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": webpush.b64u(pub), "auth": webpush.b64u(b"0123456789abcdef")}}


def test_push_subscribe_schedule_and_deliver(api: Api, monkeypatch) -> None:  # noqa: ANN001
    api.register("alice")
    evil = {**_sub_body(), "endpoint": "https://internal.example.com/x"}
    assert api.post("/api/push/subscribe", evil).status_code == 422
    assert api.post("/api/push/subscribe", _sub_body()).status_code == 200
    st = api.get("/api/push/status", params={"device_id": DEV}).json()
    assert st["subscribed"] is True and len(st["public_key"]) > 40

    now = int(time.time() * 1000)
    items = [{"id": "daily:1", "at": now - 1000, "title": "記帳", "body": "今天還沒記帳", "url": "/add"},
             {"id": "card:1", "at": now + 3600_000, "title": "繳款", "body": "", "url": "/"}]
    assert api.post("/api/push/schedule", {"device_id": DEV, "items": items}).status_code == 200

    sent: list[dict] = []
    monkeypatch.setattr(webpush, "send", lambda endpoint, p, a, msg, **kw: (sent.append(msg), webpush.SendResult(True, 201, False))[1])
    from app import db as dbmod
    from app.service.push_service import PushService

    for s in dbmod.session_scope():
        assert PushService(s).deliver_due() == 1
        assert PushService(s).deliver_due() == 0  # 不會重送
    assert sent[0]["title"] == "記帳"
    # 重新排程時，已送出的同一個提醒不會再排
    api.post("/api/push/schedule", {"device_id": DEV, "items": items})
    assert api.get("/api/push/status", params={"device_id": DEV}).json()["scheduled"] == 1

    # 失效的訂閱（410）會被刪除
    monkeypatch.setattr(webpush, "send", lambda *a, **kw: webpush.SendResult(False, 410, True))
    assert "已失效並移除" in api.post("/api/push/test").json()["message"]
    assert api.get("/api/push/status").json()["subscribed"] is False
    assert "沒有這個帳號的推播訂閱" in api.post("/api/push/test").json()["message"]


def test_transient_failure_is_retried_not_lost(api: Api, monkeypatch) -> None:  # noqa: ANN001
    import time

    from app.db import session_scope
    from app.service import push_service
    from app.service.push_service import PushService

    api.register("bob")
    api.post("/api/push/subscribe", _sub_body())
    api.post("/api/push/schedule", {"device_id": DEV, "items": [{"id": "daily:x", "at": int(time.time() * 1000) - 1000, "title": "t", "body": "b", "url": "/"}]})
    push_service._attempts.clear()
    # 推播服務暫時連不上：提醒要保留、下一輪再送
    monkeypatch.setattr(webpush, "send", lambda *a, **kw: webpush.SendResult(False, 0, False, "timeout", retry=True))
    for s in session_scope():
        assert PushService(s).deliver_due() == 0
    assert api.get("/api/push/status", params={"device_id": DEV}).json()["scheduled"] == 1
    monkeypatch.setattr(webpush, "send", lambda *a, **kw: webpush.SendResult(True, 201, False))
    for s in session_scope():
        assert PushService(s).deliver_due() == 1
    assert api.get("/api/push/status", params={"device_id": DEV}).json()["scheduled"] == 0
