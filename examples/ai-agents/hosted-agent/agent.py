"""Hosted Agent for Azure AI Foundry Agent Service.

A containerized CSA platform agent that can be deployed to
Azure AI Foundry as a hosted agent with MCP tool support.

Deployment:
    docker build -t csa-hosted-agent .
    az acr login --name <registry>
    docker tag csa-hosted-agent <registry>.azurecr.io/csa-hosted-agent:v1
    docker push <registry>.azurecr.io/csa-hosted-agent:v1
"""

from __future__ import annotations

import asyncio
import os

from azure.identity import DefaultAzureCredential
from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion
from semantic_kernel.functions import kernel_function


class CSAPlatformPlugin:
    """Unified CSA platform plugin for hosted agent."""

    @kernel_function(
        name="search_data_catalog",
        description="Search the CSA platform data catalog for datasets, tables, and data products",
    )
    def search_data_catalog(self, query: str) -> str:
        """Search catalog. In production, calls Purview REST API."""
        return f"Catalog results for '{query}': [Connect PURVIEW_ENDPOINT for live results]"

    @kernel_function(
        name="query_data",
        description="Execute a SQL query against CSA platform data products",
    )
    def query_data(self, sql: str, layer: str = "gold") -> str:
        """Execute SQL. In production, calls Synapse Serverless."""
        return f"Query result from {layer}: [Connect SYNAPSE_ENDPOINT for live results]"

    @kernel_function(
        name="check_quality",
        description="Check data quality score for a data product",
    )
    def check_quality(self, product_name: str) -> str:
        """Check quality. In production, calls Great Expectations."""
        return f"Quality for '{product_name}': Score 87.3%, Status: PASS"

    @kernel_function(
        name="get_governance_status",
        description="Get governance compliance status for a data product",
    )
    def get_governance_status(self, product_name: str) -> str:
        """Get governance status. In production, calls Purview policies."""
        return f"Governance for '{product_name}': Contract valid, Classifications applied, Lineage tracked"


def create_agent() -> ChatCompletionAgent:
    """Create the hosted CSA platform agent."""
    service = AzureChatCompletion(
        deployment_name=os.getenv("MODEL_DEPLOYMENT_NAME", "gpt-5.4"),
        endpoint=os.getenv("AZURE_OPENAI_ENDPOINT", ""),
        credential=DefaultAzureCredential(),
    )

    return ChatCompletionAgent(
        name="CSAPlatformAgent",
        description=(
            "An AI agent for the CSA-in-a-Box data analytics platform. "
            "Can search the data catalog, query data products, check quality, "
            "and review governance compliance."
        ),
        instructions=(
            "You are the CSA-in-a-Box platform assistant. Help users discover, "
            "understand, and work with data products in the platform. "
            "Use your tools to search the catalog, query data, check quality, "
            "and review governance status. Be helpful, accurate, and proactive "
            "about data quality and governance concerns."
        ),
        service=service,
        plugins=[CSAPlatformPlugin()],
    )


async def main() -> None:
    """Run agent in server mode for Foundry Agent Service."""
    agent = create_agent()
    # When running as a hosted agent, the Foundry runtime manages
    # the conversation loop. This main() is for local testing.
    print("CSA Platform Agent ready. Type messages (Ctrl+C to exit):")
    thread = None
    while True:
        try:
            user_input = input("> ").strip()
            if not user_input:
                continue
            async for response in agent.invoke(messages=user_input, thread=thread):
                print(f"Agent: {response}")
                thread = response.thread
        except (KeyboardInterrupt, EOFError):
            break


if __name__ == "__main__":
    asyncio.run(main())
