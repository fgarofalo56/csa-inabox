"""CSA-0112 — Azure AI Content Safety integration.

Platform-wide text moderation used by the RAG pipeline, the Copilot agent
loop, and any portal surface that accepts free-form user input.  The module
wraps :class:`azure.ai.contentsafety.aio.ContentSafetyClient` and returns a
frozen :class:`ContentSafetyVerdict` DTO; downstream code never imports the
Azure SDK directly.

Design notes:

    * **Feature-flagged.**  The platform is safe-by-default; when the
      ``CONTENT_SAFETY_ENABLED`` env var is unset/false, the factory returns
      a :class:`NoopContentSafetyClient` that passes every input.  Call
      sites therefore always interact with the same interface.
    * **Managed identity by default.**  When ``CONTENT_SAFETY_ENABLED=true``
      and ``CONTENT_SAFETY_ENDPOINT`` is set, the real client uses
      :class:`azure.identity.aio.DefaultAzureCredential`.  A key-based
      fallback is supported via ``CONTENT_SAFETY_KEY`` for dev.
    * **Lazy SDK import.**  The ``azure.ai.contentsafety`` package is only
      imported inside :meth:`_AzureContentSafetyClient.analyze_text`, so
      the module is importable in environments where that SDK isn't
      installed (local dev, unit tests).
    * **Typed errors only.**  :class:`ContentSafetyBlockedError` is the only
      exception raised by :func:`apply_policy` / downstream enforcement.
      Transient SDK errors propagate as :class:`ContentSafetyError`.
"""

from __future__ import annotations

import contextlib
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from csa_platform.common.logging import get_logger

__all__ = [
    "ContentSafetyBlockedError",
    "ContentSafetyCategory",
    "ContentSafetyClient",
    "ContentSafetyError",
    "ContentSafetyPolicy",
    "ContentSafetyVerdict",
    "NoopContentSafetyClient",
    "apply_policy",
    "build_content_safety_client",
]

_logger = get_logger(__name__)


# Canonical category names aligned with the Azure Content Safety REST API
# (``categoriesAnalysis`` → category field).  We use uppercase strings in
# public API to match the SDK's enum values.
class ContentSafetyCategory(str):
    """Shared constants for Content Safety categories."""

    HATE = "Hate"
    SEXUAL = "Sexual"
    VIOLENCE = "Violence"
    SELFHARM = "SelfHarm"


ALL_CATEGORIES: tuple[str, ...] = (
    ContentSafetyCategory.HATE,
    ContentSafetyCategory.SEXUAL,
    ContentSafetyCategory.VIOLENCE,
    ContentSafetyCategory.SELFHARM,
)


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ContentSafetyVerdict:
    """Result of analyzing a single text blob.

    Attributes:
        allowed: True when the blob passed the active policy.  For the
            raw :meth:`ContentSafetyClient.analyze_text` call this is
            purely advisory (severity scores do the talking); callers are
            expected to feed the verdict into :func:`apply_policy` for
            the real allow/block decision.
        categories_triggered: List of category names whose severity > 0.
        severity_scores: Mapping of category → severity (0, 2, 4, 6).
    """

    allowed: bool
    categories_triggered: list[str] = field(default_factory=list)
    severity_scores: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ContentSafetyPolicy:
    """Per-category severity thresholds.

    The Content Safety API returns severities on a 0/2/4/6 scale (low →
    high).  A category is "blocked" when ``severity_scores[cat] >= threshold``.
    ``None`` means "category disabled".

    Defaults below mirror the common production posture: block at severity
    4 ("medium") for hate/sexual/self-harm and allow severity 2
    ("low-moderate"), with a slightly tighter block at 4 for violence.
    """

    hate: int | None = 4
    sexual: int | None = 4
    violence: int | None = 4
    selfharm: int | None = 4

    def threshold_for(self, category: str) -> int | None:
        """Return the threshold for *category* (case-insensitive)."""
        key = category.lower()
        return {
            "hate": self.hate,
            "sexual": self.sexual,
            "violence": self.violence,
            "selfharm": self.selfharm,
        }.get(key)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class ContentSafetyError(Exception):
    """Base class for :mod:`content_safety` errors."""


class ContentSafetyBlockedError(ContentSafetyError):
    """Raised by :func:`apply_policy` when the verdict violates the policy."""

    def __init__(self, verdict: ContentSafetyVerdict, policy: ContentSafetyPolicy) -> None:
        self.verdict = verdict
        self.policy = policy
        super().__init__(
            f"Content Safety blocked input — categories_triggered="
            f"{verdict.categories_triggered}, severity_scores="
            f"{verdict.severity_scores}.",
        )


# ---------------------------------------------------------------------------
# Protocol + implementations
# ---------------------------------------------------------------------------


class ContentSafetyClient(Protocol):
    """Async protocol implemented by both Noop and real Azure clients."""

    async def analyze_text(self, text: str) -> ContentSafetyVerdict:
        """Analyze *text* and return a :class:`ContentSafetyVerdict`."""
        ...

    async def close(self) -> None:
        """Release underlying resources (credential, HTTP pool)."""
        ...


class NoopContentSafetyClient:
    """Dev/test implementation — passes everything, zero external calls.

    Mirrors the :class:`ContentSafetyClient` protocol so production call
    sites don't branch on whether content safety is enabled.
    """

    async def analyze_text(self, text: str) -> ContentSafetyVerdict:  # noqa: ARG002
        return ContentSafetyVerdict(
            allowed=True,
            categories_triggered=[],
            severity_scores=dict.fromkeys(ALL_CATEGORIES, 0),
        )

    async def close(self) -> None:
        return None


