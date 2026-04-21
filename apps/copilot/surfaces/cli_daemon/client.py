"""Client for the Copilot CLI daemon.

Connects to a running daemon over Unix-domain socket (POSIX) or
localhost TCP (Windows / forced TCP) and issues a JSON-RPC request.
If no daemon is running, the client will spawn a detached daemon and
wait for it to appear before retrying.

Usage::

    python -m apps.copilot.surfaces.cli_daemon.client --help
    python -m apps.copilot.surfaces.cli_daemon.client ask "question"
    python -m apps.copilot.surfaces.cli_daemon.client ask --stream "..."
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import subprocess
import sys
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from apps.copilot.surfaces.cli_daemon.daemon import (
    default_pidfile_path,
    is_windows,
    read_pidfile,
)
from apps.copilot.surfaces.cli_daemon.protocol import (
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
)


class DaemonConnectError(RuntimeError):
    """Raised when the client cannot connect to a running daemon."""


class DaemonStartupError(RuntimeError):
    """Raised when auto-starting the daemon exceeds the configured timeout."""


@dataclass(frozen=True)
class ClientTarget:
    """Discovered daemon connection target."""

    transport: str
    host: str | None = None
    port: int | None = None
    socket: str | None = None


def discover_target(pidfile: Path) -> ClientTarget | None:
    """Return the daemon's :class:`ClientTarget`, or None when not running."""
    info = read_pidfile(pidfile)
    if info is None:
        return None
    transport = str(info.get("transport", ""))
    if transport == "tcp":
        host = str(info.get("host", "127.0.0.1"))
        port = int(info.get("port", 0) or 0)
        if port <= 0:
            return None
        return ClientTarget(transport="tcp", host=host, port=port)
    if transport == "unix":
        socket = str(info.get("socket", ""))
        if not socket or not Path(socket).exists():
            return None
        return ClientTarget(transport="unix", socket=socket)
    return None


async def _open_connection(
    target: ClientTarget,
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Open a reader/writer pair against *target*."""
    if target.transport == "tcp":
        assert target.host
        assert target.port
        return await asyncio.open_connection(target.host, target.port)
    if target.transport == "unix":
        assert target.socket
        open_unix = getattr(asyncio, "open_unix_connection", None)
        if open_unix is None:  # pragma: no cover - Windows
            raise DaemonConnectError(
                "Unix-domain sockets are unavailable on this platform.",
            )
        reader, writer = await open_unix(target.socket)
        return reader, writer
    raise DaemonConnectError(f"Unknown transport {target.transport!r}")


async def _send_request(
    target: ClientTarget,
    request: JsonRpcRequest,
    *,
    streaming: bool = False,
) -> JsonRpcResponse | tuple[JsonRpcResponse, list[JsonRpcNotification]]:
    """Send *request* and read the response (+ notifications when streaming)."""
    reader, writer = await _open_connection(target)
    writer.write((request.model_dump_json(exclude_none=True) + "\n").encode("utf-8"))
    await writer.drain()

    notifications: list[JsonRpcNotification] = []
    response: JsonRpcResponse | None = None
    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            payload = json.loads(line.decode("utf-8"))
            if payload.get("method") and "id" not in payload:
                if streaming:
                    notifications.append(JsonRpcNotification.model_validate(payload))
                continue
            response = JsonRpcResponse.model_validate(payload)
            break
    finally:
        writer.close()
        with contextlib.suppress(Exception):  # pragma: no cover - best effort
            await writer.wait_closed()

    if response is None:
        raise DaemonConnectError("Daemon closed the connection without responding.")
    if streaming:
        return response, notifications
    return response


def _spawn_daemon(pidfile: Path) -> None:
    """Start a detached daemon subprocess.  Returns immediately."""
    cmd = [
        sys.executable,
        "-m",
        "apps.copilot.surfaces.cli_daemon",
        "--pidfile",
        str(pidfile),
    ]
    # Detach; on Windows use CREATE_NEW_PROCESS_GROUP; on POSIX use setsid.
    creationflags = 0
    start_new_session = False
    if is_windows():
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | 0x00000008  # DETACHED_PROCESS
    else:
        start_new_session = True
    subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
        start_new_session=start_new_session,
        close_fds=True,
    )


async def _wait_for_daemon(
    pidfile: Path,
    timeout_seconds: float,
) -> ClientTarget:
    """Poll *pidfile* until a target appears or *timeout_seconds* elapses."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        target = discover_target(pidfile)
        if target is not None:
            return target
        await asyncio.sleep(0.1)
    raise DaemonStartupError(
        f"Daemon did not become ready within {timeout_seconds:.1f}s.",
    )


async def send(
    method: str,
    params: dict[str, Any] | None = None,
    *,
    pidfile: Path | None = None,
    auto_start: bool = True,
    startup_timeout_seconds: float = 10.0,
    streaming: bool = False,
) -> JsonRpcResponse | tuple[JsonRpcResponse, list[JsonRpcNotification]]:
    """Send a JSON-RPC request and return the parsed response."""
    pidfile = pidfile or default_pidfile_path()
    target = discover_target(pidfile)
    if target is None:
        if not auto_start:
            raise DaemonConnectError(
                f"No daemon running (pidfile missing or stale): {pidfile}",
            )
        _spawn_daemon(pidfile)
        target = await _wait_for_daemon(pidfile, startup_timeout_seconds)

    request = JsonRpcRequest(id=uuid.uuid4().hex, method=method, params=params or {})
    return await _send_request(target, request, streaming=streaming)


# ─────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    """Build the argparse CLI for the daemon client."""
    parser = argparse.ArgumentParser(
        prog="apps.copilot.surfaces.cli_daemon.client",
        description=(
            "Talk to a long-lived Copilot daemon over JSON-RPC.  When no "
            "daemon is running the client auto-starts one."
        ),
    )
    parser.add_argument("--pidfile", default=None, help="Override the pidfile path.")
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=10.0,
        help="Seconds to wait for auto-started daemon (default 10).",
    )
    parser.add_argument(
        "--no-autostart",
        action="store_true",
        help="Fail if no daemon is running instead of spawning one.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    ping = sub.add_parser("ping", help="Verify the daemon is responsive.")
    ping.set_defaults(func=_cli_ping)

    ask = sub.add_parser("ask", help="Send an ``ask`` RPC.")
    ask.add_argument("question")
    ask.add_argument("--stream", action="store_true", help="Stream tokens as notifications.")
    ask.set_defaults(func=_cli_ask)

    tools = sub.add_parser("tools", help="List daemon method surface.")
    tools.set_defaults(func=_cli_tools)

    skills = sub.add_parser("skills", help="List skills when the skills pkg is installed.")
    skills.set_defaults(func=_cli_skills)

    shutdown = sub.add_parser("shutdown", help="Ask the daemon to exit.")
    shutdown.set_defaults(func=_cli_shutdown)

    return parser


def _pidfile(args: argparse.Namespace) -> Path:
    if args.pidfile:
        return Path(args.pidfile)
    return default_pidfile_path()


def _print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, sort_keys=True, default=str))


