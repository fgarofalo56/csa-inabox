"""Azure Function: Data Activator alert processor.

Receives events from Event Grid, evaluates alert rules defined in YAML
configuration files, and dispatches notifications through configured
channels (Teams webhook, email, PagerDuty, Logic App).

This is the CSA-in-a-Box equivalent of Microsoft Fabric Data Activator's
event-driven alerting engine.

Deployment: Azure Functions v4, Python 3.11, HTTP trigger.
"""

from __future__ import annotations

import json
import logging
import os
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

import yaml

try:
    import azure.functions as func
except ImportError:
    func = None  # type: ignore[assignment]

try:
    import requests
except ImportError:
    requests = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Domain models
# ──────────────────────────────────────────────────────────────────────


class Severity(str, Enum):
    """Alert severity levels."""

    CRITICAL = "critical"
    WARNING = "warning"
    INFO = "info"


class AlertType(str, Enum):
    """Supported alert evaluation types."""

    FRESHNESS = "freshness"
    ANOMALY_DETECTION = "anomaly_detection"
    THRESHOLD = "threshold"


@dataclass
class ActionConfig:
    """Configuration for a notification action."""

    type: str
    enabled: bool = True
    severity_filter: list[str] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)


@dataclass
class SuppressionConfig:
    """Alert suppression / cooldown configuration."""

    cooldown_minutes: int = 60
    group_by: list[str] = field(default_factory=list)


@dataclass
class AlertRule:
    """Parsed alert rule from YAML configuration."""

    name: str
    description: str
    alert_type: AlertType
    event_types: list[str]
    evaluation: dict[str, Any]
    conditions: list[dict[str, Any]]
    severity_rules: list[dict[str, Any]]
    default_severity: Severity
    actions: list[ActionConfig]
    suppression: SuppressionConfig
    custom_dimensions: dict[str, str] = field(default_factory=dict)


@dataclass
class AlertEvaluation:
    """Result of evaluating an alert rule against an event."""

    rule_name: str
    fired: bool
    severity: Severity
    message: str
    event_data: dict[str, Any]
    details: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )


# ──────────────────────────────────────────────────────────────────────
# Rule loading
# ──────────────────────────────────────────────────────────────────────


