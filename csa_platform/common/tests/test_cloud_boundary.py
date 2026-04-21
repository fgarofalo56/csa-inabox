"""Tests for :mod:`csa_platform.common.cloud_boundary`."""

from __future__ import annotations

import pytest

from csa_platform.common import cloud_boundary
from csa_platform.common.cloud_boundary import (
    CloudBoundaryUnknownError,
    CloudEnvironment,
    detect_cloud_environment,
    is_government_cloud,
    resolve_aad_authority,
    resolve_arm_endpoint,
    resolve_blob_endpoint_suffix,
    resolve_dfs_endpoint_suffix,
    resolve_endpoints,
    resolve_openai_endpoint_suffix,
    resolve_sql_endpoint_suffix,
)


@pytest.fixture(autouse=True)
def _clear_env_and_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test starts with no relevant env vars and a cleared cache."""
    for var in ("AZURE_ENVIRONMENT", "IS_GOVERNMENT_CLOUD", "ARM_ENDPOINT"):
        monkeypatch.delenv(var, raising=False)
    cloud_boundary._reset_cache()


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("AzureCloud", CloudEnvironment.COMMERCIAL),
        ("AzureUSGovernment", CloudEnvironment.US_GOV),
        ("AzureUSGovernmentHigh", CloudEnvironment.US_GOV_HIGH),
        ("AzureGermanCloud", CloudEnvironment.GERMANY),
        ("AzureChinaCloud", CloudEnvironment.CHINA),
        ("commercial", CloudEnvironment.COMMERCIAL),
        ("usgov", CloudEnvironment.US_GOV),
        ("us_gov_high", CloudEnvironment.US_GOV_HIGH),
        ("  USGOV  ", CloudEnvironment.US_GOV),  # whitespace + case
    ],
)
def test_detect_from_azure_environment(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
    expected: CloudEnvironment,
) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", value)
    assert detect_cloud_environment(force_refresh=True) is expected


def test_detect_from_is_government_cloud_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "true")
    assert detect_cloud_environment(force_refresh=True) is CloudEnvironment.US_GOV


def test_detect_from_arm_endpoint_commercial(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARM_ENDPOINT", "https://management.azure.com")
    assert detect_cloud_environment(force_refresh=True) is CloudEnvironment.COMMERCIAL


def test_detect_from_arm_endpoint_usgov(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARM_ENDPOINT", "https://management.usgovcloudapi.net")
    assert detect_cloud_environment(force_refresh=True) is CloudEnvironment.US_GOV


def test_detect_from_arm_endpoint_china(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARM_ENDPOINT", "https://management.chinacloudapi.cn")
    assert detect_cloud_environment(force_refresh=True) is CloudEnvironment.CHINA


def test_detect_fallback_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    # No env vars, and IMDS will fail in test environment
    def _no_imds(timeout_s: float = 1.0) -> None:
        return None

    monkeypatch.setattr(cloud_boundary, "_probe_imds", _no_imds)
    assert detect_cloud_environment(force_refresh=True) is CloudEnvironment.UNKNOWN


def test_detect_from_imds(monkeypatch: pytest.MonkeyPatch) -> None:
    def _gov_imds(timeout_s: float = 1.0) -> CloudEnvironment:
        return CloudEnvironment.US_GOV

    monkeypatch.setattr(cloud_boundary, "_probe_imds", _gov_imds)
    assert detect_cloud_environment(force_refresh=True) is CloudEnvironment.US_GOV


def test_detection_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "commercial")
    first = detect_cloud_environment(force_refresh=True)
    # Change env after first call — cached value should persist
    monkeypatch.setenv("AZURE_ENVIRONMENT", "usgov")
    second = detect_cloud_environment()
    assert first is second is CloudEnvironment.COMMERCIAL


def test_detection_force_refresh_bypasses_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "commercial")
    detect_cloud_environment(force_refresh=True)
    monkeypatch.setenv("AZURE_ENVIRONMENT", "usgov")
    assert detect_cloud_environment(force_refresh=True) is CloudEnvironment.US_GOV


def test_azure_environment_precedes_arm_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "commercial")
    monkeypatch.setenv("ARM_ENDPOINT", "https://management.usgovcloudapi.net")
    assert detect_cloud_environment(force_refresh=True) is CloudEnvironment.COMMERCIAL


# ---------------------------------------------------------------------------
# is_government_cloud
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        (CloudEnvironment.COMMERCIAL, False),
        (CloudEnvironment.US_GOV, True),
        (CloudEnvironment.US_GOV_HIGH, True),
        (CloudEnvironment.GERMANY, False),
        (CloudEnvironment.CHINA, False),
        (CloudEnvironment.UNKNOWN, False),
    ],
)
def test_is_government_cloud(env: CloudEnvironment, expected: bool) -> None:
    assert is_government_cloud(env) is expected


def test_is_government_cloud_uses_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "usgov")
    assert is_government_cloud() is True


# ---------------------------------------------------------------------------
# Endpoint resolvers
# ---------------------------------------------------------------------------


def test_resolve_aad_authority_per_environment() -> None:
    assert resolve_aad_authority(CloudEnvironment.COMMERCIAL) == "https://login.microsoftonline.com"
    assert resolve_aad_authority(CloudEnvironment.US_GOV) == "https://login.microsoftonline.us"
    assert resolve_aad_authority(CloudEnvironment.US_GOV_HIGH) == "https://login.microsoftonline.us"
    assert resolve_aad_authority(CloudEnvironment.GERMANY) == "https://login.microsoftonline.de"
    assert resolve_aad_authority(CloudEnvironment.CHINA) == "https://login.chinacloudapi.cn"


def test_resolve_aad_authority_unknown_falls_back_to_commercial() -> None:
    # Unknown cloud gets a warning log but returns commercial so callers
    # don't explode on non-Azure hosts.
    assert resolve_aad_authority(CloudEnvironment.UNKNOWN) == "https://login.microsoftonline.com"


def test_resolve_arm_endpoint() -> None:
    assert resolve_arm_endpoint(CloudEnvironment.COMMERCIAL) == "https://management.azure.com"
    assert resolve_arm_endpoint(CloudEnvironment.US_GOV) == "https://management.usgovcloudapi.net"
    assert resolve_arm_endpoint(CloudEnvironment.CHINA) == "https://management.chinacloudapi.cn"


def test_resolve_blob_and_dfs_and_sql_suffixes() -> None:
    assert resolve_blob_endpoint_suffix(CloudEnvironment.COMMERCIAL) == "blob.core.windows.net"
    assert resolve_blob_endpoint_suffix(CloudEnvironment.US_GOV) == "blob.core.usgovcloudapi.net"
    assert resolve_dfs_endpoint_suffix(CloudEnvironment.COMMERCIAL) == "dfs.core.windows.net"
    assert resolve_sql_endpoint_suffix(CloudEnvironment.GERMANY) == "database.cloudapi.de"


def test_resolve_openai_endpoint_suffix() -> None:
    assert resolve_openai_endpoint_suffix(CloudEnvironment.COMMERCIAL) == "openai.azure.com"
    assert resolve_openai_endpoint_suffix(CloudEnvironment.US_GOV) == "openai.azure.us"
    assert resolve_openai_endpoint_suffix(CloudEnvironment.US_GOV_HIGH) == "openai.azure.us"


def test_resolve_endpoints_returns_frozen_dataclass() -> None:
    import dataclasses

    endpoints = resolve_endpoints(CloudEnvironment.US_GOV)
    assert endpoints.environment is CloudEnvironment.US_GOV
    with pytest.raises(dataclasses.FrozenInstanceError):
        endpoints.aad_authority = "https://attacker.example.com"  # type: ignore[misc]


def test_unknown_cloud_raises_for_hard_endpoints() -> None:
    with pytest.raises(CloudBoundaryUnknownError):
        resolve_arm_endpoint(CloudEnvironment.UNKNOWN)
    with pytest.raises(CloudBoundaryUnknownError):
        resolve_blob_endpoint_suffix(CloudEnvironment.UNKNOWN)


def test_resolver_default_uses_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_ENVIRONMENT", "usgov")
    assert resolve_blob_endpoint_suffix() == "blob.core.usgovcloudapi.net"
