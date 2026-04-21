"""CSA Copilot client-facing surfaces (Phase 5).

This package bundles the four ways clients talk to the Copilot:

* ``api``       — FastAPI :class:`APIRouter` + standalone launcher.
* ``mcp``       — Model Context Protocol (stdio + optional HTTP).
* ``cli_daemon`` — long-lived JSON-RPC daemon (Unix socket / localhost TCP).
* ``web``       — minimal FastAPI + Jinja2 + SSE demo surface.

Each sub-package can be used independently; nothing here mutates the
core ``apps.copilot.*`` modules (see ``surfaces/README.md`` for scope).
The ``surfaces`` package has no top-level side-effects — importing it
does not load FastAPI, MCP, or any heavy deps.
"""

from __future__ import annotations

__all__ = [
    "SurfacesSettings",
]


def __getattr__(name: str) -> object:
    """Lazy-import surface settings so simply importing the package is cheap."""
    if name == "SurfacesSettings":
        from apps.copilot.surfaces.config import SurfacesSettings

        return SurfacesSettings
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
