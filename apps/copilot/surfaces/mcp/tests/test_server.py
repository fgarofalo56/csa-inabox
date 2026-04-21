"""Unit tests for :class:`CopilotMCPServer` (pure-Python dispatch layer)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.copilot.models import AnswerResponse
from apps.copilot.surfaces.mcp.resource_bridge import (
    parse_corpus_uri,
    parse_decision_tree_uri,
    parse_repo_file_uri,
)
from apps.copilot.surfaces.mcp.server import CopilotMCPServer
from apps.copilot.tools.readonly import (
    ReadRepoFileTool,
    SearchCorpusTool,
    WalkDecisionTreeTool,
)
from apps.copilot.tools.registry import ToolRegistry
from csa_platform.ai_integration.rag.pipeline import SearchResult


class _FakeAgent:
    async def ask(self, question: str) -> AnswerResponse:
        return AnswerResponse(
            question=question,
            answer="answer",
            citations=[],
            groundedness=0.8,
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
                id="c1",
                text="chunk text",
                score=0.9,
                source="docs/x.md",
                metadata={"source_path": "docs/x.md", "doc_type": "overview"},
            ),
        ]


@pytest.fixture
def server(tmp_path: Path) -> CopilotMCPServer:
    """Construct a server with stub dependencies."""
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


def test_list_tool_specs_includes_ask_and_skills(server: CopilotMCPServer) -> None:
    """The MCP server advertises ask + skills wrappers on top of the registry."""
    names = {spec.name for spec in server.list_tool_specs()}
    assert {"ask", "list_skills", "run_skill"}.issubset(names)
    # Registry tools are also advertised.
    assert {"search_corpus", "walk_decision_tree", "read_repo_file"}.issubset(names)


def test_list_resource_descriptors_has_corpus_and_tree(
    server: CopilotMCPServer,
) -> None:
    """The MCP server advertises corpus + decision tree resources."""
    uris = {desc.uri for desc in server.list_resource_descriptors()}
    assert "corpus://search/{query}" in uris
    assert "decision-tree://{tree_id}" in uris
    assert "repo-file://{path}" in uris


@pytest.mark.asyncio
async def test_handle_call_tool_ask_runs_agent(server: CopilotMCPServer) -> None:
    """`ask` tool dispatches to the Copilot agent and renders JSON."""
    text = await server.handle_call_tool("ask", {"question": "hi"})
    payload = json.loads(text)
    assert payload["status"] == "ok"
    assert payload["output"]["answer"] == "answer"


@pytest.mark.asyncio
async def test_handle_call_tool_search_corpus(server: CopilotMCPServer) -> None:
    """Registry-backed tools dispatch through the tool_bridge."""
    text = await server.handle_call_tool("search_corpus", {"query": "hello"})
    payload = json.loads(text)
    assert payload["status"] == "ok"
    assert payload["output"]["chunks"][0]["id"] == "c1"


@pytest.mark.asyncio
async def test_handle_call_tool_list_skills_returns_list(
    server: CopilotMCPServer,
) -> None:
    """list_skills returns a (possibly empty) list, never errors."""
    text = await server.handle_call_tool("list_skills", {})
    payload = json.loads(text)
    assert payload["status"] == "ok"
    assert isinstance(payload["skills"], list)


@pytest.mark.asyncio
async def test_handle_read_resource_corpus(server: CopilotMCPServer) -> None:
    """corpus://search/{query} resources run the search tool."""
    text = await server.handle_read_resource("corpus://search/hello")
    payload = json.loads(text)
    assert payload["query"] == "hello"
    assert len(payload["chunks"]) == 1


@pytest.mark.asyncio
async def test_handle_read_resource_repo_file(server: CopilotMCPServer) -> None:
    """repo-file://{path} resources run the file reader."""
    text = await server.handle_read_resource("repo-file://docs/hello.md")
    payload = json.loads(text)
    assert payload["text"] == "hello world"


@pytest.mark.asyncio
async def test_handle_read_resource_unknown_uri(
    server: CopilotMCPServer,
) -> None:
    """Unknown URIs return a structured error rather than raising."""
    text = await server.handle_read_resource("weird://nothing")
    payload = json.loads(text)
    assert payload["status"] == "unknown_resource"


# ─── URI parsing tests ───────────────────────────────────────────────────


def test_parse_corpus_uri_round_trip() -> None:
    """URL-encoded corpus queries decode back to the original string."""
    assert parse_corpus_uri("corpus://search/hello%20world") == "hello world"
    assert parse_corpus_uri("corpus://search/foo") == "foo"
    assert parse_corpus_uri("not-a-corpus-uri") is None


def test_parse_decision_tree_uri() -> None:
    assert parse_decision_tree_uri("decision-tree://onboarding") == "onboarding"
    assert parse_decision_tree_uri("decision-tree://with/slash") is None


def test_parse_repo_file_uri() -> None:
    assert parse_repo_file_uri("repo-file://docs/adr/0001.md") == "docs/adr/0001.md"
    assert parse_repo_file_uri("other-scheme://x") is None


@pytest.mark.asyncio
async def test_from_defaults_constructs_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default factory wires the production dependency chain.

    We don't exercise Azure calls — we just assert the object comes
    back with the expected field types.
    """
    # Block Azure client construction by forcing lazy agent build to
    # succeed without credentials; the dataclass fields are exposed so
    # tests can inspect without triggering network I/O.
    monkeypatch.setenv("COPILOT_AZURE_OPENAI_ENDPOINT", "")
    server = CopilotMCPServer.from_defaults(repo_root=tmp_path)
    assert isinstance(server.registry, ToolRegistry)
    assert server.repo_root == tmp_path.resolve()


def test_call_tool_routes_unknown_names(server: CopilotMCPServer) -> None:
    """Dispatch via handle_call_tool returns a structured error for unknowns."""
    import asyncio

    text = asyncio.run(server.handle_call_tool("nope", {}))
    payload = json.loads(text)
    # tool_bridge returns unknown_tool in the structured payload.
    assert "status" in payload


def test_run_stdio_requires_mcp_sdk(server: CopilotMCPServer) -> None:  # noqa: ARG001
    """Sanity: the SDK is importable in this environment.

    If this fails locally, the MCP extra is not installed and the
    stdio transport cannot run.  The method itself is exercised by
    integration tests; this unit test just asserts the import path.
    """
    import importlib

    assert importlib.import_module("mcp.server") is not None
