"""Module entry point — ``python -m apps.copilot.surfaces.mcp``.

Launches the CSA Copilot MCP server over stdio (default) or streamable
HTTP (``--transport http --port N``).  All Copilot tools + resources
become first-class MCP capabilities.
"""

from __future__ import annotations

import argparse
import asyncio
import sys


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="apps.copilot.surfaces.mcp",
        description=(
            "Run the Copilot as an MCP server.  Defaults to stdio so "
            "Claude Desktop, Cursor, and CLI clients can spawn it "
            "directly.  Pass ``--transport http --port N`` to expose a "
            "streamable HTTP endpoint instead."
        ),
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="MCP transport to serve (default: stdio).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="TCP port for --transport http (required when transport=http).",
    )
    parser.add_argument(
        "--repo-root",
        default=None,
        help="Override the repo root used for the read-file tool.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Entry point — parse args and dispatch to the correct transport."""
    args = build_parser().parse_args(argv)
    from pathlib import Path

    from apps.copilot.surfaces.mcp.server import CopilotMCPServer

    repo_root = Path(args.repo_root).resolve() if args.repo_root else None
    try:
        server = CopilotMCPServer.from_defaults(repo_root=repo_root)
    except Exception as exc:  # pragma: no cover - surfaces boot error
        print(f"[copilot.mcp] failed to construct server: {exc}", file=sys.stderr)
        return 2

    if args.transport == "stdio":
        try:
            asyncio.run(server.run_stdio())
        except KeyboardInterrupt:  # pragma: no cover - interactive
            return 130
        return 0

    if args.transport == "http":
        if args.port <= 0:
            print("[copilot.mcp] --transport http requires --port", file=sys.stderr)
            return 2
        print(
            "[copilot.mcp] HTTP streamable transport is not wired yet; "
            "use --transport stdio.",
            file=sys.stderr,
        )
        return 3

    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
