"""Tests for the platform/purview_governance module.

Covers:
- PurviewAutomation dataclasses (ClassificationRule, GlossaryTerm, ScanSchedule, LineageRelationship)
- PurviewAutomation YAML loading (classification rules, glossary terms)
- PurviewAutomation dry-run paths (apply classifications, import glossary, schedule scan,
  register ADF lineage, register dbt lineage, apply sensitivity labels)
- PurviewAutomation _build_classification_payload logic
- PurviewAutomation _make_request (mocked requests + credential)
- SharingEnforcer validate_request (approved, expired, access level exceeded,
  PII denied, PHI denied, sensitivity exceeded, copy denied)
- SharingAgreement / ValidationResult dataclasses
- load_agreement / load_agreements (YAML parsing, directory loading)
- SharingEnforcer list_agreements_for_domain, get_expired_agreements, get_expiring_soon

Mocking strategy
----------------
All Azure SDK / HTTP interactions are mocked with ``MagicMock``.  The
Purview REST API calls go through ``_make_request`` which is mocked for
non-dry-run paths.  ``requests`` and ``credential`` objects are replaced
with ``MagicMock`` instances.  YAML files for classification rules,
glossary terms, and sharing agreements are written to temp directories.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import yaml

from governance.common.logging import reset_logging_state

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset structlog state between tests."""
    reset_logging_state()
    yield
    reset_logging_state()


@pytest.fixture
def mock_credential() -> MagicMock:
    """Return a mock Azure credential."""
    cred = MagicMock()
    token_obj = MagicMock()
    token_obj.token = "mock-access-token"
    cred.get_token.return_value = token_obj
    return cred


@pytest.fixture
def purview(mock_credential: MagicMock) -> Any:
    """Create a PurviewAutomation instance with a mock credential."""
    from csa_platform.purview_governance.purview_automation import (  # type: ignore[import-untyped]
        PurviewAutomation,
    )

    return PurviewAutomation(
        account_name="test-purview",
        credential=mock_credential,
    )


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


def _write_classification_yaml(tmp_path: Path, rules: list[dict[str, Any]]) -> Path:
    """Write a classification rules YAML file and return its path."""
    data = {"classifications": rules}
    yaml_file = tmp_path / "classifications.yaml"
    yaml_file.write_text(yaml.dump(data), encoding="utf-8")
    return yaml_file


def _write_glossary_yaml(
    tmp_path: Path,
    terms: list[dict[str, Any]],
    glossary_name: str = "CSA Business Glossary",
) -> Path:
    """Write a glossary YAML file and return its path."""
    data = {"glossaryName": glossary_name, "terms": terms}
    yaml_file = tmp_path / "glossary.yaml"
    yaml_file.write_text(yaml.dump(data), encoding="utf-8")
    return yaml_file


def _write_label_policy_yaml(tmp_path: Path, policies: list[dict[str, Any]]) -> Path:
    """Write an auto-labeling policy YAML file and return its path."""
    data = {"autoLabelingPolicies": policies}
    yaml_file = tmp_path / "labels.yaml"
    yaml_file.write_text(yaml.dump(data), encoding="utf-8")
    return yaml_file


def _make_agreement_yaml(
    *,
    provider_domain: str = "finance",
    consumer_domain: str = "sales",
    data_products: list[str] | None = None,
    access_level: str = "read",
    pii_allowed: bool = False,
    phi_allowed: bool = False,
    max_sensitivity: str = "Confidential",
    expires_at: str | None = None,
    copy_allowed: bool = False,
    name: str = "finance-to-sales",
) -> dict[str, Any]:
    """Build a valid sharing agreement YAML structure."""
    products = data_products or ["invoices"]
    agreement: dict[str, Any] = {
        "metadata": {"name": name, "version": "1.0"},
        "provider": {
            "domain": provider_domain,
            "owner": "provider@contoso.com",
            "dataProducts": [{"name": p, "maxSensitivity": max_sensitivity} for p in products],
        },
        "consumer": {
            "domain": consumer_domain,
            "owner": "consumer@contoso.com",
            "purpose": "Quarterly reporting",
        },
        "terms": {
            "accessLevel": access_level,
            "piiAllowed": pii_allowed,
            "phiAllowed": phi_allowed,
            "maxSensitivity": max_sensitivity,
            "copyAllowed": copy_allowed,
            "auditRequired": True,
            "retentionDays": 90,
        },
    }
    if expires_at is not None:
        agreement["terms"]["expiresAt"] = expires_at
    return agreement


def _write_agreement_file(tmp_path: Path, agreement: dict[str, Any], filename: str = "agreement.yaml") -> Path:
    """Write a sharing agreement YAML file and return its path."""
    yaml_file = tmp_path / filename
    yaml_file.write_text(yaml.dump(agreement), encoding="utf-8")
    return yaml_file


# ---------------------------------------------------------------------------
# Dataclass tests
# ---------------------------------------------------------------------------


