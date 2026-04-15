"""Azure Function: Data quality validation service.

HTTP-triggered function that evaluates data quality rules against a
payload and returns quality scores and violations.

Endpoint: POST /api/validate-quality

Request body::

    {
        "data": [
            {"id": 1, "name": "Alice", "age": 30, "email": "alice@example.com"},
            {"id": 2, "name": "", "age": -5, "email": "invalid"}
        ],
        "rules": [
            {"type": "completeness", "fields": ["name", "email"]},
            {"type": "range", "field": "age", "min": 0, "max": 150},
            {"type": "regex", "field": "email", "pattern": "^[\\\\w.+-]+@[\\\\w-]+\\\\.[\\\\w.]+$"},
            {"type": "uniqueness", "field": "id"},
            {"type": "referential", "field": "status", "allowed_values": ["active", "inactive"]}
        ]
    }

Response::

    {
        "overall_score": 0.75,
        "rules_evaluated": 5,
        "violations": [...],
        "summary": {
            "total_rows": 2,
            "rules_passed": 3,
            "rules_failed": 2
        }
    }
"""

from __future__ import annotations

import json
import re
from typing import Any

import azure.functions as func

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="validate-quality")
logger = get_logger(__name__)

app = func.FunctionApp()


# ---------------------------------------------------------------------------
# Quality rule evaluators
# ---------------------------------------------------------------------------


def _check_completeness(
    data: list[dict[str, Any]],
    rule: dict[str, Any],
) -> dict[str, Any]:
    """Check that specified fields are not null or empty.

    Args:
        data: List of data records.
        rule: Rule definition with ``fields`` or ``column`` key.

    Returns:
        Result dictionary with violations and score.
    """
    fields = rule.get("fields", [])
    if not fields:
        column = rule.get("column", rule.get("field", ""))
        fields = [column] if column else []

    violations: list[dict[str, Any]] = []
    all_issue_rows: set[int] = set()

    for field_name in fields:
        field_issues: list[int] = []
        for idx, row in enumerate(data):
            value = row.get(field_name)
            if value is None or (isinstance(value, str) and value.strip() == ""):
                field_issues.append(idx)
        if field_issues:
            all_issue_rows.update(field_issues)
            violations.append(
                {
                    "rule": "completeness",
                    "field": field_name,
                    "row_indices": field_issues,
                    "message": f"Empty or null values found in '{field_name}'",
                    "score": 1.0 - (len(field_issues) / max(len(data), 1)),
                    "null_count": len(field_issues),
                }
            )

    score = 1.0 - (len(all_issue_rows) / max(len(data), 1))
    return {"violations": violations, "score": score}


def _check_range(
    data: list[dict[str, Any]],
    rule: dict[str, Any],
) -> dict[str, Any]:
    """Check that a numeric field falls within a defined range.

    Args:
        data: List of data records.
        rule: Rule definition with ``field``, ``min``/``min_value``,
            ``max``/``max_value`` keys.

    Returns:
        Result dictionary with violations and score.
    """
    field_name = rule.get("field", rule.get("column", ""))
    min_val = rule.get("min", rule.get("min_value"))
    max_val = rule.get("max", rule.get("max_value"))
    violations_idx: list[int] = []
    violation_details: list[dict[str, Any]] = []

    for idx, row in enumerate(data):
        value = row.get(field_name)
        if value is None:
            continue
        try:
            num_value = float(value)
            issue = None
            if min_val is not None and num_value < float(min_val):
                issue = f"below min {min_val}"
            elif max_val is not None and num_value > float(max_val):
                issue = f"above max {max_val}"
            if issue:
                violations_idx.append(idx)
                if len(violation_details) < 10:
                    violation_details.append({"row": idx, "value": num_value, "issue": issue})
        except (ValueError, TypeError):
            violations_idx.append(idx)
            if len(violation_details) < 10:
                violation_details.append({"row": idx, "value": value, "issue": "not numeric"})

    score = 1.0 - (len(violations_idx) / max(len(data), 1))
    result_violations: list[dict[str, Any]] = []
    if violations_idx:
        result_violations.append(
            {
                "rule": "range",
                "field": field_name,
                "row_indices": violations_idx,
                "message": f"Values outside range [{min_val}, {max_val}] in '{field_name}'",
                "score": score,
                "violation_count": len(violations_idx),
                "examples": violation_details,
            }
        )

    return {"violations": result_violations, "score": score}


def _check_regex(
    data: list[dict[str, Any]],
    rule: dict[str, Any],
) -> dict[str, Any]:
    """Check that a field matches a regular expression pattern.

    Args:
        data: List of data records.
        rule: Rule definition with ``field`` and ``pattern`` keys.

    Returns:
        Result dictionary with violations and score.
    """
    field_name = rule.get("field", rule.get("column", ""))
    pattern_str = rule.get("pattern", "")
    violations_idx: list[int] = []

    try:
        pattern = re.compile(pattern_str)
    except re.error as exc:
        return {
            "violations": [
                {
                    "rule": "regex",
                    "field": field_name,
                    "row_indices": [],
                    "message": f"Invalid regex pattern: {exc}",
                    "score": 0.0,
                }
            ],
            "score": 0.0,
        }

    for idx, row in enumerate(data):
        value = row.get(field_name)
        if value is None:
            continue
        if not pattern.match(str(value)):
            violations_idx.append(idx)

    score = 1.0 - (len(violations_idx) / max(len(data), 1))
    result_violations: list[dict[str, Any]] = []
    if violations_idx:
        result_violations.append(
            {
                "rule": "regex",
                "field": field_name,
                "row_indices": violations_idx,
                "message": f"Values not matching pattern '{pattern_str}' in '{field_name}'",
                "score": score,
                "violation_count": len(violations_idx),
            }
        )

    return {"violations": result_violations, "score": score}


