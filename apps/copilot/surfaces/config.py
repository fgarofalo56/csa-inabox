"""Surface-specific configuration (Phase 5).

The core :class:`apps.copilot.config.CopilotSettings` model is frozen and
owned by earlier phases — this module adds a **parallel** frozen settings
object for the four surfaces without touching the original model.

Read-side idiom::

    from apps.copilot.config import CopilotSettings
    from apps.copilot.surfaces.config import SurfacesSettings

    copilot = CopilotSettings()
    surfaces = SurfacesSettings()

Both models are independent ``BaseSettings`` instances reading the
process environment, so they compose cleanly and can be tested in
isolation.

Environment variable convention: ``COPILOT_<field-name>`` (uppercase).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class SurfacesSettings(BaseSettings):
    """Frozen configuration consumed by the Phase 5 surfaces.

    Every field has a sensible default for local dev — production or
    staging deployments layer real values on top via environment
    variables.  The startup gates in each surface (``api.app``,
    ``web.app``) inspect the relevant fields and refuse to boot when a
    critical value is missing.
    """

    # ─── FastAPI router + standalone app ────────────────────────────────
    api_auth_enabled: bool = Field(
        default=False,
        description=(
            "When true, the FastAPI surface enforces Azure AD JWT bearer "
            "authentication on every route via ``csa_platform.common.auth``. "
            "Staging/production MUST set this to ``true`` or startup refuses."
        ),
    )
    api_rate_limit_per_minute: int = Field(
        default=60,
        ge=0,
        le=10_000,
        description=(
            "Per-caller sliding-window rate limit.  Zero disables the "
            "limiter (demo/local only)."
        ),
    )
    api_cors_origins: list[str] = Field(
        default_factory=list,
        description=(
            "Explicit CORS allowlist for the FastAPI surface.  Wildcards "
            "are rejected at startup — use literal hostnames."
        ),
    )
    api_session_signing_key: str = Field(
        default="",
        description=(
            "itsdangerous signing key for session cookies carrying the "
            "conversation id.  Required (>=32 chars) in staging/prod."
        ),
    )
    api_bind_host: str = Field(
        default="127.0.0.1",
        description="Host interface the standalone launcher binds to.",
    )
    api_bind_port: int = Field(
        default=8091,
        ge=1,
        le=65_535,
        description="TCP port the standalone launcher binds to.",
    )

    # ─── MCP server ─────────────────────────────────────────────────────
    mcp_transport: Literal["stdio", "http"] = Field(
        default="stdio",
        description=(
            "MCP transport: ``stdio`` for local IDE/CLI integrations, "
            "``http`` for a streamable HTTP server."
        ),
    )
    mcp_http_port: int = Field(
        default=0,
        ge=0,
        le=65_535,
        description=(
            "TCP port for the MCP HTTP transport.  Zero disables the HTTP "
            "path (stdio only)."
        ),
    )

    # ─── CLI daemon ─────────────────────────────────────────────────────
    daemon_socket_path: str = Field(
        default="",
        description=(
            "Override for the Unix-domain socket path on POSIX hosts.  "
            "Empty means the daemon picks ``$XDG_RUNTIME_DIR/copilot.sock`` "
            "(or ``$HOME/.csa/copilot.sock``).  Ignored on Windows where "
            "the daemon always uses a localhost TCP socket."
        ),
    )
    daemon_startup_timeout_seconds: float = Field(
        default=10.0,
        ge=0.1,
        le=300.0,
        description=(
            "Client-side timeout when auto-starting the daemon before "
            "giving up and raising ``DaemonStartupError``."
        ),
    )

    # ─── Web demo surface ───────────────────────────────────────────────
    web_local_demo_mode: bool = Field(
        default=True,
        description=(
            "When true, the web surface serves the demo UI without any "
            "auth enforcement.  Staging/prod must set this to false OR "
            "run behind the BFF (``AUTH_MODE=bff``) — startup refuses "
            "otherwise."
        ),
    )
    web_brand_title: str = Field(
        default="CSA Copilot",
        max_length=100,
        description="Header shown on the web demo page.",
    )
    web_bind_host: str = Field(
        default="127.0.0.1",
        description="Host interface the standalone web launcher binds to.",
    )
    web_bind_port: int = Field(
        default=8092,
        ge=1,
        le=65_535,
        description="TCP port the standalone web launcher binds to.",
    )

    model_config = SettingsConfigDict(
        env_prefix="COPILOT_",
        frozen=True,
        extra="ignore",
    )


__all__ = ["SurfacesSettings"]