class TestDataclasses:
    """Tests for Purview governance dataclasses."""

    def test_classification_rule_defaults(self) -> None:
        from csa_platform.purview_governance.purview_automation import ClassificationRule  # type: ignore[import-untyped]

        rule = ClassificationRule(name="ssn", description="SSN detection", category="PII")
        assert rule.name == "ssn"
        assert rule.sensitivity == "Confidential"
        assert rule.minimum_percentage_match == 60.0
        assert rule.built_in_classifier is None
        assert rule.remediation_action == "none"
        assert rule.data_patterns == []
        assert rule.column_patterns == []

    def test_glossary_term_defaults(self) -> None:
        from csa_platform.purview_governance.purview_automation import GlossaryTerm  # type: ignore[import-untyped]

        term = GlossaryTerm(name="Revenue", definition="Total income")
        assert term.status == "Approved"
        assert term.abbreviation == ""
        assert term.related_terms == []
        assert term.classifications == []

    def test_scan_schedule_defaults(self) -> None:
        from csa_platform.purview_governance.purview_automation import ScanSchedule  # type: ignore[import-untyped]

        schedule = ScanSchedule(source_name="adls-raw", scan_name="weekly-scan")
        assert schedule.trigger_type == "Recurring"
        assert schedule.recurrence_interval == 7
        assert schedule.scan_level == "Full"
        assert schedule.credential_name == ""

    def test_lineage_relationship(self) -> None:
        from csa_platform.purview_governance.purview_automation import LineageRelationship  # type: ignore[import-untyped]

        rel = LineageRelationship(
            source_type="azure_datalake_gen2_resource_set",
            source_qualified_name="adls://raw/orders",
            target_type="azure_datalake_gen2_resource_set",
            target_qualified_name="adls://curated/orders",
            process_type="adf_copy_operation",
            process_qualified_name="adf://factory/pipelines/copy_orders",
        )
        assert rel.process_name == ""
        assert rel.source_qualified_name == "adls://raw/orders"

    def test_sharing_agreement_fields(self) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            SharingAgreement,  # type: ignore[import-untyped]
        )

        agreement = SharingAgreement(
            name="test",
            provider_domain="finance",
            provider_owner="owner@test.com",
            consumer_domain="sales",
            consumer_owner="consumer@test.com",
            purpose="Reporting",
            data_products=["invoices"],
            access_level="read",
            pii_allowed=False,
            phi_allowed=False,
            max_sensitivity="Confidential",
            expires_at=None,
            audit_required=True,
            copy_allowed=False,
            retention_days=90,
        )
        assert agreement.provider_domain == "finance"
        assert agreement.source_path is None

    def test_validation_result_defaults(self) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            ValidationResult,  # type: ignore[import-untyped]
        )

        result = ValidationResult(approved=True, reason="Approved")
        assert result.agreement_name is None
        assert result.conditions == []


# ---------------------------------------------------------------------------
# Classification rule loading tests
# ---------------------------------------------------------------------------


class TestLoadClassificationRules:
    """Tests for loading classification rules from YAML."""

    def test_load_single_rule(self, purview: Any, tmp_path: Path) -> None:
        rules_yaml = _write_classification_yaml(
            tmp_path,
            [
                {
                    "name": "SSN",
                    "description": "Social Security Number",
                    "category": "PII",
                    "subcategory": "Direct Identifier",
                    "sensitivity": "Restricted",
                    "dataPatterns": [{"pattern": r"\d{3}-\d{2}-\d{4}"}],
                    "columnPatterns": [{"pattern": ".*ssn.*"}],
                    "minimumPercentageMatch": 80.0,
                }
            ],
        )

        rules = purview.load_classification_rules(rules_yaml)
        assert len(rules) == 1
        assert rules[0].name == "SSN"
        assert rules[0].sensitivity == "Restricted"
        assert rules[0].minimum_percentage_match == 80.0
        assert len(rules[0].data_patterns) == 1
        assert len(rules[0].column_patterns) == 1

    def test_load_multiple_rules(self, purview: Any, tmp_path: Path) -> None:
        rules_yaml = _write_classification_yaml(
            tmp_path,
            [
                {"name": "SSN", "description": "SSN", "category": "PII"},
                {"name": "EMAIL", "description": "Email", "category": "PII"},
                {"name": "PHONE", "description": "Phone", "category": "PII"},
            ],
        )

        rules = purview.load_classification_rules(rules_yaml)
        assert len(rules) == 3
        names = {r.name for r in rules}
        assert names == {"SSN", "EMAIL", "PHONE"}

    def test_load_rules_with_defaults(self, purview: Any, tmp_path: Path) -> None:
        """Missing optional fields get default values."""
        rules_yaml = _write_classification_yaml(
            tmp_path,
            [{"name": "MINIMAL", "description": "Min rule", "category": "Test"}],
        )

        rules = purview.load_classification_rules(rules_yaml)
        assert rules[0].sensitivity == "Confidential"
        assert rules[0].minimum_percentage_match == 60.0
        assert rules[0].built_in_classifier is None

    def test_load_empty_classifications(self, purview: Any, tmp_path: Path) -> None:
        """Empty classifications list returns empty."""
        rules_yaml = _write_classification_yaml(tmp_path, [])
        rules = purview.load_classification_rules(rules_yaml)
        assert rules == []


# ---------------------------------------------------------------------------
# Build classification payload tests
# ---------------------------------------------------------------------------


