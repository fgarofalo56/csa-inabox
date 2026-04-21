"""Tests for :mod:`csa_platform.common.exfil_guard`."""

from __future__ import annotations

import pytest

from csa_platform.common import cloud_boundary
from csa_platform.common.cloud_boundary import CloudEnvironment
from csa_platform.common.exfil_guard import (
    ExfilGuard,
    ExfilGuardConfig,
    ExfilGuardViolationError,
    build_default_guard,
    guard_outbound,
)


@pytest.fixture(autouse=True)
def _reset_cloud_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in (
        "AZURE_ENVIRONMENT",
        "IS_GOVERNMENT_CLOUD",
        "ARM_ENDPOINT",
        "CSA_EXFIL_ALLOWLIST_EXTRA_HOSTS",
    ):
        monkeypatch.delenv(var, raising=False)
    cloud_boundary._reset_cache()


# ---------------------------------------------------------------------------
# Commercial allowlist
# ---------------------------------------------------------------------------


def test_commercial_allows_expected_hosts() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.COMMERCIAL))
    guard.validate_outbound_url("https://mystorage.blob.core.windows.net/container/blob")
    guard.validate_outbound_url("https://foo.openai.azure.com/v1/chat/completions")
    guard.validate_outbound_url("https://login.microsoftonline.com/common/oauth2/token")


def test_commercial_blocks_external_host() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.COMMERCIAL))
    with pytest.raises(ExfilGuardViolationError) as excinfo:
        guard.validate_outbound_url("https://attacker.example.com/steal")
    assert excinfo.value.host == "attacker.example.com"
    assert excinfo.value.cloud_env is CloudEnvironment.COMMERCIAL


def test_commercial_blocks_gov_host() -> None:
    """A Commercial guard MUST reject gov hosts — mixed-cloud is a data-residency leak."""
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.COMMERCIAL))
    # Commercial allowlist doesn't include any *.usgovcloudapi.net pattern.
    # Note: *.azure.com wildcard COULD match azure.us if we had overlapping
    # patterns — we explicitly verify the gov-specific TLD is blocked.
    with pytest.raises(ExfilGuardViolationError):
        guard.validate_outbound_url("https://x.blob.core.usgovcloudapi.net/data")


# ---------------------------------------------------------------------------
# Gov allowlist
# ---------------------------------------------------------------------------


def test_gov_blocks_commercial_host() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.US_GOV))
    with pytest.raises(ExfilGuardViolationError) as excinfo:
        guard.validate_outbound_url("https://mystorage.blob.core.windows.net/container/blob")
    assert excinfo.value.cloud_env is CloudEnvironment.US_GOV
    assert "blob.core.windows.net" in excinfo.value.host


def test_gov_allows_gov_hosts() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.US_GOV))
    guard.validate_outbound_url("https://foo.blob.core.usgovcloudapi.net/container/blob")
    guard.validate_outbound_url("https://foo.openai.azure.us/v1/chat")
    guard.validate_outbound_url("https://login.microsoftonline.us/common/oauth2/token")


def test_gov_high_is_tighter_than_gov() -> None:
    """Gov-High drops the generic *.azure.us wildcard."""
    gov = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.US_GOV))
    gov_high = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.US_GOV_HIGH))

    # A random *.azure.us host should be allowed on Gov but blocked on Gov-High
    hypothetical = "https://marketing.azure.us/campaign"
    gov.validate_outbound_url(hypothetical)
    with pytest.raises(ExfilGuardViolationError):
        gov_high.validate_outbound_url(hypothetical)


# ---------------------------------------------------------------------------
# Extra hosts via env
# ---------------------------------------------------------------------------


def test_extra_hosts_loaded_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "commercial")
    monkeypatch.setenv(
        "CSA_EXFIL_ALLOWLIST_EXTRA_HOSTS",
        "partner.example.com, *.internal.corp",
    )
    cloud_boundary._reset_cache()
    config = ExfilGuardConfig.from_env()
    assert "partner.example.com" in config.extra_hosts
    assert "*.internal.corp" in config.extra_hosts

    guard = ExfilGuard(config)
    guard.validate_outbound_url("https://partner.example.com/api")
    guard.validate_outbound_url("https://app.internal.corp/v1")
    with pytest.raises(ExfilGuardViolationError):
        guard.validate_outbound_url("https://other.example.com/api")


def test_extra_hosts_empty_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "commercial")
    cloud_boundary._reset_cache()
    config = ExfilGuardConfig.from_env()
    assert config.extra_hosts == ()


def test_effective_allowlist_deduplicates() -> None:
    config = ExfilGuardConfig.for_environment(
        CloudEnvironment.COMMERCIAL,
        extra_hosts=["*.azure.com", "partner.example.com"],
    )
    effective = config.effective_allowlist
    # *.azure.com should only appear once
    assert effective.count("*.azure.com") == 1
    assert "partner.example.com" in effective


# ---------------------------------------------------------------------------
# Missing/invalid hosts
# ---------------------------------------------------------------------------


def test_missing_host_blocked() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.COMMERCIAL))
    with pytest.raises(ExfilGuardViolationError):
        guard.validate_outbound_url("not-a-url")


def test_unknown_cloud_blocks_everything() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.UNKNOWN))
    with pytest.raises(ExfilGuardViolationError):
        guard.validate_outbound_url("https://management.azure.com")


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_guard_outbound_decorator_allows() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.COMMERCIAL))

    @guard_outbound(guard)
    async def fetch(*, url: str) -> str:
        return f"fetched:{url}"

    result = await fetch(url="https://x.blob.core.windows.net/container/data")
    assert result.startswith("fetched:")


@pytest.mark.asyncio
async def test_guard_outbound_decorator_blocks() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.US_GOV))

    @guard_outbound(guard)
    async def fetch(*, url: str) -> str:
        return f"fetched:{url}"

    with pytest.raises(ExfilGuardViolationError):
        await fetch(url="https://evil.example.com/steal")


@pytest.mark.asyncio
async def test_guard_outbound_decorator_lazy_default_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "commercial")
    cloud_boundary._reset_cache()

    @guard_outbound()  # No explicit guard — built lazily from env
    async def fetch(*, url: str) -> str:
        return url

    out = await fetch(url="https://management.azure.com/subscriptions")
    assert out == "https://management.azure.com/subscriptions"


@pytest.mark.asyncio
async def test_guard_outbound_rejects_non_string_url() -> None:
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.COMMERCIAL))

    @guard_outbound(guard)
    async def fetch(*, url: str) -> str:
        return url

    with pytest.raises(ExfilGuardViolationError):
        await fetch(url=None)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# httpx hook composition
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_httpx_request_hook_shape() -> None:
    """Hook is callable with an object that has a ``.url`` attribute."""
    guard = ExfilGuard(ExfilGuardConfig.for_environment(CloudEnvironment.COMMERCIAL))

    class FakeRequest:
        url = "https://foo.openai.azure.com/v1/chat"

    await guard.httpx_request_hook(FakeRequest())

    class EvilRequest:
        url = "https://attacker.example.com/steal"

    with pytest.raises(ExfilGuardViolationError):
        await guard.httpx_request_hook(EvilRequest())


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def test_build_default_guard_uses_detected_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "usgov")
    cloud_boundary._reset_cache()
    guard = build_default_guard()
    assert guard.cloud_env is CloudEnvironment.US_GOV
