"""同步墓碑清除點、資料庫頻率限制

Revision ID: 0003_purge_ratelimit
Revises: 0002_sync
Create Date: 2026-10-26
"""
import sqlalchemy as sa
from alembic import op

revision = "0003_purge_ratelimit"
down_revision = "0002_sync"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sync_states") as b:
        b.add_column(sa.Column("purged_seq", sa.BigInteger(), nullable=False, server_default="0"))
    op.create_table(
        "rate_limits",
        sa.Column("key", sa.String(200), primary_key=True),
        sa.Column("window_start", sa.BigInteger(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_sync_records_user_deleted", "sync_records", ["user_id", "deleted", "server_updated_at"])


def downgrade() -> None:
    op.drop_index("ix_sync_records_user_deleted", table_name="sync_records")
    op.drop_table("rate_limits")
    with op.batch_alter_table("sync_states") as b:
        b.drop_column("purged_seq")