class TestBuildClassificationPayload:
    """Tests for _build_classification_payload."""

    def test_basic_payload(self, purview: Any) -> None:
        from csa_platform.purview_governance.purview_automation import ClassificationRule  # type: ignore[import-untyped]

        rule = ClassificationRule(name="SSN", description="Social Security Number", category="PII")
        payload = purview._build_classification_payload(rule)

        assert payload["name"] == "SSN"
        assert payload["kind"] == "Custom"
        assert payload["properties"]["description"] == "Social Security Number"
        assert payload["properties"]["ruleStatus"] == "Enabled"
        assert payload["properties"]["minimumPercentageMatch"] == 60.0

    def test_payload_with_data_patterns(self, purview: Any) -> None:
        from csa_platform.purview_governance.purview_automation import ClassificationRule  # type: ignore[import-untyped]

        rule = ClassificationRule(
            name="SSN",
            description="SSN",
            category="PII",
            data_patterns=[{"pattern": r"\d{3}-\d{2}-\d{4}"}],
        )
        payload = purview._build_classification_payload(rule)
        assert "dataPatterns" in payload["properties"]
        assert payload["properties"]["dataPatterns"][0]["pattern"] == r"\d{3}-\d{2}-\d{4}"

    def test_payload_with_column_patterns(self, purview: Any) -> None:
        from csa_platform.purview_governance.purview_automation import ClassificationRule  # type: ignore[import-untyped]

        rule = ClassificationRule(
            name="SSN",
            description="SSN",
            category="PII",
            column_patterns=[{"pattern": ".*ssn.*"}],
        )
        payload = purview._build_classification_payload(rule)
        assert "columnPatterns" in payload["properties"]

    def test_payload_without_patterns(self, purview: Any) -> None:
        from csa_platform.purview_governance.purview_automation import ClassificationRule  # type: ignore[import-untyped]

        rule = ClassificationRule(name="SIMPLE", description="Simple", category="Test")
        payload = purview._build_classification_payload(rule)
        assert "dataPatterns" not in payload["properties"]
        assert "columnPatterns" not in payload["properties"]


# ---------------------------------------------------------------------------
# Apply classification rules (dry-run) tests
# ---------------------------------------------------------------------------


class TestApplyClassificationRules:
    """Tests for apply_classification_rules."""

    def test_dry_run(self, purview: Any, tmp_path: Path) -> None:
        rules_yaml = _write_classification_yaml(
            tmp_path,
            [{"name": "SSN", "description": "SSN", "category": "PII"}],
        )

        results = purview.apply_classification_rules(rules_yaml, dry_run=True)
        assert len(results) == 1
        assert results[0]["status"] == "dry_run"
        assert results[0]["name"] == "SSN"
        assert "payload" in results[0]

    def test_apply_calls_make_request(self, purview: Any, tmp_path: Path) -> None:
        rules_yaml = _write_classification_yaml(
            tmp_path,
            [{"name": "SSN", "description": "SSN", "category": "PII"}],
        )

        with patch.object(purview, "_make_request", return_value={"status": "ok"}) as mock_req:
            results = purview.apply_classification_rules(rules_yaml, dry_run=False)

        assert len(results) == 1
        assert results[0]["status"] == "applied"
        mock_req.assert_called_once()
        call_args = mock_req.call_args
        assert call_args[0][0] == "PUT"
        assert "/scan/classificationrules/SSN" in call_args[0][1]

    def test_apply_handles_api_error(self, purview: Any, tmp_path: Path) -> None:
        rules_yaml = _write_classification_yaml(
            tmp_path,
            [{"name": "FAIL", "description": "Failing rule", "category": "PII"}],
        )

        with patch.object(purview, "_make_request", side_effect=RuntimeError("API error")):
            results = purview.apply_classification_rules(rules_yaml, dry_run=False)

        assert len(results) == 1
        assert results[0]["status"] == "error"
        assert "API error" in results[0]["error"]


# ---------------------------------------------------------------------------
# Glossary loading tests
# ---------------------------------------------------------------------------


class TestLoadGlossaryTerms:
    """Tests for loading glossary terms from YAML."""

    def test_load_single_term(self, purview: Any, tmp_path: Path) -> None:
        glossary_yaml = _write_glossary_yaml(
            tmp_path,
            [
                {
                    "name": "Revenue",
                    "definition": "Total income from product sales",
                    "abbreviation": "REV",
                    "status": "Approved",
                    "contacts": [{"type": "Expert", "email": "finance@contoso.com"}],
                    "relatedTerms": ["Net Revenue", "Gross Revenue"],
                }
            ],
        )

        terms = purview.load_glossary_terms(glossary_yaml)
        assert len(terms) == 1
        assert terms[0].name == "Revenue"
        assert terms[0].abbreviation == "REV"
        assert len(terms[0].contacts) == 1
        assert terms[0].related_terms == ["Net Revenue", "Gross Revenue"]

    def test_load_term_with_defaults(self, purview: Any, tmp_path: Path) -> None:
        glossary_yaml = _write_glossary_yaml(
            tmp_path,
            [{"name": "COGS", "definition": "Cost of goods sold"}],
        )

        terms = purview.load_glossary_terms(glossary_yaml)
        assert terms[0].status == "Approved"
        assert terms[0].abbreviation == ""
        assert terms[0].contacts == []

    def test_load_empty_terms(self, purview: Any, tmp_path: Path) -> None:
        glossary_yaml = _write_glossary_yaml(tmp_path, [])
        terms = purview.load_glossary_terms(glossary_yaml)
        assert terms == []


# ---------------------------------------------------------------------------
# Import glossary terms tests
# ---------------------------------------------------------------------------


