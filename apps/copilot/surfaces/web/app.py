"""Minimal FastAPI + Jinja2 web surface for the Copilot.

Scope-bound: one HTML page, one JS file, one CSS file.  Answers stream
from the Copilot via Server-Sent Events.

Production posture:
* Startup refuses to boot in staging/production unless either
  ``COPILOT_WEB_LOCAL_DEMO_MODE=false`` AND auth is configured via
  ``csa_platform.common.auth``, OR the caller is behind a BFF
  (``AUTH_MODE=bff``).
* No secrets in HTML, JS, or CSS — the only identifier shown is the
  brand title.
* No wildcards in CORS; the web surface is same-origin by default.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sse_starlette.sse import EventSourceResponse

from apps.copilot.agent import CopilotAgent
from apps.copilot.config import CopilotSettings
from apps.copilot.surfaces.api.sse import _answer_chunk_to_event
from apps.copilot.surfaces.config import SurfacesSettings

_TEMPLATE_DIR = Path(__file__).resolve().parent / "templates"
_STATIC_DIR = Path(__file__).resolve().parent / "static"


class WebStartupConfigurationError(RuntimeError):
    """Raised when the web surface refuses to boot due to missing config."""


def _environment() -> str:
    return os.environ.get("ENVIRONMENT", "local").strip().lower()


def _enforce_startup_gate(settings: SurfacesSettings) -> None:
    """Fail fast when the web surface would serve unauthenticated traffic.

    * Local/dev can run in demo mode freely.
    * Staging/production REQUIRE either ``AUTH_MODE=bff`` OR
      ``COPILOT_WEB_LOCAL_DEMO_MODE=false`` + a valid Azure AD config.
    """
    env = _environment()
    if env in ("staging", "production"):
        auth_mode = os.environ.get("AUTH_MODE", "").strip().lower()
        behind_bff = auth_mode == "bff"
        if settings.web_local_demo_mode and not behind_bff:
            raise WebStartupConfigurationError(
                f"Copilot web surface refuses to start in ENVIRONMENT={env!r} "
                "with COPILOT_WEB_LOCAL_DEMO_MODE=true.  Either disable demo "
                "mode AND configure auth, or run behind the BFF "
                "(AUTH_MODE=bff).",
            )
        if not behind_bff and not os.environ.get("AZURE_TENANT_ID"):
            raise WebStartupConfigurationError(
                f"Copilot web surface refuses to start in ENVIRONMENT={env!r} "
                "without AZURE_TENANT_ID configured AND demo-mode off.",
            )


def _default_agent_factory() -> CopilotAgent:
    """Build the production :class:`CopilotAgent`."""
    return CopilotAgent.from_settings(CopilotSettings())


async def _stream_answer(
    agent: CopilotAgent,
    question: str,
) -> AsyncIterator[dict[str, str]]:
    """Adapt the :meth:`CopilotAgent.ask_stream` flow to SSE-shaped dicts."""
    async for chunk in agent.ask_stream(question):
        raw = _answer_chunk_to_event(chunk).decode("utf-8")
        event_line, data_line, _ = raw.split("\n", 2)
        yield {
            "event": event_line.removeprefix("event: ").strip(),
            "data": data_line.removeprefix("data: ").strip(),
        }
        if chunk.kind == "done":
            return


def build_app(
    *,
    settings: SurfacesSettings | None = None,
    agent_factory: Any = None,
) -> FastAPI:
    """Construct the web surface FastAPI application.

    Args:
        settings: Override :class:`SurfacesSettings` — tests inject
            their own values for brand title / demo mode.
        agent_factory: Callable returning a ready :class:`CopilotAgent`.
            Tests pass a stub; production uses
            :func:`_default_agent_factory`.
    """
    settings = settings or SurfacesSettings()
    _enforce_startup_gate(settings)
    factory = agent_factory or _default_agent_factory

    @asynccontextmanager
    async def _lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        # Build the agent lazily on first request when the factory is
        # cheap, but here we still eagerly construct it so the first
        # user-facing SSE call is warm.
        try:
            app.state.agent = factory()
        except Exception:  # pragma: no cover - production factory only
            app.state.agent = None
        yield

    app = FastAPI(
        title="CSA Copilot Web",
        description="Minimal SSE chat demo for the CSA-in-a-Box Copilot.",
        version="0.5.0",
        lifespan=_lifespan,
        docs_url=None,  # demo surface — no API docs served.
        redoc_url=None,
        openapi_url=None,
    )

    templates = Jinja2Templates(directory=str(_TEMPLATE_DIR))
    app.mount(
        "/static",
        StaticFiles(directory=str(_STATIC_DIR)),
        name="copilot_static",
    )

    def get_agent_dep() -> CopilotAgent:
        agent = getattr(app.state, "agent", None)
        if agent is None:
            agent = factory()
            app.state.agent = agent
        return agent

    @app.get("/", response_class=HTMLResponse, tags=["web"])
    async def index(request: Request) -> Any:
        demo_banner: str | None = None
        if settings.web_local_demo_mode:
            demo_banner = (
                "Demo mode — no authentication enforced. "
                "Do NOT share sensitive data with this instance."
            )
        return templates.TemplateResponse(
            request,
            "index.html",
            {
                "brand_title": settings.web_brand_title,
                "demo_banner": demo_banner,
                "sse_endpoint": "/chat/send",
            },
        )

    @app.get("/chat/send", tags=["web"])
    async def chat_send(
        question: str = Query(min_length=1, max_length=4_000),
        agent: CopilotAgent = Depends(get_agent_dep),  # noqa: B008 - FastAPI DI idiom
    ) -> Any:
        return EventSourceResponse(
            _stream_answer(agent, question),
            ping=15,
        )

    @app.get("/healthz", tags=["health"])
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


# ─────────────────────────────────────────────────────────────────────────
# Standalone launcher
# ─────────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI parser for the standalone launcher."""
    parser = argparse.ArgumentParser(
        prog="apps.copilot.surfaces.web",
        description=(
            "Run the Copilot web demo (FastAPI + Jinja2 + SSE) standalone "
            "via uvicorn.  In staging/production the app refuses to boot "
            "without an auth configuration."
        ),
    )
    parser.add_argument("--host", default=None, help="Override bind host.")
    parser.add_argument("--port", type=int, default=None, help="Override bind port.")
    parser.add_argument("--reload", action="store_true", help="uvicorn autoreload.")
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="uvicorn log level.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point — ``python -m apps.copilot.surfaces.web``."""
    args = build_parser().parse_args(argv)
    settings = SurfacesSettings()
    host = args.host or settings.web_bind_host
    port = args.port or settings.web_bind_port

    try:
        app = build_app(settings=settings)
    except WebStartupConfigurationError as exc:
        print(f"[copilot.web] refusing to start: {exc}", file=sys.stderr)
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


# Keep unused imports reachable (some linters flag type-only imports).
_ = asyncio
