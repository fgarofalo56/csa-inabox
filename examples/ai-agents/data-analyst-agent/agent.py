# -*- coding: utf-8 -*-
"""Data Analyst Agent — Single agent with CSA platform plugins.

Demonstrates building an AI agent using Azure AI Foundry and Semantic Kernel
that can query data, check quality, and provide analytical insights.

Usage:
    python -m examples.ai-agents.data-analyst-agent.agent

Prerequisites:
    - pip install semantic-kernel[azure] azure-identity
    - AZURE_OPENAI_ENDPOINT environment variable set
    - GPT-5.4 model deployed in Azure OpenAI
"""

from __future__ import annotations

import asyncio
import os

from azure.identity import DefaultAzureCredential
from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion
from semantic_kernel.functions import kernel_function


# ─── Plugins ─────────────────────────────────────────────────────

class DataQueryPlugin:
    """Plugin for querying data in the CSA platform."""

    @kernel_function(
        name="query_sql",
        description="Execute a SQL query against the Gold layer and return results",
    )
    def query_sql(self, query: str, database: str = "gold") -> str:
        """Execute SQL query (demo mode — returns sample data)."""
        # In production, connect to Synapse Serverless SQL
        return (
            f"Query executed against {database} layer:\n"
            f"  SQL: {query}\n"
            f"  Results: [Demo mode — connect SYNAPSE_SERVERLESS_ENDPOINT for live data]\n"
            f"  Sample row: {{'revenue': 1250000, 'region': 'West', 'quarter': 'Q4-2025'}}"
        )

    @kernel_function(
        name="list_tables",
        description="List available tables in a database",
    )
    def list_tables(self, database: str = "gold") -> str:
        """List tables in the specified database."""
        tables = {
            "gold": [
                "gold.finance.revenue_summary",
                "gold.finance.cost_analysis",
                "gold.healthcare.patient_outcomes",
                "gold.environmental.air_quality_index",
                "gold.transportation.crash_statistics",
                "gold.agriculture.crop_yields",
            ],
            "silver": [
                "silver.finance.transactions_cleaned",
                "silver.healthcare.claims_validated",
                "silver.environmental.epa_measurements",
            ],
        }
        table_list = tables.get(database, ["No tables found"])
        return f"Tables in {database}:\n" + "\n".join(f"  - {t}" for t in table_list)

    @kernel_function(
        name="describe_table",
        description="Get schema information for a table",
    )
    def describe_table(self, table: str) -> str:
        """Describe a table's schema."""
        return (
            f"Schema for {table}:\n"
            f"  - id (bigint, NOT NULL)\n"
            f"  - date (date, NOT NULL)\n"
            f"  - value (decimal(18,2))\n"
            f"  - category (varchar(100))\n"
            f"  - region (varchar(50))\n"
            f"  - _loaded_at (timestamp, auto)"
        )


class QualityPlugin:
    """Plugin for checking data quality."""

    @kernel_function(
        name="check_quality",
        description="Run quality checks on a dataset and return quality score",
    )
    def check_quality(self, dataset: str) -> str:
        """Check quality of a dataset."""
        return (
            f"Quality Report for '{dataset}':\n"
            f"  Overall Score: 87.3%\n"
            f"  Completeness: 92.1% (2 nullable columns with 8% nulls)\n"
            f"  Accuracy: 88.5% (validated against business rules)\n"
            f"  Timeliness: 85.2% (last updated: 2 hours ago)\n"
            f"  Consistency: 83.4% (3 cross-table checks passed, 1 warning)\n"
            f"  Status: PASS (above 80% gate)"
        )


# ─── Agent Setup ─────────────────────────────────────────────────

async def create_data_analyst() -> ChatCompletionAgent:
    """Create a Data Analyst agent with CSA platform plugins."""
    service = AzureChatCompletion(
        deployment_name="gpt-5.4",
        endpoint=os.getenv("AZURE_OPENAI_ENDPOINT", ""),
        credential=DefaultAzureCredential(),
    )

    agent = ChatCompletionAgent(
        name="DataAnalyst",
        description="An AI data analyst that queries and analyzes CSA platform data.",
        instructions=(
            "You are an expert data analyst working with the CSA-in-a-Box platform. "
            "You can query data products, check data quality, and provide analytical insights. "
            "Always start by listing available tables to understand what data is available. "
            "Check data quality before drawing conclusions. "
            "Provide clear, actionable insights with supporting data."
        ),
        service=service,
        plugins=[DataQueryPlugin(), QualityPlugin()],
    )
    return agent


# ─── Interactive Chat ────────────────────────────────────────────

async def main() -> None:
    """Run interactive chat with the Data Analyst agent."""
    print("╔══════════════════════════════════════════════════════╗")
    print("║  CSA-in-a-Box: Data Analyst Agent                   ║")
    print("║  Type 'quit' to exit                                ║")
    print("╚══════════════════════════════════════════════════════╝")
    print()

    agent = await create_data_analyst()
    thread = None

    while True:
        user_input = input("You: ").strip()
        if user_input.lower() in ("quit", "exit", "q"):
            break
        if not user_input:
            continue

        print("Agent: ", end="", flush=True)
        async for response in agent.invoke(
            messages=user_input,
            thread=thread,
        ):
            print(response)
            thread = response.thread

        print()


if __name__ == "__main__":
    asyncio.run(main())
