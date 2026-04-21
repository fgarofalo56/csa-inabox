"""
CSA-in-a-Box: Data Onboarding Portal — Shared Backend (main entry point).

This is the FastAPI application that powers **all three** portal front-end
implementations (React, PowerApps, Kubernetes).  It provides
a unified ``/api/v1/`` surface for:

* **Sources**      — data source registration & lifecycle management
* **Pipelines**    — ADF pipeline viewing & triggering
* **Marketplace**  — data product discovery, quality metrics
* **Access**       — self-service access request workflow
* **Stats**        — platform & domain-level dashboards
* **Health**       — liveness / readiness probes

Run locally::

    uvicorn portal.shared.api.main:app --reload --port 8000
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from csa_platform.governance.common.logging import configure_structlog, get_logger

from .config import settings
from .routers import access, marketplace, pipelines, sources, stats
from .routers.stats import domains_router
from .services.auth import get_current_user

# ── Logging ──────────────────────────────────────────────────────────────────

configure_structlog(service="csa-portal-api", level=settings.LOG_LEVEL)
logger = get_logger("csainabox.api")

# ── Security Headers Middleware ──────────────────────────────────────────────


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security-related HTTP headers to every response."""

    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[override]
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = (
            "camera=(), microphone=(), geolocation=()"
        )
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https:; "
            "connect-src 'self' https://login.microsoftonline.com https://login.microsoftonline.us; "
            "frame-ancestors 'none'"
        )
        if request.url.scheme == "https":
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )
        return response


# ── Auth Safety Gate ────────────────────────────────────────────────────────
# The import of `get_current_user` above triggers the safety gate in
# portal.shared.api.services.auth (which delegates to
# csa_platform.common.auth.enforce_auth_safety_gate).  No duplicate
# check is needed here.


