"""認證業務邏輯：註冊、登入（鎖定）、權杖簽發與輪替（重用偵測）、登出、變更密碼。"""
from __future__ import annotations

import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import mask_email
from app.core.request_info import ClientInfo
from app.core.security import create_token, decode_token, hash_password, needs_rehash, utcnow, verify_password
from app.core.mailer import MailError, mail_configured, send_mail
from app.model import ROLE_ADMIN, ROLE_USER, PasswordReset, RefreshToken, User
from sqlalchemy import select
from app.repository.token_repository import TokenRepository
from app.repository.user_repository import UserRepository
from app.schema.auth import ChangePasswordRequest, LoginRequest, RegisterRequest, ResetPasswordRequest, check_email_domain
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
        try:
            check_email_domain(req.email)
        except ValueError as e:
            raise ServiceError(422, str(e)) from e
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

        # 恆定時間密碼驗證（即使帳號不存在也執行假雜湊，防範計時攻擊）
        ok = verify_password(req.password, user.password_hash if user else None)

        # 情況 1：密碼錯誤 或 帳號不存在
        if not user or not ok:
            detail: dict[str, object] = {"reason": "bad_credentials"}
            if user:
                # 若帳號正處於被鎖定/攻擊期間，記錄登入失敗審計日誌
                if user.locked_until and user.locked_until > now:
                    self.audit.record("auth.login_locked", client, success=False, user_id=user.id)
                    self.db.commit()
                    # 統一回傳 401 錯誤，絕不洩漏 423 狀態碼或「已鎖定」字樣，徹底防範帳號枚舉
                    raise ServiceError(401, "帳號或密碼錯誤")

                user.failed_login_count += 1
                if user.failed_login_count >= self.settings.lockout_threshold:
                    user.locked_until = now + timedelta(minutes=self.settings.lockout_minutes)
                    user.failed_login_count = 0
                    detail["locked"] = True
                    log.warning("帳號因連續登入失敗被鎖定 user_id=%s ip=%s", user.id, client.ip)
            self.audit.record("auth.login", client, success=False, user_id=user.id if user else None, detail=detail)
            self.db.commit()
            raise ServiceError(401, "帳號或密碼錯誤")

        # 情況 2：密碼正確，但帳號已被管理員停用
        if not user.is_active:
            self.audit.record("auth.login", client, success=False, user_id=user.id, detail={"reason": "frozen"})
            self.db.commit()
            raise ServiceError(403, "此帳號已被停用，請聯絡管理員")

        # 情況 3：密碼正確！防範 Lockout DoS：
        # 若攻擊者曾用受害者帳號發動連續錯誤登入造成 locked_until，合法使用者輸入正確密碼時自動解除鎖定並登入
        if user.locked_until and user.locked_until > now:
            log.info("合法密碼驗證通過，自動清除鎖定狀態 user_id=%s ip=%s", user.id, client.ip)
            self.audit.record("auth.login_lockout_cleared", client, user_id=user.id)

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

    # ───── 忘記密碼 ─────
    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def request_reset(self, identifier: str, client: ClientInfo) -> None:
        """寄重設連結。不論帳號存不存在都回一樣的結果（不洩漏哪些 Email 有註冊）；未設定寄信時才明確告知。"""
        if not mail_configured():
            raise ServiceError(503, "管理員尚未設定寄信功能，請聯絡管理員幫你重設密碼")
        if not self.settings.public_url:
            raise ServiceError(503, "管理員尚未設定網站網址（CLURE_PUBLIC_URL），請聯絡管理員幫你重設密碼")
        user = self.users.get_by_identifier(identifier)
        if not user or not user.is_active:
            self.audit.record("auth.reset_request", client, success=False, detail={"reason": "unknown_or_frozen"})
            self.db.commit()
            return
        now = utcnow()
        # 先作廢舊的未使用連結，同時間只有一條有效
        for old in self.db.scalars(select(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))).all():
            old.used_at = now
        token = secrets.token_urlsafe(32)
        self.db.add(PasswordReset(user_id=user.id, token_hash=self._hash_token(token), expires_at=now + timedelta(minutes=self.settings.reset_token_minutes)))
        self.audit.record("auth.reset_request", client, user_id=user.id)
        self.db.commit()
        link = f"{self.settings.public_url.rstrip('/')}/reset-password?token={token}"
        body = (
            f"{user.username} 你好，\n\n有人（希望是你）要求重設 Aster 記帳的密碼。\n"
            f"請在 {self.settings.reset_token_minutes} 分鐘內點下面的連結設定新密碼：\n\n{link}\n\n"
            "連結只能使用一次。如果不是你要求的，請忽略這封信，你的密碼不會改變。\n"
        )
        try:
            send_mail(user.email, "Aster 記帳：重設密碼", body)
        except MailError as e:
            log.warning("重設密碼信寄送失敗 user_id=%s：%s", user.id, e)
            raise ServiceError(502, "寄信失敗，請稍後再試或聯絡管理員") from e

    def reset_password(self, req: ResetPasswordRequest, client: ClientInfo) -> None:
        now = utcnow()
        row = self.db.scalar(select(PasswordReset).where(PasswordReset.token_hash == self._hash_token(req.token)))
        if not row or row.used_at or row.expires_at <= now:
            self.audit.record("auth.reset_password", client, success=False, user_id=row.user_id if row else None, detail={"reason": "invalid_token"})
            self.db.commit()
            raise ServiceError(400, "連結無效或已過期，請重新申請")
        user = self.users.get(row.user_id)
        if not user or not user.is_active:
            raise ServiceError(400, "連結無效或已過期，請重新申請")
        if req.new_password.lower() == user.username.lower():
            raise ServiceError(400, "密碼不可與使用者名稱相同")
        user.password_hash = hash_password(req.new_password)
        user.password_changed_at = now
        user.must_change_password = False
        user.locked_until = None
        user.failed_login_count = 0
        user.token_version += 1  # 所有裝置登出
        self.tokens.revoke_all_for_user(user.id, now)
        row.used_at = now
        self.audit.record("auth.reset_password", client, user_id=user.id)
        self.db.commit()
