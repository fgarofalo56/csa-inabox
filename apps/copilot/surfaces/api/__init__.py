"""FastAPI surface for the CSA Copilot (Phase 5).

Provides an ``APIRouter`` mountable into any FastAPI application plus a
standalone launcher (``python -m apps.copilot.surfaces.api``).
"""

from __future__ import annotations

from apps.copilot.surfaces.api.router import router

__all__ = ["router"]
