"""Azure OpenAI chat-completions transport for the notebook AI-functions bridge.

A single ``call_chat`` helper performs one chat round-trip with:

* api-key OR AAD bearer auth (resolved in ``_auth``),
* the reasoning-model temperature fallback copied from
  ``ai-functions-client.ts`` (some models reject ``temperature``),
* exponential-backoff retry on HTTP 429,
* typed, actionable errors for the common misconfigurations (missing
  endpoint, missing deployment, exhausted retries).

Only ``requests`` is used — no ``openai`` SDK — so the wheel stays small and
installs cleanly on DEP-locked Synapse pools that cannot reach PyPI.
"""

from __future__ import annotations

import time

import requests

from ._auth import get_bearer_token
from ._config import get_api_key, get_deployment, get_endpoint
from ._errors import (
    AoaiBridgeConfigError,
    AoaiBridgeDeploymentError,
    AoaiBridgeError,
    AoaiBridgeRateLimitError,
)

# Pinned GA chat-completions API version (matches the Console BFF default).
API_VERSION = "2024-10-21"
_MAX_RETRIES = 3
_BASE_DELAY_S = 2.0
_TIMEOUT_S = 60

# Markers that mean "this model rejects an explicit temperature" — retry bare.
_TEMP_REJECT_MARKERS = ("unsupported_value", "does not support", "Only the default")


def _strip_fences(text: str) -> str:
    """Drop a leading/trailing markdown code fence the model sometimes adds."""
    trimmed = text.strip()
    if trimmed.startswith("```"):
        body = trimmed[3:]
        newline = body.find("\n")
        if newline != -1:
            body = body[newline + 1 :]
        if body.rstrip().endswith("```"):
            body = body.rstrip()[:-3]
        return body.strip()
    return trimmed


def call_chat(system_prompt: str, user_text: str, max_tokens: int = 800) -> str:
    """Run one AOAI chat completion and return the assistant's text.

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

    deployment = get_deployment()
    url = f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={API_VERSION}"

    headers = {"content-type": "application/json"}
    api_key = get_api_key()
    if api_key:
        headers["api-key"] = api_key
    else:
        token = get_bearer_token()
        if token:
            headers["authorization"] = f"Bearer {token}"

    base_body = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        "max_tokens": max_tokens,
    }

    def _post(with_temperature: bool) -> requests.Response:
        body = {**base_body, "temperature": 0} if with_temperature else base_body
        return requests.post(url, json=body, headers=headers, timeout=_TIMEOUT_S)

    for attempt in range(_MAX_RETRIES):
        resp = _post(with_temperature=True)

        if (
            resp.status_code == 400
            and "temperature" in resp.text
            and any(m in resp.text for m in _TEMP_REJECT_MARKERS)
        ):
            resp = _post(with_temperature=False)

        if resp.status_code == 429:
            if attempt < _MAX_RETRIES - 1:
                time.sleep(_BASE_DELAY_S * (2**attempt))
                continue
            raise AoaiBridgeRateLimitError(
                f"Azure OpenAI rate-limited the request after {_MAX_RETRIES} retries. "
                "Lower the batch concurrency (LOOM_AI_FN_WORKERS) or raise the deployment's "
                "tokens-per-minute quota in the AI Foundry hub."
            )

        if resp.status_code == 404:
            raise AoaiBridgeDeploymentError(
                f"Azure OpenAI deployment '{deployment}' was not found at {endpoint}. "
                "Deploy gpt-4o (or set LOOM_AOAI_DEPLOYMENT to an existing deployment) from "
                "the AI Foundry hub: Admin -> AI Foundry -> Quota + usage -> Deploy."
            )

        if not resp.ok:
            raise AoaiBridgeError(
                f"Azure OpenAI call failed ({resp.status_code}): {resp.text[:400]}"
            )

        payload = resp.json()
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        return _strip_fences(content)

    raise AoaiBridgeError("Exhausted retries without a successful Azure OpenAI response.")
