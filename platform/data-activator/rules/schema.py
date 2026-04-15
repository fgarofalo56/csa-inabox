"""Pydantic models for Data Activator alert rules.

Defines the schema for alert rules, conditions, actions, and schedules.
Rules are typically loaded from YAML files and validated automatically
by Pydantic.

Usage::

    from schema import AlertRule, load_rules_from_yaml

    rules = load_rules_from_yaml("sample_rules.yaml")
    for rule in rules:
        print(rule.name, rule.condition.operator)
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class ConditionOperator(str, Enum):
    """Supported comparison operators for alert conditions."""

    GT = "gt"
    LT = "lt"
    GTE = "gte"
    LTE = "lte"
    EQ = "eq"
    NEQ = "neq"
    CONTAINS = "contains"
    BETWEEN = "between"
    ANOMALY = "anomaly"


class ActionType(str, Enum):
    """Supported notification action types."""

    TEAMS = "teams"
    EMAIL = "email"
    FUNCTION = "function"
    WEBHOOK = "webhook"
    INCIDENT = "incident"


class AggregationType(str, Enum):
    """Supported windowed aggregation types."""

    COUNT = "count"
    AVG = "avg"
    MIN = "min"
    MAX = "max"
    SUM = "sum"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class Condition(BaseModel):
    """Alert trigger condition.

    Defines the field to evaluate, the comparison operator, and
    threshold value.  Optionally supports windowed aggregation.

    Attributes:
        field: Dot-separated field path in the event payload.
        operator: Comparison operator.
        threshold: Threshold value (single number for most operators,
            two-element list for ``between``).
        window_minutes: Sliding window size in minutes for aggregation
            (0 means evaluate each event independently).
        aggregation: Aggregation function applied within the window.
        z_score_threshold: Z-score threshold when ``operator`` is
            ``anomaly``.
    """

    field: str = Field(..., description="Dot-separated event field path.")
    operator: ConditionOperator = Field(..., description="Comparison operator.")
    threshold: float | list[float] = Field(
        ...,
        description="Threshold value or [low, high] for 'between'.",
    )
    window_minutes: int = Field(
        default=0,
        ge=0,
        description="Sliding window in minutes (0 = per-event).",
    )
    aggregation: AggregationType | None = Field(
        default=None,
        description="Aggregation function for windowed evaluation.",
    )
    z_score_threshold: float = Field(
        default=3.0,
        gt=0,
        description="Z-score threshold for anomaly detection.",
    )

    @field_validator("threshold")
    @classmethod
    def _validate_between_threshold(cls, v: float | list[float], info: Any) -> float | list[float]:  # noqa: ARG003
        """Ensure ``between`` operator receives a two-element list."""
        # info.data may not have 'operator' yet during init, so we
        # validate only when we can.
        return v


class ActionConfig(BaseModel):
    """Configuration payload for a notification action.

    The exact keys depend on the action type.

    Attributes:
        webhook_url: Webhook URL (Teams, generic webhook).
        channel: Teams channel name.
        recipients: Email recipient addresses.
        url: Target URL for webhook or function actions.
        function_name: Azure Function name to invoke.
        service: Incident management service name.
        severity: Incident severity level.
    """

    webhook_url: str | None = Field(default=None, description="Webhook URL.")
    channel: str | None = Field(default=None, description="Teams channel.")
    recipients: list[str] = Field(default_factory=list, description="Email recipients.")
    url: str | None = Field(default=None, description="Target URL.")
    function_name: str | None = Field(default=None, description="Azure Function name.")
    service: str | None = Field(default=None, description="Incident service (ServiceNow, PagerDuty).")
    severity: str | None = Field(default=None, description="Incident severity.")


class Action(BaseModel):
    """A notification action triggered when an alert fires.

    Attributes:
        type: The notification channel type.
        config: Channel-specific configuration.
    """

    type: ActionType = Field(..., description="Notification channel type.")
    config: ActionConfig = Field(
        default_factory=ActionConfig,
        description="Channel-specific settings.",
    )


class Schedule(BaseModel):
    """Alert evaluation schedule.

    Attributes:
        cron: Cron expression for periodic evaluation.
        timezone: IANA timezone name.
        active_hours_start: Hour (0-23) when the schedule becomes active.
        active_hours_end: Hour (0-23) when the schedule deactivates.
    """

    cron: str = Field(
        default="* * * * *",
        description="Cron expression (5-field).",
    )
    timezone: str = Field(default="UTC", description="IANA timezone.")
    active_hours_start: int | None = Field(
        default=None,
        ge=0,
        le=23,
        description="Start of active hours window.",
    )
    active_hours_end: int | None = Field(
        default=None,
        ge=0,
        le=23,
        description="End of active hours window.",
    )


class AlertRule(BaseModel):
    """Complete alert rule definition.

    Attributes:
        name: Unique rule identifier.
        description: Human-readable description.
        source: Event Grid topic or source identifier.
        condition: Trigger condition.
        actions: List of notification actions.
        schedule: Evaluation schedule.
        enabled: Whether the rule is active.
        tags: Arbitrary tags for grouping and filtering.
    """

    name: str = Field(..., min_length=1, description="Unique rule name.")
    description: str = Field(default="", description="Rule description.")
    source: str = Field(
        default="",
        description="Event Grid topic or source identifier.",
    )
    condition: Condition = Field(..., description="Trigger condition.")
    actions: list[Action] = Field(
        default_factory=list,
        description="Notification actions.",
    )
    schedule: Schedule = Field(
        default_factory=Schedule,
        description="Evaluation schedule.",
    )
    enabled: bool = Field(default=True, description="Whether the rule is active.")
    tags: dict[str, str] = Field(default_factory=dict, description="Metadata tags.")


class AlertRuleSet(BaseModel):
    """A collection of alert rules, typically loaded from a single YAML file.

    Attributes:
        rules: List of alert rules.
    """

    rules: list[AlertRule] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_rules_from_yaml(path: str | Path) -> list[AlertRule]:
    """Load and validate alert rules from a YAML file.

    Args:
        path: Path to the YAML file.

    Returns:
        List of validated :class:`AlertRule` instances.

    Raises:
        FileNotFoundError: If the file does not exist.
        pydantic.ValidationError: If the YAML does not match the schema.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Rules file not found: {path}")

    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    rule_set = AlertRuleSet.model_validate(raw)
    return rule_set.rules


def rules_to_yaml(rules: list[AlertRule], path: str | Path) -> None:
    """Serialize alert rules to a YAML file.

    Args:
        rules: List of alert rules.
        path: Output file path.
    """
    path = Path(path)
    data = AlertRuleSet(rules=rules).model_dump(mode="json")
    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False)
