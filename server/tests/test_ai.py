"""AI 功能：供應商備援與冷卻、日／週／月額度與重置、失敗不扣額度、輸出驗證、管理員設定。"""
from __future__ import annotations

import json
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import get_settings
from app.core.security import utcnow
from app.db import session_scope
from app.model import AiUsage
from app.service import ai_providers, ai_quota
from tests.conftest import Api

BODY = {"text": "昨天午餐 150 刷玉山卡", "categories": ["午餐", "早餐"], "accounts": ["玉山卡", "現金"], "today": "2026-10-28"}
GOOD = {"entries": [{"type": "expense", "amount": 150, "note": "", "category": "午餐", "account": "玉山卡", "date": "2026-10-27"}]}


@pytest.fixture(autouse=True)
def ai_env(monkeypatch):  # noqa: ANN001, ANN201
    s = get_settings()
    monkeypatch.setattr(s, "ai_openrouter_api_key", "k1")
    monkeypatch.setattr(s, "ai_nvidia_api_key", "k2")
    monkeypatch.setattr(s, "ai_providers", "openrouter,nvidia")
    for k, v in (("ai_user_daily", 3), ("ai_user_weekly", 5), ("ai_user_monthly", 8), ("ai_global_daily", 0)):
        monkeypatch.setattr(s, k, v)
    ai_providers.reset_state()
    yield
    ai_providers.reset_state()


def fake(monkeypatch, behaviour):  # noqa: ANN001, ANN201
    """behaviour(provider_name, payload) → 回應 dict，或拋例外。回傳呼叫紀錄。"""
    calls: list[str] = []

    def post(p, payload, timeout):  # noqa: ANN001, ANN202
        calls.append(p.name)
        return behaviour(p.name, payload)

    monkeypatch.setattr(ai_providers, "_post", post)
    return calls


def ok(data) -> dict:  # noqa: ANN001
    return {"choices": [{"message": {"content": "```json\n" + json.dumps(data, ensure_ascii=False) + "\n```"}}]}


def usage_rows() -> list[AiUsage]:
    for db in session_scope():
        return list(db.query(AiUsage).all())
    return []


def test_requires_login(api: Api) -> None:
    assert api.get("/api/ai/status").status_code == 401
    assert api.post("/api/ai/parse-entry", BODY).status_code == 401


def test_parse_entry_success_and_validation(api: Api, monkeypatch) -> None:  # noqa: ANN001
    bad = {"entries": [
        {"type": "expense", "amount": 150, "category": "不存在的分類", "account": "玉山卡", "date": "1999-01-01", "note": "便當"},
        {"type": "expense", "amount": -5},
        {"type": "income", "amount": "1,200", "category": "早餐"},
        "garbage",
    ]}
    fake(monkeypatch, lambda n, p: ok(bad))
    api.register("alice")
    r = api.post("/api/ai/parse-entry", BODY)
    assert r.status_code == 200, r.text
    e = r.json()["entries"]
    assert len(e) == 2
    assert e[0]["category"] is None and e[0]["account"] == "玉山卡" and e[0]["date"] is None and e[0]["note"] == "便當"
    assert e[1]["type"] == "income" and e[1]["amount"] == 1200 and e[1]["category"] == "早餐"
    assert r.json()["quota"]["daily"]["used"] == 1 and r.json()["quota"]["daily"]["remaining"] == 2


def test_prompt_contains_only_names_and_text(api: Api, monkeypatch) -> None:  # noqa: ANN001
    seen: list[dict] = []
    fake(monkeypatch, lambda n, p: (seen.append(p), ok(GOOD))[1])
    api.register("alice")
    assert api.post("/api/ai/parse-entry", BODY).status_code == 200
    user_msg = json.loads(seen[0]["messages"][1]["content"])
    assert set(user_msg) == {"今天", "可選分類", "可選帳戶", "使用者文字"}


def test_fallback_to_next_provider(api: Api, monkeypatch) -> None:  # noqa: ANN001
    def beh(name, payload):  # noqa: ANN001, ANN202
        if name == "openrouter":
            raise urllib.error.HTTPError("u", 429, "rate", {}, None)  # type: ignore[arg-type]
        return ok(GOOD)

    calls = fake(monkeypatch, beh)
    api.register("alice")
    assert api.post("/api/ai/parse-entry", BODY).status_code == 200
    assert calls == ["openrouter", "nvidia"]
    assert usage_rows()[0].provider == "nvidia"


