"""取得客戶端 IP 與 User-Agent（供頻率限制與審計日誌使用）。"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from app.core.config import get_settings


@dataclass(frozen=True)
class ClientInfo:
    ip: str
    user_agent: str


def client_info(request: Request) -> ClientInfo:
    ip = request.client.host if request.client else "unknown"
    if get_settings().trust_proxy_headers:
        real = request.headers.get("x-real-ip")
        fwd = request.headers.get("x-forwarded-for")
        if real:
            ip = real.strip()
        elif fwd:
            ip = fwd.split(",")[0].strip()
    ua = (request.headers.get("user-agent") or "")[:512]
    return ClientInfo(ip=ip[:64], user_agent=ua)
