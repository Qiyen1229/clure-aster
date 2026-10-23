"""跨裝置同步：sync_records、sync_states

Revision ID: 0002_sync
Revises: 0001_initial
Create Date: 2026-10-11
"""
import sqlalchemy as sa
from alembic import op

revision = "0002_sync"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_records",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("table_name", sa.String(64), nullable=False),
        sa.Column("record_key", sa.String(256), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("payload", sa.Text(), nullable=True),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("server_updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "table_name", "record_key", name="uq_sync_records_user_table_key"),
    )
    op.create_index("ix_sync_records_user_seq", "sync_records", ["user_id", "seq"])
    op.create_table(
        "sync_states",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("last_seq", sa.BigInteger(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("sync_states")
    op.drop_index("ix_sync_records_user_seq", table_name="sync_records")
    op.drop_table("sync_records")
