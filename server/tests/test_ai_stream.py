"""問 AI 的串流版（SSE）：供應商串流解析與備援、逐字事件、額度（成功才扣，失敗與中斷會還回去）。"""
from __future__ import annotations

import io
import json

import pytest

from app.service import ai_providers
from app.service.errors import ServiceError
from tests.conftest import Api
from tests.test_ai import SUMMARY, ai_env, usage_rows  # noqa: F401 — ai_env 是 autouse fixture（設定假的供應商與額度）


def sse_lines(chunks: list[str], *, done: bool = True) -> io.BytesIO:
    """模擬供應商的 SSE 回應：每個片段一行 data:。"""
    lines = [f"data: {json.dumps({'choices': [{'delta': {'content': c}}]}, ensure_ascii=False)}\n\n" for c in chunks]
    if done:
        lines.append("data: [DONE]\n\n")
    return io.BytesIO("".join(lines).encode())


class FakeResp(io.BytesIO):
    def __enter__(self):  # noqa: ANN204
        return self

    def __exit__(self, *a):  # noqa: ANN002, ANN204
        return False


def test_provider_stream_parsing_and_failover(monkeypatch) -> None:  # noqa: ANN001
    import urllib.error
    calls: list[str] = []

    def urlopen(req, timeout=0):  # noqa: ANN001, ANN202
        host = req.full_url
        calls.append(host)
        body = json.loads(req.data)
        assert body["stream"] is True
        if "openrouter" in host:
            raise urllib.error.URLError("boom")  # 第一家在開始輸出前就失敗 → 換下一家
        return FakeResp(sse_lines(['{"answer":"你', '好","followups":[]}']).getvalue())

    monkeypatch.setattr(ai_providers.urllib.request, "urlopen", urlopen)
    events = list(ai_providers.stream_text("sys", "usr", max_tokens=50))
    assert [e[0] for e in events] == ["delta", "delta", "done"]
    full, provider, model = events[-1][1]
    assert full == '{"answer":"你好","followups":[]}' and model == "nv-model" and provider == "nvidia"
    assert len(calls) == 2


def test_provider_stream_interrupted_midway_does_not_switch_provider(monkeypatch) -> None:  # noqa: ANN001
    class Broken(io.BytesIO):
        def __iter__(self):  # noqa: ANN204
            yield 'data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"半"}}]}\n'.encode()
            raise TimeoutError("read timed out")

        def __enter__(self):  # noqa: ANN204
            return self

        def __exit__(self, *a):  # noqa: ANN002, ANN204
            return False

    monkeypatch.setattr(ai_providers.urllib.request, "urlopen", lambda req, timeout=0: Broken())
    gen = ai_providers.stream_text("s", "u")
    assert next(gen)[0] == "delta"
    with pytest.raises(ValueError):  # 已經輸出一部分：不換供應商（避免兩段回答接在一起）
        next(gen)


def read_events(resp) -> list[tuple[str, dict]]:  # noqa: ANN001
    out, ev = [], ""
    for line in resp.iter_lines():
        if line.startswith("event:"):
            ev = line[6:].strip()
        elif line.startswith("data:"):
            out.append((ev, json.loads(line[5:])))
    return out


def stub_stream(monkeypatch, pieces, *, fail_after: int | None = None, error: Exception | None = None):  # noqa: ANN001, ANN201
    def gen(system, user, *, max_tokens=800, images=None):  # noqa: ANN001, ANN202
        buf = ""
        for i, p in enumerate(pieces):
            if fail_after is not None and i >= fail_after:
                raise error or ValueError("stream interrupted")
            buf += p
            yield ("delta", p)
        yield ("done", (buf, "stub", "stub-model"))
    monkeypatch.setattr(ai_providers, "stream_text", gen)


def test_ask_stream_emits_text_progressively_then_done(api: Api, monkeypatch) -> None:  # noqa: ANN001
    pieces = ['{"answer":"近三', '個月平均 ', '3 萬。","follo', 'wups":["要建預算嗎？"]}']
    stub_stream(monkeypatch, pieces)
    api.register("alice")
    with api.c.stream("POST", "/api/ai/ask/stream", json={"question": "下個月預算？", "summary": SUMMARY}, headers=api._h()) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        assert r.headers.get("x-accel-buffering") == "no"
        events = read_events(r)
    deltas = [d["t"] for e, d in events if e == "delta"]
    assert len(deltas) >= 3 and "".join(deltas) == "近三個月平均 3 萬。"  # 逐段送出，合起來就是完整答案（followups 不會混進來）
    name, done = events[-1]
    assert name == "done" and done["answer"] == "近三個月平均 3 萬。" and done["followups"] == ["要建預算嗎？"] and done["quota"]["daily"]["used"] == 1
    assert len(usage_rows()) == 1


