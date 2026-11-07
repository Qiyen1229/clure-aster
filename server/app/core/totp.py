"""TOTP（RFC 6238）：只用標準函式庫（hmac、hashlib、base64），不需要額外套件。

與 Google Authenticator、Apple「密碼」App、1Password、Authy 等相容：SHA-1、6 位數、30 秒一個週期。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

PERIOD = 30
DIGITS = 6
WINDOW = 1  # 前後各容許一個週期（手機時鐘差幾十秒也能過）


def new_secret() -> str:
    """20 位元組（160 bits）隨機值，Base32（無補齊）。"""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def code_at(secret: str, step: int) -> str:
    mac = hmac.new(_key(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    n = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % 10 ** DIGITS
    return f"{n:0{DIGITS}d}"


def current_step(now: float | None = None) -> int:
    return int((time.time() if now is None else now) // PERIOD)


def verify(secret: str, code: str, *, last_step: int = 0, now: float | None = None) -> int | None:
    """驗證成功回傳該碼所屬的週期編號；失敗回傳 None。已經用過的週期（<= last_step）不能再用，擋掉重送。"""
    code = (code or "").strip().replace(" ", "")
    if len(code) != DIGITS or not code.isdigit():
        return None
    cur = current_step(now)
    hit: int | None = None
    for step in range(cur - WINDOW, cur + WINDOW + 1):  # 不提早結束：比對時間不隨哪一個週期命中而不同
        if hmac.compare_digest(code_at(secret, step), code) and step > last_step and hit is None:
            hit = step
    return hit


def otpauth_uri(secret: str, account: str, issuer: str = "Aster 記帳") -> str:
    return f"otpauth://totp/{quote(issuer)}:{quote(account)}?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits={DIGITS}&period={PERIOD}"


def new_recovery_codes(n: int = 8) -> list[str]:
    """備援碼：xxxx-xxxx（去掉容易混淆的字元）；每個只能用一次。"""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return ["-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(2)) for _ in range(n)]


def normalize_recovery(code: str) -> str:
    c = "".join(ch for ch in (code or "").lower() if ch.isalnum())
    return f"{c[:4]}-{c[4:]}" if len(c) == 8 else ""


def hash_recovery(code: str) -> str:
    return hashlib.sha256(("aster-recovery:" + normalize_recovery(code)).encode()).hexdigest()
