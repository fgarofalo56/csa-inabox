"""Tests for the Data Activator rule engine.

Tests threshold evaluation, anomaly detection, freshness checking,
batch evaluation, and alert notification routing.
"""

from __future__ import annotations

from platform.data_activator.rules.engine import RuleEngine
from platform.data_activator.rules.schema import (
    Action,
    ActionConfig,
    ActionType,
    AggregationType,
    AlertRule,
    Condition,
    ConditionOperator,
)

import pytest

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_rule(
    name: str = "test-rule",
    field: str = "value",
    operator: ConditionOperator = ConditionOperator.GT,
    threshold: float | list[float] = 100.0,
    window_minutes: int = 0,
    aggregation: AggregationType | None = None,
    z_score_threshold: float = 3.0,
    enabled: bool = True,
    actions: list[Action] | None = None,
    tags: dict | None = None,
) -> AlertRule:
    """Build an AlertRule for testing."""
    return AlertRule(
        name=name,
        description=f"Test rule: {name}",
        source="test-source",
        condition=Condition(
            field=field,
            operator=operator,
            threshold=threshold,
            window_minutes=window_minutes,
            aggregation=aggregation,
            z_score_threshold=z_score_threshold,
        ),
        actions=actions
        or [
            Action(type=ActionType.TEAMS, config=ActionConfig(webhook_url="https://test.webhook.url")),
        ],
        enabled=enabled,
        tags=tags or {},
    )


@pytest.fixture
def engine() -> RuleEngine:
    """Create a fresh RuleEngine."""
    return RuleEngine()


# ---------------------------------------------------------------------------
# Threshold Evaluation Tests
# ---------------------------------------------------------------------------


class TestThresholdEvaluation:
    """Test basic threshold condition operators."""

    def test_gt_fires_when_above_threshold(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.GT, threshold=100.0))
        alerts = engine.evaluate({"value": 150.0})
        assert len(alerts) == 1
        assert alerts[0].actual_value == 150.0

    def test_gt_does_not_fire_when_below(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.GT, threshold=100.0))
        alerts = engine.evaluate({"value": 50.0})
        assert len(alerts) == 0

    def test_lt_fires_when_below_threshold(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.LT, threshold=10.0))
        alerts = engine.evaluate({"value": 5.0})
        assert len(alerts) == 1

    def test_gte_fires_on_equal(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.GTE, threshold=100.0))
        alerts = engine.evaluate({"value": 100.0})
        assert len(alerts) == 1

    def test_lte_fires_on_equal(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.LTE, threshold=50.0))
        alerts = engine.evaluate({"value": 50.0})
        assert len(alerts) == 1

    def test_eq_fires_on_exact_match(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.EQ, threshold=42.0))
        alerts = engine.evaluate({"value": 42.0})
        assert len(alerts) == 1

    def test_neq_fires_on_mismatch(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.NEQ, threshold=42.0))
        alerts = engine.evaluate({"value": 43.0})
        assert len(alerts) == 1

    def test_between_fires_when_in_range(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.BETWEEN, threshold=[10.0, 50.0]))
        alerts = engine.evaluate({"value": 25.0})
        assert len(alerts) == 1

    def test_between_does_not_fire_when_outside(self, engine):
        engine.add_rule(_make_rule(operator=ConditionOperator.BETWEEN, threshold=[10.0, 50.0]))
        alerts = engine.evaluate({"value": 75.0})
        assert len(alerts) == 0

    def test_nested_field_resolution(self, engine):
        engine.add_rule(_make_rule(field="data.temperature", operator=ConditionOperator.GT, threshold=100.0))
        alerts = engine.evaluate({"data": {"temperature": 120.0}})
        assert len(alerts) == 1
        assert alerts[0].actual_value == 120.0

    def test_missing_field_does_not_fire(self, engine):
        engine.add_rule(_make_rule(field="missing_field"))
        alerts = engine.evaluate({"other_field": 999.0})
        assert len(alerts) == 0


# ---------------------------------------------------------------------------
# Anomaly Detection Tests
# ---------------------------------------------------------------------------


