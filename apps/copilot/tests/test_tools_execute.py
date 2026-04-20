"""Tests for :mod:`apps.copilot.tools.execute` (CSA-0100 + CSA-0102).

Every execute tool MUST refuse without a broker-issued token, and
MUST perform its side-effect only after successful verification.
These tests prove both conditions on a temporary filesystem so no
real repo state is ever mutated.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from apps.copilot.broker import (
    BrokerVerificationError,
    ConfirmationBroker,
    ConfirmationRequest,
    ConfirmationToken,
    reset_broker_chain_for_testing,
)
from apps.copilot.broker.broker import compute_input_hash
from apps.copilot.config import CopilotSettings
from apps.copilot.tools.base import MissingConfirmationTokenError, ToolInvocationError
from apps.copilot.tools.execute import (
    PublishDraftADRInput,
    PublishDraftADRTool,
    RunAlembicUpgradeInput,
    RunAlembicUpgradeTool,
)


@pytest.fixture(autouse=True)
def _reset_chain() -> None:
    """Every test starts with a fresh audit chain head."""
    reset_broker_chain_for_testing()


@pytest.fixture
def settings() -> CopilotSettings:
    """Settings with a fixed signing key — deterministic test behaviour."""
    return CopilotSettings(
        broker_signing_key="exec-tool-test-key",
        broker_token_ttl_seconds=300,
    )


@pytest.fixture
def broker(settings: CopilotSettings) -> ConfirmationBroker:
    """A fresh broker per test; four-eyes off for simplicity."""
    return ConfirmationBroker(settings)


async def _issue_token(
    broker: ConfirmationBroker,
    *,
    tool_name: str,
    payload: object,
    caller: str = "alice@example.com",
    approver: str = "bob@example.com",
) -> tuple[str, ConfirmationToken]:
    """Drive a broker through request → approve, return (request_id, token)."""
    req = ConfirmationRequest(
        request_id=f"req-{tool_name}-{id(payload)}",
        tool_name=tool_name,
        caller_principal=caller,
        scope="dev",
        input_hash=compute_input_hash(payload),
        justification="test",
    )
    await broker.request(req)
    token = await broker.approve(req.request_id, approver)
    return req.request_id, token


# ---------------------------------------------------------------------------
# RunAlembicUpgradeTool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_alembic_refuses_without_token(broker: ConfirmationBroker) -> None:
    """Invoking the tool without a token must raise MissingConfirmationTokenError."""
    calls: list[RunAlembicUpgradeInput] = []

    async def _runner(inp: RunAlembicUpgradeInput) -> tuple[int, str, str]:
        calls.append(inp)
        return (0, "OK", "")

    tool = RunAlembicUpgradeTool(broker=broker, runner=_runner)
    with pytest.raises(MissingConfirmationTokenError):
        await tool(RunAlembicUpgradeInput(revision="head"))

    # The side-effect must not have fired.
    assert calls == []


@pytest.mark.asyncio
async def test_alembic_runs_with_valid_token(broker: ConfirmationBroker) -> None:
    """With a valid token the tool executes the runner exactly once."""
    calls: list[RunAlembicUpgradeInput] = []

    async def _runner(inp: RunAlembicUpgradeInput) -> tuple[int, str, str]:
        calls.append(inp)
        return (0, "migrated", "")

    tool = RunAlembicUpgradeTool(broker=broker, runner=_runner)
    payload = RunAlembicUpgradeInput(revision="abc123")
    _, token = await _issue_token(broker, tool_name=tool.name, payload=payload)

    out = await tool(payload, token=token)
    assert out.exit_code == 0
    assert out.stdout == "migrated"
    assert out.token_id == token.token_id
    assert len(calls) == 1
    assert calls[0].revision == "abc123"


@pytest.mark.asyncio
async def test_alembic_rejects_replayed_token(broker: ConfirmationBroker) -> None:
    """A second call with the same token must be refused (replay protection)."""
    async def _runner(_: RunAlembicUpgradeInput) -> tuple[int, str, str]:
        return (0, "", "")

    tool = RunAlembicUpgradeTool(broker=broker, runner=_runner)
    payload = RunAlembicUpgradeInput(revision="head")
    _, token = await _issue_token(broker, tool_name=tool.name, payload=payload)

    await tool(payload, token=token)
    with pytest.raises(BrokerVerificationError):
        await tool(payload, token=token)


@pytest.mark.asyncio
async def test_alembic_rejects_token_for_different_tool(broker: ConfirmationBroker) -> None:
    """A token issued for publish_draft_adr cannot authorise alembic."""
    async def _runner(_: RunAlembicUpgradeInput) -> tuple[int, str, str]:
        return (0, "", "")

    tool = RunAlembicUpgradeTool(broker=broker, runner=_runner)
    payload = RunAlembicUpgradeInput(revision="head")
    _, wrong_token = await _issue_token(
        broker,
        tool_name="publish_draft_adr",
        payload=payload,
    )
    with pytest.raises(BrokerVerificationError, match="tool"):
        await tool(payload, token=wrong_token)


@pytest.mark.asyncio
async def test_alembic_rejects_mutated_input(broker: ConfirmationBroker) -> None:
    """Changing the payload after token issuance breaks the input-hash binding."""
    async def _runner(_: RunAlembicUpgradeInput) -> tuple[int, str, str]:
        return (0, "", "")

    tool = RunAlembicUpgradeTool(broker=broker, runner=_runner)
    original = RunAlembicUpgradeInput(revision="safe")
    _, token = await _issue_token(broker, tool_name=tool.name, payload=original)

    mutated = RunAlembicUpgradeInput(revision="dangerous")
    with pytest.raises(BrokerVerificationError, match="input_hash"):
        await tool(mutated, token=token)


# ---------------------------------------------------------------------------
# PublishDraftADRTool
# ---------------------------------------------------------------------------


def _make_draft(repo_root: Path, name: str = "0042-new.md") -> Path:
    """Create a draft ADR under ``<repo_root>/docs/adr/drafts/``."""
    drafts_dir = repo_root / "docs" / "adr" / "drafts"
    drafts_dir.mkdir(parents=True, exist_ok=True)
    draft = drafts_dir / name
    draft.write_text("# Draft ADR\n\nThis is a draft.", encoding="utf-8")
    return draft


@pytest.mark.asyncio
async def test_publish_draft_refuses_without_token(
    broker: ConfirmationBroker,
    tmp_path: Path,
) -> None:
    """Publishing without a token leaves the filesystem untouched."""
    draft = _make_draft(tmp_path)
    tool = PublishDraftADRTool(broker=broker, repo_root=tmp_path)

    with pytest.raises(MissingConfirmationTokenError):
        await tool(PublishDraftADRInput(draft_name=draft.name))

    # The draft must still exist; no sibling must have been created.
    assert draft.is_file()
    assert not (tmp_path / "docs" / "adr" / draft.name).exists()


@pytest.mark.asyncio
async def test_publish_draft_runs_with_valid_token(
    broker: ConfirmationBroker,
    tmp_path: Path,
) -> None:
    """With a valid token the draft is moved into ``docs/adr/``."""
    draft = _make_draft(tmp_path)
    tool = PublishDraftADRTool(broker=broker, repo_root=tmp_path)

    payload = PublishDraftADRInput(draft_name=draft.name, mode="move")
    _, token = await _issue_token(broker, tool_name=tool.name, payload=payload)

    out = await tool(payload, token=token)
    assert out.mode == "move"
    assert out.bytes_written > 0
    assert out.published_path.endswith(draft.name)
    assert not draft.is_file()
    assert (tmp_path / "docs" / "adr" / draft.name).is_file()


@pytest.mark.asyncio
async def test_publish_draft_copy_mode_preserves_source(
    broker: ConfirmationBroker,
    tmp_path: Path,
) -> None:
    """Copy mode leaves the draft in place."""
    draft = _make_draft(tmp_path, "0099-copy.md")
    tool = PublishDraftADRTool(broker=broker, repo_root=tmp_path)

    payload = PublishDraftADRInput(draft_name=draft.name, mode="copy")
    _, token = await _issue_token(broker, tool_name=tool.name, payload=payload)

    await tool(payload, token=token)
    assert draft.is_file()
    assert (tmp_path / "docs" / "adr" / draft.name).is_file()


@pytest.mark.asyncio
async def test_publish_draft_refuses_overwrite(
    broker: ConfirmationBroker,
    tmp_path: Path,
) -> None:
    """If the destination already exists the tool raises ToolInvocationError."""
    draft = _make_draft(tmp_path)
    existing = tmp_path / "docs" / "adr" / draft.name
    existing.write_text("# Already published", encoding="utf-8")

    tool = PublishDraftADRTool(broker=broker, repo_root=tmp_path)
    payload = PublishDraftADRInput(draft_name=draft.name)
    _, token = await _issue_token(broker, tool_name=tool.name, payload=payload)

    with pytest.raises(ToolInvocationError, match="already exists"):
        await tool(payload, token=token)
    # Original contents untouched.
    assert existing.read_text(encoding="utf-8") == "# Already published"


@pytest.mark.asyncio
async def test_publish_draft_rejects_path_traversal_in_name(
    broker: ConfirmationBroker,
    tmp_path: Path,
) -> None:
    """A draft_name containing a path separator is a traversal attempt."""
    tool = PublishDraftADRTool(broker=broker, repo_root=tmp_path)
    payload = PublishDraftADRInput(draft_name="../evil.md")
    _, token = await _issue_token(broker, tool_name=tool.name, payload=payload)
    with pytest.raises(ToolInvocationError, match="Invalid draft_name"):
        await tool(payload, token=token)


@pytest.mark.asyncio
async def test_publish_draft_rejects_non_markdown(
    broker: ConfirmationBroker,
    tmp_path: Path,
) -> None:
    """Only ``.md`` files are acceptable ADR drafts."""
    tool = PublishDraftADRTool(broker=broker, repo_root=tmp_path)
    payload = PublishDraftADRInput(draft_name="0001-evil.sh")
    _, token = await _issue_token(broker, tool_name=tool.name, payload=payload)
    with pytest.raises(ToolInvocationError, match="markdown"):
        await tool(payload, token=token)


@pytest.mark.asyncio
async def test_publish_draft_rejects_missing_file(
    broker: ConfirmationBroker,
    tmp_path: Path,
) -> None:
    """A non-existent draft filename must be refused without side-effects."""
    tool = PublishDraftADRTool(broker=broker, repo_root=tmp_path)
    payload = PublishDraftADRInput(draft_name="0007-nope.md")
    _, token = await _issue_token(broker, tool_name=tool.name, payload=payload)
    with pytest.raises(ToolInvocationError, match="not found"):
        await tool(payload, token=token)


# ---------------------------------------------------------------------------
# Category metadata
# ---------------------------------------------------------------------------


def test_execute_tools_are_execute_category(broker: ConfirmationBroker, tmp_path: Path) -> None:
    """Execute tools must self-identify with ``category='execute'``."""
    async def _runner(_: RunAlembicUpgradeInput) -> tuple[int, str, str]:
        return (0, "", "")  # pragma: no cover — only metadata is asserted

    alembic = RunAlembicUpgradeTool(broker=broker, runner=_runner)
    publish = PublishDraftADRTool(broker=broker, repo_root=tmp_path)
    assert alembic.category == "execute"
    assert publish.category == "execute"