class TestImportGlossaryTerms:
    """Tests for import_glossary_terms."""

    def test_dry_run(self, purview: Any, tmp_path: Path) -> None:
        glossary_yaml = _write_glossary_yaml(
            tmp_path,
            [{"name": "Revenue", "definition": "Total income"}],
        )

        results = purview.import_glossary_terms(glossary_yaml, dry_run=True)
        assert len(results) == 1
        assert results[0]["status"] == "dry_run"
        assert results[0]["name"] == "Revenue"

    def test_import_calls_make_request(self, purview: Any, tmp_path: Path) -> None:
        glossary_yaml = _write_glossary_yaml(
            tmp_path,
            [{"name": "Revenue", "definition": "Total income"}],
        )

        with patch.object(
            purview,
            "_make_request",
            side_effect=[
                [{"name": "CSA Business Glossary", "guid": "glossary-guid-1"}],
                {"guid": "term-guid-1"},
            ],
        ):
            results = purview.import_glossary_terms(glossary_yaml, dry_run=False)

        assert len(results) == 1
        assert results[0]["status"] == "imported"
        assert results[0]["guid"] == "term-guid-1"

    def test_import_handles_api_error(self, purview: Any, tmp_path: Path) -> None:
        glossary_yaml = _write_glossary_yaml(
            tmp_path,
            [{"name": "FailTerm", "definition": "This will fail"}],
        )

        with patch.object(
            purview,
            "_make_request",
            side_effect=[
                [{"name": "CSA Business Glossary", "guid": "glossary-guid-1"}],
                RuntimeError("Term import failed"),
            ],
        ):
            results = purview.import_glossary_terms(glossary_yaml, dry_run=False)

        assert len(results) == 1
        assert results[0]["status"] == "error"
        assert "Term import failed" in results[0]["error"]


# ---------------------------------------------------------------------------
# Scan scheduling tests
# ---------------------------------------------------------------------------


class TestScheduleScan:
    """Tests for schedule_scan."""

    def test_dry_run(self, purview: Any) -> None:
        from csa_platform.purview_governance.purview_automation import ScanSchedule  # type: ignore[import-untyped]

        schedule = ScanSchedule(source_name="adls-raw", scan_name="weekly-full")
        result = purview.schedule_scan(schedule, dry_run=True)

        assert result["status"] == "dry_run"
        assert "payload" in result
        payload = result["payload"]
        assert payload["name"] == "weekly-full-trigger"
        assert payload["properties"]["scanLevel"] == "Full"

    def test_schedule_calls_make_request(self, purview: Any) -> None:
        from csa_platform.purview_governance.purview_automation import ScanSchedule  # type: ignore[import-untyped]

        schedule = ScanSchedule(source_name="adls-raw", scan_name="weekly-full")

        with patch.object(purview, "_make_request", return_value={"status": "ok"}) as mock_req:
            result = purview.schedule_scan(schedule, dry_run=False)

        assert result["status"] == "scheduled"
        mock_req.assert_called_once()
        call_args = mock_req.call_args
        assert call_args[0][0] == "PUT"
        assert "adls-raw" in call_args[0][1]
        assert "weekly-full" in call_args[0][1]

    def test_schedule_handles_api_error(self, purview: Any) -> None:
        from csa_platform.purview_governance.purview_automation import ScanSchedule  # type: ignore[import-untyped]

        schedule = ScanSchedule(source_name="fail-source", scan_name="fail-scan")

        with patch.object(purview, "_make_request", side_effect=RuntimeError("Scan API error")):
            result = purview.schedule_scan(schedule, dry_run=False)

        assert result["status"] == "error"
        assert "Scan API error" in result["error"]


# ---------------------------------------------------------------------------
# ADF lineage registration tests
# ---------------------------------------------------------------------------


class TestRegisterADFLineage:
    """Tests for register_adf_lineage."""

    def test_dry_run(self, purview: Any) -> None:
        result = purview.register_adf_lineage(
            pipeline_name="copy_orders",
            factory_name="adf-prod",
            source_datasets=["adls://raw/orders"],
            sink_datasets=["adls://curated/orders"],
            dry_run=True,
        )

        assert result["status"] == "dry_run"
        assert result["entities"] == 1

    def test_register_calls_make_request(self, purview: Any) -> None:
        with patch.object(purview, "_make_request", return_value={"mutatedEntities": {}}) as mock_req:
            result = purview.register_adf_lineage(
                pipeline_name="copy_orders",
                factory_name="adf-prod",
                source_datasets=["adls://raw/orders"],
                sink_datasets=["adls://curated/orders"],
                dry_run=False,
            )

        assert result["status"] == "registered"
        mock_req.assert_called_once()
        call_args = mock_req.call_args
        assert call_args[0][0] == "POST"
        assert "/catalog/api/atlas/v2/entity/bulk" in call_args[0][1]

        # Verify payload structure
        body = call_args[1]["body"]
        assert len(body["entities"]) == 1
        entity = body["entities"][0]
        assert entity["typeName"] == "adf_copy_operation"
        assert "copy_orders" in entity["attributes"]["qualifiedName"]

    def test_register_handles_api_error(self, purview: Any) -> None:
        with patch.object(purview, "_make_request", side_effect=RuntimeError("Lineage API error")):
            result = purview.register_adf_lineage(
                pipeline_name="fail_pipeline",
                factory_name="adf-prod",
                source_datasets=["adls://raw/fail"],
                sink_datasets=["adls://curated/fail"],
                dry_run=False,
            )

        assert result["status"] == "error"
        assert "Lineage API error" in result["error"]

    def test_multiple_sources_and_sinks(self, purview: Any) -> None:
        result = purview.register_adf_lineage(
            pipeline_name="merge_data",
            factory_name="adf-prod",
            source_datasets=["adls://raw/orders", "adls://raw/customers"],
            sink_datasets=["adls://curated/order_detail", "adls://curated/summary"],
            dry_run=True,
        )

        assert result["status"] == "dry_run"
        assert result["entities"] == 1


# ---------------------------------------------------------------------------
# dbt lineage registration tests
# ---------------------------------------------------------------------------


