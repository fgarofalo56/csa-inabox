"""Databricks SQL Endpoint management for Direct Lake pattern.

Manages Databricks SQL warehouse endpoints that serve Delta tables
to Power BI Direct Lake semantic models. Handles creation,
configuration, permission management, and connection string generation.

Usage::

    python configure_sql_endpoint.py create \\
        --workspace-url https://adb-xxx.azuredatabricks.net \\
        --name csa-direct-lake \\
        --size SMALL \\
        --auto-stop-minutes 30

    python configure_sql_endpoint.py configure \\
        --workspace-url https://adb-xxx.azuredatabricks.net \\
        --endpoint-id <id> \\
        --enable-serverless \\
        --tags env=prod

    python configure_sql_endpoint.py status \\
        --workspace-url https://adb-xxx.azuredatabricks.net \\
        --endpoint-id <id>
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from typing import Any

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="sql-endpoint-config")
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class EndpointConfig:
    """Configuration for a Databricks SQL warehouse endpoint."""

    name: str
    cluster_size: str = "Small"
    min_num_clusters: int = 1
    max_num_clusters: int = 1
    auto_stop_mins: int = 30
    enable_serverless_compute: bool = True
    warehouse_type: str = "PRO"
    channel: str = "CHANNEL_NAME_CURRENT"
    spot_instance_policy: str = "COST_OPTIMIZED"
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class EndpointInfo:
    """Status information for a SQL warehouse endpoint."""

    id: str
    name: str
    state: str
    cluster_size: str
    num_clusters: int = 0
    num_active_sessions: int = 0
    auto_stop_mins: int = 0
    warehouse_type: str = ""
    jdbc_url: str = ""
    odbc_params: dict[str, str] = field(default_factory=dict)
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class PermissionGrant:
    """A permission grant on a SQL endpoint."""

    principal: str
    principal_type: str = "user"  # user, group, service_principal
    permission: str = "CAN_USE"  # CAN_USE, CAN_MANAGE, IS_OWNER


# ---------------------------------------------------------------------------
# SQL Endpoint Manager
# ---------------------------------------------------------------------------


class DatabricksSQLEndpointManager:
    """Manage Databricks SQL warehouse endpoints.

    Args:
        workspace_url: Databricks workspace URL.
        token: Databricks personal access token or Azure AD token.
    """

    def __init__(
        self,
        workspace_url: str = "",
        token: str = "",
    ) -> None:
        self.workspace_url = workspace_url.rstrip("/")
        self._token = token
        self._client: Any | None = None  # TODO: Replace with typed client when SDK stubs are available

    def _get_client(self) -> Any:
        """Lazily initialize the Databricks workspace client."""
        if self._client is not None:
            return self._client

        from databricks.sdk import WorkspaceClient

        self._client = WorkspaceClient(
            host=self.workspace_url,
            token=self._token if self._token else None,
        )
        return self._client

    def create_endpoint(self, config: EndpointConfig) -> EndpointInfo:
        """Create a new SQL warehouse endpoint.

        Args:
            config: Endpoint configuration.

        Returns:
            Endpoint info with ID and connection details.
        """
        client = self._get_client()

        from databricks.sdk.service.sql import (
            CreateWarehouseRequestWarehouseType,
            SpotInstancePolicy,
        )

        warehouse_type_map = {
            "PRO": CreateWarehouseRequestWarehouseType.PRO,
            "CLASSIC": CreateWarehouseRequestWarehouseType.CLASSIC,
        }

        spot_policy_map = {
            "COST_OPTIMIZED": SpotInstancePolicy.COST_OPTIMIZED,
            "RELIABILITY_OPTIMIZED": SpotInstancePolicy.RELIABILITY_OPTIMIZED,
        }

        logger.info("sql_warehouse.creating", name=config.name, size=config.cluster_size)

        response = client.warehouses.create_and_wait(
            name=config.name,
            cluster_size=config.cluster_size,
            min_num_clusters=config.min_num_clusters,
            max_num_clusters=config.max_num_clusters,
            auto_stop_mins=config.auto_stop_mins,
            enable_serverless_compute=config.enable_serverless_compute,
            warehouse_type=warehouse_type_map.get(config.warehouse_type),
            spot_instance_policy=spot_policy_map.get(config.spot_instance_policy),
            tags={"custom_tags": [{"key": k, "value": v} for k, v in config.tags.items()]} if config.tags else None,
        )

        info = self._build_info(response)
        logger.info("sql_warehouse.created", name=info.name, id=info.id)
        return info

    def configure_warehouse(
        self,
        endpoint_id: str,
        cluster_size: str | None = None,
        max_num_clusters: int | None = None,
        auto_stop_mins: int | None = None,
        enable_serverless: bool | None = None,
        tags: dict[str, str] | None = None,  # noqa: ARG002 (planned for tag update support)
    ) -> EndpointInfo:
        """Update configuration of an existing SQL warehouse.

        Args:
            endpoint_id: Warehouse endpoint ID.
            cluster_size: New cluster size (e.g., 'Small', 'Medium').
            max_num_clusters: Maximum number of clusters.
            auto_stop_mins: Auto-stop timeout in minutes.
            enable_serverless: Enable serverless compute.
            tags: Tags to set.

        Returns:
            Updated endpoint info.
        """
        client = self._get_client()

        # Get current config
        current = client.warehouses.get(endpoint_id)

        kwargs: dict[str, Any] = {"id": endpoint_id, "name": current.name}
        if cluster_size is not None:
            kwargs["cluster_size"] = cluster_size
        if max_num_clusters is not None:
            kwargs["max_num_clusters"] = max_num_clusters
        if auto_stop_mins is not None:
            kwargs["auto_stop_mins"] = auto_stop_mins
        if enable_serverless is not None:
            kwargs["enable_serverless_compute"] = enable_serverless

        client.warehouses.edit(**kwargs)

        # Re-fetch updated info
        updated = client.warehouses.get(endpoint_id)
        info = self._build_info(updated)
        logger.info("sql_warehouse.updated", name=info.name)
        return info

    def set_permissions(
        self,
        endpoint_id: str,
        grants: list[PermissionGrant],
    ) -> list[dict[str, Any]]:
        """Set access permissions on a SQL warehouse.

        Args:
            endpoint_id: Warehouse endpoint ID.
            grants: List of permission grants to apply.

        Returns:
            Results for each permission grant.
        """
        client = self._get_client()
        results: list[dict[str, Any]] = []

        from databricks.sdk.service.iam import PermissionLevel

        permission_map = {
            "CAN_USE": PermissionLevel.CAN_USE,
            "CAN_MANAGE": PermissionLevel.CAN_MANAGE,
            "IS_OWNER": PermissionLevel.IS_OWNER,
        }

        for grant in grants:
            try:
                acl_items = []
                if grant.principal_type == "user":
                    acl_items.append(
                        {
                            "user_name": grant.principal,
                            "permission_level": permission_map.get(
                                grant.permission,
                                PermissionLevel.CAN_USE,
                            ),
                        }
                    )
                elif grant.principal_type == "group":
                    acl_items.append(
                        {
                            "group_name": grant.principal,
                            "permission_level": permission_map.get(
                                grant.permission,
                                PermissionLevel.CAN_USE,
                            ),
                        }
                    )
                elif grant.principal_type == "service_principal":
                    acl_items.append(
                        {
                            "service_principal_name": grant.principal,
                            "permission_level": permission_map.get(
                                grant.permission,
                                PermissionLevel.CAN_USE,
                            ),
                        }
                    )

                client.permissions.update(
                    request_object_type="sql/warehouses",
                    request_object_id=endpoint_id,
                    access_control_list=acl_items,
                )

                results.append(
                    {
                        "principal": grant.principal,
                        "permission": grant.permission,
                        "status": "granted",
                    }
                )
                logger.info(
                    "Granted %s to %s on warehouse %s",
                    grant.permission,
                    grant.principal,
                    endpoint_id,
                )
            except Exception as exc:
                logger.exception(
                    "Permission grant failed for %s on warehouse %s",
                    grant.principal,
                    endpoint_id,
                )
                results.append(
                    {
                        "principal": grant.principal,
                        "permission": grant.permission,
                        "status": "error",
                        "error": str(exc),
                    }
                )

        return results

    def get_connection_string(
        self,
        endpoint_id: str,
        catalog: str = "hive_metastore",
        schema: str = "default",
    ) -> dict[str, str]:
        """Get connection details for a SQL warehouse.

        Returns JDBC/ODBC connection strings suitable for Power BI
        Direct Lake or other BI tool connections.

        Args:
            endpoint_id: Warehouse endpoint ID.
            catalog: Default catalog.
            schema: Default schema.

        Returns:
            Dictionary with connection strings and parameters.
        """
        client = self._get_client()
        warehouse = client.warehouses.get(endpoint_id)

        host = self.workspace_url.replace("https://", "")
        http_path = f"/sql/1.0/warehouses/{endpoint_id}"

        jdbc_url = (
            f"jdbc:databricks://{host}:443"
            f"/default;transportMode=http;ssl=1"
            f";httpPath={http_path}"
            f";ConnCatalog={catalog}"
            f";ConnSchema={schema}"
        )

        odbc_dsn = (
            f"Driver={{Simba Spark ODBC Driver}}"
            f";Host={host}"
            f";Port=443"
            f";HTTPPath={http_path}"
            f";SSL=1"
            f";ThriftTransport=2"
            f";AuthMech=11"
            f";Auth_Flow=0"
            f";Catalog={catalog}"
            f";Schema={schema}"
        )

        return {
            "host": host,
            "http_path": http_path,
            "port": "443",
            "jdbc_url": jdbc_url,
            "odbc_dsn": odbc_dsn,
            "catalog": catalog,
            "schema": schema,
            "warehouse_name": warehouse.name,
            "warehouse_id": endpoint_id,
        }

    def get_status(self, endpoint_id: str) -> EndpointInfo:
        """Get current status of a SQL warehouse.

        Args:
            endpoint_id: Warehouse endpoint ID.

        Returns:
            Endpoint info with current state.
        """
        client = self._get_client()
        warehouse = client.warehouses.get(endpoint_id)
        return self._build_info(warehouse)

    def _build_info(self, warehouse: Any) -> EndpointInfo:
        """Build EndpointInfo from SDK warehouse object."""
        return EndpointInfo(
            id=warehouse.id or "",
            name=warehouse.name or "",
            state=str(warehouse.state) if warehouse.state else "UNKNOWN",
            cluster_size=warehouse.cluster_size or "",
            num_clusters=warehouse.num_clusters or 0,
            num_active_sessions=warehouse.num_active_sessions or 0,
            auto_stop_mins=warehouse.auto_stop_mins or 0,
            warehouse_type=str(warehouse.warehouse_type) if warehouse.warehouse_type else "",
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli_create(args: argparse.Namespace) -> None:
    """Handle 'create' subcommand."""
    tags = {}
    if args.tags:
        for tag in args.tags:
            k, v = tag.split("=", 1)
            tags[k] = v

    config = EndpointConfig(
        name=args.name,
        cluster_size=args.size,
        auto_stop_mins=args.auto_stop_minutes,
        enable_serverless_compute=args.enable_serverless,
        tags=tags,
    )

    manager = DatabricksSQLEndpointManager(
        workspace_url=args.workspace_url,
        token=args.token or "",
    )
    info = manager.create_endpoint(config)
    print(
        json.dumps(
            {
                "id": info.id,
                "name": info.name,
                "state": info.state,
            },
            indent=2,
        )
    )


def _cli_configure(args: argparse.Namespace) -> None:
    """Handle 'configure' subcommand."""
    manager = DatabricksSQLEndpointManager(
        workspace_url=args.workspace_url,
        token=args.token or "",
    )
    info = manager.configure_warehouse(
        endpoint_id=args.endpoint_id,
        cluster_size=args.size,
        auto_stop_mins=args.auto_stop_minutes,
        enable_serverless=args.enable_serverless,
    )
    print(
        json.dumps(
            {
                "id": info.id,
                "name": info.name,
                "state": info.state,
            },
            indent=2,
        )
    )


def _cli_status(args: argparse.Namespace) -> None:
    """Handle 'status' subcommand."""
    manager = DatabricksSQLEndpointManager(
        workspace_url=args.workspace_url,
        token=args.token or "",
    )
    info = manager.get_status(args.endpoint_id)
    conn = manager.get_connection_string(args.endpoint_id)

    print(f"Warehouse: {info.name} ({info.id})")
    print(f"State:     {info.state}")
    print(f"Size:      {info.cluster_size}")
    print(f"Sessions:  {info.num_active_sessions}")
    print(f"\nJDBC URL:\n  {conn['jdbc_url']}")
    print(f"\nHTTP Path: {conn['http_path']}")


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box Databricks SQL Endpoint Manager",
    )
    parser.add_argument("--workspace-url", required=True, help="Databricks workspace URL")
    parser.add_argument("--token", default="", help="Databricks PAT (or use Azure AD)")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # create
    create_parser = subparsers.add_parser("create", help="Create SQL warehouse")
    create_parser.add_argument("--name", required=True, help="Warehouse name")
    create_parser.add_argument("--size", default="Small", help="Cluster size")
    create_parser.add_argument("--auto-stop-minutes", type=int, default=30)
    create_parser.add_argument("--enable-serverless", action="store_true")
    create_parser.add_argument("--tags", nargs="*", help="Tags as key=value")
    create_parser.set_defaults(func=_cli_create)

    # configure
    config_parser = subparsers.add_parser("configure", help="Configure warehouse")
    config_parser.add_argument("--endpoint-id", required=True)
    config_parser.add_argument("--size", default=None)
    config_parser.add_argument("--auto-stop-minutes", type=int, default=None)
    config_parser.add_argument("--enable-serverless", action="store_true", default=None)
    config_parser.set_defaults(func=_cli_configure)

    # status
    status_parser = subparsers.add_parser("status", help="Get warehouse status")
    status_parser.add_argument("--endpoint-id", required=True)
    status_parser.set_defaults(func=_cli_status)

    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
