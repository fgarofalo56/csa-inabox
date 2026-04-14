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
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import access, marketplace, pipelines, sources, stats

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("csainabox.api")


# ── Lifespan ─────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: startup and shutdown hooks."""
    logger.info(
        "Starting CSA-in-a-Box API  (gov=%s, debug=%s)",
        settings.IS_GOVERNMENT_CLOUD,
        settings.DEBUG,
    )
    # TODO: Initialize database connection pool here
    # TODO: Warm up Azure credential cache
    yield
    logger.info("Shutting down CSA-in-a-Box API")
    # TODO: Close database connections, flush metrics


# ── Application ──────────────────────────────────────────────────────────────

app = FastAPI(
    title=settings.APP_TITLE,
    description=(
        "Self-service data source registration, pipeline generation, "
        "and data marketplace API for the Cloud Scale Analytics (Fabric-in-a-Box) platform."
    ),
    version=settings.APP_VERSION,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

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


@app.get("/api/v1/health", tags=["Health"])
@app.get("/api/health", tags=["Health"], include_in_schema=False)
async def health_check() -> dict:
    """Liveness / readiness probe.

    Returns service status, current timestamp, and downstream dependency
    health (stubbed in demo mode).
    """
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": settings.APP_VERSION,
        "services": {
            "api": "up",
            "database": "up",  # TODO: real DB ping
            "data_factory": "connected",  # TODO: real ADF health
            "purview": "connected",  # TODO: real Purview health
        },
    }


@app.get("/api/v1/domains", response_model=list, tags=["Statistics"])
async def list_all_domains() -> list[dict]:
    """Return all domain overviews — convenience alias used by the React frontend."""
    from .routers.stats import _DEMO_DOMAINS

    return [d.model_dump() for d in _DEMO_DOMAINS.values()]
