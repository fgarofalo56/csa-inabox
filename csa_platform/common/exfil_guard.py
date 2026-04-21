"""CSA-0091 — Outbound call allowlist / exfiltration guard.

Any outbound HTTP(S) call made from platform code that could reach a
customer-controlled or third-party endpoint MUST be routed through
:class:`ExfilGuard`.  The guard enforces a cloud-aware allowlist:

    * **Commercial** — allows the standard Microsoft-public hostnames
      (``*.azure.com``, ``*.core.windows.net``, ``*.openai.azure.com`` …).
    * **US Gov / US Gov High** — allows only the gov hostnames
      (``*.usgovcloudapi.net``, ``*.azure.us``, ``*.openai.azure.us``).
      US Gov High drops a handful of borderline hosts (``graph.microsoft.us``
      stays; the less-restricted endpoints drop out).
    * **Germany** / **China** — sovereign-cloud hostnames only.

Callers extend the allowlist at runtime via the
``CSA_EXFIL_ALLOWLIST_EXTRA_HOSTS`` env var (comma-separated fully-qualified
hostnames).  Wildcard patterns (``*.example.com``) are supported.

The module exposes three composition styles:

    1. A direct call — :meth:`ExfilGuard.validate_outbound_url`.
    2. The :func:`guard_outbound` decorator — wraps any async function that
       takes a ``url`` keyword argument and enforces the allowlist before
       the underlying call executes.
    3. An httpx-compatible request hook — :meth:`ExfilGuard.httpx_request_hook`
       suitable for ``httpx.AsyncClient(event_hooks={"request": [hook]})``.

Every allowed call emits a structured INFO log; every blocked call emits a
structured ERROR log **and** raises :class:`ExfilGuardViolationError` — callers
must not catch this exception outside of the audit plane.
"""

from __future__ import annotations

import fnmatch
import os
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, TypeVar
from urllib.parse import urlparse

from csa_platform.common.cloud_boundary import (
    CloudEnvironment,
    detect_cloud_environment,
)
from csa_platform.common.logging import get_logger

__all__ = [
    "ExfilGuard",
    "ExfilGuardConfig",
    "ExfilGuardViolationError",
    "build_default_guard",
    "guard_outbound",
]

_logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class ExfilGuardViolationError(Exception):
    """Raised when :class:`ExfilGuard` blocks an outbound URL."""

    def __init__(self, url: str, host: str, cloud_env: CloudEnvironment) -> None:
        self.url = url
        self.host = host
        self.cloud_env = cloud_env
        super().__init__(
            f"ExfilGuard blocked outbound call to host '{host}' "
            f"(url='{url}', cloud_env='{cloud_env.value}') — host not in allowlist.",
        )


# ---------------------------------------------------------------------------
# Per-environment default allowlists
# ---------------------------------------------------------------------------


