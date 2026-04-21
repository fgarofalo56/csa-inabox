"""CSA-0090 — Azure cloud boundary detection and endpoint resolution.

Platform-wide helper for determining which Azure cloud the current process
is running against (Commercial, US Gov, US Gov High, Germany, China), and
for resolving the correct Entra authority / ARM endpoint / storage DNS
suffixes for that environment.

The detection strategy is intentionally ordered:

    1. Explicit environment variable ``AZURE_ENVIRONMENT`` (matches the
       Azure CLI ``cloud set --name`` values — ``AzureCloud``,
       ``AzureUSGovernment``, ``AzureGermanCloud``, ``AzureChinaCloud``).
       We also accept the short aliases ``commercial``, ``usgov``,
       ``usgov_high``, ``germany``, ``china``.
    2. Back-compat: the existing ``IS_GOVERNMENT_CLOUD`` flag used by
       :mod:`csa_platform.common.azure_clients` and
       :mod:`csa_platform.config`.
    3. ``ARM_ENDPOINT`` inspection — matches the ARM hostname against
       per-cloud suffixes.
    4. Azure Instance Metadata Service (IMDS) — lazy ``httpx`` call with a
       1-second timeout.  Only used on Azure-hosted workloads; the IMDS
       address is not routable outside Azure.
    5. Fall back to :attr:`CloudEnvironment.UNKNOWN` — callers should
       treat this as "assume Commercial but warn" when choosing an
       authority; endpoint helpers raise because an unknown cloud cannot
       produce a correct hostname.

The detection result is cached at module scope so the IMDS probe runs at
most once per process.  Tests can override this via :func:`_reset_cache`.

This module has **no hard dependencies** beyond the stdlib — ``httpx`` is
imported lazily inside :func:`_probe_imds` and missing-dep failures
degrade to :attr:`CloudEnvironment.UNKNOWN`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from typing import Final

from csa_platform.common.logging import get_logger

__all__ = [
    "CloudBoundaryError",
    "CloudBoundaryUnknownError",
    "CloudEndpoints",
    "CloudEnvironment",
    "detect_cloud_environment",
    "is_government_cloud",
    "resolve_aad_authority",
    "resolve_arm_endpoint",
    "resolve_blob_endpoint_suffix",
    "resolve_dfs_endpoint_suffix",
    "resolve_endpoints",
    "resolve_openai_endpoint_suffix",
    "resolve_sql_endpoint_suffix",
]

_logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Enum
# ---------------------------------------------------------------------------


class CloudEnvironment(str, Enum):
    """Canonical Azure cloud identifiers understood by the platform."""

    COMMERCIAL = "commercial"
    US_GOV = "usgov"
    US_GOV_HIGH = "usgov_high"
    GERMANY = "germany"
    CHINA = "china"
    UNKNOWN = "unknown"


# ---------------------------------------------------------------------------
# Endpoint tables (frozen dataclass)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CloudEndpoints:
    """Resolved endpoint suffixes and authority for a :class:`CloudEnvironment`."""

    environment: CloudEnvironment
    aad_authority: str
    arm_endpoint: str
    blob_suffix: str
    dfs_suffix: str
    sql_suffix: str
    openai_suffix: str


# Keep a single canonical table so the individual resolve_* helpers and the
# exfil guard default allowlist both agree on hostnames.
_ENDPOINTS: Final[dict[CloudEnvironment, CloudEndpoints]] = {
    CloudEnvironment.COMMERCIAL: CloudEndpoints(
        environment=CloudEnvironment.COMMERCIAL,
        aad_authority="https://login.microsoftonline.com",
        arm_endpoint="https://management.azure.com",
        blob_suffix="blob.core.windows.net",
        dfs_suffix="dfs.core.windows.net",
        sql_suffix="database.windows.net",
        openai_suffix="openai.azure.com",
    ),
    CloudEnvironment.US_GOV: CloudEndpoints(
        environment=CloudEnvironment.US_GOV,
        aad_authority="https://login.microsoftonline.us",
        arm_endpoint="https://management.usgovcloudapi.net",
        blob_suffix="blob.core.usgovcloudapi.net",
        dfs_suffix="dfs.core.usgovcloudapi.net",
        sql_suffix="database.usgovcloudapi.net",
        openai_suffix="openai.azure.us",
    ),
    # US Gov High shares the same DNS suffixes as US Gov but uses the
    # dedicated Entra authority for DoD / IL5-IL6 workloads.
    CloudEnvironment.US_GOV_HIGH: CloudEndpoints(
        environment=CloudEnvironment.US_GOV_HIGH,
        aad_authority="https://login.microsoftonline.us",
        arm_endpoint="https://management.usgovcloudapi.net",
        blob_suffix="blob.core.usgovcloudapi.net",
        dfs_suffix="dfs.core.usgovcloudapi.net",
        sql_suffix="database.usgovcloudapi.net",
        openai_suffix="openai.azure.us",
    ),
    CloudEnvironment.GERMANY: CloudEndpoints(
        environment=CloudEnvironment.GERMANY,
        aad_authority="https://login.microsoftonline.de",
        arm_endpoint="https://management.microsoftazure.de",
        blob_suffix="blob.core.cloudapi.de",
        dfs_suffix="dfs.core.cloudapi.de",
        sql_suffix="database.cloudapi.de",
        openai_suffix="openai.azure.de",
    ),
    CloudEnvironment.CHINA: CloudEndpoints(
        environment=CloudEnvironment.CHINA,
        aad_authority="https://login.chinacloudapi.cn",
        arm_endpoint="https://management.chinacloudapi.cn",
        blob_suffix="blob.core.chinacloudapi.cn",
        dfs_suffix="dfs.core.chinacloudapi.cn",
        sql_suffix="database.chinacloudapi.cn",
        openai_suffix="openai.azure.cn",
    ),
}


# Alias table mapping user-facing strings to the canonical enum.
_ALIASES: Final[dict[str, CloudEnvironment]] = {
    # Azure CLI ``cloud set`` names
    "azurecloud": CloudEnvironment.COMMERCIAL,
    "azureusgovernment": CloudEnvironment.US_GOV,
    "azureusgovernmenthigh": CloudEnvironment.US_GOV_HIGH,
    "azuregermancloud": CloudEnvironment.GERMANY,
    "azurechinacloud": CloudEnvironment.CHINA,
    # Short aliases
    "commercial": CloudEnvironment.COMMERCIAL,
    "public": CloudEnvironment.COMMERCIAL,
    "usgov": CloudEnvironment.US_GOV,
    "us_gov": CloudEnvironment.US_GOV,
    "gov": CloudEnvironment.US_GOV,
    "usgov_high": CloudEnvironment.US_GOV_HIGH,
    "usgovhigh": CloudEnvironment.US_GOV_HIGH,
    "us_gov_high": CloudEnvironment.US_GOV_HIGH,
    "germany": CloudEnvironment.GERMANY,
    "china": CloudEnvironment.CHINA,
    "unknown": CloudEnvironment.UNKNOWN,
}


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


# Module-level cache — the detection call hits env vars and possibly IMDS,
# so we memoise the first successful resolution.  Tests call _reset_cache().
_CACHED_ENV: CloudEnvironment | None = None


def _reset_cache() -> None:
    """Test helper — clear the memoised detection result."""
    global _CACHED_ENV
    _CACHED_ENV = None


def _from_alias(value: str | None) -> CloudEnvironment | None:
    if not value:
        return None
    return _ALIASES.get(value.strip().lower())


def _from_arm_endpoint(arm: str | None) -> CloudEnvironment | None:
    if not arm:
        return None
    host = arm.lower()
    if "usgovcloudapi.net" in host:
        return CloudEnvironment.US_GOV
    if "microsoftazure.de" in host:
        return CloudEnvironment.GERMANY
    if "chinacloudapi.cn" in host:
        return CloudEnvironment.CHINA
    if "management.azure.com" in host:
        return CloudEnvironment.COMMERCIAL
    return None


def _probe_imds(timeout_s: float = 1.0) -> CloudEnvironment | None:
    """Ask the Azure Instance Metadata Service which cloud we are in.

    Returns ``None`` on any failure (httpx missing, network error, non-Azure
    host, unexpected payload).  The IMDS IP ``169.254.169.254`` is not
    routable outside Azure, so in CI / dev this call fails fast.
    """
    try:
        import httpx
    except ImportError:
        return None

    url = "http://169.254.169.254/metadata/instance?api-version=2021-02-01"
    headers = {"Metadata": "true"}
    try:
        response = httpx.get(url, headers=headers, timeout=timeout_s)
    except Exception:
        return None

    if response.status_code != 200:
        return None
    try:
        payload = response.json()
    except ValueError:
        return None

    az_env = (
        payload.get("compute", {}).get("azEnvironment")
        if isinstance(payload, dict)
        else None
    )
    return _from_alias(az_env)


def detect_cloud_environment(*, force_refresh: bool = False) -> CloudEnvironment:
    """Detect the current Azure cloud environment.

    Detection order:

        1. ``AZURE_ENVIRONMENT`` env var (accepts Azure CLI names and
           short aliases).
        2. Back-compat ``IS_GOVERNMENT_CLOUD`` → US_GOV when truthy.
        3. ``ARM_ENDPOINT`` env var — hostname-matched against each cloud.
        4. Azure Instance Metadata Service (``169.254.169.254``).
        5. :attr:`CloudEnvironment.UNKNOWN`.

    The first successful step wins.  The result is cached at module scope
    for the lifetime of the process so the IMDS probe only happens once.

    Args:
        force_refresh: If True, bypass the module-level cache.  Primarily
            for tests that need to re-run detection under different env.

    Returns:
        The resolved :class:`CloudEnvironment`.
    """
    global _CACHED_ENV
    if _CACHED_ENV is not None and not force_refresh:
        return _CACHED_ENV

    # 1. AZURE_ENVIRONMENT
    env = _from_alias(os.environ.get("AZURE_ENVIRONMENT"))
    if env is not None and env is not CloudEnvironment.UNKNOWN:
        _logger.info(
            "cloud_boundary.detected",
            source="AZURE_ENVIRONMENT",
            cloud_env=env.value,
        )
        _CACHED_ENV = env
        return env

    # 2. Back-compat IS_GOVERNMENT_CLOUD
    gov_flag = os.environ.get("IS_GOVERNMENT_CLOUD", "").strip().lower()
    if gov_flag in ("true", "1", "yes"):
        _logger.info(
            "cloud_boundary.detected",
            source="IS_GOVERNMENT_CLOUD",
            cloud_env=CloudEnvironment.US_GOV.value,
        )
        _CACHED_ENV = CloudEnvironment.US_GOV
        return CloudEnvironment.US_GOV

    # 3. ARM_ENDPOINT
    env = _from_arm_endpoint(os.environ.get("ARM_ENDPOINT"))
    if env is not None:
        _logger.info(
            "cloud_boundary.detected",
            source="ARM_ENDPOINT",
            cloud_env=env.value,
        )
        _CACHED_ENV = env
        return env

    # 4. IMDS
    env = _probe_imds()
    if env is not None and env is not CloudEnvironment.UNKNOWN:
        _logger.info(
            "cloud_boundary.detected",
            source="IMDS",
            cloud_env=env.value,
        )
        _CACHED_ENV = env
        return env

    # 5. Fallback
    _logger.warning(
        "cloud_boundary.detected",
        source="fallback",
        cloud_env=CloudEnvironment.UNKNOWN.value,
    )
    _CACHED_ENV = CloudEnvironment.UNKNOWN
    return CloudEnvironment.UNKNOWN


def is_government_cloud(env: CloudEnvironment | None = None) -> bool:
    """Return True if *env* (or the detected env) is a US-Gov cloud.

    Germany and China are **not** considered "government cloud" here —
    they have their own regulatory regimes and callers should branch on
    them explicitly.
    """
    resolved = env if env is not None else detect_cloud_environment()
    return resolved in (CloudEnvironment.US_GOV, CloudEnvironment.US_GOV_HIGH)


# ---------------------------------------------------------------------------
# Endpoint resolvers
# ---------------------------------------------------------------------------


def _require_known(env: CloudEnvironment) -> CloudEndpoints:
    if env is CloudEnvironment.UNKNOWN:
        raise CloudBoundaryUnknownError(
            "Cannot resolve endpoint suffix for CloudEnvironment.UNKNOWN — "
            "set AZURE_ENVIRONMENT or IS_GOVERNMENT_CLOUD explicitly.",
        )
    return _ENDPOINTS[env]


def resolve_endpoints(env: CloudEnvironment | None = None) -> CloudEndpoints:
    """Return the full :class:`CloudEndpoints` record for *env*."""
    return _require_known(env if env is not None else detect_cloud_environment())


def resolve_aad_authority(env: CloudEnvironment | None = None) -> str:
    """Return the Entra ID authority URL for *env* (or the detected env).

    Unknown environments default to the Commercial authority with a
    warning log — this matches the MSAL / azure-identity default and
    keeps non-Azure workloads running, while making the fallback visible.
    """
    resolved = env if env is not None else detect_cloud_environment()
    if resolved is CloudEnvironment.UNKNOWN:
        _logger.warning(
            "cloud_boundary.authority.fallback",
            cloud_env=resolved.value,
            authority=_ENDPOINTS[CloudEnvironment.COMMERCIAL].aad_authority,
        )
        return _ENDPOINTS[CloudEnvironment.COMMERCIAL].aad_authority
    return _ENDPOINTS[resolved].aad_authority


def resolve_arm_endpoint(env: CloudEnvironment | None = None) -> str:
    """Return the ARM endpoint URL for *env*."""
    return _require_known(env if env is not None else detect_cloud_environment()).arm_endpoint


def resolve_blob_endpoint_suffix(env: CloudEnvironment | None = None) -> str:
    """Return the Blob storage DNS suffix for *env*."""
    return _require_known(env if env is not None else detect_cloud_environment()).blob_suffix


def resolve_dfs_endpoint_suffix(env: CloudEnvironment | None = None) -> str:
    """Return the ADLS Gen2 (DFS) DNS suffix for *env*."""
    return _require_known(env if env is not None else detect_cloud_environment()).dfs_suffix


def resolve_sql_endpoint_suffix(env: CloudEnvironment | None = None) -> str:
    """Return the Azure SQL DNS suffix for *env*."""
    return _require_known(env if env is not None else detect_cloud_environment()).sql_suffix


def resolve_openai_endpoint_suffix(env: CloudEnvironment | None = None) -> str:
    """Return the Azure OpenAI DNS suffix for *env*."""
    return _require_known(env if env is not None else detect_cloud_environment()).openai_suffix


# ---------------------------------------------------------------------------
# Typed errors
# ---------------------------------------------------------------------------


class CloudBoundaryError(Exception):
    """Base class for :mod:`cloud_boundary` errors."""


class CloudBoundaryUnknownError(CloudBoundaryError):
    """Raised when an endpoint resolver is called with UNKNOWN cloud."""