class TestRegisterDbtLineage:
    """Tests for register_dbt_lineage."""

    def _write_manifest(self, tmp_path: Path, nodes: dict[str, Any], sources: dict[str, Any] | None = None) -> Path:
        """Write a minimal dbt manifest.json."""
        manifest = {"nodes": nodes, "sources": sources or {}}
        manifest_file = tmp_path / "manifest.json"
        manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_file

    def test_dry_run_with_dependencies(self, purview: Any, tmp_path: Path) -> None:
        manifest_path = self._write_manifest(
            tmp_path,
            {
                "model.myproject.orders_clean": {
                    "resource_type": "model",
                    "name": "orders_clean",
                    "package_name": "myproject",
                    "depends_on": {"nodes": ["model.myproject.orders_raw"]},
                },
                "model.myproject.orders_raw": {
                    "resource_type": "model",
                    "name": "orders_raw",
                    "package_name": "myproject",
                    "depends_on": {"nodes": []},
                },
            },
        )

        result = purview.register_dbt_lineage(manifest_path, dry_run=True)
        assert result["status"] == "dry_run"
        assert result["relationships"] == 1
        assert result["models"] == 2

    def test_dry_run_no_models(self, purview: Any, tmp_path: Path) -> None:
        manifest_path = self._write_manifest(
            tmp_path,
            {
                "test.myproject.test_orders": {
                    "resource_type": "test",
                    "name": "test_orders",
                    "package_name": "myproject",
                    "depends_on": {"nodes": []},
                }
            },
        )

        result = purview.register_dbt_lineage(manifest_path, dry_run=True)
        assert result["status"] == "dry_run"
        assert result["relationships"] == 0
        assert result["models"] == 0

    def test_register_calls_make_request(self, purview: Any, tmp_path: Path) -> None:
        manifest_path = self._write_manifest(
            tmp_path,
            {
                "model.pkg.clean": {
                    "resource_type": "model",
                    "name": "clean",
                    "package_name": "pkg",
                    "depends_on": {"nodes": ["model.pkg.raw"]},
                },
                "model.pkg.raw": {
                    "resource_type": "model",
                    "name": "raw",
                    "package_name": "pkg",
                    "depends_on": {"nodes": []},
                },
            },
        )

        with patch.object(purview, "_make_request", return_value={"mutatedEntities": {}}) as mock_req:
            result = purview.register_dbt_lineage(manifest_path, dry_run=False)

        assert result["status"] == "registered"
        assert result["relationships"] == 1
        mock_req.assert_called_once()

    def test_register_handles_api_error(self, purview: Any, tmp_path: Path) -> None:
        manifest_path = self._write_manifest(
            tmp_path,
            {
                "model.pkg.a": {
                    "resource_type": "model",
                    "name": "a",
                    "package_name": "pkg",
                    "depends_on": {"nodes": ["model.pkg.b"]},
                },
                "model.pkg.b": {
                    "resource_type": "model",
                    "name": "b",
                    "package_name": "pkg",
                    "depends_on": {"nodes": []},
                },
            },
        )

        with patch.object(purview, "_make_request", side_effect=RuntimeError("dbt API error")):
            result = purview.register_dbt_lineage(manifest_path, dry_run=False)

        assert result["status"] == "error"
        assert "dbt API error" in result["error"]

    def test_dependency_on_source(self, purview: Any, tmp_path: Path) -> None:
        """Model that depends on a dbt source (not another model)."""
        manifest_path = self._write_manifest(
            tmp_path,
            {
                "model.pkg.orders_clean": {
                    "resource_type": "model",
                    "name": "orders_clean",
                    "package_name": "pkg",
                    "depends_on": {"nodes": ["source.pkg.raw_orders"]},
                },
            },
            sources={
                "source.pkg.raw_orders": {
                    "resource_type": "source",
                    "name": "raw_orders",
                    "package_name": "pkg",
                }
            },
        )

        result = purview.register_dbt_lineage(manifest_path, dry_run=True)
        assert result["relationships"] == 1


# ---------------------------------------------------------------------------
# Sensitivity label application tests
# ---------------------------------------------------------------------------


