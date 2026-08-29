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
import urllib.parse
import urllib.request
from typing import Tuple

logger = logging.getLogger(__name__)


# ── Credential-safe opener (#3717) ────────────────────────────────────────────
#
# `urllib.request.urlopen()` uses the DEFAULT GLOBAL OPENER, and `_cs_post`
# below sends `Authorization: Bearer <AAD token for cognitiveservices>`.
# Measured properties of that opener: `HTTPRedirectHandler.redirect_request`
# rebuilds the Request copying EVERY header except content-length/content-type
# (urllib does NOT strip `Authorization` across a host change), and
# `http_error_302` permits a `Location:` whose scheme is http/https/ftp/'' while
# the default handler set installs FTPHandler/FileHandler/DataHandler with no
# proxy variable set. So a `302 -> http://attacker/loot` from a compromised
# upstream hands out the token, and the caller sees a normal-looking failure.
#
# `CONTENT_SAFETY_ENDPOINT` is operator-supplied, which is what makes this
# reachable rather than theoretical.
#
# Canonical long-form argument and the full measurement log:
# `scripts/csa-loom/livy-session-census.py`. Duplicated rather than imported —
# this function app ships as its own deployable with no path to `scripts/`.
_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(url: str) -> tuple:
    """The (scheme, host, port) triple two URLs must share to be same-origin."""
    parts = urllib.parse.urlsplit(url)
    scheme = (parts.scheme or "").lower()
    return (scheme, (parts.hostname or "").lower(), parts.port or _DEFAULT_PORTS.get(scheme))


def _origin_str(origin: tuple) -> str:
    scheme, host, port = origin
    return f"{scheme}://{host}" + (f":{port}" if port is not None else "")


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse any redirect that leaves the origin the request was aimed at.

    THIS is the guard that closes the exfiltration vector; the scheme scoping in
    :func:`_http_only_opener` is defence in depth. It REFUSES rather than
    stripping the header — a request that silently lost its credentials comes
    back 401 from an unexpected host, which sends the reader somewhere else
    entirely. Same-origin redirects still work.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        if _origin(target) != _origin(req.full_url):
            raise urllib.error.HTTPError(
                target, code,
                f"refusing cross-origin redirect "
                f"{_origin_str(_origin(req.full_url))} -> "
                f"{_origin_str(_origin(target))} — urllib copies the "
                f"Authorization header across a host change, so following this "
                f"would hand the Content Safety token to that host",
                headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _http_only_opener() -> urllib.request.OpenerDirector:
    """An opener whose only URL schemes are http and https (defence in depth).

    The proxy dict is SCOPED on purpose: `ProxyHandler.__init__` registers a
    `<scheme>_open` for EVERY key in the dict and the default `ProxyHandler()`
    reads `getproxies()`, so one `ftp_proxy` re-registers the ftp route and it
    fails OPEN. Dropping the `'no'` key does not break `no_proxy` — `proxy_open`
    calls the module-level `proxy_bypass()`, which re-reads the environment.
    """
    proxies = {
        scheme: url
        for scheme, url in urllib.request.getproxies().items()
        if scheme in ("http", "https")
    }
    handlers = [
        urllib.request.ProxyHandler(proxies),
        urllib.request.HTTPHandler(),
        _SameOriginRedirectHandler(),
        urllib.request.HTTPErrorProcessor(),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.UnknownHandler(),
    ]
    https_handler = getattr(urllib.request, "HTTPSHandler", None)
    if https_handler is not None:
        handlers.insert(2, https_handler())

    opener = urllib.request.OpenerDirector()
    for handler in handlers:
        opener.add_handler(handler)
    return opener


_OPENER = _http_only_opener()

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
    # `CONTENT_SAFETY_ENDPOINT` is operator-supplied, so the scheme is checked
    # STRUCTURALLY (parse, not a substring test) right at the call site — the
    # URL WE build. Where the SERVER tries to send us next is
    # `_SameOriginRedirectHandler`'s job, and which transports exist at all is
    # `_http_only_opener`'s. Three guards, three different things.
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        logger.warning("[content-safety] refusing non-http(s) endpoint URL: %s", url)
        return {}
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with _OPENER.open(req, timeout=5) as resp:
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
