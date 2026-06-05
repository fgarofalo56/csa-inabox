# sovereign-ai-agents — parity with Azure AI Foundry Agent Service (Standard / sovereign setup)

**App bundle:** `apps/fiab-console/lib/apps/content-bundles/app-sovereign-ai-agents.ts`
**App id:** `app-sovereign-ai-agents`

Source UI / docs:
- Azure AI Foundry Agent Service — Standard agent setup (data sovereignty):
  https://learn.microsoft.com/azure/foundry/agents/concepts/standard-agent-setup
- Standard setup with BYO virtual network (private networking):
  https://learn.microsoft.com/azure/foundry/agents/how-to/virtual-networks
- Connected / multi-agent systems:
  https://learn.microsoft.com/azure/foundry/agents/how-to/connected-agents
- Foundry architecture — data storage, CMK, data residency:
  https://learn.microsoft.com/azure/foundry/concepts/architecture#data-storage
- In-repo scenario source:
  `examples/ai-agents/multi-agent-governance/team.py`,
  `examples/ai-agents/contracts/multi-agent-governance.yaml`

The "sovereign" qualifier maps to the Foundry Agent Service **Standard
setup**: agent state (threads, files, vector stores) is stored in the
tenant's own Azure Cosmos DB / Storage / AI Search, encrypted under
Customer-Managed Keys, optionally inside a BYO virtual network with no
public egress — i.e. full data sovereignty / residency. The scenario is the
repo's three-agent governance review (DataAnalyst, QualityReviewer,
GovernanceOfficer) ported onto the connected-agents pattern.

---

## Azure / Foundry feature inventory (grounded in Learn)

| # | Capability (real Azure/Foundry UI or contract) | Source |
|---|---|---|
| 1 | Multi-agent orchestration: a main agent delegates to purpose-built connected sub-agents | connected-agents Learn |
| 2 | Per-agent instructions + allow-listed tools | connected-agents / contract `allowed_tools` |
| 3 | Denied tools (no write/publish/exec) enforced | contract `denied_tools` |
| 4 | Verdict vocabulary fixed to 4 values | contract `quality_rules` value_set |
| 5 | Human-in-the-loop required for approvals | contract `policy.human_in_loop_required` + `human_in_loop_for_verdicts` |
| 6 | Max-turns ceiling (12) + Content-Safety severity Medium | contract `policy.max_turns`, `content_safety_severity_max` |
| 7 | Standard setup: BYO Cosmos / Storage / AI Search (data sovereignty) | standard-agent-setup Learn |
| 8 | Customer-Managed Keys encryption | architecture#data-storage Learn |
| 9 | BYO virtual network / private networking, no public egress | virtual-networks Learn |
| 10 | Grounding via Azure AI Search (vector + keyword, HNSW) | RAG-on-agents pattern |
| 11 | Auditable transcript: full dialogue persisted, turn/token/cost totals | contract `schema` + `transcript` |
| 12 | Quality/eval of the agent system (accuracy, groundedness, policy adherence, cost, latency) | Foundry evaluation pattern |
| 13 | Runnable SDK walkthrough (azure-ai-projects connected agents) | connected-agents python sample |

---

## Loom coverage

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌

