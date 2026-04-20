#!/usr/bin/env python3
"""
Portal persistence migration CLI (CSA-0046 follow-on).

Copies records from a source portal store (SQLite or Postgres) into a
target store using the async :class:`~portal.shared.api.persistence_async.AsyncStoreBackend`
surface.  Idempotent + non-destructive: reads only from the source;
writes with ``INSERT ... ON CONFLICT (id) DO NOTHING`` semantics on
the target so re-running the migration is safe.

Usage::

    python scripts/migrate_portal_persistence.py \\
        --source sqlite:///./data/portal.db \\
        --target postgresql://portal@pg.example.com:5432/portal \\
        [--tables sources,pipelines,pipeline_runs,access_requests,marketplace_products,marketplace_quality] \\
        [--batch-size 500] \\
        [--dry-run]

Exit codes
----------
* 0 — success (all digests match).
* 1 — digest mismatch after migration.
* 2 — unreachable endpoint (connection error).
* 3 — args / validation error.
* 4 — unknown error.

Rollback
--------
The CLI never writes to the source, so the source database is untouched
by a failed migration.  Because every write uses ``ON CONFLICT DO
NOTHING``, re-running after a partial failure resumes cleanly.  If a
rollback of the target is required (e.g. to redo against a fresh
schema), truncate the target tables and re-run — the script does not
issue DDL, so that must be done manually with ``alembic downgrade``
or ``DROP TABLE``.

Azure managed identity
----------------------
When ``POSTGRES_USE_MANAGED_IDENTITY=true`` and the target URL lacks
an embedded password, the CLI reuses the token-provider logic from
:mod:`portal.shared.api.persistence_async` — no duplication.

See ADR-0016 for the async rationale.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any

# The script is often invoked directly (`python scripts/migrate...`),
# which means the repo root is NOT on ``sys.path`` by default.  Make
# the ``portal`` package importable without requiring ``pip install -e``.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Keep the import boundary tight: we only ever touch the async store
# Protocol + factory, never the sync compat layer.
from portal.shared.api.persistence_async import (  # noqa: E402
    AsyncStoreBackend,
    StoreBackendError,
    StoreConnectionError,
    build_async_store_backend,
    close_async_engines,
)

logger = logging.getLogger("csa.migrate_portal_persistence")


# ── Exit codes ──────────────────────────────────────────────────────────────

EXIT_SUCCESS = 0
EXIT_DIGEST_MISMATCH = 1
EXIT_UNREACHABLE = 2
EXIT_ARGS = 3
EXIT_UNKNOWN = 4


# ── Typed exceptions ────────────────────────────────────────────────────────


class MigrationDigestMismatchError(StoreBackendError):
    """Raised when post-migration row digests diverge between source + target."""


class MigrationPartialFailure(StoreBackendError):  # noqa: N818 — ticket-specified name
    """Raised when the migration completes but some rows failed to write."""


# ── Default table list ──────────────────────────────────────────────────────

DEFAULT_TABLES: tuple[str, ...] = (
    "sources",
    "pipelines",
    "pipeline_runs",
    "access_requests",
    "marketplace_products",
    "marketplace_quality",
)

# Logical store "filename" (what the router passes to the factory) per table.
_STORE_FILENAMES: dict[str, str] = {
    "sources": "sources.json",
    "pipelines": "pipelines.json",
    "pipeline_runs": "pipeline_runs.json",
    "access_requests": "access_requests.json",
    "marketplace_products": "marketplace_products.json",
    "marketplace_quality": "marketplace_quality.json",
}


# ── Per-table report ────────────────────────────────────────────────────────


@dataclass
class TableReport:
    """Accumulated metrics for one table's migration."""

    table: str
    rows_read: int = 0
    rows_inserted: int = 0
    rows_skipped_duplicate: int = 0
    digest_mismatches: int = 0
    elapsed_seconds: float = 0.0
    errors: list[str] = field(default_factory=list)


