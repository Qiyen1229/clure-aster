"""對外通知通道（Discord／Telegram／LINE／Webhook）

Revision ID: 0009_notify_channels
Revises: 0008_password_resets
Create Date: 2026-10-31
"""
import sqlalchemy as sa
from alembic import op

revision = "0009_notify_channels"
down_revision = "0008_password_resets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notify_channels",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("secret", sa.Text(), nullable=False),
        sa.Column("hint", sa.String(80), nullable=False, server_default=""),
        sa.Column("events", sa.String(120), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_ok_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_notify_channels_user_id", "notify_channels", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_notify_channels_user_id", table_name="notify_channels")
    op.drop_table("notify_channels")
