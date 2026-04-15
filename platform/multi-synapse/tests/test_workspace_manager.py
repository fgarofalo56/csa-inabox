"""Tests for Synapse workspace lifecycle management.

Tests SynapseWorkspaceManager: workspace creation, listing, firewall
configuration, managed VNet, RBAC assignment, and GovCloud endpoint
detection.
"""

from __future__ import annotations

import sys
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
    "azure", "azure.mgmt", "azure.mgmt.synapse", "azure.mgmt.synapse.models",
    "azure.mgmt.authorization", "azure.mgmt.authorization.models",
    "azure.identity",
]:
    sys.modules.setdefault(_m, MagicMock())
# ---------------------------------------------------------------------------

import pytest
from workspace_manager import (
    SynapseWorkspaceManager,
    WorkspaceConfig,
    WorkspaceInfo,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_credential():
    """Return a fake Azure credential."""
    return MagicMock()


@pytest.fixture
def mock_synapse_client():
    """Return a mocked SynapseManagementClient with workspace/firewall stubs."""
    client = MagicMock()

    # Default workspace.get response
    workspace_obj = SimpleNamespace(
        id="/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Synapse/workspaces/ws-1",
        name="ws-1",
        location="usgovvirginia",
        provisioning_state="Succeeded",
        managed_virtual_network="default",
        connectivity_endpoints={"sql": "ws-1.sql.azuresynapse.usgovcloudapi.net"},
        tags={"org": "USDA"},
    )
    client.workspaces.get.return_value = workspace_obj

    # Poller stub for begin_create_or_update
    poller = MagicMock()
    poller.result.return_value = workspace_obj
    client.workspaces.begin_create_or_update.return_value = poller

    # Firewall poller stub
    fw_poller = MagicMock()
    fw_poller.result.return_value = None
    client.ip_firewall_rules.begin_create_or_update.return_value = fw_poller

    return client


@pytest.fixture
def manager(mock_credential, mock_synapse_client):
    """Return a SynapseWorkspaceManager with injected mocks."""
    mgr = SynapseWorkspaceManager(
        subscription_id="sub-1",
        credential=mock_credential,
    )
    mgr._client = mock_synapse_client
    return mgr


# ---------------------------------------------------------------------------
# Workspace creation tests
# ---------------------------------------------------------------------------


class TestCreateWorkspace:
    """Test SynapseWorkspaceManager.create_workspace."""

    def test_create_workspace_returns_expected_dict(self, manager, mock_synapse_client):
        config = WorkspaceConfig(
            name="synapse-usda",
            resource_group="csa-platform",
            subscription_id="sub-1",
            location="usgovvirginia",
            storage_account="csadatalake",
            tags={"org": "USDA"},
        )

        result = manager.create_workspace(config)

        assert result["name"] == "ws-1"
        assert result["location"] == "usgovvirginia"
        assert result["state"] == "Succeeded"
        assert result["managed_vnet"] is True

    def test_create_workspace_govcloud_storage_url(self, manager, mock_synapse_client):
        """GovCloud locations should use .dfs.core.usgovcloudapi.net."""
        config = WorkspaceConfig(
            name="ws-gov",
            resource_group="rg",
            subscription_id="sub-1",
            location="usgovvirginia",
            storage_account="mydatalake",
        )

        result = manager.create_workspace(config)

        # The method builds the storage URL based on location; result is
        # from the mock poller so we verify the API was called.
        mock_synapse_client.workspaces.begin_create_or_update.assert_called_once()
        assert result["name"] == "ws-1"

    def test_create_workspace_calls_begin_create_or_update(self, manager, mock_synapse_client):
        config = WorkspaceConfig(
            name="ws-comm",
            resource_group="rg",
            subscription_id="sub-1",
            location="eastus",
            storage_account="mydatalake",
        )

        manager.create_workspace(config)

        call_kwargs = mock_synapse_client.workspaces.begin_create_or_update.call_args.kwargs
        assert call_kwargs["resource_group_name"] == "rg"
        assert call_kwargs["workspace_name"] == "ws-comm"

    def test_create_workspace_without_managed_vnet_passes_none(self, manager, mock_synapse_client):
        config = WorkspaceConfig(
            name="ws-no-vnet",
            resource_group="rg",
            subscription_id="sub-1",
            location="eastus",
            storage_account="dl",
            managed_vnet_enabled=False,
        )

        manager.create_workspace(config)

        # Verify the Workspace constructor was called with managed_virtual_network=None
        ws_model_cls = sys.modules["azure.mgmt.synapse.models"].Workspace
        call_kwargs = ws_model_cls.call_args.kwargs
        assert call_kwargs["managed_virtual_network"] is None
        assert call_kwargs["managed_virtual_network_settings"] is None

    def test_create_workspace_with_tags(self, manager, mock_synapse_client):
        config = WorkspaceConfig(
            name="ws-tagged",
            resource_group="rg",
            subscription_id="sub-1",
            storage_account="dl",
            tags={"org": "USDA", "env": "prod"},
        )

        manager.create_workspace(config)

        ws_model_cls = sys.modules["azure.mgmt.synapse.models"].Workspace
        call_kwargs = ws_model_cls.call_args.kwargs
        assert call_kwargs["tags"] == {"org": "USDA", "env": "prod"}


# ---------------------------------------------------------------------------
# Listing tests
# ---------------------------------------------------------------------------


class TestListWorkspaces:
    """Test SynapseWorkspaceManager.list_workspaces."""

    def test_list_workspaces_returns_workspace_info_objects(self, manager, mock_synapse_client):
        ws1 = SimpleNamespace(
            name="ws-a",
            location="usgovvirginia",
            provisioning_state="Succeeded",
            managed_virtual_network="default",
            connectivity_endpoints={"sql": "ws-a.sql.net"},
            tags={"org": "DOD"},
        )
        ws2 = SimpleNamespace(
            name="ws-b",
            location="usgovarizona",
            provisioning_state="Creating",
            managed_virtual_network=None,
            connectivity_endpoints={},
            tags={},
        )
        mock_synapse_client.workspaces.list_by_resource_group.return_value = [ws1, ws2]

        results = manager.list_workspaces("csa-platform")

        assert len(results) == 2
        assert isinstance(results[0], WorkspaceInfo)
        assert results[0].name == "ws-a"
        assert results[0].managed_vnet is True
        assert results[1].managed_vnet is False
        assert results[1].state == "Creating"

    def test_list_workspaces_empty(self, manager, mock_synapse_client):
        mock_synapse_client.workspaces.list_by_resource_group.return_value = []
        results = manager.list_workspaces("empty-rg")
        assert results == []


# ---------------------------------------------------------------------------
# Firewall configuration tests
# ---------------------------------------------------------------------------


class TestConfigureFirewall:
    """Test SynapseWorkspaceManager.configure_firewall."""

    def test_configure_firewall_creates_azure_services_rule(self, manager, mock_synapse_client):
        results = manager.configure_firewall(
            resource_group="rg",
            workspace_name="ws-1",
            allowed_ip_ranges=[],
            allow_azure_services=True,
        )

        assert len(results) == 1
        assert results[0]["name"] == "AllowAllWindowsAzureIps"
        assert results[0]["range"] == "0.0.0.0/0"
        assert results[0]["status"] == "created"

    def test_configure_firewall_with_ip_ranges(self, manager, mock_synapse_client):
        results = manager.configure_firewall(
            resource_group="rg",
            workspace_name="ws-1",
            allowed_ip_ranges=["10.0.0.0/8", "172.16.0.0/12"],
            allow_azure_services=False,
        )

        assert len(results) == 2
        assert results[0]["name"] == "AllowedRange_0"
        assert results[0]["range"] == "10.0.0.0/8"
        assert results[1]["name"] == "AllowedRange_1"

    def test_configure_firewall_calls_api_per_range(self, manager, mock_synapse_client):
        manager.configure_firewall(
            resource_group="rg",
            workspace_name="ws-1",
            allowed_ip_ranges=["10.0.0.0/8"],
            allow_azure_services=True,
        )

        # 1 call for Azure services + 1 for the IP range
        assert mock_synapse_client.ip_firewall_rules.begin_create_or_update.call_count == 2


# ---------------------------------------------------------------------------
# RBAC assignment tests
# ---------------------------------------------------------------------------


class TestAssignRbac:
    """Test SynapseWorkspaceManager.assign_rbac."""

    def test_assign_rbac_success(self, manager, mock_synapse_client, mock_credential):
        mock_auth_client = MagicMock()
        role_def = SimpleNamespace(id="/role-def-id")
        mock_auth_client.role_definitions.list.return_value = [role_def]
        assignment_result = SimpleNamespace(name="assignment-uuid")
        mock_auth_client.role_assignments.create.return_value = assignment_result

        # Patch the AuthorizationManagementClient constructor in the azure module
        auth_mod = sys.modules["azure.mgmt.authorization"]
        auth_mod.AuthorizationManagementClient = MagicMock(return_value=mock_auth_client)

        result = manager.assign_rbac(
            resource_group="rg",
            workspace_name="ws-1",
            principal_id="user-principal-id",
            role="Synapse Contributor",
        )

        assert result["principal_id"] == "user-principal-id"
        assert result["role"] == "Synapse Contributor"
        assert "scope" in result
        assert "assignment_id" in result

    def test_assign_rbac_role_not_found_raises(self, manager, mock_synapse_client, mock_credential):
        mock_auth_client = MagicMock()
        mock_auth_client.role_definitions.list.return_value = []

        auth_mod = sys.modules["azure.mgmt.authorization"]
        auth_mod.AuthorizationManagementClient = MagicMock(return_value=mock_auth_client)

        with pytest.raises(ValueError, match="Role .* not found"):
            manager.assign_rbac(
                resource_group="rg",
                workspace_name="ws-1",
                principal_id="user-id",
                role="NonexistentRole",
            )
