from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunk, Document


@dataclass
class Hit:
    document_id: int
    document: str
    page: int
    text: str
    score: float  # cosine similarity, 1.0 = identical


async def retrieve(session: AsyncSession, tenant_id: int, query_vec: list[float], k: int) -> list[Hit]:
    """The k chunks nearest the query, from this tenant's documents only.

    tenant_id is required and filters the chunks table itself, so no caller can
    search across tenants by forgetting a filter.
    """
    distance = Chunk.embedding.cosine_distance(query_vec)
    rows = await session.execute(
        select(Chunk.document_id, Document.name, Chunk.page, Chunk.text, distance)
        .join(Document, Document.id == Chunk.document_id)
        .where(Chunk.tenant_id == tenant_id)
        .order_by(distance)
        .limit(k)
    )
    return [Hit(doc_id, name, page, text, 1.0 - dist) for doc_id, name, page, text, dist in rows]
