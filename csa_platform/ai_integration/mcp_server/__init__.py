"""MCP Server for CSA-in-a-Box Platform.

Exposes CSA platform capabilities (data catalog, governance, quality,
lineage, pipeline status) as MCP resources and tools for AI agents.

Can be connected to:
- Azure AI Foundry hosted agents via MCP tool connection
- Semantic Kernel agents via MCPStdioPlugin or MCPSsePlugin
- Claude Code or other MCP-compatible clients
"""

from csa_platform.ai_integration.mcp_server.server import create_server

__all__ = ["create_server"]