class TestApplySensitivityLabels:
    """Tests for apply_sensitivity_labels."""

    def test_dry_run(self, purview: Any, tmp_path: Path) -> None:
        yaml_file = _write_label_policy_yaml(
            tmp_path,
            [
                {
                    "name": "pii-policy",
                    "targetLabel": "Confidential",
                    "classificationNames": ["SSN", "EMAIL"],
                }
            ],
        )

        results = purview.apply_sensitivity_labels(yaml_file, dry_run=True)
        assert len(results) == 1
        assert results[0]["status"] == "dry_run"
        assert results[0]["label"] == "Confidential"
        assert results[0]["classifications"] == ["SSN", "EMAIL"]

    def test_apply_without_dry_run(self, purview: Any, tmp_path: Path) -> None:
        yaml_file = _write_label_policy_yaml(
            tmp_path,
            [
                {
                    "name": "pii-policy",
                    "targetLabel": "Restricted",
                    "classificationNames": ["SSN"],
                }
            ],
        )

        with patch.object(purview, "_make_request", return_value={"id": "rule-1"}) as mock_req:
            results = purview.apply_sensitivity_labels(yaml_file, dry_run=False)

        assert len(results) == 1
        assert results[0]["status"] == "applied"
        assert results[0]["label"] == "Restricted"
        assert results[0]["classifications"] == ["SSN"]
        assert results[0]["response"] == {"id": "rule-1"}

        mock_req.assert_called_once_with(
            "PUT",
            "/scan/autolabelingrules/pii-policy",
            body={
                "name": "pii-policy",
                "properties": {
                    "policyName": "pii-policy",
                    "sensitivityLabel": "Restricted",
                    "classificationNames": ["SSN"],
                    "enabled": True,
                },
            },
        )

    def test_apply_api_failure(self, purview: Any, tmp_path: Path) -> None:
        yaml_file = _write_label_policy_yaml(
            tmp_path,
            [
                {
                    "name": "pii-policy",
                    "targetLabel": "Restricted",
                    "classificationNames": ["SSN"],
                }
            ],
        )

        with patch.object(purview, "_make_request", side_effect=Exception("API error")):
            results = purview.apply_sensitivity_labels(yaml_file, dry_run=False)

        assert len(results) == 1
        assert results[0]["status"] == "error"
        assert "API error" in results[0]["error"]

    def test_empty_policies(self, purview: Any, tmp_path: Path) -> None:
        yaml_file = _write_label_policy_yaml(tmp_path, [])
        results = purview.apply_sensitivity_labels(yaml_file, dry_run=True)
        assert results == []

    def test_multiple_policies(self, purview: Any, tmp_path: Path) -> None:
        yaml_file = _write_label_policy_yaml(
            tmp_path,
            [
                {"name": "pii-policy", "targetLabel": "Confidential", "classificationNames": ["SSN"]},
                {"name": "phi-policy", "targetLabel": "Restricted", "classificationNames": ["MRN"]},
            ],
        )

        results = purview.apply_sensitivity_labels(yaml_file, dry_run=True)
        assert len(results) == 2
        labels = {r["label"] for r in results}
        assert labels == {"Confidential", "Restricted"}


# ---------------------------------------------------------------------------
# _make_request tests
# ---------------------------------------------------------------------------


class TestMakeRequest:
    """Tests for _make_request HTTP interactions."""

    def test_successful_get(self, purview: Any) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = '{"data": "test"}'
        mock_response.json.return_value = {"data": "test"}

        with patch("requests.request", return_value=mock_response):
            result = purview._make_request("GET", "/test/path")

        assert result == {"data": "test"}

    def test_successful_post_with_body(self, purview: Any) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = '{"guid": "abc-123"}'
        mock_response.json.return_value = {"guid": "abc-123"}

        with patch("requests.request", return_value=mock_response):
            result = purview._make_request("POST", "/test/path", body={"name": "test"})

        assert result == {"guid": "abc-123"}

    def test_error_response_raises(self, purview: Any) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_response.text = "Not Found"
        mock_response.raise_for_status.side_effect = RuntimeError("404 Not Found")

        with patch("requests.request", return_value=mock_response), pytest.raises(RuntimeError, match="404"):
            purview._make_request("GET", "/nonexistent")

    def test_empty_response_body(self, purview: Any) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 204
        mock_response.text = ""

        with patch("requests.request", return_value=mock_response):
            result = purview._make_request("DELETE", "/test/path")

        assert result == {}

    def test_token_acquisition_failure(self, purview: Any, mock_credential: MagicMock) -> None:
        mock_credential.get_token.side_effect = RuntimeError("Auth failed")

        with pytest.raises(RuntimeError, match="Auth failed"):
            purview._make_request("GET", "/test/path")


# ---------------------------------------------------------------------------
# load_agreement tests
# ---------------------------------------------------------------------------


class TestLoadAgreement:
    """Tests for load_agreement from YAML."""

    def test_load_valid_agreement(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreement,  # type: ignore[import-untyped]
        )

        agreement_data = _make_agreement_yaml(expires_at="2030-12-31T23:59:59")
        yaml_file = _write_agreement_file(tmp_path, agreement_data)

        agreement = load_agreement(yaml_file)
        assert agreement.name == "finance-to-sales"
        assert agreement.provider_domain == "finance"
        assert agreement.consumer_domain == "sales"
        assert agreement.access_level == "read"
        assert agreement.pii_allowed is False
        assert agreement.expires_at is not None
        assert agreement.source_path == yaml_file

    def test_load_agreement_without_expiry(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreement,  # type: ignore[import-untyped]
        )

        agreement_data = _make_agreement_yaml()
        yaml_file = _write_agreement_file(tmp_path, agreement_data)

        agreement = load_agreement(yaml_file)
        assert agreement.expires_at is None

    def test_load_agreement_invalid_yaml(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreement,  # type: ignore[import-untyped]
        )

        yaml_file = tmp_path / "invalid.yaml"
        yaml_file.write_text("just a string", encoding="utf-8")

        with pytest.raises(ValueError, match="must be a YAML mapping"):
            load_agreement(yaml_file)

    def test_load_agreement_name_from_stem(self, tmp_path: Path) -> None:
        """When metadata.name is missing, use the file stem."""
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreement,  # type: ignore[import-untyped]
        )

        agreement_data = _make_agreement_yaml()
        del agreement_data["metadata"]["name"]
        yaml_file = _write_agreement_file(tmp_path, agreement_data, filename="my-custom-agreement.yaml")

        agreement = load_agreement(yaml_file)
        assert agreement.name == "my-custom-agreement"


# ---------------------------------------------------------------------------
# load_agreements tests
# ---------------------------------------------------------------------------


