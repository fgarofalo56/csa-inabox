"""Microsoft Teams Adaptive Card builder for alert notifications.

Builds rich alert cards with severity colours, metric values, and
recommended actions for each alert type (seismic, air quality, park
capacity, pipeline failure, data freshness, gaming anomaly).

Usage::

    from teams_card import build_alert_card
    from notifier import AlertPayload

    payload = AlertPayload(rule_name="seismic-alert", severity="critical", ...)
    card = build_alert_card(payload)
    # POST card JSON to Teams incoming webhook
"""

from __future__ import annotations

from typing import Any

# Import within package
from .notifier import AlertPayload


# ---------------------------------------------------------------------------
# Severity → colour mapping
# ---------------------------------------------------------------------------

_SEVERITY_COLOURS: dict[str, str] = {
    "critical": "attention",  # Red
    "warning": "warning",     # Yellow / Orange
    "info": "accent",         # Blue
}

_SEVERITY_EMOJI: dict[str, str] = {
    "critical": "\U0001f534",  # Red circle
    "warning": "\U0001f7e0",   # Orange circle
    "info": "\U0001f535",      # Blue circle
}

_SEVERITY_HEX: dict[str, str] = {
    "critical": "FF0000",
    "warning": "FF8C00",
    "info": "0078D4",
}


# ---------------------------------------------------------------------------
# Card builders
# ---------------------------------------------------------------------------


def _build_header(payload: AlertPayload) -> dict[str, Any]:
    """Build the card header with severity styling.

    Args:
        payload: The alert payload.

    Returns:
        Adaptive Card ``TextBlock`` element.
    """
    emoji = _SEVERITY_EMOJI.get(payload.severity, "\U0001f535")
    return {
        "type": "TextBlock",
        "size": "Large",
        "weight": "Bolder",
        "text": f"{emoji} {payload.rule_name}",
        "wrap": True,
        "style": "heading",
    }


def _build_severity_badge(payload: AlertPayload) -> dict[str, Any]:
    """Build a coloured severity badge.

    Args:
        payload: The alert payload.

    Returns:
        Adaptive Card ``TextBlock`` element.
    """
    colour = _SEVERITY_COLOURS.get(payload.severity, "default")
    return {
        "type": "TextBlock",
        "text": f"Severity: **{payload.severity.upper()}**",
        "color": colour,
        "weight": "Bolder",
        "spacing": "Small",
    }


def _build_facts(payload: AlertPayload) -> dict[str, Any]:
    """Build the facts section with metric details.

    Args:
        payload: The alert payload.

    Returns:
        Adaptive Card ``FactSet`` element.
    """
    facts = [
        {"title": "Rule", "value": payload.rule_name},
        {"title": "Field", "value": payload.field},
        {"title": "Value", "value": str(payload.actual_value)},
        {"title": "Threshold", "value": str(payload.threshold)},
        {"title": "Source", "value": payload.source or "N/A"},
        {"title": "Timestamp", "value": payload.timestamp or "N/A"},
    ]

    # Add relevant metadata as facts
    for key, value in payload.metadata.items():
        if key in ("domain", "data_product", "priority", "operator"):
            facts.append({"title": key.replace("_", " ").title(), "value": str(value)})

    return {
        "type": "FactSet",
        "facts": facts,
    }


def _build_description(payload: AlertPayload) -> dict[str, Any]:
    """Build the description text block.

    Args:
        payload: The alert payload.

    Returns:
        Adaptive Card ``TextBlock`` element.
    """
    return {
        "type": "TextBlock",
        "text": payload.description or "No description provided.",
        "wrap": True,
        "spacing": "Medium",
    }


