"""Tests for the csa_platform/data_activator module.

Covers:
- Alert rule schema (Pydantic models, YAML loading/saving)
- RuleEngine (condition evaluation, windowed aggregation, anomaly detection)
- Notifiers (Teams, Email, Webhook, Incident — all mocked)
- Teams card builder (card structure, recommended actions)

Mocking strategy
----------------
All external HTTP calls (Teams webhooks, SendGrid, PagerDuty, ServiceNow)
are mocked with ``unittest.mock.patch`` on the ``requests`` library.
SMTP calls are mocked at the ``smtplib`` level.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from governance.common.logging import reset_logging_state

# ---------------------------------------------------------------------------
# Test credential constants (not real credentials — used only for structural
# validation in unit tests; all external HTTP calls are mocked).
# ---------------------------------------------------------------------------

_FAKE_API_KEY = "key123"
_FAKE_SENDGRID_KEY = "sg-key"
_FAKE_PAGERDUTY_ROUTING_KEY = "routing-key"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset structlog state between tests."""
    reset_logging_state()
    yield
    reset_logging_state()


# ---------------------------------------------------------------------------
# Schema model tests (Pydantic validation)
# ---------------------------------------------------------------------------


class TestAlertRuleSchema:
    """Tests for alert rule Pydantic models."""

    def test_condition_operator_values(self) -> None:
        """ConditionOperator enum has all expected operators."""
        from csa_platform.data_activator.rules.schema import ConditionOperator  # type: ignore[import-untyped]

        assert ConditionOperator.GT == "gt"
        assert ConditionOperator.LT == "lt"
        assert ConditionOperator.BETWEEN == "between"
        assert ConditionOperator.ANOMALY == "anomaly"
        assert ConditionOperator.CONTAINS == "contains"

    def test_action_type_values(self) -> None:
        """ActionType enum has all expected types."""
        from csa_platform.data_activator.rules.schema import ActionType  # type: ignore[import-untyped]

        assert ActionType.TEAMS == "teams"
        assert ActionType.EMAIL == "email"
        assert ActionType.WEBHOOK == "webhook"
        assert ActionType.INCIDENT == "incident"

    def test_aggregation_type_values(self) -> None:
        """AggregationType enum has all expected types."""
        from csa_platform.data_activator.rules.schema import AggregationType  # type: ignore[import-untyped]

        assert AggregationType.COUNT == "count"
        assert AggregationType.AVG == "avg"
        assert AggregationType.SUM == "sum"

    def test_condition_model(self) -> None:
        """Condition model validates basic fields."""
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            Condition,
            ConditionOperator,
        )

        cond = Condition(field="data.temperature", operator=ConditionOperator.GT, threshold=100.0)
        assert cond.field == "data.temperature"
        assert cond.operator == ConditionOperator.GT
        assert cond.threshold == 100.0
        assert cond.window_minutes == 0

    def test_condition_between_threshold(self) -> None:
        """Condition with 'between' operator accepts a two-element list."""
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            Condition,
            ConditionOperator,
        )

        cond = Condition(field="data.value", operator=ConditionOperator.BETWEEN, threshold=[10.0, 50.0])
        assert cond.threshold == [10.0, 50.0]

    def test_alert_rule_model(self) -> None:
        """AlertRule model validates a complete rule definition."""
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            Action,
            ActionConfig,
            ActionType,
            AlertRule,
            Condition,
            ConditionOperator,
        )

        rule = AlertRule(
            name="high-temp",
            description="Alert on high temperature",
            condition=Condition(field="temp", operator=ConditionOperator.GT, threshold=100.0),
            actions=[Action(type=ActionType.TEAMS, config=ActionConfig(webhook_url="https://hook"))],
        )
        assert rule.name == "high-temp"
        assert rule.enabled is True
        assert len(rule.actions) == 1

    def test_alert_rule_name_validation(self) -> None:
        """AlertRule requires non-empty name."""
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            AlertRule,
            Condition,
            ConditionOperator,
        )

        with pytest.raises(ValueError, match="name"):
            AlertRule(
                name="",
                condition=Condition(field="f", operator=ConditionOperator.GT, threshold=1.0),
            )

    def test_load_rules_from_yaml(self, tmp_path: Path) -> None:
        """load_rules_from_yaml parses valid YAML into AlertRule objects."""
        from csa_platform.data_activator.rules.schema import load_rules_from_yaml  # type: ignore[import-untyped]

        yaml_content = """
rules:
  - name: test-rule
    description: Test alert
    condition:
      field: data.value
      operator: gt
      threshold: 50.0
    actions:
      - type: teams
        config:
          webhook_url: https://hook
"""
        yaml_file = tmp_path / "rules.yaml"
        yaml_file.write_text(yaml_content, encoding="utf-8")

        rules = load_rules_from_yaml(yaml_file)
        assert len(rules) == 1
        assert rules[0].name == "test-rule"
        assert rules[0].condition.threshold == 50.0

    def test_load_rules_file_not_found(self) -> None:
        """load_rules_from_yaml raises FileNotFoundError for missing files."""
        from csa_platform.data_activator.rules.schema import load_rules_from_yaml  # type: ignore[import-untyped]

        with pytest.raises(FileNotFoundError):
            load_rules_from_yaml("/nonexistent/rules.yaml")

    def test_rules_to_yaml(self, tmp_path: Path) -> None:
        """rules_to_yaml serializes rules and can be loaded back."""
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            AlertRule,
            Condition,
            ConditionOperator,
            load_rules_from_yaml,
            rules_to_yaml,
        )

        rule = AlertRule(
            name="roundtrip-test",
            condition=Condition(field="val", operator=ConditionOperator.LT, threshold=10.0),
        )
        yaml_file = tmp_path / "output.yaml"
        rules_to_yaml([rule], yaml_file)
        assert yaml_file.exists()

        loaded = load_rules_from_yaml(yaml_file)
        assert len(loaded) == 1
        assert loaded[0].name == "roundtrip-test"


