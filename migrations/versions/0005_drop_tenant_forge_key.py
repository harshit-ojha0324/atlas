"""atlas has one forge key now, in its settings

Each call names the tenant in X-Forge-Subtenant, so forge no longer needs a key
per tenant and atlas no longer stores them. Downgrading restores the column
empty; tenants would need new keys.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-01
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("tenants", "forge_api_key")


def downgrade() -> None:
    op.add_column("tenants", sa.Column("forge_api_key", sa.Text, nullable=True))
