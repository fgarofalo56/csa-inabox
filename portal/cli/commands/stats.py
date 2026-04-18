"""CLI commands for platform statistics.

Commands
--------
stats overview    — platform-wide summary statistics
stats domains     — all domain overviews (sources, pipelines, products, quality)
stats domain      — detail for a single domain
"""

from __future__ import annotations

import sys

import click

from ..client import APIClient, APIError
from ..formatters import (
    domains_table,
    format_json,
    format_yaml,
    stats_table,
)


def _client(ctx: click.Context) -> APIClient:
    return APIClient(base_url=ctx.obj["api_url"], token=ctx.obj.get("token"))


@click.group()
def stats() -> None:
    """View platform and domain statistics."""


@stats.command("overview")
@click.pass_context
def overview(ctx: click.Context) -> None:
    """Show platform-wide aggregate statistics."""
    client = _client(ctx)
    try:
        result = client.platform_stats()
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        click.echo("CSA-in-a-Box Platform Overview")
        click.echo("=" * 40)
        click.echo(stats_table(result))


@stats.command("domains")
@click.pass_context
def domains(ctx: click.Context) -> None:
    """Show overview for every domain (sources, pipelines, products, quality)."""
    client = _client(ctx)
    try:
        results = client.all_domains()
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if not results:
        click.echo("No domains found.")
        return

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(results))
    elif fmt == "yaml":
        click.echo(format_yaml(results))
    else:
        click.echo(domains_table(results))


@stats.command("domain")
@click.argument("domain_name")
@click.pass_context
def domain(ctx: click.Context, domain_name: str) -> None:
    """Show detailed overview for DOMAIN_NAME."""
    client = _client(ctx)
    try:
        result = client.domain_overview(domain_name)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        fields = [
            ("Domain", result.get("name", "")),
            ("Status", result.get("status", "")),
            ("Sources", str(result.get("source_count", 0))),
            ("Pipelines", str(result.get("pipeline_count", 0))),
            ("Data Products", str(result.get("data_product_count", 0))),
            ("Avg Quality Score", f"{result.get('avg_quality_score', 0) * 100:.1f}%"),
        ]
        width = max(len(f[0]) for f in fields)
        click.echo(f"Domain Overview: {domain_name}")
        click.echo("=" * 40)
        for k, v in fields:
            click.echo(f"{k:<{width}}  {v}")
