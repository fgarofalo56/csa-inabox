---
status: accepted
date: 2026-05-21
deciders: csa-inabox platform team, AI engineering
consulted: docs / DX, security, agents working group
informed: docs Copilot users, contributors
---

# ADR 0026 — Microsoft Learn MCP as External Grounding Source for the Copilot

## Context

The CSA-in-a-Box docs Copilot grounds answers in a tightly curated corpus (`docs/`, `examples/`, root-level guides). This produces high-quality, citation-bearing answers for questions that match the corpus — but the corpus deliberately does not duplicate Microsoft Azure's full reference documentation. Users routinely ask Azure-platform questions that the corpus does not cover end-to-end:

- "How do I configure ADLS Gen2 lifecycle management?"
- "What's the maximum partition key size in Azure Cosmos DB?"
- "How do I authenticate to Microsoft Graph from a service principal?"

Today the Copilot refuses these questions ("not enough grounded context"). That refusal is correct under the current policy but unhelpful — the canonical Microsoft documentation is publicly available, well-maintained, and trustworthy. We want the Copilot to be able to cite it directly.

Microsoft now hosts an official MCP server at <https://learn.microsoft.com/api/mcp> that exposes:

- `microsoft_docs_search` — semantic search over Microsoft Learn returning up to 10 high-quality chunks.
- `microsoft_docs_fetch` — fetch a full Microsoft Learn page as Markdown.
- `microsoft_code_sample_search` — search for code examples.

This is the natural integration point.

## Decision

Treat Microsoft Learn as a **secondary, external grounding source** that the Copilot may consult when the local corpus does not cover the question. Integrate it via the MS Learn MCP server using Streamable-HTTP transport, modelled as a read-class Copilot tool.

Phase the rollout:

1. **Phase 1 (this PR)** — Wire the tool, config, schema, and tests. Tool is opt-in via `COPILOT_MS_LEARN_ENABLED=true`. Default registry omits the tool unless the config flag is set, so existing deployments do not change behaviour.
2. **Phase 2** — Update the grounding policy to accept external chunks as evidence with distinct weighting (e.g., a higher similarity threshold or attribution-required formatting). Chat-widget UI surfaces external citations with a Microsoft Learn badge to make the source obvious.
3. **Phase 3** — Add the sibling MCP tools (`microsoft_docs_fetch`, `microsoft_code_sample_search`) once Phase 2 validates the integration.

## Architecture

### Tool surface

`apps/copilot/tools/ms_learn.py::SearchMicrosoftLearnTool` is a read-class tool that:

- Accepts `query` + `top_k` (capped by `ms_learn_max_results`).
- Calls `microsoft_docs_search` on the MCP server via the official `mcp` Python SDK's Streamable-HTTP client.
- Converts each hit into a `RetrievedChunk` with `doc_type="external"`, `metadata={title, url, source: "ms-learn"}`.
- Returns chunks ordered by reciprocal rank (MCP does not surface raw similarity scores).

### Config (env-driven, all `COPILOT_MS_LEARN_*` prefixed)

| Key | Default | Purpose |
|---|---|---|
| `COPILOT_MS_LEARN_ENABLED` | `false` | Master switch. When false, the tool is not registered. |
| `COPILOT_MS_LEARN_MCP_URL` | `https://learn.microsoft.com/api/mcp` | MCP endpoint. Override only for testing / proxying. |
| `COPILOT_MS_LEARN_REQUEST_TIMEOUT_SECONDS` | `20.0` | Per-call timeout. |
| `COPILOT_MS_LEARN_MAX_RESULTS` | `5` | Hard cap on chunks per call. |

### Grounding implications

Phase 1 introduces `doc_type="external"` into the `DocType` taxonomy but does **not** change the grounding policy. External chunks are returned to the agent as additional context, but the existing `min_grounded_chunks` gate still requires ≥ N **local** hits. Phase 2 will optionally count external chunks toward the gate with stricter quality criteria.

### Failure model

The tool is supplemental, not required. Network failures, timeouts, and MCP schema drift surface as `ToolInvocationError` rather than propagating. The agent loop catches the error, logs it as a degraded step, and continues with the local context it already retrieved.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Index a snapshot of Microsoft Learn into Azure AI Search alongside the local corpus.** | Snapshot goes stale immediately; doubling the index cost; rebuilding requires a custom Microsoft Learn export pipeline. |
| **Build a custom HTTP wrapper over the Microsoft Learn search REST API.** | The MCP server is the official, supported surface; building a parallel client invents technical debt and forfeits the standardised tool envelope. |
| **Embed direct LLM calls to a search-capable model (e.g., Bing Search API).** | Mixes search and generation; loses the deterministic citation surface the rest of the Copilot relies on; harder to attribute. |

## Consequences

**Positive**

- Copilot can answer Azure platform questions that the csa-inabox corpus doesn't cover, with citations linking to learn.microsoft.com.
- Zero indexing cost — external retrieval is live.
- Tool architecture stays uniform: MS Learn looks like any other read-class tool to the agent loop.
- Microsoft maintains the source; no need to track stale snapshots.

**Negative**

- Adds a network dependency on `learn.microsoft.com` to the answer path. Mitigated by timeout + supplemental-not-required failure model.
- External chunks have different quality characteristics from local docs; the grounding policy needs Phase-2 tuning to use them well.
- Phase 1 ships the tool but does not yet wire it into `default_registry` automatically when the flag is set — that wiring step is the first task in Phase 2 to avoid bundling behaviour changes with the tool addition itself.

## Related

- [ADR 0017 — RAG service layer](0017-rag-service-layer.md)
- [ADR 0022 — Copilot Surfaces vs Docs Widget](0022-copilot-surfaces-vs-docs-widget.md)
- Microsoft Learn MCP docs: <https://learn.microsoft.com/api/mcp>
- Implementation: `apps/copilot/tools/ms_learn.py`
- Tests: `apps/copilot/tests/test_tools_ms_learn.py`
