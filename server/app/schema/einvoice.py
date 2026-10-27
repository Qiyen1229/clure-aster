"""手機條碼載具發票查詢的請求／回應模型。"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

# 手機條碼：斜線＋7 碼（數字、大寫英文、. + -）
CARD_NO_PATTERN = r"^/[0-9A-Z.+\-]{7}$"


class EinvoiceStatus(BaseModel):
    configured: bool
    message: str


class CarrierQuery(BaseModel):
    card_no: str = Field(pattern=CARD_NO_PATTERN)
    # 手機條碼驗證碼（財政部 4–16 碼英數字）
    verify_code: str = Field(min_length=4, max_length=16)
    start: date
    end: date
    details: bool = True


class CarrierItem(BaseModel):
    name: str
    quantity: str = ""
    unit_price: str = ""
    amount: str = ""


class CarrierInvoice(BaseModel):
    number: str
    date: str  # YYYY-MM-DD
    time: str = ""
    seller_name: str = ""
    seller_ban: str = ""
    amount: float
    status: str = ""
    items: list[CarrierItem] = []


class CarrierResult(BaseModel):
    invoices: list[CarrierInvoice]