def test_circuit_breaker_skips_failing_provider(api: Api, monkeypatch) -> None:  # noqa: ANN001
    def beh(name, payload):  # noqa: ANN001, ANN202
        if name == "openrouter":
            raise TimeoutError()
        return ok(GOOD)

    calls = fake(monkeypatch, beh)
    api.register("alice")
    # 單日額度只有 3 次，改大一點才能連續呼叫
    monkeypatch.setattr(get_settings(), "ai_user_daily", 0)
    monkeypatch.setattr(get_settings(), "ai_user_weekly", 0)
    monkeypatch.setattr(get_settings(), "ai_user_monthly", 0)
    for _ in range(4):
        assert api.post("/api/ai/parse-entry", BODY).status_code == 200
    # 前 3 次 openrouter 失敗後進入冷卻，第 4 次直接跳過
    assert calls.count("openrouter") == 3 and ai_providers.cooling_down("openrouter")
    assert calls[-1] == "nvidia"


def test_all_providers_fail_does_not_charge(api: Api, monkeypatch) -> None:  # noqa: ANN001
    def beh(name, payload):  # noqa: ANN001, ANN202
        raise TimeoutError()

    fake(monkeypatch, beh)
    api.register("alice")
    r = api.post("/api/ai/parse-entry", BODY)
    assert r.status_code == 503 and usage_rows() == []
    assert api.get("/api/ai/status").json()["quota"]["daily"]["used"] == 0


def test_unparseable_output_does_not_charge(api: Api, monkeypatch) -> None:  # noqa: ANN001
    fake(monkeypatch, lambda n, p: ok({"entries": [{"amount": 0}]}))
    api.register("alice")
    assert api.post("/api/ai/parse-entry", BODY).status_code == 422
    assert usage_rows() == []


def test_not_configured(api: Api, monkeypatch) -> None:  # noqa: ANN001
    s = get_settings()
    monkeypatch.setattr(s, "ai_openrouter_api_key", "")
    monkeypatch.setattr(s, "ai_nvidia_api_key", "")
    api.register("alice")
    st = api.get("/api/ai/status").json()
    assert st["configured"] is False and st["available"] is False
    assert api.post("/api/ai/parse-entry", BODY).status_code == 503


def test_daily_quota_and_other_user_unaffected(api: Api, monkeypatch) -> None:  # noqa: ANN001
    fake(monkeypatch, lambda n, p: ok(GOOD))
    api.register("alice")
    for _ in range(3):
        assert api.post("/api/ai/parse-entry", BODY).status_code == 200
    r = api.post("/api/ai/parse-entry", BODY)
    assert r.status_code == 429 and "今日" in r.json()["detail"]
    assert len(usage_rows()) == 3  # 被拒絕的預留不會留下紀錄
    bob = Api("10.0.0.9")
    bob.register("bob")
    assert bob.post("/api/ai/parse-entry", BODY).status_code == 200


def _backdate(rows_to_shift: int, to: datetime) -> None:
    for db in session_scope():
        for r in db.query(AiUsage).order_by(AiUsage.id).limit(rows_to_shift):
            r.created_at = to


def test_windows_reset(api: Api, monkeypatch) -> None:  # noqa: ANN001
    """日額度用完後，把紀錄移到昨天 → 當天額度恢復，但週額度仍累計。"""
    fake(monkeypatch, lambda n, p: ok(GOOD))
    api.register("alice")
    for _ in range(3):
        assert api.post("/api/ai/parse-entry", BODY).status_code == 200
    assert api.post("/api/ai/parse-entry", BODY).status_code == 429
    b = ai_quota.window_bounds()
    _backdate(3, b["daily"][0] - timedelta(hours=1))
    if b["weekly"][0] > b["daily"][0] - timedelta(hours=1):  # 今天是週一：昨天已在上一週
        pytest.skip("週一時昨天屬於上一週，無法驗證「日重置但週累計」")
    st = api.get("/api/ai/status").json()["quota"]
    assert st["daily"]["used"] == 0 and st["weekly"]["used"] == 3
    # 週限額 5：再用 2 次後被週額度擋下，訊息指出「本週」
    assert api.post("/api/ai/parse-entry", BODY).status_code == 200
    assert api.post("/api/ai/parse-entry", BODY).status_code == 200
    r = api.post("/api/ai/parse-entry", BODY)
    assert r.status_code == 429 and "本週" in r.json()["detail"]


