"""第三方模型供應商（OpenAI 相容的 /chat/completions）：OpenRouter、NVIDIA NIM，以及自訂的一組。

依 CLURE_AI_PROVIDERS 的順序嘗試；一家出錯（HTTP 錯誤、限流、逾時、回應不是 JSON）就換下一家。
連續失敗 3 次的供應商冷卻 5 分鐘（記憶體內，重啟歸零），和前端報價 registry 同樣的思路。
只傳送呼叫者給的 messages，不記錄請求與回應內容。
"""
from __future__ import annotations

import json
from collections.abc import Iterator
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from app.core.config import Settings, get_settings
from app.service.errors import ServiceError

log = logging.getLogger("aster.ai")

FAIL_THRESHOLD = 3
COOLDOWN_SECONDS = 300
KNOWN = ("gemini", "openrouter", "nvidia", "custom")


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    api_key: str
    model: str
    # 額外合併進請求本文的參數（例如關閉推理模型的思考）
    extra: dict = field(default_factory=dict)

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


def extra_body(name: str, model: str, raw: str) -> dict:
    """該供應商額外的請求參數：環境變數（JSON 物件）優先；沒設定時，Nemotron 推理模型預設關閉思考輸出。"""
    if raw.strip():
        try:
            v = json.loads(raw)
            if isinstance(v, dict):
                return v
        except ValueError:
            pass
        log.warning("CLURE_AI_%s_EXTRA_BODY 不是有效的 JSON 物件，已忽略", name.upper())
    if name == "nvidia" and "nemotron" in model.lower():
        # NVIDIA NIM 的 Nemotron 預設會先輸出一長串思考，吃掉 max_tokens；關掉後直接回答
        return {"chat_template_kwargs": {"enable_thinking": False}}
    return {}


def providers(s: Settings | None = None) -> list[Provider]:
    s = s or get_settings()
    out: list[Provider] = []
    for name in [p.strip().lower() for p in s.ai_providers.split(",") if p.strip()]:
        if name not in KNOWN:
            continue
        model = getattr(s, f"ai_{name}_model")
        out.append(Provider(name, getattr(s, f"ai_{name}_base_url"), getattr(s, f"ai_{name}_api_key"), model, extra_body(name, model, getattr(s, f"ai_{name}_extra_body"))))
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
        hint = {400: "請求格式有誤（模型名稱錯誤，或這個模型不接受額外參數，可用 CLURE_AI_*_EXTRA_BODY 調整）", 422: "請求內容被拒絕（檢查模型名稱與 CLURE_AI_*_EXTRA_BODY）", 401: "API Key 無效或已過期", 402: "餘額或免費額度不足", 403: "沒有權限（Key 無效、Key 沒有這個模型的權限，或地區受限）",
                404: "找不到模型或網址錯誤（檢查 MODEL / BASE_URL）", 408: "供應商逾時", 429: "被限流或免費額度用完"}.get(e.code, "供應商伺服器錯誤" if e.code >= 500 else "")
        return f"HTTP {e.code}" + (f"：{hint}" if hint else "")
    if isinstance(e, (TimeoutError,)) or "timed out" in str(e).lower():
        return "逾時（供應商太久沒回應）"
    if isinstance(e, (urllib.error.URLError, OSError)):
        return "無法連線（網路不通、DNS 失敗或網址錯誤）"
    if isinstance(e, ValueError) and "content" in str(e) or "think" in str(e):
        return "模型沒有給出答案（推理模型的思考用完了輸出長度）；請關閉思考（見 CLURE_AI_*_EXTRA_BODY）或換模型"
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


def clean_content(content: object) -> str:
    """模型回應的文字內容。推理模型可能把思考放在 <think>…</think>（或只留結尾的 </think>）裡，只取思考之後的答案；內容空白代表被截斷。"""
    if not isinstance(content, str) or not content.strip():
        raise ValueError("empty content")  # 常見原因：思考內容用完了 max_tokens（content 為 null、只有 reasoning_content）
    t = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL | re.IGNORECASE)
    if "</think>" in t.lower():
        t = re.split(r"</think>", t, flags=re.IGNORECASE)[-1]
    if "<think>" in t.lower():  # 思考沒有收尾：被截斷
        raise ValueError("unterminated think")
    return t


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


