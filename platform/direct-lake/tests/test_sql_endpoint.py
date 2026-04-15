"""Tests for Databricks SQL Endpoint management.

Tests DatabricksSQLEndpointManager: endpoint creation, configuration
updates, RBAC permission grants, and connection string generation.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Bootstrap: add source dir to path and inject mock Databricks SDK modules
# ---------------------------------------------------------------------------
_scripts = str(Path(__file__).resolve().parent.parent / "scripts")
if _scripts not in sys.path:
    sys.path.insert(0, _scripts)

for _m in [
    "databricks", "databricks.sdk", "databricks.sdk.service",
    "databricks.sdk.service.sql", "databricks.sdk.service.iam",
]:
    sys.modules.setdefault(_m, MagicMock())
# ---------------------------------------------------------------------------

import pytest
from configure_sql_endpoint import (
    DatabricksSQLEndpointManager,
    EndpointConfig,
    EndpointInfo,
    PermissionGrant,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _mock_warehouse(**overrides):
    """Build a mock warehouse response object."""
    defaults = {
        "id": "warehouse-001",
        "name": "csa-direct-lake",
        "state": "RUNNING",
        "cluster_size": "Small",
        "num_clusters": 1,
        "num_active_sessions": 0,
        "auto_stop_mins": 30,
        "warehouse_type": "PRO",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@pytest.fixture
def mock_workspace_client():
    """Return a mocked Databricks WorkspaceClient."""
    client = MagicMock()
    client.warehouses.get.return_value = _mock_warehouse()
    client.warehouses.create_and_wait.return_value = _mock_warehouse()
    return client


@pytest.fixture
def manager(mock_workspace_client):
    """Return a DatabricksSQLEndpointManager with injected mock."""
    mgr = DatabricksSQLEndpointManager(
        workspace_url="https://adb-123.azuredatabricks.net",
        token="test-token",
    )
    mgr._client = mock_workspace_client
    return mgr


# ---------------------------------------------------------------------------
# Endpoint creation tests
# ---------------------------------------------------------------------------


class TestCreateEndpoint:
    """Test DatabricksSQLEndpointManager.create_endpoint."""

    def test_create_returns_endpoint_info(self, manager):
        config = EndpointConfig(
            name="csa-direct-lake",
            cluster_size="Small",
            auto_stop_mins=30,
        )

        info = manager.create_endpoint(config)

        assert isinstance(info, EndpointInfo)
        assert info.id == "warehouse-001"
        assert info.name == "csa-direct-lake"
        assert info.state == "RUNNING"

    def test_create_passes_config_to_sdk(self, manager, mock_workspace_client):
        config = EndpointConfig(
            name="my-warehouse",
            cluster_size="Medium",
            min_num_clusters=1,
            max_num_clusters=3,
            auto_stop_mins=15,
            enable_serverless_compute=True,
            tags={"env": "prod"},
        )

        manager.create_endpoint(config)

        call_kwargs = mock_workspace_client.warehouses.create_and_wait.call_args.kwargs
        assert call_kwargs["name"] == "my-warehouse"
        assert call_kwargs["cluster_size"] == "Medium"
        assert call_kwargs["max_num_clusters"] == 3
        assert call_kwargs["auto_stop_mins"] == 15
        assert call_kwargs["enable_serverless_compute"] is True

    def test_create_without_tags(self, manager, mock_workspace_client):
        config = EndpointConfig(name="no-tags", tags={})
        manager.create_endpoint(config)

        call_kwargs = mock_workspace_client.warehouses.create_and_wait.call_args.kwargs
        assert call_kwargs.get("tags") is None


# ---------------------------------------------------------------------------
# Configuration update tests
# ---------------------------------------------------------------------------


class TestConfigureWarehouse:
    """Test DatabricksSQLEndpointManager.configure_warehouse."""

    def test_configure_updates_size(self, manager, mock_workspace_client):
        mock_workspace_client.warehouses.get.return_value = _mock_warehouse(
            cluster_size="Medium"
        )

        info = manager.configure_warehouse(
            endpoint_id="warehouse-001",
            cluster_size="Large",
        )

        mock_workspace_client.warehouses.edit.assert_called_once()
        edit_kwargs = mock_workspace_client.warehouses.edit.call_args.kwargs
        assert edit_kwargs["cluster_size"] == "Large"

    def test_configure_preserves_name(self, manager, mock_workspace_client):
        manager.configure_warehouse(
            endpoint_id="warehouse-001",
            auto_stop_mins=60,
        )

        edit_kwargs = mock_workspace_client.warehouses.edit.call_args.kwargs
        assert edit_kwargs["name"] == "csa-direct-lake"
        assert edit_kwargs["auto_stop_mins"] == 60


# ---------------------------------------------------------------------------
# RBAC permission tests
# ---------------------------------------------------------------------------


class TestSetPermissions:
    """Test DatabricksSQLEndpointManager.set_permissions."""

    def test_grant_user_permission(self, manager, mock_workspace_client):
        grants = [
            PermissionGrant(
                principal="analyst@contoso.com",
                principal_type="user",
                permission="CAN_USE",
            ),
        ]

        results = manager.set_permissions("warehouse-001", grants)

        assert len(results) == 1
        assert results[0]["status"] == "granted"
        assert results[0]["principal"] == "analyst@contoso.com"
        mock_workspace_client.permissions.update.assert_called_once()

    def test_grant_group_permission(self, manager, mock_workspace_client):
        grants = [
            PermissionGrant(
                principal="data-analysts",
                principal_type="group",
                permission="CAN_MANAGE",
            ),
        ]

        results = manager.set_permissions("warehouse-001", grants)

        assert results[0]["status"] == "granted"
        assert results[0]["permission"] == "CAN_MANAGE"

    def test_grant_service_principal_permission(self, manager, mock_workspace_client):
        grants = [
            PermissionGrant(
                principal="sp-etl-pipeline",
                principal_type="service_principal",
                permission="CAN_USE",
            ),
        ]

        results = manager.set_permissions("warehouse-001", grants)
        assert results[0]["status"] == "granted"

    def test_grant_error_handled(self, manager, mock_workspace_client):
        mock_workspace_client.permissions.update.side_effect = RuntimeError("API error")

        grants = [
            PermissionGrant(principal="bad-user", permission="CAN_USE"),
        ]

        results = manager.set_permissions("warehouse-001", grants)
        assert results[0]["status"] == "error"
        assert "API error" in results[0]["error"]

    def test_multiple_grants(self, manager, mock_workspace_client):
        grants = [
            PermissionGrant(principal="user-a", permission="CAN_USE"),
            PermissionGrant(principal="user-b", principal_type="group", permission="CAN_MANAGE"),
        ]

        results = manager.set_permissions("warehouse-001", grants)
        assert len(results) == 2
        assert all(r["status"] == "granted" for r in results)


# ---------------------------------------------------------------------------
# Connection string generation
# ---------------------------------------------------------------------------


class TestGetConnectionString:
    """Test connection string generation for Power BI."""

    def test_connection_string_defaults(self, manager):
        conn = manager.get_connection_string("warehouse-001")

        assert conn["host"] == "adb-123.azuredatabricks.net"
        assert conn["http_path"] == "/sql/1.0/warehouses/warehouse-001"
        assert conn["port"] == "443"
        assert conn["catalog"] == "hive_metastore"
        assert conn["schema"] == "default"
        assert "jdbc:databricks://" in conn["jdbc_url"]
        assert "warehouse-001" in conn["jdbc_url"]

    def test_connection_string_custom_catalog_schema(self, manager):
        conn = manager.get_connection_string(
            "warehouse-001",
            catalog="finance",
            schema="gold",
        )

        assert conn["catalog"] == "finance"
        assert conn["schema"] == "gold"
        assert "ConnCatalog=finance" in conn["jdbc_url"]
        assert "ConnSchema=gold" in conn["jdbc_url"]

    def test_odbc_dsn_generated(self, manager):
        conn = manager.get_connection_string("warehouse-001")

        assert "Simba Spark ODBC Driver" in conn["odbc_dsn"]
        assert "Port=443" in conn["odbc_dsn"]
        assert "SSL=1" in conn["odbc_dsn"]

    def test_warehouse_info_included(self, manager):
        conn = manager.get_connection_string("warehouse-001")
        assert conn["warehouse_name"] == "csa-direct-lake"
        assert conn["warehouse_id"] == "warehouse-001"
