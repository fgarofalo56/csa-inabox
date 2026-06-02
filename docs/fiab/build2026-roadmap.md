# Build 2026 → CSA Loom adoption roadmap

Research across the Build 2026 announcements (12 agents, grounded in each page +
the repo). Relevance to CSA Loom (a Fabric-in-a-Box data/AI/governance console).

| Announcement | Loom relevance |
|---|---|
| Fabric + Databases agentic (Rayfin, HorizonDB, Fabric IQ, GPU DW) | **high** |
| Cosmos DB semantic reranker (NoSQL) | **high** |
| Azure API Management (AI gateway, MCP, LLM policies) | **high** |
| Azure Functions (MCP tool host) | **high** |
| Build keynote / Microsoft IQ (Foundry IQ, hosted agents) | **high** |
| Cosmos DB agent-memory + agentic-retrieval toolkits | medium |
| Azure Logic Apps (agent loops, MCP) | medium |
| Azure PostgreSQL (security/analytics; pgvector/azure_ai) | medium |
| Azure HorizonDB (public preview) | medium |
| Work IQ / Work IQ APIs (M365 plane) | low |
| GitHub Copilot app (coding-agent desktop) | low/skip |

## 1 · High-value — build now (reuse substrate Loom already has)
- **APIM AI gateway** — extend `apim-editors.tsx` + `apim-tree.tsx` with an **MCP servers** group and `llm-content-safety` / semantic-caching / `llm-token-limit` policy snippets on the real ARM api-version; honest-gate via existing `apimConfigGate()`.
- **Functions-hosted MCP tool server** — a Functions MCP host exposing Loom's real data-plane actions (ADX `.show`/query, Cosmos read, AI Search query, DAB, lineage) as MCP tools, plus a "Connect MCP tools to agent" panel on the workspace data-agent/Copilot config. Needs `LOOM_MCP_*` env + bicep.
- **Foundry IQ grounding picker** — a grounding-source picker in `copilot-config-store` + `foundry-agent-client` pointing at a Foundry IQ knowledge base (loom-items AI Search index + File Search). **Directly fixes the broken Copilot RAG surface (task #14).**
- **Cosmos-native semantic reranker** — opt-in "Semantic rerank" toggle in `cosmos-data-explorer.tsx` → new BFF `app/api/cosmos/items/rerank` calling real Cosmos `semantic_rerank()`; gate (gated preview, $/1k calls, 50-doc/2048-token limits).
- **Rayfin editor refresh** — keep `rayfin-app-editor.tsx` aligned to the current `@microsoft/rayfin` CLI/decorator surface (just added; verify vs the repo).

## 2 · Medium — focused add
- **Postgres introspection gate-close + pgvector/azure_ai RAG** — real `information_schema` introspection in `app/api/dab/sources/[kind]/schema` via `postgres-flex-client.ts` so DAB/navigator work end-to-end; a `CREATE EXTENSION azure_ai/vector/pg_diskann` action + Foundry embeddings from SQL.
- **Logic Apps agent-loop + MCP read-surface** — render agent-loop actions (model/prompt/tools) + an MCP-server status tab on real ARM (else honest gate).
- **Cosmos agentic-RAG / agent-memory use-case apps** — two one-click apps on Loom-provisioned Cosmos NoSQL + Foundry (Agentic RAG; Agent Memory via Durable Functions + change feed).
- **HorizonDB provisioner + admin gate** (public preview) — deploy-planner/bicep path + `LOOM_HORIZONDB_*` gate beside Postgres+DAB; honest MessageBar naming preview regions + Entra/Private-Endpoint. Not in Gov → keep gated, off the Gov-day-one path.

## 3 · Monitor — preview / too early
Fabric IQ **Ontologies** (GA "coming months" — honest-gate v2 only) · HorizonDB as a first-class item type (no public ARM/REST contract, no Gov) · Foundry **hosted-agent runtime** (preview→GA early July; admin toggle later) · Cosmos **Agent Memory Toolkit** as Loom's own Copilot store (re-evaluate at GA) · **GPU-accelerated Fabric DW** (workspace toggle → one-line doc note) · Postgres native Grafana / Defender CSPM / cross-tenant CMK (doc + bicep) · **Work IQ MCP** attach (optional gated toggle post-GA Jun 16).

## 4 · Skip — not a data-platform fit
**GitHub Copilot app** (coding-agent/repo domain) · **Work IQ APIs** (M365 productivity plane + licensing) · keynote consumer/Windows/quantum items (Scout, RTX Dev Box, Majorana, etc.). MAI-Image-2.5 already tracked (#17).

## Sequencing
Fastest high-impact wins: **(a) Foundry IQ grounding picker** (fixes Copilot RAG / #14) and **(b) Postgres introspection gate-close** (unblocks DAB + the Postgres navigator) — both reuse existing clients, no new infra. Then the strategic pair: **APIM MCP/LLM-policy + Functions MCP tool server** → turns Loom's API/Functions surfaces into a real agent control plane on the Foundry/Copilot stack. Every new env var/role/Cosmos container must land in `platform/fiab/bicep/**` + `admin-plane/main.bicep` (bicep-sync), and each new surface needs a `docs/fiab/parity/<slug>.md` artifact to grade A.
