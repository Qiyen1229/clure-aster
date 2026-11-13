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
from app.core import secretbox, totp
from app.core.security import create_token, decode_token, hash_password, needs_rehash, utcnow, verify_password
from app.core.mailer import MailError, mail_configured, send_mail
from app.model import ROLE_ADMIN, ROLE_USER, PasswordReset, RefreshToken, User
from sqlalchemy import select
from app.repository.token_repository import TokenRepository
from app.repository.user_repository import UserRepository
from app.schema.auth import ChangePasswordRequest, LoginRequest, RegisterRequest, ResetPasswordRequest, SessionOut, check_email_domain
from app.service import app_settings
from app.service.audit_service import AuditService
from app.service.errors import ServiceError

log = logging.getLogger("aster.auth")
# 兩個分頁同時刷新時，舊權杖在這段時間內再次使用不視為遭竊
REFRESH_REUSE_GRACE = timedelta(seconds=30)


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
        family = family_id or uuid.uuid4().hex
        # Access Token 也記下它屬於哪一台裝置（family）：遠端登出那台裝置時，它的 Access Token 立刻失效，不用等到期
        access, _, access_exp = create_token(user_id=user.id, role=user.role, token_version=user.token_version, token_type="access", family_id=family)
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
        fam = payload.get("fam")
        if fam and not self.tokens.family_active(fam, utcnow()):
            return None  # 這台裝置已被登出（自己登出、被別台踢掉、重用偵測）
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

        if user.totp_enabled:
            if not req.totp:
                # 密碼對了、但還要驗證碼：不算失敗、不加鎖定次數（前端會跳出輸入驗證碼的畫面）
                self.audit.record("auth.login_totp_required", client, user_id=user.id)
                self.db.commit()
                raise ServiceError(401, "請輸入雙因素驗證碼", headers={"X-Totp-Required": "1"})
            if not self._check_second_factor(user, req.totp):
                user.failed_login_count += 1
                detail2: dict[str, object] = {"reason": "bad_totp"}
                if user.failed_login_count >= self.settings.lockout_threshold:
                    user.locked_until = now + timedelta(minutes=self.settings.lockout_minutes)
                    user.failed_login_count = 0
                    detail2["locked"] = True
                self.audit.record("auth.login", client, success=False, user_id=user.id, detail=detail2)
                self.db.commit()
                raise ServiceError(401, "驗證碼錯誤或已使用過", headers={"X-Totp-Required": "1"})
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

    # ───── 雙因素驗證（TOTP） ─────
    def _secret(self, user: User) -> str | None:
        try:
            return secretbox.open_(user.totp_secret)["s"] if user.totp_secret else None
        except (ValueError, KeyError):
            return None

    def _check_second_factor(self, user: User, code: str) -> bool:
        """6 位數驗證碼（同一個 30 秒週期不能用兩次），或一次性備援碼（用掉就作廢）。"""
        secret = self._secret(user)
        clean = code.strip().replace(" ", "")
        if secret and len(clean) == totp.DIGITS and clean.isdigit():
            self.db.refresh(user)
            step = totp.verify(secret, clean, last_step=user.totp_last_step)
            if step is not None:
                user.totp_last_step = step
                self.db.flush()
                return True
            return False
        norm = totp.normalize_recovery(code)
        self.db.refresh(user)
        hashes = [h for h in (user.totp_recovery or "").split(",") if h]
        if norm and totp.hash_recovery(norm) in hashes:
            hashes.remove(totp.hash_recovery(norm))
            user.totp_recovery = ",".join(hashes)
            self.db.flush()
            return True
        return False

    def totp_status(self, user: User) -> dict[str, object]:
        left = len([h for h in (user.totp_recovery or "").split(",") if h])
        return {"enabled": bool(user.totp_enabled), "recovery_left": left if user.totp_enabled else 0}

    def totp_setup(self, user: User, client: ClientInfo) -> dict[str, str]:
        if user.totp_enabled:
            raise ServiceError(409, "已經開啟雙因素驗證；要重新設定請先關閉")
        secret = totp.new_secret()
        user.totp_secret = secretbox.seal({"s": secret})
        user.totp_last_step = 0
        self.audit.record("auth.totp_setup", client, user_id=user.id)
        self.db.commit()
        return {"secret": secret, "uri": totp.otpauth_uri(secret, user.email)}

    def totp_enable(self, user: User, code: str, client: ClientInfo) -> list[str]:
        secret = self._secret(user)
        if user.totp_enabled or not secret:
            raise ServiceError(409, "請先按「開始設定」取得密鑰")
        step = totp.verify(secret, code, last_step=0)
        if step is None:
            self.audit.record("auth.totp_enable", client, success=False, user_id=user.id)
            self.db.commit()
            raise ServiceError(400, "驗證碼不正確：請確認手機時間正確，輸入驗證 App 上目前顯示的 6 位數")
        codes = totp.new_recovery_codes()
        user.totp_enabled = True
        user.totp_last_step = step
        user.totp_recovery = ",".join(totp.hash_recovery(c) for c in codes)
        self.audit.record("auth.totp_enable", client, user_id=user.id)
        self.db.commit()
        return codes

    def totp_disable(self, user: User, password: str, code: str, client: ClientInfo) -> None:
        if not user.totp_enabled:
            return
        if not verify_password(password, user.password_hash) or not self._check_second_factor(user, code):
            self.audit.record("auth.totp_disable", client, success=False, user_id=user.id)
            self.db.commit()
            raise ServiceError(400, "密碼或驗證碼不正確")
        user.totp_enabled = False
        user.totp_secret = None
        user.totp_recovery = ""
        user.totp_last_step = 0
        self.audit.record("auth.totp_disable", client, user_id=user.id)
        self.db.commit()

    # ───── 再確認身分／刪除帳號 ─────
    def confirm_identity(self, user: User, password: str, totp_code: str | None, client: ClientInfo, action: str) -> None:
        """密碼（有開雙因素驗證時再加驗證碼）都對才放行；錯誤不計入登入鎖定，但有頻率限制（在 API 層）。"""
        if not verify_password(password, user.password_hash):
            self.audit.record(action, client, success=False, user_id=user.id, detail={"reason": "bad_password"})
            self.db.commit()
            raise ServiceError(400, "密碼不正確")
        if user.totp_enabled:
            if not totp_code:
                raise ServiceError(401, "請輸入雙因素驗證碼", headers={"X-Totp-Required": "1"})
            if not self._check_second_factor(user, totp_code):
                self.audit.record(action, client, success=False, user_id=user.id, detail={"reason": "bad_totp"})
                self.db.commit()
                raise ServiceError(401, "驗證碼錯誤或已使用過", headers={"X-Totp-Required": "1"})

    def delete_account(self, user: User, password: str, totp_code: str | None, client: ClientInfo) -> None:
        """刪除帳號與伺服器上的全部資料（帳目同步資料、收件匣、推播、外部通知、AI 用量、登入紀錄）。審計日誌只留不含個資的紀錄。"""
        self.confirm_identity(user, password, totp_code, client, "auth.account_delete")
        if user.role == ROLE_ADMIN and self.users.count_admins() <= 1:
            raise ServiceError(400, "你是唯一的管理員，請先建立另一位管理員，再刪除這個帳號")
        uid = user.id
        self.users.delete(user)  # 其他資料表以外鍵 ON DELETE CASCADE 一併刪除
        self.audit.record("auth.account_delete", client, user_id=uid)
        self.db.commit()
        log.info("使用者自行刪除帳號 id=%s", uid)

    # ───── 已登入的裝置 ─────
    def sessions(self, user: User, current_family: str | None) -> list[SessionOut]:
        now = utcnow()
        out: list[SessionOut] = []
        for row in self.tokens.active_for_user(user.id, now):
            out.append(SessionOut(id=row.family_id, created_at=self.tokens.family_started(row.family_id) or row.created_at, last_active=row.created_at,
                                  ip=row.ip, user_agent=row.user_agent, current=row.family_id == current_family))
        out.sort(key=lambda s: (not s.current, -s.last_active.timestamp()))
        return out

    def revoke_session(self, user: User, family_id: str, current_family: str | None, client: ClientInfo) -> None:
        if family_id == current_family:
            raise ServiceError(400, "這是目前使用的裝置，請用「登出」")
        if not self.tokens.family_owned_by(family_id, user.id):
            raise ServiceError(404, "找不到這個裝置（可能已經登出）")
        self.tokens.revoke_family(family_id, utcnow())
        self.audit.record("auth.session_revoke", client, user_id=user.id, detail={"family": family_id[:8]})
        self.db.commit()

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
            ua = (client.user_agent or "")[:512]
            same_device = (row.user_agent == ua) if (row.user_agent or ua) else (row.ip == client.ip)
            if row.replaced_by and now - row.revoked_at <= REFRESH_REUSE_GRACE and same_device:
                # 良性重複刷新（含行動網路切換 IP）：保留既有家族內的已發權杖，避免競態導致瀏覽器 Cookie 作廢
                pass
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
        # 有啟用雙因素驗證時，變更密碼亦須驗證 TOTP，防範 Session 被劫持時遭更換密碼
        self.confirm_identity(user, req.current_password, req.totp, client, "auth.password_change")
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
