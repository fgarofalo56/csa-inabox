# -*- coding: utf-8 -*-
"""Multi-Agent Governance Review — 3 agents collaborating via GroupChatOrchestration.

Demonstrates Semantic Kernel multi-agent orchestration where:
- Data Analyst agent: examines the data product
- Quality Agent: runs quality checks and assesses scores
- Governance Agent: reviews compliance and makes recommendations

The agents collaborate in a round-robin group chat to produce a
comprehensive governance review of a data product.

Usage:
    python -m examples.ai-agents.multi-agent-governance.team

Prerequisites:
    - pip install semantic-kernel[azure] azure-identity
    - AZURE_OPENAI_ENDPOINT set
    - GPT-5.4 deployed
"""

from __future__ import annotations

import asyncio
import os

from azure.identity import DefaultAzureCredential
from semantic_kernel.agents import (
    ChatCompletionAgent,
    GroupChatOrchestration,
    RoundRobinGroupChatManager,
)
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion
from semantic_kernel.functions import kernel_function


# ─── Shared Plugins ──────────────────────────────────────────────

class CatalogPlugin:
    """Plugin for searching the data catalog."""

    @kernel_function(
        name="search_catalog",
        description="Search the data catalog for assets matching a query",
    )
    def search_catalog(self, query: str) -> str:
        return (
            f"Catalog search results for '{query}':\n"
            f"  1. gold.finance.revenue_summary (certified, domain: Finance)\n"
            f"     Classifications: [Financial Data, Confidential]\n"
            f"     Owner: Finance Data Team\n"
            f"  2. silver.finance.transactions (endorsed, domain: Finance)\n"
            f"     Classifications: [PII - Customer ID, Financial Data]\n"
            f"     Owner: Data Engineering"
        )

    @kernel_function(
        name="get_lineage",
        description="Get data lineage for an asset",
    )
    def get_lineage(self, asset_name: str) -> str:
        return (
            f"Lineage for '{asset_name}':\n"
            f"  Upstream: raw.finance.transactions_csv → bronze.finance.transactions\n"
            f"            → silver.finance.transactions_cleaned\n"
            f"            → gold.finance.revenue_summary\n"
            f"  Downstream: Power BI 'Finance Dashboard', API endpoint /api/v1/revenue"
        )


class QualityPlugin:
    """Plugin for quality assessment."""

    @kernel_function(
        name="run_quality_suite",
        description="Run a full quality assessment suite on a dataset",
    )
    def run_quality_suite(self, dataset: str) -> str:
        return (
            f"Quality Assessment for '{dataset}':\n"
            f"  Suite: Gold Layer Standard\n"
            f"  ─────────────────────────────────\n"
            f"  Completeness:  92.1% ✓ (threshold: 90%)\n"
            f"  Accuracy:      88.5% ✓ (threshold: 85%)\n"
            f"  Timeliness:    78.3% ✗ (threshold: 80%) — FAILING\n"
            f"    → Last refresh: 26 hours ago (SLA: 24 hours)\n"
            f"  Consistency:   91.0% ✓ (threshold: 85%)\n"
            f"  ─────────────────────────────────\n"
            f"  Overall Score: 87.5% (Gate: 80%) — PASS with warnings\n"
            f"  Action Required: Fix timeliness — pipeline schedule may need adjustment"
        )


class ContractPlugin:
    """Plugin for contract validation."""

    @kernel_function(
        name="validate_contract",
        description="Validate a data product's contract against CSA standards",
    )
    def validate_contract(self, product_name: str) -> str:
        return (
            f"Contract Validation for '{product_name}':\n"
            f"  Contract: contract.yaml (v2.1)\n"
            f"  ✓ Schema defined (14 fields)\n"
            f"  ✓ Owner specified (Finance Data Team)\n"
            f"  ✓ SLA defined (99.5% uptime, 24h freshness)\n"
            f"  ✗ Cost center missing (required for marketplace)\n"
            f"  ✓ Quality thresholds defined\n"
            f"  ✓ Classification labels applied\n"
            f"  Status: 5/6 checks passed — needs cost_center field"
        )


