"""POST /ask: retrieve from the tenant's documents, answer through forge.

With history, a follow-up is first rewritten into a standalone question (one
forge call), which is then used for both retrieval and the answer (a second
call), as LangChain's ConversationalRetrievalChain did in the RAG app.

The security layer (app/core/security.py) runs around it, in the RAG app's
order: redact PII, then check for injection, so neither the refusal nor
anything after it ever handles the raw PII.
"""

import logging
import re
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
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
from app.core.retrieval import retrieve, spread
from app.core.security import filter_output, is_injection, redact_pii
from app.observability import tenant_stats
from app.observability.metrics import SECURITY_EVENTS

log = logging.getLogger("atlas.ask")

# extra passages fetched so that ones withheld by the injection screen don't
# leave the answer with fewer than k
OVERFETCH = 4
# "Summarize this", "what is my document about": questions about a whole
# document, which get passages from all through it as well as search's.
# ponytail: a word list, so "sum it up" is missed; widen it as misses show up.
WHOLE_DOCUMENT = re.compile(
    r"\b(summar(y|ies|ise|ize)|overview|outline|tl;?dr|gist|main (points|ideas|topics|themes)"
    r"|key (points|ideas|takeaways))\b|\bwhat\b.*\b(about|cover|covers|contain|contains)\W*$",
    re.IGNORECASE,
)
SPREAD_PASSAGES = 12
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


async def _event(redis, kind: str, tenant_id: int, detail: str = "") -> None:
    SECURITY_EVENTS.labels(kind=kind).inc()
    log.info("security tenant=%s %s %s", tenant_id, kind, detail)  # never logs the raw text
    await tenant_stats.bump(redis, tenant_id, f"event:{kind}")


@router.post("/ask")
async def ask(
    body: AskRequest,
    request: Request,
    tenant_id: int = Depends(limit_queries),
    session: AsyncSession = Depends(get_session),
) -> AskOut:
    state = request.app.state
    started = time.perf_counter()
    warnings: list[str] = []

    question, pii = redact_pii(body.question)
    if pii:
        warnings.append(f"PII redacted from the question: {', '.join(pii)}")
        await _event(state.redis, "pii_redacted", tenant_id, ",".join(pii))
    if is_injection(question):
        await _event(state.redis, "injection_blocked", tenant_id)
        raise HTTPException(status_code=400, detail="question blocked: it looks like a prompt injection")
    # Clients send history back as typed, so it gets the same redaction. A user
    # turn that fails the injection check is dropped, not refused: one blocked
    # question shouldn't block the rest of the conversation.
    history = []
    for m in body.history:
        content = redact_pii(m.content)[0]
        if m.role == "user" and is_injection(content):
            await _event(state.redis, "history_turn_dropped", tenant_id)
            continue
        history.append({"role": m.role, "content": content})

    async def llm(prompt: str):
        settings = state.settings
        return await complete(state.forge, settings.forge_api_key, tenant_id, settings.forge_model, prompt)

    try:
        if history:
            rewritten = await llm(
                CONDENSE_PROMPT.format(chat_history=format_history(history), question=question)
            )
            question = redact_pii(rewritten.text.strip())[0] or question

        query_vec = await run_in_threadpool(state.embedder.embed_query, question)
        hits = await retrieve(session, tenant_id, query_vec, body.k + OVERFETCH)
        whole = bool(WHOLE_DOCUMENT.search(question))
        spread_hits = []
        if whole:
            seen = {(h.document_id, h.page, h.text) for h in hits}
            spread_hits = [
                h
                for h in await spread(session, tenant_id, SPREAD_PASSAGES)
                if (h.document_id, h.page, h.text) not in seen
            ]
            hits += spread_hits
        safe_hits = [h for h in hits if not is_injection(h.text)]
        if len(safe_hits) < len(hits):
            dropped = sorted({f"{h.document} p{h.page}" for h in hits if h not in safe_hits})
            warnings.append(
                f"Left out passages that contain instructions aimed at the model: {', '.join(dropped)}"
            )
            await _event(state.redis, "chunk_dropped", tenant_id, ",".join(dropped))
        searched = [h for h in safe_hits if h not in spread_hits][: body.k]
        safe_hits = searched + [h for h in safe_hits if h in spread_hits]
        # Nothing relevant to ground an answer in: say so without spending
        # tokens, and without handing the model unrelated text to guess from.
        # A whole-document question matches nothing by design, so it has no floor.
        if not safe_hits or (not whole and safe_hits[0].score < state.settings.ask_min_score):
            await tenant_stats.bump(state.redis, tenant_id, "declined")
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
        await tenant_stats.bump(state.redis, tenant_id, "failed")
        headers = {"Retry-After": e.retry_after} if e.retry_after else None
        raise HTTPException(status_code=e.status, detail=e.detail, headers=headers)

    answer, masked = filter_output(reply.text)
    if masked:
        warnings.append(f"Credentials masked in the answer: {', '.join(masked)}")
        await _event(state.redis, "output_filtered", tenant_id, ",".join(masked))
    await tenant_stats.record_answer(state.redis, tenant_id, reply.backend, time.perf_counter() - started)
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
