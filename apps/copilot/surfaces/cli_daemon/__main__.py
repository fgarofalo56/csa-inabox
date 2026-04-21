"""Module entry point for the CLI daemon server.

Run with::

    python -m apps.copilot.surfaces.cli_daemon [--socket PATH] [--pidfile PATH]

For Windows hosts (or when ``--tcp`` is set) the daemon binds to
``127.0.0.1:0`` and writes the bound port to the pidfile.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="apps.copilot.surfaces.cli_daemon",
        description=(
            "Run the Copilot as a long-lived daemon over Unix-domain "
            "sockets (POSIX) or localhost TCP (Windows / --tcp).  Clients "
            "talk to the daemon via JSON-RPC; see client.py for helpers."
        ),
    )
    parser.add_argument(
        "--socket",
        default=None,
        help="Override the Unix domain socket path (POSIX only).",
    )
    parser.add_argument(
        "--pidfile",
        default=None,
        help="Override the pidfile path.",
    )
    parser.add_argument(
        "--tcp",
        action="store_true",
        help="Force TCP binding even on POSIX (useful for port-forwarded setups).",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="TCP bind host (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="TCP bind port (default: 0 == OS-assigned).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    args = build_parser().parse_args(argv)
    from apps.copilot.surfaces.cli_daemon.daemon import (
        CopilotDaemon,
        DaemonConfig,
        _serve_forever,
        default_pidfile_path,
        default_socket_path,
    )

    config = DaemonConfig(
        socket_path=Path(args.socket) if args.socket else default_socket_path(),
        pidfile_path=Path(args.pidfile) if args.pidfile else default_pidfile_path(),
        tcp_host=args.host,
        tcp_port=args.port,
        force_tcp=args.tcp,
    )
    daemon = CopilotDaemon(config=config)
    try:
        asyncio.run(_serve_forever(daemon))
    except KeyboardInterrupt:  # pragma: no cover - interactive
        return 130
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
