"""雙因素驗證（TOTP）：使用者的密鑰（加密）、啟用狀態、備援碼雜湊

Revision ID: 0013_totp
Revises: 0012_token_use_count
Create Date: 2026-11-07
"""
import sqlalchemy as sa
from alembic import op

revision = "0013_totp"
down_revision = "0012_token_use_count"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.add_column(sa.Column("totp_secret", sa.String(255), nullable=True))
        b.add_column(sa.Column("totp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column("totp_last_step", sa.Integer(), nullable=False, server_default="0"))
        b.add_column(sa.Column("totp_recovery", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.drop_column("totp_recovery")
        b.drop_column("totp_last_step")
        b.drop_column("totp_enabled")
        b.drop_column("totp_secret")
