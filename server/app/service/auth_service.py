"""認證業務邏輯：註冊、登入（鎖定）、權杖簽發與輪替（重用偵測）、登出、變更密碼。"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import mask_email
from app.core.request_info import ClientInfo
from app.core.security import create_token, decode_token, hash_password, needs_rehash, utcnow, verify_password
from app.model import ROLE_ADMIN, ROLE_USER, RefreshToken, User
from app.repository.token_repository import TokenRepository
from app.repository.user_repository import UserRepository
from app.schema.auth import ChangePasswordRequest, LoginRequest, RegisterRequest
from app.service import app_settings
from app.service.audit_service import AuditService
from app.service.errors import ServiceError

log = logging.getLogger("aster.auth")
# 兩個分頁同時刷新時，舊權杖在這段時間內再次使用不視為遭竊
REFRESH_REUSE_GRACE = timedelta(seconds=20)


@dataclass
class IssuedTokens:
    access_token: str
    access_expires: datetime
    refresh_token: str
    refresh_expires: datetime


class AuthService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.users = UserRepository(db)
        self.tokens = TokenRepository(db)
        self.audit = AuditService(db)
        self.settings = get_settings()

    # ───── 權杖 ─────
    def issue_tokens(self, user: User, client: ClientInfo, family_id: str | None = None) -> IssuedTokens:
        access, _, access_exp = create_token(user_id=user.id, role=user.role, token_version=user.token_version, token_type="access")
        family = family_id or uuid.uuid4().hex
        refresh, jti, refresh_exp = create_token(user_id=user.id, role=user.role, token_version=user.token_version, token_type="refresh", family_id=family)
        self.tokens.add(RefreshToken(id=jti, user_id=user.id, family_id=family, expires_at=refresh_exp, ip=client.ip, user_agent=client.user_agent))
        return IssuedTokens(access, access_exp, refresh, refresh_exp)

    def authenticate_access(self, token: str | None) -> User | None:
        """驗證 Access Token，並比對帳號狀態與 token_version（凍結、強制登出、改密碼後立即失效）。"""
        if not token:
            return None
        payload = decode_token(token, "access")
        if not payload:
            return None
        try:
            user = self.users.get(int(payload["sub"]))
        except (TypeError, ValueError):
            return None
        if not user or not user.is_active or payload.get("ver") != user.token_version:
            return None
        return user

    # ───── 註冊 ─────
    def register(self, req: RegisterRequest, client: ClientInfo) -> tuple[User, IssuedTokens]:
        if not app_settings.registration_open(self.db, self.settings):
            raise ServiceError(403, "目前未開放註冊，請聯絡管理員")
        if self.users.get_by_username(req.username) or self.users.get_by_email(req.email):
            self.audit.record("auth.register", client, success=False, detail={"reason": "duplicate"})
            self.db.commit()
            raise ServiceError(409, "使用者名稱或 Email 已被使用")
        # 全新系統（沒有任何使用者）時，第一位註冊者成為管理員；建議改用環境變數或 CLI 預先建立管理員
        role = ROLE_ADMIN if self.settings.first_user_admin and self.users.count() == 0 else ROLE_USER
        now = utcnow()
        user = self.users.add(User(
            username=req.username, email=req.email, password_hash=hash_password(req.password), role=role,
            password_changed_at=now, last_login_at=now, last_seen_at=now,
        ))
        tokens = self.issue_tokens(user, client)
        self.audit.record("auth.register", client, user_id=user.id, detail={"role": role})
        self.db.commit()
        log.info("使用者註冊 id=%s email=%s role=%s", user.id, mask_email(user.email), role)
        return user, tokens

    # ───── 登入 ─────
    def login(self, req: LoginRequest, client: ClientInfo) -> tuple[User, IssuedTokens]:
        now = utcnow()
        user = self.users.get_by_identifier(req.identifier)
        if user and user.locked_until and user.locked_until > now:
            minutes = max(1, int((user.locked_until - now).total_seconds() // 60) + 1)
            self.audit.record("auth.login_locked", client, success=False, user_id=user.id)
            self.db.commit()
            raise ServiceError(423, f"登入失敗次數過多，帳號已暫時鎖定，請於 {minutes} 分鐘後再試")

        ok = verify_password(req.password, user.password_hash if user else None)
        if not user or not ok:
            detail: dict[str, object] = {"reason": "bad_credentials"}
            if user:
                user.failed_login_count += 1
                if user.failed_login_count >= self.settings.lockout_threshold:
                    user.locked_until = now + timedelta(minutes=self.settings.lockout_minutes)
                    user.failed_login_count = 0
                    detail["locked"] = True
                    log.warning("帳號因連續登入失敗被鎖定 user_id=%s ip=%s", user.id, client.ip)
            self.audit.record("auth.login", client, success=False, user_id=user.id if user else None, detail=detail)
            self.db.commit()
            raise ServiceError(401, "帳號或密碼錯誤")

        if not user.is_active:
            self.audit.record("auth.login", client, success=False, user_id=user.id, detail={"reason": "frozen"})
            self.db.commit()
            raise ServiceError(403, "此帳號已被停用，請聯絡管理員")

        user.failed_login_count = 0
        user.locked_until = None
        user.last_login_at = now
        user.last_seen_at = now
        if needs_rehash(user.password_hash):
            user.password_hash = hash_password(req.password)
        tokens = self.issue_tokens(user, client)
        self.audit.record("auth.login", client, user_id=user.id)
        self.db.commit()
        return user, tokens

    # ───── 刷新（輪替＋重用偵測） ─────
    def refresh(self, refresh_token: str | None, client: ClientInfo) -> tuple[User, IssuedTokens]:
        payload = decode_token(refresh_token or "", "refresh")
        if not payload:
            raise ServiceError(401, "登入已過期，請重新登入")
        now = utcnow()
        row = self.tokens.get(payload["jti"])
        if not row or str(row.user_id) != payload["sub"]:
            raise ServiceError(401, "登入已過期，請重新登入")
        if row.revoked_at:
            if row.replaced_by and now - row.revoked_at <= REFRESH_REUSE_GRACE:
                pass  # 同時刷新的良性重複請求
            else:
                self.tokens.revoke_family(row.family_id, now)
                self.audit.record("auth.refresh_reuse", client, success=False, user_id=row.user_id, detail={"family": row.family_id[:8]})
                self.db.commit()
                log.warning("偵測到 Refresh Token 重用，已撤銷整條權杖鏈 user_id=%s ip=%s", row.user_id, client.ip)
                raise ServiceError(401, "登入狀態異常，請重新登入")
        if row.expires_at <= now:
            raise ServiceError(401, "登入已過期，請重新登入")
        user = self.users.get(row.user_id)
        if not user or not user.is_active or payload.get("ver") != user.token_version:
            self.tokens.revoke_family(row.family_id, now)
            self.db.commit()
            raise ServiceError(401, "登入已失效，請重新登入")
        tokens = self.issue_tokens(user, client, family_id=row.family_id)
        if not row.revoked_at:
            row.revoked_at = now
            row.replaced_by = decode_token(tokens.refresh_token, "refresh")["jti"]  # type: ignore[index]
        user.last_seen_at = now
        self.db.commit()
        return user, tokens

    # ───── 登出 ─────
    def logout(self, refresh_token: str | None, user: User | None, client: ClientInfo) -> None:
        payload = decode_token(refresh_token or "", "refresh")
        if payload:
            row = self.tokens.get(payload["jti"])
            if row:
                self.tokens.revoke_family(row.family_id, utcnow())
        self.audit.record("auth.logout", client, user_id=user.id if user else (int(payload["sub"]) if payload else None))
        self.db.commit()

    # ───── 變更密碼 ─────
    def change_password(self, user: User, req: ChangePasswordRequest, client: ClientInfo) -> IssuedTokens:
        if not verify_password(req.current_password, user.password_hash):
            self.audit.record("auth.password_change", client, success=False, user_id=user.id, detail={"reason": "bad_current"})
            self.db.commit()
            raise ServiceError(400, "目前密碼不正確")
        if req.new_password == req.current_password:
            raise ServiceError(400, "新密碼不可與目前密碼相同")
        if req.new_password.lower() == user.username.lower():
            raise ServiceError(400, "密碼不可與使用者名稱相同")
        now = utcnow()
        user.password_hash = hash_password(req.new_password)
        user.password_changed_at = now
        user.must_change_password = False
        user.token_version += 1  # 其他裝置全部登出
        self.tokens.revoke_all_for_user(user.id, now)
        tokens = self.issue_tokens(user, client)  # 目前裝置保持登入
        self.audit.record("auth.password_change", client, user_id=user.id)
        self.db.commit()
        return tokens