def test_window_bounds_taipei() -> None:
    # 2026-10-28（週三）10:00 台北 = 02:00 UTC
    b = ai_quota.window_bounds(datetime(2026, 10, 28, 2, 0))
    assert b["daily"] == (datetime(2026, 10, 27, 16, 0), datetime(2026, 10, 28, 16, 0))
    assert b["weekly"] == (datetime(2026, 10, 25, 16, 0), datetime(2026, 11, 1, 16, 0))  # 週一 10/26 00:00 台北
    assert b["monthly"] == (datetime(2026, 9, 30, 16, 0), datetime(2026, 10, 31, 16, 0))
    dec = ai_quota.window_bounds(datetime(2026, 12, 31, 20, 0))  # 台北已是 2027-01-01
    assert dec["monthly"] == (datetime(2026, 12, 31, 16, 0), datetime(2027, 1, 31, 16, 0))


def test_global_daily_cap(api: Api, monkeypatch) -> None:  # noqa: ANN001
    fake(monkeypatch, lambda n, p: ok(GOOD))
    s = get_settings()
    monkeypatch.setattr(s, "ai_global_daily", 2)
    api.register("alice")
    bob = Api("10.0.0.9")
    bob.register("bob")
    assert api.post("/api/ai/parse-entry", BODY).status_code == 200
    assert bob.post("/api/ai/parse-entry", BODY).status_code == 200
    r = api.post("/api/ai/parse-entry", BODY)
    assert r.status_code == 429 and "全站" in r.json()["detail"]
    st = api.get("/api/ai/status").json()
    assert st["available"] is False


def test_admin_settings(admin_and_user, monkeypatch) -> None:  # noqa: ANN001
    admin, user = admin_and_user
    fake(monkeypatch, lambda n, p: ok(GOOD))
    assert user.get("/api/admin/ai").status_code == 403
    a = admin.get("/api/admin/ai").json()
    assert a["user_daily"] == 3 and a["overridden"] is False
    assert [p["name"] for p in a["providers"]] == ["openrouter", "nvidia"] and all(p["configured"] for p in a["providers"])
    # 調高每日額度
    r = admin.patch("/api/admin/ai", {"user_daily": 10, "user_weekly": 20, "user_monthly": 50})
    assert r.status_code == 200 and r.json()["user_daily"] == 10 and r.json()["overridden"] is True
    for _ in range(4):
        assert user.post("/api/ai/parse-entry", BODY).status_code == 200
    assert admin.get("/api/admin/ai").json()["used_today"] == 4
    # 關閉 AI
    assert admin.patch("/api/admin/ai", {"enabled": False}).json()["enabled"] is False
    assert user.post("/api/ai/parse-entry", BODY).status_code == 503
    assert user.get("/api/ai/status").json()["available"] is False
    assert admin.patch("/api/admin/ai", {"user_daily": -1}).status_code == 422


def test_text_validation(api: Api, monkeypatch) -> None:  # noqa: ANN001
    fake(monkeypatch, lambda n, p: ok(GOOD))
    api.register("alice")
    assert api.post("/api/ai/parse-entry", {**BODY, "text": ""}).status_code == 422
    assert api.post("/api/ai/parse-entry", {**BODY, "text": "x" * 301}).status_code == 422
    assert api.post("/api/ai/parse-entry", {**BODY, "today": "昨天"}).status_code == 422


def test_extract_json_tolerates_noise() -> None:
    assert ai_providers.extract_json('好的：\n```json\n{"entries": []}\n```') == {"entries": []}
    assert ai_providers.extract_json('[{"amount": 1}]') == [{"amount": 1}]
    with pytest.raises(ValueError):
        ai_providers.extract_json("沒有 json")


