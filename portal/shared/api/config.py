"""
Application configuration using pydantic-settings.

Loads settings from environment variables with sensible defaults
for local development. All Azure resource names and connection strings
should be injected via environment variables in deployed environments.
"""

from __future__ import annotations

from typing import Literal

from pydantic import AnyHttpUrl, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Central configuration for the CSA-in-a-Box shared backend."""

    # ── Azure AD / Entra ID ──────────────────────────────────────────────
    AZURE_TENANT_ID: str = ""
    AZURE_CLIENT_ID: str = ""
    IS_GOVERNMENT_CLOUD: bool = False

    # ── Database ─────────────────────────────────────────────────────────
    # SQLite remains the default for local/dev/demo; in staging and
    # production DATABASE_URL points at an Azure Database for PostgreSQL
    # Flexible Server URL and the factory
    # (:func:`portal.shared.api.persistence_factory.build_store_backend`)
    # selects the ``PostgresStore`` automatically.  See ``CSA-0046`` and
    # ``docs/adr/0015-postgres-portal-persistence.md``.
    DATA_DIR: str = "./data"
    # Leave empty (or ``sqlite:///...``) for the default SQLite backend
    # under ``DATA_DIR``.  For Postgres use
    # ``postgresql://<user>@<server>.postgres.database.azure.com:5432/<db>``
    # — no embedded password when managed identity is enabled; the
    # Postgres backend fetches a bearer token via
    # ``azure.identity.DefaultAzureCredential``.  The driver suffix
    # (``+psycopg``/``+asyncpg``) is normalised by the factory and
    # Alembic env.py so operators can use the short form.
    DATABASE_URL: str = ""
    # SQLAlchemy engine pool sizing (used by Postgres; SQLite uses a
    # single per-store connection instead).
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20
    # Seconds before ``expires_on`` at which the cached AAD token is
    # refreshed.  5 minutes is Azure's guidance.
    DATABASE_TOKEN_REFRESH_MARGIN_SECONDS: int = 300

    # Legacy per-component Postgres settings retained for compatibility
    # with deployment templates that pre-date DATABASE_URL.  Prefer
    # DATABASE_URL in new code.
    POSTGRES_HOST: str = ""
    POSTGRES_PORT: int = 5432
    POSTGRES_DB: str = ""
    POSTGRES_USER: str = ""
    # When True, PostgresStore replaces the connection password with a
    # fresh AAD access token on every new pool connection.  See
    # ``persistence_postgres._ManagedIdentityTokenProvider``.  Leave
    # False for local Postgres with a password embedded in the URL.
    POSTGRES_USE_MANAGED_IDENTITY: bool = False
    # PostgreSQL SSL mode — Azure Flexible Server enforces TLS by default
    # and rejects ``disable``.  ``require`` is the safe production value;
    # ``verify-full`` may be preferred for CA-pinned deployments.
    POSTGRES_SSL_MODE: str = "require"

    @field_validator("DATABASE_URL", mode="before")
    @classmethod
    def _validate_database_url(cls, v: object) -> object:
        """Reject unsupported URL schemes early.

        Accepts SQLite (``sqlite://``) and PostgreSQL
        (``postgresql://``, ``postgresql+psycopg://``,
        ``postgresql+asyncpg://``).  Any other scheme raises
        ``ValueError`` at settings-load time rather than falling
        through to a silent default.
        """
        if not isinstance(v, str) or not v:
            return v
        lower = v.lower()
        if lower.startswith(("sqlite://", "sqlite:///")):
            return v
        if lower.startswith(("postgresql://", "postgres://")):
            return v
        if lower.startswith(("postgresql+", "postgres+")):
            # Accept any SQLAlchemy driver suffix — the factory + alembic
            # env.py coerce to psycopg for sync callers when needed.
            return v
        raise ValueError(
            f"DATABASE_URL scheme not supported: {v!r}. "
            "Expected sqlite://..., postgresql://..., or postgresql+<driver>://...",
        )

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

    # ── BFF reverse-proxy (CSA-0020 Phase 3, ADR-0019) ──────────────────
    # When BFF_PROXY_ENABLED=true AND AUTH_MODE=bff, the ``api_proxy``
    # router is mounted at ``/api/*`` — the SPA calls the BFF with its
    # cookie, the BFF resolves the session, silently acquires a bearer
    # token via MSAL, and forwards the request to the upstream API. The
    # access token never reaches the browser.
    #
    # The flag defaults to False so existing BFF deployments that still
    # use the direct ``/auth/token`` handoff aren't broken by an upgrade.
    # See ``docs/adr/0019-bff-reverse-proxy.md``.
    BFF_PROXY_ENABLED: bool = False

    # Upstream API the proxy forwards requests to. Typically the portal
    # backend running on a separate port (dev) or a private endpoint /
    # internal load balancer FQDN (prod). Trailing slash tolerated.
    BFF_UPSTREAM_API_ORIGIN: AnyHttpUrl = AnyHttpUrl("http://localhost:8001")

    # Scope the BFF requests when acquiring a bearer token for the
    # upstream API. No safe default — operators must configure this
    # against their app registration (e.g. ``api://<client-id>/.default``
    # or ``api://<client-id>/access_as_user``). Fail-closed.
    BFF_UPSTREAM_API_SCOPE: str = ""

    # Upstream request timeout in seconds. Covers connect + read + write;
    # transient 5xx responses from the upstream are retried inside this
    # budget via tenacity (3 attempts, jittered backoff).
    BFF_UPSTREAM_API_TIMEOUT_SECONDS: int = 30

    # ── MSAL token cache (persistent, HMAC-sealed) ─────────────────────
    # ``memory`` keeps the cache in process — dev/test only; tokens are
    # lost on restart and not shared across replicas. ``redis`` persists
    # the serialised ``msal.SerializableTokenCache`` under
    # ``csa:bff:tcache:<sha256(session_id)>`` with a Redis EX TTL and an
    # HMAC seal so a Redis compromise cannot replay or tamper with cache
    # entries.
    BFF_TOKEN_CACHE_BACKEND: Literal["memory", "redis"] = "memory"
    BFF_TOKEN_CACHE_TTL_SECONDS: int = 86400  # 24h — refresh-token lifetime + margin
    # HMAC key used to seal cache blobs. Required when the backend is
    # ``redis``; ignored for ``memory``. Must be >= 32 chars — the
    # validator below enforces this at startup, not at first request.
    BFF_TOKEN_CACHE_HMAC_KEY: SecretStr = SecretStr("")

    @model_validator(mode="after")
    def _validate_bff_proxy_settings(self) -> Settings:
        """Enforce Phase-3 required-when-bff invariants.

        These checks run at settings-load time so a misconfigured
        deployment fails fast at boot rather than at first proxied
        request. The rules:

        * When ``AUTH_MODE=bff`` AND ``BFF_PROXY_ENABLED=true``, the
          upstream API scope MUST be set (no safe default exists).
        * When ``AUTH_MODE=bff`` AND ``BFF_TOKEN_CACHE_BACKEND=redis``,
          the HMAC key MUST be set and >= 32 chars.
        """
        if self.AUTH_MODE.lower() != "bff":
            return self
        if self.BFF_PROXY_ENABLED and not self.BFF_UPSTREAM_API_SCOPE.strip():
            raise ValueError(
                "AUTH_MODE=bff with BFF_PROXY_ENABLED=true requires "
                "BFF_UPSTREAM_API_SCOPE (e.g. 'api://<client-id>/.default').",
            )
        if self.BFF_TOKEN_CACHE_BACKEND == "redis":
            secret = self.BFF_TOKEN_CACHE_HMAC_KEY.get_secret_value()
            if len(secret) < 32:
                raise ValueError(
                    "BFF_TOKEN_CACHE_BACKEND=redis requires "
                    "BFF_TOKEN_CACHE_HMAC_KEY to be >= 32 chars.",
                )
        return self

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": True,
    }


# Singleton — import this wherever settings are needed.
settings = Settings()
