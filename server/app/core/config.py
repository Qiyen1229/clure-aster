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

    # nginx 的 /proxy/ 報價代理是否只允許已登入的使用者（/api/auth/check）
    proxy_require_login: bool = True

    # 財政部電子發票應用 API（手機條碼載具自動記帳）：需向財政部申請 AppID；自 112 年起僅受理通過 ISO 27001 等認證的企業組織
    einvoice_app_id: str = ""
    einvoice_api_key: str = ""
    einvoice_api_base: str = "https://api.einvoice.nat.gov.tw"

    # ── AI 功能（OpenAI 相容的第三方模型；管理員共用一把 Key，每位使用者有日／週／月免費額度）──
    # 供應商依序嘗試（逗號分隔，可用：gemini、openrouter、nvidia、custom）；一家失敗、限流或逾時就換下一家。沒設 Key 的會自動略過。
    ai_providers: str = "nvidia,gemini,openrouter,custom"
    # Google Gemini（AI Studio 免費 Key：https://aistudio.google.com/apikey）。模型名稱用 *-latest 別名，不怕舊型號下架
    ai_gemini_api_key: str = ""
    vapid_subject: str = ""  # Web Push 的 VAPID sub（mailto: 或 https:），空白用預設
    ai_gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    ai_gemini_model: str = "gemini-flash-lite-latest"
    ai_openrouter_api_key: str = ""
    ai_openrouter_base_url: str = "https://openrouter.ai/api/v1"
    ai_openrouter_model: str = "google/gemma-4-31b-it:free"
    # NVIDIA NIM（https://build.nvidia.com）。預設 Nemotron 3.5 Super VL：推理模型，程式會自動帶 enable_thinking=false 關掉思考輸出。
    # 免費模型常下架；若回 404／410，請到網站挑一個目前可用的填入 CLURE_AI_NVIDIA_MODEL
    ai_nvidia_api_key: str = ""
    ai_nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    ai_nvidia_model: str = "nvidia/nemotron-3.5-super-vl-120b-a12b"
    ai_custom_api_key: str = ""
    ai_custom_base_url: str = ""
    ai_custom_model: str = ""
    # 每個供應商可以額外帶的請求參數（JSON 物件，會合併進 chat/completions 的請求本文），例如關閉推理模型的思考：
    #   {"chat_template_kwargs": {"enable_thinking": false}}；也可以覆寫 temperature、top_p。留空＝使用內建預設
    ai_gemini_extra_body: str = ""
    ai_openrouter_extra_body: str = ""
    ai_nvidia_extra_body: str = ""
    ai_custom_extra_body: str = ""
    ai_timeout_seconds: int = Field(30, ge=3, le=120)
    # 額度預設值（管理後台改過就以後台為準）：每位使用者的日／週／月上限，以及全站每日上限（保護上游免費額度；0＝不限）。
    # 免費層的每日上限以 Google AI Studio 的 Rate limit 頁面為準（會變動），全站每日上限請設在它以內
    ai_user_daily: int = Field(30, ge=0)
    ai_user_weekly: int = Field(120, ge=0)
    ai_user_monthly: int = Field(400, ge=0)
    ai_global_daily: int = Field(100, ge=0)
    # 管理員的額度與一般使用者分開計算（管理員常用來測試與設定，通常需要比較多）
    ai_admin_daily: int = Field(60, ge=0)
    ai_admin_weekly: int = Field(300, ge=0)
    ai_admin_monthly: int = Field(1000, ge=0)
    # 全站每分鐘最多幾次（免費層通常只有每分鐘 5～15 次）；0＝不限
    ai_global_per_minute: int = Field(8, ge=0)

    # 寄信（忘記密碼、管理員測試信）。smtp_host 空白＝未設定寄信功能
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""  # 寄件人，空白用 smtp_user
    smtp_security: str = "starttls"  # starttls（587）｜ssl（465）｜none
    public_url: str = ""  # 信中連結用的網址，例如 https://aster.example.com（不設就無法寄重設連結，避免被偽造 Host 標頭）
    admin_contact_email: str = "giter003@gmail.com"  # 忘記密碼時請使用者聯絡的管理員信箱（未設定寄信功能時使用）
    reset_token_minutes: int = Field(30, ge=5, le=1440)
    email_check_dns: bool = True  # 註冊時檢查信箱網域真的有收信伺服器（MX）

    # 資料庫自動備份（只支援 SQLite；PostgreSQL 請用 pg_dump，見 docs/OPERATIONS.md）
    backup_daily: bool = True
    backup_keep: int = Field(7, ge=1, le=90)  # 保留最近幾份
    backup_hour: int = Field(3, ge=0, le=23)  # 每天幾點之後做（本機時區 CLURE_TIMEZONE）

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


def security_warnings() -> list[str]:
    """給管理員後台顯示的設定提醒。"""
    s = get_settings()
    out: list[str] = []
    if s.first_user_admin:
        out.append("CLURE_FIRST_USER_ADMIN 仍為 true：已建立管理員後建議改為 false")
    if "change-me" in s.database_url:
        out.append("PostgreSQL 密碼仍是預設值 change-me")
    if s.cookie_secure == "false":
        out.append("Cookie 未強制 Secure：對外服務請放在 HTTPS 後面並設為 auto 或 true")
    return out
