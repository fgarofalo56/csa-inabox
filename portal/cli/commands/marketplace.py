"""CLI commands for the data marketplace.

Commands
--------
marketplace products   — list data products
marketplace get        — show details for a single product
marketplace search     — search products by keyword
marketplace quality    — show quality metric history for a product
marketplace domains    — list domains and product counts
marketplace stats      — marketplace aggregate statistics
"""

from __future__ import annotations

import sys

import click

from ..client import APIClient, APIError
from ..formatters import (
    domains_table,
    format_json,
    format_yaml,
    product_detail,
    products_table,
    quality_table,
    render,
    stats_table,
)


def _client(ctx: click.Context) -> APIClient:
    return APIClient(base_url=ctx.obj["api_url"], token=ctx.obj.get("token"))


@click.group()
def marketplace() -> None:
    """Discover and explore data products in the marketplace."""


@marketplace.command("products")
@click.option("--domain", default=None, help="Filter by business domain.")
@click.option("--min-quality", default=None, type=float, help="Minimum quality score (0-100).")
@click.option("--limit", default=50, show_default=True, help="Maximum results to return.")
@click.pass_context
def list_products(
    ctx: click.Context,
    domain: str | None,
    min_quality: float | None,
    limit: int,
) -> None:
    """List data products in the marketplace."""
    client = _client(ctx)
    try:
        results = client.list_products(domain=domain, min_quality=min_quality, limit=limit)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if not results:
        click.echo("No products found.")
        return

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(results))
    elif fmt == "yaml":
        click.echo(format_yaml(results))
    else:
        click.echo(products_table(results))


@marketplace.command("get")
@click.argument("product_id")
@click.pass_context
def get_product(ctx: click.Context, product_id: str) -> None:
    """Show details for PRODUCT_ID."""
    client = _client(ctx)
    try:
        result = client.get_product(product_id)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        click.echo(product_detail(result))


@marketplace.command("search")
@click.argument("query")
@click.option("--domain", default=None, help="Restrict search to a specific domain.")
@click.option("--min-quality", default=None, type=float, help="Minimum quality score.")
@click.option("--limit", default=20, show_default=True, help="Maximum results to return.")
@click.pass_context
def search_products(
    ctx: click.Context,
    query: str,
    domain: str | None,
    min_quality: float | None,
    limit: int,
) -> None:
    """Search marketplace products by keyword QUERY."""
    client = _client(ctx)
    try:
        results = client.list_products(
            search=query,
            domain=domain,
            min_quality=min_quality,
            limit=limit,
        )
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if not results:
        click.echo(f"No products match '{query}'.")
        return

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(results))
    elif fmt == "yaml":
        click.echo(format_yaml(results))
    else:
        click.echo(f"Found {len(results)} product(s) matching '{query}':")
        click.echo(products_table(results))


@marketplace.command("quality")
@click.argument("product_id")
@click.option("--days", default=30, show_default=True, help="Number of days of history to show.")
@click.pass_context
def product_quality(ctx: click.Context, product_id: str, days: int) -> None:
    """Show quality metric history for PRODUCT_ID."""
    client = _client(ctx)
    try:
        results = client.get_product_quality(product_id, days=days)
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if not results:
        click.echo("No quality data available.")
        return

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(results))
    elif fmt == "yaml":
        click.echo(format_yaml(results))
    else:
        click.echo(f"Quality history for '{product_id}' (last {days} days):")
        click.echo(quality_table(results))


@marketplace.command("domains")
@click.pass_context
def list_domains(ctx: click.Context) -> None:
    """List marketplace domains and their product counts."""
    client = _client(ctx)
    try:
        results = client.list_marketplace_domains()
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


@marketplace.command("stats")
@click.pass_context
def marketplace_stats(ctx: click.Context) -> None:
    """Show aggregate marketplace statistics."""
    client = _client(ctx)
    try:
        result = client.marketplace_stats()
    except APIError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    fmt = ctx.obj["format"]
    if fmt == "json":
        click.echo(format_json(result))
    elif fmt == "yaml":
        click.echo(format_yaml(result))
    else:
        # Reuse stats_table for a consistent look.
        fields = [
            ("Total Products", str(result.get("total_products", 0))),
            ("Total Domains", str(result.get("total_domains", 0))),
            ("Avg Quality Score", f"{result.get('avg_quality_score', 0):.1f}"),
        ]
        by_domain = result.get("products_by_domain") or {}
        if by_domain:
            fields.append(("", ""))  # blank separator
            fields.append(("Products by Domain", ""))
            for domain, count in by_domain.items():
                fields.append((f"  {domain}", str(count)))
        width = max(len(f[0]) for f in fields if f[0])
        for k, v in fields:
            if not k:
                click.echo()
            else:
                click.echo(f"{k:<{width}}  {v}")