@dataclass
class MigrationReport:
    """Aggregated migration result across all tables."""

    tables: list[TableReport] = field(default_factory=list)
    total_elapsed_seconds: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_elapsed_seconds": round(self.total_elapsed_seconds, 3),
            "tables": [
                {
                    "table": t.table,
                    "rows_read": t.rows_read,
                    "rows_inserted": t.rows_inserted,
                    "rows_skipped_duplicate": t.rows_skipped_duplicate,
                    "digest_mismatches": t.digest_mismatches,
                    "elapsed_seconds": round(t.elapsed_seconds, 3),
                    "errors": t.errors,
                }
                for t in self.tables
            ],
        }


# ── Settings shim ───────────────────────────────────────────────────────────
#
# ``build_async_store_backend`` expects a pydantic Settings instance but
# only reads a handful of fields.  We build a tiny shim so the CLI does
# not need to import the full application config (which would force a
# .env load the operator may not want).


@dataclass
class _CliSettings:
    DATABASE_URL: str
    DATA_DIR: str = "./data"
    POSTGRES_USE_MANAGED_IDENTITY: bool = False
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20


def _sqlite_data_dir_from_url(url: str) -> str:
    """Extract the directory + honour the URL's file basename.

    ``sqlite:///./data/portal.db`` → ``"./data"`` (with db_name override
    still happening inside the store via its default ``portal.db``).

    Accepts ``sqlite:///path/to.db`` and returns the parent directory;
    the factory will use ``portal.db`` as the db name by default, so
    the URL's basename is only a documentation hint.
    """
    import os as _os
    import urllib.parse as _urlparse

    if not url.startswith("sqlite:"):
        return "./data"
    # sqlite:///relative/... or sqlite:////abs/... — strip the scheme.
    parsed = _urlparse.urlparse(url)
    path = parsed.path
    # On Windows, sqlite URLs look like sqlite:///C:/x/y.db — strip the
    # extra leading slash so os.path operations see "C:/x/y.db".
    if path.startswith("/") and len(path) > 2 and path[2] == ":":
        path = path[1:]
    if not path:
        return "./data"
    return _os.path.dirname(path) or "./data"


def _build_settings(url: str) -> _CliSettings:
    use_mi = (
        os.environ.get("POSTGRES_USE_MANAGED_IDENTITY", "").strip().lower()
        in {"1", "true", "yes"}
    )
    # Heuristic: MI is only enabled for Postgres URLs that lack an
    # embedded password.  A ``postgresql://user:pwd@host/db`` URL opts
    # out of MI transparently.
    if use_mi and _url_has_password(url):
        logger.info(
            "POSTGRES_USE_MANAGED_IDENTITY=true ignored because target URL has an "
            "embedded password; using password auth.",
        )
        use_mi = False
    data_dir = _sqlite_data_dir_from_url(url)
    return _CliSettings(
        DATABASE_URL=url,
        DATA_DIR=data_dir,
        POSTGRES_USE_MANAGED_IDENTITY=use_mi,
    )


def _url_has_password(url: str) -> bool:
    """Return True when *url* has an embedded ``user:password@`` segment."""
    at_idx = url.rfind("@")
    if at_idx < 0:
        return False
    prefix_idx = url.find("://")
    if prefix_idx < 0:
        return False
    creds = url[prefix_idx + 3 : at_idx]
    return ":" in creds


# ── Core migration loop ─────────────────────────────────────────────────────


