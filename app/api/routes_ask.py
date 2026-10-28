"""POST /ask: retrieve from the tenant's documents, answer through forge.

With history, a follow-up is first rewritten into a standalone question (one
forge call), which is then used for both retrieval and the answer (a second
call), as LangChain's ConversationalRetrievalChain did in the RAG app.
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_session, require_tenant
from app.core.answer import (
    CONDENSE_PROMPT,
    NO_CONTEXT_ANSWER,
    RAG_PROMPT,
    ForgeFailure,
    complete,
    format_context,
    format_history,
)
from app.core.retrieval import retrieve
from app.models import Tenant

router = APIRouter(tags=["ask"])


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[Message] = Field(default_factory=list, max_length=20)
    k: int = Field(default=4, ge=1, le=20)


class Source(BaseModel):
    document_id: int
    document: str
    page: int
    excerpt: str


class AskOut(BaseModel):
    answer: str
    question: str  # the standalone question used for retrieval and answering
    sources: list[Source]
    forge_backend: str | None  # which model answered: vllm | gemini | cache; None if no call was made
    forge_cache: str | None


@router.post("/ask")
async def ask(
    body: AskRequest,
    request: Request,
    tenant_id: int = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
) -> AskOut:
    state = request.app.state
    forge_key = await session.scalar(select(Tenant.forge_api_key).where(Tenant.id == tenant_id))
    if not forge_key:
        raise HTTPException(
            status_code=503, detail="this tenant has no forge key; recreate it with make tenant"
        )

    async def llm(prompt: str):
        return await complete(state.forge, forge_key, state.settings.forge_model, prompt)

    try:
        question = body.question
        if body.history:
            history = format_history([m.model_dump() for m in body.history])
            rewritten = await llm(CONDENSE_PROMPT.format(chat_history=history, question=question))
            question = rewritten.text.strip() or body.question

        query_vec = await run_in_threadpool(state.embedder.embed_query, question)
        hits = await retrieve(session, tenant_id, query_vec, body.k)
        if not hits:  # nothing to ground an answer in: don't spend tokens
            return AskOut(
                answer=NO_CONTEXT_ANSWER, question=question, sources=[], forge_backend=None, forge_cache=None
            )

        reply = await llm(RAG_PROMPT.format(context=format_context(hits), question=question))
    except ForgeFailure as e:
        headers = {"Retry-After": e.retry_after} if e.retry_after else None
        raise HTTPException(status_code=e.status, detail=e.detail, headers=headers)

    return AskOut(
        answer=reply.text,
        question=question,
        sources=[
            Source(document_id=h.document_id, document=h.document, page=h.page, excerpt=h.text[:200])
            for h in hits
        ],
        forge_backend=reply.backend,
        forge_cache=reply.cache,
    )
