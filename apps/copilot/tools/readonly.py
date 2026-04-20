"""Read-class tools for the Copilot agent loop (CSA-0100).

Every tool in this module is side-effect-free and safe for the agent
loop to invoke without a :class:`~apps.copilot.broker.models.ConfirmationToken`.
The four tools shipped here cover the research surface:

* :class:`SearchCorpusTool` — vector retrieval over the indexed corpus.
* :class:`WalkDecisionTreeTool` — walks a YAML decision tree under
  ``decision-trees/`` and returns the visited path.
* :class:`ReadRepoFileTool` — reads a single file from an allowlisted
  subset of the repo (``docs/adr``, ``docs/decisions``,
  ``docs/migrations`` and their neighbours).
* :class:`ValidateGateDryRunTool` — invokes a ``dev-loop/gates/*``
  validation script in a dry-run mode so the agent can reason about
  configuration without mutating anything.

All tools are constructed with explicit dependencies so tests can
substitute fake corpora, fake filesystems, and a fake subprocess
runner.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.agent import (
    SupportsAsyncEmbed,
    SupportsAsyncSearch,
    _search_result_to_retrieved_chunk,
)
from apps.copilot.models import DocType, RetrievedChunk
from apps.copilot.tools.base import ToolCategory, ToolInvocationError

# ---------------------------------------------------------------------------
# Allowlisted gate scripts + repo roots
# ---------------------------------------------------------------------------

# The read-class gate tool only invokes these scripts.  A gate that is
# not listed here is flat-out unavailable — we refuse to shell out to
# anything the agent could name dynamically.
ALLOWED_DRY_RUN_GATES: frozenset[str] = frozenset(
    {
        "validate-all",
        "validate-bicep",
        "validate-python",
        "validate-dbt",
        "validate-deployment",
    }
)

# Read tools may only open files under these repo-relative roots.
# Absolute paths and paths escaping these roots are rejected.
ALLOWED_READ_ROOTS: tuple[str, ...] = (
    "docs/adr",
    "docs/decisions",
    "docs/migrations",
    "docs/compliance",
    "docs/runbooks",
    "decision-trees",
    "docs",
)


# ---------------------------------------------------------------------------
# SearchCorpusTool
# ---------------------------------------------------------------------------


class SearchCorpusInput(BaseModel):
    """Input for :class:`SearchCorpusTool`."""

    query: str = Field(min_length=1, description="User question in natural language.")
    top_k: int = Field(default=5, ge=1, le=50, description="Maximum chunks to return.")

    model_config = ConfigDict(frozen=True)


class SearchCorpusOutput(BaseModel):
    """Output of :class:`SearchCorpusTool`."""

    chunks: list[RetrievedChunk] = Field(
        default_factory=list,
        description="Retrieved chunks ordered by retriever score.",
    )

    model_config = ConfigDict(frozen=True)


class SearchCorpusTool:
    """Retrieve grounded context chunks for a question.

    Thin wrapper over the retriever + embedder shared with
    :class:`apps.copilot.agent.CopilotAgent`.  The tool is idempotent
    and safe for repeated invocation inside a single plan.
    """

    name: str = "search_corpus"
    category: ToolCategory = "read"
    description: str = (
        "Search the indexed CSA-in-a-Box corpus (ADRs, runbooks, decision "
        "docs, examples) and return the top-k chunks most relevant to a "
        "natural-language question."
    )
    input_model: type[SearchCorpusInput] = SearchCorpusInput
    output_model: type[SearchCorpusOutput] = SearchCorpusOutput

    def __init__(
        self,
        *,
        retriever: SupportsAsyncSearch,
        embedder: SupportsAsyncEmbed,
    ) -> None:
        self.retriever = retriever
        self.embedder = embedder

    async def __call__(self, input_value: SearchCorpusInput) -> SearchCorpusOutput:
        embeddings = await self.embedder.embed_texts_async([input_value.query])
        query_vector = embeddings[0]
        raw = await self.retriever.search_async(
            query_vector=query_vector,
            query_text=input_value.query,
            top_k=input_value.top_k,
        )
        chunks = [_search_result_to_retrieved_chunk(r) for r in raw]
        return SearchCorpusOutput(chunks=chunks)


# ---------------------------------------------------------------------------
# WalkDecisionTreeTool
# ---------------------------------------------------------------------------


class WalkDecisionTreeInput(BaseModel):
    """Input for :class:`WalkDecisionTreeTool`."""

    tree_id: str = Field(min_length=1, description="Decision tree id (YAML filename stem).")
    choices: list[str] = Field(
        default_factory=list,
        description=(
            "Ordered labels chosen at each node. If the label does not match "
            "any option, the walker halts and returns the partial path."
        ),
    )

    model_config = ConfigDict(frozen=True)


class DecisionStep(BaseModel):
    """One step of a decision-tree walk."""

    node_id: str = Field(description="Id of the node visited.")
    question: str | None = Field(default=None, description="Question text if the node is branching.")
    recommendation: str | None = Field(default=None, description="Recommendation text for leaf nodes.")
    chosen_label: str | None = Field(default=None, description="Label selected to move forward.")

    model_config = ConfigDict(frozen=True)


class WalkDecisionTreeOutput(BaseModel):
    """Output of :class:`WalkDecisionTreeTool`."""

    tree_id: str = Field(description="Decision tree id that was walked.")
    title: str = Field(description="Tree title (from the YAML front matter).")
    path: list[DecisionStep] = Field(
        default_factory=list,
        description="Nodes visited, in traversal order.",
    )
    reached_leaf: bool = Field(description="True when the walk ended at a recommendation node.")
    final_recommendation: str | None = Field(
        default=None,
        description="Recommendation text from the terminal leaf, if any.",
    )
    unresolved_choice: str | None = Field(
        default=None,
        description=(
            "When the walk halts early because a provided choice does not "
            "match any option, this field carries the problematic label."
        ),
    )

    model_config = ConfigDict(frozen=True)


class WalkDecisionTreeTool:
    """Walk a YAML decision tree under ``decision-trees/``.

    The tool reads the YAML once per call (cheap — trees are <10KB)
    and walks it in-memory.  No caching is performed so tests can
    swap the tree directory cleanly.
    """

    name: str = "walk_decision_tree"
    category: ToolCategory = "read"
    description: str = (
        "Walk a YAML decision tree under decision-trees/ given a sequence of "
        "choice labels. Returns the path visited and the terminal recommendation."
    )
    input_model: type[WalkDecisionTreeInput] = WalkDecisionTreeInput
    output_model: type[WalkDecisionTreeOutput] = WalkDecisionTreeOutput

    def __init__(
        self,
        *,
        trees_root: Path,
    ) -> None:
        self.trees_root = Path(trees_root)

    async def __call__(self, input_value: WalkDecisionTreeInput) -> WalkDecisionTreeOutput:
        # Reject tree ids that attempt to escape the trees_root.
        if "/" in input_value.tree_id or "\\" in input_value.tree_id or input_value.tree_id.startswith("."):
            raise ToolInvocationError(
                f"Invalid tree_id {input_value.tree_id!r} — must be a bare filename stem.",
            )

        tree_path = self.trees_root / f"{input_value.tree_id}.yaml"
        if not tree_path.is_file():
            raise ToolInvocationError(
                f"Decision tree not found: {tree_path}",
            )

        # YAML parsing is synchronous; wrap in a thread so we stay
        # async-friendly for larger trees.
        data = await asyncio.to_thread(_safe_load_yaml, tree_path)
        nodes_by_id: dict[str, dict[str, Any]] = {
            node["id"]: node for node in data.get("nodes", []) if "id" in node
        }
        if "start" not in nodes_by_id:
            raise ToolInvocationError(
                f"Decision tree {input_value.tree_id!r} missing 'start' node.",
            )

        path: list[DecisionStep] = []
        current_id = "start"
        unresolved: str | None = None
        remaining_choices = list(input_value.choices)

        while True:
            node = nodes_by_id.get(current_id)
            if node is None:
                raise ToolInvocationError(
                    f"Decision tree {input_value.tree_id!r} references missing node {current_id!r}.",
                )

            if "recommendation" in node:
                path.append(
                    DecisionStep(
                        node_id=node["id"],
                        question=None,
                        recommendation=node.get("recommendation"),
                        chosen_label=None,
                    ),
                )
                return WalkDecisionTreeOutput(
                    tree_id=input_value.tree_id,
                    title=str(data.get("title", input_value.tree_id)),
                    path=path,
                    reached_leaf=True,
                    final_recommendation=node.get("recommendation"),
                    unresolved_choice=None,
                )

            # Branching node — pick the next choice (if any).
            if not remaining_choices:
                path.append(
                    DecisionStep(
                        node_id=node["id"],
                        question=node.get("question"),
                        recommendation=None,
                        chosen_label=None,
                    ),
                )
                return WalkDecisionTreeOutput(
                    tree_id=input_value.tree_id,
                    title=str(data.get("title", input_value.tree_id)),
                    path=path,
                    reached_leaf=False,
                    final_recommendation=None,
                    unresolved_choice=None,
                )

            chosen = remaining_choices.pop(0)
            options = node.get("options", []) or []
            match = next(
                (opt for opt in options if str(opt.get("label", "")).strip() == chosen.strip()),
                None,
            )
            if match is None:
                path.append(
                    DecisionStep(
                        node_id=node["id"],
                        question=node.get("question"),
                        recommendation=None,
                        chosen_label=None,
                    ),
                )
                unresolved = chosen
                return WalkDecisionTreeOutput(
                    tree_id=input_value.tree_id,
                    title=str(data.get("title", input_value.tree_id)),
                    path=path,
                    reached_leaf=False,
                    final_recommendation=None,
                    unresolved_choice=unresolved,
                )

            path.append(
                DecisionStep(
                    node_id=node["id"],
                    question=node.get("question"),
                    recommendation=None,
                    chosen_label=chosen,
                ),
            )
            next_id = match.get("next")
            if not next_id:
                raise ToolInvocationError(
                    f"Option {chosen!r} at node {current_id!r} has no 'next' pointer.",
                )
            current_id = str(next_id)


def _safe_load_yaml(path: Path) -> dict[str, Any]:
    """Load a YAML file with ``yaml.safe_load`` and validate it's a mapping."""
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise ToolInvocationError(f"YAML root in {path} is not a mapping.")
    return data


