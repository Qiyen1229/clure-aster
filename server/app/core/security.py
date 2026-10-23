"""密碼雜湊（Argon2id）、JWT 簽發與驗證、隨機權杖。"""
from __future__ import annotations

import secrets
import string
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import get_settings

_hasher = PasswordHasher()  # Argon2id，time_cost=3、memory_cost=64MiB、parallelism=4
# 找不到帳號時用來做假驗證，讓回應時間一致，避免帳號列舉
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))

TokenType = Literal["access", "refresh"]


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def create_token(*, user_id: int, role: str, token_version: int, token_type: TokenType, jti: str | None = None, family_id: str | None = None) -> tuple[str, str, datetime]:
    """回傳 (token, jti, 到期時間)。"""
    s = get_settings()
    now = utcnow()
    exp = now + (timedelta(minutes=s.access_token_minutes) if token_type == "access" else timedelta(days=s.refresh_token_days))
    jti = jti or uuid.uuid4().hex
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "role": role,
        "ver": token_version,
        "type": token_type,
        "jti": jti,
        "iat": int(now.replace(tzinfo=timezone.utc).timestamp()),
        "exp": int(exp.replace(tzinfo=timezone.utc).timestamp()),
    }
    if family_id:
        payload["fam"] = family_id
    token = jwt.encode(payload, s.resolved_jwt_secret(), algorithm=s.jwt_algorithm)
    return token, jti, exp


def decode_token(token: str, expected_type: TokenType) -> dict[str, Any] | None:
    """驗證簽章、到期與類型；失敗回傳 None（不拋出細節，避免洩漏資訊）。"""
    s = get_settings()
    try:
        payload = jwt.decode(token, s.resolved_jwt_secret(), algorithms=[s.jwt_algorithm], options={"require": ["exp", "sub", "type", "jti"]})
    except jwt.PyJWTError:
        return None
    if payload.get("type") != expected_type:
        return None
    return payload


def generate_temporary_password(length: int = 14) -> str:
    """管理員重設密碼用：含大小寫英文與數字，排除易混淆字元。"""
    alphabet = "".join(c for c in string.ascii_letters + string.digits if c not in "Il1O0o")
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if any(c.isdigit() for c in pw) and any(c.isalpha() for c in pw):
            return pw


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)
