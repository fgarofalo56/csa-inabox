"""Azure OpenAI embeddings transport for the notebook AI-functions bridge.

Backs the ``embed`` and ``similarity`` functions (the two embeddings-class AI
functions, kept 1:1 with ``ai-functions-client.ts`` on the Console side). Uses
the AOAI embeddings data-plane over ``requests`` only (no ``openai`` SDK) with
the same api-key / AAD-bearer auth and 429 backoff as the chat client, so the
wheel stays small and installs on DEP-locked Synapse pools.
"""

from __future__ import annotations

import math
import time

import requests

from ._auth import get_bearer_token
from ._config import get_api_key, get_embed_deployment, get_endpoint
from ._errors import (
    AoaiBridgeConfigError,
    AoaiBridgeDeploymentError,
    AoaiBridgeError,
    AoaiBridgeRateLimitError,
)

# Embeddings GA api-version (matches the Console BFF default family).
API_VERSION = "2024-10-21"
_MAX_RETRIES = 3
_BASE_DELAY_S = 2.0
_TIMEOUT_S = 60


def _headers() -> dict[str, str]:
    headers = {"content-type": "application/json"}
    api_key = get_api_key()
    if api_key:
        headers["api-key"] = api_key
    else:
        token = get_bearer_token()
        if token:
            headers["authorization"] = f"Bearer {token}"
    return headers


def call_embed(texts: list[str]) -> list[list[float]]:
    """Embed a list of texts, returning one vector per input (index-aligned).

    Raises a typed :class:`AoaiBridgeError` subclass on any failure so a cell
    sees an actionable message rather than a silent empty result.
    """
    endpoint = get_endpoint()
    if not endpoint:
        raise AoaiBridgeConfigError(
            "LOOM_AOAI_ENDPOINT is not set. Set it in the Spark pool environment "
            "(via platform/fiab/bootstrap/ai-functions-pool-setup.sh) or run, before "
            "importing ai_functions:\n"
            "    spark.conf.set('spark.loom.aoai.endpoint', 'https://<account>.openai.azure.com')"
        )

    deployment = get_embed_deployment()
    url = f"{endpoint}/openai/deployments/{deployment}/embeddings?api-version={API_VERSION}"
    headers = _headers()
    body = {"input": texts}

    for attempt in range(_MAX_RETRIES):
        resp = requests.post(url, json=body, headers=headers, timeout=_TIMEOUT_S)

        if resp.status_code == 429:
            if attempt < _MAX_RETRIES - 1:
                time.sleep(_BASE_DELAY_S * (2**attempt))
                continue
            raise AoaiBridgeRateLimitError(
                f"Azure OpenAI rate-limited the embeddings request after {_MAX_RETRIES} retries. "
                "Lower the batch size or raise the embeddings deployment's tokens-per-minute "
                "quota in the AI Foundry hub."
            )

        if resp.status_code == 404:
            raise AoaiBridgeDeploymentError(
                f"Azure OpenAI embeddings deployment '{deployment}' was not found at {endpoint}. "
                "Deploy text-embedding-3-large (or set LOOM_AOAI_EMBED_DEPLOYMENT to an existing "
                "deployment) from the AI Foundry hub: Admin -> AI Foundry -> Quota + usage -> Deploy."
            )

        if not resp.ok:
            raise AoaiBridgeError(
                f"Azure OpenAI embeddings call failed ({resp.status_code}): {resp.text[:400]}"
            )

        payload = resp.json()
        data = payload.get("data", [])
        # Sort by the returned index so ordering is guaranteed to match `texts`.
        data = sorted(data, key=lambda d: d.get("index", 0))
        return [d.get("embedding", []) for d in data]

    raise AoaiBridgeError("Exhausted retries without a successful Azure OpenAI embeddings response.")


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity of two vectors in [-1, 1]; 0 when either is zero-magnitude."""
    n = min(len(a), len(b))
    dot = na = nb = 0.0
    for i in range(n):
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))