# ---------------------------------------------------------------------------
# ReadRepoFileTool
# ---------------------------------------------------------------------------


class ReadRepoFileInput(BaseModel):
    """Input for :class:`ReadRepoFileTool`."""

    path: str = Field(
        min_length=1,
        description=(
            "Repo-relative path under an allowlisted root "
            "(docs/adr, docs/decisions, docs/migrations, docs/compliance, "
            "docs/runbooks, decision-trees, docs)."
        ),
    )
    max_bytes: int = Field(
        default=64 * 1024,
        ge=1,
        le=1_048_576,
        description="Maximum bytes to return; files larger than this are truncated.",
    )

    model_config = ConfigDict(frozen=True)


class ReadRepoFileOutput(BaseModel):
    """Output of :class:`ReadRepoFileTool`."""

    path: str = Field(description="Repo-relative path that was read.")
    text: str = Field(description="UTF-8 decoded file contents (possibly truncated).")
    truncated: bool = Field(description="True when the file exceeded ``max_bytes``.")
    bytes_read: int = Field(ge=0, description="Number of bytes returned in ``text`` (UTF-8).")

    model_config = ConfigDict(frozen=True)


class ReadRepoFileTool:
    """Read a bounded text file from an allowlisted subset of the repo.

    The allowlist is deliberately narrow — the agent loop should only
    read design-time documents.  Requesting anything outside the
    allowlist raises :class:`ToolInvocationError` with an explicit
    reason (not a generic permission error, because the agent benefits
    from knowing *why* the read was refused).
    """

    name: str = "read_repo_file"
    category: ToolCategory = "read"
    description: str = (
        "Read a bounded text file from docs/adr, docs/decisions, docs/migrations, "
        "docs/compliance, docs/runbooks, decision-trees, or docs root. "
        "Returns up to max_bytes of UTF-8 text."
    )
    input_model: type[ReadRepoFileInput] = ReadRepoFileInput
    output_model: type[ReadRepoFileOutput] = ReadRepoFileOutput

    def __init__(
        self,
        *,
        repo_root: Path,
        allowed_roots: Sequence[str] = ALLOWED_READ_ROOTS,
    ) -> None:
        self.repo_root = Path(repo_root).resolve()
        self.allowed_roots = tuple(allowed_roots)

    async def __call__(self, input_value: ReadRepoFileInput) -> ReadRepoFileOutput:
        rel = input_value.path.strip().replace("\\", "/")
        if rel.startswith("/") or ".." in rel.split("/"):
            raise ToolInvocationError(
                f"Refusing to read {rel!r}: absolute or traversal paths are not allowed.",
            )

        # Enforce the allowlist on the repo-relative path prefix.
        if not any(rel == root or rel.startswith(root + "/") for root in self.allowed_roots):
            raise ToolInvocationError(
                f"Path {rel!r} is outside the read allowlist "
                f"({', '.join(self.allowed_roots)}).",
            )

        abs_path = (self.repo_root / rel).resolve()
        # Defence-in-depth: after resolving, confirm we are still
        # rooted under repo_root — protects against symlink abuse.
        try:
            abs_path.relative_to(self.repo_root)
        except ValueError as exc:
            raise ToolInvocationError(
                f"Path {rel!r} resolves outside the repo root.",
            ) from exc

        if not abs_path.is_file():
            raise ToolInvocationError(f"No file at {rel!r}.")

        raw = await asyncio.to_thread(abs_path.read_bytes)
        truncated = len(raw) > input_value.max_bytes
        clipped = raw[: input_value.max_bytes]
        text = clipped.decode("utf-8", errors="replace")
        return ReadRepoFileOutput(
            path=rel,
            text=text,
            truncated=truncated,
            bytes_read=len(clipped),
        )


