"""業務層錯誤：由 api 層轉換為 HTTP 回應。訊息為繁體中文、不含內部細節。"""
from __future__ import annotations


class ServiceError(Exception):
    def __init__(self, status_code: int, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.headers = headers or {}
