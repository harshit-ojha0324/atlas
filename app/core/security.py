"""The RAG app's security layer (backend/security/), ported for /ask.

- PII in the question and history is redacted before it reaches forge.
- A question that looks like a prompt injection is refused; earlier user turns
  that do are dropped from the history.
- Retrieved chunks that look like an injection are kept out of the prompt:
  indirect injection through an uploaded document, which the RAG app's regex
  gate never checked.
- Credentials in the answer are masked before it's returned.

One injection pattern serves questions, history and chunks, and it only
matches text aimed at the model. The RAG app's question patterns refused
ordinary document questions ("What are the new rules for expenses?", "Can
managers override the default settings?", anything mentioning someone named Dan).

ponytail: regex only. The RAG app ran Presidio (spaCy's ~600 MB model) first
and these same patterns as its fallback; Presidio adds checksum validation and
more entity types (passport, IBAN, IP). Swap it in behind redact_pii if
false positives or misses show up in practice.
"""

import re

# Longest digit patterns first, so a phone match can't eat part of a card number.
PII_PATTERNS = {
    "EMAIL_ADDRESS": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "CREDIT_CARD": re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b"),
    "US_SSN": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "PHONE_NUMBER": re.compile(r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b"),
}

# Instructions aimed at the model itself, not at a reader.
INJECTION = re.compile(
    r"(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(the\s+|your\s+)?"
    r"(previous|prior|above|earlier|system)\s+(instructions|prompts|rules)"
    r"|system prompt"
    r"|you are (now )?(dan|chatgpt|an? (ai|language model|assistant))\b"
    r"|do anything now"
    r"|jailbreak",
    re.IGNORECASE,
)

SECRET_PATTERNS = {
    "API_KEY": re.compile(r"(api[_-]?key|apikey)[\"']?\s*[:=]\s*[\"']?([a-zA-Z0-9-_]{8,})", re.IGNORECASE),
    "PASSWORD": re.compile(r"(password|passwd|pwd)[\"']?\s*[:=]\s*[\"']?([^\s\"']+)", re.IGNORECASE),
    "TOKEN": re.compile(r"(token|auth)[\"']?\s*[:=]\s*[\"']?([a-zA-Z0-9-_\.]{8,})", re.IGNORECASE),
    "AWS_KEY": re.compile(r"AKIA[0-9A-Z]{16}"),
    "PRIVATE_KEY": re.compile(r"-----BEGIN (RSA |DSA |EC )?PRIVATE KEY-----"),
}


def redact_pii(text: str) -> tuple[str, list[str]]:
    """Replace PII with [REDACTED]; return the new text and the PII types found.
    Names are left alone: they're what people ask their documents about."""
    found = []
    for pii_type, pattern in PII_PATTERNS.items():
        text, n = pattern.subn("[REDACTED]", text)
        if n:
            found.append(pii_type)
    return text, found


def is_injection(text: str) -> bool:
    return INJECTION.search(text) is not None


def filter_output(text: str) -> tuple[str, list[str]]:
    """Mask credentials in a model answer; return the new text and what was masked."""
    found = []
    for name, pattern in SECRET_PATTERNS.items():
        text, n = pattern.subn(f"[{name}_REDACTED]", text)
        if n:
            found.append(name)
    return text, found