# ---------------------------------------------------------------------------
# ValidateGateDryRunTool
# ---------------------------------------------------------------------------


GateName = Literal[
    "validate-all",
    "validate-bicep",
    "validate-python",
    "validate-dbt",
    "validate-deployment",
]


class ValidateGateDryRunInput(BaseModel):
    """Input for :class:`ValidateGateDryRunTool`."""

    gate: GateName = Field(description="Gate script stem under dev-loop/gates/.")
    environment: str = Field(
        default="dev",
        description="Environment label (forwarded to deployment gate; unused by others).",
    )

    model_config = ConfigDict(frozen=True)


class ValidateGateDryRunOutput(BaseModel):
    """Output of :class:`ValidateGateDryRunTool`."""

    gate: str = Field(description="Gate that was invoked.")
    mode: Literal["dry-run"] = Field(default="dry-run")
    exit_code: int = Field(description="Exit code returned by the gate.")
    stdout: str = Field(description="Captured stdout (may be empty).")
    stderr: str = Field(description="Captured stderr (may be empty).")
    invocation: list[str] = Field(
        description="Argv used; useful for audit records.",
    )
    skipped: bool = Field(
        default=False,
        description="True when the host lacks pwsh/powershell and the tool could not shell out.",
    )
    reason: str | None = Field(
        default=None,
        description="Populated when ``skipped=True`` to explain why.",
    )

    model_config = ConfigDict(frozen=True)


