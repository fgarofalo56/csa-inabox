"""
Tests for :class:`TokenBroker` — CSA-0020 Phase 3.

The broker wraps MSAL's ``ConfidentialClientApplication`` so these
tests substitute a fake MSAL app (mirroring the one in
``test_auth_bff.py``) via ``monkeypatch`` on
``TokenBroker._build_app_for_session``. No real network is exercised.

Coverage:

* Silent-cache hit → ``cache_hit=True``; refresh is not invoked.
* Silent miss → refresh-token fallback → ``cache_hit=False``.
* Refresh exhausted (no refresh token on session OR refresh returns
  error dict) → :class:`TokenRefreshRequiredError` surfaces as HTTP 401
  with body ``{"error": "reauth_required", ...}``.
* ``acquisition_ms`` is populated.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from portal.shared.api.config import Settings
from portal.shared.api.models.auth_bff import SessionState
from portal.shared.api.services import token_broker as tb
from portal.shared.api.services.token_cache import InMemoryTokenCacheBackend


# ── Fakes ──────────────────────────────────────────────────────────────────


class FakeMsal:
    """Stand-in for the MSAL confidential client the broker builds."""

    def __init__(
        self,
        *,
        silent_result: dict[str, Any] | None,
        refresh_result: dict[str, Any] | Exception | None,
    ) -> None:
        self.silent_result = silent_result
        self.refresh_result = refresh_result
        self.silent_calls: list[dict[str, Any]] = []
        self.refresh_calls: list[dict[str, Any]] = []

    def get_accounts(self, username: str | None = None) -> list[dict[str, Any]]:
        return []

    def acquire_token_silent(
        self, *, scopes: list[str], account: Any | None,
    ) -> dict[str, Any] | None:
        self.silent_calls.append({"scopes": scopes, "account": account})
        return self.silent_result

    def acquire_token_by_refresh_token(
        self, *, refresh_token: str, scopes: list[str],
    ) -> dict[str, Any]:
        self.refresh_calls.append(
            {"refresh_token": refresh_token, "scopes": scopes},
        )
        if isinstance(self.refresh_result, Exception):
            raise self.refresh_result
        assert self.refresh_result is not None
        return self.refresh_result


def _settings() -> Settings:
    return Settings(
        AUTH_MODE="bff",
        BFF_TENANT_ID="t",
        BFF_CLIENT_ID="c",
        BFF_CLIENT_SECRET="s",
        BFF_SESSION_SIGNING_KEY="x" * 64,
        BFF_TOKEN_CACHE_BACKEND="memory",
        BFF_TOKEN_CACHE_HMAC_KEY="k" * 64,
    )


def _session(refresh_token: str | None = "rt-test") -> SessionState:
    now = datetime.now(timezone.utc)
    return SessionState(
        session_id="sess-broker",
        oid="oid-1",
        tid="t",
        name="Test",
        email="t@example.com",
        roles=[],
        access_token="at-0",
        refresh_token=refresh_token,
        id_token=None,
        expires_at=now,
        issued_at=now,
        last_seen_at=now,
    )


def _make_broker(fake_msal: FakeMsal) -> tb.TokenBroker:
    broker = tb.TokenBroker(
        settings=_settings(), backend=InMemoryTokenCacheBackend(),
    )
    # Override the per-session MSAL build so we return the fake every call.
    broker._build_app_for_session = lambda *, cache: fake_msal  # type: ignore[method-assign]
    return broker


# ── Tests ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_silent_hit_returns_cache_hit_true() -> None:
    fake = FakeMsal(
        silent_result={
            "access_token": "cached-at",
            "expires_in": 3600,
        },
        refresh_result=None,
    )
    broker = _make_broker(fake)
    token = await broker.acquire_token(_session(), scope="api://test/.default")
    assert token.cache_hit is True
    assert token.access_token == "cached-at"
    assert token.token_type == "Bearer"
    assert token.acquisition_ms >= 0
    assert fake.silent_calls and not fake.refresh_calls


@pytest.mark.asyncio
async def test_silent_miss_falls_back_to_refresh_token() -> None:
    fake = FakeMsal(
        silent_result=None,
        refresh_result={
            "access_token": "refreshed-at",
            "expires_in": 1800,
        },
    )
    broker = _make_broker(fake)
    token = await broker.acquire_token(_session(), scope=["api://test/.default"])
    assert token.cache_hit is False
    assert token.access_token == "refreshed-at"
    assert fake.refresh_calls == [
        {"refresh_token": "rt-test", "scopes": ["api://test/.default"]},
    ]


@pytest.mark.asyncio
async def test_no_refresh_token_triggers_reauth_required() -> None:
    fake = FakeMsal(silent_result=None, refresh_result=None)
    broker = _make_broker(fake)
    with pytest.raises(tb.TokenRefreshRequiredError) as excinfo:
        await broker.acquire_token(
            _session(refresh_token=None), scope="api://test/.default",
        )
    body = excinfo.value.detail
    assert body["error"] == "reauth_required"
    assert body["reauth_url"] == "/auth/login"
    assert body["reason"] == "no_refresh_token_on_session"
    assert excinfo.value.status_code == 401
    assert not fake.refresh_calls  # never reached


@pytest.mark.asyncio
async def test_refresh_error_dict_triggers_reauth_required() -> None:
    fake = FakeMsal(
        silent_result=None,
        refresh_result={
            "error": "invalid_grant",
            "error_description": "refresh token expired",
        },
    )
    broker = _make_broker(fake)
    with pytest.raises(tb.TokenRefreshRequiredError) as excinfo:
        await broker.acquire_token(_session(), scope="api://test/.default")
    body = excinfo.value.detail
    assert body["error"] == "reauth_required"
    assert "refresh_failed" in body["reason"]


@pytest.mark.asyncio
async def test_acquisition_ms_is_populated_and_positive() -> None:
    fake = FakeMsal(
        silent_result={"access_token": "at-speedy", "expires_in": 3600},
        refresh_result=None,
    )
    broker = _make_broker(fake)
    token = await broker.acquire_token(_session(), scope="api://x/.default")
    assert token.acquisition_ms >= 0.0


@pytest.mark.asyncio
async def test_scope_as_list_passes_through_to_msal() -> None:
    fake = FakeMsal(
        silent_result={"access_token": "at", "expires_in": 3600},
        refresh_result=None,
    )
    broker = _make_broker(fake)
    await broker.acquire_token(
        _session(), scope=["api://a/.default", "api://b/.default"],
    )
    assert fake.silent_calls[0]["scopes"] == [
        "api://a/.default", "api://b/.default",
    ]
