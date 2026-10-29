"""管理員業務邏輯：使用者列表、凍結／啟用、強制登出、重設密碼。所有操作寫入審計日誌。"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.core.request_info import ClientInfo
from app.core.security import generate_temporary_password, hash_password, utcnow
from app.model import User
from app.repository.token_repository import TokenRepository
from app.repository.user_repository import UserRepository
from app.core.config import get_settings
from app.core.mailer import MailError, mail_configured, send_mail
from app.model import ROLE_ADMIN, ROLE_USER
from app.schema.auth import check_email_domain
from app.schema.admin import AdminUserOut, CreateUserRequest, CreateUserResponse, MailStatus, ResetPasswordResponse, StatusUpdateRequest, UserListQuery, UserListResponse
from app.service.audit_service import AuditService
from app.service.errors import ServiceError

log = logging.getLogger("aster.admin")


class AdminService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.users = UserRepository(db)
        self.tokens = TokenRepository(db)
        self.audit = AuditService(db)

    def _target(self, user_id: int) -> User:
        user = self.users.get(user_id)
        if not user:
            raise ServiceError(404, "找不到此使用者")
        return user

    def list_users(self, q: UserListQuery, admin: User, client: ClientInfo) -> UserListResponse:
        rows, total = self.users.search(q=q.q, status=q.status, role=q.role, now=utcnow(), page=q.page, size=q.size)
        self.audit.record("admin.user_list_view", client, actor_id=admin.id, detail={"q": q.q or "", "page": q.page})
        self.db.commit()
        return UserListResponse(items=[AdminUserOut.model_validate(u) for u in rows], total=total, page=q.page, size=q.size)

    def set_status(self, user_id: int, req: StatusUpdateRequest, admin: User, client: ClientInfo) -> AdminUserOut:
        user = self._target(user_id)
        if user.id == admin.id and not req.is_active:
            raise ServiceError(400, "不能凍結自己的帳號")
        now = utcnow()
        user.is_active = req.is_active
        if req.is_active:
            user.locked_until = None
            user.failed_login_count = 0
        else:
            user.token_version += 1
            self.tokens.revoke_all_for_user(user.id, now)
        self.audit.record("admin.user_unfreeze" if req.is_active else "admin.user_freeze", client, user_id=user.id, actor_id=admin.id,
                          detail={"reason": req.reason or ""})
        self.db.commit()
        log.info("管理員 %s %s 使用者 %s", admin.id, "啟用" if req.is_active else "凍結", user.id)
        return AdminUserOut.model_validate(user)

    def force_logout(self, user_id: int, admin: User, client: ClientInfo) -> AdminUserOut:
        user = self._target(user_id)
        user.token_version += 1
        self.tokens.revoke_all_for_user(user.id, utcnow())
        self.audit.record("admin.force_logout", client, user_id=user.id, actor_id=admin.id)
        self.db.commit()
        return AdminUserOut.model_validate(user)

    def reset_password(self, user_id: int, admin: User, client: ClientInfo) -> ResetPasswordResponse:
        user = self._target(user_id)
        temp = generate_temporary_password()
        now = utcnow()
        user.password_hash = hash_password(temp)
        user.password_changed_at = now
        user.must_change_password = True
        user.locked_until = None
        user.failed_login_count = 0
        user.token_version += 1
        self.tokens.revoke_all_for_user(user.id, now)
        self.audit.record("admin.password_reset", client, user_id=user.id, actor_id=admin.id)  # 不記錄臨時密碼
        self.db.commit()
        return ResetPasswordResponse(temporary_password=temp, message="臨時密碼只會顯示這一次，使用者登入後必須立即變更密碼")

    def create_user(self, req: CreateUserRequest, admin: User, client: ClientInfo) -> CreateUserResponse:
        """管理員直接建立帳號（不受「開放註冊」開關影響）。第一次登入必須改密碼。"""
        if self.users.get_by_username(req.username) or self.users.get_by_email(req.email):
            raise ServiceError(409, "使用者名稱或 Email 已被使用")
        try:
            check_email_domain(req.email)
        except ValueError as e:
            raise ServiceError(422, str(e)) from e
        if req.password and req.password.lower() == req.username.lower():
            raise ServiceError(422, "密碼不可與使用者名稱相同")
        temp = None if req.password else generate_temporary_password()
        now = utcnow()
        user = self.users.add(User(
            username=req.username, email=req.email, password_hash=hash_password(req.password or temp or ""),
            role=ROLE_ADMIN if req.role == "admin" else ROLE_USER, must_change_password=True, password_changed_at=now,
        ))
        self.audit.record("admin.user_create", client, user_id=user.id, actor_id=admin.id, detail={"role": user.role})  # 不記錄密碼
        self.db.commit()
        log.info("管理員 %s 建立使用者 %s role=%s", admin.id, user.id, user.role)
        return CreateUserResponse(user=AdminUserOut.model_validate(user), temporary_password=temp,
                                  message="帳號已建立，對方第一次登入時必須設定新密碼" + ("；臨時密碼只會顯示這一次" if temp else ""))

    def mail_status(self) -> MailStatus:
        s = get_settings()
        return MailStatus(configured=mail_configured(), host=s.smtp_host, sender=s.smtp_from or s.smtp_user, public_url=s.public_url, dns_check=s.email_check_dns)

    def send_test_mail(self, to: str, admin: User, client: ClientInfo) -> str:
        try:
            send_mail(to, "Aster 記帳：測試信", "收到這封信代表 Aster 的寄信設定正確，忘記密碼功能可以使用。\n")
        except MailError as e:
            self.audit.record("admin.mail_test", client, success=False, actor_id=admin.id)
            self.db.commit()
            raise ServiceError(502, str(e)) from e
        self.audit.record("admin.mail_test", client, actor_id=admin.id)
        self.db.commit()
        return f"測試信已寄到 {to}，請到信箱確認（也看看垃圾郵件）"