# ---------------------------------------------------------------------------
# RuleEngine tests
# ---------------------------------------------------------------------------


class TestRuleEngine:
    """Tests for the RuleEngine class."""

    def _make_engine(self, rules: list[Any] | None = None) -> Any:
        from csa_platform.data_activator.rules.engine import RuleEngine  # type: ignore[import-untyped]

        return RuleEngine(rules=rules)

    def _make_rule(self, name: str = "test", field: str = "value", operator: str = "gt", threshold: float = 50.0, **kwargs: Any) -> Any:
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            AlertRule,
            Condition,
            ConditionOperator,
        )

        return AlertRule(
            name=name,
            condition=Condition(field=field, operator=ConditionOperator(operator), threshold=threshold, **kwargs),
        )

    def test_evaluate_gt_fires(self) -> None:
        """GT condition fires when value exceeds threshold."""
        rule = self._make_rule(operator="gt", threshold=50.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"value": 75.0})
        assert len(alerts) == 1
        assert alerts[0].rule_name == "test"
        assert alerts[0].actual_value == 75.0

    def test_evaluate_gt_no_fire(self) -> None:
        """GT condition does not fire when value is below threshold."""
        rule = self._make_rule(operator="gt", threshold=50.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"value": 30.0})
        assert len(alerts) == 0

    def test_evaluate_lt(self) -> None:
        """LT condition fires when value is below threshold."""
        rule = self._make_rule(operator="lt", threshold=50.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"value": 30.0})
        assert len(alerts) == 1

    def test_evaluate_gte(self) -> None:
        """GTE condition fires when value equals threshold."""
        rule = self._make_rule(operator="gte", threshold=50.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"value": 50.0})
        assert len(alerts) == 1

    def test_evaluate_eq(self) -> None:
        """EQ condition fires on exact match."""
        rule = self._make_rule(operator="eq", threshold=42.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"value": 42.0})
        assert len(alerts) == 1

    def test_evaluate_neq(self) -> None:
        """NEQ condition fires when value differs."""
        rule = self._make_rule(operator="neq", threshold=42.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"value": 43.0})
        assert len(alerts) == 1

    def test_evaluate_between(self) -> None:
        """BETWEEN condition fires when value is in range."""
        rule = self._make_rule(operator="between", threshold=[10.0, 50.0])
        engine = self._make_engine([rule])

        assert len(engine.evaluate({"value": 30.0})) == 1
        assert len(engine.evaluate({"value": 5.0})) == 0
        assert len(engine.evaluate({"value": 60.0})) == 0

    def test_evaluate_contains_string(self) -> None:
        """CONTAINS condition matches substrings."""
        rule = self._make_rule(field="status", operator="contains", threshold=42.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"status": "error code 42.0 found"})
        assert len(alerts) == 1

    def test_evaluate_nested_field(self) -> None:
        """Dot-separated field paths resolve nested values."""
        rule = self._make_rule(field="data.sensor.temp", operator="gt", threshold=100.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"data": {"sensor": {"temp": 120.0}}})
        assert len(alerts) == 1

    def test_evaluate_missing_field(self) -> None:
        """Missing field does not fire the rule."""
        rule = self._make_rule(field="nonexistent", operator="gt", threshold=50.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"value": 100.0})
        assert len(alerts) == 0

    def test_disabled_rule_skipped(self) -> None:
        """Disabled rules are not evaluated."""
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            AlertRule,
            Condition,
            ConditionOperator,
        )

        rule = AlertRule(
            name="disabled",
            condition=Condition(field="value", operator=ConditionOperator.GT, threshold=0.0),
            enabled=False,
        )
        engine = self._make_engine([rule])
        alerts = engine.evaluate({"value": 100.0})
        assert len(alerts) == 0

    def test_evaluate_batch(self) -> None:
        """evaluate_batch processes multiple events."""
        rule = self._make_rule(operator="gt", threshold=50.0)
        engine = self._make_engine([rule])
        alerts = engine.evaluate_batch([{"value": 60.0}, {"value": 30.0}, {"value": 70.0}])
        assert len(alerts) == 2

    def test_add_and_remove_rule(self) -> None:
        """Rules can be added and removed dynamically."""
        engine = self._make_engine()
        rule = self._make_rule(name="dynamic")
        engine.add_rule(rule)
        assert len(engine.list_rules()) == 1
        removed = engine.remove_rule("dynamic")
        assert removed is True
        assert len(engine.list_rules()) == 0

    def test_remove_nonexistent_rule(self) -> None:
        """Removing a nonexistent rule returns False."""
        engine = self._make_engine()
        assert engine.remove_rule("ghost") is False

    def test_list_rules(self) -> None:
        """list_rules returns rule summaries."""
        rule = self._make_rule(name="summary-test")
        engine = self._make_engine([rule])
        summaries = engine.list_rules()
        assert len(summaries) == 1
        assert summaries[0]["name"] == "summary-test"
        assert summaries[0]["operator"] == "gt"


