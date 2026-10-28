"""The RAG app's security layer (backend/security/), ported for /ask.

- PII in the question and history is redacted before it reaches forge.
- A question that looks like a prompt injection is refused; earlier user turns
  that do are dropped from the history.
- Retrieved chunks that look like an injection are kept out of the prompt:
  indirect injection through an uploaded document, which the RAG app's regex
  gate never checked. Document patterns are narrower than question patterns,
  since policies routinely say "new rules" or "you are now eligible".
- Credentials in the answer are masked before it's returned.

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

# What a *question* has no business saying (the RAG app's list, minus its SQL/XSS
# patterns, which it dropped for blocking questions like "Which plan covers C#?").
QUESTION_INJECTION = re.compile(
    r"ignore .*?(instructions|prompts|rules)"
    r"|disregard .*?(instructions|prompts|rules)"
    r"|forget .*?(instructions|prompts|rules)"
    r"|you are now"
    r"|new .*?(instructions|rules|role)"
    r"|system prompt"
    r"|override .*?(instructions|settings|rules)"
    r"|jailbreak"
    r"|do anything now"
    r"|\bdan\b",
    re.IGNORECASE,
)

# What a *document* has no business saying: instructions aimed at the model itself.
DOCUMENT_INJECTION = re.compile(
    r"(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|system)\s+"
    r"(instructions|prompts|rules)"
    r"|system prompt"
    r"|you are (now )?(chatgpt|an? (ai|language model|assistant))"
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


def is_injection(question: str) -> bool:
    return QUESTION_INJECTION.search(question) is not None


def chunk_is_injection(text: str) -> bool:
    return DOCUMENT_INJECTION.search(text) is not None


def filter_output(text: str) -> tuple[str, list[str]]:
    """Mask credentials in a model answer; return the new text and what was masked."""
    found = []
    for name, pattern in SECRET_PATTERNS.items():
        text, n = pattern.subn(f"[{name}_REDACTED]", text)
        if n:
            found.append(name)
    return text, found
