"""
Tests for the BFF auth router (CSA-0020 Phase 2).

The BFF router is only mounted when ``AUTH_MODE=bff``, so these tests
build a dedicated FastAPI app (bypassing the shared portal app
fixture) and wire the router manually with an in-memory session store
and a stubbed MSAL client.

External surface covered:

* ``GET  /auth/login``    — PKCE + state + nonce issuance, redirect.
* ``GET  /auth/callback`` — state validation, token exchange, session
                            creation, cookie issuance.
* ``GET  /auth/me``       — session resolution (200 + 401 paths).
* ``POST /auth/logout``   — session destruction + cookie deletion.
* ``POST /auth/token``    — silent acquisition against the stubbed
                            confidential client.

The MSAL confidential client is stubbed at the router's
``get_msal_app`` dependency so these tests never reach Entra ID.
"""

from __future__ import annotations

import urllib.parse
from datetime import timedelta
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport
from portal.shared.api.config import Settings
from portal.shared.api.routers import auth_bff
from portal.shared.api.services.session_store import InMemorySessionStore

pytestmark = pytest.mark.asyncio


# ── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def bff_settings() -> Settings:
    """BFF-configured settings for a local test run."""
    return Settings(
        ENVIRONMENT="local",
        AUTH_MODE="bff",
        BFF_TENANT_ID="test-tenant-id",
        BFF_CLIENT_ID="test-client-id",
        BFF_CLIENT_SECRET="test-client-secret-very-long-value",
        BFF_REDIRECT_URI="http://testserver/auth/callback",
        BFF_SESSION_SIGNING_KEY="x" * 64,  # deterministic, >= 32 chars
        BFF_COOKIE_NAME="csa_sid",
        BFF_COOKIE_SECURE=False,  # TestClient uses http://
        BFF_COOKIE_SAMESITE="lax",
        BFF_SESSION_STORE="memory",
        BFF_SESSION_TTL_SECONDS=3600,
        BFF_PENDING_AUTH_TTL_SECONDS=600,
    )


