from __future__ import annotations

import pytest
from app import db as dbmod
from app.core import totp
from app.model import User
from tests.conftest import Api, PASSWORD


def test_change_password_requires_totp_when_enabled(api: Api) -> None:
    r = api.register("totp_user")
    assert r.status_code == 201

    # 啟用 2FA
    setup_r = api.post("/api/auth/2fa/setup")
    assert setup_r.status_code == 200
    secret = setup_r.json()["secret"]
    step = totp.current_step()
    code = totp.code_at(secret, step)
    enable_r = api.post("/api/auth/2fa/enable", {"code": code})
    assert enable_r.status_code == 200

    # 嘗試變更密碼，未提供 TOTP -> 401 X-Totp-Required
    cp_no_totp = api.post("/api/auth/change-password", {"current_password": PASSWORD, "new_password": "NewPassw0rd!123"})
    assert cp_no_totp.status_code == 401
    assert cp_no_totp.headers.get("x-totp-required") == "1"

    # 提供錯誤 TOTP -> 401
    cp_bad_totp = api.post("/api/auth/change-password", {"current_password": PASSWORD, "new_password": "NewPassw0rd!123", "totp": "000000"})
    assert cp_bad_totp.status_code == 401

    # 提供正確 TOTP（下一週期步數，避免同一 30 秒區間重用）
    valid_code = totp.code_at(secret, step + 1)
    cp_ok = api.post("/api/auth/change-password", {"current_password": PASSWORD, "new_password": "NewPassw0rd!123", "totp": valid_code})
    assert cp_ok.status_code == 200


def test_must_change_password_blocks_normal_api(api: Api) -> None:
    r = api.register("pw_reset_user")
    assert r.status_code == 201

    # 設定 must_change_password = True
    for s in dbmod.session_scope():
        u = s.query(User).filter(User.username == "pw_reset_user").one()
        u.must_change_password = True
        s.commit()

    # 一般業務 API (例如同步狀態) 應被阻擋 (403)
    sync_res = api.get("/api/sync/status")
    assert sync_res.status_code == 403
    assert "請先變更密碼" in sync_res.json()["detail"]

    # 取得自身資訊應允許 (200)
    me_res = api.get("/api/auth/me")
    assert me_res.status_code == 200

    # 變更密碼應允許 (200)
    cp_res = api.post("/api/auth/change-password", {"current_password": PASSWORD, "new_password": "BrandNewPass!1"})
    assert cp_res.status_code == 200

    # 變更後再次存取同步 API 應放行 (200)
    sync_ok = api.get("/api/sync/status")
    assert sync_ok.status_code == 200
