"""Azure AI Content Safety client for the CSA-in-a-Box copilot.

Calls the standalone Content Safety data plane (not the Azure OpenAI built-in
RAI filter) so every persona response is routed through the same moderation
pipeline as the Console copilot.

Gated by ``CONTENT_SAFETY_ENDPOINT``: when unset, :func:`check_input` /
:func:`check_output` return ``(False, "")`` (honest-gate — the caller proceeds
unfiltered and logs a warning rather than crashing). Transient errors also fail
open so a moderation-service blip never breaks the chat.

Auth: ``DefaultAzureCredential`` against the cognitiveservices scope (Managed
Identity preferred in Azure, ``az login`` fallback locally). A
``CONTENT_SAFETY_KEY`` env var enables key-auth for local dev.

API surface (GA, api-version 2024-09-01):
  POST /contentsafety/text:shieldPrompt   — Prompt Shields (jailbreak/injection)
  POST /contentsafety/text:analyze        — harm-category severities
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Tuple

logger = logging.getLogger(__name__)

_CONTENT_SAFETY_ENDPOINT = os.environ.get("CONTENT_SAFETY_ENDPOINT", "").rstrip("/")
_CONTENT_SAFETY_KEY = os.environ.get("CONTENT_SAFETY_KEY", "")

# Severity that counts as "blocked" — Medium, matching the Azure AI Foundry
# portal's default content filter.
_BLOCK_THRESHOLD = 4
_MAX_CHARS = 10_000  # Content Safety per-call text limit.
_HARM_CATEGORIES = ["Hate", "SelfHarm", "Sexual", "Violence"]

_cs_token_provider = None


def is_configured() -> bool:
    """True when a Content Safety endpoint is wired."""
    return bool(_CONTENT_SAFETY_ENDPOINT)


def _cs_token() -> str | None:
    """Return a bearer token for the cognitiveservices scope, or None when a
    static key is configured (key-auth header used instead)."""
    global _cs_token_provider
    if _CONTENT_SAFETY_KEY:
        return None
    if _cs_token_provider is None:
        from azure.identity import (
            DefaultAzureCredential,
            get_bearer_token_provider,
        )

        cred = DefaultAzureCredential(exclude_interactive_browser_credential=True)
        _cs_token_provider = get_bearer_token_provider(
            cred, "https://cognitiveservices.azure.com/.default"
        )
    return _cs_token_provider()


def _cs_post(path: str, payload: dict) -> dict:
    """POST to the Content Safety data plane. Returns {} on any error
    (fail-open)."""
    url = f"{_CONTENT_SAFETY_ENDPOINT}{path}"
    data = json.dumps(payload).encode()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    try:
        tok = _cs_token()
    except Exception as exc:  # pragma: no cover - credential acquisition
        logger.warning("[content-safety] token acquisition failed: %s", exc)
        return {}
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    elif _CONTENT_SAFETY_KEY:
        headers["Ocp-Apim-Subscription-Key"] = _CONTENT_SAFETY_KEY
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read()[:200] if hasattr(e, "read") else b""
        logger.warning("[content-safety] %s failed %d: %s", path, e.code, body)
        return {}
    except Exception as exc:
        logger.warning("[content-safety] %s error: %s", path, exc)
        return {}


def _check_harm(text: str) -> Tuple[bool, str]:
    result = _cs_post(
        "/contentsafety/text:analyze?api-version=2024-09-01",
        {"text": text[:_MAX_CHARS], "categories": _HARM_CATEGORIES},
    )
    hits = [
        c
        for c in result.get("categoriesAnalysis", [])
        if (c.get("severity") or 0) >= _BLOCK_THRESHOLD
    ]
    if not hits:
        return False, ""
    worst = max(hits, key=lambda c: c.get("severity", 0))
    return (
        True,
        f"Content safety blocked: {worst.get('category', 'Unknown')} "
        f"(severity {worst.get('severity', 0)})",
    )


def check_input(text: str) -> Tuple[bool, str]:
    """Run Prompt Shields + harm analysis on user input.

    Returns ``(blocked, reason)``. Returns ``(False, "")`` when Content Safety
    is not configured (honest-gate)."""
    if not _CONTENT_SAFETY_ENDPOINT:
        logger.debug("[content-safety] endpoint not configured — skipping input check")
        return False, ""
    if not text or not text.strip():
        return False, ""
    shield = _cs_post(
        "/contentsafety/text:shieldPrompt?api-version=2024-09-01",
        {"userPrompt": text[:_MAX_CHARS], "documents": []},
    )
    if shield.get("userPromptAnalysis", {}).get("attackDetected"):
        return True, "Prompt injection detected"
    return _check_harm(text)


def check_output(text: str) -> Tuple[bool, str]:
    """Run harm analysis on LLM completion output.

    Returns ``(blocked, reason)``. Returns ``(False, "")`` when Content Safety
    is not configured (honest-gate)."""
    if not _CONTENT_SAFETY_ENDPOINT:
        return False, ""
    if not text or not text.strip():
        return False, ""
    return _check_harm(text)
