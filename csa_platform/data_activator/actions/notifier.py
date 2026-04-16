"""Notification dispatchers for the Data Activator.

Provides a pluggable notification system with dispatchers for:
- Microsoft Teams (via incoming webhook with Adaptive Cards)
- Email (via SendGrid or SMTP)
- Generic webhooks (POST to arbitrary URL)
- Incident creation (ServiceNow / PagerDuty)

Usage::

    from actions.notifier import NotifierFactory
    from rules.schema import Action, ActionType, ActionConfig

    action = Action(
        type=ActionType.TEAMS,
        config=ActionConfig(webhook_url="https://..."),
    )
    notifier = NotifierFactory.create(action)
    success = notifier.send(alert_payload)
"""

from __future__ import annotations

import json
import os
import smtplib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from email.message import EmailMessage
from typing import Any

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="data-activator-notifier")
logger = get_logger(__name__)

try:
    import requests
except ImportError:
    requests = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Alert payload
# ---------------------------------------------------------------------------


@dataclass
class AlertPayload:
    """Standardised payload passed to all notifiers.

    Attributes:
        rule_name: Name of the alert rule that fired.
        description: Rule description.
        severity: Alert severity (critical, warning, info).
        field: The metric field that triggered the alert.
        actual_value: The observed value.
        threshold: The configured threshold.
        timestamp: ISO-8601 timestamp.
        source: Event source identifier.
        metadata: Additional context.
    """

    rule_name: str
    description: str = ""
    severity: str = "warning"
    field: str = ""
    actual_value: float = 0.0
    threshold: float | list[float] = 0.0
    timestamp: str = ""
    source: str = ""
    metadata: dict[str, Any] = dataclass_field(default_factory=dict)


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------


class BaseNotifier(ABC):
    """Abstract base class for notification dispatchers."""

    @abstractmethod
    def send(self, payload: AlertPayload) -> bool:
        """Send a notification.

        Args:
            payload: The standardised alert payload.

        Returns:
            ``True`` if the notification was delivered successfully.
        """
        ...

    @abstractmethod
    def validate_config(self) -> bool:
        """Check whether the notifier is properly configured.

        Returns:
            ``True`` if configuration is valid and ready.
        """
        ...


# ---------------------------------------------------------------------------
# Teams Notifier
# ---------------------------------------------------------------------------


class TeamsNotifier(BaseNotifier):
    """Send alerts to Microsoft Teams via an incoming webhook.

    Builds rich Adaptive Cards using :mod:`teams_card`.

    Args:
        webhook_url: Teams incoming webhook URL.
    """

    def __init__(self, webhook_url: str = "") -> None:
        self.webhook_url = webhook_url or os.environ.get("TEAMS_WEBHOOK_URL", "")

    def validate_config(self) -> bool:
        """Check that the webhook URL is configured."""
        return bool(self.webhook_url)

    def send(self, payload: AlertPayload) -> bool:
        """Send an Adaptive Card alert to Teams.

        Args:
            payload: The alert payload.

        Returns:
            ``True`` on success.
        """
        if not self.validate_config():
            logger.warning("TeamsNotifier: webhook URL not configured")
            return False

        if requests is None:
            logger.error("TeamsNotifier: 'requests' library not installed")
            return False

        from .teams_card import build_alert_card

        card = build_alert_card(payload)

        try:
            resp = requests.post(
                self.webhook_url,
                json=card,
                headers={"Content-Type": "application/json"},
                timeout=10,
            )
            resp.raise_for_status()
            logger.info("teams.notification_sent", rule_name=payload.rule_name)
            return True
        except requests.RequestException:
            logger.exception("teams.notification_failed", rule_name=payload.rule_name)
            return False


# ---------------------------------------------------------------------------
# Email Notifier
# ---------------------------------------------------------------------------


