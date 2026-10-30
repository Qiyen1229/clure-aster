"""AI 功能（需登入）。額度與供應商鏈見 service/ai_quota.py、service/ai_providers.py。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, rate_limit
from app.core.rate_limit import RateLimiter
from app.model import User
from app.schema.ai import (
    AiStatus, AskRequest, AskResult, BudgetPlanRequest, BudgetPlanResult, CategorizeRequest, CategorizeResult, ExplainRequest, InsightsRequest,
    InsightsResult, ParseEntryRequest, ParseEntryResult, PriceCheckRequest, PriceCheckResult, ReceiptRequest, SearchPlanRequest, SearchPlanResult,
)
from app.service.ai_service import AiService

router = APIRouter(prefix="/api/ai", tags=["ai"])
# 額度之外再加一道每分鐘上限，擋掉程式誤觸發的連續請求
ai_limiter = RateLimiter(10, name="ai")
# 新支出的市價檢查由 App 自動觸發（不計額度），另設每人每分鐘上限，避免程式誤觸發或批次匯入時狂打
price_limiter = RateLimiter(20, name="ai-price")


@router.get("/status", response_model=AiStatus, summary="AI 是否可用與目前額度")
def status(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> AiStatus:
    return AiService(db).status(user)


@router.post("/parse-entry", response_model=ParseEntryResult, summary="一句話記帳的 AI 解析（規則解析失敗時的後備）")
def parse_entry(body: ParseEntryRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ParseEntryResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).parse_entry(user, body)


@router.post("/ask", response_model=AskResult, summary="問 AI：依去識別化的收支摘要回答理財問題")
def ask(body: AskRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> AskResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).ask(user, body)


@router.post("/budget-plan", response_model=BudgetPlanResult, summary="下個月預算建議")
def budget_plan(body: BudgetPlanRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> BudgetPlanResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).budget_plan(user, body)


@router.post("/insights", response_model=InsightsResult, summary="週報／月報的白話洞察")
def insights(body: InsightsRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> InsightsResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).insights(user, body)


@router.post("/categorize", response_model=CategorizeResult, summary="替一批帳目備註建議分類")
def categorize(body: CategorizeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> CategorizeResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).categorize(user, body)


@router.post("/receipt", response_model=ParseEntryResult, summary="拍照記帳：辨識收據照片（扣 2 點額度）")
def receipt(body: ReceiptRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ParseEntryResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).receipt(user, body)


@router.post("/search-plan", response_model=SearchPlanResult, summary="搜尋：把一句話描述轉成搜尋條件")
def search_plan(body: SearchPlanRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> SearchPlanResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).search_plan(user, body)


@router.post("/explain", response_model=InsightsResult, summary="某個專案／帳戶／分類的白話解說")
def explain(body: ExplainRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> InsightsResult:
    rate_limit(ai_limiter, str(user.id))
    return AiService(db).explain(user, body)


@router.post("/price-check", response_model=PriceCheckResult, summary="新支出的市價檢查（不計額度，由 App 自動觸發）")
def price_check(body: PriceCheckRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> PriceCheckResult:
    rate_limit(price_limiter, str(user.id))
    return AiService(db).price_check(user, body)
