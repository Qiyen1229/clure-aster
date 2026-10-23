"""資料庫 Engine 與 Session 工廠。SQLite 時啟用 WAL 與外鍵約束。"""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def _make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False}, pool_pre_ping=True)

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA busy_timeout=5000")
            cur.close()

        return engine
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=10)


def get_engine() -> Engine:
    global _engine, _SessionLocal
    if _engine is None:
        _engine = _make_engine(get_settings().sqlalchemy_url)
        _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def configure(url: str) -> Engine:
    """測試用：改用指定資料庫。"""
    global _engine, _SessionLocal
    _engine = _make_engine(url)
    _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def session_scope() -> Iterator[Session]:
    """每個請求一個 Session；成功提交、例外回滾。"""
    get_engine()
    assert _SessionLocal is not None
    db = _SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