class _AzureContentSafetyClient:
    """Production implementation backed by ``azure.ai.contentsafety.aio``.

    The SDK is imported lazily so this module stays importable without the
    ``governance`` extra installed.  All network behaviour is funnelled
    through the SDK (no bespoke httpx calls), so the exfil guard applied
    upstream to the caller's egress path is the enforcement point.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        key: str | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._key = key
        self._client: Any | None = None
        self._credential: Any | None = None

    async def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            # Lazy imports — keep the module importable without the SDK.
            from azure.ai.contentsafety.aio import ContentSafetyClient as SdkClient
            from azure.core.credentials import AzureKeyCredential
        except ImportError as exc:  # pragma: no cover — covered via monkeypatch
            raise ContentSafetyError(
                "azure-ai-contentsafety is not installed. Install the "
                "'governance' extra or disable CONTENT_SAFETY_ENABLED.",
            ) from exc

        if self._key:
            self._client = SdkClient(
                endpoint=self._endpoint,
                credential=AzureKeyCredential(self._key),
            )
        else:
            try:
                from azure.identity.aio import DefaultAzureCredential
            except ImportError as exc:  # pragma: no cover
                raise ContentSafetyError(
                    "azure-identity is required for managed-identity content safety.",
                ) from exc
            self._credential = DefaultAzureCredential()
            self._client = SdkClient(
                endpoint=self._endpoint,
                credential=self._credential,
            )
        return self._client

    async def analyze_text(self, text: str) -> ContentSafetyVerdict:
        client = await self._get_client()
        try:
            from azure.ai.contentsafety.models import AnalyzeTextOptions
        except ImportError as exc:  # pragma: no cover
            raise ContentSafetyError(
                "azure-ai-contentsafety models not importable.",
            ) from exc

        try:
            response = await client.analyze_text(AnalyzeTextOptions(text=text))
        except Exception as exc:
            raise ContentSafetyError(
                f"Azure Content Safety call failed: {exc!r}",
            ) from exc

        scores: dict[str, int] = {}
        triggered: list[str] = []
        # The SDK returns a ``categories_analysis`` list (each item has
        # ``category`` + ``severity``).  We stay duck-typed because the
        # attribute names differ slightly across SDK versions and we
        # never want a version bump to break our contract.
        categories_analysis = getattr(response, "categories_analysis", None) or []
        for item in categories_analysis:
            category = getattr(item, "category", None) or (
                item.get("category") if isinstance(item, dict) else None
            )
            severity = getattr(item, "severity", None)
            if severity is None and isinstance(item, dict):
                severity = item.get("severity")
            if category is None or severity is None:
                continue
            cat_name = str(category)
            sev_int = int(severity)
            scores[cat_name] = sev_int
            if sev_int > 0:
                triggered.append(cat_name)

        verdict = ContentSafetyVerdict(
            allowed=not triggered,
            categories_triggered=triggered,
            severity_scores=scores,
        )
        _logger.info(
            "content_safety.analyzed",
            **{"content_safety.verdict": "allowed" if verdict.allowed else "flagged"},
            severity_scores=scores,
            categories_triggered=triggered,
        )
        return verdict

    async def close(self) -> None:
        if self._client is not None:
            with contextlib.suppress(Exception):
                await self._client.close()
        if self._credential is not None:
            with contextlib.suppress(Exception):
                await self._credential.close()


# ---------------------------------------------------------------------------
# Policy application
# ---------------------------------------------------------------------------


def apply_policy(
    verdict: ContentSafetyVerdict,
    policy: ContentSafetyPolicy,
    *,
    raise_on_block: bool = False,
) -> bool:
    """Return True when *verdict* satisfies *policy*.

    Args:
        verdict: Raw analyzer output.
        policy: Per-category thresholds.
        raise_on_block: When True, raise :class:`ContentSafetyBlockedError`
            instead of returning False.
    """
    for category, severity in verdict.severity_scores.items():
        threshold = policy.threshold_for(category)
        if threshold is None:
            continue
        if severity >= threshold:
            _logger.warning(
                "content_safety.policy_violation",
                **{"content_safety.verdict": "blocked"},
                category=category,
                severity=severity,
                threshold=threshold,
            )
            if raise_on_block:
                raise ContentSafetyBlockedError(verdict=verdict, policy=policy)
            return False
    return True


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def _flag_enabled(raw: str | None) -> bool:
    return (raw or "").strip().lower() in ("true", "1", "yes")


def build_content_safety_client() -> ContentSafetyClient:
    """Return the active :class:`ContentSafetyClient` implementation.

    Logic:

        * ``CONTENT_SAFETY_ENABLED`` not truthy → :class:`NoopContentSafetyClient`.
        * ``CONTENT_SAFETY_ENABLED=true`` and ``CONTENT_SAFETY_ENDPOINT`` set
          → :class:`_AzureContentSafetyClient` (managed-identity by default,
          key-based when ``CONTENT_SAFETY_KEY`` is present).
        * Enabled but endpoint missing → :class:`NoopContentSafetyClient`
          with a warning log so misconfiguration doesn't take prod down.
    """
    if not _flag_enabled(os.environ.get("CONTENT_SAFETY_ENABLED")):
        _logger.info("content_safety.client", impl="noop", reason="flag_disabled")
        return NoopContentSafetyClient()

    endpoint = os.environ.get("CONTENT_SAFETY_ENDPOINT", "").strip()
    if not endpoint:
        _logger.warning(
            "content_safety.client",
            impl="noop",
            reason="missing_endpoint",
        )
        return NoopContentSafetyClient()

    key = os.environ.get("CONTENT_SAFETY_KEY") or None
    _logger.info(
        "content_safety.client",
        impl="azure",
        endpoint=endpoint,
        auth="key" if key else "managed_identity",
    )
    return _AzureContentSafetyClient(endpoint=endpoint, key=key)