class TestLoadAgreements:
    """Tests for load_agreements from directory."""

    def test_load_from_directory(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreements,  # type: ignore[import-untyped]
        )

        agreements_dir = tmp_path / "agreements"
        agreements_dir.mkdir()

        _write_agreement_file(
            agreements_dir,
            _make_agreement_yaml(name="agreement-1"),
            filename="agreement-1.yaml",
        )
        _write_agreement_file(
            agreements_dir,
            _make_agreement_yaml(name="agreement-2", provider_domain="hr", consumer_domain="legal"),
            filename="agreement-2.yaml",
        )

        agreements = load_agreements(agreements_dir)
        assert len(agreements) == 2

    def test_skips_template_files(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreements,  # type: ignore[import-untyped]
        )

        agreements_dir = tmp_path / "agreements"
        agreements_dir.mkdir()

        _write_agreement_file(
            agreements_dir,
            _make_agreement_yaml(name="real"),
            filename="real-agreement.yaml",
        )
        _write_agreement_file(
            agreements_dir,
            _make_agreement_yaml(name="template"),
            filename="agreement_template.yaml",
        )

        agreements = load_agreements(agreements_dir)
        assert len(agreements) == 1
        assert agreements[0].name == "real"

    def test_skips_placeholder_domains(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreements,  # type: ignore[import-untyped]
        )

        agreements_dir = tmp_path / "agreements"
        agreements_dir.mkdir()

        _write_agreement_file(
            agreements_dir,
            _make_agreement_yaml(name="real", provider_domain="finance"),
            filename="real.yaml",
        )
        _write_agreement_file(
            agreements_dir,
            _make_agreement_yaml(name="placeholder", provider_domain="{provider}"),
            filename="placeholder.yaml",
        )

        agreements = load_agreements(agreements_dir)
        assert len(agreements) == 1

    def test_missing_directory_raises(self) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreements,  # type: ignore[import-untyped]
        )

        with pytest.raises(FileNotFoundError, match="Agreements directory not found"):
            load_agreements("/nonexistent/agreements")

    def test_empty_directory(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            load_agreements,  # type: ignore[import-untyped]
        )

        agreements_dir = tmp_path / "agreements"
        agreements_dir.mkdir()

        agreements = load_agreements(agreements_dir)
        assert agreements == []


# ---------------------------------------------------------------------------
# SharingEnforcer validate_request tests
# ---------------------------------------------------------------------------