# ---------------------------------------------------------------------------
# Notifier tests
# ---------------------------------------------------------------------------


class TestTeamsNotifier:
    """Tests for TeamsNotifier."""

    def _make_payload(self) -> Any:
        from csa_platform.data_activator.actions.notifier import AlertPayload  # type: ignore[import-untyped]

        return AlertPayload(
            rule_name="test-alert",
            description="Test alert description",
            severity="warning",
            field="temperature",
            actual_value=105.0,
            threshold=100.0,
        )

    def test_send_success(self) -> None:
        """TeamsNotifier.send succeeds on 200 response."""
        from csa_platform.data_activator.actions.notifier import TeamsNotifier  # type: ignore[import-untyped]

        notifier = TeamsNotifier(webhook_url="https://webhook.example.com")
        payload = self._make_payload()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        with patch("csa_platform.data_activator.actions.notifier.requests") as mock_requests:
            mock_requests.post.return_value = mock_response
            result = notifier.send(payload)

        assert result is True

    def test_send_no_url(self) -> None:
        """TeamsNotifier.send returns False without webhook URL."""
        from csa_platform.data_activator.actions.notifier import TeamsNotifier  # type: ignore[import-untyped]

        notifier = TeamsNotifier(webhook_url="")
        assert notifier.send(self._make_payload()) is False

    def test_validate_config(self) -> None:
        """validate_config returns True when URL is set."""
        from csa_platform.data_activator.actions.notifier import TeamsNotifier  # type: ignore[import-untyped]

        assert TeamsNotifier(webhook_url="https://hook").validate_config() is True
        assert TeamsNotifier(webhook_url="").validate_config() is False


