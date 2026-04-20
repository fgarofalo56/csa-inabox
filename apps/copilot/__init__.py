"""CSA Copilot (CSA-0008) — Phase 0-1.

Phases shipped:

* **Phase 0 — Corpus Indexer** (:mod:`apps.copilot.indexer`): walks repo
  documentation (``docs/``, ADRs, decisions, runbooks, ``examples/*/README.md``,
  top-level markdown) → chunk → embed → upsert into Azure AI Search with
  document-type metadata.
* **Phase 1 — Grounding + Citations** (:mod:`apps.copilot.agent` and
  :mod:`apps.copilot.grounding`): retrieves top-k chunks, enforces a refusal
  contract when coverage falls below threshold, generates an answer with
  PydanticAI, and verifies that every cited chunk appeared in the retrieved
  set.

Phases 2-5 (decision-tree walker, skill catalog, gated execute broker,
four surfaces, LLMOps) are intentionally **out of scope** for this
session — see ``apps/copilot/README.md`` for the full roadmap.
"""

from __future__ import annotations

from apps.copilot.config import CopilotSettings
from apps.copilot.grounding import (
    Coverage,
    GroundingPolicy,
    evaluate_coverage,
    verify_citations,
)
from apps.copilot.models import (
    AnswerResponse,
    Citation,
    CitationVerificationResult,
    IndexReport,
    RetrievedChunk,
)

__all__ = [
    "AnswerResponse",
    "Citation",
    "CitationVerificationResult",
    "CopilotSettings",
    "Coverage",
    "GroundingPolicy",
    "IndexReport",
    "RetrievedChunk",
    "evaluate_coverage",
    "verify_citations",
]
