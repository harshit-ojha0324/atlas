"""async ingestion: uploaded bytes, attempts, error; versions share a name

An upload now lands as a `pending` row holding the PDF bytes; the worker turns
it `ready` (or `failed`). Until then the previous ready version of the same
name stays searchable, so the one-row-per-name constraint becomes "at most one
*ready* row per name".

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-28
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("content", sa.LargeBinary, nullable=True))
    op.add_column("documents", sa.Column("error", sa.Text, nullable=True))
    op.add_column("documents", sa.Column("attempts", sa.Integer, nullable=False, server_default="0"))
    op.alter_column("documents", "pages", nullable=True)
    op.alter_column("documents", "chunk_count", nullable=True)
    op.drop_constraint("documents_tenant_id_name_key", "documents", type_="unique")
    op.create_index(
        "uq_documents_ready_name",
        "documents",
        ["tenant_id", "name"],
        unique=True,
        postgresql_where=sa.text("status = 'ready'"),
    )


def downgrade() -> None:
    op.drop_index("uq_documents_ready_name", "documents")
    op.execute("DELETE FROM documents WHERE status <> 'ready'")
    op.create_unique_constraint("documents_tenant_id_name_key", "documents", ["tenant_id", "name"])
    op.alter_column("documents", "chunk_count", nullable=False)
    op.alter_column("documents", "pages", nullable=False)
    op.drop_column("documents", "attempts")
    op.drop_column("documents", "error")
    op.drop_column("documents", "content")
