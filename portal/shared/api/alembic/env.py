"""
Alembic environment script for the portal backend (CSA-0046).

Loads ``DATABASE_URL`` from the application :mod:`portal.shared.api.config`
so SQLite (local dev) and Postgres (Azure Flexible Server) share the
same migration workflow without duplicate configuration.

For Azure Database for PostgreSQL Flexible Server with managed
identity, set ``POSTGRES_USE_MANAGED_IDENTITY=true`` in the environment
— this script then fetches a short-lived AAD token and injects it as
the connection password via the SQLAlchemy ``do_connect`` event, the
same mechanism used by :mod:`portal.shared.api.persistence_postgres`.
"""

from __future__ import annotations

import os
import re
import sys
import time
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, event, pool

# ── sys.path bootstrap ──────────────────────────────────────────────────
# Make the repository root importable so ``portal.shared.api.config`` and
# ``persistence_postgres`` resolve when Alembic is invoked from anywhere.

_THIS_FILE = Path(__file__).resolve()
_REPO_ROOT = _THIS_FILE.parents[4]  # portal/shared/api/alembic/env.py → repo root
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from portal.shared.api.config import settings  # noqa: E402 — after sys.path tweak

# Alembic Config object provides access to the values within the .ini file.
config = context.config

# Configure Python logging from the .ini file.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# No ORM models today — stores are schemaless JSON blobs.  Future type-aware
# migrations (e.g. promoting a JSONB field to a typed column) will set
# ``target_metadata = Base.metadata`` here.
target_metadata = None


# ── URL resolution ──────────────────────────────────────────────────────


def _resolve_database_url() -> str:
    """Resolve the effective DATABASE_URL for migrations.

    Order of precedence:
        1. ``ALEMBIC_DATABASE_URL`` env var (explicit override)
        2. ``sqlalchemy.url`` in alembic.ini (if set)
        3. ``settings.DATABASE_URL`` from the application config
    """
    override = os.getenv("ALEMBIC_DATABASE_URL")
    if override:
        return override
    ini_url = config.get_main_option("sqlalchemy.url")
    if ini_url:
        return ini_url
    return settings.DATABASE_URL or f"sqlite:///{settings.DATA_DIR}/portal.db"


def _coerce_to_sync_driver(url: str) -> str:
    """Rewrite async Postgres URLs to the sync psycopg driver.

    Alembic runs synchronously here; if ``settings.DATABASE_URL`` is an
    ``asyncpg`` URL it must be swapped for ``psycopg`` so the standard
    engine_from_config path works.
    """
    if url.startswith("postgresql+asyncpg://"):
        return url.replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def _redact_password(url: str) -> str:
    """Strip an embedded password before logging."""
    return re.sub(r"(?<=://)([^:/@]+):([^@]+)@", r"\1:***@", url)


# ── Offline mode ────────────────────────────────────────────────────────


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode — emits SQL to stdout."""
    url = _coerce_to_sync_driver(_resolve_database_url())
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


# ── Online mode ─────────────────────────────────────────────────────────


def _build_engine() -> Engine:  # type: ignore[name-defined]  # noqa: F821
    """Construct a SQLAlchemy engine honouring managed-identity settings."""
    url = _coerce_to_sync_driver(_resolve_database_url())
    cfg_section = config.get_section(config.config_ini_section, {}) or {}
    cfg_section["sqlalchemy.url"] = url

    engine = engine_from_config(
        cfg_section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    # Managed-identity token injection.  Only applied for Postgres URLs
    # when the app setting is enabled — SQLite does not use passwords.
    if (
        url.startswith("postgresql")
        and getattr(settings, "POSTGRES_USE_MANAGED_IDENTITY", False)
    ):
        from azure.identity import DefaultAzureCredential

        credential = DefaultAzureCredential()
        cache: dict[str, float | str] = {"token": "", "expires_on": 0.0}

        def _get_token() -> str:
            now = time.time()
            expires_on = float(cache["expires_on"] or 0.0)
            if not cache["token"] or now >= expires_on - 300:
                tok = credential.get_token(
                    "https://ossrdbms-aad.database.windows.net/.default",
                )
                cache["token"] = tok.token
                cache["expires_on"] = float(tok.expires_on)
            return str(cache["token"])

        @event.listens_for(engine, "do_connect")
        def _inject_aad_token(
            _dialect, _conn_rec, _cargs, cparams,
        ):
            # SQLAlchemy supplies dialect / conn_rec / cargs positionally;
            # they are unused here (prefix ``_`` silences lint).
            cparams["password"] = _get_token()

    return engine


def run_migrations_online() -> None:
    """Run migrations with a live database connection."""
    connectable = _build_engine()

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


# ── Dispatch ────────────────────────────────────────────────────────────


_resolved_url = _resolve_database_url()
print(f"[alembic] Using database: {_redact_password(_resolved_url)}", file=sys.stderr)

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
