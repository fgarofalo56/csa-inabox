"""Tests for the Purview automation module.

Tests classification rule management, glossary term management,
scan scheduling, and lineage registration with mocked Purview client.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import yaml

from csa_platform.governance.purview.purview_automation import (
    PurviewAutomation,
    ScanSchedule,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_credential() -> MagicMock:
    """Create a mock Azure credential."""
    cred = MagicMock()
    mock_token = MagicMock()
    mock_token.token = "fake-access-token"
    cred.get_token.return_value = mock_token
    return cred


@pytest.fixture
def purview(mock_credential: MagicMock) -> PurviewAutomation:
    """Create a PurviewAutomation instance with mocked credential."""
    return PurviewAutomation(
        account_name="purview-test",
        credential=mock_credential,
    )


@pytest.fixture
def classification_yaml(tmp_path: Path) -> Path:
    """Create a temporary classification rules YAML file."""
    rules = {
        "classifications": [
            {
                "name": "SSN",
                "description": "Social Security Number",
                "category": "PII",
                "subcategory": "DirectIdentifier",
                "sensitivity": "Restricted",
                "dataPatterns": [{"pattern": "\\d{3}-\\d{2}-\\d{4}"}],
                "columnPatterns": [{"pattern": "(?i)ssn|social_security"}],
                "minimumPercentageMatch": 80.0,
            },
            {
                "name": "EmailAddress",
                "description": "Email address detection",
                "category": "PII",
                "subcategory": "ContactInfo",
                "sensitivity": "Confidential",
                "dataPatterns": [{"pattern": "[\\w.+-]+@[\\w-]+\\.[\\w.]+"}],
            },
        ],
    }
    yaml_path = tmp_path / "pii_classifications.yaml"
    with open(yaml_path, "w") as f:
        yaml.dump(rules, f)
    return yaml_path


@pytest.fixture
def glossary_yaml(tmp_path: Path) -> Path:
    """Create a temporary glossary YAML file."""
    glossary = {
        "glossaryName": "Test Glossary",
        "terms": [
            {
                "name": "Revenue",
                "definition": "Total income from product sales",
                "abbreviation": "REV",
                "status": "Approved",
                "contacts": [{"type": "Expert", "email": "finance@contoso.com"}],
                "relatedTerms": ["Net Revenue", "Gross Revenue"],
            },
            {
                "name": "Customer",
                "definition": "End user of services",
                "abbreviation": "CUST",
                "status": "Draft",
            },
        ],
    }
    yaml_path = tmp_path / "business_terms.yaml"
    with open(yaml_path, "w") as f:
        yaml.dump(glossary, f)
    return yaml_path


@pytest.fixture
def dbt_manifest(tmp_path: Path) -> Path:
    """Create a temporary dbt manifest.json file."""
    manifest = {
        "nodes": {
            "model.project.orders_cleaned": {
                "resource_type": "model",
                "name": "orders_cleaned",
                "package_name": "project",
                "depends_on": {"nodes": ["source.project.raw.orders"]},
            },
            "model.project.orders_enriched": {
                "resource_type": "model",
                "name": "orders_enriched",
                "package_name": "project",
                "depends_on": {"nodes": ["model.project.orders_cleaned"]},
            },
        },
        "sources": {
            "source.project.raw.orders": {
                "resource_type": "source",
                "name": "orders",
                "package_name": "project",
            },
        },
    }
    manifest_path = tmp_path / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f)
    return manifest_path


# ---------------------------------------------------------------------------
# Classification Rule Tests
# ---------------------------------------------------------------------------


class TestClassificationRules:
    """Test classification rule loading and application."""

    def test_load_classification_rules(self, purview: Any, classification_yaml: Any) -> None:
        rules = purview.load_classification_rules(classification_yaml)

        assert len(rules) == 2
        assert rules[0].name == "SSN"
        assert rules[0].category == "PII"
        assert rules[0].sensitivity == "Restricted"
        assert len(rules[0].data_patterns) == 1
        assert rules[0].minimum_percentage_match == 80.0

    def test_classification_payload_structure(self, purview: Any, classification_yaml: Any) -> None:
        rules = purview.load_classification_rules(classification_yaml)
        payload = purview._build_classification_payload(rules[0])

        assert payload["name"] == "SSN"
        assert payload["kind"] == "Custom"
        assert payload["properties"]["classificationName"] == "SSN"
        assert payload["properties"]["ruleStatus"] == "Enabled"
        assert "dataPatterns" in payload["properties"]

    @patch("requests.request")
    def test_apply_classification_rules_dry_run(self, mock_request: Any, purview: Any, classification_yaml: Any) -> None:
        results = purview.apply_classification_rules(classification_yaml, dry_run=True)

        assert len(results) == 2
        assert all(r["status"] == "dry_run" for r in results)
        mock_request.assert_not_called()

    @patch("requests.request")
    def test_apply_classification_rules(self, mock_request: Any, purview: Any, classification_yaml: Any) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = '{"status": "ok"}'
        mock_response.json.return_value = {"status": "ok"}
        mock_request.return_value = mock_response

        results = purview.apply_classification_rules(classification_yaml)

        assert len(results) == 2
        assert all(r["status"] == "applied" for r in results)


# ---------------------------------------------------------------------------
# Glossary Term Tests
# ---------------------------------------------------------------------------


class TestGlossaryTerms:
    """Test glossary term loading and import."""

    def test_load_glossary_terms(self, purview: Any, glossary_yaml: Any) -> None:
        terms = purview.load_glossary_terms(glossary_yaml)

        assert len(terms) == 2
        assert terms[0].name == "Revenue"
        assert terms[0].abbreviation == "REV"
        assert terms[0].status == "Approved"
        assert len(terms[0].contacts) == 1

    @patch("requests.request")
    def test_import_glossary_terms_dry_run(self, mock_request: Any, purview: Any, glossary_yaml: Any) -> None:
        results = purview.import_glossary_terms(glossary_yaml, dry_run=True)

        assert len(results) == 2
        assert all(r["status"] == "dry_run" for r in results)
        mock_request.assert_not_called()

    @patch("requests.request")
    def test_import_glossary_terms(self, mock_request: Any, purview: Any, glossary_yaml: Any) -> None:
        # Mock glossary list (empty, triggers create)
        mock_list_resp = MagicMock()
        mock_list_resp.status_code = 200
        mock_list_resp.text = "[]"
        mock_list_resp.json.return_value = []

        # Mock glossary create
        mock_create_resp = MagicMock()
        mock_create_resp.status_code = 200
        mock_create_resp.text = '{"guid": "test-guid"}'
        mock_create_resp.json.return_value = {"guid": "test-guid"}

        # Mock term import
        mock_term_resp = MagicMock()
        mock_term_resp.status_code = 200
        mock_term_resp.text = '{"guid": "term-guid"}'
        mock_term_resp.json.return_value = {"guid": "term-guid"}

        mock_request.side_effect = [mock_list_resp, mock_create_resp, mock_term_resp, mock_term_resp]

        results = purview.import_glossary_terms(glossary_yaml)

        assert len(results) == 2
        assert all(r["status"] == "imported" for r in results)


# ---------------------------------------------------------------------------
# Scan Scheduling Tests
# ---------------------------------------------------------------------------


class TestScanScheduling:
    """Test scan schedule creation."""

    @patch("requests.request")
    def test_schedule_scan_dry_run(self, mock_request: Any, purview: Any) -> None:
        schedule = ScanSchedule(
            source_name="adls-source",
            scan_name="weekly-scan",
            recurrence_interval=7,
        )

        result = purview.schedule_scan(schedule, dry_run=True)

        assert result["status"] == "dry_run"
        assert "payload" in result
        mock_request.assert_not_called()

    @patch("requests.request")
    def test_schedule_scan(self, mock_request: Any, purview: Any) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = '{"status": "ok"}'
        mock_response.json.return_value = {"status": "ok"}
        mock_request.return_value = mock_response

        schedule = ScanSchedule(
            source_name="adls-source",
            scan_name="daily-scan",
            recurrence_interval=1,
            scan_level="Full",
        )

        result = purview.schedule_scan(schedule)

        assert result["status"] == "scheduled"


# ---------------------------------------------------------------------------
# Lineage Registration Tests
# ---------------------------------------------------------------------------


class TestLineageRegistration:
    """Test ADF and dbt lineage registration."""

    @patch("requests.request")
    def test_register_adf_lineage_dry_run(self, mock_request: Any, purview: Any) -> None:
        result = purview.register_adf_lineage(
            pipeline_name="orders-etl",
            factory_name="adf-prod",
            source_datasets=["raw/orders"],
            sink_datasets=["silver/orders_cleaned"],
            dry_run=True,
        )

        assert result["status"] == "dry_run"
        assert result["entities"] > 0

    @patch("requests.request")
    def test_register_adf_lineage(self, mock_request: Any, purview: Any) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = '{"mutatedEntities": {}}'
        mock_response.json.return_value = {"mutatedEntities": {}}
        mock_request.return_value = mock_response

        result = purview.register_adf_lineage(
            pipeline_name="orders-etl",
            factory_name="adf-prod",
            source_datasets=["raw/orders"],
            sink_datasets=["silver/orders_cleaned"],
        )

        assert result["status"] == "registered"

    def test_register_dbt_lineage_dry_run(self, purview: Any, dbt_manifest: Any) -> None:
        result = purview.register_dbt_lineage(dbt_manifest, dry_run=True)

        assert result["status"] == "dry_run"
        assert result["relationships"] == 2  # orders_cleaned <- orders, orders_enriched <- orders_cleaned
        assert result["models"] == 2

    @patch("requests.request")
    def test_register_dbt_lineage(self, mock_request: Any, purview: Any, dbt_manifest: Any) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = '{"mutatedEntities": {}}'
        mock_response.json.return_value = {"mutatedEntities": {}}
        mock_request.return_value = mock_response

        result = purview.register_dbt_lineage(dbt_manifest)

        assert result["status"] == "registered"
        assert result["relationships"] == 2
