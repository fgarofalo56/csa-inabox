"""Tests for the data sharing agreement enforcer.

Tests SharingEnforcer: YAML agreement loading, request validation
(expiration, PII/PHI checks, access level hierarchy, copy permissions),
domain listing, and expired agreement detection.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from textwrap import dedent

# ---------------------------------------------------------------------------
# Bootstrap: add source dir to path
# ---------------------------------------------------------------------------
_data_sharing = str(Path(__file__).resolve().parent.parent / "data_sharing")
if _data_sharing not in sys.path:
    sys.path.insert(0, _data_sharing)
# ---------------------------------------------------------------------------

import pytest
from sharing_enforcer import (
    SharingEnforcer,
    load_agreement,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _write_agreement_yaml(path: Path, content: str) -> Path:
    """Write a YAML agreement file and return its path."""
    path.write_text(dedent(content))
    return path


@pytest.fixture
def agreements_dir(tmp_path) -> Path:
    """Create a temp directory with sample sharing agreement YAML files."""
    d = tmp_path / "agreements"
    d.mkdir()

    _write_agreement_yaml(d / "finance-to-sales.yaml", """\
        metadata:
          name: finance-to-sales
        provider:
          domain: finance
          owner: finance-team@contoso.com
          dataProducts:
            - name: invoices
            - name: revenue
        consumer:
          domain: sales
          owner: sales-team@contoso.com
          purpose: Quarterly reporting
        terms:
          accessLevel: read
          piiAllowed: false
          phiAllowed: false
          maxSensitivity: Confidential
          expiresAt: "2099-12-31T00:00:00"
          auditRequired: true
          copyAllowed: false
          retentionDays: 90
    """)

    _write_agreement_yaml(d / "health-to-research.yaml", """\
        metadata:
          name: health-to-research
        provider:
          domain: health
          owner: health-admin@contoso.com
          dataProducts:
            - name: patient-outcomes
        consumer:
          domain: research
          owner: researcher@contoso.com
          purpose: Population health study
        terms:
          accessLevel: read_write
          piiAllowed: true
          phiAllowed: true
          maxSensitivity: Restricted
          expiresAt: "2020-01-01T00:00:00"
          auditRequired: true
          copyAllowed: true
          retentionDays: 365
    """)

    return d


@pytest.fixture
def enforcer(agreements_dir) -> SharingEnforcer:
    """Return a SharingEnforcer loaded from the test agreements."""
    return SharingEnforcer(agreements_dir=agreements_dir)


# ---------------------------------------------------------------------------
# YAML loading tests
# ---------------------------------------------------------------------------


class TestLoadAgreement:
    """Test YAML agreement loading and parsing."""

    def test_load_single_agreement(self, agreements_dir):
        agreement = load_agreement(agreements_dir / "finance-to-sales.yaml")
        assert agreement.name == "finance-to-sales"
        assert agreement.provider_domain == "finance"
        assert agreement.consumer_domain == "sales"
        assert "invoices" in agreement.data_products
        assert "revenue" in agreement.data_products

    def test_load_agreement_with_phi(self, agreements_dir):
        agreement = load_agreement(agreements_dir / "health-to-research.yaml")
        assert agreement.phi_allowed is True
        assert agreement.pii_allowed is True
        assert agreement.copy_allowed is True

    def test_enforcer_loads_all_agreements(self, enforcer):
        assert len(enforcer.agreements) == 2

    def test_load_nonexistent_dir_raises(self):
        with pytest.raises(FileNotFoundError):
            _ = SharingEnforcer(agreements_dir="/nonexistent/path").agreements

    def test_template_files_skipped(self, agreements_dir):
        _write_agreement_yaml(agreements_dir / "template-sharing.yaml", """\
            metadata:
              name: template
            provider:
              domain: "{provider}"
              owner: "{owner}"
              dataProducts: []
            consumer:
              domain: "{consumer}"
              owner: "{consumer_owner}"
            terms:
              accessLevel: read
        """)
        enforcer = SharingEnforcer(agreements_dir)
        # Template should be skipped because domain contains '{'
        names = [a.name for a in enforcer.agreements]
        assert "template" not in names


# ---------------------------------------------------------------------------
# Request validation tests
# ---------------------------------------------------------------------------


class TestValidateRequest:
    """Test data sharing request validation."""

    def test_approved_request(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            access_level="read",
        )

        assert result.approved is True
        assert result.agreement_name == "finance-to-sales"
        assert len(result.conditions) > 0

    def test_no_matching_agreement(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="unknown",
            consumer_domain="sales",
            data_product="invoices",
        )

        assert result.approved is False
        assert "No sharing agreement" in result.reason

    def test_unknown_data_product_denied(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="secret-data",
        )

        assert result.approved is False

    def test_expired_agreement_denied(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="health",
            consumer_domain="research",
            data_product="patient-outcomes",
        )

        assert result.approved is False
        assert "expired" in result.reason.lower()

    def test_pii_denied_when_not_allowed(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            includes_pii=True,
        )

        assert result.approved is False
        assert "PII" in result.reason

    def test_phi_denied_when_not_allowed(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            includes_phi=True,
        )

        assert result.approved is False
        assert "PHI" in result.reason

    def test_access_level_hierarchy_denies_escalation(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            access_level="read_write",
        )

        assert result.approved is False
        assert "access level" in result.reason.lower()

    def test_copy_denied_when_not_allowed(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            requires_copy=True,
        )

        assert result.approved is False
        assert "copy" in result.reason.lower()

    def test_sensitivity_level_denied_if_exceeded(self, enforcer):
        result = enforcer.validate_request(
            provider_domain="finance",
            consumer_domain="sales",
            data_product="invoices",
            sensitivity_level="Restricted",
        )

        assert result.approved is False
        assert "sensitivity" in result.reason.lower()


# ---------------------------------------------------------------------------
# Domain listing tests
# ---------------------------------------------------------------------------


class TestListAgreementsForDomain:
    """Test listing agreements by domain role."""

    def test_list_as_provider(self, enforcer):
        results = enforcer.list_agreements_for_domain("finance", role="provider")
        assert len(results) == 1
        assert results[0].provider_domain == "finance"

    def test_list_as_consumer(self, enforcer):
        results = enforcer.list_agreements_for_domain("sales", role="consumer")
        assert len(results) == 1
        assert results[0].consumer_domain == "sales"

    def test_list_any_role(self, enforcer):
        results = enforcer.list_agreements_for_domain("finance", role="any")
        assert len(results) >= 1

    def test_list_unknown_domain(self, enforcer):
        results = enforcer.list_agreements_for_domain("nonexistent")
        assert results == []


# ---------------------------------------------------------------------------
# Expired agreement detection
# ---------------------------------------------------------------------------


class TestExpiredDetection:
    """Test expired and expiring-soon agreement detection."""

    def test_get_expired_agreements(self, enforcer):
        expired = enforcer.get_expired_agreements()
        assert len(expired) == 1
        assert expired[0].name == "health-to-research"

    def test_get_expiring_soon(self, enforcer):
        """health-to-research is already expired, finance-to-sales expires in 2099."""
        expiring = enforcer.get_expiring_soon(days=30)
        # Neither should be "expiring soon" (one is already expired, other in 2099)
        assert len(expiring) == 0

    def test_get_expiring_soon_with_near_expiry(self, agreements_dir):
        """Add an agreement expiring in 15 days to test near-expiry detection."""
        near_expiry = (datetime.now(timezone.utc) + timedelta(days=15)).isoformat()
        _write_agreement_yaml(agreements_dir / "near-expiry.yaml", f"""\
            metadata:
              name: near-expiry
            provider:
              domain: ops
              owner: ops@contoso.com
              dataProducts:
                - name: metrics
            consumer:
              domain: analytics
              owner: analytics@contoso.com
            terms:
              accessLevel: read
              piiAllowed: false
              phiAllowed: false
              maxSensitivity: Internal
              expiresAt: "{near_expiry}"
              auditRequired: false
              copyAllowed: false
              retentionDays: 30
        """)

        enforcer = SharingEnforcer(agreements_dir)
        expiring = enforcer.get_expiring_soon(days=30)
        assert len(expiring) == 1
        assert expiring[0].name == "near-expiry"
