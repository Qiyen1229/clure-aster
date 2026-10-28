"""匯入所有模型，讓 Base.metadata 與 Alembic 能找到全部資料表。"""
from app.model.ai_usage import AiUsage
from app.model.app_setting import AppSetting
from app.model.audit_log import AuditLog
from app.model.base import Base
from app.model.e2ee_push import PushSchedule, PushSubscription, SyncKey
from app.model.inbox import InboxItem, InboxToken
from app.model.rate_limit import RateLimitHit
from app.model.refresh_token import RefreshToken
from app.model.sync_record import SyncRecord, SyncState
from app.model.user import ROLE_ADMIN, ROLE_USER, User

__all__ = ["AiUsage", "AppSetting", "AuditLog", "Base", "InboxItem", "InboxToken", "PushSchedule", "PushSubscription", "RateLimitHit", "SyncKey", "RefreshToken", "SyncRecord", "SyncState", "User", "ROLE_ADMIN", "ROLE_USER"]
