"""資料庫備份（SQLite）：一致性快照、完整性驗證、保留最近 N 份、每日自動備份。

- 用 SQLite 的 online backup API：API 運作中也能取得一致的快照（不會複製到寫到一半的檔案）
- 備份完立刻用 PRAGMA integrity_check 驗證，並以 gzip 壓縮；驗證失敗的備份會被刪除並回報失敗，不會默默留下壞檔
- 寫入暫存檔再改名：不會留下半截的備份檔
- PostgreSQL 不在這裡處理（容器內沒有 pg_dump）：見 docs/OPERATIONS.md 的 pg_dump 指令
"""
from __future__ import annotations

import asyncio
import gzip
import logging
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app.core.config import get_settings

log = logging.getLogger("aster.backup")
PREFIX = "aster-"
SUFFIX = ".db.gz"


class BackupError(Exception):
    pass


@dataclass
class BackupInfo:
    path: Path
    created: datetime
    size: int


def sqlite_path() -> Path | None:
    """目前使用的 SQLite 檔案；不是 SQLite 時回傳 None"""
    url = get_settings().sqlalchemy_url
    if not url.startswith("sqlite"):
        return None
    return Path(url.split("sqlite:///", 1)[1])


def backup_dir() -> Path:
    return get_settings().data_dir / "backups"


def list_backups(directory: Path | None = None) -> list[BackupInfo]:
    d = directory or backup_dir()
    if not d.exists():
        return []
    out = [BackupInfo(p, datetime.fromtimestamp(p.stat().st_mtime), p.stat().st_size) for p in d.glob(f"{PREFIX}*{SUFFIX}")]
    return sorted(out, key=lambda b: b.created, reverse=True)


def verify_sqlite(path: Path) -> None:
    """完整性檢查；有問題就丟出 BackupError"""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = con.execute("PRAGMA integrity_check").fetchall()
        if rows != [("ok",)]:
            raise BackupError(f"備份檔完整性檢查失敗：{rows[:3]}")
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except sqlite3.DatabaseError as e:
        raise BackupError(f"備份檔無法開啟：{e}") from e
    finally:
        con.close()


def backup_database(directory: Path | None = None, keep: int | None = None, source: Path | None = None) -> BackupInfo:
    """做一份備份並回傳；失敗丟出 BackupError。keep＝保留最近幾份（預設用設定）"""
    src = source or sqlite_path()
    if src is None:
        raise BackupError("目前使用 PostgreSQL，請改用 pg_dump 備份（見 docs/OPERATIONS.md）")
    if not src.exists():
        raise BackupError(f"找不到資料庫檔案：{src}")
    d = directory or backup_dir()
    d.mkdir(parents=True, exist_ok=True)
    tz = ZoneInfo(get_settings().timezone)
    name = f"{PREFIX}{datetime.now(tz).strftime('%Y%m%d-%H%M%S')}{SUFFIX}"
    final = d / name
    with tempfile.TemporaryDirectory(dir=d) as tmp:
        snap = Path(tmp) / "snapshot.db"
        s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
        t = sqlite3.connect(snap)
        try:
            s.backup(t)  # online backup：一致的快照
        except sqlite3.Error as e:
            raise BackupError(f"無法讀取資料庫（可能已損毀）：{e}") from e
        finally:
            t.close()
            s.close()
        verify_sqlite(snap)
        part = Path(tmp) / "out.gz"
        with snap.open("rb") as fi, gzip.open(part, "wb", compresslevel=6) as fo:
            shutil.copyfileobj(fi, fo)
        shutil.move(str(part), str(final))  # 暫存目錄在備份資料夾內，同一個磁碟：等同改名，不會留下半截的檔案
    final.chmod(0o600)
    prune(d, keep if keep is not None else get_settings().backup_keep)
    st = final.stat()
    log.info("資料庫已備份：%s（%.1f KB）", final.name, st.st_size / 1024)
    return BackupInfo(final, datetime.fromtimestamp(st.st_mtime), st.st_size)


def prune(directory: Path, keep: int) -> int:
    old = list_backups(directory)[keep:]
    for b in old:
        b.path.unlink(missing_ok=True)
    return len(old)


def restore_database(backup_file: Path, target: Path) -> None:
    """把備份還原到 target（請先停止 API）。還原前先驗證備份，並把現有資料庫另存為 .before-restore"""
    if not backup_file.exists():
        raise BackupError(f"找不到備份檔：{backup_file}")
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "restore.db"
        with gzip.open(backup_file, "rb") as fi, raw.open("wb") as fo:
            shutil.copyfileobj(fi, fo)
        verify_sqlite(raw)
        if target.exists():
            shutil.copy2(target, target.with_suffix(target.suffix + ".before-restore"))
        for ext in ("-wal", "-shm"):  # 舊的 WAL 檔不能留著，會和還原後的資料庫對不上
            Path(str(target) + ext).unlink(missing_ok=True)
        shutil.copy2(raw, target)


def status() -> dict[str, object]:
    s = get_settings()
    items = list_backups()
    return {
        "supported": sqlite_path() is not None,
        "enabled": s.backup_daily and sqlite_path() is not None,
        "keep": s.backup_keep,
        "count": len(items),
        "last_at": items[0].created.isoformat() if items else None,
        "last_size": items[0].size if items else 0,
        "directory": str(backup_dir()),
    }


def due(now: datetime | None = None) -> bool:
    """每天 backup_hour 點之後、且最近 20 小時內還沒備份過 → 該備份了"""
    s = get_settings()
    if not s.backup_daily or sqlite_path() is None:
        return False
    now = now or datetime.now(ZoneInfo(s.timezone))
    if now.hour < s.backup_hour:
        return False
    items = list_backups()
    return not items or (datetime.now() - items[0].created).total_seconds() > 20 * 3600


async def backup_loop() -> None:
    """每小時檢查一次（在 FastAPI lifespan 啟動）。備份在執行緒裡做，不卡住 API"""
    while True:
        try:
            if due():
                await asyncio.to_thread(backup_database)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — 備份失敗要記錄，但不能讓迴圈停止
            log.exception("自動備份失敗")
        await asyncio.sleep(3600)
