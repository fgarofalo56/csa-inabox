"""Module entry point — ``python -m apps.copilot.surfaces.mcp``.

Launches the CSA Copilot MCP server over stdio (default) or streamable
HTTP (``--transport http``).  All Copilot tools + resources become
first-class MCP capabilities.

HTTP transport binds to ``COPILOT_MCP_HTTP_HOST:COPILOT_MCP_HTTP_PORT``
(defaults ``127.0.0.1:8091``).  Session-less by default; pass
``--session-mode`` to enable stateful session tracking via the
``Mcp-Session-Id`` header.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

_DEFAULT_HTTP_HOST = "127.0.0.1"
_DEFAULT_HTTP_PORT = 8091


def _env_host() -> str:
    """Return the configured HTTP bind host, defaulting to loopback."""
    return os.environ.get("COPILOT_MCP_HTTP_HOST", _DEFAULT_HTTP_HOST).strip() or _DEFAULT_HTTP_HOST


def _env_port() -> int:
    """Return the configured HTTP bind port, defaulting to 8091.

    Falls back to the default if the env var is missing or not an int.
    """
    raw = os.environ.get("COPILOT_MCP_HTTP_PORT", "").strip()
    if not raw:
        return _DEFAULT_HTTP_PORT
    try:
        return int(raw)
    except ValueError:
        return _DEFAULT_HTTP_PORT


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="apps.copilot.surfaces.mcp",
        description=(
            "Run the Copilot as an MCP server.  Defaults to stdio so "
            "Claude Desktop, Cursor, and CLI clients can spawn it "
            "directly.  Pass ``--transport http`` to expose a "
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
        "--host",
        default=None,
        help=(
            "HTTP bind host (default: COPILOT_MCP_HTTP_HOST or "
            f"{_DEFAULT_HTTP_HOST!r})."
        ),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help=(
            "HTTP bind port (default: COPILOT_MCP_HTTP_PORT or "
            f"{_DEFAULT_HTTP_PORT})."
        ),
    )
    parser.add_argument(
        "--session-mode",
        action="store_true",
        help=(
            "Enable stateful session tracking for --transport http.  Off "
            "by default — each HTTP request is answered by a fresh "
            "transport (stateless)."
        ),
    )
    parser.add_argument(
        "--json-response",
        action="store_true",
        help=(
            "Reply with JSON instead of SSE event-stream frames on the "
            "HTTP transport.  Useful for non-SSE clients and tests."
        ),
    )
    parser.add_argument(
        "--mount-path",
        default="/mcp",
        help="URL path to mount the HTTP endpoint under (default: /mcp).",
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
        host = args.host or _env_host()
        port = args.port if args.port is not None else _env_port()
        if port <= 0 or port > 65_535:
            print(
                f"[copilot.mcp] invalid HTTP port {port!r}; must be 1-65535.",
                file=sys.stderr,
            )
            return 2
        try:
            asyncio.run(
                server.run_http(
                    host=host,
                    port=port,
                    stateless=not args.session_mode,
                    json_response=bool(args.json_response),
                    mount_path=args.mount_path,
                ),
            )
        except KeyboardInterrupt:  # pragma: no cover - interactive
            return 130
        return 0

    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
