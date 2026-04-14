"""FastAPI routers for the CSA-in-a-Box API (v1).

Each sub-module defines an ``APIRouter`` that is mounted by ``main.py``.
"""

from . import access, marketplace, pipelines, sources, stats

__all__ = ["access", "marketplace", "pipelines", "sources", "stats"]
