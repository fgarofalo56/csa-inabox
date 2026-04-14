"""Azure Function: PII detection service.

HTTP-triggered function that scans text fields for personally identifiable
information (PII) patterns including Social Security Numbers, email
addresses, phone numbers, credit card numbers, and more.

Endpoint: POST /api/detect-pii

Request body (option A — list of texts)::

    {
        "texts": [
            "Contact John at 555-123-4567 or john@example.com",
            "SSN: 123-45-6789, CC: 4111111111111111"
        ],
        "categories": ["ssn", "email", "phone", "credit_card"]
    }

Request body (option B — named fields, backward compatible)::

    {
        "fields": {
            "address": "123 Main St",
            "notes": "SSN 123-45-6789"
        }
    }

Response::

    {
        "results": [...],
        "summary": {
            "texts_scanned": 2,
            "texts_with_pii": 2,
            "total_detections": 4
        }
    }
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass
from typing import Any

import azure.functions as func

logger = logging.getLogger(__name__)

app = func.FunctionApp()


# ---------------------------------------------------------------------------
# PII patterns
# ---------------------------------------------------------------------------


@dataclass
class PIIDetection:
    """A single PII detection in text.

    Attributes:
        category: PII category name.
        value: The detected PII value (masked for safety).
        start: Start character offset.
        end: End character offset.
        confidence: Detection confidence (0.0-1.0).
        description: Human-readable pattern description.
    """

    category: str
    value: str
    start: int
    end: int
    confidence: float = 0.9
    description: str = ""


# Pattern definitions: (category, compiled regex, confidence, description)
_PII_PATTERNS: list[tuple[str, re.Pattern[str], float, str]] = [
    ("ssn", re.compile(r"\b(\d{3}-\d{2}-\d{4})\b"), 0.95, "Social Security Number (XXX-XX-XXXX)"),
    ("ssn", re.compile(r"\b(\d{9})\b"), 0.60, "Possible SSN without dashes (9 digits)"),
    ("email", re.compile(r"\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b"), 0.98, "Email address"),
    ("phone", re.compile(r"\b(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b"), 0.90, "US phone number"),
    ("credit_card", re.compile(r"\b(4\d{3}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b"), 0.95, "Credit card (Visa)"),
    ("credit_card", re.compile(r"\b(5[1-5]\d{2}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b"), 0.95, "Credit card (Mastercard)"),
    ("credit_card", re.compile(r"\b(3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5})\b"), 0.95, "Credit card (Amex)"),
    ("date_of_birth", re.compile(r"\b((?:0[1-9]|1[0-2])[/\-](?:0[1-9]|[12]\d|3[01])[/\-](?:19|20)\d{2})\b"), 0.70, "Date of birth"),
    ("passport", re.compile(r"\b([A-Z]\d{8})\b"), 0.65, "Possible US passport number"),
    ("ip_address", re.compile(r"\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b"), 0.80, "IPv4 address"),
    ("iban", re.compile(r"\b([A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}(?:[A-Z0-9]?){0,16})\b"), 0.85, "IBAN"),
]


def _mask_value(value: str, category: str) -> str:
    """Redact a PII value, keeping last few chars for reference.

    Args:
        value: The raw PII value.
        category: PII category name.

    Returns:
        Masked version of the value.
    """
    if category in ("ssn",):
        return "***-**-" + value[-4:] if len(value) >= 4 else "****"
    if category == "credit_card":
        return "****-****-****-" + value[-4:] if len(value) >= 4 else "****"
    if category == "email":
        parts = value.split("@")
        return parts[0][:2] + "***@" + parts[1] if len(parts) == 2 else "***"
    if category == "phone":
        return "***-***-" + value[-4:] if len(value) >= 4 else "****"
    if len(value) > 4:
        return value[:2] + "*" * (len(value) - 4) + value[-2:]
    return "****"


def _detect_pii_in_text(
    text: str,
    categories: set[str] | None = None,
) -> list[PIIDetection]:
    """Scan a single text string for PII patterns.

    Args:
        text: The text to scan.
        categories: Optional set of categories to limit detection.

    Returns:
        List of :class:`PIIDetection` objects, sorted by position.
    """
    detections: list[PIIDetection] = []

    for category, pattern, confidence, description in _PII_PATTERNS:
        if categories and category not in categories:
            continue

        for match in pattern.finditer(text):
            masked = _mask_value(match.group(1), category)
            detections.append(
                PIIDetection(
                    category=category,
                    value=masked,
                    start=match.start(1),
                    end=match.end(1),
                    confidence=confidence,
                    description=description,
                )
            )

    # Deduplicate overlapping detections (keep highest confidence)
    detections.sort(key=lambda d: (-d.confidence, d.start))
    seen_ranges: list[tuple[int, int]] = []
    unique: list[PIIDetection] = []
    for det in detections:
        overlap = any(det.start < e and det.end > s for s, e in seen_ranges)
        if not overlap:
            unique.append(det)
            seen_ranges.append((det.start, det.end))

    return sorted(unique, key=lambda d: d.start)


# ---------------------------------------------------------------------------
# Azure Function entry point
# ---------------------------------------------------------------------------


@app.function_name("detect_pii")
@app.route(route="detect-pii", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def detect_pii(req: func.HttpRequest) -> func.HttpResponse:
    """Scan text fields for PII patterns and return detections.

    Accepts a JSON body with either ``texts`` (list of strings), ``text``
    (single string), or ``fields`` (dict of named text fields).

    Args:
        req: The HTTP request.

    Returns:
        JSON response with per-text PII detections and summary statistics.
    """
    logger.info("PII detection request received")

    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON in request body"}),
            status_code=400,
            mimetype="application/json",
        )

    texts: list[str] | None = body.get("texts")
    single_text: str | None = body.get("text")
    fields: dict[str, str] | None = body.get("fields")
    category_filter = body.get("categories")

    # Normalize inputs into a list of (label, text) pairs
    items: list[tuple[str, str]] = []
    if texts:
        for i, t in enumerate(texts):
            items.append((str(i), str(t) if not isinstance(t, str) else t))
    elif single_text:
        items.append(("_text", single_text))
    elif fields:
        for name, val in fields.items():
            if isinstance(val, str):
                items.append((name, val))
    else:
        return func.HttpResponse(
            json.dumps({"error": "Provide 'texts', 'text', or 'fields'"}),
            status_code=400,
            mimetype="application/json",
        )

    categories = set(category_filter) if category_filter else None
    results: list[dict[str, Any]] = []
    total_detections = 0
    texts_with_pii = 0

    for label, text in items:
        detections = _detect_pii_in_text(text, categories=categories)
        has_pii = len(detections) > 0
        total_detections += len(detections)
        if has_pii:
            texts_with_pii += 1

        preview = text[:50] + "..." if len(text) > 50 else text

        results.append({
            "index": label,
            "text_preview": preview,
            "pii_detected": has_pii,
            "detections": [asdict(d) for d in detections],
        })

    response = {
        "pii_detected": total_detections > 0,
        "results": results,
        "summary": {
            "texts_scanned": len(items),
            "texts_with_pii": texts_with_pii,
            "total_detections": total_detections,
        },
    }

    logger.info(
        "PII detection complete: %d texts, %d with PII, %d total detections",
        len(items),
        texts_with_pii,
        total_detections,
    )

    return func.HttpResponse(
        json.dumps(response),
        status_code=200,
        mimetype="application/json",
    )
