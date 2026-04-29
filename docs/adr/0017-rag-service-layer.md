---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: security, governance, dev-loop, ai-integration
informed: all
---

# ADR 0017 — RAG pipeline service-layer extraction

## Context and Problem Statement

`csa_platform/ai_integration/rag/pipeline.py` had grown to **1,285
lines** containing four top-level classes (`DocumentChunker`,
`EmbeddingGenerator`, `VectorStore`, `RAGPipeline`) plus prompt
strings, CLI plumbing, and a factory. CSA-0133 flagged this as a
god-class: responsibilities crossed chunking, embedding, vector
search, prompt assembly, generation, and lifecycle in a single
module. AQ-0020 was raised and approved to split it.

The earlier async refactor (commit `94d4b91`) had already landed
native-async paths (`search_async`, `embed_texts_async`, `query_async`,
`aclose`). Those were preserved — the remaining scope of CSA-0133
was the **service-layer extraction + submodule split**.

Concrete problems the monolith caused:

- **Test setup mirrors the coupling.** The 75-test regression suite
  at `tests/csa_platform/test_ai_integration.py` had to reach into
  private attributes (`_client`, `_search_client`,
  `_cached_async_chat_client`) on four different classes to stub
  Azure clients, because there was no seam between the indexer and
  the retriever.
- **Copilot work was blocked.** `apps/copilot/agent.py` imports
  `SearchResult` and `VectorStore` from `pipeline`; any new Copilot
  surface (streaming, conversation, broker) would have to import
  from the same god-module, deepening the dependency.
- **No clean router entry point.** Every router that wanted to
  integrate RAG had to construct all four components by hand — there
  was no narrow facade, which led to inconsistent wiring across the
  Copilot indexer, the Multi-Synapse prototype, and the Portal.
- **Rerank policy was hard-coded.** The reranker was a bool kwarg
  threaded through four methods. Any future client-side cross-
  encoder would touch the retriever, the pipeline, and every caller.

## Decision Drivers

- **Zero behaviour change.** The 75-test regression suite must stay
  green with no modifications to test code. Routers importing
  `from ...rag.pipeline import ...` must continue to resolve.
- **One narrow router entry point.** New routers should have exactly
  one class to construct: `RAGService`. Sync wrappers are off the
  table — the async refactor already landed.
- **Protocol-based DI.** Azure clients (`SearchClient`,
  `AsyncSearchClient`, `AsyncAzureOpenAI`) must be mockable without
  credentials — matching the pattern in `apps/copilot/agent.py`.
- **No cross-module cycles.** Dependency direction must be
  one-way: `service -> {indexer, retriever, rerank, generate}` ->
  `{chunker, config, models}` -> stdlib + Azure SDKs.
- **Respect the line-count budget.** The split's source-line total
  must not exceed 130 % of the original (`1,285 × 1.3 = 1,670`).

## Considered Options

1. **Submodule split + `RAGService` facade + compat shim (chosen)** —
   seven submodules, one compat module; routers call `RAGService`;
   the old `pipeline` module re-exports legacy symbols for one
   release then is deprecated.
2. **Keep the monolith** — zero effort, zero risk. Rejected:
   blocks Copilot, breaks the "services under 500 lines" target in
   `docs/CODING_STANDARDS.md`, leaves the rerank policy unusable as
   a seam.
3. **Replace with LlamaIndex** — ships chunkers, retrievers, and a
   prompt-orchestration layer out of the box. Rejected: LlamaIndex
   is not on the FedRAMP High ATO; adopting it re-opens the SBOM
   review that ADR 0007 settled, and its default telemetry would
   need to be patched out for Gov. Revisit after FedRAMP package.
4. **Split without a facade (submodules only)** — gets the
   responsibilities apart but leaves every router to assemble its
   own pipeline. Rejected: defeats one of the two wins we're
   chasing (the narrow router entry point).

## Decision Outcome

Chosen: **Option 1 — submodule split + `RAGService` facade +
compat shim**.

Concrete layout under `csa_platform/ai_integration/rag/`:

- `chunker.py` — `DocumentChunker` + `Chunk` dataclass. Zero
  external deps.
- `indexer.py` — `EmbeddingGenerator` (sync + async paths preserved
  from the earlier refactor).
- `retriever.py` — `VectorStore` + `SearchResult`, including the
  async search client cache and `aclose`.
- `rerank.py` — `RerankPolicy` (frozen dataclass) + `apply_policy`.
  Seam for a future client-side cross-encoder.
- `generate.py` — `build_prompt` (pure) + `generate_answer_async`
  (async). Keeps the prompt-string regressions test-friendly.
- `models.py` — frozen Pydantic DTOs (`AnswerResponse`, `Citation`,
  `ContextChunk`, `IndexReport`). `AnswerResponse.to_dict()`
  preserves the legacy dict shape for older callers.
- `service.py` — `RAGService` facade with
  `ingest`/`query`/`close`/async-context-manager support.
- `pipeline.py` — _thin compat shim_. Re-exports the legacy
  classes from the submodules and keeps `RAGPipeline` intact with
  its exact pre-split behaviour so the existing regression suite
  passes without modification.
