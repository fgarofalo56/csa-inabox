"""Command-line interface for the CSA Copilot.

Sub-commands::

    python -m apps.copilot.cli ingest [--root docs/] [--root examples/] [--dry-run]
    python -m apps.copilot.cli ask "How do I enable private endpoints?" [--show-citations]
    python -m apps.copilot.cli ask "..." --with-tools               # CSA-0100 agent loop
    python -m apps.copilot.cli tools list                           # CSA-0100 tool catalogue
    python -m apps.copilot.cli broker approve <token_id> [--approver ...]

The ingest and ask commands run the grounded Q&A pipeline from Phase
0-1.  The ``tools`` command enumerates the CSA-0100 tool registry.
The ``broker`` command surfaces the CSA-0102 approval loop so
operators can approve tokens out-of-band.

All commands read configuration from environment variables
(``COPILOT_*``) via :class:`apps.copilot.config.CopilotSettings`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from apps.copilot.agent import CopilotAgent
from apps.copilot.config import CopilotSettings
from apps.copilot.indexer import CorpusIndexer
from apps.copilot.models import AnswerResponse, IndexReport


def _repo_root() -> Path:
    """Return the repository root (three levels up from this file)."""
    return Path(__file__).resolve().parents[2]


def _build_settings() -> CopilotSettings:
    """Instantiate :class:`CopilotSettings` from environment variables."""
    return CopilotSettings()


# ---------------------------------------------------------------------------
# ingest sub-command
# ---------------------------------------------------------------------------


def _cli_ingest(args: argparse.Namespace) -> int:
    """Execute the ``ingest`` sub-command."""
    settings = _build_settings()
    indexer = CorpusIndexer(settings=settings, repo_root=_repo_root())

    roots: list[Path] | None = None
    if args.root:
        roots = [Path(r) for r in args.root]

    report: IndexReport = indexer.index(
        roots=roots,
        dry_run=args.dry_run,
        ensure_index=not args.dry_run,
    )

    payload = report.model_dump()
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(
            "files_scanned  = {files_scanned}\n"
            "chunks_indexed = {chunks_indexed}\n"
            "chunks_skipped = {chunks_skipped}\n"
            "bytes_embedded = {bytes_embedded}\n"
            "elapsed_seconds= {elapsed_seconds}\n"
            "doc_type_counts= {doc_type_counts}".format(**payload),
        )
    return 0


# ---------------------------------------------------------------------------
# ask sub-command
# ---------------------------------------------------------------------------


def _cli_ask(args: argparse.Namespace) -> int:
    """Execute the ``ask`` sub-command."""
    settings = _build_settings()

    if args.with_tools:
        return _cli_ask_with_tools(args, settings)

    agent = CopilotAgent.from_settings(settings)
    response: AnswerResponse = asyncio.run(agent.ask(args.question))

    payload = response.model_dump()
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0 if not response.refused else 2

    # Human-friendly formatting.
    if response.refused:
        print(f"REFUSED ({response.refusal_reason}): {response.answer}")
        return 2

    print(response.answer)
    if args.show_citations and response.citations:
        print("\n--- Citations ---")
        for c in response.citations:
            print(f"[{c.id}] {c.source_path}  (sim={c.similarity:.2f})")
            print(f"    {c.excerpt}")
    print(f"\n(groundedness={response.groundedness:.2f})")
    return 0


def _cli_ask_with_tools(args: argparse.Namespace, _settings: CopilotSettings) -> int:
    """``ask --with-tools`` — engage :class:`CopilotAgentLoop` (CSA-0100).

    The loop is Phase 2+ and requires a planner.  When the harness
    does not yet provide a production planner, we surface a clear
    refusal explaining what is missing rather than crashing.
    """
    # Import lazily so the simple CLI paths stay cheap.
    from apps.copilot.agent_loop import CopilotAgentLoop  # noqa: F401

    message = (
        "The --with-tools surface requires a configured planner. The default "
        "factory is not yet wired for CLI use; see apps/copilot/README.md "
        "for how to build a CopilotAgentLoop from code. This CLI flag "
        "currently prints this notice and exits 3 (unimplemented)."
    )
    if args.json:
        print(json.dumps({"question": args.question, "status": "unimplemented", "message": message}))
    else:
        print(f"UNAVAILABLE: {message}")
    # Keep deterministic exit codes: 0 answer, 2 refusal, 3 for
    # "feature present but not wired".  Shell scripts depending on
    # the Phase-1 codes remain unaffected.
    return 3


# ---------------------------------------------------------------------------
# tools sub-command (CSA-0100)
# ---------------------------------------------------------------------------


def _cli_tools_list(args: argparse.Namespace) -> int:
    """``tools list`` — print the default tool catalogue.

    The default catalogue is intentionally pared-back for CLI use —
    it builds the read tools plus the execute tools wired against an
    **in-memory** broker that has no signing key.  The listing therefore
    serves as a discovery surface; invoking an execute tool without a
    signing key raises :class:`MissingSigningKeyError`.
    """
    from apps.copilot.tools.readonly import (
        ReadRepoFileTool,
        SearchCorpusTool,
        ValidateGateDryRunTool,
        WalkDecisionTreeTool,
    )
    from apps.copilot.tools.registry import ToolRegistry

    # Stub retriever/embedder keep CLI imports cheap — listing does
    # not invoke the tools.
    from csa_platform.ai_integration.rag.pipeline import SearchResult

    class _NullEmbedder:
        async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
            return [[0.0] for _ in texts]

    class _NullRetriever:
        async def search_async(
            self,
            query_vector: list[float],  # noqa: ARG002
            query_text: str = "",  # noqa: ARG002
            top_k: int = 5,  # noqa: ARG002
            score_threshold: float = 0.0,  # noqa: ARG002
            filters: str | None = None,  # noqa: ARG002
            use_semantic_reranker: bool = False,  # noqa: ARG002
        ) -> list[SearchResult]:
            return []

    repo_root = _repo_root()
    registry = ToolRegistry()
    registry.register(
        SearchCorpusTool(retriever=_NullRetriever(), embedder=_NullEmbedder()),
    )
    registry.register(
        WalkDecisionTreeTool(trees_root=repo_root / "decision-trees"),
    )
    registry.register(ReadRepoFileTool(repo_root=repo_root))
    registry.register(ValidateGateDryRunTool(repo_root=repo_root))

    # Execute tools require a broker; we list their metadata by
    # constructing lightweight spec objects rather than full tools.
    from apps.copilot.broker.broker import ConfirmationBroker
    from apps.copilot.config import CopilotSettings
    from apps.copilot.tools.execute import (
        PublishDraftADRTool,
        RunAlembicUpgradeTool,
    )

    # Use a non-empty signing key so construction succeeds — no tokens
    # are minted here; we only enumerate metadata.
    exec_settings = CopilotSettings(broker_signing_key="cli-listing-only")
    broker = ConfirmationBroker(exec_settings)

    async def _null_alembic(_: object) -> tuple[int, str, str]:
        return (0, "", "")

    registry.register(RunAlembicUpgradeTool(broker=broker, runner=_null_alembic))
    registry.register(PublishDraftADRTool(broker=broker, repo_root=repo_root))

    specs = registry.list_tools()

    if args.json:
        print(json.dumps([s.model_dump(mode="json") for s in specs], indent=2, sort_keys=True))
        return 0

    # Plain text table.
    print(f"{'NAME':<28} {'CATEGORY':<10} DESCRIPTION")
    print("-" * 88)
    for s in specs:
        print(f"{s.name:<28} {s.category:<10} {s.description}")
    return 0


# ---------------------------------------------------------------------------
# broker sub-command (CSA-0102)
# ---------------------------------------------------------------------------


def _cli_broker_approve(args: argparse.Namespace) -> int:
    """``broker approve`` — approval stub for operator workflows.

    A fully persistent broker is Phase 5+ work; the process-local
    broker used in tests does not survive across CLI invocations.
    This command therefore prints a machine-readable notice with the
    inputs, so operators can verify their parameters before calling
    the broker programmatically.
    """
    payload = {
        "request_id": args.token_id,
        "approver_principal": args.approver,
        "status": "unimplemented",
        "message": (
            "The in-process ConfirmationBroker does not persist pending "
            "requests across CLI invocations. Call "
            "ConfirmationBroker.approve() from a long-running service. "
            "This command echoes its arguments for audit and exits 3."
        ),
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 3


# ---------------------------------------------------------------------------
# argparse wiring
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Build the top-level :class:`argparse.ArgumentParser`."""
    parser = argparse.ArgumentParser(
        prog="apps.copilot.cli",
        description=(
            "CSA Copilot CLI — ingest repo documentation, ask grounded "
            "questions, enumerate tools, and approve broker tokens."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    ingest = sub.add_parser(
        "ingest",
        help="Walk the corpus, chunk, embed, and upsert into Azure AI Search.",
    )
    ingest.add_argument(
        "--root",
        action="append",
        default=None,
        help=(
            "Repo-relative corpus root to scan. Repeat to add multiple "
            "roots. If omitted, uses COPILOT_CORPUS_ROOTS / defaults."
        ),
    )
    ingest.add_argument(
        "--dry-run",
        action="store_true",
        help="Walk + chunk only; skip embedding and Azure AI Search upsert.",
    )
    ingest.add_argument(
        "--json",
        action="store_true",
        help="Emit the IndexReport as JSON on stdout.",
    )
    ingest.set_defaults(func=_cli_ingest)

    ask = sub.add_parser(
        "ask",
        help="Run the grounded Q&A agent against the indexed corpus.",
    )
    ask.add_argument(
        "question",
        help="Natural-language question about the CSA-in-a-Box platform.",
    )
    ask.add_argument(
        "--show-citations",
        action="store_true",
        help="Print each citation below the answer.",
    )
    ask.add_argument(
        "--json",
        action="store_true",
        help="Emit the AnswerResponse as JSON on stdout.",
    )
    ask.add_argument(
        "--with-tools",
        action="store_true",
        help="Engage the CSA-0100 CopilotAgentLoop (plan/act over the tool registry).",
    )
    ask.set_defaults(func=_cli_ask)

    # tools sub-command
    tools = sub.add_parser(
        "tools",
        help="CSA-0100 tool registry operations.",
    )
    tools_sub = tools.add_subparsers(dest="tools_command", required=True)
    tools_list = tools_sub.add_parser(
        "list",
        help="List every tool registered in the default catalogue.",
    )
    tools_list.add_argument(
        "--json",
        action="store_true",
        help="Emit the catalogue as JSON on stdout.",
    )
    tools_list.set_defaults(func=_cli_tools_list)

    # broker sub-command
    broker = sub.add_parser(
        "broker",
        help="CSA-0102 confirmation broker operator commands.",
    )
    broker_sub = broker.add_subparsers(dest="broker_command", required=True)
    broker_approve = broker_sub.add_parser(
        "approve",
        help="Approve a pending confirmation request by id.",
    )
    broker_approve.add_argument("token_id", help="Pending request id to approve.")
    broker_approve.add_argument(
        "--approver",
        default="operator",
        help="Principal approving the request (default: 'operator').",
    )
    broker_approve.set_defaults(func=_cli_broker_approve)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for ``python -m apps.copilot.cli``.

    Returns the intended process exit code.  Refused answers return
    ``2`` so shell scripts can distinguish a clean refusal from a
    crash (``1``) or a normal answer (``0``).  Commands that are
    implemented but require additional wiring return ``3``.
    """
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
