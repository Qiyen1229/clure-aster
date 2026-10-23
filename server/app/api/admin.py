"""管理後台路由（僅限 admin）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_client, get_db, require_admin
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.admin import AdminUserOut, ResetPasswordResponse, StatsOut, StatusUpdateRequest, UserListQuery, UserListResponse
from app.schema.audit import AuditLogList, AuditQuery
from app.service.admin_service import AdminService
from app.service.audit_service import AuditService
from app.service.stats_service import StatsService

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/stats", response_model=StatsOut, summary="系統統計")
def stats(admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> StatsOut:
    return StatsService(db).overview(admin, client)


@router.get("/users", response_model=UserListResponse, summary="使用者列表")
def list_users(q: UserListQuery = Depends(), admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> UserListResponse:
    return AdminService(db).list_users(q, admin, client)


@router.patch("/users/{user_id}/status", response_model=AdminUserOut, summary="凍結／啟用帳號")
def set_status(user_id: int, body: StatusUpdateRequest, admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> AdminUserOut:
    return AdminService(db).set_status(user_id, body, admin, client)


@router.post("/users/{user_id}/force-logout", response_model=AdminUserOut, summary="強制登出")
def force_logout(user_id: int, admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> AdminUserOut:
    return AdminService(db).force_logout(user_id, admin, client)


@router.post("/users/{user_id}/reset-password", response_model=ResetPasswordResponse, summary="重設密碼")
def reset_password(user_id: int, admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> ResetPasswordResponse:
    return AdminService(db).reset_password(user_id, admin, client)


@router.get("/audit-logs", response_model=AuditLogList, summary="資安審計日誌")
def audit_logs(q: AuditQuery = Depends(), admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> AuditLogList:
    svc = AuditService(db)
    result = svc.search(q)
    if q.page == 1:  # 只在第一頁記錄一次「查看審計日誌」，避免翻頁灌爆日誌
        svc.record("admin.audit_view", client, actor_id=admin.id, detail={"action": q.action or ""})
        db.commit()
    return result
