"""Test helpers, also used by scripts/drill_kill_worker.py."""

import hashlib
import math
import random

EMBEDDING_DIM = 384

# what the mock forge (conftest.forge) returns for every follow-up rewrite
ZEBRA = "Zebra migration patterns across the Serengeti in the dry season."


class FakeEmbedder:
    """Identical text -> identical unit vector, so a query equal to a chunk's
    text is that chunk's exact nearest neighbour."""

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self.embed_query(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        rng = random.Random(hashlib.sha256(text.encode()).digest())
        v = [rng.gauss(0, 1) for _ in range(EMBEDDING_DIM)]
        norm = math.sqrt(sum(x * x for x in v))
        return [x / norm for x in v]


def make_pdf(pages: list[str]) -> bytes:
    """A minimal valid PDF, one line of Helvetica text per page."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for line in pages:
        esc = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({esc}) Tj ET"
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        objs.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {len(objs)} 0 R >>"
        )
        kids.append(f"{len(objs)} 0 R")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    out, offsets = b"%PDF-1.4\n", []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{off:010d} 00000 n \n".encode() for off in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out
