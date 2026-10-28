"""Upload, list, delete and search a tenant's documents.

Upload is synchronous in Phase 1: the request returns once the document is
chunked, embedded and committed. Phase 2 moves that work onto a worker.
"""

import hashlib
from pathlib import PurePath

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_session, require_tenant
from app.core.chunking import DocumentTooLarge, build_chunks, extract_pages
from app.core.retrieval import retrieve
from app.models import Chunk, Document

router = APIRouter(tags=["documents"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


class DocumentOut(BaseModel):
    id: int
    name: str
    status: str
    pages: int
    chunk_count: int


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    k: int = Field(default=4, ge=1, le=20)


class HitOut(BaseModel):
    document_id: int
    document: str
    page: int
    text: str
    score: float


def _out(doc: Document) -> DocumentOut:
    return DocumentOut(
        id=doc.id, name=doc.name, status=doc.status, pages=doc.pages, chunk_count=doc.chunk_count
    )


@router.post("/documents", status_code=201)
async def upload_document(
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    tenant_id: int = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
) -> DocumentOut:
    # only the base name: a client-supplied path never reaches storage or listings
    name = PurePath(file.filename or "").name
    if not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="only PDF files are accepted")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"PDFs are limited to {MAX_UPLOAD_BYTES // 2**20} MB")
    digest = hashlib.sha256(data).hexdigest()

    existing = (
        await session.execute(select(Document).where(Document.tenant_id == tenant_id, Document.name == name))
    ).scalar_one_or_none()
    if existing and existing.sha256 == digest:
        response.status_code = 200  # same bytes already indexed: nothing to redo
        return _out(existing)

    embedder = request.app.state.embedder
    try:
        pages = await run_in_threadpool(extract_pages, data)
    except Exception:
        raise HTTPException(status_code=422, detail="could not read the PDF")
    try:
        chunks = await run_in_threadpool(build_chunks, pages, embedder)
    except DocumentTooLarge as e:
        raise HTTPException(status_code=413, detail=str(e))
    if not chunks:
        raise HTTPException(status_code=422, detail="the PDF has no extractable text")

    # One transaction: a re-upload replaces the old version (its chunks go by
    # cascade), and a failure leaves the old version searchable.
    doc = Document(
        tenant_id=tenant_id,
        name=name,
        sha256=digest,
        status="ready",
        pages=len(pages),
        chunk_count=len(chunks),
    )
    try:
        if existing:
            await session.delete(existing)
            await session.flush()
        session.add(doc)
        await session.flush()
        await session.execute(
            insert(Chunk),
            [
                {
                    "document_id": doc.id,
                    "tenant_id": tenant_id,
                    "idx": i,
                    "page": page,
                    "text": text,
                    "embedding": vec,
                }
                for i, (page, text, vec) in enumerate(chunks)
            ],
        )
        await session.commit()
    except IntegrityError:
        # two uploads of the same name raced; the (tenant_id, name) unique key let one win
        raise HTTPException(status_code=409, detail="another upload of this document name is in progress")
    return _out(doc)


@router.get("/documents")
async def list_documents(
    tenant_id: int = Depends(require_tenant), session: AsyncSession = Depends(get_session)
) -> list[DocumentOut]:
    rows = await session.execute(
        select(Document).where(Document.tenant_id == tenant_id).order_by(Document.created_at)
    )
    return [_out(d) for d in rows.scalars()]


@router.delete("/documents/{document_id}", status_code=204)
async def delete_document(
    document_id: int, tenant_id: int = Depends(require_tenant), session: AsyncSession = Depends(get_session)
) -> None:
    # another tenant's id gets the same 404 as a missing one: ids don't leak
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
    tenant_id: int = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
) -> list[HitOut]:
    query_vec = await run_in_threadpool(request.app.state.embedder.embed_query, body.query)
    hits = await retrieve(session, tenant_id, query_vec, body.k)
    return [HitOut(**h.__dict__) for h in hits]
