from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunk, Document


class Hit(BaseModel):
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
    return [
        Hit(document_id=doc_id, document=name, page=page, text=text, score=1.0 - dist)
        for doc_id, name, page, text, dist in rows
    ]


async def spread(session: AsyncSession, tenant_id: int, total: int) -> list[Hit]:
    """About `total` passages spaced evenly through this tenant's newest documents,
    in reading order. "Summarize this" names no topic for search to match, so
    every passage scores about the same and the top few are close to random.

    ponytail: a sample, not a summary; a very long document is read sparsely.
    Summarize documents at ingest if answers about them come out thin."""
    counts = (
        await session.execute(
            select(Chunk.document_id, func.count())
            .where(Chunk.tenant_id == tenant_id)
            .group_by(Chunk.document_id)
            .order_by(Chunk.document_id.desc())  # ids rise with upload time
            .limit(total)
        )
    ).all()
    if not counts:
        return []
    per = max(1, total // len(counts))
    # idx runs 0..n-1 through a document; this keeps one passage per n/per stretch
    picks = or_(*(and_(Chunk.document_id == doc, Chunk.idx * per % n < per) for doc, n in counts))
    rows = await session.execute(
        select(Chunk.document_id, Document.name, Chunk.page, Chunk.text)
        .join(Document, Document.id == Chunk.document_id)
        .where(Chunk.tenant_id == tenant_id, picks)
        .order_by(Chunk.document_id.desc(), Chunk.idx)
    )
    return [
        Hit(document_id=doc_id, document=name, page=page, text=text, score=0.0)
        for doc_id, name, page, text in rows
    ]