class TestValidateRequest:
    """Tests for SharingEnforcer.validate_request."""

    def _make_enforcer(self, tmp_path: Path, agreements: list[dict[str, Any]]) -> Any:
        """Create a SharingEnforcer with pre-written agreement files."""
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            SharingEnforcer,  # type: ignore[import-untyped]
        )

        agreements_dir = tmp_path / "agreements"
        agreements_dir.mkdir(exist_ok=True)

        for i, agreement in enumerate(agreements):
            _write_agreement_file(agreements_dir, agreement, filename=f"agreement-{i}.yaml")

        return SharingEnforcer(agreements_dir=agreements_dir)

    def test_approved_request(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            access_level="read",
        )
        assert result.approved is True
        assert "Approved" in result.reason
        assert result.agreement_name == "finance-to-sales"
        assert len(result.conditions) > 0

    def test_no_matching_agreement(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml()],
        )

        result = enforcer.validate_request(
            provider_domain="hr",
            consumer_domain="marketing",
            data_product="employees",
        )
        assert result.approved is False
        assert "No sharing agreement found" in result.reason

    def test_expired_agreement(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(expires_at="2020-01-01T00:00:00")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
        )
        assert result.approved is False
        assert "expired" in result.reason.lower()

    def test_access_level_exceeded(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(access_level="read", expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            access_level="read_write",
        )
        assert result.approved is False
        assert "access level" in result.reason.lower()

    def test_pii_denied(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(pii_allowed=False, expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            includes_pii=True,
        )
        assert result.approved is False
        assert "PII" in result.reason

    def test_phi_denied(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(phi_allowed=False, expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            includes_phi=True,
        )
        assert result.approved is False
        assert "PHI" in result.reason

    def test_sensitivity_exceeded(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(max_sensitivity="Internal", expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            sensitivity_level="Restricted",
        )
        assert result.approved is False
        assert "sensitivity" in result.reason.lower()

    def test_copy_denied(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(copy_allowed=False, expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            requires_copy=True,
        )
        assert result.approved is False
        assert "copy" in result.reason.lower()

    def test_pii_allowed(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(pii_allowed=True, expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            includes_pii=True,
        )
        assert result.approved is True

    def test_read_write_within_granted_level(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(access_level="admin", expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            access_level="read_write",
        )
        assert result.approved is True

    def test_wildcard_data_products(self, tmp_path: Path) -> None:
        """Agreement with '*' matches any data product."""
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(data_products=["*"], expires_at="2030-12-31T23:59:59")],
        )

        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="anything",
        )
        assert result.approved is True


# ---------------------------------------------------------------------------
# SharingEnforcer utility method tests
# ---------------------------------------------------------------------------


class TestSharingEnforcerUtilities:
    """Tests for list_agreements_for_domain, get_expired_agreements, get_expiring_soon."""

    def _make_enforcer(self, tmp_path: Path, agreements: list[dict[str, Any]]) -> Any:
        from csa_platform.purview_governance.data_sharing.sharing_enforcer import (
            SharingEnforcer,  # type: ignore[import-untyped]
        )

        agreements_dir = tmp_path / "agreements"
        agreements_dir.mkdir(exist_ok=True)

        for i, agreement in enumerate(agreements):
            _write_agreement_file(agreements_dir, agreement, filename=f"agreement-{i}.yaml")

        return SharingEnforcer(agreements_dir=agreements_dir)

    def test_list_agreements_for_domain_any(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [
                _make_agreement_yaml(name="a1", provider_domain="finance", consumer_domain="sales"),
                _make_agreement_yaml(name="a2", provider_domain="hr", consumer_domain="finance"),
            ],
        )

        results = enforcer.list_agreements_for_domain("finance")
        assert len(results) == 2

    def test_list_agreements_for_domain_provider_only(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [
                _make_agreement_yaml(name="a1", provider_domain="finance", consumer_domain="sales"),
                _make_agreement_yaml(name="a2", provider_domain="hr", consumer_domain="finance"),
            ],
        )

        results = enforcer.list_agreements_for_domain("finance", role="provider")
        assert len(results) == 1
        assert results[0].name == "a1"

    def test_list_agreements_for_domain_consumer_only(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [
                _make_agreement_yaml(name="a1", provider_domain="finance", consumer_domain="sales"),
                _make_agreement_yaml(name="a2", provider_domain="hr", consumer_domain="finance"),
            ],
        )

        results = enforcer.list_agreements_for_domain("finance", role="consumer")
        assert len(results) == 1
        assert results[0].name == "a2"

    def test_get_expired_agreements(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [
                _make_agreement_yaml(name="expired", expires_at="2020-01-01T00:00:00"),
                _make_agreement_yaml(name="active", expires_at="2030-12-31T23:59:59"),
            ],
        )

        expired = enforcer.get_expired_agreements()
        assert len(expired) == 1
        assert expired[0].name == "expired"

    def test_get_expired_agreements_none_expired(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(name="active", expires_at="2030-12-31T23:59:59")],
        )

        expired = enforcer.get_expired_agreements()
        assert expired == []

    def test_get_expiring_soon(self, tmp_path: Path) -> None:
        soon = (datetime.now(timezone.utc) + timedelta(days=15)).isoformat()
        far = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat()

        enforcer = self._make_enforcer(
            tmp_path,
            [
                _make_agreement_yaml(name="expiring-soon", expires_at=soon),
                _make_agreement_yaml(name="far-future", expires_at=far),
            ],
        )

        expiring = enforcer.get_expiring_soon(days=30)
        assert len(expiring) == 1
        assert expiring[0].name == "expiring-soon"

    def test_get_expiring_soon_with_custom_window(self, tmp_path: Path) -> None:
        in_60_days = (datetime.now(timezone.utc) + timedelta(days=60)).isoformat()

        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(name="in-60-days", expires_at=in_60_days)],
        )

        # 30-day window should not include it
        expiring_30 = enforcer.get_expiring_soon(days=30)
        assert len(expiring_30) == 0

        # 90-day window should include it
        expiring_90 = enforcer.get_expiring_soon(days=90)
        assert len(expiring_90) == 1

    def test_reload_clears_cache(self, tmp_path: Path) -> None:
        enforcer = self._make_enforcer(
            tmp_path,
            [_make_agreement_yaml(name="original")],
        )

        # Access to populate cache
        assert len(enforcer.agreements) == 1

        # Add another agreement file
        _write_agreement_file(
            tmp_path / "agreements",
            _make_agreement_yaml(name="new-agreement", provider_domain="hr", consumer_domain="legal"),
            filename="agreement-new.yaml",
        )

        # Still cached
        assert len(enforcer.agreements) == 1

        # Reload
        enforcer.reload()
        assert len(enforcer.agreements) == 2


# ---------------------------------------------------------------------------
# CLI entry point tests
# ---------------------------------------------------------------------------


class TestCLIMain:
    """Tests for the CLI entry point."""

    def test_apply_classifications_dry_run(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.purview_automation import main  # type: ignore[import-untyped]

        rules_yaml = _write_classification_yaml(
            tmp_path,
            [{"name": "SSN", "description": "SSN", "category": "PII"}],
        )

        with patch("azure.identity.DefaultAzureCredential") as mock_cred_cls:
            mock_cred_cls.return_value = MagicMock()
            exit_code = main([
                "--account", "test-purview",
                "--action", "apply-classifications",
                "--rules-file", str(rules_yaml),
                "--dry-run",
            ])

        assert exit_code == 0

    def test_missing_rules_dir_returns_error(self) -> None:
        from csa_platform.purview_governance.purview_automation import main  # type: ignore[import-untyped]

        with patch("azure.identity.DefaultAzureCredential") as mock_cred_cls:
            mock_cred_cls.return_value = MagicMock()
            exit_code = main([
                "--account", "test-purview",
                "--action", "apply-classifications",
            ])

        assert exit_code == 1

    def test_import_glossary_missing_file_returns_error(self) -> None:
        from csa_platform.purview_governance.purview_automation import main  # type: ignore[import-untyped]

        with patch("azure.identity.DefaultAzureCredential") as mock_cred_cls:
            mock_cred_cls.return_value = MagicMock()
            exit_code = main([
                "--account", "test-purview",
                "--action", "import-glossary",
            ])

        assert exit_code == 1

    def test_register_dbt_lineage_dry_run(self, tmp_path: Path) -> None:
        from csa_platform.purview_governance.purview_automation import main  # type: ignore[import-untyped]

        manifest = {"nodes": {}, "sources": {}}
        manifest_file = tmp_path / "manifest.json"
        manifest_file.write_text(json.dumps(manifest), encoding="utf-8")

        with patch("azure.identity.DefaultAzureCredential") as mock_cred_cls:
            mock_cred_cls.return_value = MagicMock()
            exit_code = main([
                "--account", "test-purview",
                "--action", "register-dbt-lineage",
                "--manifest", str(manifest_file),
                "--dry-run",
            ])

        assert exit_code == 0
