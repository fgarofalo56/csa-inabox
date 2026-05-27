# cross-item-copilot — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/cross-item-copilot/new` (also reachable at `/copilot`)
**Fabric reference**: there is no direct Fabric equivalent — this is a Loom-native orchestrator across every wired Azure service
**Loom screenshot**: `temp/parity/cross-item-copilot-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `POST /api/copilot/orchestrate` | wired (SSE streamed) | — |
| Tool registry | 32 tools registered across 11 services |

The editor renders a 3-rail layout: left rail = sessions list, main = prompt textarea + Orchestrate button + live step stream, right rail = registered tools grouped by service. The tools right-rail shows real counts:

- ADF (2), ADX (3), APIM (3), Activator (2), Databricks (4), Fabric (3), Foundry (1), Lakehouse (3), Loom (2), Power BI (3), Synapse (6) — **32 tools total**

## Phase 3 — Loom-native (no Fabric reference)

| Element | Present? | Notes |
|---|---|---|
| Sessions list with active-session indicator | YES | — |
| Prompt input with multiline textarea | YES | — |
| Orchestrate button (fires SSE) | YES | — |
| Live step stream (each tool call as a card) | YES (per source) | — |
| Final answer card | YES | — |
| Tools right-rail grouped by service | YES (real counts) | — |
| Tool registry inspector (click a service group → see tool descriptions + schemas) | partial — accordion of tools, but no schema inspector | MAJOR |
| Conversation persistence across reloads | YES (sessions stored) | — |
| Cancel-in-flight | not tested live | — |
| Cost/token meter | NO | MAJOR |
| Per-tool latency annotations on step cards | not verified — would need a live Orchestrate run | — |

## Functional

- Orchestrate not exercised live in this validation pass (would require triggering Foundry / Cosmos / ADX / etc.)
- 32-tool registry is real (verified in DOM)
- Layout is the most polished of the AI/ML group

## Grade — **B**

This is the strongest editor in the AI/ML group. Real 32-tool registry across all wired services, real session persistence, real SSE streaming infrastructure. Missing tool-schema inspector + token/cost meter, but the core orchestrator pattern is built. **Grade B.**
