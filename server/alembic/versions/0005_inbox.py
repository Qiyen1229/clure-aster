"""收件匣：捷徑專用權杖與待記帳項目

Revision ID: 0005_inbox
Revises: 0004_e2ee_push
Create Date: 2026-10-28
"""
import sqlalchemy as sa
from alembic import op

revision = "0005_inbox"
down_revision = "0004_e2ee_push"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "inbox_tokens",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("hint", sa.String(8), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_inbox_tokens_user_id", "inbox_tokens", ["user_id"])
    op.create_index("ix_inbox_tokens_token_hash", "inbox_tokens", ["token_hash"], unique=True)
    op.create_table(
        "inbox_items",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_id", sa.Integer(), sa.ForeignKey("inbox_tokens.id", ondelete="SET NULL"), nullable=True),
        sa.Column("source", sa.String(16), nullable=False, server_default="other"),
        sa.Column("text", sa.String(1000), nullable=False, server_default=""),
        sa.Column("amount", sa.String(40), nullable=False, server_default=""),
        sa.Column("merchant", sa.String(120), nullable=False, server_default=""),
        sa.Column("card", sa.String(80), nullable=False, server_default=""),
        sa.Column("occurred", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_inbox_items_user_id", "inbox_items", ["user_id"])
    op.create_index("ix_inbox_items_created_at", "inbox_items", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_inbox_items_created_at", table_name="inbox_items")
    op.drop_index("ix_inbox_items_user_id", table_name="inbox_items")
    op.drop_table("inbox_items")
    op.drop_index("ix_inbox_tokens_token_hash", table_name="inbox_tokens")
    op.drop_index("ix_inbox_tokens_user_id", table_name="inbox_tokens")
    op.drop_table("inbox_tokens")