def _row_digest(row: dict[str, Any]) -> str:
    """Canonical sha256 digest for a record.

    Keys are sorted so the digest is stable regardless of dict
    insertion order.  ``default=str`` handles datetimes the same way
    the store itself does.
    """
    payload = json.dumps(row, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


async def _migrate_table(
    table: str,
    source: AsyncStoreBackend,
    target: AsyncStoreBackend,
    *,
    batch_size: int,
    dry_run: bool,
) -> TableReport:
    """Copy one table end-to-end.

    Reads the full source table in batches, computes row digests, and
    upserts (or simulates upsert in dry-run) into the target.  The
    upsert uses ``ON CONFLICT DO NOTHING`` semantics so existing rows
    are preserved and counted as duplicates.
    """
    report = TableReport(table=table)
    start = perf_counter()

    # Read source.  AsyncStoreBackend does not expose a cursor-style
    # batch iterator (records are JSON blobs, not rows with offsets);
    # we pull the full list and slice into batches client-side.  The
    # portal stores are intentionally small (<10 MB per table) so
    # client-side batching is fine.
    try:
        rows = await source.list()
    except (OSError, StoreConnectionError) as exc:
        report.errors.append(f"source unreachable: {exc}")
        report.elapsed_seconds = perf_counter() - start
        raise StoreConnectionError(str(exc)) from exc

    report.rows_read = len(rows)
    source_digests = {str(row.get("id")): _row_digest(row) for row in rows}

    if dry_run:
        # Verify what we would insert, do not write.
        existing_ids: set[str] = {
            str(r.get("id")) for r in (await target.list())
        }
        report.rows_skipped_duplicate = sum(
            1 for rid in source_digests if rid in existing_ids
        )
        report.rows_inserted = len(source_digests) - report.rows_skipped_duplicate
        report.elapsed_seconds = perf_counter() - start
        return report

    # Write in batches.
    for idx in range(0, len(rows), batch_size):
        batch = rows[idx : idx + batch_size]
        for row in batch:
            rid = str(row.get("id", ""))
            if not rid:
                report.errors.append(f"row missing id: {row!r}")
                continue
            try:
                existing_row: dict[str, Any] | None = await target.get(rid)
            except (OSError, StoreConnectionError) as exc:
                report.errors.append(f"target unreachable while reading {rid}: {exc}")
                raise StoreConnectionError(str(exc)) from exc
            if existing_row is not None:
                report.rows_skipped_duplicate += 1
                continue
            try:
                await target.add(row)
            except (OSError, StoreConnectionError) as exc:
                report.errors.append(f"target unreachable while writing {rid}: {exc}")
                raise StoreConnectionError(str(exc)) from exc
            except Exception as exc:
                report.errors.append(f"write failed for id={rid}: {exc}")
                continue
            report.rows_inserted += 1

    # Post-write verification: recompute digests on the target.
    try:
        target_rows = await target.list()
    except (OSError, StoreConnectionError) as exc:
        report.errors.append(f"target unreachable during verify: {exc}")
        raise StoreConnectionError(str(exc)) from exc

    target_digests = {str(r.get("id")): _row_digest(r) for r in target_rows}
    for rid, src_digest in source_digests.items():
        tgt_digest = target_digests.get(rid)
        if tgt_digest is None:
            # Row known on source but missing on target — this counts as
            # a mismatch so operators do not trust a partial migration.
            report.digest_mismatches += 1
            report.errors.append(f"row {rid} missing on target after migrate")
        elif tgt_digest != src_digest:
            report.digest_mismatches += 1
            report.errors.append(
                f"digest mismatch for {rid}: src={src_digest[:12]} tgt={tgt_digest[:12]}",
            )

    report.elapsed_seconds = perf_counter() - start
    return report


async def run_migration(
    source_url: str,
    target_url: str,
    *,
    tables: tuple[str, ...] = DEFAULT_TABLES,
    batch_size: int = 500,
    dry_run: bool = False,
) -> MigrationReport:
    """Execute the migration and return an aggregated report.

    Raises
    ------
    StoreConnectionError
        When either endpoint is unreachable.
    MigrationDigestMismatchError
        When post-migration digests diverge (only raised after all
        tables have been attempted so operators see the full picture).
    """
    try:
        from tenacity import (  # noqa: F401 — presence check only
            retry,
            stop_after_attempt,
            wait_random_exponential,
        )
    except ImportError:  # pragma: no cover — optional dep
        logger.info("tenacity not installed; transient retries disabled.")

    overall_start = perf_counter()
    report = MigrationReport()

    src_settings = _build_settings(source_url)
    tgt_settings = _build_settings(target_url)

    try:
        for table in tables:
            if table not in _STORE_FILENAMES:
                logger.warning("Unknown table %r — skipping", table)
                report.tables.append(
                    TableReport(
                        table=table,
                        errors=[f"unknown table: {table!r}"],
                    ),
                )
                continue

            filename = _STORE_FILENAMES[table]
            # _CliSettings is structurally compatible with the Settings
            # fields the factory reads; cast to silence mypy.
            source = build_async_store_backend(
                filename, src_settings,  # type: ignore[arg-type]
            )
            target = build_async_store_backend(
                filename, tgt_settings,  # type: ignore[arg-type]
            )

            logger.info("Migrating table '%s' (dry_run=%s)", table, dry_run)
            table_report = await _migrate_table(
                table,
                source,
                target,
                batch_size=batch_size,
                dry_run=dry_run,
            )
            report.tables.append(table_report)
            await source.close()
            await target.close()
    finally:
        await close_async_engines()

    report.total_elapsed_seconds = perf_counter() - overall_start

    total_mismatches = sum(t.digest_mismatches for t in report.tables)
    if total_mismatches > 0 and not dry_run:
        raise MigrationDigestMismatchError(
            f"{total_mismatches} digest mismatches across "
            f"{len([t for t in report.tables if t.digest_mismatches])} tables; "
            "see report.",
        )
    return report


# ── CLI entry-point ─────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Migrate portal persistence records between SQLite and/or "
            "Postgres stores.  Idempotent + non-destructive; re-running "
            "is safe.  See ADR-0016 for rationale."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--source",
        required=True,
        help=(
            "Source DATABASE_URL (e.g. 'sqlite:///./data/portal.db' or "
            "'postgresql://user@host:5432/db').  Read-only."
        ),
    )
    parser.add_argument(
        "--target",
        required=True,
        help=(
            "Target DATABASE_URL (e.g. "
            "'postgresql://portal@pg.example.com:5432/portal').  "
            "Writes use INSERT ... ON CONFLICT DO NOTHING."
        ),
    )
    parser.add_argument(
        "--tables",
        default=",".join(DEFAULT_TABLES),
        help=(
            "Comma-separated list of tables to migrate.  Defaults to "
            "every portal store."
        ),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="Number of rows to write per batch (default 500).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and compute digests but do not write to the target.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (default INFO).",
    )
    return parser


