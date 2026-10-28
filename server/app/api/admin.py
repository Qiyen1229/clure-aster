"""管理後台路由（僅限 admin）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_client, get_db, rate_limit, require_admin
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.admin import (
    AdminUserOut, ResetPasswordResponse, StatsOut, StatusUpdateRequest, SystemSettingsOut, SystemSettingsUpdate, UserListQuery, UserListResponse,
)
from app.core.rate_limit import RateLimiter
from app.schema.ai import AiAdminOut, AiAdminUpdate, AiConsole, TestRequest, TestResult
from app.schema.audit import AuditLogList, AuditQuery
from app.service import app_settings
from app.service.admin_service import AdminService
from app.service.ai_service import AiService
from app.service.audit_service import AuditService
from app.service.stats_service import StatsService

router = APIRouter(prefix="/api/admin", tags=["admin"])
# 連線測試會用掉供應商一次請求，限制頻率避免誤按連點
ai_test_limiter = RateLimiter(6, name="ai-test")


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


@router.get("/settings", response_model=SystemSettingsOut, summary="系統設定")
def get_system_settings(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> SystemSettingsOut:
    return app_settings.read(db)


@router.patch("/settings", response_model=SystemSettingsOut, summary="修改系統設定（開放註冊）")
def update_system_settings(body: SystemSettingsUpdate, admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> SystemSettingsOut:
    return app_settings.update(db, body, admin, client)


@router.get("/ai", response_model=AiAdminOut, summary="AI 額度與供應商狀態")
def get_ai(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> AiAdminOut:
    return AiService(db).admin_read()


@router.patch("/ai", response_model=AiAdminOut, summary="修改 AI 開關與額度")
def update_ai(body: AiAdminUpdate, admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> AiAdminOut:
    return AiService(db).admin_update(body, admin, client)


@router.get("/ai/console", response_model=AiConsole, summary="AI 主控台：供應商連線狀況、用量、各使用者與最近呼叫")
def ai_console(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> AiConsole:
    return AiService(db).console()


@router.post("/ai/test", response_model=TestResult, summary="測試某個 AI 供應商的連線與 Key（不扣使用者額度）")
def ai_test(body: TestRequest, admin: User = Depends(require_admin), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> TestResult:
    rate_limit(ai_test_limiter, str(admin.id))
    return AiService(db).test_provider(body.provider, admin, client)
