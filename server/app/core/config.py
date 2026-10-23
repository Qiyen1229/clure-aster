"""應用程式設定：全部由環境變數（前綴 CLURE_）或 .env 讀取。"""
from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CLURE_", env_file=".env", extra="ignore")

    env: Literal["development", "production", "test"] = "production"
    data_dir: Path = Path("./data")
    database_url: str = ""  # 空白時使用 data_dir/clure.db（SQLite）

    jwt_secret: str = ""  # 空白時自動產生並保存在 data_dir/jwt_secret
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = Field(15, ge=1, le=120)
    refresh_token_days: int = Field(14, ge=1, le=90)

    cookie_secure: Literal["auto", "true", "false"] = "auto"
    cookie_samesite: Literal["lax", "strict"] = "lax"

    login_rate_limit_per_minute: int = Field(5, ge=1)
    register_rate_limit_per_minute: int = Field(5, ge=1)
    lockout_threshold: int = Field(5, ge=1)
    lockout_minutes: int = Field(15, ge=1)
    allow_registration: bool = True
    first_user_admin: bool = True  # 系統沒有任何使用者時，第一位註冊者成為管理員
    trust_proxy_headers: bool = True  # 位於 nginx 後方時讀取 X-Real-IP／X-Forwarded-For

    auto_migrate: bool = True  # 啟動（含熱重載）時自動套用資料庫遷移

    timezone: str = "Asia/Taipei"  # 「今日」統計使用的時區
    log_level: str = "INFO"

    # 首次啟動自動建立的管理員（三者皆設定時才會建立）
    admin_username: str = ""
    admin_email: str = ""
    admin_password: str = ""

    @property
    def sqlalchemy_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{(self.data_dir / 'clure.db').resolve()}"

    def resolved_jwt_secret(self) -> str:
        """取得 JWT 金鑰；未設定時產生 64 bytes 隨機值並保存，確保重啟後既有登入仍有效。"""
        if self.jwt_secret:
            return self.jwt_secret
        self.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.data_dir / "jwt_secret"
        if path.exists():
            return path.read_text().strip()
        value = secrets.token_urlsafe(64)
        path.write_text(value)
        path.chmod(0o600)
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
