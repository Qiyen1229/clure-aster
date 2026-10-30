"""健康檢查：/api/health 給 Docker／負載平衡器（輕量、永遠快速）；/api/health/ready 給人與監控看（會實際檢查資料庫與遷移、備份狀態）。"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from fastapi import APIRouter, Response
from sqlalchemy import text

router = APIRouter(tags=["health"])
log = logging.getLogger("aster.health")


@router.get("/api/health", summary="健康檢查（輕量）")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _migration_state() -> tuple[str | None, str | None]:
    """（目前版本, 最新版本）"""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    from app.db import get_engine

    root = Path(__file__).resolve().parents[2]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    head = ScriptDirectory.from_config(cfg).get_current_head()
    with get_engine().connect() as c:
        try:
            cur = c.execute(text("SELECT version_num FROM alembic_version")).scalar()
        except Exception:  # noqa: BLE001 — 沒有版本表：還沒遷移
            cur = None
    return cur, head


@router.get("/api/health/ready", summary="就緒檢查：資料庫可讀寫、遷移為最新、備份狀態")
def ready(response: Response) -> dict[str, object]:
    from app.service import backup_service

    checks: dict[str, object] = {}
    ok = True
    t0 = time.perf_counter()
    try:
        from app.db import get_engine

        with get_engine().connect() as c:
            c.execute(text("SELECT 1"))
        checks["database"] = {"ok": True, "ms": round((time.perf_counter() - t0) * 1000, 1)}
    except Exception as e:  # noqa: BLE001
        ok = False
        checks["database"] = {"ok": False, "error": type(e).__name__}
    try:
        cur, head = _migration_state()
        up = cur == head
        ok = ok and up
        checks["migrations"] = {"ok": up, "current": cur, "head": head}
    except Exception as e:  # noqa: BLE001
        ok = False
        checks["migrations"] = {"ok": False, "error": type(e).__name__}
    b = backup_service.status()
    # 備份只是提醒：啟用自動備份卻超過 3 天沒有備份，標示 stale，但不讓就緒檢查失敗
    stale = bool(b["enabled"]) and (not b["last_at"] or (time.time() - _ts(str(b["last_at"]))) > 3 * 86400)
    checks["backup"] = {**{k: b[k] for k in ("supported", "enabled", "count", "last_at")}, "stale": stale}
    if not ok:
        response.status_code = 503
    return {"status": "ready" if ok else "not_ready", "checks": checks}


def _ts(iso: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(iso).timestamp()
