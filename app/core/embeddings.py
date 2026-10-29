"""The embedding model, loaded once per process.

Same model and normalisation as the RAG app's local option, so its eval set
carries over. chunks.embedding is vector(384): a model of any other size fails
here at startup, not on the first insert.
"""

from app.models import EMBEDDING_DIM

MODEL = "sentence-transformers/all-MiniLM-L6-v2"


class Embedder:
    def __init__(self, threads: int | None = None):
        # imported here: sentence-transformers pulls in torch, which tests
        # using a fake embedder never need to load
        import torch
        from sentence_transformers import SentenceTransformer

        if threads:
            torch.set_num_threads(threads)

        self.model = SentenceTransformer(MODEL, device="cpu")
        dim = self.model.get_embedding_dimension()
        if dim != EMBEDDING_DIM:
            raise RuntimeError(f"{MODEL} makes {dim}-d vectors; chunks.embedding is {EMBEDDING_DIM}-d")

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        texts = [t.replace("\n", " ") for t in texts]  # as LangChain's HuggingFaceEmbeddings did
        return self.model.encode(texts, normalize_embeddings=True).tolist()

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]