_DEFAULT_ALLOWLIST: dict[CloudEnvironment, tuple[str, ...]] = {
    CloudEnvironment.COMMERCIAL: (
        # Entra / Graph / Management
        "login.microsoftonline.com",
        "login.windows.net",
        "graph.microsoft.com",
        "management.azure.com",
        # Storage + Data Lake
        "*.blob.core.windows.net",
        "*.dfs.core.windows.net",
        "*.file.core.windows.net",
        "*.queue.core.windows.net",
        "*.table.core.windows.net",
        # AI Search / OpenAI / Cognitive
        "*.search.windows.net",
        "*.openai.azure.com",
        "*.cognitiveservices.azure.com",
        # Key Vault, Cosmos, Service Bus, Event Hubs
        "*.vault.azure.net",
        "*.documents.azure.com",
        "*.servicebus.windows.net",
        "*.database.windows.net",
        # Purview + Monitor
        "*.purview.azure.com",
        "*.ingest.monitor.azure.com",
        "*.applicationinsights.azure.com",
        # Wildcard catch-alls allowed on the base azure.com domain.
        "*.azure.com",
    ),
    CloudEnvironment.US_GOV: (
        "login.microsoftonline.us",
        "graph.microsoft.us",
        "management.usgovcloudapi.net",
        "*.blob.core.usgovcloudapi.net",
        "*.dfs.core.usgovcloudapi.net",
        "*.file.core.usgovcloudapi.net",
        "*.queue.core.usgovcloudapi.net",
        "*.table.core.usgovcloudapi.net",
        "*.search.azure.us",
        "*.openai.azure.us",
        "*.cognitiveservices.azure.us",
        "*.vault.usgovcloudapi.net",
        "*.documents.azure.us",
        "*.servicebus.usgovcloudapi.net",
        "*.database.usgovcloudapi.net",
        "*.purview.azure.us",
        "*.ingest.monitor.azure.us",
        "*.azure.us",
    ),
    # Gov-High is intentionally tighter — no generic *.azure.us wildcard.
    CloudEnvironment.US_GOV_HIGH: (
        "login.microsoftonline.us",
        "graph.microsoft.us",
        "management.usgovcloudapi.net",
        "*.blob.core.usgovcloudapi.net",
        "*.dfs.core.usgovcloudapi.net",
        "*.file.core.usgovcloudapi.net",
        "*.search.azure.us",
        "*.openai.azure.us",
        "*.cognitiveservices.azure.us",
        "*.vault.usgovcloudapi.net",
        "*.documents.azure.us",
        "*.servicebus.usgovcloudapi.net",
        "*.database.usgovcloudapi.net",
        "*.purview.azure.us",
        "*.ingest.monitor.azure.us",
    ),
    CloudEnvironment.GERMANY: (
        "login.microsoftonline.de",
        "graph.microsoft.de",
        "management.microsoftazure.de",
        "*.blob.core.cloudapi.de",
        "*.dfs.core.cloudapi.de",
        "*.vault.microsoftazure.de",
    ),
    CloudEnvironment.CHINA: (
        "login.chinacloudapi.cn",
        "management.chinacloudapi.cn",
        "*.blob.core.chinacloudapi.cn",
        "*.dfs.core.chinacloudapi.cn",
        "*.vault.azure.cn",
    ),
    # UNKNOWN: empty allowlist — fail-closed by default.
    CloudEnvironment.UNKNOWN: (),
}


# ---------------------------------------------------------------------------
# Config + Guard
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ExfilGuardConfig:
    """Immutable config for an :class:`ExfilGuard` instance."""

    cloud_env: CloudEnvironment
    allowlist: tuple[str, ...]
    extra_hosts: tuple[str, ...] = field(default_factory=tuple)

    @property
    def effective_allowlist(self) -> tuple[str, ...]:
        """Merged allowlist = base + extras (de-duplicated, order-preserved)."""
        seen: set[str] = set()
        out: list[str] = []
        for host in (*self.allowlist, *self.extra_hosts):
            lowered = host.lower()
            if lowered and lowered not in seen:
                seen.add(lowered)
                out.append(lowered)
        return tuple(out)

    @classmethod
    def for_environment(
        cls,
        cloud_env: CloudEnvironment,
        *,
        extra_hosts: Iterable[str] | None = None,
    ) -> ExfilGuardConfig:
        """Build a config using the default allowlist for *cloud_env*."""
        extras: tuple[str, ...] = tuple(h.strip() for h in (extra_hosts or ()) if h.strip())
        return cls(
            cloud_env=cloud_env,
            allowlist=_DEFAULT_ALLOWLIST[cloud_env],
            extra_hosts=extras,
        )

    @classmethod
    def from_env(cls, cloud_env: CloudEnvironment | None = None) -> ExfilGuardConfig:
        """Build a config, reading extras from ``CSA_EXFIL_ALLOWLIST_EXTRA_HOSTS``."""
        resolved = cloud_env if cloud_env is not None else detect_cloud_environment()
        raw = os.environ.get("CSA_EXFIL_ALLOWLIST_EXTRA_HOSTS", "")
        extras = tuple(h.strip() for h in raw.split(",") if h.strip())
        return cls.for_environment(resolved, extra_hosts=extras)


