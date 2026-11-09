"""v4.1.12：操作助手的改／刪帳目驗證、對話紀錄（history）會進到 AI 的訊息、問 AI 的提示詞不再把範圍限得太窄。"""
from __future__ import annotations

import json
from datetime import date

import pytest

from app.service import ai_providers, ai_tasks
from tests.conftest import Api
from tests.test_ai import SUMMARY, ai_env, usage_rows  # noqa: F401
from tests.test_ai_stream import read_events, stub_stream

TODAY = date(2026, 11, 9)
CATS, ACCS = ["午餐", "飲料"], ["錢包", "中國信託"]


def plan(steps: list[dict]) -> list[dict]:
    return ai_tasks.v_agent_plan({"summary": "x", "steps": steps}, CATS, ACCS, TODAY)["steps"]


def test_delete_and_edit_validation() -> None:
    ok = plan([
        {"tool": "delete_transaction", "args": {"match": {"keywords": ["午餐"], "date_start": "2026-11-08", "date_end": "2026-11-08", "latest": False}}},
        {"tool": "edit_transaction", "args": {"match": {"latest": True}, "set": {"amount": 180, "category": "飲料", "note": "拿鐵", "date": None}}},
    ])
    assert [s["tool"] for s in ok] == ["delete_transaction", "edit_transaction"]
    assert ok[0]["args"]["match"]["keywords"] == ["午餐"] and ok[0]["args"]["match"]["date_start"] == "2026-11-08"
    assert ok[1]["args"]["match"]["latest"] is True and ok[1]["args"]["set"] == {"amount": 180.0, "category": "飲料", "account": None, "note": "拿鐵", "date": None}


def test_delete_and_edit_reject_unsafe_or_empty() -> None:
    # 沒有任何條件不能刪（否則變成整本帳）；改的內容全空、分類不在名單、金額不合理都丟掉
    with pytest.raises(ValueError):
        plan([{"tool": "delete_transaction", "args": {"match": {}}}])
    with pytest.raises(ValueError):
        plan([{"tool": "edit_transaction", "args": {"match": {"latest": True}, "set": {}}}])
    with pytest.raises(ValueError):
        plan([{"tool": "edit_transaction", "args": {"match": {"latest": True}, "set": {"category": "不存在", "amount": -5}}}])
    bad_cat = plan([{"tool": "delete_transaction", "args": {"match": {"category": "不存在", "keywords": ["x"]}}}])
    assert bad_cat[0]["args"]["match"]["category"] is None  # 名單外的分類名稱不會傳到前端，只剩關鍵字條件


def test_prompts_allow_general_answers_and_explain_limits() -> None:
    assert "不要拒絕" in ai_tasks.ASK and "資料有限" in ai_tasks.ASK and "對話紀錄" in ai_tasks.ASK
    assert "盡量回答" in ai_tasks.CHAT and "對話紀錄" in ai_tasks.CHAT
    assert "edit_transaction" in ai_tasks.AGENT_PLAN and "delete_transaction" in ai_tasks.AGENT_PLAN


def test_history_reaches_the_model_and_is_bounded(api: Api, monkeypatch) -> None:  # noqa: ANN001
    seen: list[str] = []

    def gen(system, msg, max_tokens=0):  # noqa: ANN001, ANN202
        seen.append(msg)
        yield ("delta", '{"answer":"好的"}')
        yield ("done", ('{"answer":"好的"}', "p", "m"))

    monkeypatch.setattr(ai_providers, "stream_text", gen)
    api.register("alice")
    hist = [{"role": "user", "text": "這個月吃飯花多少"}, {"role": "ai", "text": "3,200 元"}]
    with api.c.stream("POST", "/api/ai/ask/stream", json={"question": "那上個月呢", "summary": SUMMARY, "history": hist}, headers=api._h()) as r:
        assert read_events(r)[-1][0] == "done"
    sent = json.loads(seen[0])
    assert sent["對話紀錄"] == [{"誰": "使用者", "說": "這個月吃飯花多少"}, {"誰": "助手", "說": "3,200 元"}]
    with api.c.stream("POST", "/api/ai/chat/stream", json={"question": "你好", "history": hist}, headers=api._h()) as r:
        assert read_events(r)[-1][0] == "done"
    assert "對話紀錄" in json.loads(seen[1])
    # 沒有 history 就不帶這個欄位；太長、太多、角色不對都被擋下
    with api.c.stream("POST", "/api/ai/chat/stream", json={"question": "嗨"}, headers=api._h()) as r:
        read_events(r)
    assert "對話紀錄" not in json.loads(seen[2])
    too_many = [{"role": "user", "text": "a"}] * 9
    assert api.c.post("/api/ai/chat", json={"question": "x", "history": too_many}, headers=api._h()).status_code == 422
    assert api.c.post("/api/ai/chat", json={"question": "x", "history": [{"role": "system", "text": "a"}]}, headers=api._h()).status_code == 422
    assert api.c.post("/api/ai/chat", json={"question": "x", "history": [{"role": "user", "text": "a" * 401}]}, headers=api._h()).status_code == 422
