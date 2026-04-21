"""Integration tests for the MCP streamable HTTP transport.

These tests drive :meth:`CopilotMCPServer.build_http_app` in-process
via :class:`httpx.AsyncClient` + :class:`httpx.ASGITransport`. No real
network sockets are opened — the test runs the
:class:`~mcp.server.streamable_http_manager.StreamableHTTPSessionManager`
lifespan context manually via ``async with session_manager.run()``
(``httpx.ASGITransport`` does not drive Starlette's lifespan, so we
drive the manager directly).
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from apps.copilot.models import AnswerResponse
from apps.copilot.surfaces.mcp.server import CopilotMCPServer
from apps.copilot.tools.readonly import (
    ReadRepoFileTool,
    SearchCorpusTool,
    WalkDecisionTreeTool,
)
from apps.copilot.tools.registry import ToolRegistry
from csa_platform.ai_integration.rag.pipeline import SearchResult


@contextlib.asynccontextmanager
async def _started_app(app: object) -> AsyncIterator[object]:
    """Run the MCP session manager lifespan inline.

    ``httpx.ASGITransport`` does not drive the Starlette lifespan so we
    activate the session manager directly. The manager lives on
    ``app.state.mcp_session_manager`` (populated by
    :meth:`CopilotMCPServer.build_http_app`).
    """
    manager = app.state.mcp_session_manager  # type: ignore[attr-defined]
    async with manager.run():
        yield app


class _FakeAgent:
    async def ask(self, question: str) -> AnswerResponse:
        return AnswerResponse(
            question=question,
            answer="http-answer",
            citations=[],
            groundedness=0.7,
            refused=False,
        )


class _FakeEmbedder:
    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        return [[0.1] * 4 for _ in texts]


class _FakeRetriever:
    async def search_async(
        self,
        query_vector: list[float],  # noqa: ARG002
        query_text: str = "",  # noqa: ARG002
        top_k: int = 5,  # noqa: ARG002
        score_threshold: float = 0.0,  # noqa: ARG002
        filters: str | None = None,  # noqa: ARG002
        use_semantic_reranker: bool = False,  # noqa: ARG002
    ) -> list[SearchResult]:
        return [
            SearchResult(
                id="h1",
                text="chunk",
                score=0.9,
                source="docs/x.md",
                metadata={"source_path": "docs/x.md", "doc_type": "overview"},
            ),
        ]


@pytest.fixture
def server(tmp_path: Path) -> CopilotMCPServer:
    """Construct a Copilot MCP server with stub dependencies."""
    repo = tmp_path
    (repo / "decision-trees").mkdir()
    (repo / "docs").mkdir()
    (repo / "docs" / "hello.md").write_text("hello world", encoding="utf-8")

    search = SearchCorpusTool(retriever=_FakeRetriever(), embedder=_FakeEmbedder())
    walker = WalkDecisionTreeTool(trees_root=repo / "decision-trees")
    reader = ReadRepoFileTool(repo_root=repo)
    registry = ToolRegistry([search, walker, reader])

    return CopilotMCPServer(
        agent=_FakeAgent(),  # type: ignore[arg-type]
        registry=registry,
        search_tool=search,
        walker=walker,
        file_reader=reader,
        repo_root=repo,
    )


def test_build_http_app_stateless(server: CopilotMCPServer) -> None:
    """The default HTTP app is stateless and mounted at /mcp."""
    app = server.build_http_app()
    assert app.state.mcp_mount_path == "/mcp"
    manager = app.state.mcp_session_manager
    assert manager.stateless is True
    assert manager.json_response is False


def test_build_http_app_stateful_and_json(server: CopilotMCPServer) -> None:
    """Session-mode + json-response are plumbed through to the manager."""
    app = server.build_http_app(
        stateless=False,
        json_response=True,
        mount_path="/copilot-mcp",
    )
    assert app.state.mcp_mount_path == "/copilot-mcp"
    manager = app.state.mcp_session_manager
    assert manager.stateless is False
    assert manager.json_response is True


@pytest.mark.asyncio
async def test_http_transport_rejects_non_mcp_path(
    server: CopilotMCPServer,
) -> None:
    """Requests outside the mount path return 404."""
    app = server.build_http_app(stateless=True, json_response=True)
    async with _started_app(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
        ) as client:
            resp = await client.get("/not-mcp")
            assert resp.status_code == 404


@pytest.mark.asyncio
async def test_http_transport_initialize_and_list_tools(
    server: CopilotMCPServer,
) -> None:
    """End-to-end: initialize → initialized → tools/list returns our tools.

    Uses ``--json-response`` mode so the TestClient gets a plain
    ``application/json`` body it can parse synchronously.  The session
    id is obtained from the ``Mcp-Session-Id`` response header on the
    initialize call and threaded through subsequent calls.
    """
    app = server.build_http_app(stateless=False, json_response=True)
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
    }

    async with _started_app(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            headers=headers,
            timeout=10.0,
        ) as client:
            init_payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "pytest", "version": "0.0.0"},
                },
            }
            init_resp = await client.post("/mcp/", json=init_payload)
            assert init_resp.status_code == 200, init_resp.text
            session_id = init_resp.headers.get("mcp-session-id")
            assert session_id, "server did not return an MCP session id"
            init_body = init_resp.json()
            assert init_body["jsonrpc"] == "2.0"
            assert init_body["id"] == 1
            assert "result" in init_body

            session_headers = {"Mcp-Session-Id": session_id}

            initialized_payload = {
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
            }
            notif_resp = await client.post(
                "/mcp/",
                json=initialized_payload,
                headers=session_headers,
            )
            # Notifications return 202 Accepted with no body.
            assert notif_resp.status_code in (200, 202)

            list_payload = {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {},
            }
            list_resp = await client.post(
                "/mcp/",
                json=list_payload,
                headers=session_headers,
            )
            assert list_resp.status_code == 200, list_resp.text
            data = list_resp.json()
            tool_names = {t["name"] for t in data["result"]["tools"]}
            assert {"ask", "list_skills", "run_skill"}.issubset(tool_names)


@pytest.mark.asyncio
async def test_http_transport_stateless_call_ask_tool(
    server: CopilotMCPServer,
) -> None:
    """Stateless mode can still invoke the ``ask`` tool with no session header.

    In stateless mode the transport is recreated per request, so each
    request must be fully self-contained (an ``initialize`` alone is
    not strictly required for a single-shot ``tools/call`` in this
    SDK configuration, but we send it anyway to match a realistic
    client flow).
    """
    app = server.build_http_app(stateless=True, json_response=True)
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
    }

    async with _started_app(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            headers=headers,
            timeout=10.0,
        ) as client:
            init_payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "pytest", "version": "0.0.0"},
                },
            }
            init_resp = await client.post("/mcp/", json=init_payload)
            assert init_resp.status_code == 200, init_resp.text

            call_payload = {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "ask",
                    "arguments": {"question": "hello?"},
                },
            }
            call_resp = await client.post("/mcp/", json=call_payload)
            # In stateless mode we do not need a session id; the server
            # accepts the call directly.
            assert call_resp.status_code == 200, call_resp.text
            data = call_resp.json()
            # ``tools/call`` returns a ``content`` array of TextContent items
            # — our dispatcher emits a JSON blob.
            content_items = data["result"]["content"]
            assert content_items
            text = content_items[0]["text"]
            payload = json.loads(text)
            assert payload["status"] == "ok"
            assert payload["output"]["answer"] == "http-answer"


def test_cli_http_main_rejects_invalid_port(
    server: CopilotMCPServer,  # noqa: ARG001
) -> None:
    """The module entry point refuses obviously invalid ports."""
    from apps.copilot.surfaces.mcp.__main__ import main

    # port 0 and negative values are both rejected.
    assert main(["--transport", "http", "--port", "0"]) == 2


def test_cli_http_parser_defaults() -> None:
    """The CLI parser exposes the session/json/mount flags with sane defaults."""
    from apps.copilot.surfaces.mcp.__main__ import build_parser

    args = build_parser().parse_args(["--transport", "http"])
    assert args.transport == "http"
    assert args.session_mode is False
    assert args.json_response is False
    assert args.mount_path == "/mcp"
