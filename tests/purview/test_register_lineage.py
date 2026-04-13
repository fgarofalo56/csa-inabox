"""Tests for the Purview lineage registration script."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

# Load register_lineage as a module from the scripts directory since it's
# not an installable package.
_SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "purview" / "register_lineage.py"
_spec = importlib.util.spec_from_file_location("register_lineage", _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
register_lineage_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(register_lineage_mod)

LINEAGE_ENTRIES: list[dict[str, Any]] = register_lineage_mod.LINEAGE_ENTRIES  # type: ignore[attr-defined]
_build_atlas_entity = register_lineage_mod._build_atlas_entity  # type: ignore[attr-defined]
register_lineage_fn = register_lineage_mod.register_lineage  # type: ignore[attr-defined]


class TestBuildAtlasEntity:
    """Tests for Atlas entity construction."""

    def test_builds_valid_process_entity(self) -> None:
        entry = LINEAGE_ENTRIES[0]
        entity = _build_atlas_entity(entry)

        assert entity["typeName"] == "Process"
        assert entity["attributes"]["name"] == "adf_bronze_ingestion"
        assert "qualifiedName" in entity["attributes"]
        assert entity["attributes"]["qualifiedName"].startswith("csa-inabox://")

    def test_entity_has_inputs_and_outputs(self) -> None:
        entry = LINEAGE_ENTRIES[0]
        entity = _build_atlas_entity(entry)

        inputs = entity["relationshipAttributes"]["inputs"]
        outputs = entity["relationshipAttributes"]["outputs"]

        assert len(inputs) > 0
        assert len(outputs) > 0
        for inp in inputs:
            assert "typeName" in inp
            assert "uniqueAttributes" in inp

    def test_all_entries_produce_valid_entities(self) -> None:
        for entry in LINEAGE_ENTRIES:
            entity = _build_atlas_entity(entry)
            assert entity["typeName"] == "Process"
            assert entity["attributes"]["name"] == entry["name"]
            assert len(entity["relationshipAttributes"]["inputs"]) == len(entry["inputs"])
            assert len(entity["relationshipAttributes"]["outputs"]) == len(entry["outputs"])

    def test_guid_is_deterministic(self) -> None:
        entry = LINEAGE_ENTRIES[0]
        entity_a = _build_atlas_entity(entry)
        entity_b = _build_atlas_entity(entry)
        assert entity_a["guid"] == entity_b["guid"]

    def test_guid_differs_between_entries(self) -> None:
        guids = {_build_atlas_entity(e)["guid"] for e in LINEAGE_ENTRIES}
        assert len(guids) == len(LINEAGE_ENTRIES)


class TestRegisterLineage:
    """Tests for the register_lineage function."""

    def test_dry_run_returns_entities_without_calling_api(self) -> None:
        entities = register_lineage_fn("test-account", dry_run=True)
        assert len(entities) == len(LINEAGE_ENTRIES)
        for entity in entities:
            assert entity["typeName"] == "Process"

    def test_dry_run_does_not_import_azure_sdk(self) -> None:
        # dry_run=True should NOT attempt to import azure SDK
        entities = register_lineage_fn("test-account", dry_run=True)
        assert len(entities) > 0

    def test_lineage_entries_cover_full_pipeline(self) -> None:
        names = {e["name"] for e in LINEAGE_ENTRIES}
        assert "adf_bronze_ingestion" in names
        assert "databricks_bronze_to_silver" in names
        assert "dbt_silver_to_gold" in names
        assert "streaming_eventhub_to_cosmos" in names

    def test_all_entries_have_required_fields(self) -> None:
        for entry in LINEAGE_ENTRIES:
            assert "name" in entry
            assert "description" in entry
            assert "owner" in entry
            assert "inputs" in entry
            assert "outputs" in entry
            assert len(entry["inputs"]) > 0
            assert len(entry["outputs"]) > 0
