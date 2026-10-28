"""enable pgvector

Chunks and their embeddings live in Postgres (not Chroma) so a document's
chunks and its status commit in one transaction; see README.

Revision ID: 0001
Revises:
Create Date: 2026-10-28
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")


def downgrade() -> None:
    op.execute("DROP EXTENSION IF EXISTS vector")
