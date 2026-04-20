"""Azure Function: Teams alert notification service.

HTTP-triggered function that sends Adaptive Cards to Microsoft Teams
via incoming webhook URLs.

Endpoint: POST /api/send-teams-alert

Request body::

    {
        "title": "Data Pipeline Alert",
        "severity": "warning",
        "message": "Pipeline X failed at step Y",
        "facts": {
            "Pipeline": "orders-etl",
            "Step": "silver-transform",
            "Error": "Schema mismatch",
            "Environment": "prod"
        },
        "webhook_url": "https://..."
    }

Response::

    {
        "delivered": true,
        "status_code": 200,
        "message": "Alert sent successfully"
    }
"""

from __future__ import annotations

import json
import os
from typing import Any

import azure.functions as func

from csa_platform.common.logging import configure_structlog, get_logger

try:
    import requests
except ImportError:
    requests = None  # type: ignore[assignment]

configure_structlog(service="send-teams-alert")
logger = get_logger(__name__)

app = func.FunctionApp()


# ---------------------------------------------------------------------------
# Severity styles
# ---------------------------------------------------------------------------

_SEVERITY_CONFIG: dict[str, dict[str, str]] = {
    "critical": {"color": "Attention", "emoji": "\U0001f534", "hex": "FF0000"},
    "high": {"color": "Attention", "emoji": "\U0001f7e0", "hex": "FF6600"},
    "warning": {"color": "Warning", "emoji": "\U0001f7e1", "hex": "FFB800"},
    "info": {"color": "Accent", "emoji": "\U0001f535", "hex": "0078D4"},
    "success": {"color": "Good", "emoji": "\u2705", "hex": "00B050"},
}


# ---------------------------------------------------------------------------
# Card builder
# ---------------------------------------------------------------------------


def _build_adaptive_card(
    title: str,
    severity: str,
    message: str,
    facts: dict[str, str] | list[dict[str, str]] | None = None,
    actions: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Build a Teams Adaptive Card payload.

    Args:
        title: Alert title.
        severity: Severity level (critical, high, warning, info, success).
        message: Alert message body.
        facts: Key-value facts (dict or list of {title, value}).
        actions: Optional action buttons with title and url.

    Returns:
        JSON-serialisable Adaptive Card payload.
    """
    config = _SEVERITY_CONFIG.get(severity.lower(), _SEVERITY_CONFIG["info"])

    body: list[dict[str, Any]] = [
        {
            "type": "TextBlock",
            "size": "Large",
            "weight": "Bolder",
            "text": f"{config['emoji']} {title}",
            "wrap": True,
            "style": "heading",
            "color": config["color"] if severity.lower() in ("critical", "high") else "Default",
        },
        {
            "type": "TextBlock",
            "text": f"Severity: **{severity.upper()}**",
            "weight": "Bolder",
            "spacing": "Small",
        },
        {
            "type": "TextBlock",
            "text": message,
            "wrap": True,
            "spacing": "Medium",
        },
    ]

    # Handle facts in both dict and list-of-dicts format
    if facts:
        if isinstance(facts, dict):
            fact_items = [{"title": k, "value": str(v)} for k, v in facts.items()]
        else:
            fact_items = [{"title": f.get("title", ""), "value": f.get("value", "")} for f in facts]
        body.append(
            {
                "type": "FactSet",
                "facts": fact_items,
                "spacing": "Medium",
            }
        )

    card_actions: list[dict[str, Any]] = []
    if actions:
        for action in actions:
            card_actions.append(
                {
                    "type": "Action.OpenUrl",
                    "title": action.get("title", "View"),
                    "url": action.get("url", "#"),
                }
            )

    card_content: dict[str, Any] = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.5",
        "msteams": {"width": "Full"},
        "body": body,
    }
    if card_actions:
        card_content["actions"] = card_actions

    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "contentUrl": None,
                "content": card_content,
            }
        ],
    }


# ---------------------------------------------------------------------------
# Azure Function entry point
# ---------------------------------------------------------------------------


@app.function_name("send_teams_alert")
@app.route(route="send-teams-alert", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def send_teams_alert(req: func.HttpRequest) -> func.HttpResponse:
    """Send an Adaptive Card alert to a Microsoft Teams channel.

    Accepts a JSON body with ``title``, ``severity``, ``message``, and
    optional ``facts``, ``actions``, and ``webhook_url``.  Falls back to
    the ``TEAMS_WEBHOOK_URL`` environment variable if no URL is provided.

    Args:
        req: The HTTP request.

    Returns:
        JSON response with delivery status.
    """
    logger.info("Teams alert request received")

    if requests is None:
        return func.HttpResponse(
            json.dumps({"error": "'requests' library is not installed"}),
            status_code=500,
            mimetype="application/json",
        )

    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON in request body"}),
            status_code=400,
            mimetype="application/json",
        )

    title = body.get("title", "CSA-in-a-Box Alert")
    severity = body.get("severity", "info")
    message = body.get("message", "")
    facts = body.get("facts")
    actions = body.get("actions")
    webhook_url = body.get("webhook_url") or os.environ.get("TEAMS_WEBHOOK_URL", "")

    if not webhook_url:
        return func.HttpResponse(
            json.dumps(
                {"error": "No webhook URL provided. Set 'webhook_url' in request or TEAMS_WEBHOOK_URL env var."}
            ),
            status_code=400,
            mimetype="application/json",
        )

    if not message:
        return func.HttpResponse(
            json.dumps({"error": "'message' field is required"}),
            status_code=400,
            mimetype="application/json",
        )

    card = _build_adaptive_card(title, severity, message, facts, actions)

    try:
        resp = requests.post(
            webhook_url,
            json=card,
            headers={"Content-Type": "application/json"},
            timeout=10,
        )

        delivered = resp.status_code in (200, 202)

        result = {
            "delivered": delivered,
            "status_code": resp.status_code,
            "message": "Alert sent successfully" if delivered else f"Delivery failed: {resp.text[:200]}",
        }

        if delivered:
            logger.info("teams_alert.delivered", title=title, severity=severity)
        else:
            logger.warning(
                "Teams alert delivery failed: %s (status=%d)",
                title,
                resp.status_code,
            )

        return func.HttpResponse(
            json.dumps(result),
            status_code=200,
            mimetype="application/json",
        )

    except requests.exceptions.Timeout:
        logger.error("Teams webhook request timed out")
        return func.HttpResponse(
            json.dumps(
                {
                    "delivered": False,
                    "status_code": 408,
                    "message": "Webhook request timed out",
                }
            ),
            status_code=200,
            mimetype="application/json",
        )
    except Exception as exc:
        logger.exception("Failed to send Teams alert")
        return func.HttpResponse(
            json.dumps(
                {
                    "delivered": False,
                    "status_code": 500,
                    "message": f"Error: {exc}",
                }
            ),
            status_code=500,
            mimetype="application/json",
        )
