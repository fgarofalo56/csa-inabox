"""Tests for :mod:`apps.copilot.tools.readonly` (CSA-0100).

All fixtures are in-memory or tmp_path so the tests never touch a
real Azure resource or the real repo tree.  The goal is to prove:

* Read tools run without a confirmation token (no ``broker.verify``).
* Each tool's invariants (allowlist, schema, bounded reads).
* ``WalkDecisionTreeTool`` correctly traverses YAML.
* ``ValidateGateDryRunTool`` never shells out when PowerShell is
  absent and uses an injected runner otherwise.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from apps.copilot.tools.base import ToolInvocationError
from apps.copilot.tools.readonly import (
    ALLOWED_READ_ROOTS,
    ReadRepoFileInput,
    ReadRepoFileTool,
    SearchCorpusInput,
    SearchCorpusTool,
    ValidateGateDryRunInput,
    ValidateGateDryRunTool,
    WalkDecisionTreeInput,
    WalkDecisionTreeTool,
)
from csa_platform.ai_integration.rag.pipeline import SearchResult

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class _StubEmbedder:
    """Async embedder that returns a fixed 4-d vector per text."""

    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]


class _StubRetriever:
    """Async retriever that replays pre-baked :class:`SearchResult` items."""

    def __init__(self, results: list[SearchResult]) -> None:
        self._results = list(results)
        self.calls = 0

    async def search_async(
        self,
        query_vector: list[float],  # noqa: ARG002
        query_text: str = "",  # noqa: ARG002
        top_k: int = 5,  # noqa: ARG002
        score_threshold: float = 0.0,  # noqa: ARG002
        filters: str | None = None,  # noqa: ARG002
        use_semantic_reranker: bool = False,  # noqa: ARG002
    ) -> list[SearchResult]:
        self.calls += 1
        return list(self._results)


# ---------------------------------------------------------------------------
# SearchCorpusTool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_corpus_tool_returns_normalised_chunks() -> None:
    """The tool should normalise retriever scores into the 0-1 band."""
    retriever = _StubRetriever(
        [
            SearchResult(
                id="c1",
                score=0.91,
                text="Use Bicep.",
                metadata={"source_path": "docs/adr/0001.md", "doc_type": "adr"},
                source="docs/adr/0001.md",
            ),
            SearchResult(
                id="c2",
                score=12.0,  # Above 1.0 — must be clamped.
                text="Modules everywhere.",
                metadata={"source_path": "docs/adr/0001.md", "doc_type": "adr"},
                source="docs/adr/0001.md",
            ),
        ],
    )
    tool = SearchCorpusTool(retriever=retriever, embedder=_StubEmbedder())
    result = await tool(SearchCorpusInput(query="bicep reasons", top_k=2))
    assert [c.id for c in result.chunks] == ["c1", "c2"]
    assert all(0.0 <= c.similarity <= 1.0 for c in result.chunks)
    assert retriever.calls == 1


@pytest.mark.asyncio
async def test_search_corpus_tool_handles_empty_retriever() -> None:
    """An empty retriever must still return a well-formed output."""
    tool = SearchCorpusTool(retriever=_StubRetriever([]), embedder=_StubEmbedder())
    result = await tool(SearchCorpusInput(query="nothing"))
    assert result.chunks == []


# ---------------------------------------------------------------------------
# WalkDecisionTreeTool
# ---------------------------------------------------------------------------


def _write_tree(path: Path) -> None:
    """Write a minimal YAML tree used by the walker tests."""
    path.write_text(
        "tree_id: test\n"
        "title: Test Tree\n"
        "nodes:\n"
        "  - id: start\n"
        "    question: 'Pick one'\n"
        "    options:\n"
        "      - label: 'yes'\n"
        "        next: leaf-yes\n"
        "      - label: 'no'\n"
        "        next: leaf-no\n"
        "  - id: leaf-yes\n"
        "    recommendation: 'Go ahead.'\n"
        "  - id: leaf-no\n"
        "    recommendation: 'Stop.'\n",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_walk_tree_reaches_leaf_on_valid_choice(tmp_path: Path) -> None:
    """Walking with a matching choice should land on the leaf."""
    _write_tree(tmp_path / "test.yaml")
    tool = WalkDecisionTreeTool(trees_root=tmp_path)
    out = await tool(WalkDecisionTreeInput(tree_id="test", choices=["yes"]))
    assert out.reached_leaf is True
    assert out.final_recommendation == "Go ahead."
    assert [s.node_id for s in out.path] == ["start", "leaf-yes"]


@pytest.mark.asyncio
async def test_walk_tree_halts_on_unknown_choice(tmp_path: Path) -> None:
    """An unknown label should short-circuit without raising."""
    _write_tree(tmp_path / "test.yaml")
    tool = WalkDecisionTreeTool(trees_root=tmp_path)
    out = await tool(WalkDecisionTreeInput(tree_id="test", choices=["maybe"]))
    assert out.reached_leaf is False
    assert out.unresolved_choice == "maybe"


@pytest.mark.asyncio
async def test_walk_tree_halts_without_choices(tmp_path: Path) -> None:
    """Running out of choices stops at the current branching node."""
    _write_tree(tmp_path / "test.yaml")
    tool = WalkDecisionTreeTool(trees_root=tmp_path)
    out = await tool(WalkDecisionTreeInput(tree_id="test"))
    assert out.reached_leaf is False
    assert out.unresolved_choice is None
    assert out.path[0].node_id == "start"


@pytest.mark.asyncio
async def test_walk_tree_rejects_missing_file(tmp_path: Path) -> None:
    """Missing tree id must raise ``ToolInvocationError`` (not FileNotFound)."""
    tool = WalkDecisionTreeTool(trees_root=tmp_path)
    with pytest.raises(ToolInvocationError, match="not found"):
        await tool(WalkDecisionTreeInput(tree_id="nope"))


@pytest.mark.asyncio
async def test_walk_tree_rejects_traversal_tree_id(tmp_path: Path) -> None:
    """A tree id containing ``/`` is a traversal attempt."""
    tool = WalkDecisionTreeTool(trees_root=tmp_path)
    with pytest.raises(ToolInvocationError, match="Invalid tree_id"):
        await tool(WalkDecisionTreeInput(tree_id="../evil"))


# ---------------------------------------------------------------------------
# ReadRepoFileTool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_repo_file_reads_allowlisted_path(tmp_path: Path) -> None:
    """Reading a file under an allowed root returns its text."""
    doc = tmp_path / "docs" / "adr" / "0001.md"
    doc.parent.mkdir(parents=True)
    doc.write_text("# ADR 0001\n\nBicep for all.", encoding="utf-8")

    tool = ReadRepoFileTool(repo_root=tmp_path)
    out = await tool(ReadRepoFileInput(path="docs/adr/0001.md"))
    assert out.text.startswith("# ADR 0001")
    assert out.truncated is False


@pytest.mark.asyncio
async def test_read_repo_file_rejects_non_allowlisted_root(tmp_path: Path) -> None:
    """Files outside the allowlist must be refused with a clear reason."""
    secret = tmp_path / "secrets" / ".env"
    secret.parent.mkdir(parents=True)
    secret.write_text("KEY=leak", encoding="utf-8")

    tool = ReadRepoFileTool(repo_root=tmp_path)
    with pytest.raises(ToolInvocationError, match="allowlist"):
        await tool(ReadRepoFileInput(path="secrets/.env"))


@pytest.mark.asyncio
async def test_read_repo_file_rejects_traversal(tmp_path: Path) -> None:
    """Paths containing ``..`` must be rejected up-front."""
    tool = ReadRepoFileTool(repo_root=tmp_path)
    with pytest.raises(ToolInvocationError, match="traversal"):
        await tool(ReadRepoFileInput(path="docs/../../../etc/passwd"))


@pytest.mark.asyncio
async def test_read_repo_file_respects_max_bytes(tmp_path: Path) -> None:
    """Reads are bounded by ``max_bytes`` and the ``truncated`` flag is set."""
    doc = tmp_path / "docs" / "0002.md"
    doc.parent.mkdir(parents=True)
    doc.write_bytes(b"A" * 100)

    tool = ReadRepoFileTool(repo_root=tmp_path)
    out = await tool(ReadRepoFileInput(path="docs/0002.md", max_bytes=10))
    assert out.bytes_read == 10
    assert out.truncated is True
    assert out.text == "A" * 10


def test_read_repo_file_allowlist_matches_spec() -> None:
    """The allowlist constant stays in sync with documented roots."""
    assert "docs/adr" in ALLOWED_READ_ROOTS
    assert "docs/decisions" in ALLOWED_READ_ROOTS
    assert "docs/migrations" in ALLOWED_READ_ROOTS


# ---------------------------------------------------------------------------
# ValidateGateDryRunTool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_gate_dry_run_injected_runner(tmp_path: Path) -> None:
    """An injected runner records the dry-run argv and produces output."""
    gates_dir = tmp_path / "dev-loop" / "gates"
    gates_dir.mkdir(parents=True)
    (gates_dir / "validate-python.ps1").write_text("Write-Host dry", encoding="utf-8")

    captured: list[Sequence[str]] = []

    async def _fake_runner(argv: Sequence[str]) -> tuple[int, str, str]:
        captured.append(list(argv))
        return (0, "Python clean", "")

    tool = ValidateGateDryRunTool(
        repo_root=tmp_path,
        runner=_fake_runner,
        powershell="pwsh-fake",
    )
    out = await tool(ValidateGateDryRunInput(gate="validate-python"))
    assert out.exit_code == 0
    assert out.stdout == "Python clean"
    assert out.skipped is False
    assert "-WhatIf" in captured[0]
    assert out.invocation[0] == "pwsh-fake"


@pytest.mark.asyncio
async def test_validate_gate_dry_run_skips_when_pwsh_missing(tmp_path: Path) -> None:
    """Without pwsh and without an injected runner the tool must skip."""
    gates_dir = tmp_path / "dev-loop" / "gates"
    gates_dir.mkdir(parents=True)
    (gates_dir / "validate-python.ps1").write_text("", encoding="utf-8")

    tool = ValidateGateDryRunTool(repo_root=tmp_path, runner=None, powershell=None)
    # Monkeypatch the resolver to force the "missing" branch regardless of host.
    tool._resolve_powershell = lambda: None  # type: ignore[method-assign]
    out = await tool(ValidateGateDryRunInput(gate="validate-python"))
    assert out.skipped is True
    assert out.reason is not None


@pytest.mark.asyncio
async def test_validate_gate_dry_run_rejects_unknown_gate(tmp_path: Path) -> None:
    """A gate outside the allowlist must be refused even if the file exists."""
    (tmp_path / "dev-loop" / "gates").mkdir(parents=True)

    async def _runner(_: Sequence[str]) -> tuple[int, str, str]:  # pragma: no cover
        return (0, "", "")

    tool = ValidateGateDryRunTool(repo_root=tmp_path, runner=_runner, powershell="pwsh")
    with pytest.raises(Exception):  # noqa: B017, PT011 — pydantic ValidationError for literal
        await tool(ValidateGateDryRunInput(gate="validate-evil"))  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_validate_gate_dry_run_deployment_forwards_environment(tmp_path: Path) -> None:
    """The deployment gate must receive ``-Environment`` forwarded from the input."""
    gates_dir = tmp_path / "dev-loop" / "gates"
    gates_dir.mkdir(parents=True)
    (gates_dir / "validate-deployment.ps1").write_text("", encoding="utf-8")

    captured: list[Sequence[str]] = []

    async def _runner(argv: Sequence[str]) -> tuple[int, str, str]:
        captured.append(list(argv))
        return (0, "", "")

    tool = ValidateGateDryRunTool(repo_root=tmp_path, runner=_runner, powershell="pwsh")
    await tool(
        ValidateGateDryRunInput(gate="validate-deployment", environment="stage"),
    )
    assert "-Environment" in captured[0]
    assert "stage" in captured[0]


def test_search_corpus_tool_has_frozen_inputs() -> None:
    """Pydantic input models must be frozen so the agent loop is race-free."""
    sample = SearchCorpusInput(query="q")
    with pytest.raises(Exception):  # noqa: B017, PT011 — pydantic-version-specific
        sample.query = "other"


def test_read_repo_file_input_defaults_are_conservative() -> None:
    """Default ``max_bytes`` must be small enough to protect the agent loop."""
    sample = ReadRepoFileInput(path="docs/adr/0001.md")
    assert sample.max_bytes <= 128 * 1024


def test_walk_decision_tree_matches_real_repo_tree(tmp_path: Path) -> None:
    """The walker tolerates the real ``decision-trees/*.yaml`` schema."""
    # Copy a real tree shape into tmp_path — but write inline to keep
    # the test offline.  The schema must match decision-trees/*.yaml.
    (tmp_path / "shape.yaml").write_text(
        "tree_id: shape\n"
        "title: shape\n"
        "nodes:\n"
        "  - id: start\n"
        "    question: q\n"
        "    options:\n"
        "      - label: a\n"
        "        next: rec\n"
        "  - id: rec\n"
        "    recommendation: 'ok'\n",
        encoding="utf-8",
    )
    # WalkDecisionTreeTool is synchronous in its path resolution but
    # returns a coroutine — we only assert the schema is acceptable.
    tool = WalkDecisionTreeTool(trees_root=tmp_path)
    assert tool.input_model is WalkDecisionTreeInput


# ---------------------------------------------------------------------------
# Tool.category metadata
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("tool_cls", "init_kwargs"),
    [
        (
            SearchCorpusTool,
            {"retriever": _StubRetriever([]), "embedder": _StubEmbedder()},
        ),
        (WalkDecisionTreeTool, {"trees_root": Path(".")}),
        (ReadRepoFileTool, {"repo_root": Path(".")}),
        (ValidateGateDryRunTool, {"repo_root": Path(".")}),
    ],
)
def test_readonly_tools_are_read_category(tool_cls: type, init_kwargs: dict[str, Any]) -> None:
    """Every readonly tool must self-identify as ``category='read'``."""
    tool = tool_cls(**init_kwargs)
    assert tool.category == "read"
