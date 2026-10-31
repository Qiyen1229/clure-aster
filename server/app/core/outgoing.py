"""對外通知：把一則通知送到 Discord、Telegram、LINE 或自訂 Webhook。

- Discord／Telegram／LINE 只連官方固定網域，使用者只提供 Webhook 網址或 Bot 權杖，網址由程式組出，不會被拿去打別處
- 自訂 Webhook 是使用者給的任意網址，所以有 SSRF 防護：只允許 https、不允許帳密、不跟隨轉址，
  而且網域解析出來的每個 IP 都必須是公開位址（不能是內網、本機、雲端中繼資料位址）。
  自架在內網、想通知內網服務（例如 n8n、Home Assistant）的人，可設 CLURE_NOTIFY_ALLOW_PRIVATE=true 放寬。
- 錯誤訊息一律遮掉權杖，不寫進日誌也不回傳
- 只用標準函式庫（urllib），不增加依賴
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import re
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from html import escape
from urllib.parse import urlparse

from app.core.config import get_settings

log = logging.getLogger("aster.notify")

KINDS = ("discord", "telegram", "line", "webhook")
# 通知類型：anomaly 異常大額／訂閱漲價、budget 預算、weekly 週報、monthly 月報、reminder 提醒（信用卡、訂閱、心願、備份）、
# daily 每日記帳提醒、prize 發票中獎、test 測試
EVENTS = ("anomaly", "budget", "weekly", "monthly", "reminder", "daily", "prize")
DEFAULT_EVENTS = ("anomaly", "budget", "weekly", "monthly", "prize")

TIMEOUT = 8
LEVEL_COLOR = {"info": 0x0A84FF, "success": 0x30D158, "warn": 0xFF9F0A, "alert": 0xFF453A}
LEVEL_EMOJI = {"info": "ℹ️", "success": "✅", "warn": "⚠️", "alert": "🚨"}


@dataclass
class Notice:
    event: str
    title: str
    body: str = ""
    level: str = "info"
    # 打開 App 的連結（完整網址）；沒設定 CLURE_PUBLIC_URL 就沒有
    url: str = ""
    fields: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class SendResult:
    ok: bool
    status: int = 0
    detail: str = ""


class ConfigError(ValueError):
    """設定不正確（網址格式、權杖格式、不安全的目標）。訊息是繁體中文，可直接顯示給使用者。"""


# ───────────── 設定驗證 ─────────────
DISCORD_RE = re.compile(r"^https://(?:ptb\.|canary\.)?(?:discord|discordapp)\.com/api/webhooks/\d{15,25}/[\w-]{20,120}$")
TELEGRAM_TOKEN_RE = re.compile(r"^\d{5,15}:[\w-]{30,60}$")
TELEGRAM_CHAT_RE = re.compile(r"^(?:-?\d{4,20}|@[A-Za-z][\w]{4,31})$")
LINE_TOKEN_RE = re.compile(r"^[\w+/=.-]{40,400}$")
LINE_TO_RE = re.compile(r"^[UCR][0-9a-f]{32}$")


def check_public_url(url: str, *, allow_private: bool | None = None) -> None:
    """自訂 Webhook 的網址檢查（SSRF 防護）。不合格丟 ConfigError。"""
    allow = get_settings().notify_allow_private if allow_private is None else allow_private
    u = urlparse(url)
    if u.scheme not in (("https", "http") if allow else ("https",)):
        raise ConfigError("網址必須是 https://" if not allow else "網址必須是 http:// 或 https://")
    if not u.hostname:
        raise ConfigError("網址格式不正確")
    if u.username or u.password:
        raise ConfigError("網址不能帶帳號密碼；需要驗證請放在網址路徑的權杖或改用簽章")
    if not allow and u.port not in (None, 443):
        raise ConfigError("只能連 443 埠（內網或其他埠需要管理員開啟 CLURE_NOTIFY_ALLOW_PRIVATE）")
    try:
        infos = socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except OSError as e:
        raise ConfigError("網域解析不到，請確認網址是否正確") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not allow and not ip.is_global:
            raise ConfigError("不能連到內網或本機位址（避免伺服器被拿去探測內部服務）")


def validate_config(kind: str, cfg: dict) -> dict:
    """檢查並整理設定，回傳只含必要欄位的乾淨 dict。"""
    s = lambda k: str(cfg.get(k, "")).strip()  # noqa: E731
    if kind == "discord":
        if not DISCORD_RE.match(s("url")):
            raise ConfigError("Discord Webhook 網址格式不正確（應為 https://discord.com/api/webhooks/…）")
        return {"url": s("url")}
    if kind == "telegram":
        if not TELEGRAM_TOKEN_RE.match(s("token")):
            raise ConfigError("Telegram Bot 權杖格式不正確（向 @BotFather 取得，像 123456:ABC…）")
        if not TELEGRAM_CHAT_RE.match(s("chat_id")):
            raise ConfigError("Telegram Chat ID 格式不正確（數字，群組是負數；頻道可用 @名稱）")
        return {"token": s("token"), "chat_id": s("chat_id")}
    if kind == "line":
        if not LINE_TOKEN_RE.match(s("token")):
            raise ConfigError("LINE Channel access token 格式不正確")
        if not LINE_TO_RE.match(s("to")):
            raise ConfigError("LINE 接收對象 ID 格式不正確（User／Group／Room ID，U、C 或 R 開頭加 32 碼）")
        return {"token": s("token"), "to": s("to")}
    if kind == "webhook":
        check_public_url(s("url"))
        out = {"url": s("url")}
        if s("secret"):
            out["secret"] = s("secret")[:100]
        return out
    raise ConfigError("不支援的通知類型")


def hint_for(kind: str, cfg: dict) -> str:
    """設定列表上顯示的遮罩提示（不含可用來發送的完整機密）"""
    if kind == "discord":
        return "…" + cfg["url"][-6:]
    if kind == "telegram":
        return f"Bot {cfg['token'].split(':')[0]} → {cfg['chat_id']}"
    if kind == "line":
        return "→ …" + cfg["to"][-4:]
    return urlparse(cfg["url"]).hostname or ""


def _mask(text: str, cfg: dict) -> str:
    for v in cfg.values():
        if isinstance(v, str) and len(v) >= 6:
            text = text.replace(v, "***")
    return text


# ───────────── 傳送 ─────────────
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # noqa: ANN002, ANN003, ANN201
        return None


def _post_json(url: str, body: dict, headers: dict[str, str] | None = None, timeout: int = TIMEOUT) -> tuple[int, str]:
    """送出 JSON POST；回傳 (狀態碼, 回應本文前 300 字)。不跟隨轉址。測試時會被替換。"""
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": "Aster/1", **(headers or {})})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as r:  # noqa: S310 — 網址已由 validate_config／固定網域保證
            return r.status, r.read(300).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(300).decode("utf-8", "replace")


def _discord(cfg: dict, n: Notice) -> tuple[str, dict, dict]:
    embed: dict = {"title": n.title[:250], "description": n.body[:3500], "color": LEVEL_COLOR.get(n.level, LEVEL_COLOR["info"]), "footer": {"text": "Aster 記帳"}}
    if n.url:
        embed["url"] = n.url
    if n.fields:
        embed["fields"] = [{"name": k[:200], "value": (v or "—")[:900], "inline": True} for k, v in n.fields[:10]]
    return cfg["url"] + "?wait=false", {"username": "Aster", "embeds": [embed]}, {}


def _telegram(cfg: dict, n: Notice) -> tuple[str, dict, dict]:
    lines = [f"{LEVEL_EMOJI.get(n.level, '')} <b>{escape(n.title)}</b>"]
    if n.body:
        lines.append(escape(n.body))
    for k, v in n.fields[:10]:
        lines.append(f"<b>{escape(k)}</b>：{escape(v)}")
    if n.url:
        lines.append(f'<a href="{escape(n.url, quote=True)}">在 Aster 開啟</a>')
    body = {"chat_id": cfg["chat_id"], "text": "\n".join(lines)[:4000], "parse_mode": "HTML", "disable_web_page_preview": True}
    return f"https://api.telegram.org/bot{cfg['token']}/sendMessage", body, {}


def _line(cfg: dict, n: Notice) -> tuple[str, dict, dict]:
    color = "#%06X" % LEVEL_COLOR.get(n.level, LEVEL_COLOR["info"])
    contents: list[dict] = []
    if n.body:
        contents.append({"type": "text", "text": n.body[:1000], "wrap": True, "size": "sm", "color": "#555555"})
    for k, v in n.fields[:10]:
        contents.append({"type": "box", "layout": "baseline", "spacing": "sm", "margin": "sm", "contents": [
            {"type": "text", "text": k[:30], "size": "xs", "color": "#8E8E93", "flex": 2},
            {"type": "text", "text": (v or "—")[:100], "size": "sm", "wrap": True, "flex": 5}]})
    bubble: dict = {
        "type": "bubble", "size": "kilo",
        "header": {"type": "box", "layout": "vertical", "backgroundColor": color, "paddingAll": "14px", "contents": [
            {"type": "text", "text": n.title[:100], "weight": "bold", "color": "#FFFFFF", "wrap": True}]},
        "body": {"type": "box", "layout": "vertical", "spacing": "sm", "contents": contents or [{"type": "text", "text": " ", "size": "xs"}]},
    }
    if n.url:
        bubble["footer"] = {"type": "box", "layout": "vertical", "contents": [{"type": "button", "style": "link", "height": "sm", "action": {"type": "uri", "label": "在 Aster 開啟", "uri": n.url}}]}
    body = {"to": cfg["to"], "messages": [{"type": "flex", "altText": f"{n.title}"[:400], "contents": bubble}]}
    return "https://api.line.me/v2/bot/message/push", body, {"Authorization": f"Bearer {cfg['token']}"}


def _webhook(cfg: dict, n: Notice) -> tuple[str, dict, dict]:
    body = {"app": "aster", "event": n.event, "level": n.level, "title": n.title, "body": n.body, "url": n.url, "fields": [{"name": k, "value": v} for k, v in n.fields]}
    headers: dict[str, str] = {}
    if cfg.get("secret"):
        sig = hmac.new(cfg["secret"].encode(), json.dumps(body, ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
        headers["X-Aster-Signature"] = f"sha256={sig}"
    return cfg["url"], body, headers


_BUILDERS = {"discord": _discord, "telegram": _telegram, "line": _line, "webhook": _webhook}


def send(kind: str, cfg: dict, notice: Notice) -> SendResult:
    """送出一則通知。不丟例外：失敗以 SendResult(ok=False) 回傳，訊息已遮掉權杖。"""
    try:
        if kind == "webhook":
            check_public_url(cfg["url"])  # 發送當下再檢查一次（網域解析可能在建立後變了）
        url, body, headers = _BUILDERS[kind](cfg, notice)
        status, text = _post_json(url, body, headers)
    except ConfigError as e:
        return SendResult(False, 0, str(e))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return SendResult(False, 0, "連線失敗：" + _mask(str(getattr(e, "reason", e)), cfg)[:120])
    except Exception as e:  # noqa: BLE001 — 單一通道出錯不能影響其他通道
        log.warning("對外通知發送發生未預期錯誤（%s）：%s", kind, type(e).__name__)
        return SendResult(False, 0, "發送失敗")
    if 200 <= status < 300:
        return SendResult(True, status)
    detail = _mask(text, cfg)
    try:  # 各平台的錯誤訊息欄位不同，盡量取出人看得懂的那句
        j = json.loads(text)
        detail = str(j.get("description") or j.get("message") or j.get("error") or detail)
    except (ValueError, AttributeError):
        pass
    hint = {401: "（權杖錯誤或已失效）", 403: "（沒有權限，Bot 可能被移出群組）", 404: "（找不到：Webhook 已被刪除或 ID 錯誤）", 429: "（被限流，稍後再試）"}.get(status, "")
    log.warning("對外通知被拒絕（%s）：HTTP %s", kind, status)
    return SendResult(False, status, f"HTTP {status}{hint} {_mask(detail, cfg)[:100]}".strip())