def _expand_env_vars(value: Any) -> Any:
    """Recursively expand ``${VAR}`` environment variable references."""
    if isinstance(value, str) and "${" in value:
        for env_key, env_val in os.environ.items():
            value = value.replace(f"${{{env_key}}}", env_val)
        return value
    if isinstance(value, dict):
        return {k: _expand_env_vars(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env_vars(v) for v in value]
    return value


def load_alert_rules(rules_dir: Path | str) -> list[AlertRule]:
    """Load all alert rule YAML files from a directory.

    Args:
        rules_dir: Path to the directory containing alert rule YAML files.

    Returns:
        List of parsed :class:`AlertRule` objects.

    Raises:
        FileNotFoundError: If the rules directory does not exist.
        ValueError: If a YAML file contains invalid rule definitions.
    """
    rules_dir = Path(rules_dir)
    if not rules_dir.is_dir():
        raise FileNotFoundError(f"Alert rules directory not found: {rules_dir}")

    rules: list[AlertRule] = []
    for yaml_path in sorted(rules_dir.glob("*.yaml")):
        try:
            rule = _parse_rule_file(yaml_path)
            rules.append(rule)
            logger.info("Loaded alert rule: %s from %s", rule.name, yaml_path.name)
        except Exception:
            logger.exception("Failed to load alert rule from %s", yaml_path)
            raise
    return rules


def _parse_rule_file(path: Path) -> AlertRule:
    """Parse a single alert rule YAML file into an :class:`AlertRule`."""
    with open(path) as f:
        raw = yaml.safe_load(f)

    raw = _expand_env_vars(raw)
    metadata = raw.get("metadata", {})
    evaluation = raw.get("evaluation", {})
    severity = raw.get("severity", {})
    suppression_raw = raw.get("suppression", {})
    logging_config = raw.get("logging", {})

    actions = [
        ActionConfig(
            type=a["type"],
            enabled=a.get("enabled", True),
            severity_filter=a.get("severityFilter", []),
            config=a.get("config", {}),
        )
        for a in raw.get("actions", [])
    ]

    return AlertRule(
        name=metadata.get("name", path.stem),
        description=metadata.get("description", ""),
        alert_type=AlertType(evaluation.get("type", "threshold")),
        event_types=raw.get("trigger", {}).get("eventTypes", []),
        evaluation=evaluation,
        conditions=raw.get("conditions", []),
        severity_rules=severity.get("rules", []),
        default_severity=Severity(severity.get("default", "warning")),
        actions=actions,
        suppression=SuppressionConfig(
            cooldown_minutes=suppression_raw.get("cooldownMinutes", 60),
            group_by=suppression_raw.get("groupBy", []),
        ),
        custom_dimensions=logging_config.get("customDimensions", {}),
    )


# ──────────────────────────────────────────────────────────────────────
# Evaluation engine
# ──────────────────────────────────────────────────────────────────────


def _resolve_field(data: dict[str, Any], field_path: str) -> Any:
    """Resolve a dot-separated field path against a nested dict.

    Example::

        _resolve_field({"data": {"metric": "null_rate"}}, "data.metric")
        # → "null_rate"
    """
    parts = field_path.split(".")
    current: Any = data
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def _evaluate_condition(event: dict[str, Any], condition: dict[str, Any]) -> bool:
    """Evaluate a single condition against an event payload."""
    field_path = condition.get("field", "")
    operator = condition.get("operator", "equals")
    expected = condition.get("value")

    actual = _resolve_field(event, field_path)
    if actual is None:
        return False

    if operator == "equals":
        return actual == expected
    if operator == "notEquals":
        return actual != expected
    if operator == "greaterThan":
        return float(actual) > float(expected)
    if operator == "lessThan":
        return float(actual) < float(expected)
    if operator == "greaterThanOrEqual":
        return float(actual) >= float(expected)
    if operator == "lessThanOrEqual":
        return float(actual) <= float(expected)
    if operator == "in":
        return actual in (expected if isinstance(expected, list) else [expected])
    if operator == "notIn":
        return actual not in (expected if isinstance(expected, list) else [expected])
    if operator == "contains":
        return expected in str(actual)

    logger.warning("Unknown operator: %s", operator)
    return False


def _determine_severity(
    rule: AlertRule,
    event: dict[str, Any],
) -> Severity:
    """Determine alert severity based on the rule's severity escalation rules."""
    data = event.get("data", {})

    for sev_rule in rule.severity_rules:
        condition_expr = sev_rule.get("condition", "")
        level = sev_rule.get("level", "warning")

        # Simple expression evaluation for severity rules.
        # Supports: "metric_name > value", "metric_name == value"
        try:
            if _evaluate_severity_expression(condition_expr, data):
                return Severity(level)
        except (ValueError, TypeError):
            continue

    return rule.default_severity


def _evaluate_severity_expression(expr: str, data: dict[str, Any]) -> bool:
    """Evaluate a simple severity condition expression.

    Supports expressions like:
    - ``staleness_minutes > 360``
    - ``abs(z_score) > 5.0``
    - ``value == 0 && metric == 'row_count'``
    """
    if not expr:
        return False

    # Handle && (AND) expressions
    if "&&" in expr:
        parts = [p.strip() for p in expr.split("&&")]
        return all(_evaluate_severity_expression(p, data) for p in parts)

    # Handle abs() function
    if "abs(" in expr:
        import re

        match = re.search(r"abs\((\w+)\)\s*([><=!]+)\s*([\d.]+)", expr)
        if match:
            field_name = match.group(1)
            operator = match.group(2)
            threshold = float(match.group(3))
            value = data.get(field_name, 0)
            abs_value = abs(float(value))
            return _compare(abs_value, operator, threshold)

    # Handle simple comparisons: field_name operator value
    import re

    match = re.match(r"(\w+)\s*([><=!]+)\s*(.+)", expr.strip())
    if match:
        field_name = match.group(1)
        operator = match.group(2)
        raw_value = match.group(3).strip().strip("'\"")
        actual = data.get(field_name)
        if actual is None:
            return False
        try:
            return _compare(float(actual), operator, float(raw_value))
        except ValueError:
            return _compare(str(actual), operator, raw_value)

    return False


def _compare(actual: Any, operator: str, expected: Any) -> bool:
    """Compare two values with the given operator string."""
    if operator in (">",):
        return actual > expected
    if operator in ("<",):
        return actual < expected
    if operator in (">=",):
        return actual >= expected
    if operator in ("<=",):
        return actual <= expected
    if operator in ("==",):
        return actual == expected
    if operator in ("!=",):
        return actual != expected
    return False


def evaluate_freshness(
    rule: AlertRule,
    event: dict[str, Any],
) -> AlertEvaluation:
    """Evaluate a freshness alert rule against an event."""
    data = event.get("data", {})
    last_updated = data.get("last_updated_at")
    sla_minutes = data.get("sla_freshness_minutes") or rule.evaluation.get(
        "defaultFreshnessMinutes",
        120,
    )
    grace = rule.evaluation.get("gracePeriodMinutes", 15)

    if not last_updated:
        return AlertEvaluation(
            rule_name=rule.name,
            fired=False,
            severity=Severity.INFO,
            message="No last_updated_at timestamp in event data",
            event_data=data,
        )

    try:
        last_dt = datetime.fromisoformat(last_updated.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return AlertEvaluation(
            rule_name=rule.name,
            fired=False,
            severity=Severity.INFO,
            message=f"Invalid timestamp format: {last_updated}",
            event_data=data,
        )

    now = datetime.now(timezone.utc)
    staleness_minutes = (now - last_dt).total_seconds() / 60.0
    threshold = float(sla_minutes) + float(grace)
    fired = staleness_minutes > threshold

    severity = _determine_severity(rule, {
        **event,
        "data": {**data, "staleness_minutes": staleness_minutes},
    }) if fired else Severity.INFO

    domain = data.get("domain", "unknown")
    product = data.get("dataProduct", "unknown")
    message = (
        f"Data product {domain}/{product} is {staleness_minutes:.0f} minutes stale "
        f"(SLA: {sla_minutes} min + {grace} min grace)"
        if fired
        else f"Data product {domain}/{product} is fresh ({staleness_minutes:.0f} min)"
    )

    return AlertEvaluation(
        rule_name=rule.name,
        fired=fired,
        severity=severity,
        message=message,
        event_data=data,
        details={
            "staleness_minutes": round(staleness_minutes, 1),
            "sla_minutes": sla_minutes,
            "grace_minutes": grace,
            "threshold_minutes": threshold,
        },
    )


def evaluate_anomaly(
    rule: AlertRule,
    event: dict[str, Any],
    baseline_values: list[float] | None = None,
) -> AlertEvaluation:
    """Evaluate an anomaly detection alert rule using z-score analysis.

    Args:
        rule: The alert rule to evaluate.
        event: The incoming event payload.
        baseline_values: Historical metric values for baseline calculation.
            In production, these would be fetched from a metrics store.
    """
    data = event.get("data", {})
    current_value = data.get("value")
    metric_name = data.get("metric", "unknown")

    if current_value is None:
        return AlertEvaluation(
            rule_name=rule.name,
            fired=False,
            severity=Severity.INFO,
            message="No metric value in event data",
            event_data=data,
        )

    current_value = float(current_value)
    min_baseline = rule.evaluation.get("minimumBaselinePoints", 7)

    if not baseline_values or len(baseline_values) < min_baseline:
        return AlertEvaluation(
            rule_name=rule.name,
            fired=False,
            severity=Severity.INFO,
            message=(
                f"Insufficient baseline data for {metric_name}: "
                f"{len(baseline_values or [])} < {min_baseline} points"
            ),
            event_data=data,
        )

    mean = statistics.mean(baseline_values)
    stdev = statistics.stdev(baseline_values) if len(baseline_values) > 1 else 0.0
    z_threshold = rule.evaluation.get("zScoreThreshold", 3.0)

    if stdev == 0:
        z_score = 0.0 if current_value == mean else float("inf")
    else:
        z_score = (current_value - mean) / stdev

    fired = abs(z_score) > z_threshold

    severity = _determine_severity(rule, {
        **event,
        "data": {**data, "z_score": z_score},
    }) if fired else Severity.INFO

    domain = data.get("domain", "unknown")
    product = data.get("dataProduct", "unknown")
    direction = "above" if z_score > 0 else "below"
    change_pct = ((current_value - mean) / mean * 100) if mean != 0 else 0

    message = (
        f"Anomaly detected: {metric_name} for {domain}/{product} is "
        f"{abs(z_score):.1f} std devs {direction} baseline "
        f"(value={current_value:.4f}, mean={mean:.4f})"
        if fired
        else f"Metric {metric_name} for {domain}/{product} is within normal range (z={z_score:.2f})"
    )

    return AlertEvaluation(
        rule_name=rule.name,
        fired=fired,
        severity=severity,
        message=message,
        event_data=data,
        details={
            "z_score": round(z_score, 3),
            "current_value": current_value,
            "baseline_mean": round(mean, 4),
            "baseline_stdev": round(stdev, 4),
            "baseline_size": len(baseline_values),
            "direction": direction,
            "change_percent": round(change_pct, 2),
        },
    )


def evaluate_threshold(
    rule: AlertRule,
    event: dict[str, Any],
) -> AlertEvaluation:
    """Evaluate a threshold alert rule against an event."""
    data = event.get("data", {})
    metric_name = data.get("metric", "unknown")
    current_value = data.get("value")
    previous_value = data.get("previous_value")

    if current_value is None:
        return AlertEvaluation(
            rule_name=rule.name,
            fired=False,
            severity=Severity.INFO,
            message="No metric value in event data",
            event_data=data,
        )

    current_value = float(current_value)
    thresholds = rule.evaluation.get("thresholds", [])
    breached = False
    breach_details: dict[str, Any] = {}

    for threshold_def in thresholds:
        if threshold_def.get("metric") != metric_name:
            continue

        lower = threshold_def.get("lowerBound")
        upper = threshold_def.get("upperBound")
        pct_drop = threshold_def.get("percentageDropThreshold")

        if lower is not None and current_value < float(lower):
            breached = True
            breach_details = {
                "threshold_type": "lower",
                "threshold_value": lower,
                "metric": metric_name,
            }
            break

        if upper is not None and current_value > float(upper):
            breached = True
            breach_details = {
                "threshold_type": "upper",
                "threshold_value": upper,
                "metric": metric_name,
            }
            break

        if pct_drop is not None and previous_value is not None:
            prev = float(previous_value)
            if prev > 0:
                drop_pct = ((prev - current_value) / prev) * 100
                if drop_pct > float(pct_drop):
                    breached = True
                    breach_details = {
                        "threshold_type": "percentage_drop",
                        "threshold_value": pct_drop,
                        "actual_drop_percent": round(drop_pct, 2),
                        "metric": metric_name,
                    }
                    break

    severity = _determine_severity(rule, {
        **event,
        "data": {**data, "threshold_breached": breached, "value": current_value},
    }) if breached else Severity.INFO

    domain = data.get("domain", "unknown")
    product = data.get("dataProduct", "unknown")
    change_pct = 0.0
    if previous_value is not None and float(previous_value) != 0:
        change_pct = ((current_value - float(previous_value)) / float(previous_value)) * 100

    message = (
        f"Threshold breach: {metric_name} = {current_value} for {domain}/{product} "
        f"(threshold: {breach_details.get('threshold_type', 'unknown')} = "
        f"{breach_details.get('threshold_value', 'N/A')})"
        if breached
        else f"Metric {metric_name} = {current_value} for {domain}/{product} is within bounds"
    )

    return AlertEvaluation(
        rule_name=rule.name,
        fired=breached,
        severity=severity,
        message=message,
        event_data=data,
        details={
            **breach_details,
            "current_value": current_value,
            "previous_value": previous_value,
            "change_percent": round(change_pct, 2),
        },
    )


def evaluate_rule(
    rule: AlertRule,
    event: dict[str, Any],
    baseline_values: list[float] | None = None,
) -> AlertEvaluation:
    """Evaluate an alert rule against an event.

    Dispatches to the appropriate evaluator based on the rule's alert type.

    Args:
        rule: The alert rule to evaluate.
        event: The incoming event payload.
        baseline_values: Historical values for anomaly detection baseline.

    Returns:
        An :class:`AlertEvaluation` with the result.
    """
    if rule.alert_type == AlertType.FRESHNESS:
        return evaluate_freshness(rule, event)
    if rule.alert_type == AlertType.ANOMALY_DETECTION:
        return evaluate_anomaly(rule, event, baseline_values=baseline_values)
    if rule.alert_type == AlertType.THRESHOLD:
        return evaluate_threshold(rule, event)

    return AlertEvaluation(
        rule_name=rule.name,
        fired=False,
        severity=Severity.INFO,
        message=f"Unsupported alert type: {rule.alert_type}",
        event_data=event.get("data", {}),
    )


# ──────────────────────────────────────────────────────────────────────
# Notification dispatch
# ──────────────────────────────────────────────────────────────────────


def _render_template(template: str, data: dict[str, Any]) -> str:
    """Simple Mustache-style template rendering.

    Replaces ``{{key}}`` and ``{{data.key}}`` patterns with values from
    the data dictionary.
    """
    import re

    def replacer(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        value = _resolve_field(data, key)
        if value is None:
            value = _resolve_field({"data": data}, key)
        return str(value) if value is not None else match.group(0)

    return re.sub(r"\{\{([\w.]+)\}\}", replacer, template)


def send_teams_notification(
    evaluation: AlertEvaluation,
    action: ActionConfig,
) -> bool:
    """Send an alert notification to Microsoft Teams via incoming webhook.

    Args:
        evaluation: The alert evaluation result.
        action: The Teams action configuration.

    Returns:
        True if the notification was sent successfully.
    """
    webhook_url = action.config.get("title", "")
    # The actual webhook URL comes from environment
    webhook_url = os.environ.get("TEAMS_WEBHOOK_URL", "")

    if not webhook_url:
        logger.warning("TEAMS_WEBHOOK_URL not configured, skipping Teams notification")
        return False

    if requests is None:
        logger.warning("requests library not available, skipping Teams notification")
        return False

    title = action.config.get("title", f"Alert: {evaluation.rule_name}")
    theme_color = action.config.get("themeColor", "FF6600")
    template = action.config.get("messageTemplate", evaluation.message)
    rendered_message = _render_template(template, {
        **evaluation.event_data,
        **evaluation.details,
    })

    # Adaptive Card payload for Teams
    payload = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        "themeColor": theme_color,
        "summary": title,
        "sections": [
            {
                "activityTitle": title,
                "activitySubtitle": f"Severity: {evaluation.severity.value.upper()}",
                "facts": [
                    {"name": "Rule", "value": evaluation.rule_name},
                    {"name": "Severity", "value": evaluation.severity.value},
                    {"name": "Time", "value": evaluation.timestamp},
                ],
                "text": rendered_message,
                "markdown": True,
            },
        ],
    }

    try:
        resp = requests.post(webhook_url, json=payload, timeout=10)
        resp.raise_for_status()
        logger.info(
            "Teams notification sent for %s (severity=%s)",
            evaluation.rule_name,
            evaluation.severity.value,
        )
        return True
    except Exception:
        logger.exception("Failed to send Teams notification for %s", evaluation.rule_name)
        return False


def send_pagerduty_notification(
    evaluation: AlertEvaluation,
    action: ActionConfig,
) -> bool:
    """Send an alert to PagerDuty via Events API v2.

    Args:
        evaluation: The alert evaluation result.
        action: The PagerDuty action configuration.

    Returns:
        True if the event was sent successfully.
    """
    routing_key = action.config.get("routingKey") or os.environ.get(
        "PAGERDUTY_INTEGRATION_KEY",
        "",
    )

    if not routing_key or routing_key.startswith("$"):
        logger.warning("PagerDuty integration key not configured, skipping")
        return False

    if requests is None:
        logger.warning("requests library not available, skipping PagerDuty notification")
        return False

    pd_severity = action.config.get("severity", evaluation.severity.value)
    summary = action.config.get("summary", evaluation.message)
    rendered_summary = _render_template(summary, {
        **evaluation.event_data,
        **evaluation.details,
    })

    payload = {
        "routing_key": routing_key,
        "event_action": "trigger",
        "payload": {
            "summary": rendered_summary,
            "severity": pd_severity,
            "source": f"csa-inabox/{evaluation.event_data.get('domain', 'unknown')}",
            "component": evaluation.event_data.get("dataProduct", "unknown"),
            "custom_details": {
                "rule_name": evaluation.rule_name,
                "details": evaluation.details,
                "event_data": evaluation.event_data,
            },
        },
    }

    try:
        resp = requests.post(
            "https://events.pagerduty.com/v2/enqueue",
            json=payload,
            timeout=10,
        )
        resp.raise_for_status()
        logger.info("PagerDuty event sent for %s", evaluation.rule_name)
        return True
    except Exception:
        logger.exception("Failed to send PagerDuty event for %s", evaluation.rule_name)
        return False


def send_email_notification(
    evaluation: AlertEvaluation,
    action: ActionConfig,
) -> bool:
    """Send an email notification (placeholder — delegates to Logic App).

    In production, email delivery is handled by the Logic App workflow
    that receives the alert payload and uses the Office 365 connector.

    Returns:
        True (email sending is delegated to Logic App).
    """
    recipients = action.config.get("recipients", [])
    subject = action.config.get("subject", f"CSA Alert: {evaluation.rule_name}")
    _render_template(subject, {
        **evaluation.event_data,
        **evaluation.details,
    })
    logger.info(
        "Email notification queued for %s → %s",
        evaluation.rule_name,
        recipients,
    )
    # Actual sending is delegated to the Logic App
    return True


def send_logic_app_notification(
    evaluation: AlertEvaluation,
    action: ActionConfig,
) -> bool:
    """Trigger the Logic App workflow for multi-channel notification.

    Args:
        evaluation: The alert evaluation result.
        action: The Logic App action configuration.

    Returns:
        True if the Logic App was triggered successfully.
    """
    trigger_url = action.config.get("triggerUrl") or os.environ.get(
        "LOGIC_APP_TRIGGER_URL",
        "",
    )

    if not trigger_url or trigger_url.startswith("$"):
        logger.warning("Logic App trigger URL not configured, skipping")
        return False

    if requests is None:
        logger.warning("requests library not available, skipping Logic App trigger")
        return False

    payload = {
        "alertName": evaluation.rule_name,
        "severity": evaluation.severity.value,
        "domain": evaluation.event_data.get("domain", "unknown"),
        "dataProduct": evaluation.event_data.get("dataProduct", "unknown"),
        "message": evaluation.message,
        "details": evaluation.details,
        "timestamp": evaluation.timestamp,
    }

    try:
        resp = requests.post(trigger_url, json=payload, timeout=15)
        resp.raise_for_status()
        logger.info("Logic App triggered for %s", evaluation.rule_name)
        return True
    except Exception:
        logger.exception("Failed to trigger Logic App for %s", evaluation.rule_name)
        return False


_ACTION_DISPATCHERS: dict[str, Any] = {
    "teams_webhook": send_teams_notification,
    "pagerduty": send_pagerduty_notification,
    "email": send_email_notification,
    "logic_app": send_logic_app_notification,
}


def dispatch_actions(
    evaluation: AlertEvaluation,
    actions: list[ActionConfig],
) -> dict[str, bool]:
    """Dispatch notifications for a fired alert.

    Only sends notifications for enabled actions whose severity filter
    matches the evaluation severity.

    Args:
        evaluation: The alert evaluation that fired.
        actions: List of action configurations from the alert rule.

    Returns:
        Dict mapping action type to success/failure status.
    """
    results: dict[str, bool] = {}

    for action in actions:
        if not action.enabled:
            continue

        # Check severity filter
        if action.severity_filter and evaluation.severity.value not in action.severity_filter:
            logger.debug(
                "Skipping %s action for %s (severity %s not in filter %s)",
                action.type,
                evaluation.rule_name,
                evaluation.severity.value,
                action.severity_filter,
            )
            continue

        dispatcher = _ACTION_DISPATCHERS.get(action.type)
        if dispatcher is None:
            logger.warning("Unknown action type: %s", action.type)
            results[action.type] = False
            continue

        results[action.type] = dispatcher(evaluation, action)

    return results


# ──────────────────────────────────────────────────────────────────────
# Suppression (in-memory for single-instance; use Redis for multi-instance)
# ──────────────────────────────────────────────────────────────────────

_suppression_cache: dict[str, datetime] = {}


def _is_suppressed(rule: AlertRule, event: dict[str, Any]) -> bool:
    """Check if an alert is suppressed (within cooldown window)."""
    group_key_parts = []
    for field_path in rule.suppression.group_by:
        value = _resolve_field(event, field_path)
        group_key_parts.append(str(value))

    cache_key = f"{rule.name}:{'|'.join(group_key_parts)}"
    last_fired = _suppression_cache.get(cache_key)

    if last_fired is not None:
        elapsed = (datetime.now(timezone.utc) - last_fired).total_seconds() / 60.0
        if elapsed < rule.suppression.cooldown_minutes:
            logger.debug(
                "Alert %s suppressed (%.1f min < %d min cooldown)",
                rule.name,
                elapsed,
                rule.suppression.cooldown_minutes,
            )
            return True

    return False


def _record_suppression(rule: AlertRule, event: dict[str, Any]) -> None:
    """Record that an alert fired for suppression tracking."""
    group_key_parts = []
    for field_path in rule.suppression.group_by:
        value = _resolve_field(event, field_path)
        group_key_parts.append(str(value))

    cache_key = f"{rule.name}:{'|'.join(group_key_parts)}"
    _suppression_cache[cache_key] = datetime.now(timezone.utc)


# ──────────────────────────────────────────────────────────────────────
# Main processing pipeline
# ──────────────────────────────────────────────────────────────────────


def process_event(
    event: dict[str, Any],
    rules: list[AlertRule],
    baseline_provider: Any | None = None,
) -> list[AlertEvaluation]:
    """Process a single event against all alert rules.

    Args:
        event: The incoming event payload (CloudEvents 1.0 schema).
        rules: List of alert rules to evaluate.
        baseline_provider: Optional callable that returns historical
            metric values for anomaly detection. Signature:
            ``(domain: str, product: str, metric: str) -> list[float]``

    Returns:
        List of alert evaluations (both fired and not-fired for audit).
    """
    event_type = event.get("type", "")
    evaluations: list[AlertEvaluation] = []

    for rule in rules:
        # Check if the rule handles this event type
        if event_type and rule.event_types and event_type not in rule.event_types:
            continue

        # Check suppression
        if _is_suppressed(rule, event):
            evaluations.append(AlertEvaluation(
                rule_name=rule.name,
                fired=False,
                severity=Severity.INFO,
                message=f"Alert suppressed (cooldown: {rule.suppression.cooldown_minutes} min)",
                event_data=event.get("data", {}),
            ))
            continue

        # Get baseline values for anomaly detection
        baseline: list[float] | None = None
        if rule.alert_type == AlertType.ANOMALY_DETECTION and baseline_provider:
            data = event.get("data", {})
            baseline = baseline_provider(
                data.get("domain", ""),
                data.get("dataProduct", ""),
                data.get("metric", ""),
            )

        # Evaluate the rule
        evaluation = evaluate_rule(rule, event, baseline_values=baseline)
        evaluations.append(evaluation)

        # Dispatch actions if the alert fired
        if evaluation.fired:
            _record_suppression(rule, event)
            action_results = dispatch_actions(evaluation, rule.actions)
            evaluation.details["action_results"] = action_results

    return evaluations


# ──────────────────────────────────────────────────────────────────────
# Azure Function entry point
# ──────────────────────────────────────────────────────────────────────

# Load rules at module level (cold start optimization).
_RULES_DIR = Path(os.environ.get("ALERT_RULES_DIR", str(Path(__file__).parent.parent / "alert_rules")))
_RULES: list[AlertRule] | None = None


def _get_rules() -> list[AlertRule]:
    """Lazily load alert rules (cached after first load)."""
    global _RULES
    if _RULES is None:
        try:
            _RULES = load_alert_rules(_RULES_DIR)
            logger.info("Loaded %d alert rules from %s", len(_RULES), _RULES_DIR)
        except FileNotFoundError:
            logger.warning("Alert rules directory not found: %s", _RULES_DIR)
            _RULES = []
    return _RULES


if func is not None:
    app = func.FunctionApp()

    @app.function_name("alert_processor")
    @app.route(route="alerts", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
    def alert_processor(req: func.HttpRequest) -> func.HttpResponse:
        """HTTP-triggered Azure Function that processes alert events.

        Receives events from Event Grid subscriptions, evaluates them
        against all configured alert rules, and dispatches notifications.

        Args:
            req: The HTTP request containing the event payload.

        Returns:
            JSON response with evaluation results.
        """
        logger.info("Alert processor triggered")

        try:
            body = req.get_json()
        except ValueError:
            return func.HttpResponse(
                json.dumps({"error": "Invalid JSON payload"}),
                status_code=400,
                mimetype="application/json",
            )

        # Handle Event Grid validation handshake
        if isinstance(body, list) and body:
            first = body[0]
            if first.get("eventType") == "Microsoft.EventGrid.SubscriptionValidationEvent":
                validation_code = first.get("data", {}).get("validationCode", "")
                return func.HttpResponse(
                    json.dumps({"validationResponse": validation_code}),
                    mimetype="application/json",
                )

        # Process the event
        rules = _get_rules()
        events = body if isinstance(body, list) else [body]
        all_evaluations: list[dict[str, Any]] = []

        for event in events:
            evaluations = process_event(event, rules)
            for evaluation in evaluations:
                all_evaluations.append({
                    "rule": evaluation.rule_name,
                    "fired": evaluation.fired,
                    "severity": evaluation.severity.value,
                    "message": evaluation.message,
                    "details": evaluation.details,
                    "timestamp": evaluation.timestamp,
                })

        fired_count = sum(1 for e in all_evaluations if e["fired"])
        logger.info(
            "Processed %d event(s): %d evaluation(s), %d fired",
            len(events),
            len(all_evaluations),
            fired_count,
        )

        return func.HttpResponse(
            json.dumps({
                "processed": len(events),
                "evaluations": len(all_evaluations),
                "fired": fired_count,
                "results": all_evaluations,
            }),
            mimetype="application/json",
        )
