"""ORM 基底類別。所有時間欄位以 UTC（naive）儲存。"""
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
