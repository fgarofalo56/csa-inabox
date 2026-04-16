"""
CSA-in-a-Box: Data Onboarding Portal — Shared Backend (main entry point).

This is the FastAPI application that powers **all four** portal front-end
implementations (React, PowerApps, Static Web App, Kubernetes).  It provides
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

import logging
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .config import settings
from .routers import access, marketplace, pipelines, sources, stats

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("csainabox.api")

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
        if request.url.scheme == "https":
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )
        return response


# ── Auth Safety Gate ────────────────────────────────────────────────────────
# Defence-in-depth: this mirrors the check in auth.py at the application
# entry-point so it fires even if the auth module is not directly imported.

_auth_off = settings.AUTH_DISABLED or not settings.AZURE_TENANT_ID
_safe_env = settings.ENVIRONMENT.lower() == "local" or settings.DEMO_MODE

if _auth_off and not _safe_env:
    logger.critical(
        "FATAL: Authentication is disabled (AUTH_DISABLED=%s, "
        "AZURE_TENANT_ID=%s) but ENVIRONMENT=%r is not 'local' and "
        "DEMO_MODE is False.  Refusing to start — configure authentication "
        "or set ENVIRONMENT=local for development.",
        settings.AUTH_DISABLED,
        bool(settings.AZURE_TENANT_ID),
        settings.ENVIRONMENT,
    )
    raise RuntimeError(
        "AUTH_DISABLED or missing AZURE_TENANT_ID in non-local environment. "
        "Set ENVIRONMENT=local or DEMO_MODE=true for development, or "
        "configure AZURE_TENANT_ID for production."
    )


# ── Lifespan ─────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: startup and shutdown hooks."""
    logger.info(
        "Starting CSA-in-a-Box API  (gov=%s, debug=%s)",
        settings.IS_GOVERNMENT_CLOUD,
        settings.DEBUG,
    )
    # Initialize data directory for JSON persistence
    from pathlib import Path

    data_dir = Path(settings.DATA_DIR)
    data_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"JSON persistence data directory: {data_dir}")

    # Seed demo data once at startup (instead of per-request)
    sources.seed_demo_sources()
    access.seed_demo_requests()
    marketplace.seed_demo_products()
    logger.info("Demo data seeding complete")

    yield
    logger.info("Shutting down CSA-in-a-Box API")
    # JSON files are persisted automatically, no cleanup needed


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
    """
    checks: dict[str, object] = {}
    overall_healthy = True

    # Check data store (SQLite)
    try:
        from .routers.sources import _sources_store

        _sources_store.count()  # simple query to verify DB is accessible
        checks["data_store"] = "healthy"
    except Exception as e:
        checks["data_store"] = f"unhealthy: {type(e).__name__}"
        overall_healthy = False

    # Check that authentication is configured (or intentionally skipped)
    checks["auth_configured"] = bool(settings.AZURE_TENANT_ID) or settings.DEMO_MODE

    return {
        "status": "healthy" if overall_healthy else "degraded",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": settings.APP_VERSION,
        "environment": settings.ENVIRONMENT,
        "checks": checks,
    }


@app.get("/api/v1/domains", response_model=list, tags=["Statistics"])
async def list_all_domains() -> list[dict]:
    """Return all domain overviews — convenience alias used by the React frontend."""
    from .routers.stats import _build_domain_overviews, _get_pipelines, _get_products, _get_sources

    sources = _get_sources()
    pipelines = _get_pipelines()
    products = _get_products()
    overviews = _build_domain_overviews(sources, pipelines, products)
    return [d.model_dump() for d in overviews.values()]
