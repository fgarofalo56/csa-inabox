"""Model Context Protocol (MCP) server surface for the CSA Copilot.

Exposes the Copilot's tool registry and ``ask`` contract as MCP tools +
resources so any MCP-compatible IDE or agent (e.g. Claude Desktop) can
consume the Copilot as a first-class tool provider.

Entry points:
* ``python -m apps.copilot.surfaces.mcp``       — runs the stdio server.
* :class:`CopilotMCPServer`                     — importable server class.
"""

from __future__ import annotations

__all__ = ["CopilotMCPServer"]


def __getattr__(name: str) -> object:
    """Lazy re-export — importing the package must not pull the ``mcp`` SDK."""
    if name == "CopilotMCPServer":
        from apps.copilot.surfaces.mcp.server import CopilotMCPServer

        return CopilotMCPServer
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