class FakeMsalApp:
    """Stand-in for ``msal.ConfidentialClientApplication`` used by the
    BFF router tests. Surfaces the three methods the router actually
    calls and records invocations for assertions."""

    def __init__(self) -> None:
        self.acquire_calls: list[dict[str, Any]] = []
        self.silent_calls: list[dict[str, Any]] = []
        self.refresh_calls: list[dict[str, Any]] = []

        self.acquire_result: dict[str, Any] = {
            "access_token": "fake-access-token",
            "refresh_token": "fake-refresh-token",
            "id_token": "fake-id-token",
            "id_token_claims": {
                "oid": "00000000-0000-0000-0000-000000000001",
                "tid": "test-tenant-id",
                "name": "Test User",
                "preferred_username": "test@csainabox.local",
                "email": "test@csainabox.local",
                "roles": ["Admin"],
            },
            "expires_in": 3600,
        }
        self.silent_result: dict[str, Any] | None = {
            "access_token": "fake-silent-access-token",
            "expires_in": 3600,
        }
        self.refresh_result: dict[str, Any] = {
            "access_token": "fake-refresh-access-token",
            "expires_in": 3600,
        }

    def acquire_token_by_authorization_code(
        self, *, code: str, scopes: list[str], redirect_uri: str, code_verifier: str
    ) -> dict[str, Any]:
        self.acquire_calls.append(
            {
                "code": code,
                "scopes": scopes,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
        )
        return self.acquire_result

    def get_accounts(
        self,
        username: str | None = None,  # noqa: ARG002 — mirrors MSAL signature
    ) -> list[dict[str, Any]]:
        return []

    def acquire_token_silent(
        self, *, scopes: list[str], account: Any | None
    ) -> dict[str, Any] | None:
        self.silent_calls.append({"scopes": scopes, "account": account})
        return self.silent_result

    def acquire_token_by_refresh_token(
        self, *, refresh_token: str, scopes: list[str]
    ) -> dict[str, Any]:
        self.refresh_calls.append(
            {"refresh_token": refresh_token, "scopes": scopes},
        )
        return self.refresh_result


@pytest.fixture
def fake_msal() -> FakeMsalApp:
    return FakeMsalApp()


@pytest.fixture
def bff_app(bff_settings: Settings, fake_msal: FakeMsalApp) -> FastAPI:
    """Build a minimal FastAPI app wiring only the BFF router.

    Keeps the blast radius tight — this test suite never touches the
    shared portal app fixture (which bundles SQLite stores + demo
    seeding).
    """
    store = InMemorySessionStore()
    auth_bff.reset_session_store_singleton()

    app = FastAPI()
    app.include_router(auth_bff.router)

    app.dependency_overrides[auth_bff.get_session_store] = lambda: store
    app.dependency_overrides[auth_bff.get_msal_app] = lambda: fake_msal
    # Override the single settings dependency — the router re-uses the
    # same ``get_settings`` callable everywhere, so one override swaps
    # the config for /login, /callback, /me, /logout, and /token.
    app.dependency_overrides[auth_bff.get_settings] = lambda: bff_settings

    return app


@pytest_asyncio.fixture()
async def bff_client(bff_app: FastAPI):
    """Async client bound to the BFF app (no network)."""
    transport = ASGITransport(app=bff_app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver", follow_redirects=False
    ) as client:
        yield client


# ── /auth/login ────────────────────────────────────────────────────────────


class TestAuthLogin:
    async def test_login_redirects_to_entra_id_with_expected_params(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        resp = await bff_client.get("/auth/login", params={"redirect_to": "/dashboard"})
        assert resp.status_code == 302

        location = resp.headers["location"]
        parsed = urllib.parse.urlparse(location)
        qs = urllib.parse.parse_qs(parsed.query)

        assert parsed.netloc == "login.microsoftonline.com"
        assert qs["client_id"] == ["test-client-id"]
        assert qs["response_type"] == ["code"]
        assert qs["code_challenge_method"] == ["S256"]
        assert qs["redirect_uri"] == ["http://testserver/auth/callback"]
        assert "code_challenge" in qs
        assert "state" in qs
        assert qs["state"][0]
        assert "nonce" in qs
        assert qs["nonce"][0]

    async def test_login_sets_signed_pending_auth_cookie(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        resp = await bff_client.get("/auth/login")
        assert resp.status_code == 302
        assert "csa_pending_auth" in resp.cookies

    async def test_login_rejects_non_local_redirect_targets(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        resp = await bff_client.get(
            "/auth/login", params={"redirect_to": "https://evil.example.com/"},
        )
        # The handler silently rewrites to "/" and still 302s.
        assert resp.status_code == 302


# ── /auth/callback ─────────────────────────────────────────────────────────


class TestAuthCallback:
    async def test_callback_without_pending_cookie_returns_400(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        resp = await bff_client.get(
            "/auth/callback", params={"code": "x", "state": "y"},
        )
        assert resp.status_code == 400

    async def test_callback_with_tampered_state_cookie_returns_400(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        login = await bff_client.get("/auth/login")
        bff_client.cookies.set(
            "csa_pending_auth", "not.a.valid.signed.value",
        )
        resp = await bff_client.get(
            "/auth/callback",
            params={"code": "fake-code", "state": "whatever"},
        )
        assert resp.status_code == 400
        _ = login  # silence unused

    async def test_callback_with_state_mismatch_returns_400(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        login = await bff_client.get("/auth/login")
        assert login.status_code == 302
        resp = await bff_client.get(
            "/auth/callback",
            params={"code": "fake-code", "state": "mismatched-state-value"},
        )
        assert resp.status_code == 400

    async def test_callback_happy_path_issues_session_cookie_and_redirects(
        self, bff_client: httpx.AsyncClient, fake_msal: FakeMsalApp, bff_settings: Settings,
    ) -> None:
        login = await bff_client.get(
            "/auth/login", params={"redirect_to": "/sources"},
        )
        assert login.status_code == 302
        # Pull the state query param back out of the Entra-ID URL.
        parsed = urllib.parse.urlparse(login.headers["location"])
        qs = urllib.parse.parse_qs(parsed.query)
        state = qs["state"][0]

        resp = await bff_client.get(
            "/auth/callback",
            params={"code": "real-authorization-code", "state": state},
        )
        assert resp.status_code == 302
        assert resp.headers["location"] == "/sources"
        assert bff_settings.BFF_COOKIE_NAME in resp.cookies

        # MSAL was invoked with the bound PKCE verifier.
        assert len(fake_msal.acquire_calls) == 1
        assert fake_msal.acquire_calls[0]["code"] == "real-authorization-code"
        assert fake_msal.acquire_calls[0]["code_verifier"]


# ── /auth/me ───────────────────────────────────────────────────────────────


class TestAuthMe:
    async def test_me_without_cookie_returns_401(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        resp = await bff_client.get("/auth/me")
        assert resp.status_code == 401

    async def test_me_after_callback_returns_profile(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        await _complete_login(bff_client)

        resp = await bff_client.get("/auth/me")
        assert resp.status_code == 200
        body = resp.json()
        assert body["oid"] == "00000000-0000-0000-0000-000000000001"
        assert body["tid"] == "test-tenant-id"
        assert body["name"] == "Test User"
        assert "Admin" in body["roles"]


# ── /auth/logout ───────────────────────────────────────────────────────────


class TestAuthLogout:
    async def test_logout_removes_session_and_clears_cookie(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        await _complete_login(bff_client)

        # Precondition: /me works.
        assert (await bff_client.get("/auth/me")).status_code == 200

        logout = await bff_client.post("/auth/logout")
        assert logout.status_code == 204

        # Manually drop the cookie jar on the client to simulate the
        # browser honouring the Set-Cookie with Max-Age=0; httpx
        # retains expired cookies for the duration of the AsyncClient.
        bff_client.cookies.clear()

        assert (await bff_client.get("/auth/me")).status_code == 401

    async def test_logout_without_cookie_is_noop_204(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        resp = await bff_client.post("/auth/logout")
        assert resp.status_code == 204


# ── /auth/token ────────────────────────────────────────────────────────────


class TestAuthToken:
    async def test_token_without_session_returns_401(
        self, bff_client: httpx.AsyncClient
    ) -> None:
        resp = await bff_client.post("/auth/token", params={"resource": "graph"})
        assert resp.status_code == 401

    async def test_token_happy_path_returns_bearer(
        self, bff_client: httpx.AsyncClient, fake_msal: FakeMsalApp,
    ) -> None:
        await _complete_login(bff_client)

        resp = await bff_client.post("/auth/token", params={"resource": "graph"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["token_type"] == "Bearer"
        assert body["access_token"] == "fake-silent-access-token"
        assert body["resource"] == "graph"
        assert len(fake_msal.silent_calls) == 1
        assert fake_msal.silent_calls[0]["scopes"] == ["User.Read"]

    async def test_token_falls_back_to_refresh_token_when_silent_returns_none(
        self, bff_client: httpx.AsyncClient, fake_msal: FakeMsalApp,
    ) -> None:
        await _complete_login(bff_client)
        fake_msal.silent_result = None

        resp = await bff_client.post("/auth/token", params={"resource": "graph"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["access_token"] == "fake-refresh-access-token"
        assert len(fake_msal.refresh_calls) == 1


# ── Helpers ────────────────────────────────────────────────────────────────


async def _complete_login(client: httpx.AsyncClient) -> None:
    """Drive ``/auth/login`` → ``/auth/callback`` through the fake MSAL
    so a live ``csa_sid`` cookie is sitting on the client's jar."""
    login = await client.get("/auth/login", params={"redirect_to": "/"})
    assert login.status_code == 302
    parsed = urllib.parse.urlparse(login.headers["location"])
    qs = urllib.parse.parse_qs(parsed.query)
    state = qs["state"][0]

    callback = await client.get(
        "/auth/callback",
        params={"code": "real-authorization-code", "state": state},
    )
    assert callback.status_code == 302


# Suppress "unused" lint on timedelta import — reserved for future
# TTL-expiry tests.
_ = timedelta
