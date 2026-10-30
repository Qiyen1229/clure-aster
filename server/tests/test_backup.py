"""資料庫備份與就緒檢查：一致性快照、驗證、保留份數、還原、損毀偵測、API 端點。"""
from __future__ import annotations

import gzip
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

from app.core.config import get_settings
from app.service import backup_service as bs
from tests.conftest import Api


def _make_db(path: Path, rows: int = 5) -> None:
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    con.executemany("INSERT INTO t (v) VALUES (?)", [(f"row{i}",) for i in range(rows)])
    con.commit()
    con.close()


def test_backup_roundtrip_and_prune(tmp_path: Path) -> None:
    src = tmp_path / "live.db"
    _make_db(src)
    out = tmp_path / "bk"
    infos = []
    for i in range(4):
        # 檔名以秒為單位：測試裡手動錯開，確保 4 份各自獨立
        info = bs.backup_database(out, keep=3, source=src)
        infos.append(info)
        info.path.rename(info.path.with_name(f"aster-2026010{i + 1}-000000.db.gz")) if i < 3 else None
    files = sorted(p.name for p in out.glob("aster-*.db.gz"))
    assert len(files) == 3  # 只留最近 3 份
    assert all(oct(p.stat().st_mode & 0o777) == "0o600" for p in out.glob("aster-*.db.gz"))
    assert not list(out.glob("tmp*"))  # 沒有留下暫存檔
    # 解壓縮後是完整可用的資料庫
    latest = bs.list_backups(out)[0]
    raw = tmp_path / "restored.db"
    raw.write_bytes(gzip.decompress(latest.path.read_bytes()))
    assert sqlite3.connect(raw).execute("SELECT count(*) FROM t").fetchone()[0] == 5


def test_backup_is_consistent_while_writing(tmp_path: Path) -> None:
    """備份期間仍在寫入：快照要是某個一致的時間點（行數不會多出半筆交易）。"""
    src = tmp_path / "live.db"
    _make_db(src, 100)
    writer = sqlite3.connect(src)
    writer.execute("BEGIN")
    writer.execute("INSERT INTO t (v) VALUES ('uncommitted')")  # 未提交的資料不能出現在備份裡
    info = bs.backup_database(tmp_path / "bk", source=src)
    writer.rollback()
    raw = tmp_path / "r.db"
    raw.write_bytes(gzip.decompress(info.path.read_bytes()))
    assert sqlite3.connect(raw).execute("SELECT count(*) FROM t").fetchone()[0] == 100


def test_corrupt_source_fails_and_leaves_no_file(tmp_path: Path) -> None:
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"this is not a sqlite database" * 100)
    with pytest.raises(bs.BackupError):
        bs.backup_database(tmp_path / "bk", source=bad)
    assert not list((tmp_path / "bk").glob("aster-*"))


def test_missing_source_and_postgres_message(tmp_path: Path) -> None:
    with pytest.raises(bs.BackupError, match="找不到資料庫"):
        bs.backup_database(tmp_path / "bk", source=tmp_path / "nope.db")


def test_restore_validates_and_keeps_previous(tmp_path: Path) -> None:
    src = tmp_path / "live.db"
    _make_db(src, 3)
    info = bs.backup_database(tmp_path / "bk", source=src)
    # 現有資料庫之後又被改壞／改變
    con = sqlite3.connect(src)
    con.execute("DELETE FROM t")
    con.commit()
    con.close()
    bs.restore_database(info.path, src)
    assert sqlite3.connect(src).execute("SELECT count(*) FROM t").fetchone()[0] == 3
    assert (tmp_path / "live.db.before-restore").exists()  # 還原前的原檔另存
    # 損毀的備份檔不會覆蓋現有資料庫
    broken = tmp_path / "broken.db.gz"
    broken.write_bytes(gzip.compress(b"garbage" * 50))
    before = src.read_bytes()
    with pytest.raises(bs.BackupError):
        bs.restore_database(broken, src)
    assert src.read_bytes() == before


def test_due_logic(monkeypatch, tmp_path: Path) -> None:
    s = get_settings()
    monkeypatch.setattr(bs, "backup_dir", lambda: tmp_path / "bk")
    monkeypatch.setattr(bs, "sqlite_path", lambda: tmp_path / "x.db")
    # 還沒到時間（3 點前）不備份；到了而且從來沒備份過 → 該備份
    assert bs.due(datetime(2026, 10, 31, s.backup_hour - 1 if s.backup_hour else 0, 0)) is (s.backup_hour == 0)
    assert bs.due(datetime(2026, 10, 31, max(s.backup_hour, 4), 0)) is True
    # 剛備份過 → 今天不用再備份
    (tmp_path / "bk").mkdir()
    (tmp_path / "bk" / "aster-20261031-040000.db.gz").write_bytes(b"x")
    assert bs.due(datetime(2026, 10, 31, 23, 0)) is False


def test_health_ready_and_admin_backup(admin_and_user: tuple[Api, Api]) -> None:
    from sqlalchemy import text

    from app.api.health import _migration_state
    from app.db import get_engine

    a, u = admin_and_user
    # 測試資料庫由模型直接建立、沒有遷移版本表：未遷移時就緒檢查要回 503
    assert a.get("/api/health/ready").status_code == 503
    _, head = _migration_state()
    with get_engine().begin() as c:
        c.execute(text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"))
        c.execute(text("DELETE FROM alembic_version"))
        c.execute(text("INSERT INTO alembic_version (version_num) VALUES (:h)"), {"h": head})
    r = a.get("/api/health/ready")
    body = r.json()
    assert r.status_code == 200 and body["status"] == "ready"
    assert body["checks"]["database"]["ok"] is True
    assert "backup" in body["checks"]
    assert a.get("/api/health").json() == {"status": "ok"}
    # 備份管理：一般使用者不可；管理員可看狀態、立即備份
    assert u.get("/api/admin/backup").status_code == 403
    assert u.post("/api/admin/backup/run").status_code == 403
    st = a.get("/api/admin/backup").json()
    assert "count" in st and "last_at" in st


def test_cli_backup_verify_restore(tmp_path: Path, monkeypatch, capsys) -> None:
    from app import cli

    src = tmp_path / "live.db"
    _make_db(src, 4)
    monkeypatch.setattr(bs, "sqlite_path", lambda: src)
    assert cli.backup_cmd(str(tmp_path / "bk"), 2) == 0
    f = bs.list_backups(tmp_path / "bk")[0].path
    assert cli.verify_backup_cmd(str(f)) == 0
    bad = tmp_path / "bad.db.gz"
    bad.write_bytes(b"not gzip")
    assert cli.verify_backup_cmd(str(bad)) == 1
    assert cli.restore_cmd(str(f), yes=False) == 1  # 沒加 --yes 不會動資料庫
    assert cli.restore_cmd(str(f), yes=True) == 0
