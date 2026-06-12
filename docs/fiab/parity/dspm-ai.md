# dspm-ai — parity with Microsoft Purview DSPM for AI → "Discover › Apps and agents"

**Loom surface:** Admin → Security & governance → **DSPM for AI** tab
(`/admin/security?tab=dspm`), also linked from the admin-shell nav.
**Source UI:** Microsoft Purview portal → Data Security Posture Management →
**Discover › Apps and agents** (and the classic DSPM-for-AI **Apps and agents**
dashboard).
**Source docs (grounding):**
- https://learn.microsoft.com/purview/data-security-posture-management-learn-about#how-to-use-data-security-posture-management
- https://learn.microsoft.com/purview/dspm-for-ai#how-to-use-data-security-posture-management-for-ai

> Purview, verbatim: *"Discover > Apps and agents: To view a dashboard of AI
> apps and their agents… For the top 20 most recently used agents, view details
> about **sensitive data that they accessed and how they're protected by
> policies** from Microsoft Purview."*

This is the Fabric Build 2026 #34 ask: Copilot usage was tracked (token meter,
`/admin/copilot-usage`) but there was **no DSPM posture report** answering "which
agents / Copilots touch sensitive-labeled data." This surface fills that gap,
Azure-native — **no Microsoft Fabric / Power BI dependency** (Cosmos + Microsoft
Graph Information Protection + Azure Monitor only).

## Azure/Purview feature inventory (every capability)

| # | Purview "Apps and agents" capability | Notes |
|---|--------------------------------------|-------|
| 1 | Dashboard of AI apps + their agents used across the org | per-agent rows |
| 2 | Per agent: **sensitive data accessed** (which sensitivity labels) | the core signal |
| 3 | Per agent: **how it's protected by policies** (protected vs unprotected) | RMS/label protection |
| 4 | Most recently used agents (usage recency / volume) | "top 20 most recently used" |
| 5 | Sensitive-data exposure rolled up across agents (reports → "sensitive interactions per AI app") | summary metrics |
| 6 | Admin-only access to the estate-wide posture | RBAC-gated |
| 7 | Time window selection for the usage view | last N days |

## Loom coverage

| # | Capability | Status | How |
|---|-----------|--------|-----|
| 1 | AI agent inventory | ✅ built | `computeDspmAiPosture()` queries Cosmos `items` for the AI-agent item types (`data-agent`, `operations-agent`, `prompt-flow`) across the tenant's workspaces — matching Purview's "Apps and agents" breadth rather than a single type. The set is extensible via `LOOM_DSPM_AI_AGENT_ITEM_TYPES` (comma-separated, additive to the defaults). |
| 2 | Sensitive data accessed (labels) | ✅ built | Each agent's typed `state.sources[]` is resolved to its bound item's `state.sensitivityLabel` (Cosmos join by id then displayName). Per-agent `labelDistribution`, `sensitiveSourceCount`, and `maxLabel` (highest-ranked). |
| 3 | Protection state | ✅ built (⚠ honest-gate on MIP) | `maxLabel` is checked against Microsoft Graph Information Protection (`listSensitivityLabels().hasProtection`). When `LOOM_MIP_ENABLED` is unset → `gates.mip` info bar; ranking falls back to a deterministic static order and protection shows unknown. |
| 4 | Usage recency / volume per agent | ✅ built (⚠ honest-gate on Monitor) | KQL `AppEvents | where Name=="copilot.usage" | summarize calls=count(), lastUsed=max(TimeGenerated) by agent_id` over Log Analytics. The data-agent chat path now stamps `copilot.usage` with `agent_id` / `agent_name` / `sensitivity_label` / `data_sources`. Unset LAW → `gates.usage`, usage columns blank, label report still renders. |
| 5 | Estate roll-up | ✅ built | Summary cards (AI agents, agents touching labeled data, distinct labels exposed) + "labels reachable by agents" chips with per-label agent counts + protection icon. |
| 6 | Admin-only | ✅ built | BFF gates via `isTenantAdmin()` (403 `admin_only` with bootstrap remediation), matching `/api/governance/govern/posture`. |
| 7 | Time window | ✅ built | `?days=` (1–90, default 30); surfaced in the panel title. |

