"""AI 功能（需登入）。額度與供應商鏈見 service/ai_quota.py、service/ai_providers.py。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, rate_limit
from app.core.rate_limit import RateLimiter
from app.model import User
from app.schema.ai import AiStatus, ParseEntryRequest, ParseEntryResult
from app.service.ai_service import AiService

router = APIRouter(prefix="/api/ai", tags=["ai"])
# 額度之外再加一道每分鐘上限，擋掉程式誤觸發的連續請求
ai_limiter = RateLimiter(10, name="ai")


@router.get("/status", response_model=AiStatus, summary="AI 是否可用與目前額度")
def status(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> AiStatus:
    return AiService(db).status(user)


@router.post("/parse-entry", response_model=ParseEntryResult, summary="一句話記帳的 AI 解析（規則解析失敗時的後備）")
def parse_entry(body: ParseEntryRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ParseEntryResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).parse_entry(user, body)
