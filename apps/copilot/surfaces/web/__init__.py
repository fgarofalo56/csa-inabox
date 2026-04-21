"""Minimal SSE web demo surface for the Copilot.

Ships a single-page HTMX-style chat UI that streams answers from the
grounded Q&A pipeline.  Out of scope: routing, SPA, authentication UX
— the surface is scope-bounded to a functional demo.
"""

from __future__ import annotations

__all__ = ["build_app"]


def __getattr__(name: str) -> object:
    if name == "build_app":
        from apps.copilot.surfaces.web.app import build_app

        return build_app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