**Zero ❌, zero stub banners.** The only non-functional states are honest
infra-gates (MIP / Log Analytics), each rendering a `NotConfiguredBar` naming the
env var + bicep module + role — the full label-exposure report renders regardless.

## Backend per control

| Control | Backend |
|---------|---------|
| Agent inventory + source→label join | Cosmos `workspaces` + `items` (`cosmos-client`), UAMI `ChainedTokenCredential` |
| Label ordering + protection | Microsoft Graph `/beta/security/informationProtection/sensitivityLabels` (`mip-graph-client.listSensitivityLabels`) |
| Per-agent usage (calls, last used) | Azure Monitor Log Analytics KQL over `copilot.usage` (`monitor-client.queryLogs`) |
| Usage telemetry emit (agent_id dimension) | App Insights `/v2/track` from the data-agent chat route (`copilot-orchestrator.emitCopilotUsage` + `dspm-ai-client.resolveAgentSourceLabels`) |
| Admin gate | `feature-gate.isTenantAdmin` |

## No-Fabric-dependency statement

Works fully with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET. No call to
`api.fabric.microsoft.com` / `api.powerbi.com`; no `fabricWorkspaceId` read. The
data-agent items, their sources, and sensitivity labels are all Azure-native
(Cosmos), label semantics come from Microsoft Graph IP, and usage from Azure
Monitor — exactly the Azure-native 1:1 of Purview DSPM for AI.

## Per-cloud

All wrapped clients inherit sovereign endpoints: Cosmos `documents.azure.com`
(Commercial/GCC) vs `documents.azure.us` (GCC-High/IL5); Log Analytics honors
`LOOM_LOG_ANALYTICS_ENDPOINT` (`https://api.loganalytics.us` for GCC-High/IL5);
App Insights ingestion host is carried in `APPLICATIONINSIGHTS_CONNECTION_STRING`;
Graph uses the UAMI credential with cloud-correct scope. No cloud branching in the
new code.

## Bicep / env sync

**No new Azure resource, env var, role, or Cosmos container.** The report reuses:
`LOOM_COSMOS_ENDPOINT` (admin-plane/main.bicep) + the Console UAMI Cosmos Data
Contributor grant; `LOOM_LOG_ANALYTICS_WORKSPACE_ID` + Log Analytics Reader
(admin-plane/monitoring.bicep); `APPLICATIONINSIGHTS_CONNECTION_STRING`
(admin-plane/app-deployments.bicep); `LOOM_MIP_ENABLED` + the Graph IP app roles;
and `LOOM_TENANT_ADMIN_OID` / `LOOM_TENANT_ADMIN_GROUP_ID` for the admin gate.
`LOOM_DSPM_AI_AGENT_ITEM_TYPES` is an **optional** comma-separated override that
*adds* item types to the built-in agent set (`data-agent`, `operations-agent`,
`prompt-flow`); the report works without it, so no bicep wiring is required.

## Verification

- `npx tsc --noEmit` — clean on all touched files.
- Unit tests: `lib/azure/__tests__/dspm-ai-client.test.ts` (source→label join,
  max-label ranking, protection state, usage join, MIP/Monitor honest gates,
  and the widened agent inventory covering `operations-agent` + `prompt-flow`)
  and the extended `copilot-usage-emit.test.ts` (new agent_id/sensitivity_label
  dimension; base schema preserved).
- Live E2E: hit `GET /api/admin/dspm-ai` with a minted admin session →
  `{ ok:true, agents, summary, gates }`; with `LOOM_LOG_ANALYTICS_WORKSPACE_ID`
  unset → `gates.usage` present + usage columns blank; with `LOOM_COSMOS_ENDPOINT`
  unset → 503 `dspm_ai_not_configured`.