# ── Lifespan ─────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: startup and shutdown hooks."""
    logger.info(
        "Starting CSA-in-a-Box API  (gov=%s, debug=%s)",
        settings.IS_GOVERNMENT_CLOUD,
        settings.DEBUG,
    )
    # Initialize data directory for SQLite persistence when SQLite is
    # the selected backend (default when DATABASE_URL is empty).  When
    # DATABASE_URL targets Postgres the factory picks PostgresStore and
    # schema is applied via ``alembic upgrade head`` — see
    # ``portal/shared/api/alembic/`` and ``persistence_factory.py``.
    from pathlib import Path

    _db_url = (settings.DATABASE_URL or "").strip()
    if not _db_url or _db_url.startswith("sqlite:"):
        data_dir = Path(settings.DATA_DIR)
        data_dir.mkdir(parents=True, exist_ok=True)
        logger.info("SQLite persistence data directory: %s", data_dir)
    else:
        logger.info("Using external persistence backend (DATABASE_URL=%s)", _db_url.split("@")[-1])

    # OPS-0012: Validate critical configuration before accepting traffic.
    # In production/staging environments, missing Azure settings cause a hard
    # failure at startup rather than silent misbehaviour at request time.
    env = settings.ENVIRONMENT.lower()
    if env in ("production", "staging"):
        missing = []
        if not settings.AZURE_TENANT_ID:
            missing.append("AZURE_TENANT_ID")
        if not settings.STORAGE_ACCOUNT_NAME:
            missing.append("STORAGE_ACCOUNT_NAME")
        if missing:
            raise RuntimeError(
                f"Missing required config for {settings.ENVIRONMENT}: {', '.join(missing)}"
            )
    else:
        # Warn in local/dev so engineers notice un-configured Azure settings
        # without blocking the startup.
        if not settings.AZURE_TENANT_ID:
            logger.warning("AZURE_TENANT_ID is not set (env=%s)", settings.ENVIRONMENT)
        if not settings.STORAGE_ACCOUNT_NAME:
            logger.warning("STORAGE_ACCOUNT_NAME is not set (env=%s)", settings.ENVIRONMENT)

    # Seed demo data only in local/demo environments (STATE-0002).
    # Production/staging deployments start with empty stores.
    if env in ("local", "demo") or settings.DEMO_MODE:
        await sources.seed_demo_sources()
        await pipelines.seed_demo_pipelines()
        await access.seed_demo_requests()
        await marketplace.seed_demo_products()
        logger.info("Demo data seeding complete (env=%s, demo_mode=%s)", env, settings.DEMO_MODE)
    else:
        logger.info("Skipping demo data seeding (env=%s)", env)

    # CSA-0020 Phase 3 — initialise the BFF reverse-proxy resources (ADR-0019).
    # The router is mounted below at module-import time when the feature
    # flag is on; the httpx client + token broker are created here so
    # shutdown can close them deterministically under the same lifespan.
    if settings.AUTH_MODE.lower() == "bff" and settings.BFF_PROXY_ENABLED:
        import httpx as _httpx

        from .routers import api_proxy
        from .services.token_broker import TokenBroker
        from .services.token_cache import build_token_cache_backend

        _tc_backend = build_token_cache_backend(settings)
        _proxy_client = _httpx.AsyncClient(
            timeout=settings.BFF_UPSTREAM_API_TIMEOUT_SECONDS,
            follow_redirects=False,
        )
        _broker = TokenBroker(settings=settings, backend=_tc_backend)
        api_proxy.get_proxy_resources().configure(
            client=_proxy_client, broker=_broker,
        )
        logger.info(
            "BFF reverse-proxy resources initialised (upstream=%s, cache=%s)",
            settings.BFF_UPSTREAM_API_ORIGIN,
            settings.BFF_TOKEN_CACHE_BACKEND,
        )

    # Audit routes for missing auth dependencies (SEC-0010)
    for route in _app.routes:
        if hasattr(route, "dependant") and hasattr(route, "path"):
            deps = [
                d.dependency
                for d in route.dependant.dependencies
                if hasattr(d, "dependency")
            ]
            has_auth = any(
                d in (get_current_user,)
                or (hasattr(d, "__wrapped__") and d.__wrapped__ in (get_current_user,))
                for d in deps
            )
            if not has_auth and route.path.startswith("/api/v1/"):
                logger.warning(
                    "Route %s %s has no auth dependency",
                    route.methods,
                    route.path,
                )

    yield

    # ── Shutdown ────────────────────────────────────────────────────────
    # Close every async store (flip per-instance init flags) and dispose
    # of the shared async SQLAlchemy engine + managed-identity credentials.
    # See ADR-0016.
    logger.info("Shutting down CSA-in-a-Box API — draining async stores")
    # Close BFF proxy resources first (httpx client) so in-flight proxy
    # requests see a clean cancellation rather than a half-closed engine.
    if settings.AUTH_MODE.lower() == "bff" and settings.BFF_PROXY_ENABLED:
        try:
            from .routers import api_proxy

            await api_proxy.get_proxy_resources().aclose()
            logger.info("BFF reverse-proxy httpx client closed")
        except Exception as exc:
            logger.warning("BFF proxy shutdown error: %s", exc)
    try:
        from .dependencies import all_stores
        from .persistence_async import close_async_engines

        for store in all_stores():
            try:
                await store.close()
            except Exception as exc:
                logger.warning("Async store close error: %s", exc)
        await close_async_engines()
    except Exception as exc:
        logger.warning("Async store shutdown error: %s", exc)
    logger.info("Shutting down CSA-in-a-Box API")


# ── Application ──────────────────────────────────────────────────────────────

_is_production = settings.ENVIRONMENT.lower() == "production"

