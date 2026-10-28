"""第三方模型供應商（OpenAI 相容的 /chat/completions）：OpenRouter、NVIDIA NIM，以及自訂的一組。

依 CLURE_AI_PROVIDERS 的順序嘗試；一家出錯（HTTP 錯誤、限流、逾時、回應不是 JSON）就換下一家。
連續失敗 3 次的供應商冷卻 5 分鐘（記憶體內，重啟歸零），和前端報價 registry 同樣的思路。
只傳送呼叫者給的 messages，不記錄請求與回應內容。
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from app.core.config import Settings, get_settings
from app.service.errors import ServiceError

log = logging.getLogger("aster.ai")

FAIL_THRESHOLD = 3
COOLDOWN_SECONDS = 300
KNOWN = ("openrouter", "nvidia", "custom")


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    api_key: str
    model: str

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)


_lock = threading.Lock()
_fails: dict[str, int] = {}
_cooldown_until: dict[str, float] = {}


@dataclass
class Health:
    """供應商連線狀況（記憶體內，API 重啟歸零）；只記次數、時間與簡短原因，不記請求與回應內容。"""
    ok: int = 0
    fail: int = 0
    last_ok_at: float | None = None
    last_fail_at: float | None = None
    last_error: str = ""
    last_latency_ms: int | None = None


_health: dict[str, Health] = {}


def providers(s: Settings | None = None) -> list[Provider]:
    s = s or get_settings()
    out: list[Provider] = []
    for name in [p.strip().lower() for p in s.ai_providers.split(",") if p.strip()]:
        if name not in KNOWN:
            continue
        out.append(Provider(name, getattr(s, f"ai_{name}_base_url"), getattr(s, f"ai_{name}_api_key"), getattr(s, f"ai_{name}_model")))
    return out


def cooling_down(name: str) -> bool:
    return _cooldown_until.get(name, 0) > time.time()


def reset_state() -> None:
    """測試用"""
    with _lock:
        _fails.clear()
        _cooldown_until.clear()
        _health.clear()


def health(name: str) -> Health:
    return _health.get(name) or Health()


def cooldown_remaining(name: str) -> int:
    return max(0, int(_cooldown_until.get(name, 0) - time.time()))


def describe_error(e: Exception) -> str:
    """把例外轉成管理員看得懂的一句話（不含網址、Key 與回應內容）。"""
    if isinstance(e, urllib.error.HTTPError):
        hint = {400: "請求格式或模型名稱有誤", 401: "API Key 無效或已過期", 402: "餘額或免費額度不足", 403: "沒有權限（Key 無此模型或地區受限）",
                404: "找不到模型或網址錯誤（檢查 MODEL / BASE_URL）", 408: "供應商逾時", 429: "被限流或免費額度用完"}.get(e.code, "供應商伺服器錯誤" if e.code >= 500 else "")
        return f"HTTP {e.code}" + (f"：{hint}" if hint else "")
    if isinstance(e, (TimeoutError,)) or "timed out" in str(e).lower():
        return "逾時（供應商太久沒回應）"
    if isinstance(e, (urllib.error.URLError, OSError)):
        return "無法連線（網路不通、DNS 失敗或網址錯誤）"
    return "回應格式不正確（不是預期的 JSON）"


def _record(name: str, ok: bool, latency_ms: int | None = None, error: str = "") -> None:
    with _lock:
        h = _health.setdefault(name, Health())
        now = time.time()
        if ok:
            h.ok += 1
            h.last_ok_at = now
            h.last_latency_ms = latency_ms
        else:
            h.fail += 1
            h.last_fail_at = now
            h.last_error = error
        if ok:
            _fails.pop(name, None)
            _cooldown_until.pop(name, None)
            return
        _fails[name] = _fails.get(name, 0) + 1
        if _fails[name] >= FAIL_THRESHOLD:
            _cooldown_until[name] = time.time() + COOLDOWN_SECONDS
            _fails[name] = 0
            log.warning("AI 供應商 %s 連續失敗，冷卻 %s 秒", name, COOLDOWN_SECONDS)


def _post(p: Provider, payload: dict, timeout: int) -> dict:
    req = urllib.request.Request(
        p.base_url.rstrip("/") + "/chat/completions", data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {p.api_key}", "X-Title": "Aster"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — 網址來自管理員設定的環境變數
        return json.loads(r.read().decode("utf-8"))


def extract_json(text: str) -> object:
    """從模型輸出取出 JSON：容忍 ```json 圍欄與前後多餘的說明文字。"""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.IGNORECASE)
    pairs = [(o, c) for o, c in (("{", "}"), ("[", "]")) if o in t]
    pairs.sort(key=lambda oc: t.find(oc[0]))  # 先出現的括號是最外層
    for opener, closer in pairs:
        a, b = t.find(opener), t.rfind(closer)
        if a != -1 and b > a:
            try:
                return json.loads(t[a:b + 1])
            except ValueError:
                continue
    raise ValueError("no json")


def complete_json(system: str, user: str, *, max_tokens: int = 500) -> tuple[object, str, str]:
    """依序嘗試各供應商，回傳 (解析後的 JSON, 供應商名稱, 模型)。全部失敗拋 503。"""
    s = get_settings()
    tried = 0
    for p in providers(s):
        if not p.configured or cooling_down(p.name):
            continue
        tried += 1
        payload = {"model": p.model, "temperature": 0, "max_tokens": max_tokens,
                   "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        t0 = time.monotonic()
        try:
            resp = _post(p, payload, s.ai_timeout_seconds)
            content = resp["choices"][0]["message"]["content"]
            data = extract_json(content)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            reason = describe_error(e)
            log.warning("AI 供應商 %s 失敗：%s", p.name, reason)
            _record(p.name, False, error=reason)
            continue
        _record(p.name, True, latency_ms=int((time.monotonic() - t0) * 1000))
        return data, p.name, p.model
    raise ServiceError(503, "AI 服務暫時無法使用，請稍後再試" if tried else "尚未設定可用的 AI 供應商")


def check_provider(name: str) -> dict:
    """送一個極小的請求測試連線與 Key（略過冷卻；成功會解除冷卻）。不經過使用者額度，用掉供應商 1 次請求。"""
    s = get_settings()
    p = next((x for x in providers(s) if x.name == name), None)
    if p is None:
        raise ServiceError(404, "沒有這個供應商（檢查 CLURE_AI_PROVIDERS）")
    if not p.configured:
        return {"name": name, "ok": False, "latency_ms": None, "detail": "尚未設定：需要 API Key、網址與模型都有值"}
    payload = {"model": p.model, "temperature": 0, "max_tokens": 8, "messages": [{"role": "user", "content": "請只回覆：OK"}]}
    t0 = time.monotonic()
    try:
        resp = _post(p, payload, s.ai_timeout_seconds)
        resp["choices"][0]["message"]["content"]  # noqa: B018 — 確認回應結構正確
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
        reason = describe_error(e)
        _record(name, False, error=reason)
        return {"name": name, "ok": False, "latency_ms": None, "detail": reason}
    ms = int((time.monotonic() - t0) * 1000)
    _record(name, True, latency_ms=ms)
    return {"name": name, "ok": True, "latency_ms": ms, "detail": "連線正常，Key 與模型可用"}
