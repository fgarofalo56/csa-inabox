"""
Pydantic models for data access requests and marketplace.

NOTE: This file is kept for backward-compatibility with the ``routes/``
package.  The canonical marketplace models now live in ``marketplace.py``.
"""

from __future__ import annotations

# Re-export from the marketplace module so existing routes/ imports still work.
from .marketplace import (  # noqa: F401
    AccessLevel,
    AccessRequest,
    AccessRequestCreate,
    AccessRequestStatus,
    DataProduct,
    DomainOverview,
    DomainStatus,
    PlatformStats,
    QualityMetric,
)