# Type alias for the injectable subprocess runner — makes tests easy.
ProcessRunner = Callable[[Sequence[str]], Awaitable[tuple[int, str, str]]]


class ValidateGateDryRunTool:
    """Run a ``dev-loop/gates/validate-*`` script in a read-only mode.

    The PowerShell gates in this repo do not have a uniform
    ``--dry-run`` switch; however, every gate short-circuits safely
    when its underlying tools (az CLI, dbt, bicep) are unavailable.
    This tool therefore runs each gate with ``-WhatIf`` *plus* a
    ``COPILOT_DRY_RUN=1`` environment variable so the gate can detect
    and short-circuit write operations.  When the host does not have
    PowerShell on PATH, the tool returns a :pyattr:`skipped=True`
    response rather than failing hard — the agent loop then falls
    back to reading the script via :class:`ReadRepoFileTool`.
    """

    name: str = "validate_gate_dry_run"
    category: ToolCategory = "read"
    description: str = (
        "Invoke a dev-loop/gates/validate-*.ps1 script in a read-only "
        "mode (-WhatIf + COPILOT_DRY_RUN=1). Never executes side-effects."
    )
    input_model: type[ValidateGateDryRunInput] = ValidateGateDryRunInput
    output_model: type[ValidateGateDryRunOutput] = ValidateGateDryRunOutput

    def __init__(
        self,
        *,
        repo_root: Path,
        runner: ProcessRunner | None = None,
        powershell: str | None = None,
    ) -> None:
        self.repo_root = Path(repo_root).resolve()
        self._runner = runner
        self._powershell = powershell

    def _resolve_powershell(self) -> str | None:
        """Return the first available PowerShell executable, or None."""
        if self._powershell:
            return self._powershell
        for candidate in ("pwsh", "powershell"):
            located = shutil.which(candidate)
            if located:
                return located
        return None

    async def __call__(self, input_value: ValidateGateDryRunInput) -> ValidateGateDryRunOutput:
        if input_value.gate not in ALLOWED_DRY_RUN_GATES:
            raise ToolInvocationError(
                f"Gate {input_value.gate!r} is not on the dry-run allowlist.",
            )

        script = self.repo_root / "dev-loop" / "gates" / f"{input_value.gate}.ps1"
        if not script.is_file():
            raise ToolInvocationError(f"Gate script not found: {script}")

        argv = [
            "",  # placeholder for the interpreter path
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-WhatIf",
        ]
        if input_value.gate == "validate-deployment":
            argv.extend(["-Environment", input_value.environment])

        runner = self._runner or _default_runner_factory(self._resolve_powershell())
        if runner is None:
            return ValidateGateDryRunOutput(
                gate=input_value.gate,
                exit_code=0,
                stdout="",
                stderr="",
                invocation=argv[1:],
                skipped=True,
                reason="PowerShell not available on host; skipped gate dry-run.",
            )

        pwsh_exec = self._resolve_powershell()
        if pwsh_exec:
            argv[0] = pwsh_exec
        else:
            # Custom runner supplied: let it interpret the argv list.
            argv[0] = "powershell"

        exit_code, stdout, stderr = await runner(argv)
        return ValidateGateDryRunOutput(
            gate=input_value.gate,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            invocation=argv,
            skipped=False,
        )