# ─── Agent Definitions ──────────────────────────────────────────

def create_agents() -> list[ChatCompletionAgent]:
    """Create the governance review agent team."""
    service = AzureChatCompletion(
        deployment_name="gpt-5.4",
        endpoint=os.getenv("AZURE_OPENAI_ENDPOINT", ""),
        credential=DefaultAzureCredential(),
    )

    analyst = ChatCompletionAgent(
        name="DataAnalyst",
        description="Examines data products, checks catalog entries, and traces lineage.",
        instructions=(
            "You are a data analyst reviewing a data product. "
            "Use the catalog to find the product, check its lineage, "
            "and report your findings to the team. Be factual and specific."
        ),
        service=service,
        plugins=[CatalogPlugin()],
    )

    quality_reviewer = ChatCompletionAgent(
        name="QualityReviewer",
        description="Runs quality assessments and evaluates data product trustworthiness.",
        instructions=(
            "You are a data quality specialist. Run the quality suite on the data product "
            "and provide a detailed assessment. Flag any failing metrics and suggest fixes. "
            "Be precise about scores and thresholds."
        ),
        service=service,
        plugins=[QualityPlugin()],
    )

    governance_officer = ChatCompletionAgent(
        name="GovernanceOfficer",
        description="Reviews compliance, contracts, and makes governance recommendations.",
        instructions=(
            "You are a data governance officer. Review the findings from the analyst "
            "and quality reviewer. Validate the data contract. Provide a final governance "
            "verdict: APPROVED, APPROVED WITH CONDITIONS, or REJECTED. "
            "Include specific remediation steps for any issues found."
        ),
        service=service,
        plugins=[ContractPlugin()],
    )

    return [analyst, quality_reviewer, governance_officer]


# ─── Response Callback ───────────────────────────────────────────

async def agent_response_callback(message: object) -> None:
    """Print agent responses as they come in."""
    agent_name = getattr(message, "name", "Agent")
    content = str(message)
    print(f"\n{'─' * 60}")
    print(f"  {agent_name}:")
    print(f"{'─' * 60}")
    print(content)


# ─── Main Orchestration ─────────────────────────────────────────

async def run_governance_review(product_name: str) -> None:
    """Run a multi-agent governance review of a data product."""
    print("╔══════════════════════════════════════════════════════════╗")
    print("║  CSA-in-a-Box: Multi-Agent Governance Review            ║")
    print(f"║  Product: {product_name:<44} ║")
    print("╠══════════════════════════════════════════════════════════╣")
    print("║  Agents:                                                ║")
    print("║    1. DataAnalyst — catalog search & lineage            ║")
    print("║    2. QualityReviewer — quality assessment               ║")
    print("║    3. GovernanceOfficer — compliance & verdict           ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print()

    agents = create_agents()

    # Create group chat with round-robin turns (5 rounds = each agent speaks ~2 times)
    orchestration = GroupChatOrchestration(
        members=agents,
        manager=RoundRobinGroupChatManager(max_rounds=5),
        agent_response_callback=agent_response_callback,
    )

    # The runtime manages agent execution
    from semantic_kernel.agents import InProcessRuntime

    runtime = InProcessRuntime()
    runtime.start()

    try:
        result = await orchestration.invoke(
            task=(
                f"Conduct a comprehensive governance review of the '{product_name}' "
                f"data product. The analyst should search the catalog and check lineage. "
                f"The quality reviewer should run the quality suite. "
                f"The governance officer should validate the contract and provide "
                f"a final verdict with any required remediation steps."
            ),
            runtime=runtime,
        )

        print("\n" + "=" * 60)
        print("  FINAL RESULT")
        print("=" * 60)
        print(str(result))
    finally:
        await runtime.stop()


async def main() -> None:
    """Entry point."""
    import sys

    product = sys.argv[1] if len(sys.argv) > 1 else "gold.finance.revenue_summary"
    await run_governance_review(product)


if __name__ == "__main__":
    asyncio.run(main())
