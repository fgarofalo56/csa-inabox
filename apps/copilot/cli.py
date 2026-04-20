"""Command-line interface for the CSA Copilot (Phase 0-1).

Two sub-commands::

    python -m apps.copilot.cli ingest [--root docs/] [--root examples/] [--dry-run]
    python -m apps.copilot.cli ask "How do I enable private endpoints?" [--show-citations]

The ingest command runs the corpus indexer.  The ask command runs the
grounded Q&A agent.  Both commands read configuration from environment
variables (``COPILOT_*``) via :class:`apps.copilot.config.CopilotSettings`.
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


# ---------------------------------------------------------------------------
# argparse wiring
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Build the top-level :class:`argparse.ArgumentParser`."""
    parser = argparse.ArgumentParser(
        prog="apps.copilot.cli",
        description=(
            "CSA Copilot CLI — ingest repo documentation and ask grounded "
            "questions against it (CSA-0008 Phase 0-1)."
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
    ask.set_defaults(func=_cli_ask)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for ``python -m apps.copilot.cli``.

    Returns the intended process exit code.  Refused answers return
    ``2`` so shell scripts can distinguish a clean refusal from a
    crash (``1``) or a normal answer (``0``).
    """
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
