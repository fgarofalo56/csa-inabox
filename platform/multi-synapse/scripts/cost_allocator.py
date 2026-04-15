"""Cost allocation and chargeback for multi-org Synapse deployments.

Queries Azure Cost Management for Synapse workspace costs, groups them
by organization tags, and generates allocation reports suitable for
inter-agency chargeback.

Usage::

    # Generate a cost report for the last 30 days
    python cost_allocator.py report \\
        --subscription-id <sub-id> \\
        --tag-name org \\
        --start-date 2024-03-01 \\
        --end-date 2024-03-31

    # Allocate shared costs to organizations
    python cost_allocator.py allocate \\
        --subscription-id <sub-id> \\
        --tag-name org \\
        --shared-cost-strategy proportional
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class CostEntry:
    """A single cost entry from Azure Cost Management."""

    resource_name: str
    resource_group: str
    meter_category: str
    meter_subcategory: str
    cost: float
    currency: str = "USD"
    usage_quantity: float = 0.0
    date: str = ""
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class OrgCostSummary:
    """Aggregated cost summary for a single organization."""

    org_name: str
    total_cost: float = 0.0
    compute_cost: float = 0.0
    storage_cost: float = 0.0
    network_cost: float = 0.0
    other_cost: float = 0.0
    shared_cost_allocation: float = 0.0
    resource_count: int = 0
    currency: str = "USD"


@dataclass
class AllocationReport:
    """Complete cost allocation report."""

    start_date: str
    end_date: str
    total_cost: float
    shared_cost: float
    org_summaries: list[OrgCostSummary] = field(default_factory=list)
    allocation_strategy: str = "proportional"
    generated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# Cost Allocator
# ---------------------------------------------------------------------------


class CostAllocator:
    """Query and allocate Azure costs across organizations.

    Args:
        subscription_id: Azure subscription ID.
        credential: Azure credential object.
    """

    def __init__(
        self,
        subscription_id: str,
        credential: Any | None = None,
    ) -> None:
        self.subscription_id = subscription_id
        self._credential = credential
        self._client: Any = None

    def _get_client(self) -> Any:
        """Lazily initialize the Cost Management client."""
        if self._client is not None:
            return self._client

        from azure.mgmt.costmanagement import CostManagementClient

        if self._credential is None:
            from azure.identity import DefaultAzureCredential
            self._credential = DefaultAzureCredential()

        self._client = CostManagementClient(
            credential=self._credential,
        )
        return self._client

    def get_costs_by_tag(
        self,
        tag_name: str,
        start_date: date,
        end_date: date,
        resource_group: str | None = None,
    ) -> list[CostEntry]:
        """Query costs grouped by a specific tag.

        Args:
            tag_name: Tag key to group costs by (e.g., 'org').
            start_date: Start of the cost period.
            end_date: End of the cost period.
            resource_group: Optional resource group filter.

        Returns:
            List of cost entries from the API.
        """
        from azure.mgmt.costmanagement.models import (
            QueryAggregation,
            QueryDataset,
            QueryDefinition,
            QueryFilter,
            QueryGrouping,
            QueryTimePeriod,
        )

        client = self._get_client()

        scope = f"/subscriptions/{self.subscription_id}"
        if resource_group:
            scope = f"{scope}/resourceGroups/{resource_group}"

        dataset = QueryDataset(
            granularity="Daily",
            aggregation={
                "totalCost": QueryAggregation(
                    name="Cost",
                    function="Sum",
                ),
                "usageQuantity": QueryAggregation(
                    name="UsageQuantity",
                    function="Sum",
                ),
            },
            grouping=[
                QueryGrouping(
                    type="Dimension",
                    name="ResourceGroupName",
                ),
                QueryGrouping(
                    type="Dimension",
                    name="MeterCategory",
                ),
                QueryGrouping(
                    type="Tag",
                    name=tag_name,
                ),
            ],
            filter=QueryFilter(
                dimensions={
                    "name": "MeterCategory",
                    "operator": "In",
                    "values": [
                        "Azure Synapse Analytics",
                        "Storage",
                        "Virtual Network",
                        "Bandwidth",
                    ],
                },
            ) if False else None,  # Filter optionally
        )

        query_def = QueryDefinition(
            type="ActualCost",
            timeframe="Custom",
            time_period=QueryTimePeriod(
                from_property=start_date,
                to=end_date,
            ),
            dataset=dataset,
        )

        logger.info(
            "Querying costs from %s to %s (tag: %s)",
            start_date,
            end_date,
            tag_name,
        )

        result = client.query.usage(scope=scope, parameters=query_def)

        entries: list[CostEntry] = []
        columns = [col.name for col in (result.columns or [])]

        for row in (result.rows or []):
            row_dict = dict(zip(columns, row, strict=True))
            entries.append(CostEntry(
                resource_name=row_dict.get("ResourceGroupName", ""),
                resource_group=row_dict.get("ResourceGroupName", ""),
                meter_category=row_dict.get("MeterCategory", ""),
                meter_subcategory="",
                cost=float(row_dict.get("Cost", 0.0)),
                usage_quantity=float(row_dict.get("UsageQuantity", 0.0)),
                date=str(row_dict.get("UsageDate", "")),
                tags={tag_name: row_dict.get(f"Tag_{tag_name}", row_dict.get(tag_name, "untagged"))},
            ))

        logger.info("Retrieved %d cost entries", len(entries))
        return entries

    def allocate_to_orgs(
        self,
        entries: list[CostEntry],
        tag_name: str,
        shared_cost_strategy: str = "proportional",
    ) -> AllocationReport:
        """Allocate costs to organizations based on tag grouping.

        Shared costs (resources without the org tag) are distributed
        according to the specified strategy.

        Args:
            entries: Raw cost entries.
            tag_name: Tag key used for grouping.
            shared_cost_strategy: How to distribute untagged costs
                ('proportional', 'equal', or 'none').

        Returns:
            Complete allocation report.
        """
        org_costs: dict[str, OrgCostSummary] = {}
        shared_cost = 0.0
        total_cost = 0.0

        for entry in entries:
            total_cost += entry.cost
            org_value = entry.tags.get(tag_name, "untagged")

            if not org_value or org_value == "untagged":
                shared_cost += entry.cost
                continue

            if org_value not in org_costs:
                org_costs[org_value] = OrgCostSummary(
                    org_name=org_value,
                    currency=entry.currency,
                )

            summary = org_costs[org_value]
            summary.total_cost += entry.cost
            summary.resource_count += 1

            category = entry.meter_category.lower()
            if "compute" in category or "synapse" in category:
                summary.compute_cost += entry.cost
            elif "storage" in category:
                summary.storage_cost += entry.cost
            elif "network" in category or "bandwidth" in category:
                summary.network_cost += entry.cost
            else:
                summary.other_cost += entry.cost

        # Distribute shared costs
        if shared_cost > 0 and org_costs:
            if shared_cost_strategy == "proportional":
                direct_total = sum(s.total_cost for s in org_costs.values())
                if direct_total > 0:
                    for summary in org_costs.values():
                        ratio = summary.total_cost / direct_total
                        summary.shared_cost_allocation = shared_cost * ratio
                        summary.total_cost += summary.shared_cost_allocation

            elif shared_cost_strategy == "equal":
                per_org = shared_cost / len(org_costs)
                for summary in org_costs.values():
                    summary.shared_cost_allocation = per_org
                    summary.total_cost += per_org

            # "none" strategy: shared costs are not allocated

        dates = [e.date for e in entries if e.date]
        start = min(dates) if dates else ""
        end = max(dates) if dates else ""

        report = AllocationReport(
            start_date=start,
            end_date=end,
            total_cost=total_cost,
            shared_cost=shared_cost,
            org_summaries=sorted(org_costs.values(), key=lambda s: s.total_cost, reverse=True),
            allocation_strategy=shared_cost_strategy,
        )

        logger.info(
            "Allocation complete: total=$%.2f, shared=$%.2f, orgs=%d",
            total_cost,
            shared_cost,
            len(org_costs),
        )
        return report

    def generate_report(self, report: AllocationReport) -> str:
        """Generate a formatted text report from an allocation.

        Args:
            report: The allocation report.

        Returns:
            Formatted report string.
        """
        lines: list[str] = []
        lines.append("=" * 72)
        lines.append("CSA-in-a-Box Cost Allocation Report")
        lines.append(f"Period: {report.start_date} to {report.end_date}")
        lines.append(f"Generated: {report.generated_at}")
        lines.append(f"Strategy: {report.allocation_strategy}")
        lines.append("=" * 72)
        lines.append(f"Total Cost:  ${report.total_cost:>12,.2f}")
        lines.append(f"Shared Cost: ${report.shared_cost:>12,.2f}")
        lines.append("-" * 72)
        lines.append(
            f"{'Organization':<20s} {'Total':>12s} {'Compute':>12s} "
            f"{'Storage':>12s} {'Shared':>12s}"
        )
        lines.append("-" * 72)

        for summary in report.org_summaries:
            lines.append(
                f"{summary.org_name:<20s} "
                f"${summary.total_cost:>11,.2f} "
                f"${summary.compute_cost:>11,.2f} "
                f"${summary.storage_cost:>11,.2f} "
                f"${summary.shared_cost_allocation:>11,.2f}"
            )

        lines.append("=" * 72)
        return "\n".join(lines)

    def export_csv(
        self,
        report: AllocationReport,
        output_path: str | None = None,
    ) -> str:
        """Export the allocation report to CSV format.

        Args:
            report: The allocation report.
            output_path: Optional file path. If None, returns CSV string.

        Returns:
            CSV content as string.
        """
        output = io.StringIO()
        writer = csv.DictWriter(
            output,
            fieldnames=[
                "org_name",
                "total_cost",
                "compute_cost",
                "storage_cost",
                "network_cost",
                "other_cost",
                "shared_cost_allocation",
                "resource_count",
                "currency",
            ],
        )
        writer.writeheader()

        for summary in report.org_summaries:
            writer.writerow({
                "org_name": summary.org_name,
                "total_cost": f"{summary.total_cost:.2f}",
                "compute_cost": f"{summary.compute_cost:.2f}",
                "storage_cost": f"{summary.storage_cost:.2f}",
                "network_cost": f"{summary.network_cost:.2f}",
                "other_cost": f"{summary.other_cost:.2f}",
                "shared_cost_allocation": f"{summary.shared_cost_allocation:.2f}",
                "resource_count": summary.resource_count,
                "currency": summary.currency,
            })

        csv_content = output.getvalue()

        if output_path:
            with open(output_path, "w", newline="", encoding="utf-8") as f:
                f.write(csv_content)
            logger.info("CSV report written to %s", output_path)

        return csv_content


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli_report(args: argparse.Namespace) -> None:
    """Handle the 'report' subcommand."""
    start = date.fromisoformat(args.start_date)
    end = date.fromisoformat(args.end_date)

    allocator = CostAllocator(args.subscription_id)
    entries = allocator.get_costs_by_tag(args.tag_name, start, end)
    report = allocator.allocate_to_orgs(entries, args.tag_name, args.shared_cost_strategy)
    print(allocator.generate_report(report))

    if args.output_csv:
        allocator.export_csv(report, args.output_csv)


def _cli_allocate(args: argparse.Namespace) -> None:
    """Handle the 'allocate' subcommand."""
    start = date.fromisoformat(args.start_date)
    end = date.fromisoformat(args.end_date)

    allocator = CostAllocator(args.subscription_id)
    entries = allocator.get_costs_by_tag(args.tag_name, start, end)
    report = allocator.allocate_to_orgs(entries, args.tag_name, args.shared_cost_strategy)
    print(json.dumps({
        "total_cost": report.total_cost,
        "shared_cost": report.shared_cost,
        "strategy": report.allocation_strategy,
        "orgs": [
            {
                "name": s.org_name,
                "total": s.total_cost,
                "shared_allocation": s.shared_cost_allocation,
            }
            for s in report.org_summaries
        ],
    }, indent=2))


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box Cost Allocator for Multi-Synapse Deployments",
    )
    parser.add_argument("--subscription-id", required=True, help="Azure subscription ID")
    parser.add_argument("--tag-name", default="org", help="Tag key for org grouping (default: org)")
    parser.add_argument("--start-date", required=True, help="Period start (YYYY-MM-DD)")
    parser.add_argument("--end-date", required=True, help="Period end (YYYY-MM-DD)")
    parser.add_argument(
        "--shared-cost-strategy",
        choices=["proportional", "equal", "none"],
        default="proportional",
        help="How to distribute shared costs",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # report
    report_parser = subparsers.add_parser("report", help="Generate a cost allocation report")
    report_parser.add_argument("--output-csv", help="Export report to CSV file")
    report_parser.set_defaults(func=_cli_report)

    # allocate
    allocate_parser = subparsers.add_parser("allocate", help="Allocate costs to organizations (JSON)")
    allocate_parser.set_defaults(func=_cli_allocate)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
