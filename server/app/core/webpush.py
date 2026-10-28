"""Web Push（RFC 8030／8291／8292）：VAPID 金鑰、aes128gcm 內容加密、送出。

只用 cryptography 與 PyJWT，不依賴 pywebpush。VAPID 私鑰存在 data_dir/vapid_private.pem（與 JWT 金鑰同處，首次自動產生）。
"""
from __future__ import annotations

import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import urlparse

import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import get_settings

log = logging.getLogger("aster.push")


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


@lru_cache
def vapid_key() -> ec.EllipticCurvePrivateKey:
    path = get_settings().data_dir / "vapid_private.pem"
    if path.exists():
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        assert isinstance(key, ec.EllipticCurvePrivateKey)
        return key
    key = ec.generate_private_key(ec.SECP256R1())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    path.chmod(0o600)
    return key


def vapid_public_key() -> str:
    """給瀏覽器 pushManager.subscribe 的 applicationServerKey（未壓縮點，base64url）。"""
    pub = vapid_key().public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64u(pub)


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """RFC 8291 aes128gcm：以訂閱者公鑰與 auth secret 加密推播內容。"""
    ua_pub_bytes = unb64u(p256dh)
    auth_secret = unb64u(auth)
    ua_pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub_bytes)
    as_priv = ec.generate_private_key(ec.SECP256R1())
    as_pub = as_priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = as_priv.exchange(ec.ECDH(), ua_pub)
    ikm = HKDF(hashes.SHA256(), 32, auth_secret, b"WebPush: info\x00" + ua_pub_bytes + as_pub).derive(shared)
    salt = os.urandom(16)
    cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    ct = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)  # 0x02：最後一筆紀錄的分隔
    rs = 4096
    header = salt + rs.to_bytes(4, "big") + bytes([len(as_pub)]) + as_pub
    return header + ct


def vapid_headers(endpoint: str, subject: str) -> dict[str, str]:
    u = urlparse(endpoint)
    token = jwt.encode({"aud": f"{u.scheme}://{u.netloc}", "exp": int(time.time()) + 12 * 3600, "sub": subject}, vapid_key(), algorithm="ES256")
    return {"Authorization": f"vapid t={token}, k={vapid_public_key()}"}


@dataclass
class SendResult:
    ok: bool
    status: int
    gone: bool  # 訂閱已失效（404／410），應刪除
    detail: str = ""  # 推播服務回的原因（例如 Apple 的 BadJwtToken），方便診斷
    retry: bool = False  # 暫時性失敗（連不上、429、5xx），可稍後再送


# 最近一次失敗的原因（記憶體內，重啟歸零）；給「傳送測試推播」與狀態頁顯示
last_failure: dict[str, object] = {}


def _host(endpoint: str) -> str:
    return urlparse(endpoint).netloc


def _record_failure(endpoint: str, status: int, detail: str) -> None:
    last_failure.clear()
    last_failure.update({"host": _host(endpoint), "status": status, "detail": detail[:200], "at": int(time.time())})


def default_subject() -> str:
    # 蘋果等推播服務會檢查 sub 是否像真的聯絡方式，.local 這類假網域可能被拒絕
    return get_settings().vapid_subject or "mailto:admin@example.com"


def send(endpoint: str, p256dh: str, auth: str, message: dict, subject: str | None = None, ttl: int = 86400) -> SendResult:
    body = encrypt(json.dumps(message, ensure_ascii=False).encode(), p256dh, auth)
    headers = {
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": str(ttl), "Urgency": "normal", "User-Agent": "Aster-WebPush/2",
        **vapid_headers(endpoint, subject or default_subject()),
    }
    req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310 — endpoint 來自瀏覽器的 Push 服務
            return SendResult(True, r.status, False)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read(300).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = ""
        log.warning("推播失敗 status=%s host=%s detail=%s", e.code, _host(endpoint), detail)
        _record_failure(endpoint, e.code, detail)
        return SendResult(False, e.code, e.code in (404, 410), detail, retry=e.code == 429 or e.code >= 500)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        log.warning("推播連線失敗 host=%s err=%s", _host(endpoint), e)
        _record_failure(endpoint, 0, str(e))
        return SendResult(False, 0, False, str(e), retry=True)
