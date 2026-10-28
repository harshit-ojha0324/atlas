"""POST /ask: retrieve from the tenant's documents, answer through forge.

With history, a follow-up is first rewritten into a standalone question (one
forge call), which is then used for both retrieval and the answer (a second
call), as LangChain's ConversationalRetrievalChain did in the RAG app.

The security layer (app/core/security.py) runs around it, in the RAG app's
order: redact PII, then check for injection, so neither the refusal nor
anything after it ever handles the raw PII.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_session, limit_queries
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
from app.core.security import filter_output, is_injection, redact_pii
from app.models import Tenant
from app.observability.metrics import SECURITY_EVENTS

log = logging.getLogger("atlas.ask")

# extra passages fetched so that ones withheld by the injection screen don't
# leave the answer with fewer than k
OVERFETCH = 4
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
    question: str  # the standalone question used for retrieval and answering (PII redacted)
    sources: list[Source]
    forge_backend: str | None  # which model answered: vllm | gemini | cache; None if no call was made
    forge_cache: str | None
    security_warnings: list[str]


def _event(kind: str, tenant_id: int, detail: str = "") -> None:
    SECURITY_EVENTS.labels(kind=kind).inc()
    log.info("security tenant=%s %s %s", tenant_id, kind, detail)  # never logs the raw text


@router.post("/ask")
async def ask(
    body: AskRequest,
    request: Request,
    tenant_id: int = Depends(limit_queries),
    session: AsyncSession = Depends(get_session),
) -> AskOut:
    state = request.app.state
    warnings: list[str] = []

    question, pii = redact_pii(body.question)
    if pii:
        warnings.append(f"PII redacted from the question: {', '.join(pii)}")
        _event("pii_redacted", tenant_id, ",".join(pii))
    if is_injection(question):
        _event("injection_blocked", tenant_id)
        raise HTTPException(status_code=400, detail="question blocked: it looks like a prompt injection")
    # Clients send history back as typed, so it gets the same redaction. A user
    # turn that fails the injection check is dropped, not refused: one blocked
    # question shouldn't block the rest of the conversation.
    history = []
    for m in body.history:
        content = redact_pii(m.content)[0]
        if m.role == "user" and is_injection(content):
            _event("history_turn_dropped", tenant_id)
            continue
        history.append({"role": m.role, "content": content})

    forge_key = await session.scalar(select(Tenant.forge_api_key).where(Tenant.id == tenant_id))
    if not forge_key:
        raise HTTPException(
            status_code=503, detail="this tenant has no forge key; recreate it with make tenant"
        )

    async def llm(prompt: str):
        return await complete(state.forge, forge_key, state.settings.forge_model, prompt)

    try:
        if history:
            rewritten = await llm(
                CONDENSE_PROMPT.format(chat_history=format_history(history), question=question)
            )
            question = redact_pii(rewritten.text.strip())[0] or question

        query_vec = await run_in_threadpool(state.embedder.embed_query, question)
        hits = await retrieve(session, tenant_id, query_vec, body.k + OVERFETCH)
        safe_hits = [h for h in hits if not is_injection(h.text)]
        if len(safe_hits) < len(hits):
            dropped = sorted({f"{h.document} p{h.page}" for h in hits if h not in safe_hits})
            warnings.append(
                f"Left out passages that contain instructions aimed at the model: {', '.join(dropped)}"
            )
            _event("chunk_dropped", tenant_id, ",".join(dropped))
        safe_hits = safe_hits[: body.k]
        # Nothing relevant to ground an answer in: say so without spending
        # tokens, and without handing the model unrelated text to guess from.
        if not safe_hits or safe_hits[0].score < state.settings.ask_min_score:
            return AskOut(
                answer=NO_CONTEXT_ANSWER,
                question=question,
                sources=[],
                forge_backend=None,
                forge_cache=None,
                security_warnings=warnings,
            )

        reply = await llm(RAG_PROMPT.format(context=format_context(safe_hits), question=question))
    except ForgeFailure as e:
        headers = {"Retry-After": e.retry_after} if e.retry_after else None
        raise HTTPException(status_code=e.status, detail=e.detail, headers=headers)

    answer, masked = filter_output(reply.text)
    if masked:
        warnings.append(f"Credentials masked in the answer: {', '.join(masked)}")
        _event("output_filtered", tenant_id, ",".join(masked))
    return AskOut(
        answer=answer,
        question=question,
        sources=[
            Source(document_id=h.document_id, document=h.document, page=h.page, excerpt=h.text[:200])
            for h in safe_hits
        ],
        forge_backend=reply.backend,
        forge_cache=reply.cache,
        security_warnings=warnings,
    )
