"""Initial schema — portal logical stores.

Creates one ``id TEXT PRIMARY KEY + data JSONB`` table per logical store
that the portal routers use today (CSA-0046):

  * sources              (portal.shared.api.routers.sources)
  * pipelines            (portal.shared.api.routers.pipelines)
  * pipeline_runs        (portal.shared.api.routers.pipelines)
  * access_requests      (portal.shared.api.routers.access)
  * marketplace_products (portal.shared.api.routers.marketplace)
  * marketplace_quality  (portal.shared.api.routers.marketplace)

The schema intentionally mirrors the SQLite layout (single ``data``
blob column keyed by ``id``) so migration from SQLite is a mechanical
row-by-row copy.  Future revisions may promote specific top-level
fields into typed columns.

Revision ID: 0001
Revises:
Create Date: 2026-04-20
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Every logical store the portal currently writes.  Keep this list in
# sync with the ``build_store_backend(...)`` calls in the routers.
_STORE_TABLES: list[str] = [
    "sources",
    "pipelines",
    "pipeline_runs",
    "access_requests",
    "marketplace_products",
    "marketplace_quality",
]


def _jsonb_type() -> sa.types.TypeEngine:
    """Return ``JSONB`` on Postgres, ``JSON`` elsewhere (SQLite, MySQL).

    Alembic migrations are dialect-aware; we pick the most appropriate
    column type per backend rather than hard-coding ``JSONB``.  The
    portal's PostgresStore relies on JSONB's indexability for the
    ``query`` path; the SQLite backend uses ``json_extract`` over TEXT
    anyway so the choice is immaterial there.
    """
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import JSONB

        return JSONB(astext_type=sa.Text())
    return sa.JSON()


def upgrade() -> None:
    """Create all store tables if they do not already exist.

    Idempotent via ``IF NOT EXISTS`` so it composes safely with
    ``PostgresStore._ensure_table`` (used as a dev-time safety net).
    """
    json_col = _jsonb_type()
    for table in _STORE_TABLES:
        op.create_table(
            table,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("data", json_col, nullable=False),
            if_not_exists=True,
        )


def downgrade() -> None:
    """Drop all store tables."""
    for table in reversed(_STORE_TABLES):
        op.drop_table(table, if_exists=True)
