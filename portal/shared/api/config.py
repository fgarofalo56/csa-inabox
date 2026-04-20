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

    # ── BFF (Backend-for-Frontend) auth — CSA-0020 Phase 2 ───────────────
    # When AUTH_MODE=bff, the ``auth_bff`` router is mounted and drives
    # server-side MSAL Auth Code + PKCE flows with a signed ``csa_sid``
    # session cookie. When AUTH_MODE=spa (default) the BFF router is
    # NOT mounted, so accidental exposure in an SPA-configured deploy
    # is impossible. See ``docs/adr/0014-msal-bff-auth-pattern.md``.
    AUTH_MODE: str = "spa"  # one of: "spa" | "bff"

    # Entra ID app registration used for the confidential-client flow.
    # Reuse AZURE_TENANT_ID / AZURE_CLIENT_ID unless a separate BFF
    # app registration is preferred (recommended for defence in depth).
    BFF_TENANT_ID: str = ""
    BFF_CLIENT_ID: str = ""
    BFF_CLIENT_SECRET: str = ""
    BFF_REDIRECT_URI: str = "http://localhost:8000/auth/callback"
    # Scopes requested at /auth/login. `offline_access` is required for
    # refresh-token-backed silent acquisition. Keep space-separated so
    # operators can extend with additional API scopes (e.g.
    # "api://<client-id>/access_as_user") without code changes.
    BFF_SCOPES: str = "openid profile email offline_access User.Read"

    # Session cookie. Secure + HttpOnly + SameSite=Lax are the Phase 2
    # defaults. For cross-site SPA + BFF deployments (different origin)
    # set BFF_COOKIE_SAMESITE=None and ensure the hosting origin is
    # HTTPS — otherwise the browser will drop the cookie.
    BFF_COOKIE_NAME: str = "csa_sid"
    BFF_COOKIE_SECURE: bool = True
    BFF_COOKIE_SAMESITE: str = "lax"  # one of: "lax" | "strict" | "none"
    BFF_COOKIE_DOMAIN: str | None = None

    # Signing key for the short-lived pending-auth cookie and the
    # opaque session id. MUST be set in non-local environments. The
    # mount guard in main.py rejects startup when AUTH_MODE=bff and
    # this is empty/too-short in staging or production.
    BFF_SESSION_SIGNING_KEY: str = ""
    # Seconds; 8 hours default. `touch()` on /auth/me extends.
    BFF_SESSION_TTL_SECONDS: int = 8 * 60 * 60
    # Seconds; 10 minutes is a generous window for the user to finish
    # the Entra ID login round-trip before the pending-auth cookie
    # expires and /auth/callback refuses the request.
    BFF_PENDING_AUTH_TTL_SECONDS: int = 10 * 60

    # Session-store backend. "memory" is dev/test; "redis" is required
    # for multi-replica deployments.
    BFF_SESSION_STORE: str = "memory"  # one of: "memory" | "redis"
    BFF_REDIS_URL: str = ""

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": True,
    }


# Singleton — import this wherever settings are needed.
settings = Settings()
