"""Standalone FastAPI launcher for the Copilot API surface.

Run with::

    python -m apps.copilot.surfaces.api --help
    python -m apps.copilot.surfaces.api --host 127.0.0.1 --port 8091

In staging/production the startup gate refuses to boot without:
* ``COPILOT_API_AUTH_ENABLED=true``
* ``AZURE_TENANT_ID`` and ``AZURE_CLIENT_ID`` configured

The app also rejects wildcards in the CORS allowlist.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from apps.copilot.surfaces.api.auth import (
    build_rate_limiter,
    rate_limit_dependency,
)
from apps.copilot.surfaces.api.router import router as copilot_router
from apps.copilot.surfaces.config import SurfacesSettings


class StartupConfigurationError(RuntimeError):
    """Raised when the API surface refuses to boot due to missing config."""


def _environment() -> str:
    return os.environ.get("ENVIRONMENT", "local").strip().lower()


def _enforce_startup_gate(settings: SurfacesSettings) -> None:
    """Fail fast when auth / CORS config is unsafe for the current env.

    Rules:
    * Staging/production REQUIRE ``api_auth_enabled=True`` AND
      ``AZURE_TENANT_ID`` + ``AZURE_CLIENT_ID`` set.
    * Wildcards in ``api_cors_origins`` are rejected anywhere except
      local/dev environments.
    """
    env = _environment()
    if env in ("staging", "production"):
        missing: list[str] = []
        if not settings.api_auth_enabled:
            missing.append("COPILOT_API_AUTH_ENABLED=true")
        if not os.environ.get("AZURE_TENANT_ID"):
            missing.append("AZURE_TENANT_ID")
        if not os.environ.get("AZURE_CLIENT_ID"):
            missing.append("AZURE_CLIENT_ID")
        if missing:
            raise StartupConfigurationError(
                f"Copilot API refuses to start in ENVIRONMENT={env!r}: missing "
                f"{', '.join(missing)}.  Configure auth before accepting traffic.",
            )

    wildcard = [origin for origin in settings.api_cors_origins if "*" in origin]
    if wildcard and env not in ("local", "dev"):
        raise StartupConfigurationError(
            f"COPILOT_API_CORS_ORIGINS contains wildcard entries {wildcard!r}; "
            "replace with explicit hostnames.  Wildcards + credentials allow "
            "any attacker-controlled origin to make credentialled requests.",
        )


def build_app(
    *,
    settings: SurfacesSettings | None = None,
    prefix: str = "/copilot",
) -> FastAPI:
    """Build the standalone Copilot FastAPI application.

    Args:
        settings: Override the default :class:`SurfacesSettings`.
            Tests pass a settings instance constructed from a ``dict``.
        prefix: Router prefix (default ``/copilot`` so the standalone
            app mirrors the in-portal mount path).

    Returns:
        A configured :class:`FastAPI` application.  The same app can be
        handed to ``uvicorn.run`` or to ``httpx.AsyncClient`` for tests.
    """
    settings = settings or SurfacesSettings()
    _enforce_startup_gate(settings)

    @asynccontextmanager
    async def _lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
        yield

    app = FastAPI(
        title="CSA Copilot API",
        description="Grounded Q&A + tools + broker for the CSA-in-a-Box Copilot.",
        version="0.5.0",
        lifespan=_lifespan,
    )

    # CORS — explicit allowlist, no wildcards accepted in non-dev envs.
    if settings.api_cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.api_cors_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
        )

    # Rate limiter — swap-able via ``app.dependency_overrides``.
    limiter = build_rate_limiter(settings)
    app.state.rate_limiter = limiter
    dependency = rate_limit_dependency(limiter)
    app.include_router(
        copilot_router,
        prefix=prefix,
        dependencies=[] if settings.api_rate_limit_per_minute <= 0 else [__depends(dependency)],
    )

    @app.get("/healthz", tags=["health"])
    async def healthz() -> dict[str, str]:
        """Liveness probe — always returns OK when the process is alive."""
        return {"status": "ok"}

    return app


def __depends(dep: Any) -> Any:
    """Thin wrapper producing a ``Depends(...)`` without importing fastapi at module top."""
    from fastapi import Depends

    return Depends(dep)


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser for the standalone launcher."""
    parser = argparse.ArgumentParser(
        prog="apps.copilot.surfaces.api",
        description=(
            "Run the Copilot FastAPI surface standalone via uvicorn.  In "
            "staging/production the app refuses to boot without Azure AD "
            "auth configured."
        ),
    )
    parser.add_argument("--host", default=None, help="Override bind host.")
    parser.add_argument("--port", type=int, default=None, help="Override bind port.")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable uvicorn autoreload (development only).",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="uvicorn log level.",
    )
    parser.add_argument(
        "--prefix",
        default="/copilot",
        help="Mount prefix for the Copilot router (default: /copilot).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point — ``python -m apps.copilot.surfaces.api``."""
    args = build_parser().parse_args(argv)
    settings = SurfacesSettings()
    host = args.host or settings.api_bind_host
    port = args.port or settings.api_bind_port

    try:
        app = build_app(settings=settings, prefix=args.prefix)
    except StartupConfigurationError as exc:
        print(f"[copilot.api] refusing to start: {exc}", file=sys.stderr)
        return 2

    import uvicorn

    uvicorn.run(
        app,
        host=host,
        port=port,
        reload=args.reload,
        log_level=args.log_level,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