def _configure_logging(level: str) -> None:
    try:
        from csa_platform.common.logging import configure_structlog

        configure_structlog(service="csa-portal-migrate", level=level)
    except ImportError:
        logging.basicConfig(
            level=getattr(logging, level.upper(), logging.INFO),
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    _configure_logging(args.log_level)

    if args.batch_size < 1:
        print("--batch-size must be >= 1", file=sys.stderr)
        return EXIT_ARGS

    tables = tuple(t.strip() for t in args.tables.split(",") if t.strip())
    unknown = [t for t in tables if t not in _STORE_FILENAMES]
    if unknown:
        print(
            f"Unknown tables: {unknown!r}. Valid options: {list(_STORE_FILENAMES)!r}",
            file=sys.stderr,
        )
        return EXIT_ARGS

    try:
        report = asyncio.run(
            run_migration(
                args.source,
                args.target,
                tables=tables,
                batch_size=args.batch_size,
                dry_run=args.dry_run,
            ),
        )
    except MigrationDigestMismatchError as exc:
        logger.error("Digest mismatch: %s", exc)
        return EXIT_DIGEST_MISMATCH
    except StoreConnectionError as exc:
        logger.error("Unreachable endpoint: %s", exc)
        return EXIT_UNREACHABLE
    except (ValueError, argparse.ArgumentTypeError) as exc:
        logger.error("Invalid arguments: %s", exc)
        return EXIT_ARGS
    except Exception as exc:
        logger.exception("Unknown migration failure: %s", exc)
        return EXIT_UNKNOWN

    print(json.dumps(report.to_dict(), indent=2))
    return EXIT_SUCCESS


if __name__ == "__main__":
    sys.exit(main())
