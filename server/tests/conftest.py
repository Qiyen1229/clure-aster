"""測試設定：每個測試使用全新的 SQLite 資料庫與乾淨的頻率限制。"""
from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

import pytest

_tmp = tempfile.mkdtemp(prefix="aster-test-")
os.environ.update({
    "CLURE_ENV": "test",
    "CLURE_DATA_DIR": _tmp,
    "CLURE_JWT_SECRET": "test-secret-" + "x" * 48,
    "CLURE_LOCKOUT_THRESHOLD": "5",
    "CLURE_EMAIL_CHECK_DNS": "false",
    "CLURE_PUBLIC_URL": "https://aster.test",
    "CLURE_LOGIN_RATE_LIMIT_PER_MINUTE": "5",
})

from fastapi.testclient import TestClient  # noqa: E402

from app import db as dbmod  # noqa: E402
from app.api.deps import reset_rate_limits  # noqa: E402
from app.main import app  # noqa: E402
from app.model import Base  # noqa: E402

PASSWORD = "Passw0rd!x"


@pytest.fixture(autouse=True)
def fresh_db(tmp_path) -> Iterator[None]:
    engine = dbmod.configure(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    reset_rate_limits()
    yield
    engine.dispose()


class Api:
    """包裝 TestClient：自動帶 CSRF 標頭。"""

    def __init__(self, ip: str = "10.0.0.1") -> None:
        self.c = TestClient(app, headers={"X-Real-IP": ip, "User-Agent": "pytest"})
        self.c.get("/api/health")  # 取得 csrf_token Cookie

    def _h(self) -> dict[str, str]:
        return {"X-CSRF-Token": self.c.cookies.get("csrf_token") or ""}

    def get(self, url: str, **kw):  # noqa: ANN003, ANN201
        return self.c.get(url, **kw)

    def post(self, url: str, json=None, **kw):  # noqa: ANN001, ANN003, ANN201
        return self.c.post(url, json=json, headers=self._h(), **kw)

    def patch(self, url: str, json=None, **kw):  # noqa: ANN001, ANN003, ANN201
        return self.c.patch(url, json=json, headers=self._h(), **kw)

    def register(self, username: str, email: str | None = None, password: str = PASSWORD):  # noqa: ANN201
        return self.post("/api/auth/register", {"username": username, "email": email or f"{username}@example.com", "password": password})

    def login(self, identifier: str, password: str = PASSWORD):  # noqa: ANN201
        return self.post("/api/auth/login", {"identifier": identifier, "password": password})


@pytest.fixture
def api() -> Api:
    return Api()


@pytest.fixture
def admin_and_user() -> tuple[Api, Api]:
    """第一位註冊者成為管理員；第二位為一般使用者。"""
    a = Api("10.0.0.2")
    assert a.register("admin").status_code == 201
    u = Api("10.0.0.3")
    assert u.register("alice").status_code == 201
    return a, u