def test_console_requires_admin_and_shows_everything(admin_and_user, monkeypatch) -> None:  # noqa: ANN001
    admin, user = admin_and_user

    def beh(name, payload):  # noqa: ANN001, ANN202
        if name == "openrouter":
            raise urllib.error.HTTPError("u", 401, "x", {}, None)  # type: ignore[arg-type]
        return ok(GOOD)

    fake(monkeypatch, beh)
    assert user.get("/api/admin/ai/console").status_code == 403
    assert user.post("/api/admin/ai/test", {"provider": "nvidia"}).status_code == 403
    for _ in range(2):
        assert user.post("/api/ai/parse-entry", BODY).status_code == 200
    c = admin.get("/api/admin/ai/console").json()
    assert c["totals"] == {"today": 2, "week": 2, "month": 2}
    assert c["by_user"][0]["username"] == "alice" and c["by_user"][0]["today"] == 2
    assert len(c["recent"]) == 2 and c["recent"][0]["provider"] == "nvidia" and c["recent"][0]["username"] == "alice"
    assert len(c["daily"]) == 7 and c["daily"][-1]["count"] == 2
    p = {x["name"]: x for x in c["providers"]}
    assert p["openrouter"]["fail"] == 2 and "401" in p["openrouter"]["last_error"] and "Key" in p["openrouter"]["last_error"]
    assert p["nvidia"]["ok"] == 2 and p["nvidia"]["last_latency_ms"] is not None
    assert p["openrouter"]["key_hint"] == "••••" and p["openrouter"]["base_host"] == "openrouter.ai"
    assert "k1" not in json.dumps(c)  # Key 不會出現在回應中
    assert c["settings"]["user_daily"] == 3 and c["timezone"] == "Asia/Taipei"


def test_key_hint_masks_all_but_last4(admin_and_user, monkeypatch) -> None:  # noqa: ANN001
    admin, _ = admin_and_user
    monkeypatch.setattr(get_settings(), "ai_nvidia_api_key", "nvapi-SECRETSECRET-wxyz")
    c = admin.get("/api/admin/ai/console").json()
    nv = next(x for x in c["providers"] if x["name"] == "nvidia")
    assert nv["key_hint"] == "••••wxyz" and "SECRET" not in json.dumps(c)


def test_provider_connection_test(admin_and_user, monkeypatch) -> None:  # noqa: ANN001
    admin, user = admin_and_user
    state = {"fail": True}

    def beh(name, payload):  # noqa: ANN001, ANN202
        assert payload["max_tokens"] == 8  # 測試請求要夠小
        if state["fail"]:
            raise urllib.error.HTTPError("u", 429, "x", {}, None)  # type: ignore[arg-type]
        return {"choices": [{"message": {"content": "OK"}}]}

    fake(monkeypatch, beh)
    r = admin.post("/api/admin/ai/test", {"provider": "openrouter"}).json()
    assert r["ok"] is False and "429" in r["detail"] and r["latency_ms"] is None
    state["fail"] = False
    r = admin.post("/api/admin/ai/test", {"provider": "openrouter"}).json()
    assert r["ok"] is True and r["latency_ms"] is not None
    assert admin.post("/api/admin/ai/test", {"provider": "nope"}).status_code == 404
    # 測試不扣任何使用者額度
    assert usage_rows() == []
    logs = admin.get("/api/admin/audit-logs", params={"action": "admin.ai_test"}).json()["items"]
    assert [l["success"] for l in logs] == [True, False]


def test_connection_test_clears_cooldown(admin_and_user, monkeypatch) -> None:  # noqa: ANN001
    admin, _ = admin_and_user
    for _ in range(3):
        ai_providers._record("openrouter", False, error="x")
    assert ai_providers.cooling_down("openrouter")
    fake(monkeypatch, lambda n, p: {"choices": [{"message": {"content": "OK"}}]})
    assert admin.post("/api/admin/ai/test", {"provider": "openrouter"}).json()["ok"] is True
    assert not ai_providers.cooling_down("openrouter")


def test_unconfigured_provider_test(admin_and_user, monkeypatch) -> None:  # noqa: ANN001
    admin, _ = admin_and_user
    monkeypatch.setattr(get_settings(), "ai_nvidia_api_key", "")
    r = admin.post("/api/admin/ai/test", {"provider": "nvidia"}).json()
    assert r["ok"] is False and "尚未設定" in r["detail"]


def test_describe_error() -> None:
    d = ai_providers.describe_error
    assert "Key" in d(urllib.error.HTTPError("u", 401, "x", {}, None))  # type: ignore[arg-type]
    assert "MODEL" in d(urllib.error.HTTPError("u", 404, "x", {}, None))  # type: ignore[arg-type]
    assert "供應商伺服器" in d(urllib.error.HTTPError("u", 503, "x", {}, None))  # type: ignore[arg-type]
    assert "逾時" in d(TimeoutError())
    assert "無法連線" in d(urllib.error.URLError("dns"))
    assert "格式" in d(ValueError())