app = FastAPI(
    title=settings.APP_TITLE,
    description=(
        "Self-service data source registration, pipeline generation, "
        "and data marketplace API for the Cloud Scale Analytics (Fabric-in-a-Box) platform."
    ),
    version=settings.APP_VERSION,
    lifespan=lifespan,
    docs_url=None if _is_production else "/api/docs",
    redoc_url=None if _is_production else "/api/redoc",
    openapi_url=None if _is_production else "/api/openapi.json",
)

# ── Security Headers ────────────────────────────────────────────────────────
# Added before CORS so security headers are set on every response.

app.add_middleware(SecurityHeadersMiddleware)

# ── CORS ─────────────────────────────────────────────────────────────────────

# Reject wildcard patterns at startup — they match any Azure-hosted app
# and allow credentialed cross-origin requests from attacker-controlled
# origins.  Set CORS_ORIGINS to explicit hostnames in production.
_rejected = [o for o in settings.CORS_ORIGINS if "*" in o]
if _rejected and settings.ENVIRONMENT.lower() not in {"local", "dev"}:
    raise RuntimeError(
        f"CORS_ORIGINS contains wildcard patterns: {_rejected!r}.  "
        "Wildcards with allow_credentials=True let any Azure-hosted app "
        "make credentialed requests.  Use explicit hostnames."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# ── Exception Handlers (CSA-0029) ────────────────────────────────────────────
# Every uncaught exception becomes a structured JSON 500 with a
# correlation id. Stack traces are NEVER surfaced to callers — they are
# logged with correlation_id so operators can find them in Log Analytics
# via a single identifier. Validation and HTTP errors get the same
# correlation-id envelope for uniformity across the API.


def _correlation_id(request: Request) -> str:
    """Return the request correlation id, preferring inbound headers.

    If a reverse proxy / front door already emitted ``x-correlation-id``
    or ``x-request-id``, propagate it; otherwise mint a UUID4.
    """
    for header in ("x-correlation-id", "x-request-id"):
        value = request.headers.get(header)
        if value:
            return value
    return str(uuid.uuid4())


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(
    request: Request, exc: RequestValidationError,
) -> JSONResponse:
    """422 responses with correlation id; body errors are safe to return."""
    cid = _correlation_id(request)
    logger.warning(
        "Request validation failed",
        path=request.url.path,
        method=request.method,
        errors=exc.errors(),
        correlation_id=cid,
    )
    return JSONResponse(
        status_code=422,
        content={
            "detail": exc.errors(),
            "correlation_id": cid,
            "type": "validation_error",
        },
        headers={"x-correlation-id": cid},
    )


@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(
    request: Request, exc: StarletteHTTPException,
) -> JSONResponse:
    """Preserve HTTPException semantics while attaching a correlation id."""
    cid = _correlation_id(request)
    content: dict[str, object] = {
        "detail": exc.detail,
        "correlation_id": cid,
    }
    return JSONResponse(
        status_code=exc.status_code,
        content=content,
        headers={"x-correlation-id": cid, **(exc.headers or {})},
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(
    request: Request, exc: Exception,
) -> JSONResponse:
    """Catch-all: 500 with correlation id; NEVER leak traceback."""
    cid = _correlation_id(request)
    # exc_info=True routes the traceback to structlog — visible in Log
    # Analytics AppTraces but never returned to the caller.
    logger.exception(
        "Unhandled exception",
        path=request.url.path,
        method=request.method,
        correlation_id=cid,
        exception_type=type(exc).__name__,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "correlation_id": cid,
            "type": "internal_error",
        },
        headers={"x-correlation-id": cid},
    )


# ── Routers ──────────────────────────────────────────────────────────────────
# The React frontend (api.ts) calls everything under /api/v1/.
# Legacy routes/ remain at /api/ for backward compatibility via app.py.

app.include_router(sources.router, prefix="/api/v1/sources", tags=["Sources"])
app.include_router(pipelines.router, prefix="/api/v1/pipelines", tags=["Pipelines"])
app.include_router(marketplace.router, prefix="/api/v1/marketplace", tags=["Marketplace"])
app.include_router(access.router, prefix="/api/v1/access", tags=["Access Requests"])
app.include_router(stats.router, prefix="/api/v1/stats", tags=["Statistics"])
app.include_router(domains_router, prefix="/api/v1/domains", tags=["Statistics"])

# ── BFF auth router (conditionally mounted) — CSA-0020 Phase 2 ──────────────
# The BFF router runs the MSAL Auth Code + PKCE flow server-side and
# issues an opaque httpOnly session cookie. It is only mounted when
# AUTH_MODE=bff so accidental exposure on an SPA-configured deployment
# is impossible. See docs/adr/0014-msal-bff-auth-pattern.md.
if settings.AUTH_MODE.lower() == "bff":
    # Import here to keep the optional `msal` + `itsdangerous` deps out
    # of the import graph on SPA-mode deployments.
    from .routers import auth_bff

    _env = settings.ENVIRONMENT.lower()
    if _env in ("production", "staging"):
        if not settings.BFF_SESSION_SIGNING_KEY or len(settings.BFF_SESSION_SIGNING_KEY) < 32:
            raise RuntimeError(
                "AUTH_MODE=bff requires BFF_SESSION_SIGNING_KEY "
                "(>=32 chars) to be configured for staging/production.",
            )
        if not (settings.BFF_TENANT_ID and settings.BFF_CLIENT_ID and settings.BFF_CLIENT_SECRET):
            raise RuntimeError(
                "AUTH_MODE=bff requires BFF_TENANT_ID, BFF_CLIENT_ID, and "
                "BFF_CLIENT_SECRET to be configured for staging/production.",
            )
    app.include_router(auth_bff.router)
    logger.info("BFF auth router mounted under /auth (AUTH_MODE=bff)")

    # CSA-0020 Phase 3 — reverse-proxy router (ADR-0019).  Opt-in via
    # BFF_PROXY_ENABLED so existing BFF deployments using the direct
    # /auth/token handoff aren't broken by an upgrade. The upstream
    # origin + scope are validated in config.py at settings-load time;
    # the httpx client + token broker are instantiated in ``lifespan``
    # and torn down on shutdown.
    if settings.BFF_PROXY_ENABLED:
        from .routers import api_proxy

        app.include_router(api_proxy.router)
        logger.info(
            "BFF reverse-proxy router mounted (upstream=%s, cache=%s)",
            settings.BFF_UPSTREAM_API_ORIGIN,
            settings.BFF_TOKEN_CACHE_BACKEND,
        )
else:
    logger.info("BFF auth router NOT mounted (AUTH_MODE=%s)", settings.AUTH_MODE)


# ── Top-level endpoints ─────────────────────────────────────────────────────


@app.get("/api/health/live", tags=["Health"])
async def health_live() -> dict:
    """Liveness probe — is the process running?"""
    return {"status": "alive"}


@app.get("/api/v1/health", tags=["Health"])
@app.get("/api/health/ready", tags=["Health"])
@app.get("/api/health", tags=["Health"], include_in_schema=False)
async def health_ready() -> dict:
    """Readiness probe — can the app serve requests?

    Checks local dependencies (SQLite data store, configuration) and
    reports an honest ``healthy`` / ``degraded`` status.  Does **not**
    attempt to reach remote Azure services that may not be deployed.

    SEC-0004: Only ``status`` and ``timestamp`` are returned to
    unauthenticated callers.  Version, environment, and auth_configured
    details are stripped from the public response to avoid information
    disclosure to unauthenticated scanners.
    """
    overall_healthy = True

    # Check data store (SQLite/Postgres) — result drives healthy/degraded
    # status but is intentionally not surfaced in the response body.
    try:
        from .dependencies import get_sources_store

        await get_sources_store().count()  # verify async store is reachable
    except Exception:
        overall_healthy = False

    return {
        "status": "healthy" if overall_healthy else "degraded",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


