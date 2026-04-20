"""Tests for :mod:`apps.copilot.agent_loop` (CSA-0100).

The agent loop is the plan/act surface.  These tests build a mock
planner that returns a deterministic plan and drive a
:class:`CopilotAgentLoop` end-to-end over a
:class:`ToolRegistry` containing both read and execute tools.

Three scenarios are covered:

1. A plan that calls a read tool runs to completion with status
   ``completed``.
2. A plan that calls an execute tool **without** a token is refused
   with status ``refused_no_token``; the underlying side-effect
   must not fire.
3. A plan that calls an execute tool with a valid broker token runs
   to completion; the trace records the token id.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from apps.copilot.agent_loop import (
    AgentTrace,
    CopilotAgentLoop,
    PlannedStep,
)
from apps.copilot.broker import (
    ConfirmationBroker,
    ConfirmationRequest,
    reset_broker_chain_for_testing,
)
from apps.copilot.broker.broker import compute_input_hash
from apps.copilot.config import CopilotSettings
from apps.copilot.tools.execute import (
    PublishDraftADRInput,
    PublishDraftADRTool,
)
from apps.copilot.tools.readonly import (
    ReadRepoFileTool,
)
from apps.copilot.tools.registry import ToolRegistry

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakePlanner:
    """Deterministic planner — returns the plan the test handed in."""

    def __init__(self, plan: list[PlannedStep]) -> None:
        self._plan = plan
        self.seen_tools: list[list[dict[str, Any]]] = []
        self.calls = 0

    async def plan(
        self,
        question: str,  # noqa: ARG002
        tools: list[dict[str, Any]],
    ) -> list[PlannedStep]:
        self.calls += 1
        self.seen_tools.append(list(tools))
        return list(self._plan)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_chain() -> None:
    """Each test begins with a fresh broker audit chain."""
    reset_broker_chain_for_testing()


@pytest.fixture
def settings() -> CopilotSettings:
    """Broker settings with a fixed signing key."""
    return CopilotSettings(
        broker_signing_key="agent-loop-test-key",
        broker_token_ttl_seconds=300,
    )


@pytest.fixture
def broker(settings: CopilotSettings) -> ConfirmationBroker:
    """Fresh broker per test."""
    return ConfirmationBroker(settings)


@pytest.fixture
def repo_tree(tmp_path: Path) -> Path:
    """Minimal repo tree with an ADR + a draft to publish."""
    (tmp_path / "docs" / "adr").mkdir(parents=True)
    (tmp_path / "docs" / "adr" / "0001-bicep.md").write_text(
        "# ADR 0001\n\nUse Bicep.",
        encoding="utf-8",
    )
    drafts_dir = tmp_path / "docs" / "adr" / "drafts"
    drafts_dir.mkdir()
    (drafts_dir / "0042-privates.md").write_text(
        "# Draft 0042\n\nEnable private endpoints.",
        encoding="utf-8",
    )
    return tmp_path


@pytest.fixture
def registry(broker: ConfirmationBroker, repo_tree: Path) -> ToolRegistry:
    """Registry with one read tool and one execute tool."""
    reg = ToolRegistry()
    reg.register(ReadRepoFileTool(repo_root=repo_tree))
    reg.register(PublishDraftADRTool(broker=broker, repo_root=repo_tree))
    return reg


# ---------------------------------------------------------------------------
# Scenario 1 — read tool executes freely
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_plan_with_read_tool_runs_to_completion(
    registry: ToolRegistry,
    broker: ConfirmationBroker,
) -> None:
    """A plan that uses only read tools must run to status='completed'."""
    plan = [
        PlannedStep(
            tool_name="read_repo_file",
            arguments={"path": "docs/adr/0001-bicep.md"},
            rationale="load ADR content",
        ),
    ]
    loop = CopilotAgentLoop(
        registry=registry,
        broker=broker,
        planner=_FakePlanner(plan),
    )
    trace: AgentTrace = await loop.run("Why do we use Bicep?")
    assert len(trace.steps) == 1
    step = trace.steps[0]
    assert step.status == "completed"
    assert step.category == "read"
    assert step.output is not None
    assert "Use Bicep" in step.output["text"]
    assert trace.refused_reasons == []


# ---------------------------------------------------------------------------
# Scenario 2 — execute tool without token is refused
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_plan_with_execute_tool_no_token_refuses(
    registry: ToolRegistry,
    broker: ConfirmationBroker,
    repo_tree: Path,
) -> None:
    """An execute step without a token must yield status='refused_no_token'."""
    plan = [
        PlannedStep(
            tool_name="publish_draft_adr",
            arguments={"draft_name": "0042-privates.md"},
            rationale="publish the draft",
            token=None,
        ),
    ]
    loop = CopilotAgentLoop(
        registry=registry,
        broker=broker,
        planner=_FakePlanner(plan),
    )
    trace = await loop.run("Publish draft 0042")
    assert len(trace.steps) == 1
    step = trace.steps[0]
    assert step.status == "refused_no_token"
    assert "ConfirmationBroker" in (step.message or "") or "ConfirmationToken" in (step.message or "")
    assert trace.refused_reasons == ["publish_draft_adr:refused_no_token"]

    # Side-effect must NOT have happened: the draft is still in place
    # and no published copy was created.
    draft = repo_tree / "docs" / "adr" / "drafts" / "0042-privates.md"
    published = repo_tree / "docs" / "adr" / "0042-privates.md"
    assert draft.is_file()
    assert not published.exists()


# ---------------------------------------------------------------------------
# Scenario 3 — execute tool with valid token runs end-to-end
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_plan_with_execute_tool_and_valid_token_runs(
    registry: ToolRegistry,
    broker: ConfirmationBroker,
    repo_tree: Path,
) -> None:
    """With a broker token, the execute step runs and mutates the tree."""
    payload = PublishDraftADRInput(draft_name="0042-privates.md")
    req = ConfirmationRequest(
        request_id="req-publish-42",
        tool_name="publish_draft_adr",
        caller_principal="alice@example.com",
        scope="dev",
        input_hash=compute_input_hash(payload),
        justification="ship the ADR",
    )
    await broker.request(req)
    token = await broker.approve(req.request_id, "bob@example.com")

    plan = [
        PlannedStep(
            tool_name="publish_draft_adr",
            arguments=payload.model_dump(),
            rationale="publish draft 0042",
            token=token,
        ),
    ]
    loop = CopilotAgentLoop(
        registry=registry,
        broker=broker,
        planner=_FakePlanner(plan),
    )
    trace = await loop.run("Publish draft 0042")
    assert len(trace.steps) == 1
    step = trace.steps[0]
    assert step.status == "completed", step.message
    assert step.category == "execute"
    assert step.token_id == token.token_id
    assert step.output is not None
    assert step.output["published_path"].endswith("0042-privates.md")

    # Side-effect happened: draft removed, published file present.
    draft = repo_tree / "docs" / "adr" / "drafts" / "0042-privates.md"
    published = repo_tree / "docs" / "adr" / "0042-privates.md"
    assert not draft.exists()
    assert published.is_file()


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_question_short_circuits(registry: ToolRegistry, broker: ConfirmationBroker) -> None:
    """An empty question must not be planned against the registry."""
    planner = _FakePlanner([])
    loop = CopilotAgentLoop(registry=registry, broker=broker, planner=planner)
    trace = await loop.run("")
    assert trace.steps == []
    assert trace.refused_reasons == ["empty_question"]
    assert planner.calls == 0


@pytest.mark.asyncio
async def test_missing_tool_produces_refused_step(
    registry: ToolRegistry,
    broker: ConfirmationBroker,
) -> None:
    """An LLM-typoed tool name becomes a trace step, not an exception."""
    plan = [
        PlannedStep(tool_name="does_not_exist", arguments={}, rationale="typo"),
    ]
    loop = CopilotAgentLoop(
        registry=registry,
        broker=broker,
        planner=_FakePlanner(plan),
    )
    trace = await loop.run("anything")
    assert trace.steps[0].status == "refused_missing_tool"
    assert trace.steps[0].category == "unknown"


@pytest.mark.asyncio
async def test_planner_sees_tool_catalogue(registry: ToolRegistry, broker: ConfirmationBroker) -> None:
    """The planner receives the tool spec list on every run."""
    planner = _FakePlanner([])
    loop = CopilotAgentLoop(registry=registry, broker=broker, planner=planner)
    await loop.run("what do you know?")
    assert planner.calls == 1
    # At least the two registered tools should surface in the catalogue.
    seen = {t["name"] for t in planner.seen_tools[0]}
    assert "read_repo_file" in seen
    assert "publish_draft_adr" in seen


@pytest.mark.asyncio
async def test_execute_tool_with_bad_input_hash_refuses(
    registry: ToolRegistry,
    broker: ConfirmationBroker,
) -> None:
    """A token bound to payload A must refuse when payload B is presented."""
    original = PublishDraftADRInput(draft_name="0042-privates.md")
    req = ConfirmationRequest(
        request_id="req-bad-hash",
        tool_name="publish_draft_adr",
        caller_principal="alice@example.com",
        scope="dev",
        input_hash=compute_input_hash(original),
    )
    await broker.request(req)
    token = await broker.approve(req.request_id, "bob@example.com")

    plan = [
        PlannedStep(
            tool_name="publish_draft_adr",
            arguments={"draft_name": "different-file.md"},
            token=token,
        ),
    ]
    loop = CopilotAgentLoop(
        registry=registry,
        broker=broker,
        planner=_FakePlanner(plan),
    )
    trace = await loop.run("attempt mismatched payload")
    assert trace.steps[0].status == "refused_broker"
    assert "input_hash" in (trace.steps[0].message or "")
