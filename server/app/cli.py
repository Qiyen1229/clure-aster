"""指令列工具（在後端主機或容器內執行）：

  建立或提升管理員（互動輸入密碼）：
    python -m app.cli create-admin --username admin --email admin@example.com
  非互動（例如自動化部署）：先設定環境變數 CLURE_NEW_PASSWORD 再執行上面的指令
  刪除使用者（不可刪除最後一位管理員）：
    python -m app.cli delete-user --username olduser
  列出使用者：
    python -m app.cli list-users
所有變更都會寫入審計日誌（IP 記為 cli）。
"""
from __future__ import annotations

import argparse
import getpass
import logging
import os
import sys

from email_validator import EmailNotValidError, validate_email

from app.core.logging import mask_email, setup_logging
from app.core.request_info import ClientInfo
from app.core.security import hash_password, utcnow
from app.db import session_scope
from app.model import ROLE_ADMIN, User
from app.repository.token_repository import TokenRepository
from app.repository.user_repository import UserRepository
from app.schema.auth import USERNAME_RE, validate_password_strength
from app.service.audit_service import AuditService

log = logging.getLogger("clure.cli")
CLI_CLIENT = ClientInfo(ip="cli", user_agent="clure-cli")


def _read_password() -> str | None:
    env = os.environ.get("CLURE_NEW_PASSWORD")
    if env:
        return env
    pw = getpass.getpass("管理員密碼：")
    if pw != getpass.getpass("再輸入一次："):
        log.error("兩次輸入的密碼不一致")
        return None
    return pw


def create_admin(username: str, email: str) -> int:
    if not USERNAME_RE.match(username):
        log.error("使用者名稱只能使用英文、數字、底線、點與連字號（3–32 字元）")
        return 1
    try:
        email = validate_email(email, check_deliverability=False).normalized.lower()
    except EmailNotValidError:
        log.error("Email 格式不正確")
        return 1
    password = _read_password()
    if password is None:
        return 1
    try:
        validate_password_strength(password)
        if password.lower() == username.lower():
            raise ValueError("密碼不可與使用者名稱相同")
    except ValueError as e:
        log.error("%s", e)
        return 1
    for db in session_scope():
        repo = UserRepository(db)
        existing = repo.get_by_username(username)
        other = repo.get_by_email(email)
        if other and (not existing or other.id != existing.id):
            log.error("Email 已被其他帳號使用")
            return 1
        now = utcnow()
        if existing:
            existing.role = ROLE_ADMIN
            existing.email = email
            existing.password_hash = hash_password(password)
            existing.password_changed_at = now
            existing.is_active = True
            existing.locked_until = None
            existing.failed_login_count = 0
            existing.must_change_password = False
            existing.token_version += 1
            TokenRepository(db).revoke_all_for_user(existing.id, now)
            user = existing
            log.info("已將既有使用者 %s 設為管理員並更新密碼", username)
        else:
            user = repo.add(User(username=username, email=email, password_hash=hash_password(password), role=ROLE_ADMIN, password_changed_at=now))
            log.info("已建立管理員 %s（%s）", username, mask_email(email))
        AuditService(db).record("admin.cli_create_admin", CLI_CLIENT, user_id=user.id, detail={"username": username})
        db.commit()
    return 0


def delete_user(username: str) -> int:
    for db in session_scope():
        repo = UserRepository(db)
        user = repo.get_by_username(username)
        if not user:
            log.error("找不到使用者 %s", username)
            return 1
        if user.role == ROLE_ADMIN and repo.count_admins() <= 1:
            log.error("不能刪除最後一位管理員，請先建立另一位管理員")
            return 1
        uid = user.id
        repo.delete(user)
        AuditService(db).record("admin.cli_delete_user", CLI_CLIENT, user_id=uid, detail={"username": username})
        db.commit()
        log.info("已刪除使用者 %s（id=%s）", username, uid)
    return 0


def list_users() -> int:
    from sqlalchemy import select
    for db in session_scope():
        for u in db.scalars(select(User).order_by(User.id)):
            log.info("id=%s username=%s email=%s role=%s active=%s", u.id, u.username, mask_email(u.email), u.role, u.is_active)
    return 0


def main() -> int:
    setup_logging()
    p = argparse.ArgumentParser(prog="clure")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-admin", help="建立或提升管理員（密碼可用環境變數 CLURE_NEW_PASSWORD 提供）")
    c.add_argument("--username", required=True)
    c.add_argument("--email", required=True)
    d = sub.add_parser("delete-user", help="刪除使用者（不可刪除最後一位管理員）")
    d.add_argument("--username", required=True)
    sub.add_parser("list-users", help="列出使用者")
    args = p.parse_args()
    if args.cmd == "create-admin":
        return create_admin(args.username, args.email)
    if args.cmd == "delete-user":
        return delete_user(args.username)
    if args.cmd == "list-users":
        return list_users()
    return 1


if __name__ == "__main__":
    sys.exit(main())