class TestWebhookNotifier:
    """Tests for WebhookNotifier."""

    def test_send_success(self) -> None:
        """WebhookNotifier.send POSTs payload to URL."""
        from csa_platform.data_activator.actions.notifier import (  # type: ignore[import-untyped]
            AlertPayload,
            WebhookNotifier,
        )

        notifier = WebhookNotifier(url="https://webhook.example.com/api")
        payload = AlertPayload(rule_name="test", severity="info")

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()

        with patch("csa_platform.data_activator.actions.notifier.requests") as mock_requests:
            mock_requests.post.return_value = mock_response
            result = notifier.send(payload)

        assert result is True

    def test_send_no_url(self) -> None:
        """WebhookNotifier.send returns False without URL."""
        from csa_platform.data_activator.actions.notifier import (  # type: ignore[import-untyped]
            AlertPayload,
            WebhookNotifier,
        )

        notifier = WebhookNotifier(url="")
        assert notifier.send(AlertPayload(rule_name="test")) is False


class TestEmailNotifier:
    """Tests for EmailNotifier."""

    def test_validate_config_no_recipients(self) -> None:
        """validate_config returns False without recipients."""
        from csa_platform.data_activator.actions.notifier import EmailNotifier  # type: ignore[import-untyped]

        notifier = EmailNotifier(recipients=[])
        assert notifier.validate_config() is False

    def test_validate_config_with_sendgrid(self) -> None:
        """validate_config returns True with SendGrid key and recipients."""
        from csa_platform.data_activator.actions.notifier import EmailNotifier  # type: ignore[import-untyped]

        notifier = EmailNotifier(recipients=["user@test.com"], sendgrid_api_key=_FAKE_API_KEY)
        assert notifier.validate_config() is True

    def test_send_no_recipients(self) -> None:
        """send returns False without recipients."""
        from csa_platform.data_activator.actions.notifier import (  # type: ignore[import-untyped]
            AlertPayload,
            EmailNotifier,
        )

        notifier = EmailNotifier(recipients=[])
        assert notifier.send(AlertPayload(rule_name="test")) is False

    def test_send_sendgrid(self) -> None:
        """send via SendGrid posts to SendGrid API."""
        from csa_platform.data_activator.actions.notifier import (  # type: ignore[import-untyped]
            AlertPayload,
            EmailNotifier,
        )

        notifier = EmailNotifier(recipients=["user@test.com"], sendgrid_api_key=_FAKE_SENDGRID_KEY)
        payload = AlertPayload(rule_name="test", severity="critical")

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()

        with patch("csa_platform.data_activator.actions.notifier.requests") as mock_requests:
            mock_requests.post.return_value = mock_response
            result = notifier.send(payload)

        assert result is True


class TestIncidentCreator:
    """Tests for IncidentCreator."""

    def test_validate_config(self) -> None:
        """validate_config checks for API key."""
        from csa_platform.data_activator.actions.notifier import IncidentCreator  # type: ignore[import-untyped]

        assert IncidentCreator(api_key=_FAKE_API_KEY).validate_config() is True
        assert IncidentCreator(api_key="").validate_config() is False

    def test_send_pagerduty(self) -> None:
        """send creates PagerDuty incident."""
        from csa_platform.data_activator.actions.notifier import (  # type: ignore[import-untyped]
            AlertPayload,
            IncidentCreator,
        )

        creator = IncidentCreator(service="pagerduty", api_key=_FAKE_PAGERDUTY_ROUTING_KEY)
        payload = AlertPayload(rule_name="test", severity="critical", field="cpu", actual_value=99.0, threshold=90.0)

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()

        with patch("csa_platform.data_activator.actions.notifier.requests") as mock_requests:
            mock_requests.post.return_value = mock_response
            result = creator.send(payload)

        assert result is True

    def test_unsupported_service(self) -> None:
        """send returns False for unsupported service."""
        from csa_platform.data_activator.actions.notifier import (  # type: ignore[import-untyped]
            AlertPayload,
            IncidentCreator,
        )

        creator = IncidentCreator(service="unknown", api_key="key")
        assert creator.send(AlertPayload(rule_name="test")) is False


