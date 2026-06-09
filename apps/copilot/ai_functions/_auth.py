"""Token acquisition for the Loom notebook AI-functions bridge.

Auth precedence (matches ``ai-functions-client.ts`` on the Console side):

1. ``LOOM_AOAI_KEY`` set  → API-key auth; no token is fetched.
2. otherwise              → AAD bearer token from the Spark pool's managed
   identity. A user-assigned identity is preferred when ``LOOM_UAMI_CLIENT_ID``
   / ``AZURE_CLIENT_ID`` is set (Synapse pools attach a UAMI); otherwise the
   chained default credential resolves the system-assigned MSI.

Tokens are cached per-process and refreshed five minutes before expiry, so a
batch of hundreds of rows shares a single token round-trip per executor.
"""

from __future__ import annotations

import threading
import time

from ._config import get_api_key, get_audience, get_uami_client_id
from ._errors import AoaiBridgeAuthError

# Refresh this many seconds before the token's real expiry to avoid races.
_TOKEN_SLACK_SEC = 300

_LOCK = threading.Lock()
_TOKEN_CACHE: dict[str, float | str] = {}


def _is_expired() -> bool:
    expires_at = _TOKEN_CACHE.get("expires_at", 0.0)
    return time.time() >= float(expires_at) - _TOKEN_SLACK_SEC


def reset_token_cache() -> None:
    """Drop any cached token. Used by tests and after an identity change."""
    with _LOCK:
        _TOKEN_CACHE.clear()


def get_bearer_token() -> str | None:
    """Return an AOAI bearer token, or ``None`` when API-key auth is in effect.

    Raises :class:`AoaiBridgeAuthError` with an actionable message when token
    acquisition fails (almost always a missing role assignment on the Spark
    pool's identity).
    """
    if get_api_key():
        return None  # caller sends the api-key header instead

    with _LOCK:
        cached = _TOKEN_CACHE.get("token")
        if cached and not _is_expired():
            return str(cached)

    audience = get_audience()
    client_id = get_uami_client_id()
    try:
        from azure.identity import (
            ChainedTokenCredential,
            DefaultAzureCredential,
            ManagedIdentityCredential,
        )

        if client_id:
            credential = ChainedTokenCredential(
                ManagedIdentityCredential(client_id=client_id),
                DefaultAzureCredential(),
            )
        else:
            credential = DefaultAzureCredential()
        token = credential.get_token(f"{audience}/.default")
    except Exception as exc:
        raise AoaiBridgeAuthError(
            f"Failed to acquire an Azure OpenAI token (audience={audience}): {exc}. "
            "The Spark pool's managed identity needs the 'Cognitive Services OpenAI User' "
            "role on the AI Services account (aoai-csa-loom-<region>). Deploy the grant "
            "via platform/fiab/bicep/modules/admin-plane/aoai-spark-rbac.bicep, or set "
            "LOOM_AOAI_KEY for key-based auth."
        ) from exc

    with _LOCK:
        _TOKEN_CACHE["token"] = token.token
        _TOKEN_CACHE["expires_at"] = float(token.expires_on)
    return token.token
