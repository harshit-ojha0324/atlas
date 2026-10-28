"""each tenant's own forge API key

atlas calls forge as the tenant, so forge's quotas, fair queueing and
response cache are all per atlas tenant. Stored in plain text: atlas must
present it, and forge's own tenants file holds it in plain text too.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-28
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column("forge_api_key", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("tenants", "forge_api_key")
