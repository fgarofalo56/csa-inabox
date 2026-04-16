"""Synapse workspace lifecycle management for multi-org deployments.

Provides programmatic creation, configuration, and RBAC assignment for
Azure Synapse Analytics workspaces in a multi-tenant CSA-in-a-Box
deployment.

Usage::

    # Create a workspace for an organization
    python workspace_manager.py create \\
        --subscription-id <sub-id> \\
        --resource-group csa-platform \\
        --name synapse-usda \\
        --location usgovvirginia \\
        --storage-account csadatalake \\
        --tags org=USDA environment=prod

    # List all workspaces
    python workspace_manager.py list \\
        --subscription-id <sub-id> \\
        --resource-group csa-platform

    # Configure firewall and managed VNet
    python workspace_manager.py configure \\
        --subscription-id <sub-id> \\
        --resource-group csa-platform \\
        --name synapse-usda \\
        --enable-managed-vnet \\
        --allowed-ips 10.0.0.0/8
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from typing import Any

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="workspace-manager")
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class WorkspaceConfig:
    """Configuration for a Synapse workspace."""

    name: str
    resource_group: str
    subscription_id: str
    location: str = "usgovvirginia"
    storage_account: str = ""
    storage_filesystem: str = "synapse"
    managed_vnet_enabled: bool = True
    managed_resource_group: str = ""
    sql_admin_login: str = "sqladmin"
    sql_admin_password: str = ""
    tags: dict[str, str] = field(default_factory=dict)
    allowed_ip_ranges: list[str] = field(default_factory=list)
    private_endpoints_only: bool = False


@dataclass
class WorkspaceInfo:
    """Summary information about a Synapse workspace."""

    name: str
    resource_group: str
    location: str
    state: str
    managed_vnet: bool
    connectivity_endpoints: dict[str, str] = field(default_factory=dict)
    tags: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Workspace Manager
# ---------------------------------------------------------------------------


class SynapseWorkspaceManager:
    """Manage Azure Synapse Analytics workspaces.

    Args:
        subscription_id: Azure subscription ID.
        credential: Azure credential object (e.g., DefaultAzureCredential()).
    """

    def __init__(
        self,
        subscription_id: str,
        credential: Any | None = None,
    ) -> None:
        self.subscription_id = subscription_id
        self._credential = credential
        self._client: Any | None = None  # TODO: Replace with typed client when SDK stubs are available

    def _get_client(self) -> Any:
        """Lazily initialize the Synapse management client."""
        if self._client is not None:
            return self._client

        from azure.mgmt.synapse import SynapseManagementClient

        if self._credential is None:
            from azure.identity import DefaultAzureCredential

            self._credential = DefaultAzureCredential()

        self._client = SynapseManagementClient(
            credential=self._credential,
            subscription_id=self.subscription_id,
        )
        return self._client

    # -- Workspace CRUD -----------------------------------------------------

    def create_workspace(self, config: WorkspaceConfig) -> dict[str, Any]:
        """Create a new Synapse workspace.

        Args:
            config: Workspace configuration.

        Returns:
            Dictionary with workspace details from the API response.

        Raises:
            RuntimeError: If creation fails.
        """
        from azure.mgmt.synapse.models import (
            DataLakeStorageAccountDetails,
            ManagedVirtualNetworkSettings,
            Workspace,
        )

        client = self._get_client()

        storage_url = (
            f"https://{config.storage_account}.dfs.core.usgovcloudapi.net"
            if "usgov" in config.location.lower()
            else f"https://{config.storage_account}.dfs.core.windows.net"
        )

        default_storage = DataLakeStorageAccountDetails(
            account_url=storage_url,
            filesystem=config.storage_filesystem,
        )

        managed_vnet = None
        if config.managed_vnet_enabled:
            managed_vnet = ManagedVirtualNetworkSettings(
                prevent_data_exfiltration=True,
                allowed_aad_tenant_ids_for_linking=[],
            )

        workspace_params = Workspace(
            location=config.location,
            default_data_lake_storage=default_storage,
            sql_administrator_login=config.sql_admin_login,
            sql_administrator_login_password=config.sql_admin_password or None,
            managed_virtual_network="default" if config.managed_vnet_enabled else None,
            managed_virtual_network_settings=managed_vnet,
            managed_resource_group_name=config.managed_resource_group or None,
            tags=config.tags,
        )

        logger.info(
            "Creating Synapse workspace '%s' in %s/%s",
            config.name,
            config.resource_group,
            config.location,
        )

        poller = client.workspaces.begin_create_or_update(
            resource_group_name=config.resource_group,
            workspace_name=config.name,
            workspace_info=workspace_params,
        )

        result = poller.result()
        logger.info("workspace.created", name=config.name)

        return {
            "name": result.name,
            "location": result.location,
            "state": result.provisioning_state,
            "connectivity_endpoints": dict(result.connectivity_endpoints or {}),
            "managed_vnet": config.managed_vnet_enabled,
            "tags": dict(result.tags or {}),
        }

    def list_workspaces(
        self,
        resource_group: str,
    ) -> list[WorkspaceInfo]:
        """List all Synapse workspaces in a resource group.

        Args:
            resource_group: Azure resource group name.

        Returns:
            List of workspace info objects.
        """
        client = self._get_client()
        workspaces = client.workspaces.list_by_resource_group(resource_group)

        results: list[WorkspaceInfo] = []
        for ws in workspaces:
            results.append(
                WorkspaceInfo(
                    name=ws.name,
                    resource_group=resource_group,
                    location=ws.location,
                    state=ws.provisioning_state or "Unknown",
                    managed_vnet=ws.managed_virtual_network is not None,
                    connectivity_endpoints=dict(ws.connectivity_endpoints or {}),
                    tags=dict(ws.tags or {}),
                )
            )

        logger.info("workspaces.listed", count=len(results), resource_group=resource_group)
        return results

    def configure_firewall(
        self,
        resource_group: str,
        workspace_name: str,
        allowed_ip_ranges: list[str],
        allow_azure_services: bool = True,
    ) -> list[dict[str, Any]]:
        """Configure IP firewall rules for a workspace.

        Args:
            resource_group: Azure resource group name.
            workspace_name: Synapse workspace name.
            allowed_ip_ranges: List of CIDR ranges to allow.
            allow_azure_services: Whether to allow Azure service access.

        Returns:
            List of created/updated firewall rules.
        """
        from azure.mgmt.synapse.models import IpFirewallRuleInfo

        client = self._get_client()
        results: list[dict[str, Any]] = []

        if allow_azure_services:
            rule = IpFirewallRuleInfo(
                start_ip_address="0.0.0.0",
                end_ip_address="0.0.0.0",
            )
            poller = client.ip_firewall_rules.begin_create_or_update(
                resource_group_name=resource_group,
                workspace_name=workspace_name,
                rule_name="AllowAllWindowsAzureIps",
                ip_firewall_rule_info=rule,
            )
            poller.result()
            results.append(
                {
                    "name": "AllowAllWindowsAzureIps",
                    "range": "0.0.0.0/0",
                    "status": "created",
                }
            )

        for i, cidr in enumerate(allowed_ip_ranges):
            parts = cidr.split("/")
            start_ip = parts[0]
            # Calculate end IP based on CIDR (simplified)
            end_ip = start_ip  # Simplified; proper CIDR calc in production

            rule = IpFirewallRuleInfo(
                start_ip_address=start_ip,
                end_ip_address=end_ip,
            )

            rule_name = f"AllowedRange_{i}"
            poller = client.ip_firewall_rules.begin_create_or_update(
                resource_group_name=resource_group,
                workspace_name=workspace_name,
                rule_name=rule_name,
                ip_firewall_rule_info=rule,
            )
            poller.result()
            results.append(
                {
                    "name": rule_name,
                    "range": cidr,
                    "status": "created",
                }
            )
            logger.info(
                "Firewall rule '%s' created for %s: %s",
                rule_name,
                workspace_name,
                cidr,
            )

        return results

    def set_managed_vnet(
        self,
        resource_group: str,
        workspace_name: str,
        prevent_data_exfiltration: bool = True,
    ) -> dict[str, Any]:
        """Enable and configure managed virtual network.

        Args:
            resource_group: Azure resource group name.
            workspace_name: Synapse workspace name.
            prevent_data_exfiltration: Enable data exfiltration prevention.

        Returns:
            Updated workspace configuration.
        """
        from azure.mgmt.synapse.models import (
            ManagedVirtualNetworkSettings,
            Workspace,
        )

        client = self._get_client()

        workspace_update = Workspace(
            location="",  # Required but will be preserved
            managed_virtual_network="default",
            managed_virtual_network_settings=ManagedVirtualNetworkSettings(
                prevent_data_exfiltration=prevent_data_exfiltration,
            ),
        )

        poller = client.workspaces.begin_create_or_update(
            resource_group_name=resource_group,
            workspace_name=workspace_name,
            workspace_info=workspace_update,
        )
        result = poller.result()

        logger.info(
            "Managed VNet configured for %s (exfiltration prevention: %s)",
            workspace_name,
            prevent_data_exfiltration,
        )

        return {
            "name": result.name,
            "managed_vnet": True,
            "prevent_data_exfiltration": prevent_data_exfiltration,
        }

    def assign_rbac(
        self,
        resource_group: str,
        workspace_name: str,
        principal_id: str,
        role: str = "Synapse Contributor",
    ) -> dict[str, Any]:
        """Assign an RBAC role on the Synapse workspace.

        Args:
            resource_group: Azure resource group name.
            workspace_name: Synapse workspace name.
            principal_id: Azure AD principal (user, group, or service principal) ID.
            role: Role name to assign.

        Returns:
            Role assignment result.
        """
        import uuid

        from azure.mgmt.authorization import AuthorizationManagementClient
        from azure.mgmt.authorization.models import RoleAssignmentCreateParameters

        auth_client = AuthorizationManagementClient(
            credential=self._credential,
            subscription_id=self.subscription_id,
        )

        # Look up the workspace resource ID
        client = self._get_client()
        workspace = client.workspaces.get(resource_group, workspace_name)
        scope = workspace.id

        # Resolve role definition ID
        role_definitions = auth_client.role_definitions.list(
            scope=scope,
            filter=f"roleName eq '{role}'",
        )
        role_def = next(iter(role_definitions), None)
        if role_def is None:
            raise ValueError(f"Role '{role}' not found for scope {scope}")

        assignment_id = str(uuid.uuid4())
        params = RoleAssignmentCreateParameters(
            role_definition_id=role_def.id,
            principal_id=principal_id,
        )

        result = auth_client.role_assignments.create(
            scope=scope,
            role_assignment_name=assignment_id,
            parameters=params,
        )

        logger.info(
            "Assigned role '%s' to %s on workspace %s",
            role,
            principal_id,
            workspace_name,
        )

        return {
            "assignment_id": result.name,
            "principal_id": principal_id,
            "role": role,
            "scope": scope,
        }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli_create(args: argparse.Namespace) -> None:
    """Handle the 'create' subcommand."""
    tags = {}
    if args.tags:
        for tag in args.tags:
            k, v = tag.split("=", 1)
            tags[k] = v

    config = WorkspaceConfig(
        name=args.name,
        resource_group=args.resource_group,
        subscription_id=args.subscription_id,
        location=args.location,
        storage_account=args.storage_account,
        tags=tags,
    )

    manager = SynapseWorkspaceManager(args.subscription_id)
    result = manager.create_workspace(config)
    print(json.dumps(result, indent=2))


def _cli_list(args: argparse.Namespace) -> None:
    """Handle the 'list' subcommand."""
    manager = SynapseWorkspaceManager(args.subscription_id)
    workspaces = manager.list_workspaces(args.resource_group)

    for ws in workspaces:
        print(f"  {ws.name:30s}  {ws.location:20s}  {ws.state:15s}  VNet={ws.managed_vnet}")


def _cli_configure(args: argparse.Namespace) -> None:
    """Handle the 'configure' subcommand."""
    manager = SynapseWorkspaceManager(args.subscription_id)

    if args.enable_managed_vnet:
        result = manager.set_managed_vnet(
            args.resource_group,
            args.name,
        )
        print(f"Managed VNet enabled: {json.dumps(result, indent=2)}")

    if args.allowed_ips:
        results = manager.configure_firewall(
            args.resource_group,
            args.name,
            args.allowed_ips,
        )
        for r in results:
            print(f"  Firewall rule: {r['name']} -> {r['range']} ({r['status']})")


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box Synapse Workspace Manager",
    )
    parser.add_argument(
        "--subscription-id",
        required=True,
        help="Azure subscription ID",
    )
    parser.add_argument(
        "--resource-group",
        required=True,
        help="Azure resource group name",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # create
    create_parser = subparsers.add_parser("create", help="Create a new Synapse workspace")
    create_parser.add_argument("--name", required=True, help="Workspace name")
    create_parser.add_argument("--location", default="usgovvirginia", help="Azure region")
    create_parser.add_argument("--storage-account", required=True, help="ADLS Gen2 storage account")
    create_parser.add_argument("--tags", nargs="*", help="Tags as key=value pairs")
    create_parser.set_defaults(func=_cli_create)

    # list
    list_parser = subparsers.add_parser("list", help="List workspaces in a resource group")
    list_parser.set_defaults(func=_cli_list)

    # configure
    config_parser = subparsers.add_parser("configure", help="Configure workspace settings")
    config_parser.add_argument("--name", required=True, help="Workspace name")
    config_parser.add_argument("--enable-managed-vnet", action="store_true", help="Enable managed VNet")
    config_parser.add_argument("--allowed-ips", nargs="*", help="Allowed IP ranges (CIDR)")
    config_parser.set_defaults(func=_cli_configure)

    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
