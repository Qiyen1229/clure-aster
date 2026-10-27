"""手機條碼載具發票：未設定 AppID 時回 503、分月分頁查詢、明細、錯誤碼轉換。"""
from __future__ import annotations

import pytest

from app.core.config import get_settings
from app.service import einvoice_service as svc
from tests.conftest import Api

BODY = {"card_no": "/ABC1234", "verify_code": "secret12", "start": "2026-09-20", "end": "2026-10-05", "details": True}


@pytest.fixture
def mof(monkeypatch):  # noqa: ANN001, ANN201
    calls: list[dict] = []

    def fake_post(params: dict) -> dict:
        calls.append(params)
        if params["action"] == "carrierInvChk":
            if params["startDate"].startswith("2026/09"):
                if params["page"] == "1":
                    return {"code": "996", "details": [{"invNum": "AB11111111", "invDate": {"time": 1790000000000}, "sellerName": "全聯", "amount": "356", "invStatus": "已確認"}]}
                return {"code": "200", "details": [{"invNum": "AB22222222", "invDate": {"year": "126", "month": "8", "date": "30"}, "sellerName": "7-11", "amount": "85", "invStatus": "已確認"}]}
            return {"code": "200", "details": [{"invNum": "CD33333333", "invDate": {"year": "115", "month": "10", "date": "3"}, "sellerName": "星巴克", "amount": "155", "invStatus": "作廢"}]}
        return {"code": "200", "details": [{"description": "拿鐵", "quantity": "1", "unitPrice": "155", "amount": "155"}]}

    monkeypatch.setattr(svc, "_post", fake_post)
    return calls


def test_not_configured(api: Api) -> None:
    api.register("alice")
    assert api.get("/api/einvoice/status").json()["configured"] is False
    assert api.post("/api/einvoice/carrier", BODY).status_code == 503


def test_carrier_query(api: Api, mof, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(get_settings(), "einvoice_app_id", "APP123")
    api.register("alice")
    assert api.get("/api/einvoice/status").json()["configured"] is True
    assert api.post("/api/einvoice/carrier", {**BODY, "card_no": "ABC1234"}).status_code == 422
    r = api.post("/api/einvoice/carrier", BODY)
    assert r.status_code == 200, r.text
    inv = r.json()["invoices"]
    assert [i["number"] for i in inv] == ["AB11111111", "AB22222222", "CD33333333"]
    assert inv[1]["date"] == "2026-09-30" and inv[2]["date"] == "2026-10-03"
    assert inv[0]["amount"] == 356 and inv[2]["items"][0]["name"] == "拿鐵"
    chk = [c for c in mof if c["action"] == "carrierInvChk"]
    # 分月（9 月、10 月）＋ 9 月有第 2 頁
    assert [(c["startDate"], c["endDate"], c["page"]) for c in chk] == [("2026/09/20", "2026/09/30", "1"), ("2026/09/20", "2026/09/30", "2"), ("2026/10/01", "2026/10/05", "1")]
    assert all(c["appID"] == "APP123" and c["cardType"] == "3J0002" and c["cardEncrypt"] == "secret12" for c in mof)
    assert all(int(c["expTimeStamp"]) > int(c["timeStamp"]) for c in mof)
    # 跨月重複的發票只回傳一次
    r2 = api.post("/api/einvoice/carrier", {**BODY, "start": "2026-08-01"}).json()["invoices"]
    assert len(r2) == len({i["number"] for i in r2})


def test_error_codes(api: Api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(get_settings(), "einvoice_app_id", "APP123")
    monkeypatch.setattr(svc, "_post", lambda p: {"code": "919", "msg": "x"})
    api.register("alice")
    r = api.post("/api/einvoice/carrier", BODY)
    assert r.status_code == 400 and "驗證碼" in r.json()["detail"]