async def _cli_ping_async(args: argparse.Namespace) -> int:
    response = await send(
        "ping",
        pidfile=_pidfile(args),
        auto_start=not args.no_autostart,
        startup_timeout_seconds=args.startup_timeout,
    )
    assert isinstance(response, JsonRpcResponse)
    _print_json(response.model_dump(mode="json", exclude_none=True))
    return 0 if response.error is None else 1


def _cli_ping(args: argparse.Namespace) -> int:
    return asyncio.run(_cli_ping_async(args))


async def _cli_ask_async(args: argparse.Namespace) -> int:
    pidfile = _pidfile(args)
    method = "ask_stream" if args.stream else "ask"
    out = await send(
        method,
        params={"question": args.question},
        pidfile=pidfile,
        auto_start=not args.no_autostart,
        startup_timeout_seconds=args.startup_timeout,
        streaming=args.stream,
    )
    if args.stream:
        assert isinstance(out, tuple)
        response, notifications = out
        for note in notifications:
            _print_json(note.model_dump(mode="json"))
        _print_json(response.model_dump(mode="json", exclude_none=True))
        return 0 if response.error is None else 1
    assert isinstance(out, JsonRpcResponse)
    _print_json(out.model_dump(mode="json", exclude_none=True))
    return 0 if out.error is None else 1


def _cli_ask(args: argparse.Namespace) -> int:
    return asyncio.run(_cli_ask_async(args))


async def _cli_tools_async(args: argparse.Namespace) -> int:
    response = await send(
        "tools.list",
        pidfile=_pidfile(args),
        auto_start=not args.no_autostart,
        startup_timeout_seconds=args.startup_timeout,
    )
    assert isinstance(response, JsonRpcResponse)
    _print_json(response.model_dump(mode="json", exclude_none=True))
    return 0 if response.error is None else 1


def _cli_tools(args: argparse.Namespace) -> int:
    return asyncio.run(_cli_tools_async(args))


async def _cli_skills_async(args: argparse.Namespace) -> int:
    response = await send(
        "skills.list",
        pidfile=_pidfile(args),
        auto_start=not args.no_autostart,
        startup_timeout_seconds=args.startup_timeout,
    )
    assert isinstance(response, JsonRpcResponse)
    _print_json(response.model_dump(mode="json", exclude_none=True))
    return 0 if response.error is None else 1


def _cli_skills(args: argparse.Namespace) -> int:
    return asyncio.run(_cli_skills_async(args))


async def _cli_shutdown_async(args: argparse.Namespace) -> int:
    try:
        response = await send(
            "shutdown",
            pidfile=_pidfile(args),
            auto_start=False,
            startup_timeout_seconds=args.startup_timeout,
        )
    except DaemonConnectError:
        _print_json({"status": "not_running"})
        return 0
    assert isinstance(response, JsonRpcResponse)
    _print_json(response.model_dump(mode="json", exclude_none=True))
    return 0 if response.error is None else 1


def _cli_shutdown(args: argparse.Namespace) -> int:
    return asyncio.run(_cli_shutdown_async(args))


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except DaemonConnectError as exc:
        print(f"[copilot.client] {exc}", file=sys.stderr)
        return 2
    except DaemonStartupError as exc:
        print(f"[copilot.client] {exc}", file=sys.stderr)
        return 3


__all__ = [
    "ClientTarget",
    "DaemonConnectError",
    "DaemonStartupError",
    "build_parser",
    "discover_target",
    "main",
    "send",
]


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())


# Unused imports pruned by linters — keep the helpers reachable.
_ = AsyncIterator, os
