"""Tests for the cross-domain shortcut manager.

Tests ShortcutManager: shortcut creation, abfss:// path parsing,
validation with mocked BlobServiceClient, revocation (soft delete),
bulk validation, and expiration handling.
"""

from __future__ import annotations

import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Bootstrap: add source dir to path
# ---------------------------------------------------------------------------
_unity = str(Path(__file__).resolve().parent.parent / "unity_catalog")
if _unity not in sys.path:
    sys.path.insert(0, _unity)

# Ensure azure.storage.blob is a real module (not a MagicMock) so that
# @patch("azure.storage.blob.BlobServiceClient") works even when the
# multi_synapse tests have already injected a MagicMock for "azure".
_blob_mod = types.ModuleType("azure.storage.blob")
_blob_mod.BlobServiceClient = MagicMock()
sys.modules.setdefault("azure.storage", types.ModuleType("azure.storage"))
sys.modules["azure.storage.blob"] = _blob_mod
# ---------------------------------------------------------------------------

import pytest
from shortcut_manager import (
    Shortcut,
    ShortcutManager,
    ValidationResult,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def manager() -> ShortcutManager:
    """Return a ShortcutManager with mocked credential (no validation)."""
    return ShortcutManager(credential=MagicMock(), registry_backend="memory")


# ---------------------------------------------------------------------------
# abfss:// path parsing
# ---------------------------------------------------------------------------


class TestParseAbfssPath:
    """Test ShortcutManager._parse_abfss_path."""

    def test_valid_abfss_path(self, manager) -> None:
        container, account, path = manager._parse_abfss_path(
            "abfss://gold@datalake-dod.dfs.core.windows.net/orders/2024/"
        )
        assert container == "gold"
        assert account == "datalake-dod"
        assert path == "orders/2024/"

    def test_path_without_trailing_path(self, manager) -> None:
        container, account, path = manager._parse_abfss_path("abfss://container@myaccount.dfs.core.windows.net/")
        assert container == "container"
        assert account == "myaccount"
        assert path == ""

    def test_invalid_scheme_raises(self, manager) -> None:
        with pytest.raises(ValueError, match="abfss://"):
            manager._parse_abfss_path("https://datalake.blob.core.windows.net/data")

    def test_govcloud_path(self, manager) -> None:
        container, account, _ = manager._parse_abfss_path("abfss://gold@datalake.dfs.core.usgovcloudapi.net/data/")
        assert container == "gold"
        assert account == "datalake"


# ---------------------------------------------------------------------------
# Shortcut creation
# ---------------------------------------------------------------------------


class TestCreateShortcut:
    """Test ShortcutManager.create_shortcut."""

    def test_create_without_validation(self, manager) -> None:
        shortcut = manager.create_shortcut(
            name="dod-orders",
            source_path="abfss://gold@datalake-dod.dfs.core.windows.net/orders/",
            target_domain="usda",
            target_alias="abfss://shared@datalake-usda.dfs.core.windows.net/shortcuts/dod-orders/",
            granted_by="data-steward@gov.mil",
            validate=False,
        )

        assert isinstance(shortcut, Shortcut)
        assert shortcut.name == "dod-orders"
        assert shortcut.target_domain == "usda"
        assert shortcut.is_active is True
        assert shortcut.source_domain == "dod"  # auto-detected from path

    def test_create_with_explicit_source_domain(self, manager) -> None:
        shortcut = manager.create_shortcut(
            name="test",
            source_path="abfss://c@acct.dfs.core.windows.net/",
            target_domain="consumer",
            source_domain="explicit-domain",
            validate=False,
        )
        assert shortcut.source_domain == "explicit-domain"

    def test_create_with_expiration(self, manager) -> None:
        expiry = (datetime.now(timezone.utc) + timedelta(days=90)).isoformat()
        shortcut = manager.create_shortcut(
            name="temp-share",
            source_path="abfss://c@acct.dfs.core.windows.net/",
            target_domain="consumer",
            expires_at=expiry,
            validate=False,
        )
        assert shortcut.expires_at == expiry

    def test_create_with_metadata(self, manager) -> None:
        shortcut = manager.create_shortcut(
            name="meta-share",
            source_path="abfss://c@acct.dfs.core.windows.net/",
            target_domain="consumer",
            metadata={"project": "csa-alpha", "tier": "gold"},
            validate=False,
        )
        assert shortcut.metadata["project"] == "csa-alpha"


# ---------------------------------------------------------------------------
# Validation with mocked BlobServiceClient
# ---------------------------------------------------------------------------


class TestValidateAccess:
    """Test shortcut validation using mocked Azure Storage SDK."""

    @patch("azure.storage.blob.BlobServiceClient")
    def test_validate_accessible_path(self, mock_blob_cls, manager) -> None:
        mock_container = MagicMock()
        mock_container.exists.return_value = True
        mock_container.list_blobs.return_value = []

        mock_service = MagicMock()
        mock_service.get_container_client.return_value = mock_container
        mock_blob_cls.return_value = mock_service

        result = manager.validate_access("abfss://gold@datalake.dfs.core.windows.net/data/")

        assert isinstance(result, ValidationResult)
        assert result.exists is True
        assert result.accessible is True
        assert result.container == "gold"
        assert result.account == "datalake"

    @patch("azure.storage.blob.BlobServiceClient")
    def test_validate_nonexistent_container(self, mock_blob_cls, manager) -> None:
        mock_container = MagicMock()
        mock_container.exists.return_value = False

        mock_service = MagicMock()
        mock_service.get_container_client.return_value = mock_container
        mock_blob_cls.return_value = mock_service

        result = manager.validate_access("abfss://missing@datalake.dfs.core.windows.net/data/")

        assert result.exists is False
        assert result.accessible is False
        assert "not found" in result.error

    def test_validate_invalid_path(self, manager) -> None:
        result = manager.validate_access("https://notabfss.com/data")
        assert result.accessible is False
        assert "abfss://" in result.error


# ---------------------------------------------------------------------------
# Revocation (soft delete)
# ---------------------------------------------------------------------------


class TestRemoveShortcut:
    """Test shortcut revocation (soft delete)."""

    def test_remove_marks_inactive(self, manager) -> None:
        shortcut = manager.create_shortcut(
            name="to-revoke",
            source_path="abfss://c@acct.dfs.core.windows.net/",
            target_domain="consumer",
            validate=False,
        )

        result = manager.remove_shortcut(shortcut.id, revoked_by="admin@gov.mil")

        assert result is True
        revoked = manager.get_shortcut(shortcut.id)
        assert revoked.is_active is False
        assert revoked.metadata["revoked_by"] == "admin@gov.mil"

    def test_remove_nonexistent_returns_false(self, manager) -> None:
        result = manager.remove_shortcut("nonexistent-id")
        assert result is False


# ---------------------------------------------------------------------------
# Listing and filtering
# ---------------------------------------------------------------------------


class TestListShortcuts:
    """Test shortcut listing with domain and active filters."""

    def test_list_by_target_domain(self, manager) -> None:
        manager.create_shortcut(
            name="s1",
            source_path="abfss://c@a.dfs.core.windows.net/",
            target_domain="usda",
            validate=False,
        )
        manager.create_shortcut(
            name="s2",
            source_path="abfss://c@a.dfs.core.windows.net/",
            target_domain="dod",
            validate=False,
        )

        results = manager.list_shortcuts(domain="usda")
        assert len(results) == 1
        assert results[0].name == "s1"

    def test_list_active_only_excludes_revoked(self, manager) -> None:
        s = manager.create_shortcut(
            name="revoked",
            source_path="abfss://c@a.dfs.core.windows.net/",
            target_domain="consumer",
            validate=False,
        )
        manager.remove_shortcut(s.id)

        active = manager.list_shortcuts(active_only=True)
        assert len(active) == 0

        all_shortcuts = manager.list_shortcuts(active_only=False)
        assert len(all_shortcuts) == 1


# ---------------------------------------------------------------------------
# Bulk validation
# ---------------------------------------------------------------------------


class TestBulkValidation:
    """Test validate_all_shortcuts."""

    @patch("azure.storage.blob.BlobServiceClient")
    def test_validate_all_updates_shortcut_status(self, mock_blob_cls, manager) -> None:
        mock_container = MagicMock()
        mock_container.exists.return_value = True
        mock_container.list_blobs.return_value = []

        mock_service = MagicMock()
        mock_service.get_container_client.return_value = mock_container
        mock_blob_cls.return_value = mock_service

        manager.create_shortcut(
            name="s1",
            source_path="abfss://c@acct.dfs.core.windows.net/data/",
            target_domain="consumer",
            validate=False,
        )

        results = manager.validate_all_shortcuts()

        assert len(results) == 1
        assert results[0]["accessible"] is True
        assert results[0]["name"] == "s1"
