"""移除 Email 轉寄收帳單：刪掉收件匣附件表與權杖的寄件人白名單欄位

0010_mail_inbox 已經在某些部署上執行過，所以保留它、用這個遷移把東西拿掉（表或欄位不存在也不會報錯）。

Revision ID: 0011_drop_mail_inbox
Revises: 0010_mail_inbox
Create Date: 2026-11-07
"""
import sqlalchemy as sa
from alembic import op

revision = "0011_drop_mail_inbox"
down_revision = "0010_mail_inbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "inbox_attachments" in insp.get_table_names():
        op.drop_table("inbox_attachments")
    if "allow_from" in [c["name"] for c in insp.get_columns("inbox_tokens")]:
        with op.batch_alter_table("inbox_tokens") as b:
            b.drop_column("allow_from")


def downgrade() -> None:
    # 回到 0010 的狀態（Email 轉寄功能已移除，這些只是讓 0010 的 downgrade 能接著執行）
    with op.batch_alter_table("inbox_tokens") as b:
        b.add_column(sa.Column("allow_from", sa.String(400), nullable=False, server_default=""))
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
