"""End-to-end streaming pipeline validation tests.

Validates the event schema, ASA query syntax, ADX materialized views,
and Bicep infrastructure alignment for the CSA-in-a-Box streaming
pipeline.  All tests run offline — no Azure connection required.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[2]
_STREAMING_DIR = _REPO_ROOT / "scripts" / "streaming"
_QUERIES_DIR = _STREAMING_DIR / "queries"
_ADX_SETUP_KQL = _STREAMING_DIR / "adx_setup.kql"

# Columns declared by ``.create-merge table RawEvents (...)`` in adx_setup.kql.
# Kept in sync manually — if the KQL changes, update this set.
_EXPECTED_RAW_EVENTS_COLUMNS = {
    "id",
    "source",
    "type",
    "timestamp",
    "data",
    "_ingested_at",
}

# Top-level fields produced by ``generate_event()`` in produce_events.py.
_EXPECTED_EVENT_FIELDS = {"id", "source", "type", "timestamp", "data"}

# Event types from produce_events.py EVENT_TYPES list.
_EXPECTED_EVENT_TYPES = {
    "page_view",
    "button_click",
    "form_submit",
    "search_query",
    "add_to_cart",
    "checkout_start",
    "purchase_complete",
    "error",
    "sensor_reading",
    "heartbeat",
}


# ===================================================================
# Helpers
# ===================================================================


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _generate_sample_event() -> dict[str, Any]:
    """Import and invoke the event generator from produce_events.py."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "produce_events",
        _STREAMING_DIR / "produce_events.py",
    )
    assert spec is not None
    assert spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.generate_event(0)  # type: ignore[no-any-return]


# ===================================================================
# Tests: Event schema matches ADX RawEvents table
# ===================================================================


class TestEventSchemaAlignment:
    """The event produced by ``produce_events.py`` must contain
    exactly the top-level fields expected by the ADX RawEvents table."""

    def test_event_has_expected_top_level_fields(self) -> None:
        event = _generate_sample_event()
        actual_keys = set(event.keys())
        missing = _EXPECTED_EVENT_FIELDS - actual_keys
        assert not missing, f"Event missing fields expected by ADX: {missing}"

    def test_event_type_is_known(self) -> None:
        """Every event type declared in produce_events.py must be in the known set.

        Iterates the full EVENT_TYPES list from the producer module rather than
        sampling a single random event, so that a new or renamed type is always
        caught regardless of random selection.
        """
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "produce_events",
            _STREAMING_DIR / "produce_events.py",
        )
        assert spec is not None
        assert spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        producer_event_types: list[str] = mod.EVENT_TYPES
        assert len(producer_event_types) > 0, "produce_events.py EVENT_TYPES list is empty"

        unknown = set(producer_event_types) - _EXPECTED_EVENT_TYPES
        assert not unknown, (
            f"produce_events.py declares event types not in _EXPECTED_EVENT_TYPES: {unknown}"
        )

        missing = _EXPECTED_EVENT_TYPES - set(producer_event_types)
        assert not missing, (
            f"_EXPECTED_EVENT_TYPES contains types not found in produce_events.py: {missing}"
        )

    def test_event_data_has_session_and_region(self) -> None:
        """The ``data`` payload should include at minimum the fields
        that the ADX materialized views reference."""
        event = _generate_sample_event()
        data = event.get("data", {})
        assert "session_id" in data, "Event data missing session_id"
        assert "region" in data, "Event data missing region"

    def test_adx_raw_events_table_columns(self) -> None:
        """Parse adx_setup.kql and verify the RawEvents column names."""
        if not _ADX_SETUP_KQL.exists():
            pytest.skip("adx_setup.kql not found")

        kql = _read_text(_ADX_SETUP_KQL)

        # Extract column declarations from `.create-merge table RawEvents (...)`
        match = re.search(
            r"\.create-merge\s+table\s+RawEvents\s*\((.*?)\)",
            kql,
            re.DOTALL,
        )
        assert match, "Could not find RawEvents table definition in KQL"

        columns_block = match.group(1)
        # Parse "column_name: type" pairs
        column_names = set()
        for line in columns_block.split(","):
            line = line.strip()
            if ":" in line:
                col_name = line.split(":")[0].strip()
                column_names.add(col_name)

        assert column_names == _EXPECTED_RAW_EVENTS_COLUMNS, (
            f"ADX RawEvents columns mismatch.\n  Expected: {_EXPECTED_RAW_EVENTS_COLUMNS}\n  Got:      {column_names}"
        )


# ===================================================================
# Tests: ASAQL query files are syntactically valid
# ===================================================================


