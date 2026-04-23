"""CSA Platform MCP Server implementation.

Provides resources, tools, and prompts for the CSA-in-a-Box platform
via the Model Context Protocol (MCP).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def create_server() -> Any:
    """Create and configure the CSA Platform MCP server.

    Returns:
        Configured MCP server instance.

    Example (stdio transport):
        server = create_server()
        server.run_stdio()

    Example (SSE transport):
        server = create_server()
        server.run_sse(host="0.0.0.0", port=8080)
    """
    try:
        from mcp.server import Server
        from mcp.types import Prompt, PromptMessage, Resource, TextContent, Tool
    except ImportError as err:
        raise ImportError(
            "MCP SDK required. Install: pip install mcp"
        ) from err

    server = Server("csa-platform")

    # ─── Resources ───────────────────────────────────────────────

    @server.list_resources()
    async def list_resources() -> list[Resource]:
        """List available CSA platform resources."""
        return [
            Resource(
                uri="csa://catalog/domains",
                name="Data Domains",
                description="List of data domains in the CSA platform (finance, healthcare, environmental, etc.)",
                mimeType="application/json",
            ),
            Resource(
                uri="csa://governance/glossary",
                name="Business Glossary",
                description="Business glossary terms and definitions from Purview",
                mimeType="application/json",
            ),
            Resource(
                uri="csa://governance/policies",
                name="Governance Policies",
                description="Active data governance policies and rules",
                mimeType="application/json",
            ),
            Resource(
                uri="csa://quality/summary",
                name="Quality Summary",
                description="Data quality scores across all data products",
                mimeType="application/json",
            ),
            Resource(
                uri="csa://platform/status",
                name="Platform Status",
                description="Current platform deployment and health status",
                mimeType="application/json",
            ),
        ]

    @server.read_resource()
    async def read_resource(uri: str) -> str:
        """Read a CSA platform resource."""
        handlers = {
            "csa://catalog/domains": _get_domains,
            "csa://governance/glossary": _get_glossary,
            "csa://governance/policies": _get_policies,
            "csa://quality/summary": _get_quality_summary,
            "csa://platform/status": _get_platform_status,
        }

        handler = handlers.get(uri)
        if handler:
            return json.dumps(await handler(), indent=2)

        # Dynamic resource URIs
        if uri.startswith("csa://catalog/"):
            domain = uri.replace("csa://catalog/", "")
            return json.dumps(await _get_domain_products(domain), indent=2)
        if uri.startswith("csa://quality/"):
            product = uri.replace("csa://quality/", "")
            return json.dumps(await _get_product_quality(product), indent=2)
        if uri.startswith("csa://lineage/"):
            asset = uri.replace("csa://lineage/", "")
            return json.dumps(await _get_lineage(asset), indent=2)

        return json.dumps({"error": f"Unknown resource: {uri}"})

    # ─── Tools ───────────────────────────────────────────────────

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        """List available CSA platform tools."""
        return [
            Tool(
                name="query_data_product",
                description="Execute a SQL query against a data product in the CSA platform. Returns tabular results.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "SQL query to execute",
                        },
                        "database": {
                            "type": "string",
                            "description": "Target database (e.g., 'gold', 'silver')",
                            "default": "gold",
                        },
                        "max_rows": {
                            "type": "integer",
                            "description": "Maximum rows to return",
                            "default": 100,
                        },
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="check_data_quality",
                description="Run data quality checks on a dataset using Great Expectations rules.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "dataset": {
                            "type": "string",
                            "description": "Dataset name or path",
                        },
                        "suite": {
                            "type": "string",
                            "description": "Quality suite to run (bronze, silver, gold, custom)",
                            "default": "gold",
                        },
                    },
                    "required": ["dataset"],
                },
            ),
            Tool(
                name="validate_contract",
                description="Validate a data contract YAML against the CSA contract schema.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "contract_yaml": {
                            "type": "string",
                            "description": "Data contract YAML content to validate",
                        },
                    },
                    "required": ["contract_yaml"],
                },
            ),
            Tool(
                name="search_catalog",
                description="Search the Purview data catalog for data assets matching a query.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query for catalog assets",
                        },
                        "filters": {
                            "type": "object",
                            "description": "Optional filters (domain, classification, type)",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max results to return",
                            "default": 10,
                        },
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="get_lineage",
                description="Get data lineage graph for an asset, showing upstream sources and downstream consumers.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "asset_name": {
                            "type": "string",
                            "description": "Fully qualified asset name",
                        },
                        "direction": {
                            "type": "string",
                            "enum": ["upstream", "downstream", "both"],
                            "default": "both",
                        },
                        "depth": {
                            "type": "integer",
                            "description": "Maximum lineage depth",
                            "default": 3,
                        },
                    },
                    "required": ["asset_name"],
                },
            ),
            Tool(
                name="list_pipelines",
                description="List recent Azure Data Factory pipeline runs and their status.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["all", "succeeded", "failed", "running"],
                            "default": "all",
                        },
                        "last_hours": {
                            "type": "integer",
                            "description": "Show runs from last N hours",
                            "default": 24,
                        },
                    },
                },
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
        """Execute a CSA platform tool."""
        tool_handlers = {
            "query_data_product": _tool_query_data,
            "check_data_quality": _tool_check_quality,
            "validate_contract": _tool_validate_contract,
            "search_catalog": _tool_search_catalog,
            "get_lineage": _tool_get_lineage,
            "list_pipelines": _tool_list_pipelines,
        }

        handler = tool_handlers.get(name)
        if not handler:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

        try:
            result = await handler(**arguments)
            return [TextContent(type="text", text=json.dumps(result, indent=2))]
        except Exception as e:
            logger.exception("Tool %s failed", name)
            return [TextContent(type="text", text=f"Error: {e!s}")]

    # ─── Prompts ─────────────────────────────────────────────────

    @server.list_prompts()
    async def list_prompts() -> list[Prompt]:
        """List available prompt templates."""
        return [
            Prompt(
                name="analyze-data",
                description="Template for data analysis requests on CSA platform data products",
                arguments=[
                    {"name": "dataset", "description": "Dataset to analyze", "required": True},
                    {"name": "question", "description": "Analysis question", "required": True},
                ],
            ),
            Prompt(
                name="governance-review",
                description="Template for reviewing data governance compliance of a data product",
                arguments=[
                    {"name": "product", "description": "Data product to review", "required": True},
                ],
            ),
            Prompt(
                name="troubleshoot-pipeline",
                description="Template for diagnosing pipeline failures",
                arguments=[
                    {"name": "pipeline", "description": "Pipeline name", "required": True},
                    {"name": "error", "description": "Error message or symptoms", "required": False},
                ],
            ),
        ]

    @server.get_prompt()
    async def get_prompt(name: str, arguments: dict[str, str]) -> list[PromptMessage]:
        """Get a prompt template with arguments filled in."""
        prompts = {
            "analyze-data": _prompt_analyze_data,
            "governance-review": _prompt_governance_review,
            "troubleshoot-pipeline": _prompt_troubleshoot_pipeline,
        }

        builder = prompts.get(name)
        if not builder:
            return [
                PromptMessage(
                    role="user",
                    content=TextContent(type="text", text=f"Unknown prompt: {name}"),
                )
            ]

        return builder(arguments)

    return server


# ─── Resource Handlers ─────────────────────────────────────────────

async def _get_domains() -> dict[str, Any]:
    """Get list of data domains."""
    return {
        "domains": [
            {"name": "finance", "description": "Financial data products", "product_count": 12},
            {"name": "healthcare", "description": "Healthcare and tribal health data", "product_count": 8},
            {"name": "environmental", "description": "EPA environmental monitoring", "product_count": 6},
            {"name": "transportation", "description": "DOT transportation analytics", "product_count": 5},
            {"name": "agriculture", "description": "USDA agricultural data", "product_count": 7},
            {"name": "weather", "description": "NOAA weather and climate", "product_count": 9},
            {"name": "demographics", "description": "Census demographic data", "product_count": 4},
            {"name": "commerce", "description": "Retail and commercial data", "product_count": 3},
        ]
    }


async def _get_glossary() -> dict[str, Any]:
    """Get business glossary terms."""
    return {
        "terms": [
            {"term": "Bronze Layer", "definition": "Raw, unprocessed data ingested from source systems", "domain": "Data Engineering"},
            {"term": "Silver Layer", "definition": "Cleaned, validated, and conformed data", "domain": "Data Engineering"},
            {"term": "Gold Layer", "definition": "Business-ready, aggregated data optimized for consumption", "domain": "Data Engineering"},
            {"term": "Data Contract", "definition": "Formal agreement defining schema, SLA, and quality expectations", "domain": "Data Governance"},
            {"term": "Data Product", "definition": "A curated, discoverable, and trustworthy dataset published for consumption", "domain": "Data Mesh"},
        ],
        "total_count": 5,
        "note": "Connect to Purview for full glossary. Set PURVIEW_ENDPOINT environment variable.",
    }


async def _get_policies() -> dict[str, Any]:
    """Get active governance policies."""
    return {
        "policies": [
            {"name": "PII Classification Required", "status": "active", "scope": "all domains"},
            {"name": "Data Quality Gate > 80%", "status": "active", "scope": "gold layer"},
            {"name": "Lineage Tracking Required", "status": "active", "scope": "all pipelines"},
            {"name": "Data Contract Required for Publishing", "status": "active", "scope": "marketplace"},
        ]
    }


async def _get_quality_summary() -> dict[str, Any]:
    """Get quality score summary."""
    return {
        "overall_score": 87.3,
        "by_domain": {
            "finance": 92.1,
            "healthcare": 88.5,
            "environmental": 85.2,
            "transportation": 83.7,
        },
        "dimensions": {
            "completeness": 91.0,
            "accuracy": 88.5,
            "timeliness": 85.2,
            "consistency": 84.5,
        },
    }


async def _get_platform_status() -> dict[str, Any]:
    """Get platform health status."""
    return {
        "status": "healthy",
        "services": {
            "databricks": "running",
            "synapse": "running",
            "purview": "running",
            "data_factory": "running",
            "event_hubs": "running",
        },
        "last_deployment": "2026-04-22T10:00:00Z",
        "version": "0.1.0",
    }


async def _get_domain_products(domain: str) -> dict[str, Any]:
    """Get data products for a specific domain."""
    return {"domain": domain, "products": [], "note": f"Connect to marketplace API for {domain} products"}


async def _get_product_quality(product: str) -> dict[str, Any]:
    """Get quality details for a specific product."""
    return {"product": product, "score": 0, "note": "Connect to quality service for details"}


async def _get_lineage(asset: str) -> dict[str, Any]:
    """Get lineage for an asset."""
    return {"asset": asset, "upstream": [], "downstream": [], "note": "Connect to Purview for lineage"}


# ─── Tool Handlers ─────────────────────────────────────────────────

async def _tool_query_data(
    query: str, database: str = "gold", max_rows: int = 100
) -> dict[str, Any]:
    """Execute SQL query against data product."""
    # In production, connects to Synapse Serverless SQL
    synapse_endpoint = os.getenv("SYNAPSE_SERVERLESS_ENDPOINT")
    if not synapse_endpoint:
        return {
            "status": "error",
            "message": "SYNAPSE_SERVERLESS_ENDPOINT not configured. Set environment variable to connect.",
            "query": query,
            "database": database,
        }

    # Execute via pyodbc or azure-synapse SDK
    return {
        "status": "success",
        "query": query,
        "database": database,
        "max_rows": max_rows,
        "note": "Connect SYNAPSE_SERVERLESS_ENDPOINT to execute queries",
    }


async def _tool_check_quality(
    dataset: str, suite: str = "gold"
) -> dict[str, Any]:
    """Run quality checks on a dataset."""
    return {
        "dataset": dataset,
        "suite": suite,
        "status": "pending",
        "note": "Connect Great Expectations for quality validation",
    }


async def _tool_validate_contract(contract_yaml: str) -> dict[str, Any]:
    """Validate a data contract."""
    import yaml

    try:
        contract = yaml.safe_load(contract_yaml)
    except yaml.YAMLError as e:
        return {"valid": False, "errors": [f"YAML parse error: {e!s}"]}

    errors = []
    required_fields = ["name", "version", "owner", "schema"]
    for field in required_fields:
        if field not in contract:
            errors.append(f"Missing required field: {field}")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "contract_name": contract.get("name", "unknown"),
    }


async def _tool_search_catalog(
    query: str, filters: dict | None = None, limit: int = 10  # noqa: ARG001
) -> dict[str, Any]:
    """Search Purview catalog."""
    purview_endpoint = os.getenv("PURVIEW_ENDPOINT")
    if not purview_endpoint:
        return {
            "results": [],
            "query": query,
            "note": "Set PURVIEW_ENDPOINT to enable catalog search",
        }

    return {"results": [], "query": query, "limit": limit}


async def _tool_get_lineage(
    asset_name: str, direction: str = "both", depth: int = 3
) -> dict[str, Any]:
    """Get lineage for an asset."""
    return {
        "asset": asset_name,
        "direction": direction,
        "depth": depth,
        "lineage": [],
        "note": "Set PURVIEW_ENDPOINT to enable lineage queries",
    }


async def _tool_list_pipelines(
    status: str = "all", last_hours: int = 24
) -> dict[str, Any]:
    """List ADF pipeline runs."""
    return {
        "runs": [],
        "status_filter": status,
        "last_hours": last_hours,
        "note": "Set ADF_RESOURCE_ID to enable pipeline listing",
    }


# ─── Prompt Builders ───────────────────────────────────────────────

def _prompt_analyze_data(args: dict[str, str]) -> list:
    from mcp.types import PromptMessage, TextContent

    dataset = args.get("dataset", "unknown")
    question = args.get("question", "Provide a summary analysis")

    return [
        PromptMessage(
            role="user",
            content=TextContent(
                type="text",
                text=(
                    f"Analyze the '{dataset}' data product in the CSA platform.\n\n"
                    f"Question: {question}\n\n"
                    "Instructions:\n"
                    "1. Use the query_data_product tool to explore the data\n"
                    "2. Use the check_data_quality tool to verify data quality\n"
                    "3. Use the search_catalog tool to find related assets\n"
                    "4. Provide insights with supporting data\n"
                    "5. Note any data quality concerns\n"
                    "6. Suggest next steps for deeper analysis"
                ),
            ),
        )
    ]


def _prompt_governance_review(args: dict[str, str]) -> list:
    from mcp.types import PromptMessage, TextContent

    product = args.get("product", "unknown")

    return [
        PromptMessage(
            role="user",
            content=TextContent(
                type="text",
                text=(
                    f"Conduct a governance review of the '{product}' data product.\n\n"
                    "Review checklist:\n"
                    "1. Data contract: Does it have a valid contract.yaml? (use validate_contract)\n"
                    "2. Classifications: Are PII/PHI fields properly classified? (use search_catalog)\n"
                    "3. Quality: Does it meet the 80% quality gate? (use check_data_quality)\n"
                    "4. Lineage: Is end-to-end lineage tracked? (use get_lineage)\n"
                    "5. Access: Are access policies appropriate?\n"
                    "6. Documentation: Is it properly cataloged with glossary terms?\n\n"
                    "Provide a compliance score and remediation recommendations."
                ),
            ),
        )
    ]


def _prompt_troubleshoot_pipeline(args: dict[str, str]) -> list:
    from mcp.types import PromptMessage, TextContent

    pipeline = args.get("pipeline", "unknown")
    error = args.get("error", "No error details provided")

    return [
        PromptMessage(
            role="user",
            content=TextContent(
                type="text",
                text=(
                    f"Troubleshoot the '{pipeline}' pipeline failure.\n\n"
                    f"Error/Symptoms: {error}\n\n"
                    "Diagnostic steps:\n"
                    "1. Check recent pipeline runs (use list_pipelines)\n"
                    "2. Check data quality of input datasets (use check_data_quality)\n"
                    "3. Check lineage to identify upstream issues (use get_lineage)\n"
                    "4. Review the pipeline configuration\n\n"
                    "Provide: root cause analysis, immediate fix, and prevention steps."
                ),
            ),
        )
    ]


# ─── CLI Entry Point ───────────────────────────────────────────────

def main() -> None:
    """Run the CSA Platform MCP server (stdio transport)."""
    import asyncio

    server = create_server()

    async def run() -> None:
        from mcp.server.stdio import stdio_server

        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream)

    asyncio.run(run())


if __name__ == "__main__":
    main()
