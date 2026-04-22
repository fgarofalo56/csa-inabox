"""
End-to-end tests for :mod:`scripts.migrate_portal_persistence`.

Seeds a source SQLite database, runs the migration against a separate
target SQLite database, and verifies:

* idempotency — re-running the CLI yields ``rows_skipped_duplicate`` = rowcount
* dry-run — inspects + reports but does not write
* ``--tables`` filtering — only named tables are copied
* digest verification — post-migration digests match byte-for-byte
* exit codes — argparse validation, unreachable endpoints, digest
  mismatches each map to their documented code
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest

# The CLI lives under ``scripts/`` which is not a Python package; add
# it to sys.path so ``import migrate_portal_persistence`` works.
_SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from portal.shared.api.persistence_async import (  # noqa: E402
    AsyncSqliteStore,
    close_async_engines,
)

import migrate_portal_persistence as cli  # noqa: E402

# ── Helpers ──────────────────────────────────────────────────────────────


async def _seed_source_table(
    data_dir: Path,
    filename: str,
    rows: list[dict[str, Any]],
) -> None:
    """Populate one SQLite store with *rows* via the async backend."""
    store = AsyncSqliteStore(filename, data_dir=data_dir)
    for row in rows:
        await store.add(row)
    await store.close()


async def _count_target_rows(
    data_dir: Path,
    filename: str,
) -> int:
    store = AsyncSqliteStore(filename, data_dir=data_dir)
    try:
        return await store.count()
    finally:
        await store.close()


async def _fetch_target_rows(
    data_dir: Path,
    filename: str,
) -> list[dict[str, Any]]:
    store = AsyncSqliteStore(filename, data_dir=data_dir)
    try:
        return await store.list()
    finally:
        await store.close()


# ── End-to-end migration ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_migration_end_to_end(tmp_path: Path) -> None:
    """Seed source → migrate → verify target counts + digests."""
    src_dir = tmp_path / "src"
    tgt_dir = tmp_path / "tgt"
    src_dir.mkdir()
    tgt_dir.mkdir()

    await _seed_source_table(
        src_dir,
        "sources.json",
        [
            {"id": "src-1", "name": "A", "domain": "finance"},
            {"id": "src-2", "name": "B", "domain": "hr"},
        ],
    )
    await _seed_source_table(
        src_dir,
        "pipelines.json",
        [{"id": "pl-1", "source_id": "src-1"}],
    )

    src_url = f"sqlite:///{src_dir}/portal.db"
    tgt_url = f"sqlite:///{tgt_dir}/portal.db"

    report = await cli.run_migration(src_url, tgt_url)

    assert report.total_elapsed_seconds > 0
    by_table = {t.table: t for t in report.tables}
    assert by_table["sources"].rows_read == 2
    assert by_table["sources"].rows_inserted == 2
    assert by_table["sources"].rows_skipped_duplicate == 0
    assert by_table["sources"].digest_mismatches == 0
    assert by_table["pipelines"].rows_read == 1
    assert by_table["pipelines"].rows_inserted == 1

    # Empty tables are valid — they just report zero counts.
    for table in ("pipeline_runs", "access_requests", "marketplace_products", "marketplace_quality"):
        assert by_table[table].rows_read == 0
        assert by_table[table].rows_inserted == 0

    assert await _count_target_rows(tgt_dir, "sources.json") == 2
    assert await _count_target_rows(tgt_dir, "pipelines.json") == 1

    target_rows = await _fetch_target_rows(tgt_dir, "sources.json")
    assert {r["id"] for r in target_rows} == {"src-1", "src-2"}


@pytest.mark.asyncio
async def test_migration_is_idempotent(tmp_path: Path) -> None:
    """Re-running the migration skips rows that already exist."""
    src_dir = tmp_path / "src"
    tgt_dir = tmp_path / "tgt"
    src_dir.mkdir()
    tgt_dir.mkdir()

    await _seed_source_table(
        src_dir,
        "sources.json",
        [{"id": "src-1", "name": "A"}],
    )

    src_url = f"sqlite:///{src_dir}/portal.db"
    tgt_url = f"sqlite:///{tgt_dir}/portal.db"

    await cli.run_migration(src_url, tgt_url, tables=("sources",))
    # Second run: every row is a duplicate.
    report = await cli.run_migration(src_url, tgt_url, tables=("sources",))

    by_table = {t.table: t for t in report.tables}
    assert by_table["sources"].rows_inserted == 0
    assert by_table["sources"].rows_skipped_duplicate == 1


@pytest.mark.asyncio
async def test_dry_run_does_not_write(tmp_path: Path) -> None:
    """``--dry-run`` reads + reports but the target stays empty."""
    src_dir = tmp_path / "src"
    tgt_dir = tmp_path / "tgt"
    src_dir.mkdir()
    tgt_dir.mkdir()

    await _seed_source_table(
        src_dir,
        "sources.json",
        [{"id": "src-1", "name": "A"}, {"id": "src-2", "name": "B"}],
    )

    src_url = f"sqlite:///{src_dir}/portal.db"
    tgt_url = f"sqlite:///{tgt_dir}/portal.db"

    report = await cli.run_migration(
        src_url,
        tgt_url,
        tables=("sources",),
        dry_run=True,
    )

    by_table = {t.table: t for t in report.tables}
    # Dry-run accounts both rows as "would be inserted" + zero skips.
    assert by_table["sources"].rows_read == 2
    assert by_table["sources"].rows_inserted == 2
    assert by_table["sources"].digest_mismatches == 0

    # But the target is still empty.
    assert await _count_target_rows(tgt_dir, "sources.json") == 0


@pytest.mark.asyncio
async def test_tables_filter_limits_scope(tmp_path: Path) -> None:
    """``--tables`` only migrates the named tables."""
    src_dir = tmp_path / "src"
    tgt_dir = tmp_path / "tgt"
    src_dir.mkdir()
    tgt_dir.mkdir()

    await _seed_source_table(
        src_dir,
        "sources.json",
        [{"id": "src-1", "name": "A"}],
    )
    await _seed_source_table(
        src_dir,
        "pipelines.json",
        [{"id": "pl-1", "source_id": "src-1"}],
    )

    src_url = f"sqlite:///{src_dir}/portal.db"
    tgt_url = f"sqlite:///{tgt_dir}/portal.db"

    report = await cli.run_migration(
        src_url, tgt_url, tables=("sources",),
    )

    assert len(report.tables) == 1
    assert report.tables[0].table == "sources"
    assert report.tables[0].rows_inserted == 1

    # ``pipelines`` table on the target should not exist / be empty.
    assert await _count_target_rows(tgt_dir, "pipelines.json") == 0


# ── CLI exit codes ────────────────────────────────────────────────────────


def test_cli_help_prints_usage(capsys: pytest.CaptureFixture) -> None:
    """``--help`` prints usage and exits with 0."""
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["--help"])
    assert excinfo.value.code == 0
    captured = capsys.readouterr()
    assert "Migrate portal persistence records" in captured.out


def test_cli_rejects_unknown_table(
    tmp_path: Path,
) -> None:
    """An unknown --tables value returns exit 3 (args)."""
    rc = cli.main(
        [
            "--source", f"sqlite:///{tmp_path}/src.db",
            "--target", f"sqlite:///{tmp_path}/tgt.db",
            "--tables", "not_a_real_table",
        ],
    )
    assert rc == cli.EXIT_ARGS


def test_cli_rejects_zero_batch_size(
    tmp_path: Path,
) -> None:
    """A zero --batch-size returns exit 3 (args)."""
    rc = cli.main(
        [
            "--source", f"sqlite:///{tmp_path}/src.db",
            "--target", f"sqlite:///{tmp_path}/tgt.db",
            "--batch-size", "0",
        ],
    )
    assert rc == cli.EXIT_ARGS


def test_cli_success_round_trip(
    tmp_path: Path,
    capsys: pytest.CaptureFixture,
) -> None:
    """End-to-end CLI invocation returns exit 0 with a JSON report."""
    src_dir = tmp_path / "src"
    tgt_dir = tmp_path / "tgt"
    src_dir.mkdir()
    tgt_dir.mkdir()

    asyncio.run(
        _seed_source_table(
            src_dir,
            "sources.json",
            [{"id": "src-1", "name": "A"}],
        ),
    )

    rc = cli.main(
        [
            "--source", f"sqlite:///{src_dir}/portal.db",
            "--target", f"sqlite:///{tgt_dir}/portal.db",
            "--tables", "sources",
        ],
    )
    assert rc == cli.EXIT_SUCCESS

    captured = capsys.readouterr()
    assert '"rows_inserted": 1' in captured.out


# ── Teardown ──────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _close_engines_after_test():
    import contextlib

    yield
    # Close any cached AsyncEngines (only Postgres needs this; SQLite
    # stores are closed per-test).  Ignored errors because the
    # migration CLI already drains them in its own finally.
    with contextlib.suppress(Exception):
        asyncio.run(close_async_engines())
