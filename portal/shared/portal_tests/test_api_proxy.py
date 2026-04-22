"""
Tests for the BFF reverse-proxy router — CSA-0020 Phase 3.

Covers the contract the SPA depends on:

* 401 without ``csa_sid`` / tampered / expired cookie.
* 200 happy path with session + mocked MSAL + mocked upstream.
* Authorization header is injected with the MSAL bearer token.
* Streaming body bytes pass through unchanged.
* Upstream status codes are preserved (4xx/5xx all pass through except
  502/503/504 which trigger retry then 504 on exhaustion).
* Upstream ``Set-Cookie`` is stripped from the response.
* Hop-by-hop headers are filtered out of the forwarded request.
* Upstream timeout → 504.
* ``bff.proxy.request`` log event carries session_id_hash, method, path,
  upstream_status, upstream_ms, cache_hit.

All upstream calls go through a custom ``httpx.MockTransport`` — no
real network is reached.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport
from portal.shared.api.config import Settings
from portal.shared.api.models.auth_bff import AcquiredToken, SessionState
from portal.shared.api.routers import api_proxy, auth_bff
from portal.shared.api.services.session_store import InMemorySessionStore
from portal.shared.api.services.token_broker import TokenRefreshRequiredError

pytestmark = pytest.mark.asyncio


# ── Fakes ──────────────────────────────────────────────────────────────────


class FakeBroker:
    """Records calls, returns a configurable :class:`AcquiredToken` or
    raises :class:`TokenRefreshRequiredError`."""

    def __init__(
        self,
        *,
        token: AcquiredToken | None = None,
        error: TokenRefreshRequiredError | None = None,
    ) -> None:
        self.token = token
        self.error = error
        self.calls: list[tuple[SessionState, str | list[str]]] = []

    async def acquire_token(
        self, session: SessionState, scope: str | list[str],
    ) -> AcquiredToken:
        self.calls.append((session, scope))
        if self.error is not None:
            raise self.error
        assert self.token is not None
        return self.token


def _proxy_settings(**overrides: Any) -> Settings:
    base = {
        "AUTH_MODE": "bff",
        "BFF_PROXY_ENABLED": True,
        "BFF_TENANT_ID": "t",
        "BFF_CLIENT_ID": "c",
        "BFF_CLIENT_SECRET": "s",
        "BFF_REDIRECT_URI": "http://testserver/auth/callback",
        "BFF_SESSION_SIGNING_KEY": "x" * 64,
        "BFF_COOKIE_SECURE": False,
        "BFF_SESSION_TTL_SECONDS": 3600,
        "BFF_UPSTREAM_API_ORIGIN": "http://upstream.test",
        "BFF_UPSTREAM_API_SCOPE": "api://test/.default",
        "BFF_UPSTREAM_API_TIMEOUT_SECONDS": 5,
        "BFF_TOKEN_CACHE_BACKEND": "memory",
        "BFF_TOKEN_CACHE_HMAC_KEY": "k" * 64,
    }
    base.update(overrides)
    return Settings(**base)


def _make_session() -> SessionState:
    now = datetime.now(timezone.utc)
    return SessionState(
        session_id="sess-proxy-1",
        oid="oid-1",
        tid="t",
        name="Test",
        email="t@example.com",
        roles=[],
        access_token="at-0",
        refresh_token="rt-0",
        id_token=None,
        expires_at=now + timedelta(hours=1),
        issued_at=now,
        last_seen_at=now,
    )


def _fake_token(cache_hit: bool = True) -> AcquiredToken:
    return AcquiredToken(
        access_token="bearer-test-token",
        token_type="Bearer",
        expires_on=datetime.now(timezone.utc) + timedelta(minutes=30),
        cache_hit=cache_hit,
        acquisition_ms=1.25,
    )


# ── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def upstream_handler() -> dict[str, Any]:
    """Mutable box the tests fill with an upstream handler function.

    The handler receives an ``httpx.Request`` and returns an
    ``httpx.Response``. Keeping this mutable lets each test swap the
    upstream behaviour without rebuilding the app fixture.
    """
    return {"handler": None, "observed_requests": []}


@pytest.fixture
def proxy_app(upstream_handler: dict[str, Any]) -> FastAPI:
    store = InMemorySessionStore()
    auth_bff.reset_session_store_singleton()

    settings = _proxy_settings()
    broker = FakeBroker(token=_fake_token())

    # Custom transport so every upstream call is captured without
    # touching the network.
    def _transport_handler(request: httpx.Request) -> httpx.Response:
        upstream_handler["observed_requests"].append(request)
        handler = upstream_handler["handler"]
        assert handler is not None, "tests must configure upstream_handler['handler']"
        return handler(request)

    transport = httpx.MockTransport(_transport_handler)
    client = httpx.AsyncClient(transport=transport, timeout=5)

    api_proxy._resources.configure(client=client, broker=broker)  # type: ignore[arg-type]

    app = FastAPI()
    app.include_router(auth_bff.router)
    app.include_router(api_proxy.router)
    app.dependency_overrides[auth_bff.get_settings] = lambda: settings
    app.dependency_overrides[auth_bff.get_session_store] = lambda: store
    app.state.fake_broker = broker
    app.state.session_store = store
    app.state.settings = settings
    return app


@pytest_asyncio.fixture()
async def proxy_client(proxy_app: FastAPI):
    transport = ASGITransport(app=proxy_app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver", follow_redirects=False,
    ) as client:
        yield client


async def _seed_session(app: FastAPI, client: httpx.AsyncClient) -> None:
    """Place a valid session in the store + set the signed cookie on the client."""
    from itsdangerous import URLSafeTimedSerializer

    settings: Settings = app.state.settings
    store: InMemorySessionStore = app.state.session_store

    session = _make_session()
    await store.set(session, ttl_seconds=settings.BFF_SESSION_TTL_SECONDS)

    serializer = URLSafeTimedSerializer(
        settings.BFF_SESSION_SIGNING_KEY, salt="csa-bff-session-v1",
    )
    signed = serializer.dumps(session.session_id)
    client.cookies.set(settings.BFF_COOKIE_NAME, signed)


# ── 401 paths ──────────────────────────────────────────────────────────────


async def test_proxy_without_cookie_returns_401_reauth_required(
    proxy_client: httpx.AsyncClient,
) -> None:
    resp = await proxy_client.get("/api/health")
    assert resp.status_code == 401
    body = resp.json()["detail"] if "detail" in resp.json() else resp.json()
    assert body["error"] == "reauth_required"
    assert body["reauth_url"] == "/auth/login"


async def test_proxy_with_invalid_cookie_returns_401(
    proxy_client: httpx.AsyncClient,
) -> None:
    proxy_client.cookies.set("csa_sid", "not.a.valid.signed.cookie.value")
    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 401


async def test_proxy_with_expired_session_returns_401(
    proxy_app: FastAPI, proxy_client: httpx.AsyncClient,
) -> None:
    await _seed_session(proxy_app, proxy_client)
    # Purge server-side session so the cookie resolves to nothing.
    await proxy_app.state.session_store.delete("sess-proxy-1")
    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 401


async def test_proxy_surfaces_reauth_required_from_broker(
    proxy_app: FastAPI, proxy_client: httpx.AsyncClient, upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)
    proxy_app.state.fake_broker.error = TokenRefreshRequiredError(
        reauth_url="/auth/login", reason="refresh_failed: invalid_grant",
    )
    # Upstream should never be called.
    upstream_handler["handler"] = lambda req: pytest.fail("upstream reached")

    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 401
    body = resp.json()
    # The detail envelope comes from FastAPI's default HTTPException rendering.
    detail = body.get("detail", body)
    assert detail["error"] == "reauth_required"
    assert detail["reason"].startswith("refresh_failed")


# ── Happy path ─────────────────────────────────────────────────────────────


async def test_proxy_happy_path_forwards_with_bearer_and_preserves_body(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)

    def _ok(request: httpx.Request) -> httpx.Response:
        # Verify the forwarded request shape.
        assert request.method == "GET"
        assert request.url.path == "/api/v1/sources"
        assert request.headers["authorization"] == "Bearer bearer-test-token"
        # cookie header was scrubbed
        assert "cookie" not in {k.lower() for k in request.headers.keys()}
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            content=b'{"items":[1,2,3]}',
        )

    upstream_handler["handler"] = _ok

    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 200
    assert resp.content == b'{"items":[1,2,3]}'
    assert resp.headers["content-type"].startswith("application/json")
    assert len(proxy_app.state.fake_broker.calls) == 1


async def test_proxy_strips_upstream_set_cookie(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)

    def _with_cookie(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers=[
                ("content-type", "text/plain"),
                ("set-cookie", "upstream_session=evil; Path=/"),
            ],
            content=b"ok",
        )

    upstream_handler["handler"] = _with_cookie
    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 200
    # Set-Cookie must not pass through to the SPA — BFF owns cookies.
    assert "set-cookie" not in {k.lower() for k in resp.headers.keys()}


async def test_proxy_forwards_non_retryable_5xx_as_is(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)

    def _err(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"boom", headers={"content-type": "text/plain"})

    upstream_handler["handler"] = _err
    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 500
    assert resp.content == b"boom"


async def test_proxy_forwards_4xx_as_is(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)

    def _forbidden(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, content=b'{"error":"nope"}',
                              headers={"content-type": "application/json"})

    upstream_handler["handler"] = _forbidden
    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 403


async def test_proxy_forwards_post_body_and_preserves_content_type(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)
    captured: dict[str, Any] = {}

    def _echo(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content
        captured["ctype"] = request.headers.get("content-type")
        return httpx.Response(201, content=b'{"ok":true}',
                              headers={"content-type": "application/json"})

    upstream_handler["handler"] = _echo

    resp = await proxy_client.post(
        "/api/v1/sources",
        content=b'{"name":"new-src"}',
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 201
    assert captured["body"] == b'{"name":"new-src"}'
    assert captured["ctype"] == "application/json"


# ── Retry / timeout paths ──────────────────────────────────────────────────


async def test_proxy_retries_503_and_ultimately_returns_504(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)

    call_count = {"n": 0}

    def _always_503(_req: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(503, content=b"down")

    upstream_handler["handler"] = _always_503

    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 504
    assert call_count["n"] == 3  # tenacity: 3 attempts


async def test_proxy_retries_502_then_succeeds(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)

    calls = {"n": 0}

    def _flaky(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 2:
            return httpx.Response(502, content=b"bad gateway")
        return httpx.Response(200, content=b"recovered",
                              headers={"content-type": "text/plain"})

    upstream_handler["handler"] = _flaky

    resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 200
    assert resp.content == b"recovered"
    assert calls["n"] == 2


async def test_proxy_timeout_returns_504(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    await _seed_session(proxy_app, proxy_client)

    def _raise_timeout(_req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("simulated upstream timeout")

    upstream_handler["handler"] = _raise_timeout

    resp = await proxy_client.get("/api/v1/sources")
    # httpx.TransportError subclasses are retried via tenacity; after 3
    # attempts the handler raises UpstreamUnavailableError → 504.
    assert resp.status_code == 504


# ── Logging ────────────────────────────────────────────────────────────────


async def test_proxy_emits_structured_request_log(
    proxy_app: FastAPI,
    proxy_client: httpx.AsyncClient,
    upstream_handler: dict[str, Any],
) -> None:
    """``bff.proxy.request`` structlog event carries the expected fields."""
    import structlog.testing

    await _seed_session(proxy_app, proxy_client)

    def _ok(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"{}",
                              headers={"content-type": "application/json"})

    upstream_handler["handler"] = _ok

    # ``structlog.testing.capture_logs`` intercepts the processor chain
    # before it hits stdlib logging, which is the portable way to assert
    # on structlog events in tests.
    with structlog.testing.capture_logs() as events:
        resp = await proxy_client.get("/api/v1/sources")
    assert resp.status_code == 200
    proxy_events = [e for e in events if e.get("event") == "bff.proxy.request"]
    assert proxy_events, f"expected bff.proxy.request in {events!r}"
    evt = proxy_events[0]
    assert evt["method"] == "GET"
    assert evt["path"] == "v1/sources"
    assert evt["upstream_status"] == 200
    assert evt["cache_hit"] is True
    assert "session_id_hash" in evt
    assert "upstream_ms" in evt


# ── Resources lifecycle ────────────────────────────────────────────────────


async def test_proxy_resources_aclose_is_idempotent() -> None:
    r = api_proxy.ProxyResources()
    # Never configured → aclose is a no-op.
    await r.aclose()
    await r.aclose()


async def test_proxy_resources_closes_httpx_client() -> None:
    r = api_proxy.ProxyResources()

    class _StubBroker:
        async def acquire_token(
            self, session: SessionState, scope: Any,
        ) -> AcquiredToken:  # pragma: no cover
            raise AssertionError("not called")

    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: httpx.Response(200)))
    r.configure(client=client, broker=_StubBroker())  # type: ignore[arg-type]
    await r.aclose()
    # Second close is idempotent.
    await r.aclose()
    assert r.client is None
