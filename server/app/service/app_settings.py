"""系統設定：管理後台改過的值優先，沒改過就沿用 .env（CLURE_ALLOW_REGISTRATION 等）。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.request_info import ClientInfo
from app.model import AppSetting, User
from app.schema.admin import SystemSettingsOut, SystemSettingsUpdate
from app.service.audit_service import AuditService

REGISTRATION = "allow_registration"


def registration_open(db: Session, settings: Settings | None = None) -> bool:
    row = db.get(AppSetting, REGISTRATION)
    if row is not None:
        return row.value == "1"
    return (settings or get_settings()).allow_registration


def read(db: Session) -> SystemSettingsOut:
    s = get_settings()
    return SystemSettingsOut(
        allow_registration=registration_open(db, s),
        allow_registration_default=s.allow_registration,
        allow_registration_overridden=db.get(AppSetting, REGISTRATION) is not None,
    )


def update(db: Session, body: SystemSettingsUpdate, admin: User, client: ClientInfo) -> SystemSettingsOut:
    if body.allow_registration is not None:
        row = db.get(AppSetting, REGISTRATION)
        value = "1" if body.allow_registration else "0"
        if row is None:
            db.add(AppSetting(key=REGISTRATION, value=value))
        else:
            row.value = value
        AuditService(db).record("admin.settings", client, actor_id=admin.id, detail={REGISTRATION: body.allow_registration})
    db.commit()
    return read(db)
