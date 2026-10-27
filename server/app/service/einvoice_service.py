"""財政部電子發票應用 API：以手機條碼＋驗證碼查詢載具發票（表頭與明細）。

規格：電子發票應用 API 規格 Ver 2.0（113 年 5 月）
- 載具發票表頭查詢：POST {base}/PB2CAPIVAN/invServ/InvServ，action=carrierInvChk、version=0.6，可分頁（回應碼 996 代表還有下一頁）
- 載具發票明細查詢：同網址，action=carrierInvDetail、version=0.5
- timeStamp 建議為「現在 + 10～180 秒」（Unix 秒）；查詢區間以單月為單位，最多回溯約 9 個月

伺服器只轉送查詢，不保存手機條碼驗證碼與發票內容；AppID 只放在伺服器 .env，不會送到前端。
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid as uuidlib
from calendar import monthrange
from datetime import date, datetime
from zoneinfo import ZoneInfo

from app.core.config import get_settings
from app.schema.einvoice import CarrierInvoice, CarrierItem, CarrierQuery, CarrierResult, EinvoiceStatus
from app.service.errors import ServiceError

log = logging.getLogger("clure.einvoice")

INV_SERV = "/PB2CAPIVAN/invServ/InvServ"
MAX_PAGES = 20
MAX_DETAILS = 300
# 財政部回應碼 → 使用者看得懂的說明
CODE_MESSAGES = {
    "903": "參數錯誤",
    "919": "手機條碼或驗證碼錯誤",
    "950": "超過財政部查詢次數上限，請稍後再試",
    "951": "財政部連線逾時，請稍後再試",
    "952": "時間戳記過期，請確認伺服器時間正確",
    "997": "裝置識別碼被財政部列入黑名單",
    "998": "伺服器的 AppID 無效（停權或尚未通過審核）",
}


def _post(params: dict[str, str]) -> dict:
    s = get_settings()
    body = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(s.einvoice_api_base.rstrip("/") + INV_SERV, data=body, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 — 固定為財政部網址
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ServiceError(502, f"財政部服務回應錯誤（HTTP {e.code}）") from e
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise ServiceError(502, "無法連線到財政部電子發票平台，請稍後再試") from e


def _common(q: CarrierQuery, device: str) -> dict[str, str]:
    now = int(time.time())
    return {
        "cardType": "3J0002", "cardNo": q.card_no, "cardEncrypt": q.verify_code, "appID": get_settings().einvoice_app_id,
        "timeStamp": str(now + 30), "expTimeStamp": str(now + 180), "uuid": device,
    }


def _check(resp: dict, allow_more: bool = False) -> None:
    code = str(resp.get("code", ""))
    if code == "200" or (allow_more and code == "996"):
        return
    raise ServiceError(400 if code in ("903", "919") else 502, CODE_MESSAGES.get(code, f"財政部回應：{resp.get('msg') or code}"))


def _months(start: date, end: date) -> list[tuple[date, date]]:
    """切成單月區間（財政部以月份為查詢單位）。"""
    out: list[tuple[date, date]] = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        first = date(y, m, 1)
        last = date(y, m, monthrange(y, m)[1])
        out.append((max(first, start), min(last, end)))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _iso(d: dict | str) -> str:
    """發票日期 → YYYY-MM-DD。表頭的 invDate 是物件：以 time（毫秒）換算台灣時間最可靠；
    沒有 time 時，year ≥ 120 視為 Java Date（西元年－1900、月份 0 起算），否則視為民國年。"""
    if isinstance(d, dict):
        if d.get("time"):
            tz = ZoneInfo(get_settings().timezone)
            return datetime.fromtimestamp(int(d["time"]) / 1000, tz).strftime("%Y-%m-%d")
        y, m, day = int(d["year"]), int(d["month"]), int(d["date"])
        if y >= 120:
            return f"{y + 1900:04d}-{m + 1:02d}-{day:02d}"
        return f"{y + 1911:04d}-{m:02d}-{day:02d}"
    s = str(d)
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 and s.isdigit() else s


class EinvoiceService:
    def status(self) -> EinvoiceStatus:
        s = get_settings()
        if s.einvoice_app_id:
            return EinvoiceStatus(configured=True, message="已設定財政部 AppID，可用手機條碼自動記帳")
        return EinvoiceStatus(configured=False, message="伺服器尚未設定財政部電子發票 AppID（CLURE_EINVOICE_APP_ID）")

    def carrier_invoices(self, q: CarrierQuery, user_id: int) -> CarrierResult:
        if not get_settings().einvoice_app_id:
            raise ServiceError(503, self.status().message)
        if q.end < q.start or (q.end - q.start).days > 280:
            raise ServiceError(422, "查詢區間需在 9 個月內")
        # 以使用者 id 衍生固定的裝置識別碼（財政部要求 uuid，用來追蹤濫用）
        device = str(uuidlib.uuid5(uuidlib.NAMESPACE_URL, f"clure-user-{user_id}"))
        out: list[CarrierInvoice] = []
        for a, b in _months(q.start, q.end):
            for page in range(1, MAX_PAGES + 1):
                resp = _post({**_common(q, device), "version": "0.6", "action": "carrierInvChk", "startDate": a.strftime("%Y/%m/%d"),
                              "endDate": b.strftime("%Y/%m/%d"), "onlyWinningInv": "N", "page": str(page)})
                _check(resp, allow_more=True)
                for d in resp.get("details") or []:
                    out.append(CarrierInvoice(
                        number=str(d.get("invNum", "")), date=_iso(d.get("invDate", "")), time=str(d.get("invoiceTime", "")),
                        seller_name=str(d.get("sellerName", "")), seller_ban=str(d.get("sellerBan", "")),
                        amount=float(str(d.get("amount", "0")).replace(",", "") or 0), status=str(d.get("invStatus", "")),
                    ))
                if str(resp.get("code")) != "996":
                    break
        # 分頁或跨月重複出現的同一張發票只留一筆
        seen: set[str] = set()
        out = [i for i in out if i.number and not (i.number in seen or seen.add(i.number))]
        if q.details:
            for inv in out[:MAX_DETAILS]:
                resp = _post({**_common(q, device), "version": "0.5", "action": "carrierInvDetail", "invNum": inv.number,
                              "invDate": inv.date.replace("-", "/"), "sellerName": inv.seller_name, "amount": str(int(inv.amount))})
                if str(resp.get("code")) != "200":
                    continue  # 明細失敗不影響表頭
                inv.items = [CarrierItem(name=str(i.get("description", "")), quantity=str(i.get("quantity", "")),
                                         unit_price=str(i.get("unitPrice", "")), amount=str(i.get("amount", "")))
                             for i in resp.get("details") or []]
        log.info("載具發票查詢 user_id=%s 筆數=%s", user_id, len(out))
        return CarrierResult(invoices=out)
