"""CSA Copilot (CSA-0008) — Phase 0-1 + CSA-0100/CSA-0102 agent surfaces.

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
* **CSA-0100 — Tool registry + agent loop** (:mod:`apps.copilot.tools`,
  :mod:`apps.copilot.agent_loop`): typed :class:`~apps.copilot.tools.base.Tool`
  protocol, :class:`~apps.copilot.tools.registry.ToolRegistry`, and a
  plan/act :class:`~apps.copilot.agent_loop.CopilotAgentLoop` that routes
  execute-class tools through the broker.
* **CSA-0102 — Confirmation broker** (:mod:`apps.copilot.broker`):
  HMAC-signed, single-use, TTL-bound ``ConfirmationToken`` primitives
  with a tamper-evident audit chain that reuses CSA-0016 hash primitives.

Deferred: decision-tree authoring UX (Phase 3), LLMOps (Phase 6),
streaming (Phase 5).  See ``apps/copilot/README.md``.
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
