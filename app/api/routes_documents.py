"""Upload, list, get, delete and search a tenant's documents.

Upload only stores the PDF and queues it: the worker (app/worker.py) chunks and
embeds it. Clients poll GET /documents/{id} until status is ready or failed.
"""

import hashlib
from pathlib import PurePath

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from redis.exceptions import RedisError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_session, limit_queries, limit_uploads, require_tenant
from app.core.retrieval import Hit, retrieve
from app.models import Document

router = APIRouter(tags=["documents"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


class DocumentOut(BaseModel):
    id: int
    name: str
    status: str  # pending | ready | failed
    pages: int | None
    chunk_count: int | None
    error: str | None


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    k: int = Field(default=4, ge=1, le=20)


def _out(doc: Document) -> DocumentOut:
    return DocumentOut(
        id=doc.id,
        name=doc.name,
        status=doc.status,
        pages=doc.pages,
        chunk_count=doc.chunk_count,
        error=doc.error,
    )


@router.post("/documents", status_code=202)
async def upload_document(
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    tenant_id: int = Depends(limit_uploads),
    session: AsyncSession = Depends(get_session),
) -> DocumentOut:
    # only the base name: a client-supplied path never reaches storage or listings
    name = PurePath(file.filename or "").name
    if not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="only PDF files are accepted")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"PDFs are limited to {MAX_UPLOAD_BYTES // 2**20} MB")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="the file is not a PDF")
    digest = hashlib.sha256(data).hexdigest()

    # the same bytes already indexed, or on their way: nothing to redo
    existing = (
        await session.execute(
            select(Document)
            .where(
                Document.tenant_id == tenant_id,
                Document.name == name,
                Document.sha256 == digest,
                Document.status.in_(("pending", "ready")),
            )
            .order_by(Document.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing:
        response.status_code = 200
        return _out(existing)

    doc = Document(tenant_id=tenant_id, name=name, sha256=digest, status="pending", content=data)
    session.add(doc)
    await session.commit()
    try:
        settings = request.app.state.settings
        # the worker (app/worker.py) consumes this stream
        await request.app.state.redis.xadd(
            settings.stream_key, {"doc_id": str(doc.id)}, maxlen=settings.stream_maxlen, approximate=True
        )
    except RedisError:
        # a row nobody will ever process is worse than a failed upload
        await session.delete(doc)
        await session.commit()
        raise HTTPException(status_code=503, detail="ingestion queue unavailable; try again shortly")
    return _out(doc)


@router.get("/documents")
async def list_documents(
    tenant_id: int = Depends(require_tenant), session: AsyncSession = Depends(get_session)
) -> list[DocumentOut]:
    rows = await session.execute(
        select(Document).where(Document.tenant_id == tenant_id).order_by(Document.id)
    )
    return [_out(d) for d in rows.scalars()]


@router.get("/documents/{document_id}")
async def get_document(
    document_id: int, tenant_id: int = Depends(require_tenant), session: AsyncSession = Depends(get_session)
) -> DocumentOut:
    doc = await session.scalar(
        select(Document).where(Document.id == document_id, Document.tenant_id == tenant_id)
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="document not found")
    return _out(doc)


@router.delete("/documents/{document_id}", status_code=204)
async def delete_document(
    document_id: int, tenant_id: int = Depends(require_tenant), session: AsyncSession = Depends(get_session)
) -> None:
    # another tenant's id gets the same 404 as a missing one: ids don't leak.
    # Deleting a pending document is safe: the worker finds no row and skips it.
    result = await session.execute(
        delete(Document).where(Document.id == document_id, Document.tenant_id == tenant_id)
    )
    await session.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="document not found")


@router.post("/search")
async def search(
    body: SearchRequest,
    request: Request,
    tenant_id: int = Depends(limit_queries),
    session: AsyncSession = Depends(get_session),
) -> list[Hit]:
    query_vec = await run_in_threadpool(request.app.state.embedder.embed_query, body.query)
    return await retrieve(session, tenant_id, query_vec, body.k)
