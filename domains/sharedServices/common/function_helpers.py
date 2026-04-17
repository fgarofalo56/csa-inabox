"""Shared helper utilities for CSA-in-a-Box Azure Function Apps.

Provides standardised response builders and constants used across all
shared-service function apps so each app stays DRY and responses remain
consistent for monitoring and alerting.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import azure.functions as func

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Maximum blob size (in bytes) accepted for document analysis (50 MB).
#: Azure AI Document Intelligence has a hard 500 MB limit, but we keep a
#: conservative 50 MB ceiling to protect memory on the Functions consumption
#: plan.
MAX_BLOB_SIZE: int = 50 * 1024 * 1024  # 50 MB


# ---------------------------------------------------------------------------
# Response builders
# ---------------------------------------------------------------------------


def build_health_response(service_name: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return the standard health-check payload dict for *service_name*.

    Args:
        service_name: Human-readable service identifier, e.g. ``"ai-enrichment"``.
        extra: Optional additional fields merged into the response (e.g.
            ``{"kv_configured": True}``).  Callers use this to surface
            service-specific readiness checks without building a custom dict.

    Returns:
        A JSON-serialisable dict with at minimum ``status``, ``service``,
        and ``timestamp`` keys.

    Example::

        return func.HttpResponse(
            json.dumps(build_health_response("my-service")),
            status_code=200,
            mimetype="application/json",
        )
    """
    payload: dict[str, Any] = {
        "status": "healthy",
        "service": service_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if extra:
        payload.update(extra)
    return payload


def build_error_response(
    status_code: int,
    message: str,
    details: dict[str, Any] | None = None,
) -> func.HttpResponse:
    """Return a standard error :class:`azure.functions.HttpResponse`.

    Args:
        status_code: HTTP status code (e.g. ``400``, ``500``).
        message: Human-readable error description placed in the ``"error"``
            field of the JSON body.
        details: Optional extra fields merged into the response body (e.g.
            ``{"secret_name": "...", "service": "storage"}``).

    Returns:
        A :class:`func.HttpResponse` with ``mimetype="application/json"``.

    Example::

        return build_error_response(400, "Missing 'text' field")
        return build_error_response(503, "Azure SDK error", {"error_type": "ServiceRequestError"})
    """
    body: dict[str, Any] = {"error": message}
    if details:
        body.update(details)
    return func.HttpResponse(
        json.dumps(body),
        status_code=status_code,
        mimetype="application/json",
    )
