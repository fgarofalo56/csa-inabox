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

from csa_platform.common.logging import configure_structlog, get_logger

from .dlq import DLQEnvelope, DeadLetterQueue, get_default_dlq
from .errors import DataActivatorFatalError, DataActivatorTransientError
from .retry import retry_sync

configure_structlog(service="data-activator-notifier")
logger = get_logger(__name__)

try:
    import requests
except ImportError:
    requests = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Error classification helpers
# ---------------------------------------------------------------------------


_TRANSIENT_STATUS_CODES: frozenset[int] = frozenset({408, 425, 429, 500, 502, 503, 504})


def _classify_http_error(exc: Any) -> DataActivatorTransientError | DataActivatorFatalError:
    """Map a ``requests`` exception to a typed Data Activator error.

    Timeouts, connection errors, chunked encoding issues, and 5xx / 408 /
    425 / 429 responses are transient; everything else (4xx auth, 400
    validation) is fatal.
    """
    if requests is None:  # pragma: no cover - guarded by caller
        return DataActivatorFatalError(str(exc))

    # requests.exceptions hosts the canonical classes; the ``requests``
    # module re-exports most of them, but ChunkedEncodingError lives
    # only under the submodule in some installs.
    req_exc = requests.exceptions

    if isinstance(exc, req_exc.Timeout):
        return DataActivatorTransientError(f"timeout: {exc}")
    if isinstance(exc, req_exc.ConnectionError):
        return DataActivatorTransientError(f"connection: {exc}")
    if isinstance(exc, req_exc.ChunkedEncodingError):
        return DataActivatorTransientError(f"chunked: {exc}")
    if isinstance(exc, req_exc.HTTPError):
        status = getattr(getattr(exc, "response", None), "status_code", 0) or 0
        if status in _TRANSIENT_STATUS_CODES or (500 <= status < 600):
            return DataActivatorTransientError(f"http {status}: {exc}")
        return DataActivatorFatalError(f"http {status}: {exc}")
    # Any other RequestException is treated as transient — the retry
    # loop handles it and the DLQ catches a pathological exhaustion.
    return DataActivatorTransientError(f"unknown: {exc}")


