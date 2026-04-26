"""Tests for cost allocation and chargeback logic.

Tests CostAllocator: cost grouping by tag, proportional/equal/none
allocation strategies, text report generation, and CSV export.
"""

from __future__ import annotations

import csv
import io
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Bootstrap: add source dir to path and inject mock Azure SDK modules
# ---------------------------------------------------------------------------
_scripts = str(Path(__file__).resolve().parent.parent / "scripts")
if _scripts not in sys.path:
    sys.path.insert(0, _scripts)

for _m in [
    "azure",
    "azure.mgmt",
    "azure.mgmt.costmanagement",
    "azure.mgmt.costmanagement.models",
    "azure.identity",
]:
    sys.modules.setdefault(_m, MagicMock())
# ---------------------------------------------------------------------------

import pytest
from cost_allocator import (
    CostAllocator,
    CostEntry,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_entries() -> list[CostEntry]:
    """Build a set of cost entries for allocation tests."""
    return [
        CostEntry(
            resource_name="rg-usda",
            resource_group="rg-usda",
            meter_category="Azure Synapse Analytics",
            meter_subcategory="Compute",
            cost=100.0,
            date="2024-03-15",
            tags={"org": "USDA"},
        ),
        CostEntry(
            resource_name="rg-usda",
            resource_group="rg-usda",
            meter_category="Storage",
            meter_subcategory="",
            cost=50.0,
            date="2024-03-15",
            tags={"org": "USDA"},
        ),
        CostEntry(
            resource_name="rg-dod",
            resource_group="rg-dod",
            meter_category="Azure Synapse Analytics",
            meter_subcategory="Compute",
            cost=200.0,
            date="2024-03-16",
            tags={"org": "DOD"},
        ),
        CostEntry(
            resource_name="rg-shared",
            resource_group="rg-shared",
            meter_category="Bandwidth",
            meter_subcategory="",
            cost=30.0,
            date="2024-03-16",
            tags={"org": "untagged"},
        ),
    ]


@pytest.fixture
def allocator() -> None:
    """Return a CostAllocator with a mocked client."""
    alloc = CostAllocator(
        subscription_id="sub-1",
        credential=MagicMock(),
    )
    alloc._client = MagicMock()
    return alloc


# ---------------------------------------------------------------------------
# Cost grouping tests
# ---------------------------------------------------------------------------


class TestGetCostsByTag:
    """Test CostAllocator.get_costs_by_tag."""

    def test_parses_api_rows_into_cost_entries(self, allocator) -> None:
        mock_result = SimpleNamespace(
            columns=[
                SimpleNamespace(name="ResourceGroupName"),
                SimpleNamespace(name="MeterCategory"),
                SimpleNamespace(name="org"),
                SimpleNamespace(name="Cost"),
                SimpleNamespace(name="UsageQuantity"),
                SimpleNamespace(name="UsageDate"),
            ],
            rows=[
                ["rg-usda", "Azure Synapse Analytics", "USDA", 100.0, 10.0, "2024-03-15"],
                ["rg-dod", "Storage", "DOD", 50.0, 5.0, "2024-03-16"],
            ],
        )
        allocator._client.query.usage.return_value = mock_result

        entries = allocator.get_costs_by_tag(
            tag_name="org",
            start_date=date(2024, 3, 1),
            end_date=date(2024, 3, 31),
        )

        assert len(entries) == 2
        assert entries[0].cost == 100.0
        assert entries[0].tags == {"org": "USDA"}
        assert entries[1].meter_category == "Storage"

    def test_empty_api_result_returns_empty_list(self, allocator) -> None:
        mock_result = SimpleNamespace(columns=[], rows=[])
        allocator._client.query.usage.return_value = mock_result

        entries = allocator.get_costs_by_tag("org", date(2024, 3, 1), date(2024, 3, 31))
        assert entries == []


# ---------------------------------------------------------------------------
# Allocation strategy tests
# ---------------------------------------------------------------------------


class TestAllocateToOrgs:
    """Test the three allocation strategies: proportional, equal, none."""

    def test_proportional_allocation(self, allocator) -> None:
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org", shared_cost_strategy="proportional")

        assert report.total_cost == pytest.approx(380.0)
        assert report.shared_cost == pytest.approx(30.0)
        assert report.allocation_strategy == "proportional"
        assert len(report.org_summaries) == 2

        # USDA direct cost=150, DOD direct cost=200; shared=30
        # USDA share = 30 * 150/350 ~= 12.857
        # DOD share  = 30 * 200/350 ~= 17.143
        usda = next(s for s in report.org_summaries if s.org_name == "USDA")
        dod = next(s for s in report.org_summaries if s.org_name == "DOD")

        assert usda.shared_cost_allocation == pytest.approx(30 * 150 / 350, rel=1e-3)
        assert dod.shared_cost_allocation == pytest.approx(30 * 200 / 350, rel=1e-3)
        assert usda.total_cost == pytest.approx(150 + usda.shared_cost_allocation, rel=1e-3)

    def test_equal_allocation(self, allocator) -> None:
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org", shared_cost_strategy="equal")

        usda = next(s for s in report.org_summaries if s.org_name == "USDA")
        dod = next(s for s in report.org_summaries if s.org_name == "DOD")

        per_org = 30.0 / 2
        assert usda.shared_cost_allocation == pytest.approx(per_org)
        assert dod.shared_cost_allocation == pytest.approx(per_org)

    def test_none_allocation(self, allocator) -> None:
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org", shared_cost_strategy="none")

        for s in report.org_summaries:
            assert s.shared_cost_allocation == 0.0

        assert report.shared_cost == pytest.approx(30.0)

    def test_meter_category_classification(self, allocator) -> None:
        """Verify costs are bucketed by compute/storage/network/other."""
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org", shared_cost_strategy="none")

        usda = next(s for s in report.org_summaries if s.org_name == "USDA")
        assert usda.compute_cost == pytest.approx(100.0)
        assert usda.storage_cost == pytest.approx(50.0)

    def test_empty_entries_produces_empty_report(self, allocator) -> None:
        report = allocator.allocate_to_orgs([], "org")
        assert report.total_cost == 0.0
        assert len(report.org_summaries) == 0

    def test_report_sorted_by_cost_descending(self, allocator) -> None:
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org", shared_cost_strategy="none")

        costs = [s.total_cost for s in report.org_summaries]
        assert costs == sorted(costs, reverse=True)


# ---------------------------------------------------------------------------
# Report generation tests
# ---------------------------------------------------------------------------


class TestGenerateReport:
    """Test text report generation."""

    def test_report_contains_header_and_org_lines(self, allocator) -> None:
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org")
        text = allocator.generate_report(report)

        assert "CSA-in-a-Box Cost Allocation Report" in text
        assert "proportional" in text
        assert "USDA" in text
        assert "DOD" in text
        assert "$" in text


# ---------------------------------------------------------------------------
# CSV export tests
# ---------------------------------------------------------------------------


class TestExportCsv:
    """Test CSV export of allocation reports."""

    def test_csv_contains_all_orgs(self, allocator) -> None:
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org")
        csv_content = allocator.export_csv(report)

        reader = csv.DictReader(io.StringIO(csv_content))
        rows = list(reader)

        assert len(rows) == 2
        org_names = {r["org_name"] for r in rows}
        assert "USDA" in org_names
        assert "DOD" in org_names

    def test_csv_has_expected_columns(self, allocator) -> None:
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org")
        csv_content = allocator.export_csv(report)

        reader = csv.DictReader(io.StringIO(csv_content))
        row = next(reader)

        expected_cols = {
            "org_name",
            "total_cost",
            "compute_cost",
            "storage_cost",
            "network_cost",
            "other_cost",
            "shared_cost_allocation",
            "resource_count",
            "currency",
        }
        assert expected_cols.issubset(row.keys())

    def test_csv_export_to_file(self, allocator, tmp_path) -> None:
        entries = _make_entries()
        report = allocator.allocate_to_orgs(entries, "org")
        output_file = str(tmp_path / "cost_report.csv")

        csv_content = allocator.export_csv(report, output_path=output_file)

        assert len(csv_content) > 0
        with open(output_file, newline="") as f:
            assert f.read() == csv_content
