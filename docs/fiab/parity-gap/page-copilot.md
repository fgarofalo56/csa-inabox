# Parity gap — `/copilot`

**Loom route:** `/copilot` (renders `CopilotConsoleView` from `lib/editors/cross-item-copilot-editor.tsx`)
**Fabric reference:** Fabric Copilot — https://learn.microsoft.com/fabric/get-started/copilot-fabric-overview (full-screen Copilot experience, multi-source grounding, tool-using)
**Loom screenshot:** `temp/parity/page-copilot-loom.png`
**Captured:** 2026-05-26 — 32 tools registered across 11 service categories

## Phase 3 — Side-by-side gap matrix

| # | Fabric Copilot full-screen element | Loom Copilot element | Status | Severity |
|---|---|---|---|---|
| 1 | Page header "Copilot" | "Loom Copilot" with subtitle "Orchestrate across every wired service from a single natural-language prompt" | present | — |
| 2 | Session list / "+ New session" | Present — "Sessions" panel with "+ New session" button, "No sessions yet" empty state | present | — |
| 3 | Tool palette showing capabilities | "Tools (32)" panel grouped by service: ADF (2), ADX (3), APIM (3), Activator (2), Databricks (4), Fabric (3), Foundry (1), Lakehouse (3), Loom (2), Power BI (3), Synapse (6) | present + **richer than Fabric** | — |
| 4 | Prompt input with rich attachments | Prompt input present | present | — |
| 5 | Streaming response with citations | SSE streaming from `/api/copilot/orchestrate` — verified in source | present | — |
| 6 | Tool-use trace (what tools were called, what they returned) | `OrchestratorStep` event types in source — full step-by-step trace | present | — |
| 7 | "Sources" panel showing grounding context | Per tool category in palette | partial — no per-prompt sources panel | MINOR |
| 8 | "Pin to canvas" / save snippet | Not visible | missing | MINOR |
| 9 | Honest gate when AOAI not deployed | Source: 503 with deep-link CTA when `resolveAoaiTarget()` throws `NoAoaiDeploymentError` | present + honest | — |
| 10 | Citation rendering with source link | `citations` rendering supported per cross-item-copilot-editor | present | — |
| 11 | Multi-turn conversation memory | Sessions persisted via `/api/copilot/sessions` | present | — |
| 12 | Stop / Cancel button during streaming | Not verified — would need live LLM call | unknown | — |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Prompt input + Send | POSTs to `/api/copilot/orchestrate` with SSE response stream | OK — real |
| Session list | GET `/api/copilot/sessions` — real Cosmos | OK |
| Tools list | GET `/api/copilot/tools` returns 32 registered tools — verified live | OK |
| AOAI gate | Pre-flight `resolveAoaiTarget()` → if `NoAoaiDeploymentError` returns 503 so UI can show deep-link CTA | OK — honest |
| Session history | GET `/api/copilot/sessions/[id]` loads prior messages | OK |
| Streaming | ReadableStream + SSE events of `OrchestratorStep` per source | OK technically — needs live test for E2E |

## Backend reality check

```typescript
// apps/fiab-console/app/api/copilot/orchestrate/route.ts
const stream = new ReadableStream({
  async start(controller) {
    const send = (event: string, data: unknown) => { /* SSE format */ };
    // Stream OrchestratorStep events from the orchestrator
    await orchestrate({ prompt, userOid, ... });
  },
});
```

Real SSE streaming, real AOAI orchestrator via `@/lib/azure/copilot-orchestrator`, honest 503 with deep-link when AOAI deployment is missing. 32 tools registered.

## Honest grade

**Grade: A-**

Reasoning:
- Phase 3: 0 BLOCKER, 0 MAJOR, 2 MINOR (no per-prompt sources panel, no pin-snippet).
- Phase 4: 0 BROKEN — every visible control wires to real backend with honest gates.
- 32 tools registered across 11 categories is a sophisticated orchestrator surface.
- Session persistence is real (Cosmos-backed).
- Streaming is real SSE.

Not A+ because:
- Live LLM streaming wasn't end-to-end exercised in this validation (would need live AOAI deploy + a real prompt; that's a separate functional test).
- Stop / Cancel during streaming not verified.
- No "Sources" panel showing what tools were called per prompt (the trace is per-step but not aggregated into a "Sources" view).

**This is the highest-quality top-level surface in CSA Loom.**

## Recommended next actions

1. Add per-prompt "Sources" panel summarizing which tools fired (already in step trace, just needs aggregation).
2. Add Stop button during streaming (cancellation via AbortController on the SSE stream).
3. Add "Pin to canvas" / save snippet (would persist a snippet doc + show in `/browse` pinned).
4. Verify Stop/Cancel functionally with a live AOAI deploy.
5. Surface the 32-tool list as a searchable command palette inside the Copilot view.
