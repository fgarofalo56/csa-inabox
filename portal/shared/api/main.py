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

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from governance.common.logging import configure_structlog, get_logger

from .config import settings
from .routers import access, marketplace, pipelines, sources, stats
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
    # Initialize data directory for SQLite persistence
    from pathlib import Path

    data_dir = Path(settings.DATA_DIR)
    data_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"SQLite persistence data directory: {data_dir}")

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

    # Seed demo data once at startup (instead of per-request)
    sources.seed_demo_sources()
    pipelines.seed_demo_pipelines()
    access.seed_demo_requests()
    marketplace.seed_demo_products()
    logger.info("Demo data seeding complete")

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

# ── Routers ──────────────────────────────────────────────────────────────────
# The React frontend (api.ts) calls everything under /api/v1/.
# Legacy routes/ remain at /api/ for backward compatibility via app.py.

app.include_router(sources.router, prefix="/api/v1/sources", tags=["Sources"])
app.include_router(pipelines.router, prefix="/api/v1/pipelines", tags=["Pipelines"])
app.include_router(marketplace.router, prefix="/api/v1/marketplace", tags=["Marketplace"])
app.include_router(access.router, prefix="/api/v1/access", tags=["Access Requests"])
app.include_router(stats.router, prefix="/api/v1/stats", tags=["Statistics"])


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

    # Check data store (SQLite) — result drives healthy/degraded status
    # but is intentionally not surfaced in the response body.
    try:
        from .routers.sources import _sources_store

        _sources_store.count()  # simple query to verify DB is accessible
    except Exception:
        overall_healthy = False

    return {
        "status": "healthy" if overall_healthy else "degraded",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/v1/domains", response_model=list, tags=["Statistics"])
async def list_all_domains(
    _user: dict = Depends(get_current_user),
) -> list[dict]:
    """Return all domain overviews — convenience alias used by the React frontend."""
    from .routers.stats import _build_domain_overviews, _get_pipelines, _get_products, _get_sources

    sources = _get_sources()
    pipelines = _get_pipelines()
    products = _get_products()
    overviews = _build_domain_overviews(sources, pipelines, products)
    return [d.model_dump() for d in overviews.values()]