def complete_json(
    system: str,
    user: str,
    *,
    max_tokens: int = 800,
    images: list[str] | None = None,
    audio: tuple[str, str] | None = None,
    prefer: tuple[str, ...] | None = None,
) -> tuple[object, str, str]:
    """依序嘗試各供應商，回傳 (解析後的 JSON, 供應商名稱, 模型)。全部失敗拋 503。"""
    s = get_settings()
    plist = list(providers(s))
    if prefer:
        rank = {name: i for i, name in enumerate(prefer)}
        plist.sort(key=lambda p: rank.get(p.name, len(rank)))
    tried = 0
    for p in plist:
        if not p.configured or cooling_down(p.name):
            continue
        tried += 1
        # 圖片／音訊放在使用者訊息裡
        if audio:
            b64, fmt = audio
            content: object = [{"type": "text", "text": user}, {"type": "input_audio", "input_audio": {"data": b64, "format": fmt}}]
        elif images:
            content = [{"type": "text", "text": user}, *({"type": "image_url", "image_url": {"url": u}} for u in images)]
        else:
            content = user
        payload = {"model": p.model, "temperature": 0, "max_tokens": max_tokens,
                   "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}], **p.extra}
        t0 = time.monotonic()
        try:
            resp = _post(p, payload, s.ai_timeout_seconds)
            data = extract_json(clean_content(resp["choices"][0]["message"].get("content")))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            reason = describe_error(e)
            log.warning("AI 供應商 %s 失敗：%s", p.name, reason)
            _record(p.name, False, error=reason)
            continue
        _record(p.name, True, latency_ms=int((time.monotonic() - t0) * 1000))
        return data, p.name, p.model
    raise ServiceError(503, "AI 服務暫時無法使用，請稍後再試" if tried else "尚未設定可用的 AI 供應商")


# ───────────── 串流（SSE）：邊生成邊傳，使用者不用等整段寫完 ─────────────

def visible_text(buf: str) -> str:
    """串流到一半的文字裡，去掉推理模型的 <think>…</think>；思考還沒結束的部分先不顯示。"""
    t = re.sub(r"<think>.*?</think>", "", buf, flags=re.DOTALL | re.IGNORECASE)
    i = t.lower().find("<think>")
    return t[:i] if i != -1 else t


_ESC = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", '"': '"', "\\": "\\", "/": "/"}


def partial_json_string(buf: str, key: str = "answer") -> str:
    """從「還沒寫完的 JSON」裡取出某個字串欄位目前已經到的內容（處理跳脫字元；停在一半的跳脫序列先不輸出）。"""
    m = re.search(r'"%s"\s*:\s*"' % re.escape(key), buf)
    if not m:
        return ""
    i, out = m.end(), []
    n = len(buf)
    while i < n:
        c = buf[i]
        if c == '"':
            break
        if c != "\\":
            out.append(c)
            i += 1
            continue
        if i + 1 >= n:
            break
        e = buf[i + 1]
        if e == "u":
            if i + 6 > n:
                break
            try:
                code = int(buf[i + 2:i + 6], 16)
            except ValueError:
                break
            i += 6
            if 0xD800 <= code < 0xDC00:  # 代理對：後半段還沒到就先等
                if i + 6 > n:
                    i -= 6
                    break
                try:
                    low = int(buf[i + 2:i + 6], 16) if buf[i:i + 2] == "\\u" else -1
                except ValueError:
                    low = -1
                if 0xDC00 <= low < 0xE000:
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                    i += 6
            out.append(chr(code))
        else:
            out.append(_ESC.get(e, e))
            i += 2
    return "".join(out)


def stream_text(system: str, user: str, *, max_tokens: int = 800, images: list[str] | None = None) -> Iterator[tuple[str, object]]:
    """依序嘗試各供應商（失敗、限流、逾時才換下一家），邊收邊產出 ("delta", 文字片段)；全部收完產出 ("done", (全文, 供應商, 模型))。
    已經開始輸出之後才中斷就不再換供應商（換了會讓使用者看到前後不連的兩段回答），改丟 ValueError 由呼叫端處理。"""
    s = get_settings()
    tried = 0
    for p in providers(s):
        if not p.configured or cooling_down(p.name):
            continue
        tried += 1
        content: object = user if not images else [{"type": "text", "text": user}, *({"type": "image_url", "image_url": {"url": u}} for u in images)]
        payload = {"model": p.model, "temperature": 0, "max_tokens": max_tokens, "stream": True,
                   "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}], **p.extra}
        req = urllib.request.Request(
            p.base_url.rstrip("/") + "/chat/completions", data=json.dumps(payload).encode(), method="POST",
            headers={"Content-Type": "application/json", "Accept": "text/event-stream", "Authorization": f"Bearer {p.api_key}", "X-Title": "Aster"},
        )
        t0 = time.monotonic()
        parts: list[str] = []
        try:
            with urllib.request.urlopen(req, timeout=s.ai_timeout_seconds) as r:  # noqa: S310 — 網址來自管理員設定的環境變數
                for raw in r:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except ValueError:
                        continue
                    delta = ((obj.get("choices") or [{}])[0].get("delta") or {}).get("content")
                    if isinstance(delta, str) and delta:
                        parts.append(delta)
                        yield ("delta", delta)
            full = "".join(parts)
            clean_content(full)  # 空白或思考沒收尾：視為失敗
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError, AttributeError) as e:
            reason = describe_error(e)
            log.warning("AI 供應商 %s 串流失敗：%s", p.name, reason)
            _record(p.name, False, error=reason)
            if parts:
                raise ValueError("stream interrupted") from e
            continue
        _record(p.name, True, latency_ms=int((time.monotonic() - t0) * 1000))
        yield ("done", (full, p.name, p.model))
        return
    raise ServiceError(503, "AI 服務暫時無法使用，請稍後再試" if tried else "尚未設定可用的 AI 供應商")


def check_provider(name: str) -> dict:
    """送一個極小的請求測試連線與 Key（略過冷卻；成功會解除冷卻）。不經過使用者額度，用掉供應商 1 次請求。"""
    s = get_settings()
    p = next((x for x in providers(s) if x.name == name), None)
    if p is None:
        raise ServiceError(404, "沒有這個供應商（檢查 CLURE_AI_PROVIDERS）")
    if not p.configured:
        return {"name": name, "ok": False, "latency_ms": None, "detail": "尚未設定：需要 API Key、網址與模型都有值"}
    payload = {"model": p.model, "temperature": 0, "max_tokens": 8, "messages": [{"role": "user", "content": "請只回覆：OK"}], **p.extra}
    t0 = time.monotonic()
    try:
        resp = _post(p, payload, s.ai_timeout_seconds)
        msg = resp["choices"][0]["message"]  # 確認回應結構正確
        if msg.get("content") is None and not msg.get("reasoning_content"):
            raise ValueError("empty")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
        reason = describe_error(e)
        _record(name, False, error=reason)
        return {"name": name, "ok": False, "latency_ms": None, "detail": reason}
    ms = int((time.monotonic() - t0) * 1000)
    _record(name, True, latency_ms=ms)
    return {"name": name, "ok": True, "latency_ms": ms, "detail": "連線正常，Key 與模型可用"}