def _payload_to_dict(payload: AlertPayload) -> dict[str, Any]:  # type: ignore[name-defined]
    from dataclasses import asdict

    return asdict(payload)


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
    """Abstract base class for notification dispatchers.

    Concrete notifiers implement :meth:`_deliver` (a single outbound
    attempt).  :meth:`send` wraps the attempt in tenacity exponential
    backoff (via :func:`retry_sync`) and, on exhaustion or fatal error,
    pushes the original payload to the configured
    :class:`~csa_platform.data_activator.actions.dlq.DeadLetterQueue`.

    Args:
        retry_attempts: Max attempts (including the first try).  The
            default ``3`` matches the streaming breach publisher.
        dlq: Optional DLQ override.  Defaults to
            :func:`get_default_dlq`, which picks up
            ``DATA_ACTIVATOR_DLQ_CONNECTION_STRING``.
    """

    #: Human-readable notifier type for DLQ envelopes.  Overridden by subclasses.
    NOTIFIER_TYPE: str = "base"

    def __init__(
        self,
        *,
        retry_attempts: int = 3,
        dlq: DeadLetterQueue | None = None,
    ) -> None:
        self._retry_attempts = max(1, retry_attempts)
        self._dlq: DeadLetterQueue = dlq if dlq is not None else get_default_dlq()

    @property
    def dlq(self) -> DeadLetterQueue:
        return self._dlq

    @property
    def retry_attempts(self) -> int:
        return self._retry_attempts

    @abstractmethod
    def _deliver(self, payload: AlertPayload) -> None:
        """Perform a single delivery attempt.

        Implementations MUST raise
        :class:`~csa_platform.data_activator.actions.errors.DataActivatorTransientError`
        for retry-eligible failures and
        :class:`~csa_platform.data_activator.actions.errors.DataActivatorFatalError`
        for non-retryable failures.  Successful delivery must return
        ``None``.
        """
        ...

    def send(self, payload: AlertPayload) -> bool:
        """Send a notification with retries + DLQ fallback.

        Args:
            payload: The standardised alert payload.

        Returns:
            ``True`` if the notification was delivered successfully; ``False``
            if all retries were exhausted or a fatal error occurred (in
            which case the payload was sent to the DLQ).
        """
        if not self.validate_config():
            logger.warning(
                "data_activator.notifier.not_configured",
                notifier_type=self.NOTIFIER_TYPE,
                rule_name=payload.rule_name,
            )
            return False

        attempts = 0

        def _attempt() -> None:
            nonlocal attempts
            attempts += 1
            self._deliver(payload)

        try:
            retry_sync(_attempt, max_attempts=self._retry_attempts)
        except DataActivatorFatalError as exc:
            logger.error(
                "data_activator.notifier.fatal",
                notifier_type=self.NOTIFIER_TYPE,
                rule_name=payload.rule_name,
                error=str(exc),
            )
            self._dead_letter(payload, exc, "fatal", attempts)
            return False
        except DataActivatorTransientError as exc:
            logger.error(
                "data_activator.notifier.retry_exhausted",
                notifier_type=self.NOTIFIER_TYPE,
                rule_name=payload.rule_name,
                attempts=attempts,
                error=str(exc),
            )
            self._dead_letter(payload, exc, "transient_exhausted", attempts)
            return False
        except Exception as exc:  # noqa: BLE001 — last-resort guard
            logger.exception(
                "data_activator.notifier.unexpected",
                notifier_type=self.NOTIFIER_TYPE,
                rule_name=payload.rule_name,
            )
            self._dead_letter(payload, exc, "fatal", attempts)
            return False

        logger.info(
            "data_activator.notifier.delivered",
            notifier_type=self.NOTIFIER_TYPE,
            rule_name=payload.rule_name,
            attempts=attempts,
        )
        return True

    def _dead_letter(
        self,
        payload: AlertPayload,
        error: BaseException,
        reason: str,
        attempts: int,
    ) -> None:
        envelope = DLQEnvelope.build(
            rule_name=payload.rule_name,
            notifier_type=self.NOTIFIER_TYPE,
            failure_reason=reason,
            error=error,
            attempts=attempts,
            payload=_payload_to_dict(payload),
        )
        try:
            self._dlq.send(envelope)
        except Exception:  # noqa: BLE001 — DLQ itself must never crash the loop
            logger.exception(
                "data_activator.notifier.dlq_error",
                notifier_type=self.NOTIFIER_TYPE,
                rule_name=payload.rule_name,
            )

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
        retry_attempts: Max outbound attempts (default 3).
        dlq: Optional DLQ override for tests.
    """

    NOTIFIER_TYPE = "teams"

    def __init__(
        self,
        webhook_url: str = "",
        *,
        retry_attempts: int = 3,
        dlq: DeadLetterQueue | None = None,
    ) -> None:
        super().__init__(retry_attempts=retry_attempts, dlq=dlq)
        self.webhook_url = webhook_url or os.environ.get("TEAMS_WEBHOOK_URL", "")

    def validate_config(self) -> bool:
        """Check that the webhook URL is configured."""
        if not self.webhook_url:
            return False
        if requests is None:
            logger.error("TeamsNotifier: 'requests' library not installed")
            return False
        return True

    def _deliver(self, payload: AlertPayload) -> None:
        assert requests is not None  # guaranteed by validate_config  # noqa: S101
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
        except requests.RequestException as exc:
            raise _classify_http_error(exc) from exc


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

    NOTIFIER_TYPE = "email"

    def __init__(
        self,
        recipients: list[str] | None = None,
        from_address: str = "",
        sendgrid_api_key: str = "",
        smtp_host: str = "",
        smtp_port: int = 587,
        *,
        retry_attempts: int = 3,
        dlq: DeadLetterQueue | None = None,
    ) -> None:
        super().__init__(retry_attempts=retry_attempts, dlq=dlq)
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

    def _deliver(self, payload: AlertPayload) -> None:
        subject = f"[CSA Alert] {payload.severity.upper()}: {payload.rule_name}"
        body = self._build_body(payload)

        if self.sendgrid_api_key:
            self._send_sendgrid(subject, body)
            return
        if self.smtp_host:
            self._send_smtp(subject, body)
            return

        raise DataActivatorFatalError("no email transport configured")

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

    def _send_sendgrid(self, subject: str, body: str) -> None:
        """Send email via SendGrid API — raises typed errors on failure."""
        if requests is None:
            raise DataActivatorFatalError("'requests' library not installed")

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
        except requests.RequestException as exc:
            raise _classify_http_error(exc) from exc

    def _send_smtp(self, subject: str, body: str) -> None:
        """Send email via SMTP — raises typed errors on failure."""
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = self.from_address
        msg["To"] = ", ".join(self.recipients)
        msg.set_content(body)

        try:
            with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
                server.starttls()
                smtp_user = os.environ.get("SMTP_USER", "")
                smtp_pass = os.environ.get("SMTP_PASSWORD", "")
                if smtp_user:
                    server.login(smtp_user, smtp_pass)
                server.send_message(msg)
        except smtplib.SMTPAuthenticationError as exc:
            raise DataActivatorFatalError(f"smtp auth: {exc}") from exc
        except smtplib.SMTPRecipientsRefused as exc:
            raise DataActivatorFatalError(f"smtp recipients: {exc}") from exc
        except (smtplib.SMTPException, OSError) as exc:
            raise DataActivatorTransientError(f"smtp: {exc}") from exc


# ---------------------------------------------------------------------------
# Webhook Notifier
# ---------------------------------------------------------------------------


class WebhookNotifier(BaseNotifier):
    """POST alert payloads to an arbitrary webhook URL.

    Args:
        url: The target webhook URL.
        headers: Optional HTTP headers to include.
    """

    NOTIFIER_TYPE = "webhook"

    def __init__(
        self,
        url: str = "",
        headers: dict[str, str] | None = None,
        *,
        retry_attempts: int = 3,
        dlq: DeadLetterQueue | None = None,
    ) -> None:
        super().__init__(retry_attempts=retry_attempts, dlq=dlq)
        self.url = url
        self.headers = headers or {"Content-Type": "application/json"}

    def validate_config(self) -> bool:
        """Check that the URL is configured."""
        if not self.url:
            return False
        if requests is None:
            logger.error("WebhookNotifier: 'requests' library not installed")
            return False
        return True

    def _deliver(self, payload: AlertPayload) -> None:
        assert requests is not None  # guaranteed by validate_config  # noqa: S101
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
        except requests.RequestException as exc:
            raise _classify_http_error(exc) from exc


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

    NOTIFIER_TYPE = "incident"

    def __init__(
        self,
        service: str = "pagerduty",
        api_url: str = "",
        api_key: str = "",
        severity: str = "high",
        *,
        retry_attempts: int = 3,
        dlq: DeadLetterQueue | None = None,
    ) -> None:
        super().__init__(retry_attempts=retry_attempts, dlq=dlq)
        self.service = service.lower()
        self.api_key = api_key or os.environ.get(
            f"{self.service.upper()}_API_KEY",
            os.environ.get("PAGERDUTY_INTEGRATION_KEY", ""),
        )
        self.api_url = api_url
        self.severity = severity

    def validate_config(self) -> bool:
        """Check that the API key is configured and supported service selected."""
        if not self.api_key:
            return False
        if self.service not in {"pagerduty", "servicenow"}:
            return False
        if self.service == "servicenow" and not (
            self.api_url or os.environ.get("SERVICENOW_INSTANCE_URL", "")
        ):
            return False
        if requests is None:
            logger.error("IncidentCreator: 'requests' library not installed")
            return False
        return True

    def _deliver(self, payload: AlertPayload) -> None:
        if self.service == "pagerduty":
            self._create_pagerduty_incident(payload)
            return
        if self.service == "servicenow":
            self._create_servicenow_incident(payload)
            return
        raise DataActivatorFatalError(f"unsupported incident service: {self.service}")

    def _create_pagerduty_incident(self, payload: AlertPayload) -> None:
        """Create a PagerDuty incident via Events API v2 — raises typed errors."""
        assert requests is not None  # guaranteed by validate_config  # noqa: S101

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
        except requests.RequestException as exc:
            raise _classify_http_error(exc) from exc

    def _create_servicenow_incident(self, payload: AlertPayload) -> None:
        """Create a ServiceNow incident via REST API — raises typed errors."""
        assert requests is not None  # guaranteed by validate_config  # noqa: S101

        sn_url = self.api_url or os.environ.get("SERVICENOW_INSTANCE_URL", "")
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
        except requests.RequestException as exc:
            raise _classify_http_error(exc) from exc


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
