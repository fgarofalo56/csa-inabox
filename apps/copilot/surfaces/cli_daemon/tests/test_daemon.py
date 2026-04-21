"""Unit tests for the CLI daemon server."""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from apps.copilot.models import AnswerChunk, AnswerResponse
from apps.copilot.surfaces.cli_daemon.daemon import (
    CopilotDaemon,
    DaemonConfig,
    read_pidfile,
    write_pidfile,
)
from apps.copilot.surfaces.cli_daemon.protocol import (
    METHOD_NOT_FOUND,
    PARSE_ERROR,
)

# ─── Fake agent ──────────────────────────────────────────────────────────


class _FakeAgent:
    async def ask(self, question: str) -> AnswerResponse:
        return AnswerResponse(
            question=question,
            answer=f"fake: {question}",
            citations=[],
            groundedness=0.8,
            refused=False,
        )

    async def ask_stream(
        self,
        question: str,
        *,
        extra_context: str = "",  # noqa: ARG002
    ) -> AsyncIterator[AnswerChunk]:
        yield AnswerChunk(kind="status", payload="retrieve-start")
        yield AnswerChunk(kind="token", payload="fake: ")
        yield AnswerChunk(kind="token", payload=question)
        final = AnswerResponse(
            question=question,
            answer=f"fake: {question}",
            citations=[],
            groundedness=0.8,
            refused=False,
        )
        yield AnswerChunk(kind="done", payload=final)


# ─── Fixtures ────────────────────────────────────────────────────────────


@pytest.fixture
def daemon_config(tmp_path: Path) -> DaemonConfig:
    """Scoped config using tmp_path for sockets/pidfiles."""
    return DaemonConfig(
        socket_path=tmp_path / "copilot.sock",
        pidfile_path=tmp_path / "copilot.pid",
        tcp_host="127.0.0.1",
        tcp_port=0,
        # On Windows we always force TCP; on POSIX the tests still use
        # TCP so they behave uniformly and can run in CI containers.
        force_tcp=True,
    )


async def _spawn_daemon(
    config: DaemonConfig,
    agent_factory: Any = _FakeAgent,
) -> tuple[CopilotDaemon, asyncio.Task[None]]:
    """Construct a daemon and spin it up in the background."""
    daemon = CopilotDaemon(config=config, agent_factory=agent_factory)
    task = asyncio.create_task(daemon.serve())
    # Wait until the pidfile is visible so the client connects cleanly.
    for _ in range(50):
        if config.pidfile_path.exists():
            info = read_pidfile(config.pidfile_path)
            if info and info.get("port"):
                break
        await asyncio.sleep(0.05)
    return daemon, task


