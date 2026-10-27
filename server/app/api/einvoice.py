"""手機條碼載具發票（財政部電子發票應用 API）。需登入；查詢用 POST，驗證碼不會出現在網址與存取日誌。"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_current_user, rate_limit
from app.core.rate_limit import RateLimiter
from app.model import User
from app.schema.einvoice import CarrierQuery, CarrierResult, EinvoiceStatus
from app.service.einvoice_service import EinvoiceService

router = APIRouter(prefix="/api/einvoice", tags=["einvoice"])
# 財政部有流量管制；每位使用者每分鐘最多 6 次查詢就夠用
carrier_limiter = RateLimiter(6, name="einvoice")


@router.get("/status", response_model=EinvoiceStatus, summary="是否已設定財政部 AppID")
def status(_: User = Depends(get_current_user)) -> EinvoiceStatus:
    return EinvoiceService().status()


@router.post("/carrier", response_model=CarrierResult, summary="查詢手機條碼載具發票")
def carrier(body: CarrierQuery, user: User = Depends(get_current_user)) -> CarrierResult:
    rate_limit(carrier_limiter, str(user.id))
    return EinvoiceService().carrier_invoices(body, user.id)
