"""Command-line interface for the CSA Copilot.

Sub-commands::

    python -m apps.copilot.cli ingest [--root docs/] [--root examples/] [--dry-run]
    python -m apps.copilot.cli ask "How do I enable private endpoints?" [--show-citations]
    python -m apps.copilot.cli ask "..." --stream                    # post-Phase-1 streaming
    python -m apps.copilot.cli ask "..." --with-tools               # CSA-0100 agent loop
    python -m apps.copilot.cli chat                                  # post-Phase-1 REPL
    python -m apps.copilot.cli tools list                           # CSA-0100 tool catalogue
    python -m apps.copilot.cli broker approve <token_id> [--approver ...]

The ingest and ask commands run the grounded Q&A pipeline from Phase
0-1.  The ``tools`` command enumerates the CSA-0100 tool registry.
The ``broker`` command surfaces the CSA-0102 approval loop so
operators can approve tokens out-of-band.  The ``chat`` command drives
a multi-turn REPL over the grounded Q&A pipeline.

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
from apps.copilot.models import AnswerChunk, AnswerResponse, Citation, IndexReport


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

    if args.stream:
        return asyncio.run(_run_ask_stream(agent, args))

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


async def _run_ask_stream(agent: CopilotAgent, args: argparse.Namespace) -> int:
    """Drive :meth:`CopilotAgent.ask_stream` and render to stdout.

    Status events are rendered as bracketed markers on stderr so they
    do not contaminate stdout piping; tokens flow to stdout verbatim;
    the terminal ``done`` event is summarised as either a
    groundedness line or a refusal line.  JSON mode (``--json``)
    serialises each :class:`AnswerChunk` as one JSON-lines record.
    """
    final: AnswerResponse | None = None
    collected_citations: list[Citation] = []
    any_token = False

    async for event in agent.ask_stream(args.question):
        if args.json:
            sys.stdout.write(_stream_event_to_jsonline(event))
            sys.stdout.write("\n")
            sys.stdout.flush()
        else:
            _render_stream_event_human(event)

        if event.kind == "citation" and isinstance(event.payload, Citation):
            collected_citations.append(event.payload)
        if event.kind == "token":
            any_token = True
        if event.kind == "done" and isinstance(event.payload, AnswerResponse):
            final = event.payload

    if final is None:
        # Streams MUST terminate with a done event; anything else is a bug.
        sys.stderr.write("[stream]: terminated without done event\n")
        return 1

    if args.json:
        return 0 if not final.refused else 2

    if final.refused:
        sys.stderr.write(
            f"\nREFUSED ({final.refusal_reason}): {final.answer}\n",
        )
        return 2

    if not any_token:
        # Fallback pretty-print when the LLM backend did not emit deltas.
        sys.stdout.write(final.answer)
    sys.stdout.write("\n")
    if args.show_citations and collected_citations:
        sys.stdout.write("\n--- Citations ---\n")
        for c in collected_citations:
            sys.stdout.write(
                f"[{c.id}] {c.source_path}  (sim={c.similarity:.2f})\n"
                f"    {c.excerpt}\n",
            )
    sys.stdout.write(f"\n(groundedness={final.groundedness:.2f})\n")
    return 0


def _stream_event_to_jsonline(event: AnswerChunk) -> str:
    """Serialise a streaming event to a single JSON line.

    ``Citation`` / ``AnswerResponse`` payloads are expanded via
    ``model_dump(mode='json')`` so the consumer gets a flat record.
    """
    payload_json: object
    if isinstance(event.payload, (Citation, AnswerResponse)):
        payload_json = event.payload.model_dump(mode="json")
    else:
        payload_json = event.payload  # str
    return json.dumps({"kind": event.kind, "payload": payload_json})


def _render_stream_event_human(event: AnswerChunk) -> None:
    """Pretty-print one streaming event to stdout/stderr."""
    if event.kind == "status":
        sys.stderr.write(f"[{event.payload}]\n")
        sys.stderr.flush()
        return
    if event.kind == "token":
        if isinstance(event.payload, str):
            sys.stdout.write(event.payload)
            sys.stdout.flush()
        return
    if event.kind == "citation":
        # Citations are collected and printed after the final token
        # so they appear together; we emit a short indicator here.
        if isinstance(event.payload, Citation):
            sys.stderr.write(f"[citation {event.payload.id}]\n")
            sys.stderr.flush()
        return
    if event.kind == "done":
        # ``done`` is handled by the caller so it can short-circuit
        # JSON vs human mode. Intentional no-op here.
        return


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
# chat sub-command (post-Phase-1)
# ---------------------------------------------------------------------------


def _cli_chat(args: argparse.Namespace) -> int:
    """Interactive multi-turn REPL over :meth:`CopilotAgent.ask_in_conversation`.

    Commands honoured by the REPL:

    * ``/reset`` — start a new conversation (prior turns forgotten).
    * ``/exit`` or empty EOF — quit.

    Agent replies are streamed by default so tokens appear as soon as
    the LLM produces them; pass ``--no-stream`` to fall back to the
    blocking path.
    """
    settings = _build_settings()
    agent = CopilotAgent.from_settings(settings)
    return asyncio.run(_run_chat(agent, stream=not args.no_stream))


async def _run_chat(agent: CopilotAgent, *, stream: bool) -> int:
    """Async body of the ``chat`` sub-command.

    Uses synchronous ``input()`` behind :func:`asyncio.to_thread` so
    the coroutine remains cooperative with the agent's async I/O.
    """
    sys.stdout.write(
        "CSA Copilot chat. Type /reset to start over, /exit to quit.\n",
    )
    sys.stdout.flush()

    handle = await agent.start_conversation()

    while True:
        try:
            line = await asyncio.to_thread(input, "you> ")
        except EOFError:
            sys.stdout.write("\n")
            return 0
        except KeyboardInterrupt:
            sys.stdout.write("\n")
            return 130

        if not line or not line.strip():
            continue

        command = line.strip()
        if command == "/exit":
            return 0
        if command == "/reset":
            await agent.reset_conversation(handle)
            handle = await agent.start_conversation()
            sys.stdout.write("[conversation reset]\n")
            continue

        # Drive a single turn.
        if stream:
            # Capture the prior summary, then stream. We use
            # ask_stream for deltas but still record the turn via
            # ask_in_conversation's store update logic; to keep a
            # single source of truth we drive ask_in_conversation and
            # accept it is blocking. For user-facing token streaming
            # during chat we run ask_stream with manual context from
            # the conversation state.
            state = await agent.conversation_store.get(handle.conversation_id)
            context = agent.summarizer.condense(state) if state else ""

            sys.stdout.write("copilot> ")
            sys.stdout.flush()
            final: AnswerResponse | None = None
            async for event in agent.ask_stream(command, extra_context=context):
                if event.kind == "token" and isinstance(event.payload, str):
                    sys.stdout.write(event.payload)
                    sys.stdout.flush()
                elif event.kind == "status" and isinstance(event.payload, str):
                    # Show refusals inline; hide the mundane lifecycle
                    # statuses in REPL mode.
                    if event.payload.startswith("refused:"):
                        sys.stderr.write(f"[{event.payload}]\n")
                elif event.kind == "done" and isinstance(event.payload, AnswerResponse):
                    final = event.payload

            sys.stdout.write("\n")
            if final is None:
                sys.stderr.write("[stream terminated abnormally]\n")
                continue

            # Persist the turn to the conversation store so the next
            # turn has history. Replicates the store update done by
            # ask_in_conversation without re-running the pipeline.
            from apps.copilot.conversation import approx_token_count
            from apps.copilot.models import ConversationTurn

            state = await agent.conversation_store.get(handle.conversation_id)
            if state is not None:
                new_turn = ConversationTurn(
                    turn_index=len(state.turns),
                    question=command,
                    answer=final.answer,
                    refused=final.refused,
                    refusal_reason=final.refusal_reason,
                    approx_tokens=(
                        approx_token_count(command) + approx_token_count(final.answer)
                    ),
                )
                updated = state.with_turn_appended(
                    new_turn,
                    max_turns=agent.settings.conversation_max_turns,
                    max_history_tokens=agent.settings.conversation_max_history_tokens,
                )
                await agent.conversation_store.set(
                    updated,
                    ttl_seconds=agent.conversation_ttl_seconds,
                )
        else:
            response = await agent.ask_in_conversation(handle, command)
            if response.refused:
                sys.stdout.write(
                    f"copilot> REFUSED ({response.refusal_reason}): {response.answer}\n",
                )
            else:
                sys.stdout.write(f"copilot> {response.answer}\n")
            sys.stdout.flush()


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
    ask.add_argument(
        "--stream",
        action="store_true",
        help=(
            "Stream tokens as they arrive from the LLM. Status events go "
            "to stderr; tokens go to stdout. Default is the blocking path."
        ),
    )
    ask.set_defaults(func=_cli_ask)

    # chat sub-command
    chat = sub.add_parser(
        "chat",
        help="Multi-turn REPL over the grounded Q&A pipeline.",
    )
    chat.add_argument(
        "--no-stream",
        action="store_true",
        help="Disable token streaming in the REPL (block until the full reply).",
    )
    chat.set_defaults(func=_cli_chat)

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
