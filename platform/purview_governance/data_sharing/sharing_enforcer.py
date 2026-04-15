"""Data sharing agreement enforcer for CSA-in-a-Box.

Validates inter-domain data sharing requests against signed sharing
agreements defined in YAML. Prevents unauthorized cross-domain data
access by ensuring every sharing grant has a valid, unexpired agreement.

Typical use::

    from platform.purview_governance.data_sharing.sharing_enforcer import SharingEnforcer

    enforcer = SharingEnforcer(agreements_dir="platform/purview_governance/data_sharing/agreements/")

    result = enforcer.validate_request(
        provider_domain="finance",
        consumer_domain="sales",
        data_product="invoices",
        access_level="read",
    )

    if result.approved:
        # Grant RBAC access
        ...
    else:
        print(f"Denied: {result.reason}")
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import yaml

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="sharing-enforcer")
logger = get_logger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Domain models
# ──────────────────────────────────────────────────────────────────────


@dataclass
class SharingAgreement:
    """Parsed data sharing agreement from YAML."""

    name: str
    provider_domain: str
    provider_owner: str
    consumer_domain: str
    consumer_owner: str
    purpose: str
    data_products: list[str]
    access_level: str
    pii_allowed: bool
    phi_allowed: bool
    max_sensitivity: str
    expires_at: datetime | None
    audit_required: bool
    copy_allowed: bool
    retention_days: int
    source_path: Path | None = None


@dataclass
class ValidationResult:
    """Result of validating a sharing request against agreements."""

    approved: bool
    reason: str
    agreement_name: str | None = None
    conditions: list[str] = field(default_factory=list)


# ──────────────────────────────────────────────────────────────────────
# Agreement loading
# ──────────────────────────────────────────────────────────────────────


def load_agreement(path: Path) -> SharingAgreement:
    """Load a single sharing agreement from a YAML file.

    Args:
        path: Path to a sharing agreement YAML file.

    Returns:
        Parsed :class:`SharingAgreement`.

    Raises:
        ValueError: If the YAML file is missing required fields.
    """
    with open(path) as f:
        raw = yaml.safe_load(f)

    if not isinstance(raw, dict):
        raise ValueError(f"{path}: sharing agreement must be a YAML mapping")

    metadata = raw.get("metadata", {})
    provider = raw.get("provider", {})
    consumer = raw.get("consumer", {})
    terms = raw.get("terms", {})

    # Extract data product names from the provider section
    product_entries = provider.get("dataProducts", [])
    product_names: list[str] = []
    for entry in product_entries:
        if isinstance(entry, str):
            product_names.append(entry)
        elif isinstance(entry, dict) and "name" in entry:
            product_names.append(entry["name"])

    # Parse expiration date
    expires_str = terms.get("expiresAt")
    expires_at: datetime | None = None
    if expires_str and not expires_str.startswith("{"):
        try:
            expires_at = datetime.fromisoformat(expires_str).replace(tzinfo=timezone.utc)
        except ValueError:
            logger.warning("agreement.invalid_expiry", path=str(path), expires_at=expires_str)

    return SharingAgreement(
        name=metadata.get("name", path.stem),
        provider_domain=provider.get("domain", ""),
        provider_owner=provider.get("owner", ""),
        consumer_domain=consumer.get("domain", ""),
        consumer_owner=consumer.get("owner", ""),
        purpose=consumer.get("purpose", ""),
        data_products=product_names,
        access_level=terms.get("accessLevel", "read"),
        pii_allowed=terms.get("piiAllowed", False),
        phi_allowed=terms.get("phiAllowed", False),
        max_sensitivity=terms.get(
            "maxSensitivity",
            provider.get("dataProducts", [{}])[0].get("maxSensitivity", "Confidential")
            if product_entries and isinstance(product_entries[0], dict)
            else "Confidential",
        ),
        expires_at=expires_at,
        audit_required=terms.get("auditRequired", True),
        copy_allowed=terms.get("copyAllowed", False),
        retention_days=terms.get("retentionDays", 90),
        source_path=path,
    )


def load_agreements(agreements_dir: Path | str) -> list[SharingAgreement]:
    """Load all sharing agreements from a directory.

    Args:
        agreements_dir: Path to a directory containing agreement YAML files.

    Returns:
        List of parsed :class:`SharingAgreement` objects.

    Raises:
        FileNotFoundError: If the agreements directory does not exist.
    """
    agreements_dir = Path(agreements_dir)
    if not agreements_dir.is_dir():
        raise FileNotFoundError(f"Agreements directory not found: {agreements_dir}")

    agreements: list[SharingAgreement] = []
    for yaml_path in sorted(agreements_dir.glob("*.yaml")):
        # Skip the template file
        if "template" in yaml_path.name.lower():
            continue

        try:
            agreement = load_agreement(yaml_path)
            # Skip agreements with placeholder values
            if "{" in agreement.provider_domain or "{" in agreement.consumer_domain:
                logger.debug("agreement.skipping_template", path=str(yaml_path))
                continue
            agreements.append(agreement)
            logger.info(
                "agreement.loaded",
                agreement_name=agreement.name,
                provider=agreement.provider_domain,
                consumer=agreement.consumer_domain,
            )
        except Exception:
            logger.exception("agreement.load_failed", path=str(yaml_path))

    return agreements


# ──────────────────────────────────────────────────────────────────────
# Sharing Enforcer
# ──────────────────────────────────────────────────────────────────────


class SharingEnforcer:
    """Validates data sharing requests against signed agreements.

    The enforcer loads all sharing agreements from a directory and
    provides a validation method that checks whether a specific sharing
    request is permitted.

    Args:
        agreements_dir: Path to a directory containing agreement YAML files.
    """

    def __init__(self, agreements_dir: Path | str) -> None:
        self.agreements_dir = Path(agreements_dir)
        self._agreements: list[SharingAgreement] | None = None

    @property
    def agreements(self) -> list[SharingAgreement]:
        """Lazily load and cache agreements."""
        if self._agreements is None:
            self._agreements = load_agreements(self.agreements_dir)
        return self._agreements

    def reload(self) -> None:
        """Force reload agreements from disk."""
        self._agreements = None

    def validate_request(
        self,
        provider_domain: str,
        consumer_domain: str,
        data_product: str,
        access_level: str = "read",
        *,
        includes_pii: bool = False,
        includes_phi: bool = False,
        sensitivity_level: str = "Internal",
        requires_copy: bool = False,
    ) -> ValidationResult:
        """Validate a data sharing request against active agreements.

        Checks whether a valid, unexpired sharing agreement exists that
        permits the requested access pattern.

        Args:
            provider_domain: Domain that owns the data.
            consumer_domain: Domain requesting access.
            data_product: Name of the data product being requested.
            access_level: Requested access level (``read``, ``read_write``).
            includes_pii: Whether the data product contains PII.
            includes_phi: Whether the data product contains PHI.
            sensitivity_level: Sensitivity classification of the data.
            requires_copy: Whether the consumer needs to copy the data.

        Returns:
            A :class:`ValidationResult` indicating whether the request is
            approved and, if not, the reason for denial.
        """
        # Find matching agreements
        matching = self._find_matching_agreements(
            provider_domain,
            consumer_domain,
            data_product,
        )

        if not matching:
            return ValidationResult(
                approved=False,
                reason=(
                    f"No sharing agreement found between provider '{provider_domain}' "
                    f"and consumer '{consumer_domain}' for data product '{data_product}'"
                ),
            )

        # Validate each matching agreement
        for agreement in matching:
            result = self._validate_against_agreement(
                agreement,
                access_level=access_level,
                includes_pii=includes_pii,
                includes_phi=includes_phi,
                sensitivity_level=sensitivity_level,
                requires_copy=requires_copy,
            )
            if result.approved:
                return result

        # If no agreement passed validation, return the last denial reason
        return result  # type: ignore[possibly-undefined]

    def _find_matching_agreements(
        self,
        provider_domain: str,
        consumer_domain: str,
        data_product: str,
    ) -> list[SharingAgreement]:
        """Find agreements matching the provider, consumer, and product."""
        return [
            a
            for a in self.agreements
            if (
                a.provider_domain.lower() == provider_domain.lower()
                and a.consumer_domain.lower() == consumer_domain.lower()
                and (data_product.lower() in [p.lower() for p in a.data_products] or "*" in a.data_products)
            )
        ]

    def _validate_against_agreement(
        self,
        agreement: SharingAgreement,
        *,
        access_level: str,
        includes_pii: bool,
        includes_phi: bool,
        sensitivity_level: str,
        requires_copy: bool,
    ) -> ValidationResult:
        """Validate a request against a specific agreement."""
        conditions: list[str] = []
        now = datetime.now(timezone.utc)

        # Check expiration
        if agreement.expires_at and now > agreement.expires_at:
            return ValidationResult(
                approved=False,
                reason=(f"Sharing agreement '{agreement.name}' expired on {agreement.expires_at.isoformat()}"),
                agreement_name=agreement.name,
            )

        # Check access level
        access_hierarchy = {"read": 1, "read_write": 2, "admin": 3}
        requested_level = access_hierarchy.get(access_level, 0)
        granted_level = access_hierarchy.get(agreement.access_level, 0)
        if requested_level > granted_level:
            return ValidationResult(
                approved=False,
                reason=(
                    f"Requested access level '{access_level}' exceeds the "
                    f"agreement's maximum '{agreement.access_level}'"
                ),
                agreement_name=agreement.name,
            )

        # Check PII
        if includes_pii and not agreement.pii_allowed:
            return ValidationResult(
                approved=False,
                reason=(f"Data product contains PII but agreement '{agreement.name}' does not allow PII sharing"),
                agreement_name=agreement.name,
            )

        # Check PHI
        if includes_phi and not agreement.phi_allowed:
            return ValidationResult(
                approved=False,
                reason=(f"Data product contains PHI but agreement '{agreement.name}' does not allow PHI sharing"),
                agreement_name=agreement.name,
            )

        # Check sensitivity level
        sensitivity_hierarchy = {
            "Public": 1,
            "Internal": 2,
            "Confidential": 3,
            "Restricted": 4,
        }
        data_sensitivity = sensitivity_hierarchy.get(sensitivity_level, 0)
        max_sensitivity = sensitivity_hierarchy.get(agreement.max_sensitivity, 0)
        if data_sensitivity > max_sensitivity:
            return ValidationResult(
                approved=False,
                reason=(
                    f"Data sensitivity '{sensitivity_level}' exceeds the "
                    f"agreement's maximum '{agreement.max_sensitivity}'"
                ),
                agreement_name=agreement.name,
            )

        # Check copy requirement
        if requires_copy and not agreement.copy_allowed:
            return ValidationResult(
                approved=False,
                reason=(f"Data copy requested but agreement '{agreement.name}' does not allow data copying"),
                agreement_name=agreement.name,
            )

        # Build conditions list
        if agreement.audit_required:
            conditions.append("All data access must be logged for audit")
        conditions.append(f"Data retention limited to {agreement.retention_days} days")
        if agreement.expires_at:
            conditions.append(f"Agreement expires: {agreement.expires_at.date().isoformat()}")

        return ValidationResult(
            approved=True,
            reason=f"Approved under agreement '{agreement.name}'",
            agreement_name=agreement.name,
            conditions=conditions,
        )

    def list_agreements_for_domain(
        self,
        domain: str,
        role: str = "any",
    ) -> list[SharingAgreement]:
        """List all agreements involving a domain.

        Args:
            domain: Domain name to search for.
            role: Filter by role — ``"provider"``, ``"consumer"``, or
                ``"any"`` (default).

        Returns:
            List of matching agreements.
        """
        results: list[SharingAgreement] = []
        for agreement in self.agreements:
            if (role in ("any", "provider") and agreement.provider_domain.lower() == domain.lower()) or (
                role in ("any", "consumer") and agreement.consumer_domain.lower() == domain.lower()
            ):
                results.append(agreement)
        return results

    def get_expired_agreements(self) -> list[SharingAgreement]:
        """Return all expired agreements (for cleanup/renewal workflows)."""
        now = datetime.now(timezone.utc)
        return [a for a in self.agreements if a.expires_at is not None and now > a.expires_at]

    def get_expiring_soon(self, days: int = 30) -> list[SharingAgreement]:
        """Return agreements expiring within the next ``days`` days."""
        from datetime import timedelta

        now = datetime.now(timezone.utc)
        cutoff = now + timedelta(days=days)
        return [a for a in self.agreements if a.expires_at is not None and now < a.expires_at <= cutoff]
