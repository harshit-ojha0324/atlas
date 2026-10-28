"""PDF -> page text -> semantic chunks -> embeddings.

SemanticChunker is ported from the RAG app (backend/services/document_processor.py)
without LangChain. Everything here is CPU-bound and synchronous: routes run it in
a threadpool so one upload doesn't stall the event loop.
"""

import io
import logging
import math
import re
import statistics
from typing import Any

from pypdf import PdfReader

logger = logging.getLogger(__name__)

# Split on sentence-ending punctuation followed by whitespace and a capital/quote/digit.
_SENTENCE_BOUNDARY = re.compile(r'(?<=[.!?])\s+(?=[A-Z0-9"\'])')

BREAKPOINT_PERCENTILE = 90  # a gap in the top 10% of sentence distances is a topic shift
MIN_CHUNK_CHARS = 250
# all-MiniLM-L6-v2 reads only the first 256 tokens (~1,000 characters of English)
# of a text, so longer chunks would have their ends left out of the index.
MAX_CHUNK_CHARS = 1000
MAX_SENTENCES = 400  # beyond this, one embedding per sentence isn't worth it
# Embedding is the expensive step; cap it so one upload can't pin the CPU for minutes.
MAX_CHUNKS_PER_DOCUMENT = 2000


class DocumentTooLarge(ValueError):
    pass


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class SemanticChunker:
    """Starts a new chunk wherever the cosine distance between consecutive
    sentences is in the top percentile, i.e. at a topic shift. Falls back to
    plain splitting when there are too few or too many sentences to reason about,
    or when embedding fails."""

    def __init__(self, embeddings: Any):
        self.embeddings = embeddings

    def split_text(self, text: str) -> list[str]:
        text = (text or "").strip()
        if not text:
            return []
        if len(text) <= MIN_CHUNK_CHARS:
            return [text]

        normalised = re.sub(r"\s+", " ", text)
        sentences = [s.strip() for s in _SENTENCE_BOUNDARY.split(normalised) if s.strip()]
        if len(sentences) < 3 or len(sentences) > MAX_SENTENCES:
            return self._fallback(text)

        try:
            vectors = self.embeddings.embed_documents(sentences)
        except Exception as e:
            logger.warning(f"Sentence embedding failed ({e}); using plain splitting for this page")
            return self._fallback(text)

        distances = [1.0 - cosine(vectors[i], vectors[i + 1]) for i in range(len(vectors) - 1)]
        threshold = statistics.quantiles(distances, n=100, method="inclusive")[BREAKPOINT_PERCENTILE - 1]

        chunks: list[str] = []
        current = [sentences[0]]
        for i, dist in enumerate(distances):
            nxt = sentences[i + 1]
            current_len = sum(len(s) + 1 for s in current)
            hit_topic_shift = dist >= threshold and current_len >= MIN_CHUNK_CHARS
            would_overflow = current_len + len(nxt) > MAX_CHUNK_CHARS
            if hit_topic_shift or would_overflow:
                chunks.append(" ".join(current).strip())
                current = [nxt]
            else:
                current.append(nxt)
        if current:
            chunks.append(" ".join(current).strip())
        return [c for c in chunks if c]

    @staticmethod
    def _fallback(text: str) -> list[str]:
        # ponytail: greedy word packing with no overlap, where the RAG app used
        # LangChain's recursive splitter with 200 chars of overlap. Add overlap
        # back if evals show answers cut off at chunk edges.
        chunks: list[str] = []
        current = ""
        for word in text.split():
            if current and len(current) + 1 + len(word) > MAX_CHUNK_CHARS:
                chunks.append(current)
                current = word
            else:
                current = f"{current} {word}" if current else word
        if current:
            chunks.append(current)
        return chunks


def extract_pages(data: bytes) -> list[tuple[int, str]]:
    """(page number, text) for every page that has text. Raises on an unreadable PDF."""
    reader = PdfReader(io.BytesIO(data))
    return [
        (n, text) for n, page in enumerate(reader.pages, 1) if (text := page.extract_text()) and text.strip()
    ]


def build_chunks(pages: list[tuple[int, str]], embedder: Any) -> list[tuple[int, str, list[float]]]:
    """(page, text, embedding) for every chunk, in document order."""
    chunker = SemanticChunker(embedder)
    pieces = [(page, piece) for page, text in pages for piece in chunker.split_text(text)]
    if len(pieces) > MAX_CHUNKS_PER_DOCUMENT:
        raise DocumentTooLarge(
            f"document splits into {len(pieces)} chunks; the limit is {MAX_CHUNKS_PER_DOCUMENT}"
        )
    vectors = embedder.embed_documents([text for _, text in pieces]) if pieces else []
    return [(page, text, vec) for (page, text), vec in zip(pieces, vectors)]