class EmailNotifier(BaseNotifier):
    """Send alert emails via SendGrid API or SMTP.

    Prefers SendGrid when ``SENDGRID_API_KEY`` is set; falls back to SMTP.

    Args:
        recipients: Email addresses to send to.
        from_address: Sender email address.
        sendgrid_api_key: SendGrid API key.
        smtp_host: SMTP server hostname.
        smtp_port: SMTP server port.
    """

    def __init__(
        self,
        recipients: list[str] | None = None,
        from_address: str = "",
        sendgrid_api_key: str = "",
        smtp_host: str = "",
        smtp_port: int = 587,
    ) -> None:
        self.recipients = recipients or []
        self.from_address = from_address or os.environ.get("ALERT_FROM_EMAIL", "alerts@csa-inabox.gov")
        self.sendgrid_api_key = sendgrid_api_key or os.environ.get("SENDGRID_API_KEY", "")
        self.smtp_host = smtp_host or os.environ.get("SMTP_HOST", "")
        self.smtp_port = smtp_port

    def validate_config(self) -> bool:
        """Check that recipients and a delivery method are configured."""
        if not self.recipients:
            return False
        return bool(self.sendgrid_api_key) or bool(self.smtp_host)

    def send(self, payload: AlertPayload) -> bool:
        """Send an alert email.

        Args:
            payload: The alert payload.

        Returns:
            ``True`` on success.
        """
        if not self.recipients:
            logger.warning("EmailNotifier: no recipients configured")
            return False

        subject = f"[CSA Alert] {payload.severity.upper()}: {payload.rule_name}"
        body = self._build_body(payload)

        if self.sendgrid_api_key:
            return self._send_sendgrid(subject, body)
        if self.smtp_host:
            return self._send_smtp(subject, body)

        logger.warning("EmailNotifier: no email transport configured")
        return False

    def _build_body(self, payload: AlertPayload) -> str:
        """Build the email body from the alert payload."""
        return (
            f"Alert: {payload.rule_name}\n"
            f"Severity: {payload.severity.upper()}\n"
            f"Description: {payload.description}\n"
            f"Field: {payload.field}\n"
            f"Value: {payload.actual_value}\n"
            f"Threshold: {payload.threshold}\n"
            f"Source: {payload.source}\n"
            f"Timestamp: {payload.timestamp}\n"
            f"\nMetadata:\n{json.dumps(payload.metadata, indent=2)}"
        )

    def _send_sendgrid(self, subject: str, body: str) -> bool:
        """Send email via SendGrid API."""
        if requests is None:
            logger.error("EmailNotifier: 'requests' library not installed")
            return False

        sg_payload = {
            "personalizations": [{"to": [{"email": r} for r in self.recipients]}],
            "from": {"email": self.from_address},
            "subject": subject,
            "content": [{"type": "text/plain", "value": body}],
        }
        try:
            resp = requests.post(
                "https://api.sendgrid.com/v3/mail/send",
                json=sg_payload,
                headers={
                    "Authorization": f"Bearer {self.sendgrid_api_key}",
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
            resp.raise_for_status()
            logger.info("sendgrid.email_sent", recipients=self.recipients)
            return True
        except requests.RequestException:
            logger.exception("SendGrid email failed")
            return False

    def _send_smtp(self, subject: str, body: str) -> bool:
        """Send email via SMTP."""
        try:
            msg = EmailMessage()
            msg["Subject"] = subject
            msg["From"] = self.from_address
            msg["To"] = ", ".join(self.recipients)
            msg.set_content(body)

            with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
                server.starttls()
                smtp_user = os.environ.get("SMTP_USER", "")
                smtp_pass = os.environ.get("SMTP_PASSWORD", "")
                if smtp_user:
                    server.login(smtp_user, smtp_pass)
                server.send_message(msg)

            logger.info("smtp.email_sent", recipients=self.recipients)
            return True
        except (smtplib.SMTPException, OSError):
            logger.exception("SMTP email failed")
            return False


# ---------------------------------------------------------------------------
# Webhook Notifier
# ---------------------------------------------------------------------------


class WebhookNotifier(BaseNotifier):
    """POST alert payloads to an arbitrary webhook URL.

    Args:
        url: The target webhook URL.
        headers: Optional HTTP headers to include.
    """

    def __init__(
        self,
        url: str = "",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.url = url
        self.headers = headers or {"Content-Type": "application/json"}

    def validate_config(self) -> bool:
        """Check that the URL is configured."""
        return bool(self.url)

    def send(self, payload: AlertPayload) -> bool:
        """POST the alert payload to the webhook URL.

        Args:
            payload: The alert payload.

        Returns:
            ``True`` on success.
        """
        if not self.validate_config():
            logger.warning("WebhookNotifier: URL not configured")
            return False

        if requests is None:
            logger.error("WebhookNotifier: 'requests' library not installed")
            return False

        body = {
            "rule_name": payload.rule_name,
            "description": payload.description,
            "severity": payload.severity,
            "field": payload.field,
            "actual_value": payload.actual_value,
            "threshold": payload.threshold,
            "timestamp": payload.timestamp,
            "source": payload.source,
            "metadata": payload.metadata,
        }

        try:
            resp = requests.post(
                self.url,
                json=body,
                headers=self.headers,
                timeout=10,
            )
            resp.raise_for_status()
            logger.info("webhook.notification_sent", url=self.url)
            return True
        except requests.RequestException:
            logger.exception("webhook.notification_failed", url=self.url)
            return False


# ---------------------------------------------------------------------------
# Incident Creator
# ---------------------------------------------------------------------------


class IncidentCreator(BaseNotifier):
    """Create incidents in ServiceNow or PagerDuty.

    Args:
        service: Incident management platform (``"servicenow"`` or ``"pagerduty"``).
        api_url: Service API URL.
        api_key: API key or integration key.
        severity: Incident severity level.
    """

    def __init__(
        self,
        service: str = "pagerduty",
        api_url: str = "",
        api_key: str = "",
        severity: str = "high",
    ) -> None:
        self.service = service.lower()
        self.api_key = api_key or os.environ.get(
            f"{self.service.upper()}_API_KEY",
            os.environ.get("PAGERDUTY_INTEGRATION_KEY", ""),
        )
        self.api_url = api_url
        self.severity = severity

    def validate_config(self) -> bool:
        """Check that the API key is configured."""
        return bool(self.api_key)

    def send(self, payload: AlertPayload) -> bool:
        """Create an incident.

        Args:
            payload: The alert payload.

        Returns:
            ``True`` on success.
        """
        if not self.validate_config():
            logger.warning("incident_creator.api_key_missing", service=self.service)
            return False

        if self.service == "pagerduty":
            return self._create_pagerduty_incident(payload)
        if self.service == "servicenow":
            return self._create_servicenow_incident(payload)

        logger.warning("incident_creator.unsupported_service", service=self.service)
        return False

    def _create_pagerduty_incident(self, payload: AlertPayload) -> bool:
        """Create a PagerDuty incident via Events API v2."""
        if requests is None:
            logger.error("IncidentCreator: 'requests' library not installed")
            return False

        pd_payload = {
            "routing_key": self.api_key,
            "event_action": "trigger",
            "payload": {
                "summary": f"{payload.rule_name}: {payload.field}={payload.actual_value} (threshold={payload.threshold})",
                "severity": self.severity,
                "source": f"csa-inabox/{payload.source}",
                "component": payload.metadata.get("data_product", "unknown"),
                "custom_details": {
                    "rule_name": payload.rule_name,
                    "description": payload.description,
                    "actual_value": payload.actual_value,
                    "threshold": payload.threshold,
                    "metadata": payload.metadata,
                },
            },
        }

        try:
            resp = requests.post(
                "https://events.pagerduty.com/v2/enqueue",
                json=pd_payload,
                timeout=10,
            )
            resp.raise_for_status()
            logger.info("pagerduty.incident_created", rule_name=payload.rule_name)
            return True
        except requests.RequestException:
            logger.exception("PagerDuty incident creation failed")
            return False

    def _create_servicenow_incident(self, payload: AlertPayload) -> bool:
        """Create a ServiceNow incident via REST API."""
        if requests is None:
            logger.error("IncidentCreator: 'requests' library not installed")
            return False

        sn_url = self.api_url or os.environ.get("SERVICENOW_INSTANCE_URL", "")
        if not sn_url:
            logger.warning("IncidentCreator: ServiceNow instance URL not configured")
            return False

        sn_payload = {
            "short_description": f"CSA Alert: {payload.rule_name}",
            "description": (
                f"Alert: {payload.rule_name}\n"
                f"Description: {payload.description}\n"
                f"Field: {payload.field} = {payload.actual_value}\n"
                f"Threshold: {payload.threshold}\n"
                f"Source: {payload.source}\n"
                f"Timestamp: {payload.timestamp}"
            ),
            "urgency": "1" if self.severity == "critical" else "2",
            "impact": "1" if self.severity == "critical" else "2",
        }

        try:
            resp = requests.post(
                f"{sn_url.rstrip('/')}/api/now/table/incident",
                json=sn_payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
                timeout=15,
            )
            resp.raise_for_status()
            logger.info("servicenow.incident_created", rule_name=payload.rule_name)
            return True
        except requests.RequestException:
            logger.exception("ServiceNow incident creation failed")
            return False


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


class NotifierFactory:
    """Create the appropriate notifier from an Action configuration.

    Usage::

        from rules.schema import Action, ActionType, ActionConfig

        action = Action(type=ActionType.TEAMS, config=ActionConfig(webhook_url="..."))
        notifier = NotifierFactory.create(action)
        notifier.send(payload)
    """

    @staticmethod
    def create(action: Any) -> BaseNotifier:
        """Create a notifier instance from an :class:`Action` model.

        Args:
            action: An ``Action`` model instance from the schema module.

        Returns:
            A configured :class:`BaseNotifier` subclass.

        Raises:
            ValueError: If the action type is not supported.
        """
        from ..rules.schema import ActionType

        action_type = action.type
        config = action.config

        if action_type == ActionType.TEAMS:
            return TeamsNotifier(webhook_url=config.webhook_url or "")

        if action_type == ActionType.EMAIL:
            return EmailNotifier(recipients=config.recipients)

        if action_type == ActionType.WEBHOOK:
            return WebhookNotifier(url=config.url or "")

        if action_type == ActionType.FUNCTION:
            # Functions are invoked via webhook
            return WebhookNotifier(url=config.url or "")

        if action_type == ActionType.INCIDENT:
            return IncidentCreator(
                service=config.service or "pagerduty",
                severity=config.severity or "high",
            )

        raise ValueError(f"Unsupported action type: {action_type}")

    @staticmethod
    def create_all(actions: list[Any]) -> list[BaseNotifier]:
        """Create notifier instances for a list of actions.

        Args:
            actions: List of ``Action`` model instances.

        Returns:
            List of configured notifiers.
        """
        return [NotifierFactory.create(a) for a in actions]