async def _client_send(
    config: DaemonConfig,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Open a TCP connection, send *payload*, read one JSON line back."""
    info = read_pidfile(config.pidfile_path)
    assert info is not None
    reader, writer = await asyncio.open_connection(
        info["host"],
        int(info["port"]),
    )
    writer.write((json.dumps(payload) + "\n").encode("utf-8"))
    await writer.drain()
    line = await reader.readline()
    writer.close()
    import contextlib

    with contextlib.suppress(Exception):
        await writer.wait_closed()
    return dict(json.loads(line.decode("utf-8")))


# ─── Tests ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_write_and_read_pidfile(tmp_path: Path) -> None:
    """Pidfile round-trips a JSON payload safely."""
    path = tmp_path / "copilot.pid"
    write_pidfile(path, {"pid": 42, "port": 1234})
    data = read_pidfile(path)
    assert data == {"pid": 42, "port": 1234}


@pytest.mark.asyncio
async def test_read_pidfile_missing_returns_none(tmp_path: Path) -> None:
    assert read_pidfile(tmp_path / "does-not-exist.pid") is None


@pytest.mark.asyncio
async def test_ping_round_trip(daemon_config: DaemonConfig) -> None:
    """A ``ping`` RPC returns a pong + pid."""
    daemon, task = await _spawn_daemon(daemon_config)
    try:
        response = await _client_send(
            daemon_config,
            {"jsonrpc": "2.0", "id": "1", "method": "ping", "params": {}},
        )
        assert response["id"] == "1"
        assert response["result"]["status"] == "pong"
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_ask_rpc(daemon_config: DaemonConfig) -> None:
    """The ``ask`` RPC invokes the fake agent and returns AnswerResponse JSON."""
    daemon, task = await _spawn_daemon(daemon_config)
    try:
        response = await _client_send(
            daemon_config,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "ask",
                "params": {"question": "hi"},
            },
        )
        assert response["result"]["answer"] == "fake: hi"
        assert response["result"]["groundedness"] == pytest.approx(0.8)
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_ask_rejects_empty_question(daemon_config: DaemonConfig) -> None:
    """Empty question → INVALID_PARAMS."""
    daemon, task = await _spawn_daemon(daemon_config)
    try:
        response = await _client_send(
            daemon_config,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "ask",
                "params": {"question": ""},
            },
        )
        assert response["error"]["code"] == -32602
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_unknown_method_returns_error(daemon_config: DaemonConfig) -> None:
    """Unknown methods surface METHOD_NOT_FOUND."""
    daemon, task = await _spawn_daemon(daemon_config)
    try:
        response = await _client_send(
            daemon_config,
            {"jsonrpc": "2.0", "id": 3, "method": "nope.nope", "params": {}},
        )
        assert response["error"]["code"] == METHOD_NOT_FOUND
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_parse_error_surface(daemon_config: DaemonConfig) -> None:
    """Malformed JSON yields PARSE_ERROR."""
    daemon, task = await _spawn_daemon(daemon_config)
    try:
        info = read_pidfile(daemon_config.pidfile_path)
        assert info is not None
        reader, writer = await asyncio.open_connection(info["host"], int(info["port"]))
        writer.write(b"not-json\n")
        await writer.drain()
        line = await reader.readline()
        writer.close()
        response = json.loads(line.decode("utf-8"))
        assert response["error"]["code"] == PARSE_ERROR
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_ask_stream_notifications(daemon_config: DaemonConfig) -> None:
    """``ask_stream`` emits notifications followed by a terminal response."""
    daemon, task = await _spawn_daemon(daemon_config)
    try:
        info = read_pidfile(daemon_config.pidfile_path)
        assert info is not None
        reader, writer = await asyncio.open_connection(info["host"], int(info["port"]))
        payload = {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "ask_stream",
            "params": {"question": "stream me"},
        }
        writer.write((json.dumps(payload) + "\n").encode("utf-8"))
        await writer.drain()

        notifications = []
        response = None
        while True:
            line = await reader.readline()
            if not line:
                break
            msg = json.loads(line.decode("utf-8"))
            if "id" in msg:
                response = msg
                break
            notifications.append(msg)
        writer.close()

        assert notifications, "expected at least one streaming notification"
        assert any(n["params"]["kind"] == "token" for n in notifications)
        assert any(n["params"]["kind"] == "done" for n in notifications)
        assert response is not None
        assert response["result"]["done"] is True
        assert response["result"]["final"]["answer"] == "fake: stream me"
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_shutdown_rpc(daemon_config: DaemonConfig) -> None:
    """Shutdown RPC drains the daemon and cleans up the pidfile."""
    _daemon, task = await _spawn_daemon(daemon_config)
    response = await _client_send(
        daemon_config,
        {"jsonrpc": "2.0", "id": 9, "method": "shutdown", "params": {}},
    )
    assert response["result"]["shutting_down"] is True
    await asyncio.wait_for(task, timeout=5)
    assert not daemon_config.pidfile_path.exists()


@pytest.mark.asyncio
async def test_skills_list_returns_a_list(daemon_config: DaemonConfig) -> None:
    """skills.list returns ``{"skills": [...]}`` (empty or populated)."""
    daemon, task = await _spawn_daemon(daemon_config)
    try:
        response = await _client_send(
            daemon_config,
            {"jsonrpc": "2.0", "id": 11, "method": "skills.list", "params": {}},
        )
        assert "skills" in response["result"]
        assert isinstance(response["result"]["skills"], list)
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.asyncio
async def test_tools_list_advertises_methods(daemon_config: DaemonConfig) -> None:
    """tools.list returns the daemon method surface."""
    daemon, task = await _spawn_daemon(daemon_config)
    try:
        response = await _client_send(
            daemon_config,
            {"jsonrpc": "2.0", "id": 12, "method": "tools.list", "params": {}},
        )
        methods = response["result"]["methods"]
        assert "ask" in methods
        assert "shutdown" in methods
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.skipif(sys.platform.startswith("win"), reason="Unix-socket only")
@pytest.mark.asyncio
async def test_unix_socket_mode_starts(tmp_path: Path) -> None:
    """POSIX Unix-domain socket mode can bind and ping.

    Skipped on Windows where ``asyncio.start_unix_server`` is unavailable.
    """
    config = DaemonConfig(
        socket_path=tmp_path / "copilot.sock",
        pidfile_path=tmp_path / "copilot.pid",
        force_tcp=False,
    )
    daemon = CopilotDaemon(config=config, agent_factory=_FakeAgent)
    task = asyncio.create_task(daemon.serve())
    try:
        for _ in range(50):
            if config.socket_path.exists() and config.pidfile_path.exists():
                break
            await asyncio.sleep(0.05)
        open_unix = asyncio.open_unix_connection  # type: ignore[attr-defined]
        reader, writer = await open_unix(str(config.socket_path))
        writer.write(
            (json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}}) + "\n").encode(
                "utf-8",
            ),
        )
        await writer.drain()
        line = await reader.readline()
        writer.close()
        payload = json.loads(line.decode("utf-8"))
        assert payload["result"]["status"] == "pong"
    finally:
        await daemon.request_shutdown()
        await asyncio.wait_for(task, timeout=5)