def _default_runner_factory(pwsh_exec: str | None) -> ProcessRunner | None:
    """Build the default asyncio-subprocess runner, or None if pwsh is missing."""
    if pwsh_exec is None:
        return None

    async def _run(argv: Sequence[str]) -> tuple[int, str, str]:
        # Carry the dry-run sentinel into the gate's environment so
        # the script can short-circuit any side-effect paths.
        env = os.environ.copy()
        env["COPILOT_DRY_RUN"] = "1"
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout_bytes, stderr_bytes = await proc.communicate()
        return (
            proc.returncode if proc.returncode is not None else -1,
            stdout_bytes.decode("utf-8", errors="replace"),
            stderr_bytes.decode("utf-8", errors="replace"),
        )

    return _run


# ---------------------------------------------------------------------------
# Convenience helpers
# ---------------------------------------------------------------------------


def _doc_type_for_path(rel: str) -> DocType:
    """Best-effort bucket a repo-relative path into a :class:`DocType`.

    Used by the read helpers to stamp a sensible doc-type without
    importing the full indexer classifier.
    """
    rel = rel.replace("\\", "/")
    if rel.startswith("docs/adr/"):
        return "adr"
    if rel.startswith(("docs/decisions/", "decision-trees/")):
        return "decision"
    if rel.startswith("docs/migrations/"):
        return "migration"
    if rel.startswith("docs/compliance/"):
        return "compliance"
    if rel.startswith("docs/runbooks/"):
        return "runbook"
    if rel.startswith("examples/"):
        return "example"
    return "overview"


__all__ = [
    "ALLOWED_DRY_RUN_GATES",
    "ALLOWED_READ_ROOTS",
    "DecisionStep",
    "ReadRepoFileInput",
    "ReadRepoFileOutput",
    "ReadRepoFileTool",
    "SearchCorpusInput",
    "SearchCorpusOutput",
    "SearchCorpusTool",
    "ValidateGateDryRunInput",
    "ValidateGateDryRunOutput",
    "ValidateGateDryRunTool",
    "WalkDecisionTreeInput",
    "WalkDecisionTreeOutput",
    "WalkDecisionTreeTool",
]
