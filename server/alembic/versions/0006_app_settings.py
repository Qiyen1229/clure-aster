"""系統設定（管理後台的開放註冊開關）

Revision ID: 0006_app_settings
Revises: 0005_inbox
Create Date: 2026-10-27
"""
import sqlalchemy as sa
from alembic import op

revision = "0006_app_settings"
down_revision = "0005_inbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", sa.String(200), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("app_settings")
