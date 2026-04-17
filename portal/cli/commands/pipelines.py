"""CLI commands for pipeline management.

Commands
--------
pipelines list     — list all pipelines with optional filters
pipelines get      — show details for a single pipeline
pipelines runs     — show recent execution runs for a pipeline
pipelines trigger  — manually trigger a pipeline run
"""

from __future__ import annotations

import sys

import click

from ..client import APIClient, APIError
from ..formatters import (
    format_json,
    format_yaml,
    pipeline_runs_table,
    pipelines_table,
)


def _client(ctx: click.Context) -> APIClient:
    return APIClient(base_url=ctx.obj["api_url"], token=ctx.obj.get("token"))


@click.group()
def pipelines() -> None:
    """Manage and trigger data pipelines."""


@pipelines.command("list")
@click.option("--source-id", default=None, help="Filter by linked source ID.")
@click.option("--status", default=None, help="Filter by status (e.g. running, succeeded, failed).")
@click.option("--limit", default=50, show_default=True, help="Maximum results to return.")
@click.pass_context
def list_pipelines(
    ctx: click.Context,
    source_id: str | None,
    status: str | None,
    limit: int,
) -> None:
    """List data pipelines."""
    client = _client(ctx)
    try:
        results = client.list_pipelines(source_id=source_id, status=status, limit=limit)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if not results:
        click.echo("No pipelines found.")
        return

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(results))
    elif fmt == "yaml":
        click.echo(format_yaml(results))
    else:
        click.echo(pipelines_table(results))


@pipelines.command("get")
@click.argument("pipeline_id")
@click.pass_context
def get_pipeline(ctx: click.Context, pipeline_id: str) -> None:
    """Show details for PIPELINE_ID."""
    client = _client(ctx)
    try:
        result = client.get_pipeline(pipeline_id)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        # Render as a key-value detail block.
        fields = [
            ("ID", result.get("id", "")),
            ("Name", result.get("name", "")),
            ("Type", result.get("pipeline_type", "")),
            ("Status", result.get("status", "")),
            ("Source ID", result.get("source_id", "")),
            ("Schedule", result.get("schedule_cron") or "-"),
            ("ADF Pipeline", result.get("adf_pipeline_id") or "-"),
            ("Created", (result.get("created_at") or "")[:16].replace("T", " ")),
            ("Last Run", (result.get("last_run_at") or "")[:16].replace("T", " ") or "-"),
        ]
        width = max(len(f[0]) for f in fields)
        for k, v in fields:
            click.echo(f"{k:<{width}}  {v}")


@pipelines.command("runs")
@click.argument("pipeline_id")
@click.option("--limit", default=20, show_default=True, help="Maximum run records to return.")
@click.pass_context
def pipeline_runs(ctx: click.Context, pipeline_id: str, limit: int) -> None:
    """Show recent execution runs for PIPELINE_ID."""
    client = _client(ctx)
    try:
        results = client.get_pipeline_runs(pipeline_id, limit=limit)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if not results:
        click.echo("No runs found for this pipeline.")
        return

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(results))
    elif fmt == "yaml":
        click.echo(format_yaml(results))
    else:
        click.echo(pipeline_runs_table(results))


@pipelines.command("trigger")
@click.argument("pipeline_id")
@click.option("--yes", is_flag=True, help="Skip confirmation prompt.")
@click.pass_context
def trigger_pipeline(ctx: click.Context, pipeline_id: str, yes: bool) -> None:
    """Manually trigger a run for PIPELINE_ID."""
    if not yes:
        click.confirm(f"Trigger pipeline '{pipeline_id}'?", abort=True)

    client = _client(ctx)
    try:
        result = client.trigger_pipeline(pipeline_id)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        click.echo(f"Pipeline run triggered.")
        click.echo(f"Run ID:  {result.get('id')}")
        click.echo(f"Status:  {result.get('status')}")
        started = (result.get("started_at") or "")[:19].replace("T", " ")
        click.echo(f"Started: {started}")
