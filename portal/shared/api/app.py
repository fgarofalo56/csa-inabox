"""
CSA-in-a-Box: Data Onboarding Portal — Shared Backend API

FastAPI application providing the common backend for all portal implementations
(PowerApps, React, Static Web Apps, Kubernetes). Handles data source registration,
pipeline generation, DLZ provisioning, and marketplace functionality.
"""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from .routers import access, marketplace, pipelines, sources, stats

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: startup and shutdown hooks."""
    logger.info("Starting CSA Data Onboarding Portal API")
    yield
    logger.info("Shutting down CSA Data Onboarding Portal API")


app = FastAPI(
    title="CSA-in-a-Box Data Onboarding Portal",
    description=(
        "Self-service data source registration, pipeline generation, "
        "and data marketplace API for the Cloud Scale Analytics platform."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# CORS — allow all portal frontends
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # React dev
        "http://localhost:4280",  # Static Web Apps dev
        "http://localhost:5173",  # Vite dev
        "https://*.azurestaticapps.net",
        "https://*.azurewebsites.net",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register route modules
app.include_router(sources.router, prefix="/api/sources", tags=["Data Sources"])
app.include_router(pipelines.router, prefix="/api/pipelines", tags=["Pipelines"])
app.include_router(marketplace.router, prefix="/api/marketplace", tags=["Marketplace"])
app.include_router(access.router, prefix="/api/access", tags=["Access Requests"])
app.include_router(stats.router, prefix="/api/stats", tags=["Statistics"])


@app.get("/api/health")
async def health_check() -> dict:
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": "1.0.0",
    }