def _get_recommended_actions(payload: AlertPayload) -> list[str]:
    """Get recommended actions based on the alert type.

    Args:
        payload: The alert payload.

    Returns:
        List of recommended action strings.
    """
    tags = payload.metadata.get("tags", {})
    domain = tags.get("domain", "") if isinstance(tags, dict) else ""

    if "seismic" in payload.rule_name.lower():
        return [
            "Check USGS earthquake feed for event details",
            "Verify affected infrastructure in the region",
            "Notify emergency response teams if magnitude >= 6.0",
        ]
    if "air" in payload.rule_name.lower() or domain == "epa":
        return [
            "Issue public health advisory for affected area",
            "Check sensor calibration and data quality",
            "Review historical AQI trend for context",
        ]
    if "park" in payload.rule_name.lower() or domain == "nps":
        return [
            "Activate crowd management protocols",
            "Update park capacity signage",
            "Consider temporary entry restrictions",
        ]
    if "pipeline" in payload.rule_name.lower():
        return [
            "Review pipeline run logs in ADF/Databricks",
            "Check source system availability",
            "Verify data lake storage health",
            "Escalate if data SLA is at risk",
        ]
    if "freshness" in payload.rule_name.lower():
        return [
            "Check pipeline execution history",
            "Verify source system is publishing data",
            "Review data contract SLA requirements",
        ]
    if "slot" in payload.rule_name.lower() or "gaming" in payload.rule_name.lower():
        return [
            "Flag machine for physical inspection",
            "Review security camera footage",
            "Cross-reference with player tracking data",
            "Notify gaming commission if tampering confirmed",
        ]

    return ["Investigate the alert and take appropriate action"]


def _build_actions_section(payload: AlertPayload) -> list[dict[str, Any]]:
    """Build the recommended actions as a numbered list.

    Args:
        payload: The alert payload.

    Returns:
        List of Adaptive Card ``TextBlock`` elements.
    """
    actions = _get_recommended_actions(payload)
    action_text = "\n".join(f"{i+1}. {a}" for i, a in enumerate(actions))
    return [
        {
            "type": "TextBlock",
            "text": "**Recommended Actions:**",
            "weight": "Bolder",
            "spacing": "Medium",
        },
        {
            "type": "TextBlock",
            "text": action_text,
            "wrap": True,
            "spacing": "Small",
        },
    ]


# ---------------------------------------------------------------------------
# Main builder
# ---------------------------------------------------------------------------


def build_alert_card(payload: AlertPayload) -> dict[str, Any]:
    """Build a complete Teams Adaptive Card for an alert.

    Returns a JSON-serialisable dictionary suitable for POST to a Teams
    incoming webhook URL.

    Args:
        payload: The alert payload.

    Returns:
        Adaptive Card JSON structure wrapped in a MessageCard envelope.
    """
    body: list[dict[str, Any]] = [
        _build_header(payload),
        _build_severity_badge(payload),
        {"type": "TextBlock", "text": "---", "spacing": "Small"},
        _build_description(payload),
        _build_facts(payload),
    ]
    body.extend(_build_actions_section(payload))

    adaptive_card = {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.5",
        "body": body,
    }

    # Wrap in the Teams webhook message format
    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "contentUrl": None,
                "content": adaptive_card,
            }
        ],
    }


def build_simple_card(
    title: str,
    message: str,
    severity: str = "info",
    facts: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build a simple Teams message card (non-Adaptive).

    Useful for quick notifications that don't need the full Adaptive Card
    richness.

    Args:
        title: Card title.
        message: Message body.
        severity: Severity level for colour coding.
        facts: Optional key-value facts to display.

    Returns:
        MessageCard JSON structure.
    """
    colour = _SEVERITY_HEX.get(severity, "0078D4")

    sections: list[dict[str, Any]] = [
        {
            "activityTitle": title,
            "activitySubtitle": f"Severity: {severity.upper()}",
            "text": message,
            "markdown": True,
        }
    ]

    if facts:
        sections[0]["facts"] = [{"name": k, "value": v} for k, v in facts.items()]

    return {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        "themeColor": colour,
        "summary": title,
        "sections": sections,
    }