| Inventory row | Loom surface (bundle item) | Status |
|---|---|---|
| 1 Multi-agent orchestration | `Sovereign Governance Review` prompt-flow — orchestrator + 3 connected-agent nodes | ✅ |
| 2 Per-agent instructions + allowed tools | each tool node carries `instructions` + `allowedTools` | ✅ |
| 3 Denied tools enforced | each node `deniedTools`; ToolCalls seed row shows a refused `publish_data_product` (`allowed=false`) | ✅ |
| 4 Verdict vocabulary (4 values) | `verdictVocabulary` on the governance node + synthesis output shape; ADX seed covers all 4 | ✅ |
| 5 Human-in-the-loop on approvals | `node-hitl` `humanInLoop` (forVerdicts APPROVED*, gateState proposed) | ✅ |
| 6 Max-turns 12 + Content-Safety Medium | `maxTurns: 12` + `contentSafety severity_max medium` on synthesis | ✅ |
| 7 Standard setup BYO (sovereignty) | grounding docs gov-001; notebook cell 0 asserts BYO Cosmos/Storage/Search before any agent is created | ✅ |
| 8 Customer-Managed Keys | grounding doc gov-002 | ✅ |
| 9 BYO virtual network / no egress | grounding doc gov-003; notebook "go fully private" next-step | ✅ |
| 10 AI Search grounding (HNSW vector) | `governance-review-corpus` index — 1536-dim HNSW, 8 seed docs, tenant filter | ✅ |
| 11 Auditable transcript store | `agent-audit` KQL DB — AgentReviews/AgentTurns/ToolCalls seeded + review_verdicts/agent_cost_rollup functions + 5 queries | ✅ |
| 12 Agent quality / evaluation | `Sovereign Agent Quality` evaluation — 8 metrics + baseline run | ✅ |
| 13 Runnable SDK walkthrough | `Sovereign Agents Walkthrough` notebook — 13 cells, azure-ai-projects connected agents, end-to-end | ✅ |

Zero ❌. Zero stub banners.

---

## Backend per control (Phase-2 provisioner per item)

| Bundle item (itemType) | Real backend on install | Provisioner |
|---|---|---|
| `governance-review-corpus` (ai-search-index) | PUT index + push 8 seed docs to BYO Azure AI Search (`https://{svc}.search.windows.net`, api 2024-07-01) | `lib/install/provisioners/ai-search.ts` (`aiSearchProvisioner`) — real REST |
| `agent-audit` (kql-database) | ARM createDatabase + `.create table` ×3 + `.create-or-alter function` ×2 + retention/caching policies + inline-ingest seed rows | `lib/install/provisioners/kql-db.ts` (`kqlDatabaseProvisioner`) — real REST |
| `Sovereign Agents Walkthrough` (notebook) | POST Fabric notebook (ipynb inline-base64) / updateDefinition | `lib/install/provisioners/notebook.ts` (`notebookProvisioner`) — real REST |
| `Sovereign Governance Review` (prompt-flow) | Cosmos-only editor surface (no Phase-2 provisioner registered for `prompt-flow`); the engine returns `skipped` with an honest "Cosmos-only" step. The editor reads `state.content` and the flow is exercised live against Foundry from the notebook (`/api/items/prompt-flow/.../invoke`). | none (by design) |
| `Sovereign Agent Quality` (evaluation) | Cosmos-only editor surface (no Phase-2 provisioner registered for `evaluation`); honest `skipped`. Run live from the notebook via `/api/items/evaluation/.../run`. | none (by design) |

### Honest infra-gates (no-vaporware compliance)

Every real provisioner already surfaces a Fluent MessageBar `status:'remediation'` naming the exact env var / role:
- AI Search: `LOOM_AI_SEARCH_SERVICE` missing → set it; 403 → grant the Console UAMI **Search Service Contributor**.
- ADX: `LOOM_KUSTO_CLUSTER_URI` missing → set it; 403 → grant **AllDatabasesAdmin**.
- Notebook: no bound Fabric workspace → `LOOM_DEFAULT_FABRIC_WORKSPACE` / Bind capacity; 403 → add UAMI as Fabric **Contributor**.
- Sovereign-specific (notebook cell 0): asserts `LOOM_AGENT_COSMOS_ACCOUNT` / `LOOM_AGENT_STORAGE_ACCOUNT` / `LOOM_AI_SEARCH_SERVICE` so the agents never silently fall back to Microsoft-managed multitenant storage (which would forfeit data sovereignty).

---

## Verification

- `pnpm uat` (deep-functional) + live side-by-side against the Foundry portal Agents experience.
- Install the app, confirm 5 items render; open the prompt-flow editor and confirm the orchestrator system prompt + 6 nodes; open `agent-audit` and run the "Policy violations" query (returns the seeded refused `publish_data_product` row); open the evaluation and confirm `tool_policy_adherence == 1.00` baseline.
- Provisioner E2E receipt (per `.claude/rules/no-vaporware.md`) attaches to the integrating PR: AI Search index PUT 201 + 8-doc push, ADX createDatabase Succeeded + 3 tables + seed ingest, Fabric notebook create 201.
