"""Safety-gate tests for csa_platform.common.auth.

Covers the CRITICAL findings remediated in this audit cycle:

* CSA-0001 / SEC-NEW-0001 — empty ``AZURE_TENANT_ID`` no longer silently
  disables auth in non-local environments.
* CSA-0018 / SEC-NEW-0005, SEC-NEW-0006 — JWT validation requires
  ``exp``/``nbf``/``iss``/``aud``/``sub``, accepts ``api://<client-id>``
  as audience, pins ``tid``.
* CSA-0019 / SEC-NEW-0002 — ``DEMO_MODE``/``AUTH_DISABLED`` are only
  honoured when ``ENVIRONMENT`` is in the ``{"local", "demo"}`` allow-list.

Tests manipulate ``os.environ`` directly and reset it via
``monkeypatch`` so they don't leak state between cases.
"""

from __future__ import annotations

import pytest
from csa_platform.common import auth as auth_module

# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────


def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reset every auth-relevant env var so each test starts clean."""
    for key in (
        "ENVIRONMENT",
        "AUTH_DISABLED",
        "DEMO_MODE",
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "IS_GOVERNMENT_CLOUD",
    ):
        monkeypatch.delenv(key, raising=False)


# ─────────────────────────────────────────────────────────────────────────
# CSA-0001 — empty tenant must fail closed outside local/demo
# ─────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "environment",
    ["dev", "qa", "uat", "test", "preprod", "staging", "production"],
)
def test_empty_tenant_fails_closed_in_non_local_environment(
    monkeypatch: pytest.MonkeyPatch, environment: str
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", environment)

    with pytest.raises(RuntimeError, match="AZURE_TENANT_ID is empty"):
        auth_module.enforce_auth_safety_gate()


def test_empty_tenant_ok_in_local(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "local")
    # Must not raise.
    auth_module.enforce_auth_safety_gate()


def test_empty_tenant_ok_in_demo(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "demo")
    auth_module.enforce_auth_safety_gate()


def test_empty_tenant_default_environment_is_local(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ENVIRONMENT unset defaults to 'local' (config.py) — gate passes."""
    _clear_env(monkeypatch)
    auth_module.enforce_auth_safety_gate()


def test_auth_disabled_no_longer_triggered_by_empty_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """_auth_disabled must ignore tenant — empty tenant is no longer a
    silent auth-off signal."""
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "local")
    assert auth_module._auth_disabled() is False


# ─────────────────────────────────────────────────────────────────────────
# CSA-0019 — DEMO_MODE / AUTH_DISABLED allow-list is strict
# ─────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "environment",
    ["dev", "qa", "uat", "test", "preprod", "staging", "production"],
)
def test_demo_mode_refused_outside_allow_list(
    monkeypatch: pytest.MonkeyPatch, environment: str
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("AZURE_TENANT_ID", "00000000-0000-0000-0000-000000000000")
    monkeypatch.setenv("DEMO_MODE", "true")

    with pytest.raises(RuntimeError, match="DEMO_MODE=true"):
        auth_module.enforce_auth_safety_gate()


@pytest.mark.parametrize(
    "environment",
    ["dev", "qa", "uat", "test", "preprod", "staging", "production"],
)
def test_auth_disabled_refused_outside_allow_list(
    monkeypatch: pytest.MonkeyPatch, environment: str
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("AZURE_TENANT_ID", "00000000-0000-0000-0000-000000000000")
    monkeypatch.setenv("AUTH_DISABLED", "true")

    with pytest.raises(RuntimeError, match="AUTH_DISABLED=true"):
        auth_module.enforce_auth_safety_gate()


@pytest.mark.parametrize("environment", ["local", "demo"])
def test_demo_mode_honoured_in_allow_list(
    monkeypatch: pytest.MonkeyPatch, environment: str
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("DEMO_MODE", "true")
    auth_module.enforce_auth_safety_gate()


@pytest.mark.parametrize("environment", ["local", "demo"])
def test_is_local_or_demo_recognises_allow_list(
    monkeypatch: pytest.MonkeyPatch, environment: str
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", environment)
    assert auth_module._is_local_or_demo() is True


@pytest.mark.parametrize(
    "environment",
    ["dev", "qa", "uat", "test", "preprod", "staging", "production"],
)
def test_is_local_or_demo_rejects_non_allow_list(
    monkeypatch: pytest.MonkeyPatch, environment: str
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", environment)
    assert auth_module._is_local_or_demo() is False


# ─────────────────────────────────────────────────────────────────────────
# CSA-0018 — JWT validation hardening
# ─────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_validate_token_rejects_wrong_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Token with a tid claim that differs from AZURE_TENANT_ID is rejected.

    The jwt.decode path is mocked because we're not testing PyJWT itself —
    just the post-decode tenant-pinning guard.
    """
    from fastapi import HTTPException

    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv(
        "AZURE_TENANT_ID", "00000000-0000-0000-0000-000000000001"
    )
    monkeypatch.setenv(
        "AZURE_CLIENT_ID", "00000000-0000-0000-0000-000000000002"
    )

    # Bypass JWKS + decode — return claims with a bad tid.
    class _FakeJWKSKey:
        key = "fake-key"

    class _FakeJWKSClient:
        def get_signing_key_from_jwt(self, _token: str) -> _FakeJWKSKey:
            return _FakeJWKSKey()

    monkeypatch.setattr(
        auth_module, "_get_jwks_client", lambda: _FakeJWKSClient()
    )

    def _fake_decode(*_a: object, **_kw: object) -> dict[str, str]:
        return {
            "sub": "user-id",
            "tid": "99999999-9999-9999-9999-999999999999",  # wrong tenant
        }

    monkeypatch.setattr(auth_module.jwt, "decode", _fake_decode)

    with pytest.raises(HTTPException) as exc_info:
        await auth_module._validate_token("dummy-token")
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_validate_token_accepts_matching_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv(
        "AZURE_TENANT_ID", "00000000-0000-0000-0000-000000000001"
    )
    monkeypatch.setenv(
        "AZURE_CLIENT_ID", "00000000-0000-0000-0000-000000000002"
    )

    class _FakeJWKSKey:
        key = "fake-key"

    class _FakeJWKSClient:
        def get_signing_key_from_jwt(self, _token: str) -> _FakeJWKSKey:
            return _FakeJWKSKey()

    monkeypatch.setattr(
        auth_module, "_get_jwks_client", lambda: _FakeJWKSClient()
    )

    expected_claims = {
        "sub": "user-id",
        "tid": "00000000-0000-0000-0000-000000000001",
        "roles": ["Reader"],
    }

    def _fake_decode(*_a: object, **_kw: object) -> dict[str, object]:
        return expected_claims

    monkeypatch.setattr(auth_module.jwt, "decode", _fake_decode)

    claims = await auth_module._validate_token("dummy-token")
    assert claims == expected_claims


@pytest.mark.asyncio
async def test_demo_mode_returns_synthetic_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_DISABLED", "true")

    claims = await auth_module._validate_token("")
    assert claims["roles"] == ["Reader"]
    assert claims["sub"] == "demo-user-id"
