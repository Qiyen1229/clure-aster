"""Email 轉寄收帳單：收件匣附件、權杖的寄件人白名單

Revision ID: 0010_mail_inbox
Revises: 0009_notify_channels
Create Date: 2026-11-07
"""
import sqlalchemy as sa
from alembic import op

revision = "0010_mail_inbox"
down_revision = "0009_notify_channels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inbox_tokens", sa.Column("allow_from", sa.String(400), nullable=False, server_default=""))
    op.create_table(
        "inbox_attachments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("inbox_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("filename", sa.String(200), nullable=False, server_default=""),
        sa.Column("content_type", sa.String(80), nullable=False, server_default=""),
        sa.Column("size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_inbox_attachments_user_id", "inbox_attachments", ["user_id"])
    op.create_index("ix_inbox_attachments_item_id", "inbox_attachments", ["item_id"])


def downgrade() -> None:
    op.drop_index("ix_inbox_attachments_item_id", table_name="inbox_attachments")
    op.drop_index("ix_inbox_attachments_user_id", table_name="inbox_attachments")
    op.drop_table("inbox_attachments")
    op.drop_column("inbox_tokens", "allow_from")
