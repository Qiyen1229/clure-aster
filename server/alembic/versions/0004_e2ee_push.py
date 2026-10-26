"""端對端加密同步金鑰資訊、Web Push 訂閱與排程

Revision ID: 0004_e2ee_push
Revises: 0003_purge_ratelimit
Create Date: 2026-10-26
"""
import sqlalchemy as sa
from alembic import op

revision = "0004_e2ee_push"
down_revision = "0003_purge_ratelimit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_keys",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("salt", sa.String(64), nullable=False, server_default=""),
        sa.Column("iterations", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("check", sa.Text(), nullable=False, server_default=""),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("endpoint", sa.String(1024), nullable=False),
        sa.Column("p256dh", sa.String(256), nullable=False),
        sa.Column("auth", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_ok_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("endpoint", name="uq_push_subscriptions_endpoint"),
    )
    op.create_index("ix_push_subscriptions_user_id", "push_subscriptions", ["user_id"])
    op.create_table(
        "push_schedules",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("item_id", sa.String(128), nullable=False),
        sa.Column("at", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("body", sa.String(300), nullable=False, server_default=""),
        sa.Column("url", sa.String(256), nullable=False, server_default="/"),
        sa.Column("sent", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("user_id", "device_id", "item_id", name="uq_push_schedules_item"),
    )
    op.create_index("ix_push_schedules_due", "push_schedules", ["sent", "at"])


def downgrade() -> None:
    op.drop_index("ix_push_schedules_due", table_name="push_schedules")
    op.drop_table("push_schedules")
    op.drop_index("ix_push_subscriptions_user_id", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
    op.drop_table("sync_keys")
