"""小型加密盒：把外部通知的機密（Bot 權杖、Webhook 網址）加密後才存進資料庫。

AES-256-GCM，金鑰由伺服器的 JWT 金鑰經 HKDF 導出（用途隔離，不會跟簽發權杖共用同一把）。
資料庫或備份外洩時看不到明文；但持有伺服器金鑰的人仍可解密——這是「伺服器要主動發送」的本質限制，
所以文件請使用者用專用的、可隨時撤銷的 Bot／Webhook。
"""
from __future__ import annotations

import base64
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import get_settings

_INFO = b"aster-secretbox-v1"


def _key() -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_INFO).derive(get_settings().resolved_jwt_secret().encode())


def seal(data: dict) -> str:
    nonce = os.urandom(12)
    ct = AESGCM(_key()).encrypt(nonce, json.dumps(data, ensure_ascii=False).encode(), _INFO)
    return "v1." + base64.urlsafe_b64encode(nonce + ct).decode()


def open_(token: str) -> dict:
    if not token.startswith("v1."):
        raise ValueError("格式不正確")
    raw = base64.urlsafe_b64decode(token[3:])
    return json.loads(AESGCM(_key()).decrypt(raw[:12], raw[12:], _INFO))
