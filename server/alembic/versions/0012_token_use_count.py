"""收件匣權杖的使用次數：App 顯示「已傳送 N 次資料」

Revision ID: 0012_token_use_count
Revises: 0011_drop_mail_inbox
Create Date: 2026-11-07
"""
import sqlalchemy as sa
from alembic import op

revision = "0012_token_use_count"
down_revision = "0011_drop_mail_inbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("inbox_tokens") as b:
        b.add_column(sa.Column("use_count", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    with op.batch_alter_table("inbox_tokens") as b:
        b.drop_column("use_count")
