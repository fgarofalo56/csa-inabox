"""PII and secret-pattern redaction for chat content before persistence.

Applied to user messages, assistant replies, and improvement-text feedback
*before* they are written to Cosmos DB or emitted to App Insights.

Best-effort: pattern matchers, not provable extraction. Layered with
short max_length cap so even an unmatched secret is bounded.

Never used to filter content sent to OpenAI — only what we persist.
"""

from __future__ import annotations

import hashlib
import re

REDACTED = "[redacted]"

# Order matters — more specific patterns run first so the broad
# alphanumeric "long-token" sweep doesn't double-redact things we
# already handled with a more precise pattern.

# JWT — three base64url segments separated by dots, starts with eyJ
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")

# Provider-prefixed credentials, split by shape:
#   - Prefixes with a separator (sk-, xoxb-, ghp_, github_pat_, ...)
#   - Prefixes that flow directly into the credential body (AIza, hf_)
_PREFIXED_KEY_SEP_RE = re.compile(
    r"\b(?:sk|xoxb|xoxp|xoxa|ghp|gho|ghu|ghs|ghr|github_pat)[-_][A-Za-z0-9_-]{20,}\b"
)
_PREFIXED_KEY_NOSEP_RE = re.compile(
    r"\b(?:AIza|hf_)[A-Za-z0-9_-]{20,}\b"
)

# Bearer / Authorization header values
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._-]{16,}\b")

# Azure connection-string fragments
_CONN_STR_RE = re.compile(
    r"(?i)(AccountKey|SharedAccessKey|AccessKey|Key|Password)\s*=\s*[A-Za-z0-9+/=._-]{12,}"
)

# Azure 88-char base64 keys (storage / Cog Services)
_AZURE_KEY_RE = re.compile(r"\b[A-Za-z0-9+/]{86,88}={0,2}\b")

# Email
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")

# IPv4
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# Long opaque tokens — runs LAST so the more-specific patterns above
# get first crack. 32+ chars of [A-Za-z0-9_-] looks like a token.
_GENERIC_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])")


def redact(text: str, *, max_length: int = 4000) -> str:
    """Apply all redactors in sequence and cap the length."""
    if not text:
        return ""
    text = text[:max_length]
    text = _JWT_RE.sub(REDACTED, text)
    text = _PREFIXED_KEY_SEP_RE.sub(REDACTED, text)
    text = _PREFIXED_KEY_NOSEP_RE.sub(REDACTED, text)
    text = _BEARER_RE.sub(f"Bearer {REDACTED}", text)
    text = _CONN_STR_RE.sub(lambda m: f"{m.group(1)}={REDACTED}", text)
    text = _AZURE_KEY_RE.sub(REDACTED, text)
    text = _EMAIL_RE.sub(REDACTED, text)
    text = _IPV4_RE.sub(REDACTED, text)
    text = _GENERIC_TOKEN_RE.sub(REDACTED, text)
    return text


def hash_ip(ip: str, salt: str = "") -> str:
    """Salted, truncated SHA-256 of an IP for analytics deduplication.

    Not reversible without the salt. Same (ip, salt) pair yields the
    same digest, so per-IP rate-limit-aware analytics still work.
    """
    payload = f"{salt}:{ip}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]
