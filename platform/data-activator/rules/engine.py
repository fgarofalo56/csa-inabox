"""Rule evaluation engine for the Data Activator.

Loads alert rules from YAML, evaluates conditions against incoming events,
supports windowed aggregations (count, avg, min, max, sum over time
windows), and anomaly detection using simple z-score analysis.

Usage::

    from engine import RuleEngine

    engine = RuleEngine.from_yaml("rules/sample_rules.yaml")
    fired = engine.evaluate({"magnitude": 5.2, "region": "Alaska"})
    for alert in fired:
        print(alert)
"""

from __future__ import annotations

import logging
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .schema import (
    ActionType,
    AggregationType,
    AlertRule,
    Condition,
    ConditionOperator,
    load_rules_from_yaml,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class FiredAlert:
    """Represents an alert that has been triggered.

    Attributes:
        rule_name: Name of the rule that fired.
        description: Rule description.
        condition_field: The field that was evaluated.
        actual_value: The value that triggered the alert.
        threshold: The configured threshold.
        actions: List of action types to dispatch.
        timestamp: ISO-8601 timestamp of when the alert fired.
        metadata: Additional context about the evaluation.
    """

    rule_name: str
    description: str
    condition_field: str
    actual_value: float
    threshold: float | list[float]
    actions: list[ActionType]
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class WindowedEvent:
    """An event stored in the sliding window buffer.

    Attributes:
        value: Numeric value of the metric.
        timestamp: When the event was received.
    """

    value: float
    timestamp: float  # monotonic seconds


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class RuleEngine:
    """Evaluate alert rules against incoming events.

    The engine maintains an in-memory sliding window buffer per
    (rule, field) pair for windowed aggregations and anomaly detection.

    Args:
        rules: List of :class:`AlertRule` instances.
    """

    def __init__(self, rules: list[AlertRule] | None = None) -> None:
        self._rules: list[AlertRule] = rules or []
        # Sliding window buffer: key = (rule_name, field) -> list of events
        self._window_buffer: dict[tuple[str, str], list[WindowedEvent]] = defaultdict(list)

    # -- Factory methods ----------------------------------------------------

    @classmethod
    def from_yaml(cls, path: str | Path) -> RuleEngine:
        """Create a :class:`RuleEngine` from a YAML rules file.

        Args:
            path: Path to the YAML file.

        Returns:
            A configured rule engine.
        """
        rules = load_rules_from_yaml(path)
        logger.info("Loaded %d rules from %s", len(rules), path)
        return cls(rules=rules)

    # -- Rule management ----------------------------------------------------

    def add_rule(self, rule: AlertRule) -> None:
        """Add a rule to the engine.

        Args:
            rule: The alert rule to add.
        """
        self._rules.append(rule)

    def remove_rule(self, name: str) -> bool:
        """Remove a rule by name.

        Args:
            name: Name of the rule to remove.

        Returns:
            ``True`` if the rule was found and removed.
        """
        before = len(self._rules)
        self._rules = [r for r in self._rules if r.name != name]
        return len(self._rules) < before

    def list_rules(self) -> list[dict[str, Any]]:
        """List all loaded rules as dictionaries.

        Returns:
            List of rule summaries.
        """
        return [
            {
                "name": r.name,
                "description": r.description,
                "enabled": r.enabled,
                "field": r.condition.field,
                "operator": r.condition.operator.value,
                "threshold": r.condition.threshold,
            }
            for r in self._rules
        ]

    # -- Window management --------------------------------------------------

    def _prune_window(self, key: tuple[str, str], window_minutes: int) -> None:
        """Remove expired events from the sliding window."""
        cutoff = time.monotonic() - (window_minutes * 60)
        self._window_buffer[key] = [e for e in self._window_buffer[key] if e.timestamp >= cutoff]

    def _add_to_window(self, key: tuple[str, str], value: float) -> None:
        """Add a new event to the sliding window."""
        self._window_buffer[key].append(WindowedEvent(value=value, timestamp=time.monotonic()))

    def _aggregate_window(
        self,
        key: tuple[str, str],
        aggregation: AggregationType,
    ) -> float | None:
        """Compute an aggregate over the sliding window.

        Args:
            key: Buffer key (rule_name, field).
            aggregation: Aggregation function.

        Returns:
            Aggregated value, or ``None`` if the buffer is empty.
        """
        events = self._window_buffer.get(key, [])
        if not events:
            return None

        values = [e.value for e in events]

        if aggregation == AggregationType.COUNT:
            return float(len(values))
        if aggregation == AggregationType.AVG:
            return statistics.mean(values)
        if aggregation == AggregationType.MIN:
            return min(values)
        if aggregation == AggregationType.MAX:
            return max(values)
        if aggregation == AggregationType.SUM:
            return sum(values)

        return None

    # -- Condition evaluation -----------------------------------------------

    def _resolve_field(self, event: dict[str, Any], field_path: str) -> Any:
        """Resolve a dot-separated field path against a nested dict.

        Args:
            event: The event payload.
            field_path: Dot-separated path (e.g. ``"data.magnitude"``).

        Returns:
            The resolved value, or ``None`` if not found.
        """
        current: Any = event
        for part in field_path.split("."):
            if isinstance(current, dict):
                current = current.get(part)
            else:
                return None
        return current

    def _evaluate_condition(
        self,
        rule: AlertRule,
        event: dict[str, Any],
    ) -> tuple[bool, float]:
        """Evaluate a single rule's condition against an event.

        Args:
            rule: The alert rule.
            event: The event payload.

        Returns:
            Tuple of (fired, actual_value).
        """
        condition = rule.condition
        raw_value = self._resolve_field(event, condition.field)

        if raw_value is None:
            return False, 0.0

        try:
            value = float(raw_value)
        except (ValueError, TypeError):
            # For string comparisons (contains, eq)
            return self._evaluate_string_condition(condition, str(raw_value))

        # Windowed aggregation
        window_key = (rule.name, condition.field)
        if condition.window_minutes > 0:
            self._add_to_window(window_key, value)
            self._prune_window(window_key, condition.window_minutes)
            if condition.aggregation:
                agg_value = self._aggregate_window(window_key, condition.aggregation)
                if agg_value is None:
                    return False, 0.0
                value = agg_value
        else:
            # Even without a window, track values for anomaly detection
            self._add_to_window(window_key, value)

        return self._compare(condition, value), value

    def _compare(self, condition: Condition, value: float) -> bool:
        """Apply the condition operator to a numeric value.

        Args:
            condition: The condition to evaluate.
            value: The resolved numeric value.

        Returns:
            Whether the condition is met.
        """
        threshold = condition.threshold
        op = condition.operator

        if op == ConditionOperator.GT:
            return value > float(threshold)  # type: ignore[arg-type]
        if op == ConditionOperator.LT:
            return value < float(threshold)  # type: ignore[arg-type]
        if op == ConditionOperator.GTE:
            return value >= float(threshold)  # type: ignore[arg-type]
        if op == ConditionOperator.LTE:
            return value <= float(threshold)  # type: ignore[arg-type]
        if op == ConditionOperator.EQ:
            return value == float(threshold)  # type: ignore[arg-type]
        if op == ConditionOperator.NEQ:
            return value != float(threshold)  # type: ignore[arg-type]
        if op == ConditionOperator.BETWEEN:
            if isinstance(threshold, list) and len(threshold) == 2:
                return threshold[0] <= value <= threshold[1]
            return False
        if op == ConditionOperator.ANOMALY:
            return self._detect_anomaly(condition, value)

        return False

    def _detect_anomaly(self, condition: Condition, current_value: float) -> bool:
        """Detect anomalies using simple z-score analysis.

        Compares the current value against the distribution of values
        in the sliding window buffer.

        Args:
            condition: The condition with z-score threshold.
            current_value: The current metric value.

        Returns:
            ``True`` if the value is anomalous (z-score exceeds threshold).
        """
        # We need at least 7 data points for meaningful z-score
        buffer_key = None
        for key, _events in self._window_buffer.items():
            if key[1] == condition.field:
                buffer_key = key
                break

        if buffer_key is None:
            return False

        values = [e.value for e in self._window_buffer[buffer_key]]
        if len(values) < 7:
            return False

        mean = statistics.mean(values)
        stdev = statistics.stdev(values) if len(values) > 1 else 0.0

        if stdev == 0:
            return current_value != mean

        z_score = abs(current_value - mean) / stdev
        return z_score > condition.z_score_threshold

    def _evaluate_string_condition(
        self,
        condition: Condition,
        value: str,
    ) -> tuple[bool, float]:
        """Evaluate a condition against a string value.

        Args:
            condition: The condition to evaluate.
            value: The string value.

        Returns:
            Tuple of (fired, 0.0).
        """
        if condition.operator == ConditionOperator.EQ:
            return value == str(condition.threshold), 0.0
        if condition.operator == ConditionOperator.NEQ:
            return value != str(condition.threshold), 0.0
        if condition.operator == ConditionOperator.CONTAINS:
            return str(condition.threshold) in value, 0.0
        return False, 0.0

    # -- Main evaluation ----------------------------------------------------

    def evaluate(self, event: dict[str, Any]) -> list[FiredAlert]:
        """Evaluate all enabled rules against an incoming event.

        Args:
            event: The event payload (e.g. from Event Grid).

        Returns:
            List of :class:`FiredAlert` for all rules that fired.
        """
        fired_alerts: list[FiredAlert] = []

        for rule in self._rules:
            if not rule.enabled:
                continue

            fired, actual_value = self._evaluate_condition(rule, event)

            if fired:
                alert = FiredAlert(
                    rule_name=rule.name,
                    description=rule.description,
                    condition_field=rule.condition.field,
                    actual_value=actual_value,
                    threshold=rule.condition.threshold,
                    actions=[a.type for a in rule.actions],
                    metadata={
                        "source": rule.source,
                        "operator": rule.condition.operator.value,
                        "tags": rule.tags,
                    },
                )
                fired_alerts.append(alert)
                logger.info(
                    "Alert fired: %s (field=%s, value=%.2f, threshold=%s)",
                    rule.name,
                    rule.condition.field,
                    actual_value,
                    rule.condition.threshold,
                )

        return fired_alerts

    def evaluate_batch(self, events: list[dict[str, Any]]) -> list[FiredAlert]:
        """Evaluate all rules against a batch of events.

        Args:
            events: List of event payloads.

        Returns:
            Combined list of fired alerts from all events.
        """
        all_alerts: list[FiredAlert] = []
        for event in events:
            all_alerts.extend(self.evaluate(event))
        return all_alerts
