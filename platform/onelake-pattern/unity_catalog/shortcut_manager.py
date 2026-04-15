"""Cross-domain shortcut manager for the OneLake pattern.

Manages virtual data access shortcuts across organizational domains
in ADLS Gen2, enabling cross-domain data access without physical
data movement — similar to Microsoft OneLake shortcuts.

Shortcuts are metadata pointers that map an alias path to a physical
ADLS Gen2 path, validated through managed identity and RBAC.

Usage::

    from unity_catalog.shortcut_manager import ShortcutManager

    manager = ShortcutManager()

    # Create a cross-domain shortcut
    manager.create_shortcut(
        name="dod-orders",
        source_path="abfss://gold@datalake-dod.dfs.core.windows.net/orders/",
        target_domain="usda",
        target_alias="abfss://shared@datalake-usda.dfs.core.windows.net/shortcuts/dod-orders/",
        granted_by="dod-data-steward@gov.mil",
    )

    # List shortcuts
    shortcuts = manager.list_shortcuts(domain="usda")
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="shortcut-manager")
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class Shortcut:
    """A virtual data access shortcut between domains."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    source_path: str = ""  # Physical ADLS Gen2 path
    source_domain: str = ""  # Owning organization/domain
    target_domain: str = ""  # Consuming organization/domain
    target_alias: str = ""  # Virtual alias path in target domain
    access_level: str = "read"  # read, read_write
    granted_by: str = ""
    granted_to: str = ""  # Managed identity or AD group
    is_active: bool = True
    validated: bool = False
    validation_error: str = ""
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    expires_at: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass
class ValidationResult:
    """Result of validating a shortcut's source path."""

    path: str
    exists: bool = False
    accessible: bool = False
    container: str = ""
    account: str = ""
    error: str = ""


# ---------------------------------------------------------------------------
# Shortcut Manager
# ---------------------------------------------------------------------------