def test_ask_stream_failures_do_not_cost_quota(api: Api, monkeypatch) -> None:  # noqa: ANN001
    api.register("alice")
    body = {"question": "你好", "summary": SUMMARY}

    def run() -> list[tuple[str, dict]]:
        with api.c.stream("POST", "/api/ai/ask/stream", json=body, headers=api._h()) as r:
            return read_events(r)

    stub_stream(monkeypatch, ['{"answer":""}'])  # 空答案
    ev = run()
    assert ev[-1][0] == "error" and ev[-1][1]["status"] == 422 and usage_rows() == []
    stub_stream(monkeypatch, ['{"answer":"到一半', '再多'], fail_after=1)  # 輸出一半中斷
    ev = run()
    assert [e for e, _ in ev][-1] == "error" and ev[-1][1]["status"] == 502 and usage_rows() == []
    stub_stream(monkeypatch, ['x'], fail_after=0, error=ServiceError(503, "AI 服務暫時無法使用，請稍後再試"))  # 全部供應商失敗
    ev = run()
    assert ev[-1][1] == {"status": 503, "detail": "AI 服務暫時無法使用，請稍後再試"} and usage_rows() == []


def test_ask_stream_respects_quota_and_login(api: Api, monkeypatch) -> None:  # noqa: ANN001
    from fastapi.testclient import TestClient
    from app.main import app
    assert TestClient(app).post("/api/ai/ask/stream", json={"question": "x", "summary": SUMMARY}).status_code in (401, 403)  # 沒登入（沒有 CSRF 或沒有登入）
    api.register("alice")
    stub_stream(monkeypatch, ['{"answer":"好"}'])
    body = {"question": "你好", "summary": SUMMARY}
    for _ in range(3):  # 每日額度 3 次
        with api.c.stream("POST", "/api/ai/ask/stream", json=body, headers=api._h()) as r:
            assert read_events(r)[-1][0] == "done"
    with api.c.stream("POST", "/api/ai/ask/stream", json=body, headers=api._h()) as r:
        ev = read_events(r)
    assert ev[-1][0] == "error" and ev[-1][1]["status"] == 429 and len(usage_rows()) == 3


# ── 操作助手（agent-plan）串流版：摘要先出現，步驟驗證後一次送出，白名單驗證和一般版相同 ──

def test_agent_plan_stream_streams_summary_and_validates_steps(api: Api, monkeypatch) -> None:  # noqa: ANN001
    from tests.test_ai import AGENT_BODY
    plan = {"summary": "把 Uber 歸到通勤並設預算", "steps": [
        {"tool": "set_budget", "args": {"category": "通勤", "amount": "3,000", "alert_percent": 80}},
        {"tool": "delete_everything", "args": {}},  # 不在白名單：驗證時丟掉
    ]}
    raw = json.dumps(plan, ensure_ascii=False)
    stub_stream(monkeypatch, [raw[:14], raw[14:30], raw[30:]])
    api.register("alice")
    with api.c.stream("POST", "/api/ai/agent-plan/stream", json=AGENT_BODY, headers=api._h()) as r:
        assert r.status_code == 200
        events = read_events(r)
    deltas = "".join(d["t"] for e, d in events if e == "delta")
    assert deltas == "把 Uber 歸到通勤並設預算"  # 只串流摘要，步驟（JSON）不會原樣漏給畫面
    name, done = events[-1]
    assert name == "done" and [s["tool"] for s in done["steps"]] == ["set_budget"] and done["quota"]["daily"]["used"] == 1


def test_agent_plan_stream_rejects_empty_plan_without_cost(api: Api, monkeypatch) -> None:  # noqa: ANN001
    from tests.test_ai import AGENT_BODY
    stub_stream(monkeypatch, ['{"summary":"","steps":[{"tool":"reclassify","args":{"keywords":[],"to_category":"通勤"}}]}'])
    api.register("alice")
    with api.c.stream("POST", "/api/ai/agent-plan/stream", json=AGENT_BODY, headers=api._h()) as r:
        events = read_events(r)
    assert events[-1][0] == "error" and events[-1][1]["status"] == 422 and usage_rows() == []
