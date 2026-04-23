#!/usr/bin/env python3
"""
CSA-in-a-Box Data Marketplace CLI

A command-line tool for managing data products in the CSA marketplace.
Provides commands to register, list, validate contracts, and request access.

Usage:
    python marketplace-cli.py register --contract contract.yaml
    python marketplace-cli.py list [--domain finance] [--min-quality 0.8]
    python marketplace-cli.py get <product-id>
    python marketplace-cli.py quality <product-id>
    python marketplace-cli.py request-access <product-id> --justification "reason"
    python marketplace-cli.py validate --contract contract.yaml
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

import httpx
import yaml
from rich.console import Console
from rich.table import Table

# Add the project root to Python path for imports
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from csa_platform.data_marketplace.contract_validator import validate_contract  # noqa: E402

console = Console()


class MarketplaceAPI:
    """Client for the CSA marketplace API."""

    def __init__(self, base_url: str | None = None, timeout: float = 30.0):
        """Initialize the marketplace API client."""
        self.base_url = base_url or os.getenv('MARKETPLACE_API_URL', 'http://localhost:8000/api/v1/marketplace')
        self.timeout = timeout
        self.client = httpx.Client(timeout=timeout)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.client.close()

    def list_products(
        self,
        domain: str | None = None,
        search: str | None = None,
        min_quality: float | None = None,
        limit: int = 50,
        offset: int = 0
    ) -> list[dict[str, Any]]:
        """List data products from the marketplace."""
        params = {'limit': limit, 'offset': offset}
        if domain:
            params['domain'] = domain
        if search:
            params['search'] = search
        if min_quality is not None:
            params['min_quality'] = min_quality

        try:
            response = self.client.get(f"{self.base_url}/products", params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as e:
            console.print(f"[red]Error listing products: {e}[/red]")
            return []

    def get_product(self, product_id: str) -> dict[str, Any] | None:
        """Get a specific data product by ID."""
        try:
            response = self.client.get(f"{self.base_url}/products/{product_id}")
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                console.print(f"[red]Product '{product_id}' not found[/red]")
            elif e.response.status_code == 403:
                console.print(f"[red]Access denied for product '{product_id}'[/red]")
            else:
                console.print(f"[red]Error getting product: {e}[/red]")
            return None
        except httpx.HTTPError as e:
            console.print(f"[red]Error getting product: {e}[/red]")
            return None

    def get_quality_history(self, product_id: str, days: int = 30) -> list[dict[str, Any]]:
        """Get quality history for a data product."""
        try:
            response = self.client.get(f"{self.base_url}/products/{product_id}/quality", params={'days': days})
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                console.print(f"[red]Product '{product_id}' not found[/red]")
            elif e.response.status_code == 403:
                console.print(f"[red]Access denied for product '{product_id}'[/red]")
            else:
                console.print(f"[red]Error getting quality history: {e}[/red]")
            return []
        except httpx.HTTPError as e:
            console.print(f"[red]Error getting quality history: {e}[/red]")
            return []

    def register_product(self, contract_data: dict[str, Any]) -> bool:
        """Register a new data product."""
        try:
            response = self.client.post(f"{self.base_url}/products", json=contract_data)
            response.raise_for_status()
            console.print("[green]Product registered successfully![/green]")
            return True
        except httpx.HTTPStatusError as e:
            console.print(f"[red]Error registering product: {e.response.status_code} {e.response.text}[/red]")
            return False
        except httpx.HTTPError as e:
            console.print(f"[red]Error registering product: {e}[/red]")
            return False

    def request_access(self, product_id: str, justification: str, access_level: str = "read") -> bool:
        """Request access to a data product."""
        access_request = {
            "data_product_id": product_id,
            "justification": justification,
            "access_level": access_level
        }
        try:
            response = self.client.post(f"{self.base_url}/access-requests", json=access_request)
            response.raise_for_status()
            console.print("[green]Access request submitted successfully![/green]")
            return True
        except httpx.HTTPStatusError as e:
            console.print(f"[red]Error requesting access: {e.response.status_code} {e.response.text}[/red]")
            return False
        except httpx.HTTPError as e:
            console.print(f"[red]Error requesting access: {e}[/red]")
            return False


def format_products_table(products: list[dict[str, Any]]) -> None:
    """Format products in a rich table."""
    if not products:
        console.print("[yellow]No products found[/yellow]")
        return

    table = Table(title="Data Products")
    table.add_column("ID", style="cyan")
    table.add_column("Name", style="bold")
    table.add_column("Domain", style="green")
    table.add_column("Quality", justify="right")
    table.add_column("Classification", style="yellow")
    table.add_column("Owner", style="blue")
    table.add_column("Updated", style="dim")

    for product in products:
        quality_score = product.get('quality_score', 0.0)
        quality_color = "green" if quality_score >= 0.9 else "yellow" if quality_score >= 0.7 else "red"
        quality_str = f"[{quality_color}]{quality_score:.1%}[/{quality_color}]"

        owner = product.get('owner', {})
        owner_str = f"{owner.get('name', 'Unknown')} ({owner.get('team', 'Unknown Team')})"

        updated_at = product.get('updated_at', '')
        if updated_at:
            # Format datetime to just show date
            updated_str = updated_at.split('T')[0]
        else:
            updated_str = 'Unknown'

        table.add_row(
            product.get('id', ''),
            product.get('name', ''),
            product.get('domain', ''),
            quality_str,
            product.get('classification', 'internal'),
            owner_str,
            updated_str
        )

    console.print(table)


def format_product_details(product: dict[str, Any]) -> None:
    """Format detailed product information."""
    console.print(f"\n[bold cyan]Data Product: {product.get('name', 'Unknown')}[/bold cyan]")
    console.print(f"ID: {product.get('id', 'Unknown')}")
    console.print(f"Domain: [green]{product.get('domain', 'Unknown')}[/green]")
    console.print(f"Classification: [yellow]{product.get('classification', 'internal')}[/yellow]")
    console.print(f"Version: {product.get('version', '1.0.0')}")
    console.print(f"Status: {product.get('status', 'active')}")

    # Description
    description = product.get('description', '')
    if description:
        console.print(f"\n[bold]Description:[/bold]\n{description}")

    # Owner information
    owner = product.get('owner', {})
    if owner:
        console.print("\n[bold]Owner:[/bold]")
        console.print(f"  Name: {owner.get('name', 'Unknown')}")
        console.print(f"  Email: {owner.get('email', 'Unknown')}")
        console.print(f"  Team: {owner.get('team', 'Unknown')}")

    # Quality metrics
    quality_score = product.get('quality_score', 0.0)
    completeness = product.get('completeness', 0.0)
    availability = product.get('availability', 0.0)
    freshness_hours = product.get('freshness_hours', 0.0)

    console.print("\n[bold]Quality Metrics:[/bold]")
    console.print(f"  Quality Score: {quality_score:.1%}")
    console.print(f"  Completeness: {completeness:.1%}")
    console.print(f"  Availability: {availability:.1%}")
    console.print(f"  Freshness: {freshness_hours:.1f} hours")

    # SLA information
    sla = product.get('sla', {})
    if sla:
        console.print("\n[bold]Service Level Agreement:[/bold]")
        console.print(f"  Freshness SLA: {sla.get('freshness_minutes', 0)} minutes")
        console.print(f"  Availability SLA: {sla.get('availability_percent', 0.0):.1f}%")
        console.print(f"  Valid Row Ratio: {sla.get('valid_row_ratio', 0.0):.1%}")
        if sla.get('supported_until'):
            console.print(f"  Supported Until: {sla['supported_until']}")

    # Schema information
    schema_info = product.get('schema_info', {})
    if schema_info:
        console.print("\n[bold]Schema:[/bold]")
        console.print(f"  Format: {schema_info.get('format', 'unknown')}")
        console.print(f"  Location: {schema_info.get('location', 'unknown')}")

        columns = schema_info.get('columns', [])
        if columns:
            console.print(f"  Columns ({len(columns)}):")
            for col in columns[:5]:  # Show first 5 columns
                col_type = col.get('type', 'unknown')
                col_desc = col.get('description', '')
                nullable = " (nullable)" if col.get('nullable', True) else " (required)"
                desc_part = f" - {col_desc}" if col_desc else ""
                console.print(f"    • {col.get('name', 'unknown')}: {col_type}{nullable}{desc_part}")
            if len(columns) > 5:
                console.print(f"    ... and {len(columns) - 5} more columns")

        partition_by = schema_info.get('partition_by', [])
        if partition_by:
            console.print(f"  Partitioned by: {', '.join(partition_by)}")

    # Tags
    tags = product.get('tags', {})
    if tags:
        console.print("\n[bold]Tags:[/bold]")
        for key, value in tags.items():
            console.print(f"  {key}: {value}")

    # Sample queries
    sample_queries = product.get('sample_queries', [])
    if sample_queries:
        console.print("\n[bold]Sample Queries:[/bold]")
        for i, query in enumerate(sample_queries[:3], 1):  # Show first 3 queries
            console.print(f"  {i}. {query}")
        if len(sample_queries) > 3:
            console.print(f"     ... and {len(sample_queries) - 3} more queries")

    # Documentation URL
    doc_url = product.get('documentation_url')
    if doc_url:
        console.print(f"\n[bold]Documentation:[/bold] {doc_url}")

    # Lineage
    lineage = product.get('lineage', {})
    if lineage:
        upstream = lineage.get('upstream', [])
        downstream = lineage.get('downstream', [])
        transformations = lineage.get('transformations', [])

        if upstream or downstream or transformations:
            console.print("\n[bold]Lineage:[/bold]")
            if upstream:
                console.print(f"  Upstream: {', '.join(upstream)}")
            if downstream:
                console.print(f"  Downstream: {', '.join(downstream)}")
            if transformations:
                console.print("  Transformations:")
                for transform in transformations:
                    console.print(f"    • {transform}")


def format_quality_history(history: list[dict[str, Any]]) -> None:
    """Format quality history in a table."""
    if not history:
        console.print("[yellow]No quality history available[/yellow]")
        return

    table = Table(title="Quality History")
    table.add_column("Date", style="cyan")
    table.add_column("Quality Score", justify="right")
    table.add_column("Completeness", justify="right")
    table.add_column("Freshness (hrs)", justify="right")
    table.add_column("Row Count", justify="right")

    for entry in history:
        quality_score = entry.get('quality_score', 0.0)
        quality_color = "green" if quality_score >= 0.9 else "yellow" if quality_score >= 0.7 else "red"
        quality_str = f"[{quality_color}]{quality_score:.1%}[/{quality_color}]"

        completeness = entry.get('completeness', 0.0)
        comp_color = "green" if completeness >= 0.9 else "yellow" if completeness >= 0.7 else "red"
        comp_str = f"[{comp_color}]{completeness:.1%}[/{comp_color}]"

        table.add_row(
            str(entry.get('date', '')),
            quality_str,
            comp_str,
            f"{entry.get('freshness_hours', 0.0):.1f}",
            f"{entry.get('row_count', 0):,}"
        )

    console.print(table)


def load_contract(file_path: str) -> dict[str, Any] | None:
    """Load a contract YAML file."""
    try:
        with open(file_path, encoding='utf-8') as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        console.print(f"[red]Contract file not found: {file_path}[/red]")
        return None
    except yaml.YAMLError as e:
        console.print(f"[red]Invalid YAML in contract file: {e}[/red]")
        return None
    except Exception as e:
        console.print(f"[red]Error loading contract file: {e}[/red]")
        return None


def cmd_list(args) -> None:
    """Handle the list command."""
    with MarketplaceAPI() as api:
        products = api.list_products(
            domain=args.domain,
            search=args.search,
            min_quality=args.min_quality,
            limit=args.limit,
            offset=args.offset
        )
        format_products_table(products)


def cmd_get(args) -> None:
    """Handle the get command."""
    with MarketplaceAPI() as api:
        product = api.get_product(args.product_id)
        if product:
            format_product_details(product)


def cmd_quality(args) -> None:
    """Handle the quality command."""
    with MarketplaceAPI() as api:
        history = api.get_quality_history(args.product_id, days=args.days)
        format_quality_history(history)


def cmd_register(args) -> None:
    """Handle the register command."""
    # First validate the contract
    if args.validate_only:
        result = validate_contract(args.contract)
        if result.is_valid:
            console.print("[green]PASS: Contract is valid![/green]")
            if result.warnings:
                console.print("\n[yellow]Warnings:[/yellow]")
                for warning in result.warnings:
                    console.print(f"  * {warning}")
        else:
            console.print("[red]FAIL: Contract validation failed![/red]")
            console.print("\n[red]Errors:[/red]")
            for error in result.errors:
                console.print(f"  * {error}")
            if result.warnings:
                console.print("\n[yellow]Warnings:[/yellow]")
                for warning in result.warnings:
                    console.print(f"  * {warning}")
            sys.exit(1)
        return

    # Validate and register
    result = validate_contract(args.contract)
    if not result.is_valid:
        console.print("[red]FAIL: Contract validation failed![/red]")
        console.print("\n[red]Errors:[/red]")
        for error in result.errors:
            console.print(f"  * {error}")
        if result.warnings:
            console.print("\n[yellow]Warnings:[/yellow]")
            for warning in result.warnings:
                console.print(f"  * {warning}")
        sys.exit(1)

    console.print("[green]PASS: Contract is valid![/green]")
    if result.warnings:
        console.print("\n[yellow]Warnings:[/yellow]")
        for warning in result.warnings:
            console.print(f"  • {warning}")

    # Load and register the contract
    contract_data = load_contract(args.contract)
    if not contract_data:
        sys.exit(1)

    with MarketplaceAPI() as api:
        success = api.register_product(contract_data)
        if not success:
            sys.exit(1)


def cmd_validate(args) -> None:
    """Handle the validate command."""
    result = validate_contract(args.contract)

    if result.is_valid:
        console.print("[green]PASS: Contract is valid![/green]")
        if result.warnings:
            console.print("\n[yellow]Warnings:[/yellow]")
            for warning in result.warnings:
                console.print(f"  * {warning}")
    else:
        console.print("[red]FAIL: Contract validation failed![/red]")
        console.print("\n[red]Errors:[/red]")
        for error in result.errors:
            console.print(f"  * {error}")
        if result.warnings:
            console.print("\n[yellow]Warnings:[/yellow]")
            for warning in result.warnings:
                console.print(f"  * {warning}")
        sys.exit(1)


def cmd_request_access(args) -> None:
    """Handle the request-access command."""
    with MarketplaceAPI() as api:
        success = api.request_access(args.product_id, args.justification, args.access_level)
        if not success:
            sys.exit(1)


def main() -> None:
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box Data Marketplace CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s list --domain finance --min-quality 0.8
  %(prog)s get dp-001
  %(prog)s quality dp-001 --days 7
  %(prog)s validate --contract my-product.yaml
  %(prog)s register --contract my-product.yaml
  %(prog)s request-access dp-001 --justification "Need for quarterly reporting"
        """.strip()
    )

    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # List command
    list_parser = subparsers.add_parser('list', help='List data products')
    list_parser.add_argument('--domain', help='Filter by domain')
    list_parser.add_argument('--search', help='Search in name and description')
    list_parser.add_argument('--min-quality', type=float, help='Minimum quality score (0.0-1.0)')
    list_parser.add_argument('--limit', type=int, default=50, help='Maximum number of results (default: 50)')
    list_parser.add_argument('--offset', type=int, default=0, help='Offset for pagination (default: 0)')
    list_parser.set_defaults(func=cmd_list)

    # Get command
    get_parser = subparsers.add_parser('get', help='Get detailed product information')
    get_parser.add_argument('product_id', help='Product ID')
    get_parser.set_defaults(func=cmd_get)

    # Quality command
    quality_parser = subparsers.add_parser('quality', help='Show quality history for a product')
    quality_parser.add_argument('product_id', help='Product ID')
    quality_parser.add_argument('--days', type=int, default=30, help='Number of days of history (default: 30)')
    quality_parser.set_defaults(func=cmd_quality)

    # Register command
    register_parser = subparsers.add_parser('register', help='Register a new data product')
    register_parser.add_argument('--contract', required=True, help='Path to YAML contract file')
    register_parser.add_argument('--validate-only', action='store_true', help='Only validate, do not register')
    register_parser.set_defaults(func=cmd_register)

    # Validate command
    validate_parser = subparsers.add_parser('validate', help='Validate a contract file')
    validate_parser.add_argument('--contract', required=True, help='Path to YAML contract file')
    validate_parser.set_defaults(func=cmd_validate)

    # Request access command
    access_parser = subparsers.add_parser('request-access', help='Request access to a data product')
    access_parser.add_argument('product_id', help='Product ID')
    access_parser.add_argument('--justification', required=True, help='Justification for access request')
    access_parser.add_argument('--access-level', choices=['read', 'read_write', 'admin'], default='read',
                               help='Access level requested (default: read)')
    access_parser.set_defaults(func=cmd_request_access)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == '__main__':
    main()