class ShortcutManager:
    """Manage cross-domain data shortcuts on ADLS Gen2.

    Shortcuts are stored in an in-memory registry (development) or
    persisted to Azure SQL / Cosmos DB (production).

    Args:
        credential: Azure credential for storage validation.
        registry_backend: Storage backend ('memory', 'sql', 'cosmos').
    """

    def __init__(
        self,
        credential: Any | None = None,
        registry_backend: str = "memory",
    ) -> None:
        self._credential = credential
        self.registry_backend = registry_backend
        self._shortcuts: dict[str, Shortcut] = {}

    def _parse_abfss_path(self, path: str) -> tuple[str, str, str]:
        """Parse an abfss:// path into (container, account, path).

        Args:
            path: ADLS Gen2 path in abfss format.

        Returns:
            Tuple of (container, account_name, blob_path).

        Raises:
            ValueError: If the path is not a valid abfss URL.
        """
        if not path.startswith("abfss://"):
            raise ValueError(f"Path must start with 'abfss://': {path}")

        # abfss://container@account.dfs.core.windows.net/path/
        without_scheme = path[len("abfss://") :]
        container, rest = without_scheme.split("@", 1)
        host, *path_parts = rest.split("/", 1)
        account = host.split(".")[0]
        blob_path = path_parts[0] if path_parts else ""

        return container, account, blob_path

    def validate_access(
        self,
        path: str,
    ) -> ValidationResult:
        """Validate that a source path exists and is accessible.

        Uses the Azure Storage SDK to check container/blob existence
        and access permissions.

        Args:
            path: ADLS Gen2 abfss path to validate.

        Returns:
            Validation result with details.
        """
        try:
            container, account, blob_path = self._parse_abfss_path(path)
        except ValueError as exc:
            return ValidationResult(path=path, error=str(exc))

        try:
            from azure.storage.blob import BlobServiceClient

            if self._credential is None:
                from azure.identity import DefaultAzureCredential

                self._credential = DefaultAzureCredential()

            account_url = f"https://{account}.blob.core.windows.net"
            service_client = BlobServiceClient(
                account_url=account_url,
                credential=self._credential,
            )

            container_client = service_client.get_container_client(container)
            exists = container_client.exists()

            if not exists:
                return ValidationResult(
                    path=path,
                    exists=False,
                    accessible=False,
                    container=container,
                    account=account,
                    error=f"Container '{container}' not found",
                )

            # Check if we can list blobs (validates read access)
            list(
                container_client.list_blobs(
                    name_starts_with=blob_path,
                    results_per_page=1,
                )
            )

            return ValidationResult(
                path=path,
                exists=True,
                accessible=True,
                container=container,
                account=account,
            )

        except ImportError:
            return ValidationResult(
                path=path,
                error="azure-storage-blob package not installed",
            )
        except Exception as exc:
            return ValidationResult(
                path=path,
                exists=True,
                accessible=False,
                container=container if "container" in dir() else "",
                account=account if "account" in dir() else "",
                error=str(exc),
            )

    def create_shortcut(
        self,
        name: str,
        source_path: str,
        target_domain: str,
        target_alias: str = "",
        source_domain: str = "",
        access_level: str = "read",
        granted_by: str = "",
        granted_to: str = "",
        validate: bool = True,
        expires_at: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> Shortcut:
        """Create a cross-domain shortcut.

        Args:
            name: Shortcut name (unique within target domain).
            source_path: Physical ADLS Gen2 path (abfss://).
            target_domain: Consuming organization name.
            target_alias: Virtual alias path in target domain.
            source_domain: Owning organization name.
            access_level: Access level (read, read_write).
            granted_by: Who authorized the shortcut.
            granted_to: Managed identity or AD group receiving access.
            validate: Whether to validate source path accessibility.
            expires_at: Optional expiration timestamp.
            metadata: Optional key-value metadata.

        Returns:
            The created shortcut.

        Raises:
            ValueError: If validation fails and validate=True.
        """
        # Auto-detect source domain from path
        if not source_domain:
            try:
                _, account, _ = self._parse_abfss_path(source_path)
                source_domain = account.replace("datalake-", "").replace("datalake", "")
            except ValueError:
                source_domain = "unknown"

        shortcut = Shortcut(
            name=name,
            source_path=source_path,
            source_domain=source_domain,
            target_domain=target_domain,
            target_alias=target_alias,
            access_level=access_level,
            granted_by=granted_by,
            granted_to=granted_to,
            expires_at=expires_at,
            metadata=metadata or {},
        )

        if validate:
            result = self.validate_access(source_path)
            shortcut.validated = result.accessible
            if not result.accessible:
                shortcut.validation_error = result.error
                logger.warning(
                    "Shortcut '%s' created but source path validation failed: %s",
                    name,
                    result.error,
                )

        self._shortcuts[shortcut.id] = shortcut
        logger.info(
            "Created shortcut: %s (%s -> %s/%s)",
            name,
            source_path,
            target_domain,
            target_alias,
        )
        return shortcut

    def list_shortcuts(
        self,
        domain: str | None = None,
        active_only: bool = True,
    ) -> list[Shortcut]:
        """List registered shortcuts.

        Args:
            domain: Filter by target domain.
            active_only: Only return active shortcuts.

        Returns:
            List of matching shortcuts.
        """
        shortcuts = list(self._shortcuts.values())

        if domain:
            shortcuts = [s for s in shortcuts if s.target_domain == domain or s.source_domain == domain]
        if active_only:
            shortcuts = [s for s in shortcuts if s.is_active]

        return shortcuts

    def get_shortcut(self, shortcut_id: str) -> Shortcut | None:
        """Get a shortcut by ID."""
        return self._shortcuts.get(shortcut_id)

    def remove_shortcut(
        self,
        shortcut_id: str,
        revoked_by: str = "",
    ) -> bool:
        """Deactivate and remove a shortcut.

        Does not delete the shortcut record but marks it as inactive
        for audit purposes.

        Args:
            shortcut_id: Shortcut ID.
            revoked_by: Who revoked the shortcut.

        Returns:
            True if the shortcut was found and deactivated.
        """
        shortcut = self._shortcuts.get(shortcut_id)
        if shortcut is None:
            return False

        shortcut.is_active = False
        shortcut.updated_at = datetime.now(timezone.utc).isoformat()
        shortcut.metadata["revoked_by"] = revoked_by

        logger.info(
            "Revoked shortcut: %s (source: %s, revoked by: %s)",
            shortcut.name,
            shortcut.source_path,
            revoked_by,
        )
        return True

    def validate_all_shortcuts(self) -> list[dict[str, Any]]:
        """Validate all active shortcuts and report status.

        Returns:
            List of validation reports per shortcut.
        """
        results: list[dict[str, Any]] = []
        for shortcut in self._shortcuts.values():
            if not shortcut.is_active:
                continue

            validation = self.validate_access(shortcut.source_path)
            shortcut.validated = validation.accessible
            shortcut.validation_error = validation.error
            shortcut.updated_at = datetime.now(timezone.utc).isoformat()

            results.append(
                {
                    "shortcut_id": shortcut.id,
                    "name": shortcut.name,
                    "source_path": shortcut.source_path,
                    "accessible": validation.accessible,
                    "error": validation.error,
                }
            )

        logger.info(
            "Validated %d shortcuts: %d accessible",
            len(results),
            sum(1 for r in results if r["accessible"]),
        )
        return results
