"""Unit tests for the CLI daemon client."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from apps.copilot.models import AnswerChunk, AnswerResponse
from apps.copilot.surfaces.cli_daemon.client import (
    ClientTarget,
    DaemonConnectError,
    discover_target,
    send,
)
from apps.copilot.surfaces.cli_daemon.daemon import (
    CopilotDaemon,
    DaemonConfig,
    read_pidfile,
    write_pidfile,
)


class _FakeAgent:
    async def ask(self, question: str) -> AnswerResponse:
        return AnswerResponse(
            question=question,
            answer="ok",
            citations=[],
            groundedness=0.9,
            refused=False,
        )

    async def ask_stream(
        self,
        question: str,
        *,
        extra_context: str = "",  # noqa: ARG002
    ) -> AsyncIterator[AnswerChunk]:
        yield AnswerChunk(kind="status", payload="retrieve-start")
        yield AnswerChunk(kind="token", payload="hi")
        yield AnswerChunk(
            kind="done",
            payload=AnswerResponse(
                question=question,
                answer="ok",
                citations=[],
                groundedness=0.9,
                refused=False,
            ),
        )


def test_discover_target_missing_pidfile(tmp_path: Path) -> None:
    """No pidfile → None."""
    assert discover_target(tmp_path / "missing") is None


def test_discover_target_stale_pidfile(tmp_path: Path) -> None:
    """Missing socket file → None."""
    path = tmp_path / "copilot.pid"
    write_pidfile(path, {"transport": "unix", "socket": str(tmp_path / "gone.sock")})
    assert discover_target(path) is None


def test_discover_target_tcp(tmp_path: Path) -> None:
    """Pidfile with host + port is parsed."""
    path = tmp_path / "copilot.pid"
    write_pidfile(
        path,
        {"transport": "tcp", "host": "127.0.0.1", "port": 1234},
    )
    target = discover_target(path)
    assert target == ClientTarget(transport="tcp", host="127.0.0.1", port=1234)


@pytest.fixture
def config(tmp_path: Path) -> DaemonConfig:
    return DaemonConfig(
        socket_path=tmp_path / "copilot.sock",
        pidfile_path=tmp_path / "copilot.pid",
        tcp_host="127.0.0.1",
        tcp_port=0,
        force_tcp=True,
    )


async def _spawn(config: DaemonConfig) -> tuple[CopilotDaemon, asyncio.Task[None]]:
    daemon = CopilotDaemon(config=config, agent_factory=_FakeAgent)
    task = asyncio.create_task(daemon.serve())
    for _ in range(50):
        info = read_pidfile(config.pidfile_path)
        if info and info.get("port"):
            return daemon, task
        await asyncio.sleep(0.05)
    raise RuntimeError("daemon did not start")


@pytest.mark.asyncio
async def test_client_send_ping(config: DaemonConfig) -> None:
    """End-to-end: client send → running daemon → JSON-RPC response."""
    daemon, task = await _spawn(config)
    try:
        response = await send(
            "ping",
            pidfile=config.pidfile_path,
            auto_start=False,
        )
        from apps.copilot.surfaces.cli_daemon.protocol import JsonRpcResponse

        assert isinstance(response, JsonRpcResponse)
        assert response.result is not None
        assert response.result["status"] == "pong"
        assert "pid" in response.result
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_client_send_streaming(config: DaemonConfig) -> None:
    """``ask_stream`` yields both notifications and a final response."""
    daemon, task = await _spawn(config)
    try:
        out = await send(
            "ask_stream",
            params={"question": "hello"},
            pidfile=config.pidfile_path,
            auto_start=False,
            streaming=True,
        )
        assert isinstance(out, tuple)
        response, notifications = out
        assert response.result is not None
        assert response.result["done"] is True
        kinds = [n.params["kind"] for n in notifications]
        assert "token" in kinds
        assert "done" in kinds
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_client_no_daemon_and_no_autostart(tmp_path: Path) -> None:
    """With no daemon and ``auto_start=False`` the client raises."""
    with pytest.raises(DaemonConnectError):
        await send(
            "ping",
            pidfile=tmp_path / "missing.pid",
            auto_start=False,
        )
