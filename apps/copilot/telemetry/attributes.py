"""Canonical OpenTelemetry span + log attribute names for the Copilot.

These names are the **only** valid attribute keys used on
``copilot.*`` spans.  Centralising them here prevents drift (e.g. one
module emitting ``copilot.q_hash`` while another emits
``copilot.question_hash``) which would break dashboards and alerts.

The :class:`SpanAttribute` enum values are the wire-format strings
exported to OTLP receivers.  Import the enum in every module that
emits spans so the linter (and type-checker) catches typos at authoring
time.

All attribute values MUST be OTel-compatible scalars or sequences of
scalars — never arbitrary Python objects.  See
:func:`apps.copilot.telemetry.spans.copilot_span` for the set-time
coercion helper that enforces this.
"""

from __future__ import annotations

from enum import Enum


class SpanAttribute(str, Enum):
    """Canonical attribute keys used on ``copilot.*`` spans.

    Inherits from ``str`` so it is directly usable wherever a string
    key is expected (e.g. ``span.set_attribute(SpanAttribute.FOO, v)``
    still produces the wire string ``copilot.foo``).
    """

    # -- Request-level ------------------------------------------------------
    QUESTION_HASH = "copilot.question_hash"
    CONVERSATION_ID = "copilot.conversation_id"
    TOP_K = "copilot.top_k"
    EXTRA_CONTEXT_PRESENT = "copilot.extra_context_present"

    # -- Retrieval ----------------------------------------------------------
    RETRIEVAL_RESULTS = "copilot.retrieval_results"
    RETRIEVAL_SEMANTIC_USED = "copilot.retrieval_semantic_used"

    # -- Grounding ----------------------------------------------------------
    GROUNDEDNESS = "copilot.groundedness"
    COVERAGE_GROUNDED = "copilot.coverage_grounded"
    COVERAGE_CHUNKS_ABOVE = "copilot.coverage_chunks_above"

    # -- Generation ---------------------------------------------------------
    PROMPT_ID = "copilot.prompt_id"
    PROMPT_VERSION = "copilot.prompt_version"
    PROMPT_CONTENT_HASH = "copilot.prompt_content_hash"
    GENERATION_TOKENS = "copilot.generation_tokens"

    # -- Verification -------------------------------------------------------
    VERIFICATION_VALID = "copilot.verification_valid"
    MISSING_MARKERS = "copilot.verification_missing_markers"
    FABRICATED_IDS = "copilot.verification_fabricated_ids"

    # -- Outcome ------------------------------------------------------------
    REFUSED = "copilot.refused"
    REFUSAL_REASON = "copilot.refusal_reason"
    SKILL_ID = "copilot.skill_id"
    TOOL_CATEGORY = "copilot.tool_category"
    TOOL_NAME = "copilot.tool_name"
    BROKER_ACTION = "copilot.broker_action"

    # -- Eval harness -------------------------------------------------------
    EVAL_CASE_ID = "copilot.eval_case_id"
    EVAL_RUBRIC = "copilot.eval_rubric"
    EVAL_SCORE = "copilot.eval_score"
    EVAL_LATENCY_MS = "copilot.eval_latency_ms"


# Sensitive substrings that should never appear on span attributes.  The
# telemetry helpers scrub these when serialising values — e.g. an
# ``OTLP_ENDPOINT`` that accidentally includes a bearer token.  The list
# is deliberately short and conservative; callers should avoid setting
# credentials as attributes in the first place.
_SENSITIVE_ATTRIBUTE_SUBSTRINGS: tuple[str, ...] = (
    "api-key",
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "password",
    "secret",
    "token",
)


def sanitize_attribute_value(key: str, value: object) -> object:
    """Return a safe-to-export form of *value* for attribute *key*.

    * Strings containing any of :data:`_SENSITIVE_ATTRIBUTE_SUBSTRINGS`
      (case-insensitive) are redacted to ``"<redacted>"``.
    * ``None`` becomes the empty string so OTel's strict type check
      does not drop the attribute entirely.
    * Unsupported types (tuples, sets, nested dicts) are coerced via
      ``str()`` so the export never fails — this is defensive; callers
      should still provide scalars.
    """
    if isinstance(value, str):
        lowered = value.lower()
        if any(needle in lowered for needle in _SENSITIVE_ATTRIBUTE_SUBSTRINGS):
            return "<redacted>"
        return value
    if value is None:
        return ""
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [sanitize_attribute_value(key, v) for v in value]
    return str(value)


__all__ = [
    "SpanAttribute",
    "sanitize_attribute_value",
]
