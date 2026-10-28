"""AI 呼叫紀錄（日／週／月額度）

Revision ID: 0007_ai_usage
Revises: 0006_app_settings
Create Date: 2026-10-28
"""
import sqlalchemy as sa
from alembic import op

revision = "0007_ai_usage"
down_revision = "0006_app_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_usage",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False, server_default=""),
        sa.Column("model", sa.String(100), nullable=False, server_default=""),
        sa.Column("cost", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("pending", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index("ix_ai_usage_created_at", "ai_usage", ["created_at"])
    op.create_index("ix_ai_usage_user_created", "ai_usage", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_ai_usage_user_created", "ai_usage")
    op.drop_index("ix_ai_usage_created_at", "ai_usage")
    op.drop_table("ai_usage")