class TestNotifierFactory:
    """Tests for NotifierFactory."""

    def test_create_teams(self) -> None:
        """Factory creates TeamsNotifier for TEAMS action type."""
        from csa_platform.data_activator.actions.notifier import (  # type: ignore[import-untyped]
            NotifierFactory,
            TeamsNotifier,
        )
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            Action,
            ActionConfig,
            ActionType,
        )

        action = Action(type=ActionType.TEAMS, config=ActionConfig(webhook_url="https://hook"))
        notifier = NotifierFactory.create(action)
        assert isinstance(notifier, TeamsNotifier)

    def test_create_webhook(self) -> None:
        """Factory creates WebhookNotifier for WEBHOOK action type."""
        from csa_platform.data_activator.actions.notifier import (  # type: ignore[import-untyped]
            NotifierFactory,
            WebhookNotifier,
        )
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            Action,
            ActionConfig,
            ActionType,
        )

        action = Action(type=ActionType.WEBHOOK, config=ActionConfig(url="https://api"))
        notifier = NotifierFactory.create(action)
        assert isinstance(notifier, WebhookNotifier)

    def test_create_all(self) -> None:
        """create_all returns notifiers for all actions."""
        from csa_platform.data_activator.actions.notifier import NotifierFactory  # type: ignore[import-untyped]
        from csa_platform.data_activator.rules.schema import (  # type: ignore[import-untyped]
            Action,
            ActionConfig,
            ActionType,
        )

        actions = [
            Action(type=ActionType.TEAMS, config=ActionConfig(webhook_url="https://h")),
            Action(type=ActionType.WEBHOOK, config=ActionConfig(url="https://u")),
        ]
        notifiers = NotifierFactory.create_all(actions)
        assert len(notifiers) == 2


# ---------------------------------------------------------------------------
# Teams card builder tests
# ---------------------------------------------------------------------------


class TestTeamsCardBuilder:
    """Tests for teams_card module."""

    def _make_payload(self, **kwargs: Any) -> Any:
        from csa_platform.data_activator.actions.notifier import AlertPayload  # type: ignore[import-untyped]

        defaults: dict[str, Any] = {
            "rule_name": "test-rule",
            "description": "Test description",
            "severity": "warning",
            "field": "temperature",
            "actual_value": 105.0,
            "threshold": 100.0,
            "source": "sensor-1",
            "metadata": {},
        }
        defaults.update(kwargs)
        return AlertPayload(**defaults)

    def test_build_alert_card_structure(self) -> None:
        """build_alert_card returns valid Adaptive Card structure."""
        from csa_platform.data_activator.actions.teams_card import build_alert_card  # type: ignore[import-untyped]

        card = build_alert_card(self._make_payload())
        assert card["type"] == "message"
        assert len(card["attachments"]) == 1
        assert card["attachments"][0]["contentType"] == "application/vnd.microsoft.card.adaptive"
        content = card["attachments"][0]["content"]
        assert content["type"] == "AdaptiveCard"
        assert content["version"] == "1.5"

    def test_build_simple_card(self) -> None:
        """build_simple_card returns MessageCard format."""
        from csa_platform.data_activator.actions.teams_card import build_simple_card  # type: ignore[import-untyped]

        card = build_simple_card("Alert Title", "Alert message", severity="critical", facts={"key": "value"})
        assert card["@type"] == "MessageCard"
        assert card["themeColor"] == "FF0000"
        assert card["summary"] == "Alert Title"

    @pytest.mark.parametrize(
        ("rule_name", "expected_keyword"),
        [
            ("seismic-alert", "USGS"),
            ("air-quality-warning", "health advisory"),
            ("park-capacity", "crowd management"),
            ("pipeline-failure", "pipeline run logs"),
            ("data-freshness-breach", "pipeline execution"),
            ("slot-machine-anomaly", "Flag machine"),
            ("generic-alert", "Investigate"),
        ],
    )
    def test_recommended_actions_by_rule_type(self, rule_name: str, expected_keyword: str) -> None:
        """_get_recommended_actions returns domain-specific recommendations."""
        from csa_platform.data_activator.actions.teams_card import (
            _get_recommended_actions,  # type: ignore[import-untyped]
        )

        payload = self._make_payload(rule_name=rule_name)
        actions = _get_recommended_actions(payload)
        assert any(expected_keyword in a for a in actions)
