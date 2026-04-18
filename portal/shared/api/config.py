"""
Application configuration using pydantic-settings.

Loads settings from environment variables with sensible defaults
for local development. All Azure resource names and connection strings
should be injected via environment variables in deployed environments.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Central configuration for the CSA-in-a-Box shared backend."""

    # ── Azure AD / Entra ID ──────────────────────────────────────────────
    AZURE_TENANT_ID: str = ""
    AZURE_CLIENT_ID: str = ""
    IS_GOVERNMENT_CLOUD: bool = False

    # ── Database ─────────────────────────────────────────────────────────
    # SQLite-based persistence for demo/development — swap to Cosmos DB or PostgreSQL in production
    DATA_DIR: str = "./data"

    # ── Azure Storage ────────────────────────────────────────────────────
    STORAGE_ACCOUNT_NAME: str = ""

    # ── Azure Data Factory ───────────────────────────────────────────────
    ADF_RESOURCE_GROUP: str = ""
    ADF_FACTORY_NAME: str = ""
    ADF_SUBSCRIPTION_ID: str = ""

    # ── Microsoft Purview ────────────────────────────────────────────────
    PURVIEW_ACCOUNT_NAME: str = ""

    # ── Observability ────────────────────────────────────────────────────
    LOG_LEVEL: str = "INFO"

    # ── CORS ─────────────────────────────────────────────────────────────
    # Wildcards like *.azurestaticapps.net match ANY Azure-hosted app
    # (including attacker-controlled ones) and should never be used with
    # allow_credentials=True.  In production set CORS_ORIGINS env var to
    # explicit hostnames: "https://myapp.azurestaticapps.net,https://portal.example.com"
    CORS_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:4280",  # Static Web Apps emulator
        "http://localhost:5173",
        "http://localhost:8080",
    ]

    # ── Application ──────────────────────────────────────────────────────
    APP_TITLE: str = "CSA-in-a-Box API"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = False

    # ── Auth / Environment Safety ────────────────────────────────────────
    # ENVIRONMENT controls deploy-target awareness. AUTH_DISABLED=true is
    # only honoured when ENVIRONMENT=local or DEMO_MODE=true — any other
    # combination causes a hard startup failure to prevent accidental
    # production exposure without authentication.
    ENVIRONMENT: str = "local"
    DEMO_MODE: bool = False
    AUTH_DISABLED: bool = False

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": True,
    }


# Singleton — import this wherever settings are needed.
settings = Settings()
