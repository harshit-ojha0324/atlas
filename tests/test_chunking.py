from app.core.chunking import MAX_CHUNK_CHARS, SemanticChunker


def test_fallback_packs_words_without_exceeding_the_limit():
    words = [f"word{i}" for i in range(1000)]
    chunks = SemanticChunker._fallback(" ".join(words))
    assert all(len(c) <= MAX_CHUNK_CHARS for c in chunks)
    assert " ".join(chunks).split() == words  # nothing dropped, nothing reordered


def test_short_text_is_one_chunk_and_blank_is_none():
    chunker = SemanticChunker(embeddings=None)
    assert chunker.split_text("  A short page.  ") == ["A short page."]
    assert chunker.split_text("   ") == []
