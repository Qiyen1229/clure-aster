"""對外通知：設定驗證與 SSRF 防護、機密加密存放、各平台的請求格式、事件轉送與過濾、權限隔離、排程提醒轉送。"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import select, text

from app import db as dbmod
from app.core import outgoing, secretbox
from app.core.outgoing import ConfigError, Notice
from app.model import NotifyChannel, PushSchedule
from app.service.notify_service import app_link, schedule_notice
from tests.conftest import Api

DISCORD = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL0123456789abcdefghijklmnopqrstuv"
TG = {"token": "123456789:AAH_fake-token-0123456789abcdefghijkl", "chat_id": "-1001234567890"}
LINE = {"token": "x" * 60 + "+/=", "to": "U" + "0123456789abcdef" * 2}


class Sent:
    """攔截對外請求，不真的連網。"""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, status: int = 200, text_: str = "{}") -> None:
        self.calls: list[tuple[str, dict, dict]] = []
        self.status, self.text = status, text_
        monkeypatch.setattr(outgoing, "_post_json", self._post)
        monkeypatch.setattr(outgoing, "check_public_url", lambda *a, **k: None)  # 測試環境不做 DNS

    def _post(self, url: str, body: dict, headers: dict | None = None, timeout: int = 8) -> tuple[int, str]:
        self.calls.append((url, body, headers or {}))
        return self.status, self.text


@pytest.fixture
def alice(api: Api) -> Api:
    assert api.register("alice").status_code == 201
    return api


def _create(api: Api, kind: str = "discord", config: dict | None = None, **kw):  # noqa: ANN202
    cfg = config or ({"url": DISCORD} if kind == "discord" else TG if kind == "telegram" else LINE if kind == "line" else {"url": "https://hooks.example.com/x"})
    return api.post("/api/notify/channels", {"kind": kind, "config": cfg, **kw})


# ───────────── 設定驗證 ─────────────
def test_validate_config_each_kind() -> None:
    assert outgoing.validate_config("discord", {"url": DISCORD}) == {"url": DISCORD}
    with pytest.raises(ConfigError):
        outgoing.validate_config("discord", {"url": "https://evil.example.com/api/webhooks/1/2"})
    with pytest.raises(ConfigError):
        outgoing.validate_config("discord", {"url": DISCORD.replace("https", "http")})
    assert outgoing.validate_config("telegram", TG) == TG
    with pytest.raises(ConfigError):
        outgoing.validate_config("telegram", {**TG, "token": "bad"})
    with pytest.raises(ConfigError):
        outgoing.validate_config("telegram", {**TG, "chat_id": "abc"})
    assert outgoing.validate_config("telegram", {**TG, "chat_id": "@my_channel"})["chat_id"] == "@my_channel"
    assert outgoing.validate_config("line", LINE) == LINE
    with pytest.raises(ConfigError):
        outgoing.validate_config("line", {**LINE, "to": "nope"})
    with pytest.raises(ConfigError):
        outgoing.validate_config("nope", {})


@pytest.mark.parametrize("url", [
    "http://example.com/hook",                # 不是 https
    "https://user:pw@example.com/hook",       # 帶帳密
    "https://example.com:8443/hook",          # 非 443 埠
    "https://127.0.0.1/hook",                 # 本機
    "https://localhost/hook",
    "https://169.254.169.254/latest/meta-data",  # 雲端中繼資料
    "https://10.0.0.5/hook",                  # 內網
    "https://192.168.1.10/hook",
    "https://[::1]/hook",
    "ftp://example.com/x",
])
def test_ssrf_guard_blocks_unsafe_targets(url: str) -> None:
    with pytest.raises(ConfigError):
        outgoing.check_public_url(url, allow_private=False)


def test_allow_private_relaxes_for_lan_services() -> None:
    outgoing.check_public_url("http://127.0.0.1:5678/webhook/x", allow_private=True)  # 自架 n8n
    with pytest.raises(ConfigError):
        outgoing.check_public_url("ftp://127.0.0.1/x", allow_private=True)


# ───────────── 機密加密與 API ─────────────
def test_secretbox_roundtrip_and_tamper() -> None:
    sealed = secretbox.seal({"url": "https://x", "中文": "值"})
    assert "https://x" not in sealed
    assert secretbox.open_(sealed) == {"url": "https://x", "中文": "值"}
    with pytest.raises(Exception):  # noqa: B017, PT011
        secretbox.open_(sealed[:-3] + "AAA")


def test_create_masks_secret_and_stores_encrypted(alice: Api) -> None:
    r = _create(alice, "telegram", name="家人群組")
    assert r.status_code == 201, r.text
    j = r.json()
    assert j["name"] == "家人群組" and j["hint"].startswith("Bot 123456789") and set(j["events"]) == {"anomaly", "budget", "weekly", "monthly", "prize"}
    assert TG["token"] not in r.text and "secret" not in j
    assert TG["token"] not in json.dumps(alice.get("/api/notify/channels").json())
    for db in dbmod.session_scope():
        raw = db.scalar(select(NotifyChannel.secret))
        assert raw and TG["token"] not in raw and raw.startswith("v1.")
        assert TG["token"] not in str(db.execute(text("SELECT * FROM notify_channels")).all())


def test_create_rejects_bad_config_and_limits(alice: Api) -> None:
    assert _create(alice, "discord", {"url": "https://evil.com/x"}).status_code == 422
    assert alice.post("/api/notify/channels", {"kind": "sms", "config": {}}).status_code == 422
    from app.model import User
    for db in dbmod.session_scope():
        uid = db.scalar(select(User.id))
        for i in range(10):
            db.add(NotifyChannel(user_id=uid, kind="discord", name=f"c{i}", secret=secretbox.seal({"url": DISCORD}), events="budget"))
    assert _create(alice).status_code == 413  # 最多 10 個


def test_create_is_rate_limited(alice: Api) -> None:
    codes = [_create(alice).status_code for _ in range(9)]
    assert 429 in codes


def test_update_toggle_events_and_replace_secret(alice: Api) -> None:
    cid = _create(alice).json()["id"]
    r = alice.patch(f"/api/notify/channels/{cid}", {"enabled": False, "events": ["weekly", "bogus"], "name": "  我的 Discord "})
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["events"] == ["weekly"] and r.json()["name"] == "我的 Discord"
    new = DISCORD[:-4] + "zzzz"
    assert alice.patch(f"/api/notify/channels/{cid}", {"config": {"url": new}}).json()["hint"] == "…" + new[-6:]
    assert alice.patch(f"/api/notify/channels/{cid}", {"config": {"url": "https://bad.example.com"}}).status_code == 422
    assert alice.c.delete(f"/api/notify/channels/{cid}", headers=alice._h()).status_code == 200
    assert alice.get("/api/notify/channels").json() == []


def test_users_are_isolated(admin_and_user: tuple[Api, Api]) -> None:
    admin, alice = admin_and_user
    cid = _create(alice).json()["id"]
    assert admin.get("/api/notify/channels").json() == []
    assert admin.patch(f"/api/notify/channels/{cid}", {"enabled": False}).status_code == 404
    assert admin.c.delete(f"/api/notify/channels/{cid}", headers=admin._h()).status_code == 404
    assert admin.post(f"/api/notify/channels/{cid}/test").status_code == 404


def test_requires_login(api: Api) -> None:
    assert api.get("/api/notify/channels").status_code == 401
    assert api.post("/api/notify/event", {"event": "budget", "title": "x"}).status_code == 401


# ───────────── 各平台的請求格式 ─────────────
N = Notice(event="budget", title="預算快超支了", body="餐飲已用 92%", level="warn", url="https://aster.test/plan", fields=[("已用", "$9,200"), ("預算", "$10,000")])


def test_discord_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Sent(monkeypatch, 204, "")
    assert outgoing.send("discord", {"url": DISCORD}, N).ok
    url, body, _ = s.calls[0]
    assert url.startswith(DISCORD)
    e = body["embeds"][0]
    assert e["title"] == "預算快超支了" and e["color"] == outgoing.LEVEL_COLOR["warn"] and e["url"] == "https://aster.test/plan"
    assert e["fields"][0] == {"name": "已用", "value": "$9,200", "inline": True}


def test_telegram_payload_escapes_html(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Sent(monkeypatch)
    n = Notice(event="anomaly", title="<b>注入</b> & 測試", body="a<b", level="alert")
    assert outgoing.send("telegram", TG, n).ok
    url, body, _ = s.calls[0]
    assert url == f"https://api.telegram.org/bot{TG['token']}/sendMessage"
    assert "&lt;b&gt;注入&lt;/b&gt; &amp; 測試" in body["text"] and "a&lt;b" in body["text"]
    assert body["parse_mode"] == "HTML" and body["chat_id"] == TG["chat_id"]


def test_line_flex_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Sent(monkeypatch)
    assert outgoing.send("line", LINE, N).ok
    url, body, headers = s.calls[0]
    assert url == "https://api.line.me/v2/bot/message/push" and headers["Authorization"] == f"Bearer {LINE['token']}"
    msg = body["messages"][0]
    assert msg["type"] == "flex" and msg["contents"]["header"]["contents"][0]["text"] == "預算快超支了"
    assert msg["contents"]["footer"]["contents"][0]["action"]["uri"] == "https://aster.test/plan"


def test_webhook_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Sent(monkeypatch)
    assert outgoing.send("webhook", {"url": "https://hooks.example.com/x", "secret": "s3cret"}, N).ok
    _, body, headers = s.calls[0]
    assert body["event"] == "budget" and body["fields"][0] == {"name": "已用", "value": "$9,200"}
    import hashlib
    import hmac
    expect = hmac.new(b"s3cret", json.dumps(body, ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
    assert headers["X-Aster-Signature"] == f"sha256={expect}"


@pytest.mark.parametrize(("status", "needle"), [(401, "權杖"), (404, "找不到"), (429, "限流"), (500, "HTTP 500")])
def test_error_messages_never_leak_token(monkeypatch: pytest.MonkeyPatch, status: int, needle: str) -> None:
    Sent(monkeypatch, status, json.dumps({"description": f"bad token {TG['token']} here"}))
    r = outgoing.send("telegram", TG, N)
    assert not r.ok and needle in r.detail and TG["token"] not in r.detail and "***" in r.detail


def test_network_failure_is_reported_not_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.error

    def boom(*a, **k):  # noqa: ANN002, ANN003, ANN202
        raise urllib.error.URLError(f"cannot reach {TG['token']}")
    monkeypatch.setattr(outgoing, "_post_json", boom)
    r = outgoing.send("telegram", TG, N)
    assert not r.ok and "連線失敗" in r.detail and TG["token"] not in r.detail


# ───────────── 事件轉送 ─────────────
def test_event_fans_out_only_to_matching_enabled_channels(alice: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    s = Sent(monkeypatch)
    only_weekly = _create(alice, "discord", events=["weekly"]).json()["id"]
    both = _create(alice, "telegram", events=["budget", "weekly"]).json()["id"]
    off = _create(alice, "line", events=["budget"]).json()["id"]
    alice.patch(f"/api/notify/channels/{off}", {"enabled": False})
    r = alice.post("/api/notify/event", {"event": "budget", "title": "預算快超支了", "body": "餐飲 92%", "level": "warn", "path": "/plan", "fields": [["已用", "$9,200"]]})
    assert r.status_code == 200 and r.json() == {"channels": 1, "sent": 1, "failed": []}
    assert len(s.calls) == 1 and "api.telegram.org" in s.calls[0][0]
    assert "https://aster.test/plan" in s.calls[0][1]["text"]  # CLURE_PUBLIC_URL 組出可點的連結
    chans = {c["id"]: c for c in alice.get("/api/notify/channels").json()}
    assert chans[both]["last_ok_at"] and chans[only_weekly]["last_ok_at"] is None


def test_failed_channel_records_error_and_does_not_block_others(alice: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def post(url: str, body: dict, headers: dict | None = None, timeout: int = 8) -> tuple[int, str]:
        calls.append(url)
        return (404, "{}") if "discord" in url else (200, "{}")
    monkeypatch.setattr(outgoing, "_post_json", post)
    monkeypatch.setattr(outgoing, "check_public_url", lambda *a, **k: None)
    _create(alice, "discord", events=["anomaly"])
    _create(alice, "telegram", events=["anomaly"])
    r = alice.post("/api/notify/event", {"event": "anomaly", "title": "x"}).json()
    assert r["channels"] == 2 and r["sent"] == 1 and len(r["failed"]) == 1 and "找不到" in r["failed"][0]
    errs = [c["last_error"] for c in alice.get("/api/notify/channels").json()]
    assert any("找不到" in e for e in errs) and "" in errs


def test_event_validation_and_rate_limit(alice: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    Sent(monkeypatch)
    assert alice.post("/api/notify/event", {"event": "nope", "title": "x"}).status_code == 422
    assert alice.post("/api/notify/event", {"event": "budget", "title": ""}).status_code == 422
    assert alice.post("/api/notify/event", {"event": "budget", "title": "x", "level": "weird"}).status_code == 200  # level 會被修正為 info
    codes = [alice.post("/api/notify/event", {"event": "budget", "title": "x"}).status_code for _ in range(25)]
    assert 429 in codes


def test_test_endpoint(alice: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    s = Sent(monkeypatch)
    cid = _create(alice, "discord", events=[]).json()["id"]  # 沒勾任何類型也能測試
    r = alice.post(f"/api/notify/channels/{cid}/test")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert s.calls[0][1]["embeds"][0]["title"].startswith("Aster 測試通知")


# ───────────── 排程提醒轉送 ─────────────
def test_schedule_notice_event_mapping() -> None:
    assert schedule_notice("weekly:2026-11-02", "t", "b", "/reports").event == "weekly"
    assert schedule_notice("monthly:2026-11-01", "t", "b", "/").event == "monthly"
    assert schedule_notice("card:abc:2026-11-05", "t", "b", "/").event == "reminder"
    assert schedule_notice("daily:2026-11-01", "t", "b", "/").event == "daily"
    assert schedule_notice("unknown:1", "t", "b", "/").event == "reminder"


def test_app_link_only_for_in_app_paths() -> None:
    assert app_link("/plan?tab=wish") == "https://aster.test/plan?tab=wish"
    assert app_link("https://evil.com") == "" and app_link("//evil.com") == "" and app_link("") == ""


def test_due_push_items_also_go_to_channels(alice: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.service.push_service import PushService
    s = Sent(monkeypatch)
    _create(alice, "telegram", events=["weekly"])
    for db in dbmod.session_scope():
        from app.model import User
        uid = db.scalar(select(User.id))
        db.add(PushSchedule(user_id=uid, device_id="dev12345", item_id="weekly:2026-11-02", at=1, title="📊 上週摘要出爐", body="看看", url="/reports/summary?unit=week"))
        db.add(PushSchedule(user_id=uid, device_id="dev12345", item_id="card:x:2026-11-05", at=1, title="💳 繳款", body="", url="/accounts"))
    for db in dbmod.session_scope():
        PushService(db).deliver_due(now_ms=2)
    assert len(s.calls) == 1 and "上週摘要出爐" in s.calls[0][1]["text"]  # card 屬於 reminder，這個通道沒勾，所以只收到週報


def test_same_key_is_forwarded_only_once(alice: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    s = Sent(monkeypatch)
    _create(alice, "discord", events=["anomaly"])
    body = {"event": "anomaly", "title": "x", "key": "insight:abc"}
    assert alice.post("/api/notify/event", body).json()["sent"] == 1
    assert alice.post("/api/notify/event", body).json() == {"channels": 0, "sent": 0, "failed": []}  # 另一台裝置偵測到同一件事
    assert alice.post("/api/notify/event", {**body, "key": "insight:other"}).json()["sent"] == 1
    assert len(s.calls) == 2
