"""標準 logging 設定與脫敏工具。全專案禁止 print，並且不得記錄密碼、權杖。"""
from __future__ import annotations

import logging
import re

_EMAIL = re.compile(r"^([^@]{1})[^@]*(@.+)$")


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # uvicorn 存取日誌含查詢字串，交由 nginx 記錄即可
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def mask_email(email: str | None) -> str:
    """a***@example.com"""
    if not email:
        return ""
    return _EMAIL.sub(r"\1***\2", email)