class ExfilGuard:
    """Enforce a per-cloud allowlist on outbound URLs."""

    def __init__(self, config: ExfilGuardConfig) -> None:
        self._config = config
        # Pre-compute the effective allowlist so validate_outbound_url is cheap.
        self._effective = config.effective_allowlist

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def config(self) -> ExfilGuardConfig:
        """Return the frozen config this guard was built from."""
        return self._config

    @property
    def cloud_env(self) -> CloudEnvironment:
        """Shortcut for ``self.config.cloud_env``."""
        return self._config.cloud_env

    @property
    def allowlist(self) -> tuple[str, ...]:
        """Return the effective (merged + de-duped) allowlist."""
        return self._effective

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def is_host_allowed(self, host: str) -> bool:
        """Return True if *host* matches any allowlist entry (supports globs)."""
        if not host:
            return False
        lowered = host.lower()
        return any(fnmatch.fnmatchcase(lowered, pattern) for pattern in self._effective)

    def validate_outbound_url(self, url: str) -> None:
        """Raise :class:`ExfilGuardViolationError` if *url*'s host is not allowed.

        Logs every decision with structured fields so an SIEM can audit
        every outbound call the platform made.
        """
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if not host:
            _logger.error(
                "exfil_guard.blocked",
                reason="missing_host",
                url=url,
                cloud_env=self._config.cloud_env.value,
            )
            raise ExfilGuardViolationError(url=url, host="", cloud_env=self._config.cloud_env)

        if not self.is_host_allowed(host):
            _logger.error(
                "exfil_guard.blocked",
                **{"guard.blocked_host": host},
                url=url,
                cloud_env=self._config.cloud_env.value,
                allowlist_size=len(self._effective),
            )
            raise ExfilGuardViolationError(
                url=url,
                host=host,
                cloud_env=self._config.cloud_env,
            )

        _logger.info(
            "exfil_guard.allowed",
            **{"guard.allowed_host": host},
            url=url,
            cloud_env=self._config.cloud_env.value,
        )

    # ------------------------------------------------------------------
    # Composition helpers
    # ------------------------------------------------------------------

    async def httpx_request_hook(self, request: Any) -> None:
        """httpx AsyncClient ``event_hooks={"request": [...]}`` compatible hook.

        ``httpx.Request`` has ``.url`` attribute; we defensively str() it
        so the hook works with any request-like object.
        """
        url = str(getattr(request, "url", ""))
        self.validate_outbound_url(url)


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------


F = TypeVar("F", bound=Callable[..., Awaitable[Any]])


def guard_outbound(
    guard: ExfilGuard | None = None,
    *,
    url_kwarg: str = "url",
) -> Callable[[F], F]:
    """Decorator — enforce :class:`ExfilGuard` on an async function's URL kwarg.

    The wrapped function MUST accept the URL via keyword argument (default
    name ``url``).  Positional URLs are not supported because the guard must
    know which argument to inspect without introspection gymnastics.

    Args:
        guard: A preconfigured guard.  When ``None``, the decorator lazily
            builds one from env on first call (so import order doesn't matter).
        url_kwarg: Name of the URL keyword argument on the wrapped function.
    """

    def decorator(fn: F) -> F:
        @wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            active = guard if guard is not None else build_default_guard()
            url = kwargs.get(url_kwarg)
            if not isinstance(url, str):
                raise ExfilGuardViolationError(
                    url=str(url),
                    host="",
                    cloud_env=active.cloud_env,
                )
            active.validate_outbound_url(url)
            return await fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def build_default_guard() -> ExfilGuard:
    """Build an :class:`ExfilGuard` using detected cloud + env-provided extras."""
    return ExfilGuard(ExfilGuardConfig.from_env())
