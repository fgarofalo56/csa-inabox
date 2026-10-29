# ADR-001 — The plane is a control plane; APIM stays the runtime

**Status:** Proposed 2026-10-28; accepted when W1 ships.
**Mosaic lineage:** ADR 0001 (apim-runtime-boundary), partially superseded by
0010 for writes — adopted as-is.

## Context

Loom's console already calls Azure OpenAI directly or through the
bicep-authored APIM gateway (`LOOM_AOAI_VIA_APIM`, `aoai-apim-gateway.ts`).
Issue #3777 proposes a BFF-internal model router for Loom's own features.
Mosaic's first decision is that the governance product must never become an
availability dependency for model traffic.

## Decision

1. The plane stores desired governance state in Cosmos, mirrors observed
   gateway state, produces deterministic plans, applies them to API Management
   only after review, and reads telemetry from Log Analytics.
2. No request from a caller to a model or MCP server passes through the
   console or the worker job. Callers → APIM → backend.
3. APIM remains authoritative for runtime configuration; a Cosmos write is
   never treated as applied. Drift and partial failure are handled by
   re-planning, never by assuming.
4. Loom's own AI traffic (#4442) follows the same rule: the console is a
   *caller* with a grant, not a hop.

## Consequences

- The plane cannot take model traffic down; an outage of the console leaves
  every governed API serving.
- Everything the plane enforces must be expressible as APIM policy, backends,
  named values and subscriptions. Where APIM cannot express a control (e.g.
  token limits on a classic tier for the Anthropic shape), the plane refuses
  or labels, it does not interpose.
- Usage is read after the fact (minutes), so limits are enforced by the
  gateway at call time while views lag.
- #3777's router, if built, is a caller of the plane's governed endpoints,
  not an alternative to them.

## Alternatives rejected

- A console-side proxy (would make the console an availability dependency,
  and would hide traffic from APIM's own telemetry and policies).
- Writing to APIM on save (no review, no digest, no rollback; Mosaic rejected
  it too).

## Verification

A network trace of a governed call shows no console or job hop; stopping the
console leaves `verify-model-access.mjs` green on the estate.