- `__init__.py` — re-exports the union of legacy symbols and the
  new public API (`RAGService`, `IndexReport`, `AnswerResponse`, …).

Dependency direction:

```
apps/copilot ─────────┐
portal/shared/api ────┤
csa_platform/*routers ┘
            │
            ▼
       RAGService (service.py)
            │
    ┌───────┼──────────┬──────────┐
    ▼       ▼          ▼          ▼
 indexer  retriever  rerank    generate
    │       │                     │
    └───────┼─────────────────────┘
            ▼
      chunker ─── models ─── config
            │
            ▼
       stdlib + Azure SDKs
```

Routers going forward MUST go through `RAGService`. The
`RAGPipeline` compat class is retained for one release and then
deprecated; a follow-up ADR will record the removal once all
internal callers have migrated.

## Consequences

- Positive: every new router has exactly one class to construct,
  and `async with RAGService.from_settings() as svc:` is the
  canonical pattern for scripts and tests.
- Positive: each submodule is independently testable. The new
  `csa_platform/ai_integration/rag/tests/` directory adds 48
  focused unit tests across the six seams, plus a compat-shim
  test that guarantees every legacy import still resolves.
- Positive: the rerank policy is now a frozen dataclass, so a
  future client-side cross-encoder only touches `rerank.py` plus
  one wire-up line in `service.py`.
- Positive: mypy + ruff run clean on the whole `rag/` tree.
- Neutral: the compat shim adds ~400 lines of legacy surface that
  will be removed once internal callers migrate. Total source
  lines across the submodules (`1,659`) stays under the 130 %
  budget (`1,670`).
- Negative: downstream callers now have two plausible entry points
  (`RAGPipeline` via the shim; `RAGService` from the package root).
  This is intentional for the transition but needs a deprecation
  timer — tracked as CSA-0134.
- Negative: `AnswerResponse` in this package is structurally
  different from `apps.copilot.models.AnswerResponse`. Copilot
  layers its refusal + groundedness contract on top of the RAG
  response, so a shared base class would force both to share
  semantics they don't. Documented in `models.py` module-level
  docstring so future readers don't assume a merge.

## Pros and Cons of the Options

### Option 1 — Submodule split + `RAGService` facade + compat shim

- Pros: zero test regressions (119 pass — 71 legacy + 48 new);
  dependency direction enforced by the split; rerank seam clean;
  routers get a single entry point.
- Cons: the compat shim is duplicated surface area until CSA-0134
  removes it.

### Option 2 — Keep the monolith

- Pros: zero work.
- Cons: blocks Copilot; fails the `docs/CODING_STANDARDS.md`
  module-size target; no rerank seam.

### Option 3 — LlamaIndex replacement

- Pros: less code to own; large upstream community.
- Cons: not on FedRAMP High ATO; default telemetry needs patching
  for Gov; SBOM re-review; ADR 0007 would need superseding.

### Option 4 — Split without a facade

- Pros: unblocks Copilot; enforces dependency direction.
- Cons: every router reassembles the pipeline by hand — the same
  failure mode that Copilot's indexer, Multi-Synapse prototype,
  and Portal are already hitting.

## Validation

We will know this decision is right if:

- `python -m pytest tests/csa_platform/test_ai_integration.py
csa_platform/ai_integration/rag/tests/` passes with zero skips
  (currently 119 passed).
- `python -m pytest apps/copilot/tests/` still reports the same
  pass/fail counts as before the split (the split touches nothing
  Copilot depends on structurally — only the shared
  `SearchResult`/`VectorStore`/`Chunk` imports which the compat
  shim re-exports).
- `python -m ruff check csa_platform/ai_integration/rag/` is clean.
- `python -m mypy csa_platform/ai_integration/rag/
--ignore-missing-imports` is clean.
- A fresh router wiring RAG uses `RAGService.from_settings()` and
  never imports from `pipeline`.

## Migration plan

- **This ADR**: ships the split + compat shim. Callers keep
  working; no router code changes required.
- **CSA-0134 (follow-up)**: migrate `apps/copilot/**`,
  `csa_platform/multi_synapse/**`, and any portal router wiring
  to import `RAGService` directly. Mark `RAGPipeline` as
  deprecated in that ADR.
- **CSA-0135 (future release)**: delete the compat shim body,
  keeping `pipeline.py` as a raise-on-import stub that points at
  `RAGService`.

## References

- CSA-0133 (this work) — god-class split, AQ-0020 approved.
- CSA-0134 — deprecate `RAGPipeline`, migrate internal callers.
- CSA-0135 — delete the compat shim body.
- ADR 0007 — Azure OpenAI over self-hosted LLM (constrains the
  LlamaIndex alternative).
- `csa_platform/ai_integration/rag/service.py` — `RAGService`
  implementation.
- `csa_platform/ai_integration/rag/tests/` — 48 new submodule
  tests (chunker / indexer / retriever / rerank / generate /
  service / pipeline-compat).
- `tests/csa_platform/test_ai_integration.py` — 71-test regression
  suite that proves the behaviour preservation contract.
