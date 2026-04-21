"""CLI commands for data source management.

Commands
--------
sources list       — list registered sources (with optional filters)
sources get        — show details for a single source
sources register   — interactively register a new source from flags
sources decommission — soft-delete a source
sources provision  — trigger DLZ provisioning for a source
"""

from __future__ import annotations

import json
import sys

import click

from ..client import APIClient, APIError
from ..formatters import (
    format_json,
    format_yaml,
    source_detail,
    sources_table,
)


def _client(ctx: click.Context) -> APIClient:
    return APIClient(base_url=ctx.obj["api_url"], token=ctx.obj.get("token"))


def _output(ctx: click.Context, data, table_fn=None) -> None:
    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(data))
    elif fmt == "yaml":
        click.echo(format_yaml(data))
    else:
        click.echo(table_fn(data) if table_fn else format_json(data))


@click.group()
def sources() -> None:
    """Manage data sources."""


@sources.command("list")
@click.option("--domain", default=None, help="Filter by domain.")
@click.option("--status", default=None, help="Filter by lifecycle status (e.g. active, draft).")
@click.option("--type", "source_type", default=None, help="Filter by source type (e.g. azure_sql, event_hub).")
@click.option("--search", default=None, help="Full-text search in name and description.")
@click.option("--limit", default=50, show_default=True, help="Maximum results to return.")
@click.option("--offset", default=0, show_default=True, help="Offset for pagination.")
@click.pass_context
def list_sources(
    ctx: click.Context,
    domain: str | None,
    status: str | None,
    source_type: str | None,
    search: str | None,
    limit: int,
    offset: int,
) -> None:
    """List registered data sources."""
    client = _client(ctx)
    try:
        results = client.list_sources(
            domain=domain,
            status=status,
            source_type=source_type,
            search=search,
            limit=limit,
            offset=offset,
        )
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if not results:
        click.echo("No sources found.")
        return

    _output(ctx, results, table_fn=sources_table)


@sources.command("get")
@click.argument("source_id")
@click.pass_context
def get_source(ctx: click.Context, source_id: str) -> None:
    """Show details for SOURCE_ID."""
    client = _client(ctx)
    try:
        result = client.get_source(source_id)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        click.echo(source_detail(result))


@sources.command("register")
@click.option("--name", required=True, prompt=True, help="Human-readable name for this source.")
@click.option("--domain", required=True, prompt=True, help="Business domain (e.g. finance, hr).")
@click.option(
    "--type",
    "source_type",
    required=True,
    prompt=True,
    type=click.Choice(
        [
            "azure_sql", "synapse", "cosmos_db", "adls_gen2", "blob_storage",
            "databricks", "postgresql", "mysql", "oracle", "rest_api",
            "odata", "sftp", "sharepoint", "event_hub", "iot_hub", "kafka",
        ],
        case_sensitive=False,
    ),
    help="Source technology type.",
)
@click.option(
    "--classification",
    default="internal",
    show_default=True,
    type=click.Choice(["public", "internal", "confidential", "restricted", "cui", "fouo"], case_sensitive=False),
    help="Data classification level.",
)
@click.option("--description", default="", help="Optional description.")
@click.option("--connection-json", default=None, help="Connection config as a JSON string.")
@click.option("--ingestion-json", default=None, help="Ingestion config as a JSON string.")
@click.option("--owner-name", default=None, help="Owner full name.")
@click.option("--owner-email", default=None, help="Owner email address.")
@click.option("--owner-team", default=None, help="Owner team name.")
@click.pass_context
def register_source(
    ctx: click.Context,
    name: str,
    domain: str,
    source_type: str,
    classification: str,
    description: str,
    connection_json: str | None,
    ingestion_json: str | None,
    owner_name: str | None,
    owner_email: str | None,
    owner_team: str | None,
) -> None:
    """Register a new data source (created in draft status)."""
    connection: dict = {}
    if connection_json:
        try:
            connection = json.loads(connection_json)
        except json.JSONDecodeError as exc:
            click.echo(f"Error: --connection-json is not valid JSON: {exc}", err=True)
            sys.exit(1)

    ingestion: dict = {}
    if ingestion_json:
        try:
            ingestion = json.loads(ingestion_json)
        except json.JSONDecodeError as exc:
            click.echo(f"Error: --ingestion-json is not valid JSON: {exc}", err=True)
            sys.exit(1)

    owner: dict | None = None
    if owner_name or owner_email:
        owner = {
            k: v
            for k, v in {
                "name": owner_name,
                "email": owner_email,
                "team": owner_team,
            }.items()
            if v is not None
        }

    payload: dict = {
        "name": name,
        "domain": domain,
        "source_type": source_type,
        "classification": classification,
        "description": description,
        "connection": connection,
        "ingestion": ingestion,
    }
    if owner:
        payload["owner"] = owner

    client = _client(ctx)
    try:
        result = client.register_source(payload)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    click.echo(f"Source registered with ID: {result.get('id')}")
    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        click.echo(source_detail(result))


@sources.command("decommission")
@click.argument("source_id")
@click.option("--yes", is_flag=True, help="Skip confirmation prompt.")
@click.pass_context
def decommission_source(ctx: click.Context, source_id: str, yes: bool) -> None:
    """Decommission SOURCE_ID (soft-delete, sets status to decommissioned)."""
    if not yes:
        click.confirm(
            f"Decommission source '{source_id}'? This cannot be undone.",
            abort=True,
        )
    client = _client(ctx)
    try:
        result = client.decommission_source(source_id)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    click.echo(f"Source '{source_id}' decommissioned (status: {result.get('status')}).")


@sources.command("provision")
@click.argument("source_id")
@click.pass_context
def provision_source(ctx: click.Context, source_id: str) -> None:
    """Trigger Data Landing Zone provisioning for SOURCE_ID."""
    client = _client(ctx)
    try:
        result = client.provision_source(source_id)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        click.echo(f"Provisioning triggered for '{source_id}'.")
        click.echo(f"Status:  {result.get('status')}")
        click.echo(f"Message: {result.get('message')}")