def _check_uniqueness(
    data: list[dict[str, Any]],
    rule: dict[str, Any],
) -> dict[str, Any]:
    """Check that a field contains unique values (no duplicates).

    Args:
        data: List of data records.
        rule: Rule definition with ``field`` key.

    Returns:
        Result dictionary with violations and score.
    """
    field_name = rule.get("field", rule.get("column", ""))
    seen: dict[Any, list[int]] = {}

    for idx, row in enumerate(data):
        value = row.get(field_name)
        if value is None:
            continue
        seen.setdefault(value, []).append(idx)

    duplicate_indices: list[int] = []
    for _value, indices in seen.items():
        if len(indices) > 1:
            duplicate_indices.extend(indices)

    score = 1.0 - (len(duplicate_indices) / max(len(data), 1))
    result_violations: list[dict[str, Any]] = []
    if duplicate_indices:
        result_violations.append(
            {
                "rule": "uniqueness",
                "field": field_name,
                "row_indices": sorted(duplicate_indices),
                "message": f"Duplicate values found in '{field_name}'",
                "score": score,
                "duplicate_count": len(duplicate_indices),
            }
        )

    return {"violations": result_violations, "score": score}


def _check_referential(
    data: list[dict[str, Any]],
    rule: dict[str, Any],
) -> dict[str, Any]:
    """Check that a field's values exist in a reference set.

    Args:
        data: List of data records.
        rule: Rule definition with ``field`` and ``allowed_values`` keys.

    Returns:
        Result dictionary with violations and score.
    """
    field_name = rule.get("field", rule.get("column", ""))
    allowed_values = set(rule.get("allowed_values", []))
    violations_idx: list[int] = []

    if not allowed_values:
        return {"violations": [], "score": 1.0}

    for idx, row in enumerate(data):
        value = row.get(field_name)
        if value is not None and value not in allowed_values:
            violations_idx.append(idx)

    score = 1.0 - (len(violations_idx) / max(len(data), 1))
    result_violations: list[dict[str, Any]] = []
    if violations_idx:
        result_violations.append(
            {
                "rule": "referential",
                "field": field_name,
                "row_indices": violations_idx,
                "message": f"Values not in allowed set for '{field_name}'",
                "score": score,
            }
        )

    return {"violations": result_violations, "score": score}


# Dispatcher mapping rule type to evaluator
_RULE_EVALUATORS: dict[str, Any] = {
    "completeness": _check_completeness,
    "range": _check_range,
    "regex": _check_regex,
    "uniqueness": _check_uniqueness,
    "referential": _check_referential,
}


# ---------------------------------------------------------------------------
# Azure Function entry point
# ---------------------------------------------------------------------------


@app.function_name("validate_quality")
@app.route(route="validate-quality", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def validate_quality(req: func.HttpRequest) -> func.HttpResponse:
    """Validate data quality by running configurable rules against a payload.

    Accepts a JSON body with ``data`` (list of records) and ``rules``
    (list of quality rule definitions).  Also accepts legacy ``records``
    key for backward compatibility.

    Args:
        req: The HTTP request.

    Returns:
        JSON response with overall quality score, individual rule results,
        and violation details.
    """
    logger.info("Quality validation request received")

    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON in request body"}),
            status_code=400,
            mimetype="application/json",
        )

    data = body.get("data", body.get("records"))
    rules = body.get("rules")

    if not isinstance(data, list):
        return func.HttpResponse(
            json.dumps({"error": "'data' must be a list of records"}),
            status_code=400,
            mimetype="application/json",
        )

    if not isinstance(rules, list) or not rules:
        return func.HttpResponse(
            json.dumps({"error": "'rules' must be a non-empty list"}),
            status_code=400,
            mimetype="application/json",
        )

    all_violations: list[dict[str, Any]] = []
    rule_scores: list[float] = []
    rules_passed = 0
    rules_failed = 0

    for rule in rules:
        rule_type = rule.get("type", rule.get("rule", ""))
        evaluator = _RULE_EVALUATORS.get(rule_type)

        if evaluator is None:
            all_violations.append(
                {
                    "rule": rule_type,
                    "field": rule.get("field", ""),
                    "row_indices": [],
                    "message": f"Unknown rule type: '{rule_type}'",
                    "score": 0.0,
                }
            )
            rule_scores.append(0.0)
            rules_failed += 1
            continue

        try:
            result = evaluator(data, rule)
            all_violations.extend(result["violations"])
            rule_scores.append(result["score"])
            if result["score"] >= 1.0:
                rules_passed += 1
            else:
                rules_failed += 1
        except Exception as exc:
            logger.exception("rule.evaluation_error", rule_type=rule_type)
            all_violations.append(
                {
                    "rule": rule_type,
                    "field": rule.get("field", ""),
                    "row_indices": [],
                    "message": f"Evaluation error: {exc}",
                    "score": 0.0,
                }
            )
            rule_scores.append(0.0)
            rules_failed += 1

    overall_score = sum(rule_scores) / max(len(rule_scores), 1)

    response = {
        "overall_score": round(overall_score, 4),
        "rules_evaluated": len(rules),
        "violations": all_violations,
        "summary": {
            "total_rows": len(data),
            "rules_passed": rules_passed,
            "rules_failed": rules_failed,
        },
    }

    logger.info(
        "Quality validation complete: score=%.2f, passed=%d, failed=%d",
        overall_score,
        rules_passed,
        rules_failed,
    )

    return func.HttpResponse(
        json.dumps(response),
        status_code=200,
        mimetype="application/json",
    )