class TestAnomalyDetection:
    """Test z-score anomaly detection."""

    def test_anomaly_detected_with_outlier(self, engine):
        rule = _make_rule(
            name="anomaly-rule",
            operator=ConditionOperator.ANOMALY,
            threshold=3.0,
            z_score_threshold=2.0,
        )
        engine.add_rule(rule)

        # Feed normal values to build history (need at least 7)
        normal_values = [100.0, 101.0, 99.0, 100.5, 100.2, 99.8, 100.1, 99.5]
        for v in normal_values:
            engine.evaluate({"value": v})

        # Now send an outlier
        alerts = engine.evaluate({"value": 200.0})  # Far from mean ~100
        assert len(alerts) == 1

    def test_anomaly_not_detected_with_normal(self, engine):
        rule = _make_rule(
            name="anomaly-rule",
            operator=ConditionOperator.ANOMALY,
            threshold=3.0,
            z_score_threshold=3.0,
        )
        engine.add_rule(rule)

        # Feed normal values
        for v in [100.0, 101.0, 99.0, 100.5, 100.2, 99.8, 100.1, 99.5]:
            engine.evaluate({"value": v})

        # Send a value within normal range
        alerts = engine.evaluate({"value": 100.3})
        assert len(alerts) == 0

    def test_anomaly_requires_minimum_data_points(self, engine):
        rule = _make_rule(
            name="anomaly-rule",
            operator=ConditionOperator.ANOMALY,
            threshold=3.0,
            z_score_threshold=2.0,
        )
        engine.add_rule(rule)

        # Only feed 3 values (need 7)
        for v in [100.0, 101.0, 99.0]:
            engine.evaluate({"value": v})

        # Even an outlier shouldn't fire with insufficient data
        alerts = engine.evaluate({"value": 500.0})
        assert len(alerts) == 0


# ---------------------------------------------------------------------------
# Freshness Checking Tests
# ---------------------------------------------------------------------------


class TestFreshnessChecking:
    """Test data freshness rules (time-based thresholds)."""

    def test_stale_data_triggers_alert(self, engine):
        """Simulates a freshness check using GT on minutes_since_update."""
        rule = _make_rule(
            name="freshness-rule",
            field="minutes_since_update",
            operator=ConditionOperator.GT,
            threshold=60.0,
        )
        engine.add_rule(rule)

        alerts = engine.evaluate({"minutes_since_update": 120.0})
        assert len(alerts) == 1
        assert alerts[0].rule_name == "freshness-rule"

    def test_fresh_data_no_alert(self, engine):
        rule = _make_rule(
            name="freshness-rule",
            field="minutes_since_update",
            operator=ConditionOperator.GT,
            threshold=60.0,
        )
        engine.add_rule(rule)

        alerts = engine.evaluate({"minutes_since_update": 30.0})
        assert len(alerts) == 0


# ---------------------------------------------------------------------------
# Batch Evaluation Tests
# ---------------------------------------------------------------------------


class TestBatchEvaluation:
    """Test evaluating multiple events against multiple rules."""

    def test_batch_evaluation(self, engine):
        engine.add_rule(
            _make_rule(name="high-temp", field="temperature", operator=ConditionOperator.GT, threshold=100.0)
        )
        engine.add_rule(
            _make_rule(name="low-pressure", field="pressure", operator=ConditionOperator.LT, threshold=900.0)
        )

        events = [
            {"temperature": 120.0, "pressure": 1013.0},
            {"temperature": 80.0, "pressure": 850.0},
            {"temperature": 110.0, "pressure": 880.0},
        ]

        alerts = engine.evaluate_batch(events)

        rule_names = [a.rule_name for a in alerts]
        assert "high-temp" in rule_names
        assert "low-pressure" in rule_names
        # Event 1: high-temp fires; Event 2: low-pressure fires; Event 3: both fire
        assert len(alerts) >= 3

    def test_disabled_rule_skipped(self, engine):
        engine.add_rule(_make_rule(name="disabled", enabled=False))
        alerts = engine.evaluate({"value": 999.0})
        assert len(alerts) == 0


# ---------------------------------------------------------------------------
# Rule Management Tests
# ---------------------------------------------------------------------------


class TestRuleManagement:
    """Test adding, removing, and listing rules."""

    def test_add_and_list_rules(self, engine):
        engine.add_rule(_make_rule(name="rule-1"))
        engine.add_rule(_make_rule(name="rule-2"))

        rules = engine.list_rules()
        assert len(rules) == 2
        assert rules[0]["name"] == "rule-1"

    def test_remove_rule(self, engine):
        engine.add_rule(_make_rule(name="rule-to-remove"))
        assert engine.remove_rule("rule-to-remove") is True
        assert len(engine.list_rules()) == 0

    def test_remove_nonexistent_rule(self, engine):
        assert engine.remove_rule("nonexistent") is False


# ---------------------------------------------------------------------------
# Alert Metadata Tests
# ---------------------------------------------------------------------------


class TestAlertMetadata:
    """Test that fired alerts contain correct metadata."""

    def test_fired_alert_has_correct_fields(self, engine):
        engine.add_rule(
            _make_rule(
                name="test-alert",
                field="cpu_percent",
                operator=ConditionOperator.GT,
                threshold=90.0,
                tags={"env": "prod"},
            )
        )

        alerts = engine.evaluate({"cpu_percent": 95.0})

        assert len(alerts) == 1
        alert = alerts[0]
        assert alert.rule_name == "test-alert"
        assert alert.condition_field == "cpu_percent"
        assert alert.actual_value == 95.0
        assert alert.threshold == 90.0
        assert ActionType.TEAMS in alert.actions
        assert alert.metadata["tags"] == {"env": "prod"}
        assert alert.timestamp  # Should have ISO timestamp