class TestAsaqlSyntax:
    """Basic structural validation for .asaql (Azure Stream Analytics
    SQL-like) query files."""

    @staticmethod
    def _find_asaql_files() -> list[Path]:
        if not _QUERIES_DIR.exists():
            return []
        return sorted(_QUERIES_DIR.glob("*.asaql"))

    def test_asaql_files_exist(self) -> None:
        files = self._find_asaql_files()
        assert len(files) > 0, "No .asaql files found in scripts/streaming/queries/"

    @pytest.mark.parametrize(
        "asaql_path",
        sorted((Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "queries").glob("*.asaql"))
        if (Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "queries").exists()
        else [],
        ids=lambda p: p.name,
    )
    def test_asaql_has_select_and_from(self, asaql_path: Path) -> None:
        """Every ASAQL file should contain at least SELECT and FROM
        keywords — the bare minimum for a valid Stream Analytics query."""
        content = _read_text(asaql_path).upper()
        # Strip SQL comments for cleaner keyword checks
        content_no_comments = re.sub(r"--.*$", "", content, flags=re.MULTILINE)

        assert "SELECT" in content_no_comments, f"{asaql_path.name}: missing SELECT keyword"
        assert "FROM" in content_no_comments, f"{asaql_path.name}: missing FROM keyword"

    @pytest.mark.parametrize(
        "asaql_path",
        sorted((Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "queries").glob("*.asaql"))
        if (Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "queries").exists()
        else [],
        ids=lambda p: p.name,
    )
    def test_asaql_has_into_clause(self, asaql_path: Path) -> None:
        """Stream Analytics queries should specify an output with INTO."""
        content = _read_text(asaql_path).upper()
        content_no_comments = re.sub(r"--.*$", "", content, flags=re.MULTILINE)
        assert "INTO" in content_no_comments, f"{asaql_path.name}: missing INTO clause (no output sink defined)"

    @pytest.mark.parametrize(
        "asaql_path",
        sorted((Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "queries").glob("*.asaql"))
        if (Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "queries").exists()
        else [],
        ids=lambda p: p.name,
    )
    def test_asaql_balanced_parentheses(self, asaql_path: Path) -> None:
        """Parentheses should be balanced in every query file."""
        content = _read_text(asaql_path)
        open_count = content.count("(")
        close_count = content.count(")")
        assert open_count == close_count, (
            f"{asaql_path.name}: unbalanced parentheses ({open_count} open, {close_count} close)"
        )

    @pytest.mark.parametrize(
        "asaql_path",
        sorted((Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "queries").glob("*.asaql"))
        if (Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "queries").exists()
        else [],
        ids=lambda p: p.name,
    )
    def test_asaql_not_empty(self, asaql_path: Path) -> None:
        """Query files should not be empty."""
        content = _read_text(asaql_path).strip()
        assert len(content) > 0, f"{asaql_path.name}: file is empty"


# ===================================================================
# Tests: ADX materialized views reference correct source tables
# ===================================================================


class TestAdxMaterializedViews:
    """Verify ADX materialized views in adx_setup.kql reference
    the RawEvents source table."""

    def test_adx_setup_kql_exists(self) -> None:
        """adx_setup.kql must be present in scripts/streaming/.

        This test fails (rather than skipping) if the file is deleted, so
        accidental removal is caught immediately in CI.
        """
        assert _ADX_SETUP_KQL.exists(), (
            f"adx_setup.kql not found at expected path: {_ADX_SETUP_KQL}\n"
            "If you moved or renamed the file, update _ADX_SETUP_KQL in this test module."
        )

    def test_materialized_views_reference_raw_events(self) -> None:
        if not _ADX_SETUP_KQL.exists():
            pytest.skip("adx_setup.kql not found")

        kql = _read_text(_ADX_SETUP_KQL)

        # Find all materialized-view definitions
        mv_pattern = re.compile(
            r"\.create-or-alter\s+materialized-view\s+(\w+)\s+on\s+table\s+(\w+)",
            re.IGNORECASE,
        )
        matches = mv_pattern.findall(kql)
        assert len(matches) > 0, "No materialized views found in adx_setup.kql"

        for view_name, source_table in matches:
            assert source_table == "RawEvents", (
                f"Materialized view {view_name!r} references {source_table!r} instead of 'RawEvents'"
            )

    def test_materialized_views_have_summarize(self) -> None:
        """Materialized views should contain a summarize clause."""
        if not _ADX_SETUP_KQL.exists():
            pytest.skip("adx_setup.kql not found")

        kql = _read_text(_ADX_SETUP_KQL)

        # Extract materialized view bodies
        mv_blocks = re.findall(
            r"\.create-or-alter\s+materialized-view\s+\w+\s+on\s+table\s+\w+\s*\{(.*?)\}",
            kql,
            re.DOTALL | re.IGNORECASE,
        )
        for block in mv_blocks:
            assert "summarize" in block.lower(), "A materialized view is missing a 'summarize' clause"


# ===================================================================
# Tests: Consumer group / Event Hub naming
# ===================================================================


class TestBicepEventHubConfig:
    """Validate that Bicep params reference expected Event Hub values.

    These are structural checks only — no Azure connection needed.
    """

    def test_asaql_references_eventhub_input(self) -> None:
        """All .asaql files should reference [EventHubInput] as their
        source — matching the naming convention in Bicep."""
        for asaql_path in sorted(_QUERIES_DIR.glob("*.asaql")):
            content = _read_text(asaql_path)
            # Check for EventHubInput reference (case-insensitive)
            assert re.search(r"\[EventHubInput\]", content, re.IGNORECASE), (
                f"{asaql_path.name}: does not reference [EventHubInput]"
            )

    def test_adx_streaming_ingestion_enabled(self) -> None:
        """The KQL setup should enable streaming ingestion on RawEvents."""
        if not _ADX_SETUP_KQL.exists():
            pytest.skip("adx_setup.kql not found")

        kql = _read_text(_ADX_SETUP_KQL)
        assert "streamingingestion" in kql.lower(), "adx_setup.kql should enable streaming ingestion on RawEvents"

    def test_adx_retention_policy_set(self) -> None:
        """The KQL setup should define a retention policy for RawEvents."""
        if not _ADX_SETUP_KQL.exists():
            pytest.skip("adx_setup.kql not found")

        kql = _read_text(_ADX_SETUP_KQL)
        assert "retention" in kql.lower(), "adx_setup.kql should define a retention policy for RawEvents"

    def test_adx_ingestion_mapping_exists(self) -> None:
        """The KQL setup should define a JSON ingestion mapping."""
        if not _ADX_SETUP_KQL.exists():
            pytest.skip("adx_setup.kql not found")

        kql = _read_text(_ADX_SETUP_KQL)
        assert "ingestion json mapping" in kql.lower(), (
            "adx_setup.kql should define a JSON ingestion mapping for RawEvents"
        )
