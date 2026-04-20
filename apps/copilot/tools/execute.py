"""Execute-class tools for the Copilot agent loop (CSA-0100 + CSA-0102).

Every tool in this module performs a real side-effect (file write,
command execution) and must be invoked with a valid
:class:`~apps.copilot.broker.models.ConfirmationToken` issued by the
:class:`~apps.copilot.broker.broker.ConfirmationBroker`.  The tool
calls ``broker.verify(token, tool.name, input_hash)`` before running
its side-effect path — invocation without a token raises
:class:`~apps.copilot.tools.base.MissingConfirmationTokenError` so the
agent loop can surface a clean refusal.

Two concrete tools ship here:

* :class:`RunAlembicUpgradeTool` — invokes an injected ``alembic`` runner
  to upgrade the schema.  The runner is fully injectable so tests
  exercise the code path without touching a real database.
* :class:`PublishDraftADRTool` — promotes a ``docs/adr/drafts/*.md``
  file to ``docs/adr/``.  Writes are constrained to a repo-relative
  sandbox so tests can set ``repo_root`` to a temp directory and
  confirm the move happens only after a token.

The key invariant is: **no execute tool ever runs a side-effect
without a broker-issued token**.  Tests assert this explicitly.
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.broker.broker import (
    BrokerVerificationError,
    ConfirmationBroker,
    compute_input_hash,
)
from apps.copilot.broker.models import ConfirmationToken
from apps.copilot.tools.base import (
    MissingConfirmationTokenError,
    ToolCategory,
    ToolInvocationError,
)
from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _verify_token_or_fail(
    broker: ConfirmationBroker,
    token: ConfirmationToken | None,
    tool_name: str,
    payload: Any,
) -> None:
    """Verify *token* for *tool_name* against *payload*.

    Raises :class:`MissingConfirmationTokenError` if no token was
    provided and :class:`BrokerVerificationError` if the broker
    rejects the token.  On success, returns ``None`` and the caller
    proceeds to the side-effect path.
    """
    if token is None:
        raise MissingConfirmationTokenError(
            f"Execute tool {tool_name!r} requires a ConfirmationToken. "
            "Obtain one from the ConfirmationBroker before invoking.",
        )
    input_hash = compute_input_hash(payload)
    # The broker raises on failure; propagate rather than convert so
    # the agent loop preserves the exact failure reason in its trace.
    await broker.verify(token, tool_name=tool_name, input_hash=input_hash)


# ---------------------------------------------------------------------------
# RunAlembicUpgradeTool
# ---------------------------------------------------------------------------


class RunAlembicUpgradeInput(BaseModel):
    """Input for :class:`RunAlembicUpgradeTool`."""

    revision: str = Field(
        default="head",
        min_length=1,
        description="Alembic revision identifier (``head`` or a hash).",
    )
    config_path: str = Field(
        default="alembic.ini",
        description="Repo-relative path to the alembic configuration file.",
    )
    database_url_env: str = Field(
        default="DATABASE_URL",
        description="Name of the env var the runner resolves to get the DB URL.",
    )

    model_config = ConfigDict(frozen=True)


class RunAlembicUpgradeOutput(BaseModel):
    """Output of :class:`RunAlembicUpgradeTool`."""

    revision: str = Field(description="Revision the runner was asked to upgrade to.")
    exit_code: int = Field(description="Exit code returned by the runner (0 == success).")
    stdout: str = Field(description="Captured stdout.")
    stderr: str = Field(description="Captured stderr.")
    approver_principal: str = Field(description="Principal that approved the token.")
    token_id: str = Field(description="Token id that authorised this invocation.")

    model_config = ConfigDict(frozen=True)


# The runner signature keeps tests pure — production wiring hooks an
# asyncio subprocess runner in ``RunAlembicUpgradeTool.default_runner``.
AlembicRunner = Callable[[RunAlembicUpgradeInput], Awaitable[tuple[int, str, str]]]


class RunAlembicUpgradeTool:
    """Run an Alembic upgrade after verifying a broker token.

    The tool never imports :mod:`alembic` directly — it delegates to
    an injected *runner* coroutine that returns ``(exit_code, stdout,
    stderr)``.  Production code provides a runner that shells out to
    ``alembic -c <config> upgrade <revision>``.  Tests pass a fake
    runner that records calls.
    """

    name: str = "run_alembic_upgrade"
    category: ToolCategory = "execute"
    description: str = (
        "Run an Alembic database migration to the target revision. "
        "Requires a ConfirmationToken bound to this tool and input hash."
    )
    input_model: type[RunAlembicUpgradeInput] = RunAlembicUpgradeInput
    output_model: type[RunAlembicUpgradeOutput] = RunAlembicUpgradeOutput

    def __init__(
        self,
        *,
        broker: ConfirmationBroker,
        runner: AlembicRunner,
    ) -> None:
        self.broker = broker
        self.runner = runner

    async def __call__(
        self,
        input_value: RunAlembicUpgradeInput,
        *,
        token: ConfirmationToken | None = None,
    ) -> RunAlembicUpgradeOutput:
        # Broker verification FIRST — no side-effects happen until the
        # token is proven valid.
        await _verify_token_or_fail(
            self.broker,
            token,
            self.name,
            input_value,
        )
        # ``token`` is guaranteed non-None past this point because
        # _verify_token_or_fail raises if it was None.
        assert token is not None  # for mypy
        logger.info(
            "copilot.tools.alembic_upgrade",
            revision=input_value.revision,
            config=input_value.config_path,
            token_id=token.token_id,
        )
        exit_code, stdout, stderr = await self.runner(input_value)
        return RunAlembicUpgradeOutput(
            revision=input_value.revision,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            approver_principal=token.approver_principal,
            token_id=token.token_id,
        )


# ---------------------------------------------------------------------------
# PublishDraftADRTool
# ---------------------------------------------------------------------------


class PublishDraftADRInput(BaseModel):
    """Input for :class:`PublishDraftADRTool`."""

    draft_name: str = Field(
        min_length=1,
        description=(
            "Bare filename (no path separators) of the draft under "
            "``docs/adr/drafts/``, e.g. ``0042-use-private-endpoints.md``."
        ),
    )
    published_name: str | None = Field(
        default=None,
        description=(
            "Optional override for the destination filename. When unset, the "
            "draft filename is reused (minus the drafts/ prefix)."
        ),
    )
    mode: Literal["copy", "move"] = Field(
        default="move",
        description="``copy`` keeps the draft in place; ``move`` deletes it.",
    )

    model_config = ConfigDict(frozen=True)


class PublishDraftADROutput(BaseModel):
    """Output of :class:`PublishDraftADRTool`."""

    draft_path: str = Field(description="Repo-relative path of the source draft.")
    published_path: str = Field(description="Repo-relative path of the published ADR.")
    mode: Literal["copy", "move"] = Field(description="Mode that was used.")
    bytes_written: int = Field(ge=0, description="Number of bytes written to the destination.")
    approver_principal: str = Field(description="Principal that approved the token.")
    token_id: str = Field(description="Token id that authorised this invocation.")

    model_config = ConfigDict(frozen=True)


class PublishDraftADRTool:
    """Promote a draft ADR from ``docs/adr/drafts/`` to ``docs/adr/``.

    All path handling is constrained to *repo_root*.  A draft name
    containing a path separator is rejected — the intent is to
    publish a single file, not move something arbitrary.

    The destination file is never overwritten by default; callers
    must delete or rename any pre-existing file first (the explicit
    error surfaces in the agent trace).
    """

    name: str = "publish_draft_adr"
    category: ToolCategory = "execute"
    description: str = (
        "Promote a draft ADR from docs/adr/drafts/ into docs/adr/. "
        "Requires a ConfirmationToken bound to this tool and input hash."
    )
    input_model: type[PublishDraftADRInput] = PublishDraftADRInput
    output_model: type[PublishDraftADROutput] = PublishDraftADROutput

    def __init__(
        self,
        *,
        broker: ConfirmationBroker,
        repo_root: Path,
    ) -> None:
        self.broker = broker
        self.repo_root = Path(repo_root).resolve()

    async def __call__(
        self,
        input_value: PublishDraftADRInput,
        *,
        token: ConfirmationToken | None = None,
    ) -> PublishDraftADROutput:
        await _verify_token_or_fail(
            self.broker,
            token,
            self.name,
            input_value,
        )
        assert token is not None  # for mypy

        name = input_value.draft_name
        if "/" in name or "\\" in name or name.startswith("."):
            raise ToolInvocationError(
                f"Invalid draft_name {name!r} — must be a bare filename.",
            )
        if not name.lower().endswith(".md"):
            raise ToolInvocationError(
                f"Invalid draft_name {name!r} — ADRs must be markdown files.",
            )
        published_name = input_value.published_name or name
        if "/" in published_name or "\\" in published_name:
            raise ToolInvocationError(
                f"Invalid published_name {published_name!r} — must be a bare filename.",
            )

        drafts_dir = self.repo_root / "docs" / "adr" / "drafts"
        target_dir = self.repo_root / "docs" / "adr"
        source = (drafts_dir / name).resolve()
        destination = (target_dir / published_name).resolve()

        # Defence-in-depth: confirm resolved paths are still under repo_root.
        for path in (source, destination):
            try:
                path.relative_to(self.repo_root)
            except ValueError as exc:
                raise ToolInvocationError(
                    f"Refusing to operate on {path}: outside repo root.",
                ) from exc

        if not source.is_file():
            raise ToolInvocationError(f"Draft ADR not found: {source}")
        if destination.exists():
            raise ToolInvocationError(
                f"Destination already exists: {destination}. "
                "Remove or rename it before publishing.",
            )

        target_dir.mkdir(parents=True, exist_ok=True)
        if input_value.mode == "move":
            bytes_written = await asyncio.to_thread(_move_file, source, destination)
        else:
            bytes_written = await asyncio.to_thread(_copy_file, source, destination)

        draft_rel = source.relative_to(self.repo_root).as_posix()
        pub_rel = destination.relative_to(self.repo_root).as_posix()
        logger.info(
            "copilot.tools.publish_draft_adr",
            draft=draft_rel,
            published=pub_rel,
            mode=input_value.mode,
            token_id=token.token_id,
        )
        return PublishDraftADROutput(
            draft_path=draft_rel,
            published_path=pub_rel,
            mode=input_value.mode,
            bytes_written=int(bytes_written),
            approver_principal=token.approver_principal,
            token_id=token.token_id,
        )


def _move_file(source: Path, destination: Path) -> int:
    """Move *source* → *destination* and return the byte count written."""
    shutil.move(str(source), str(destination))
    return destination.stat().st_size


def _copy_file(source: Path, destination: Path) -> int:
    """Copy *source* → *destination* and return the byte count written."""
    shutil.copyfile(str(source), str(destination))
    return destination.stat().st_size


__all__ = [
    "AlembicRunner",
    "BrokerVerificationError",  # re-export for agent loop convenience
    "PublishDraftADRInput",
    "PublishDraftADROutput",
    "PublishDraftADRTool",
    "RunAlembicUpgradeInput",
    "RunAlembicUpgradeOutput",
    "RunAlembicUpgradeTool",
]
