# CSA Loom — API route inventory (WS-D3)

> GENERATED — do not edit by hand.
> Regenerate: `node scripts/ci/generate-route-inventory.mjs`.
> CI drift gate: `node scripts/ci/generate-route-inventory.mjs --check`.

Taxonomy of every `apps/fiab-console/app/api/**/route.ts` — classified by
auth scope, gate behavior, and backend dependency. Session / admin / gate /
backend detection mirrors `scripts/ci/check-route-guards.mjs`. The **owner**
verdict is DERIVED, not name-matched — see "How the owner column is decided".

## Summary

| Metric | Count |
| --- | ---: |
| Total routes | 1684 |
| Public (no session) | 58 |
| Session-only | 646 |
| Owner-scoped | 676 |
| Admin | 304 |
| Unknown (generator fails) | 0 |
| Gated (backend config) | 496 |
| Areas | 122 |

**Auth scope** — `public`: no session check; `session-only`: signed-in but
no per-resource authz; `owner-scoped`: the route reaches an owner/workspace-ACL
decision about the caller; `admin`: tenant/domain-admin gate; `unknown`: the
generator could not establish the scope and FAILED rather than guess.
**Gated** = the route honest-gates on a backend being configured (see
`docs/fiab/gate-registry.md`).
**Backends** = every backend the route REACHES through the call graph. `—` is
an assertion, not a default — see "How the backend column is decided".

## How the owner column is decided

Until #3625 this column came from a regex of ~30 names, three of which were
the bare tokens `claims.oid` / `claims.tid` / `claims.tenantId`. Measured on
`main` at 9cc1a397: **271 of 773 `owner-scoped` rows rested on a `claims.*`
token and nothing else** — a log field, a FinOps attribution field or a Cosmos
partition key reported as an authorization check. One of them,
`items/azure-sql-database/[id]/mirroring`, read `owner-scoped` while it was an
active P0 exfiltration primitive.

A route is now `owner-scoped` when it **reaches** an authorization decision:

1. it calls a symbol that resolves — module-qualified, through the import
   graph — to a member of the derived resolver set below, from a span
   reachable from an exported HTTP verb, and the answer is not discarded
   (`scripts/ci/_gate-consumption.mjs`); **or**
2. it compares the caller identity against a stored owner field and refuses.

The resolver set is DERIVED, not listed: a function qualifies when its body
reaches a seeded root primitive and consumes the answer, or makes the same
comparison itself. Seeds:

- owner: `apps/fiab-console/lib/auth/workspace-access.ts::resolveWorkspaceAccessByOid`
- owner: `apps/fiab-console/lib/auth/workspace-role.ts::resolveWorkspaceRole`
- session: `apps/fiab-console/lib/auth/session.ts::getSession`

The **session** signal is derived the same way, in addition to the shared
`SESSION_RE` list. It only ever adds: removing the bogus owner token dropped 13
`adx/*` routes to `public` because their session lives inside `guardAdxRequest`,
a wrapper that list does not name.

What this does NOT claim: that the decision is the RIGHT one (correct item,
correct role) — that needs a per-route read. Scope is per FILE, not per method.
Full statement of limits: `scripts/ci/_route-auth-scope.mjs` header.

## How the backend column is decided

Until #3592 this column came from `BACKEND_LABEL`, a hand-maintained map from a
Loom client MODULE NAME to a backend tag, consumed through `.filter(Boolean)` —
so a module absent from the map was **silently dropped** and its route published
`—`, "touches no backend". Measured on `main` at b9ca620b: the map held **26
entries against 378 distinct `@/lib/azure/*` modules that routes import**, and
one of its entries (`keyvault-client`) was imported by **zero** routes while the
module 19 routes use to reach Key Vault was absent — it looked like it covered
Key Vault while covering none of it. It published a false document four times
(#3499, #3529, Wave 0, #3581), each found by a human reading a regenerated diff.

A route now reaches a backend when a function reachable from an exported HTTP
verb **names that backend**, or calls a function that does. "Names" means one of
three identifiers that belong to Microsoft, not to Loom:

1. an ARM resource-provider namespace (`providers/Microsoft.Kusto/…`);
2. a data-plane / AAD-scope DNS suffix (`*.kusto.windows.net`);
3. a client SDK package (`@azure/cosmos`, `mssql`).

So adding a Loom client requires **no edit to any table** — a new
`lib/azure/*-client.ts` that builds a `Microsoft.Kusto` path derives ADX on the
commit that adds it. What DOES stop the build is Loom reaching an Azure service
this vocabulary has never seen: the detector is generic (any `Microsoft.*`, any
host under a Microsoft cloud DNS namespace, any `@azure/*` package), so it is
SEEN, fails to translate, and names itself.

**`—` is an assertion.** A route publishes it only when every module it reaches
that makes a network call has been named — by the derivation, or in the table
below with the verdict read at its definition. A client that talks to something
the analyzer cannot name FAILS this generator (`deploy-integrity.md` R7). That
remit is the whole route-reachable set, not one directory: scoped to
`lib/azure/**` it missed a client under `lib/integrations/` calling a real IoT
Hub data plane. It is per MODULE, though — a route that reaches only the
config-reading function of a module whose OTHER functions name a backend can
still publish `—` without tripping anything.

Two string-level filters keep help text out of the column, and both were
measured rather than assumed. **Prose**: a host preceded by whitespace is a
sentence, not an endpoint. **Placeholder examples**: a host in a string that
also carries a `<template-token>` is an admin fill-in-the-blank. The second
was the larger — `lib/admin/env-checks/core.ts`'s `VALUE_HINT` table put a
backend on **92 routes** attributable to nothing else, including **Power BI on
79 routes** from the single literal
`powerbi://api.powerbi.com/v1.0/myorg/<workspace>`.

What this does NOT claim: that the route calls the backend on EVERY request — a
branch behind a feature flag or an error path counts, which is the honest
direction for a dependency column. Reach is per FILE, not per method. Dynamic
dispatch is invisible to it. Full limits: `scripts/ci/_route-backends.mjs`.

## a2a

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `a2a/agent-cards/[kind]/[id]/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `a2a/agent-cards/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `a2a/delegate/route.ts` | POST | session-only |  | Azure Monitor, Cosmos |
| `a2a/route.ts` | GET POST | owner-scoped |  | AAS, ADX, AI Foundry, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Dataverse, Fabric, Key Vault, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power BI, Synapse SQL |

## access-governance

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `access-governance/assignments/[id]/activate/route.ts` | POST | session-only |  | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `access-governance/backfill/route.ts` | POST | admin |  | Cosmos |
| `access-governance/group-sync/route.ts` | POST | admin | ● | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `access-governance/repartition/route.ts` | POST | admin |  | Cosmos |
| `access-governance/report/route.ts` | GET | admin |  | Cosmos, Microsoft Graph |
| `access-governance/reviews/[id]/decision/route.ts` | POST | admin |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |
| `access-governance/reviews/[id]/evidence/route.ts` | GET | admin |  | Cosmos |
| `access-governance/reviews/[id]/route.ts` | GET PATCH DELETE | admin |  | ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |
| `access-governance/reviews/route.ts` | GET POST | admin |  | Cosmos |
| `access-governance/reviews/sweep/route.ts` | POST | admin |  | ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |
| `access-governance/revoke-all/route.ts` | POST | admin |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |
| `access-governance/sweep/route.ts` | POST | admin |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |

## access-packages

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `access-packages/[id]/request/route.ts` | POST | admin |  | Cosmos |
| `access-packages/[id]/route.ts` | GET PUT DELETE | admin |  | Cosmos |
| `access-packages/route.ts` | GET POST | admin |  | Cosmos |

## access-requests

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `access-requests/[id]/decision/route.ts` | POST | admin |  | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `access-requests/bulk-decision/route.ts` | POST | session-only |  | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `access-requests/public/route.ts` | POST | public |  | Cosmos |
| `access-requests/route.ts` | GET | session-only |  | Cosmos |

## activity

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `activity/route.ts` | GET | session-only |  | Cosmos |

## adf

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `adf/cdc/route.ts` | GET POST DELETE | session-only | ● | ADF, ADLS, ADX, ARM, Azure Monitor, Azure Networking, Azure SQL, Azure Storage, Container Apps, Cost Management, Log Analytics, Managed Identity, Resource Graph, Synapse SQL |
| `adf/dataflows/[name]/debug/route.ts` | GET POST | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/dataflows/[name]/route.ts` | GET PUT DELETE | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/dataflows/route.ts` | GET POST DELETE | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/datasets/[name]/route.ts` | GET | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/datasets/route.ts` | GET POST DELETE | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/factories/create/route.ts` | POST | session-only |  | ADF, ARM |
| `adf/global-parameters/route.ts` | GET PUT | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/integration-runtimes/route.ts` | GET POST DELETE | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/linked-services/[name]/route.ts` | GET | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/linked-services/route.ts` | GET POST DELETE | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/linked-services/test/route.ts` | POST | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/managed-private-endpoints/route.ts` | GET POST DELETE | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/pipelines/route.ts` | GET POST DELETE | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/resource-json/route.ts` | GET | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `adf/triggers/route.ts` | GET POST DELETE | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |

## admin

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `admin/access-requests/[id]/create-user/route.ts` | POST | admin |  | Cosmos, Microsoft Graph |
| `admin/access-requests/[id]/invite-guest/route.ts` | POST | admin |  | Cosmos, Microsoft Graph |
| `admin/access-requests/[id]/route.ts` | PATCH | admin |  | Cosmos |
| `admin/access-requests/route.ts` | GET | admin |  | Cosmos |
| `admin/agent-quality/eval-alert/route.ts` | GET POST DELETE | admin | ● | ARM, Azure Monitor |
| `admin/agent-quality/route.ts` | GET | admin | ● | AI Foundry, Cosmos |
| `admin/audit-logs/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos, Log Analytics, Purview |
| `admin/autopilot/apply/route.ts` | POST | admin |  | ADX, AKS, ARM, Azure Cache for Redis, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Resource Graph, Synapse |
| `admin/autopilot/route.ts` | GET PUT | admin |  | ADX, AKS, ARM, Azure Cache for Redis, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Resource Graph, Synapse |
| `admin/autopilot/run/route.ts` | POST | admin |  | ADX, AKS, ARM, Azure Cache for Redis, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Resource Graph, Synapse |
| `admin/azure-resources/route.ts` | GET | admin | ● | ARM |
| `admin/batch-labeling/route.ts` | GET POST | admin |  | Cosmos, Fabric, Microsoft Graph, Power BI, Purview |
| `admin/bootstrap-catalogs/route.ts` | POST | admin |  | AI Search, Cosmos |
| `admin/capacity/chargeback/route.ts` | GET | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management |
| `admin/capacity/cost/route.ts` | GET | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management, Microsoft Graph |
| `admin/capacity/guardrails/route.ts` | GET PUT | admin |  | Azure Monitor, Cosmos |
| `admin/capacity/utilization/route.ts` | POST | admin |  | ARM, Cosmos, Microsoft Graph |
| `admin/capacity/viz-config/route.ts` | GET | admin |  | Cosmos, Microsoft Graph, Power BI |
| `admin/chaos/dependency/route.ts` | GET POST | admin |  | Azure Cache for Redis, Azure Monitor, Cosmos |
| `admin/chargeback/attribution/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos |
| `admin/chargeback/route.ts` | GET | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management |
| `admin/chargeback/workspaces/route.ts` | GET | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management |
| `admin/classifications/route.ts` | GET POST DELETE | admin |  | Cosmos, Purview |
| `admin/coe-library/render/route.ts` | GET POST | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management, Defender for Cloud, Log Analytics, Microsoft Graph, Purview, Resource Graph |
| `admin/coe-library/route.ts` | GET POST DELETE | admin |  | ADLS, ARM, Azure Storage, Cosmos, Cost Management, Managed Identity, Microsoft Graph, Purview, Resource Graph |
| `admin/copilot-config/route.ts` | GET PUT | admin |  | ARM, Azure AI Services, Cosmos |
| `admin/copilot-quality/[surface]/route.ts` | GET | admin |  | Cosmos |
| `admin/copilot-quality/budgets/route.ts` | GET POST DELETE | admin |  | Azure Cache for Redis, Azure Monitor, Cosmos |
| `admin/copilot-quality/prompts/[promptId]/route.ts` | GET POST | admin |  | ARM, Azure Monitor, Cosmos |
| `admin/copilot-quality/prompts/route.ts` | GET POST | admin |  | Azure Cache for Redis, Azure Monitor, Cosmos |
| `admin/copilot-quality/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos |
| `admin/copilot-quality/run/route.ts` | POST | admin | ● | ARM, Cosmos |
| `admin/copilot-quality/search/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos |
| `admin/copilot-quality/tier/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos |
| `admin/copilot-usage/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos, Log Analytics |
| `admin/copilot/memory/[id]/route.ts` | DELETE | admin |  | AI Search, Cosmos |
| `admin/copilot/memory/audit/route.ts` | GET | admin |  | Cosmos |
| `admin/copilot/memory/route.ts` | GET POST | admin |  | AI Search, Cosmos |
| `admin/data-products-backend/route.ts` | GET | admin |  | — |
| `admin/data-quality-rules/route.ts` | GET POST PUT DELETE | admin |  | Cosmos |
| `admin/deploy-plan/cost-estimate/route.ts` | POST | admin |  | Defender for Cloud, Retail Prices API |
| `admin/deploy-plan/route.ts` | GET PUT | admin |  | Cosmos, Defender for Cloud |
| `admin/deploy-status/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos |
| `admin/developer/tokens/[id]/route.ts` | DELETE | admin |  | Azure Monitor, Cosmos |
| `admin/developer/tokens/route.ts` | GET | admin |  | Cosmos |
| `admin/diagnostics/bundle/route.ts` | GET | admin |  | ADX, Azure Monitor, Azure Networking, Azure Storage, Container Apps, Cosmos, Cost Management, Log Analytics |
| `admin/directory-users/[id]/lifecycle/route.ts` | POST | admin |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `admin/domains/[id]/inventory/route.ts` | GET | admin |  | ARM, Cosmos, Resource Graph |
| `admin/domains/assign-workspaces/route.ts` | POST | admin |  | Cosmos, Microsoft Graph |
| `admin/domains/images/route.ts` | GET | admin |  | ADLS, ARM, Azure Storage, Managed Identity |
| `admin/domains/mesh/route.ts` | GET | admin |  | Azure Monitor, Cosmos |
| `admin/domains/purview-status/route.ts` | GET | admin |  | Purview |
| `admin/domains/route.ts` | GET POST PATCH DELETE | admin |  | ADLS, Azure Monitor, Cosmos, Microsoft Graph, Purview |
| `admin/domains/sync/route.ts` | GET POST | admin |  | Azure Monitor, Cosmos, Purview |
| `admin/dspm-ai/route.ts` | GET | admin | ● | Cosmos, Log Analytics, Microsoft Graph |
| `admin/embed-codes/route.ts` | GET POST DELETE | admin | ● | ADLS, ARM, Azure Storage, Cosmos, Managed Identity |
| `admin/env-config/route.ts` | GET PUT | admin |  | ADLS, AKS, ARM, Azure Monitor, Container Apps, Cosmos, Microsoft Graph |
| `admin/estate/pause/route.ts` | POST | admin |  | AAS, ADX, ARM, Azure Monitor, Azure SQL, Compute, Cosmos, Managed Identity, Synapse, Synapse SQL |
| `admin/estate/resume/route.ts` | POST | admin |  | ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Synapse SQL |
| `admin/estate/state/route.ts` | GET | admin |  | AAS, ADX, ARM, Azure SQL, Compute, Cosmos, Managed Identity, Synapse, Synapse SQL |
| `admin/feedback-forwarding/route.ts` | GET PUT | admin |  | Cosmos |
| `admin/finops/anomalies/route.ts` | GET PUT DELETE | admin |  | ARM, Azure Cache for Redis, Azure Monitor, Cosmos, Cost Management |
| `admin/finops/breakdown/route.ts` | GET | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management |
| `admin/finops/budgets/route.ts` | GET POST PUT DELETE | admin |  | ARM, Azure Cache for Redis, Azure Monitor, Cosmos, Cost Management |
| `admin/finops/focus/route.ts` | GET | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management |
| `admin/finops/forecast/route.ts` | GET | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management |
| `admin/gates/[id]/options/route.ts` | GET | admin | ● | ARM, Azure AI Services, Cosmos |
| `admin/gates/[id]/resolve/route.ts` | POST | admin | ● | ADLS, ADX, AKS, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Microsoft Graph |
| `admin/gates/route.ts` | GET | admin |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `admin/governance-catalog/reindex/route.ts` | POST | admin | ● | AI Search, Cosmos |
| `admin/health/exercise/route.ts` | GET POST | admin |  | Power Platform |
| `admin/lineage/reconcile/route.ts` | GET POST | admin |  | Cosmos, Purview |
| `admin/load-sample-data/route.ts` | POST | admin |  | ADX, ARM, Managed Identity |
| `admin/mcp-servers/bridge/route.ts` | GET | admin |  | — |
| `admin/mcp-servers/builtin/route.ts` | GET | admin |  | — |
| `admin/mcp-servers/deploy/route.ts` | GET POST | admin | ● | ADLS, ARM, Azure Monitor, Azure Storage, Container Apps, Cosmos, Fabric, Key Vault, Microsoft Graph, Power BI |
| `admin/mcp-servers/deployed/status/route.ts` | GET | admin |  | ARM, Container Apps, Cosmos |
| `admin/mcp-servers/deployed/teardown/route.ts` | DELETE | admin |  | ARM, Azure Monitor, Container Apps, Cosmos, Key Vault |
| `admin/mcp-servers/ms-remote/config/route.ts` | GET PUT | admin |  | AI Foundry, ARM, Cosmos, Dataverse, Fabric, Microsoft Graph, Microsoft Sentinel, Power BI |
| `admin/mcp-servers/ms-remote/route.ts` | GET POST | admin |  | AI Foundry, ARM, Cosmos, Dataverse, Fabric, Key Vault, Microsoft Graph, Microsoft Sentinel, Power BI |
| `admin/mcp-servers/powerbi/route.ts` | GET POST | admin | ● | Cosmos, Fabric, Key Vault, Power BI |
| `admin/mcp-servers/route.ts` | GET POST PUT DELETE | admin |  | AI Foundry, ARM, Azure Monitor, Cosmos, Dataverse, Fabric, Key Vault, Microsoft Graph, Microsoft Sentinel, Power BI |
| `admin/mcp-servers/test-connection/route.ts` | POST | admin |  | Cosmos, Key Vault |
| `admin/model-fabric/route.ts` | GET PUT | admin |  | AKS, AML, ARM, Azure Monitor, Container Apps, Cosmos |
| `admin/model-fabric/run/route.ts` | POST | admin |  | AKS, AML, ARM, Azure Monitor, Container Apps, Cosmos |
| `admin/network/topology/route.ts` | GET | admin |  | ARM, Azure Networking, Resource Graph |
| `admin/ops-copilot/execute/route.ts` | POST | admin |  | ADX, ARM, Cosmos, Resource Graph, Synapse |
| `admin/ops-copilot/route.ts` | POST | admin |  | ADX, AML, ARM, Azure AI Services, Azure OpenAI, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `admin/org-visuals/dashboards/render/route.ts` | GET POST | admin |  | ARM, Azure Cache for Redis, Cosmos, Cost Management, Defender for Cloud, Log Analytics, Resource Graph |
| `admin/org-visuals/dashboards/route.ts` | GET POST PUT DELETE | admin |  | ADLS, ARM, Azure Cache for Redis, Azure Storage, Cosmos, Cost Management, Defender for Cloud, Log Analytics, Managed Identity, Resource Graph |
| `admin/org-visuals/route.ts` | GET POST PUT DELETE | admin | ● | ADLS, ARM, Azure Storage, Cosmos, Managed Identity |
| `admin/overview/route.ts` | GET | admin |  | ADX, ARM, Azure Cache for Redis, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Microsoft Graph |
| `admin/parity-autopilot/route.ts` | GET | admin |  | Cosmos, GitHub |
| `admin/parity-autopilot/run/route.ts` | POST | admin |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, GitHub |
| `admin/pdp/shadow-report/route.ts` | GET | admin |  | Cosmos |
| `admin/performance/cache-stats/route.ts` | GET | admin |  | Cosmos |
| `admin/performance/copilot-slo/route.ts` | GET | admin |  | — |
| `admin/performance/prove-warm/route.ts` | POST | admin | ● | Azure Monitor, Cosmos, Synapse |
| `admin/performance/recommendations/apply/route.ts` | POST | admin |  | ADX, ARM, Azure Monitor, Cosmos, Resource Graph, Synapse |
| `admin/performance/recommendations/route.ts` | GET | admin |  | ADX, ARM, Cosmos, Resource Graph, Synapse |
| `admin/performance/retrieval-stats/route.ts` | GET | admin |  | AI Search, Cosmos |
| `admin/performance/route.ts` | GET | admin |  | Cosmos |
| `admin/performance/run/route.ts` | GET POST | admin |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Azure SQL, Cosmos, Managed Identity, Synapse SQL |
| `admin/performance/tunables/route.ts` | GET POST | admin |  | Cosmos |
| `admin/permissions/capabilities/route.ts` | GET | admin |  | Cosmos |
| `admin/permissions/grants/route.ts` | GET POST DELETE | admin |  | Azure Monitor, Cosmos |
| `admin/permissions/principals/route.ts` | GET | admin |  | Cosmos, Microsoft Graph |
| `admin/platform-settings/route.ts` | GET PUT | admin |  | ADLS, Azure Monitor, Cosmos, Microsoft Graph |
| `admin/policy-code/reconcile/route.ts` | GET POST | admin |  | ADX, ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Purview, Synapse SQL |
| `admin/policy-code/route.ts` | GET PUT | admin |  | Cosmos |
| `admin/protection-policies/[id]/route.ts` | GET DELETE | admin |  | Cosmos |
| `admin/protection-policies/route.ts` | GET POST | admin |  | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `admin/readiness/export/route.ts` | GET | admin |  | AAS, ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure AI Services, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Container Apps, Cosmos, Cost Management, Event Grid, Event Hubs, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Power Automate, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse |
| `admin/readiness/route.ts` | GET | admin |  | AAS, ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Container Apps, Cosmos, Cost Management, Event Grid, Event Hubs, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Power Automate, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse |
| `admin/refresh-summary/route.ts` | GET | admin | ● | ADF, ARM, Cosmos, Log Analytics, Resource Graph |
| `admin/reindex-items/route.ts` | POST | admin |  | AI Search, Cosmos |
| `admin/rum/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos, Log Analytics |
| `admin/runtime-flags/[id]/route.ts` | PUT | admin |  | Azure Monitor, Cosmos |
| `admin/runtime-flags/route.ts` | GET | admin |  | Cosmos |
| `admin/scaling/adx/route.ts` | GET POST PUT | admin |  | ADX, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `admin/scaling/ai-search/route.ts` | GET POST | admin |  | AI Search, ARM, Cosmos, Microsoft Graph |
| `admin/scaling/aks/route.ts` | GET POST | admin |  | AKS, ARM, Cosmos, Microsoft Graph |
| `admin/scaling/apim/route.ts` | GET POST | admin | ● | APIM, ARM, Cosmos, Microsoft Graph |
| `admin/scaling/capacity/route.ts` | GET POST | admin |  | ARM, Cosmos, Fabric, Microsoft Graph |
| `admin/scaling/compute/purview-managed-vnet/route.ts` | GET POST | admin |  | Cosmos, Microsoft Graph, Purview |
| `admin/scaling/compute/register-purview-shir/route.ts` | GET POST | admin |  | Cosmos, Microsoft Graph, Purview |
| `admin/scaling/compute/route.ts` | GET POST | admin | ● | ADX, ARM, Compute, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `admin/scaling/container-apps/route.ts` | GET POST | admin |  | ARM, Container Apps, Cosmos, Microsoft Graph |
| `admin/scaling/cosmos/route.ts` | GET POST | admin | ● | Cosmos, Microsoft Graph |
| `admin/scaling/databricks-cluster/route.ts` | GET POST | admin | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `admin/scaling/databricks-warehouse/route.ts` | GET POST | admin | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `admin/scaling/foundry-compute/route.ts` | GET POST | admin |  | AML, ARM, Cosmos, Microsoft Graph |
| `admin/scaling/synapse-dwu/route.ts` | GET POST | admin | ● | ARM, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `admin/scaling/utilization/route.ts` | GET | admin | ● | ADX, AI Search, APIM, ARM, Container Apps, Cosmos, Microsoft Graph, Synapse |
| `admin/secret-health/route.ts` | GET | admin |  | Key Vault, Microsoft Graph |
| `admin/security/dlp/alerts/route.ts` | GET | admin |  | Microsoft Graph, Purview |
| `admin/security/dlp/manage/route.ts` | GET POST PATCH DELETE | admin |  | ADLS, Cosmos, Microsoft Graph, Purview |
| `admin/security/dlp/policies/route.ts` | GET | admin |  | Microsoft Graph, Purview |
| `admin/security/dlp/simulate/route.ts` | POST | admin |  | Purview |
| `admin/security/dlp/violations/route.ts` | GET | admin |  | Microsoft Graph, Purview |
| `admin/security/mip/applicable-items/route.ts` | GET | admin |  | Cosmos |
| `admin/security/mip/evaluate/route.ts` | POST | admin |  | Microsoft Graph, Purview |
| `admin/security/mip/labels/[id]/route.ts` | PATCH DELETE | admin |  | Loom service, Purview |
| `admin/security/mip/labels/route.ts` | GET POST | admin |  | ADLS, Cosmos, Loom service, Microsoft Graph, Purview |
| `admin/security/mip/policies/[id]/route.ts` | PATCH DELETE | admin |  | Loom service, Purview |
| `admin/security/mip/policies/route.ts` | GET POST | admin |  | Loom service, Purview |
| `admin/security/purview/collections/route.ts` | GET | admin |  | Purview |
| `admin/security/purview/dataquality/route.ts` | GET | admin |  | Cosmos, Purview |
| `admin/security/purview/discover/route.ts` | GET | admin |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Resource Graph, Synapse SQL |
| `admin/security/purview/domains/route.ts` | GET POST | admin |  | Purview |
| `admin/security/purview/glossary/route.ts` | GET POST | admin |  | Purview |
| `admin/security/purview/scans/route.ts` | GET POST | admin |  | ARM, Compute, Purview |
| `admin/security/purview/sources/route.ts` | GET POST DELETE | admin |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, PostgreSQL, Purview, Resource Graph, Synapse |
| `admin/self-audit/route.ts` | GET POST | admin |  | AAS, ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure AI Services, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Container Apps, Cosmos, Cost Management, Event Grid, Event Hubs, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Power Automate, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse |
| `admin/sensitivity-labels/route.ts` | GET POST DELETE | admin |  | Cosmos |
| `admin/slo/route.ts` | GET | admin |  | ARM, Azure Cache for Redis, Azure Monitor, Azure Storage, Cosmos |
| `admin/spark-telemetry/audit/route.ts` | GET POST | admin |  | ARM, Cosmos |
| `admin/spark/chaos/route.ts` | POST | admin | ● | Synapse |
| `admin/spark/health/route.ts` | GET | admin | ● | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Resource Graph, Synapse |
| `admin/spark/recover/route.ts` | GET POST | admin | ● | ADX, ARM, Azure Cache for Redis, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Resource Graph, Synapse |
| `admin/synthetic-runs/route.ts` | GET | admin | ● | Azure Storage |
| `admin/tenant-settings/groups/route.ts` | GET | admin | ● | Microsoft Graph |
| `admin/tenant-settings/route.ts` | GET PUT | admin |  | ADLS, Azure Monitor, Cosmos, Microsoft Graph |
| `admin/updates/apply/route.ts` | GET POST | admin |  | ACR, ARM, Azure Monitor, Container Apps, Cosmos, Microsoft Graph |
| `admin/updates/status/route.ts` | GET | admin | ● | ARM, Container Apps, Cosmos, Microsoft Graph |
| `admin/usage/embed/route.ts` | GET | admin | ● | Fabric, Power BI |
| `admin/usage/route.ts` | GET | admin |  | Azure Cache for Redis, Cosmos, Log Analytics |
| `admin/users/route.ts` | GET | admin |  | Cosmos, Microsoft Graph |
| `admin/webhooks/[id]/route.ts` | GET PATCH DELETE | admin |  | Azure Monitor, Cosmos |
| `admin/webhooks/[id]/test/route.ts` | POST | admin |  | Cosmos |
| `admin/webhooks/route.ts` | GET POST | admin |  | Azure Monitor, Cosmos |
| `admin/workspaces/[id]/cmk/route.ts` | GET POST DELETE | admin | ● | ARM, Azure RBAC, Azure Storage, Cosmos, Key Vault, Microsoft Graph |
| `admin/workspaces/[id]/connections/[connId]/route.ts` | DELETE | admin |  | Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/connections/adls-accounts/route.ts` | GET | admin |  | ARM, Azure Storage, Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/connections/log-analytics-workspaces/route.ts` | GET | admin |  | ARM, Cosmos, Log Analytics, Microsoft Graph |
| `admin/workspaces/[id]/connections/route.ts` | GET POST | admin |  | ADLS, ARM, Azure RBAC, Azure Storage, Cosmos, Log Analytics, Managed Identity, Microsoft Graph |
| `admin/workspaces/[id]/folders/route.ts` | GET POST PATCH DELETE | admin |  | Cosmos |
| `admin/workspaces/[id]/git/branch-out/route.ts` | POST | admin |  | ADF, ADLS, ADX, AI Search, ARM, Azure DevOps, Azure RBAC, Azure SQL, Azure Storage, Compute, Cosmos, Event Hubs, Fabric, Key Vault, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `admin/workspaces/[id]/git/meta/route.ts` | GET | admin |  | Azure DevOps, Cosmos, Key Vault, Microsoft Graph |
| `admin/workspaces/[id]/git/route.ts` | GET POST DELETE | admin |  | Azure DevOps, Cosmos, Key Vault, Microsoft Graph |
| `admin/workspaces/[id]/git/status/route.ts` | GET | admin |  | Azure DevOps, Cosmos, Key Vault, Microsoft Graph |
| `admin/workspaces/[id]/git/sync/route.ts` | POST | admin |  | Azure DevOps, Cosmos, Key Vault, Microsoft Graph |
| `admin/workspaces/[id]/identity/route.ts` | GET POST | admin |  | ADX, ARM, Azure Cache for Redis, Azure Monitor, Azure RBAC, Azure Storage, Cosmos, Event Hubs, Managed Identity, Microsoft Graph, Resource Graph |
| `admin/workspaces/[id]/m365/route.ts` | POST | admin |  | AI Search, Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/networking/inbound/route.ts` | GET POST | admin |  | ARM, Azure Networking, Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/networking/ip-rules/route.ts` | GET POST DELETE | admin |  | ARM, Azure Networking, Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/networking/outbound/route.ts` | GET POST DELETE | admin |  | ARM, Azure Networking, Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/networking/trusted-resources/route.ts` | GET POST DELETE | admin | ● | ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `admin/workspaces/[id]/networking/trusted/route.ts` | GET POST DELETE | admin |  | ARM, Azure Networking, Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/route.ts` | GET PATCH DELETE | admin |  | AI Search, ARM, Azure Monitor, Azure RBAC, Azure Storage, Cosmos, Fabric, Managed Identity, Microsoft Graph |
| `admin/workspaces/[id]/spark/environment/route.ts` | GET POST | admin | ● | Azure Monitor, Cosmos, Databricks, Microsoft Graph |
| `admin/workspaces/[id]/spark/jobs/route.ts` | GET POST | admin | ● | Cosmos, Databricks, Microsoft Graph |
| `admin/workspaces/[id]/spark/pools/route.ts` | GET POST DELETE | admin | ● | Cosmos, Databricks, Microsoft Graph |
| `admin/workspaces/[id]/spark/runtime/route.ts` | GET POST | admin | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/storage-metrics/route.ts` | GET | admin | ● | ARM, Azure Storage, Cosmos, Microsoft Graph |
| `admin/workspaces/[id]/task-flows/[flowId]/route.ts` | GET PUT DELETE | admin |  | Cosmos |
| `admin/workspaces/[id]/task-flows/route.ts` | GET POST | admin |  | Cosmos |
| `admin/workspaces/route.ts` | GET POST | admin |  | ADLS, ADX, AI Search, ARM, Azure Monitor, Azure RBAC, Azure Storage, Cosmos, Event Hubs, Fabric, Managed Identity, Microsoft Graph, Purview, Resource Graph |

## adx

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `adx/anomaly/route.ts` | POST | admin |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/continuous-exports/route.ts` | GET POST DELETE | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/external-tables/route.ts` | GET POST DELETE | owner-scoped |  | ADLS, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/functions/route.ts` | GET POST DELETE | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/ingestion-mappings/route.ts` | GET POST DELETE | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/materialized-views/route.ts` | GET POST DELETE | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/overview/route.ts` | GET | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/policies/route.ts` | GET POST | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/policy-authoring/route.ts` | POST | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/principals/route.ts` | GET POST | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/rls/route.ts` | GET POST | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |
| `adx/tables/route.ts` | GET POST PATCH DELETE | owner-scoped |  | ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Managed Identity, Microsoft Graph |

## agents

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `agents/[id]/memory/route.ts` | GET POST DELETE | owner-scoped |  | Azure Cache for Redis, Azure Monitor, Cosmos, Microsoft Graph |

## ai-functions

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ai-functions/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Monitor, Azure OpenAI, Cosmos |
| `ai-functions/table/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Monitor, Azure OpenAI, Cosmos |

## ai-search

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ai-search/aliases/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/datasources/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/debug-sessions/route.ts` | GET POST DELETE | session-only | ● | AI Search, ARM |
| `ai-search/index-my-data/prepare/route.ts` | GET | owner-scoped |  | ADLS, AI Search, AML, ARM, Azure AI Services, Azure OpenAI, Azure SQL, Azure Storage, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `ai-search/index-my-data/run/route.ts` | POST | owner-scoped | ● | ADLS, AI Search, AML, ARM, Azure AI Services, Azure OpenAI, Azure SQL, Azure Storage, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `ai-search/index-my-data/sources/route.ts` | GET | owner-scoped |  | Azure SQL, Cosmos, Microsoft Graph, Synapse |
| `ai-search/indexers/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/indexes/[name]/analyze/route.ts` | POST | session-only | ● | AI Search |
| `ai-search/indexes/[name]/route.ts` | GET PUT | session-only | ● | AI Search |
| `ai-search/indexes/[name]/search/route.ts` | POST | session-only | ● | AI Search |
| `ai-search/indexes/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/knowledge-bases/[name]/retrieve/route.ts` | POST | session-only | ● | AI Search |
| `ai-search/knowledge-bases/[name]/route.ts` | GET | session-only | ● | AI Search |
| `ai-search/knowledge-bases/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/knowledge-sources/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/service/metrics/route.ts` | GET | session-only | ● | AI Search, ARM, Cosmos, Microsoft Graph |
| `ai-search/service/route.ts` | GET POST | session-only | ● | AI Search, ARM, Cosmos, Microsoft Graph |
| `ai-search/skillsets/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/synonymmaps/route.ts` | GET POST DELETE | session-only | ● | AI Search |

## aml

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `aml/compute-instances/[name]/idle-shutdown/route.ts` | POST | session-only | ● | AML, ARM |
| `aml/compute-instances/[name]/start/route.ts` | POST | session-only | ● | AML, ARM |
| `aml/compute-instances/[name]/stop/route.ts` | POST | session-only | ● | AML, ARM |
| `aml/compute-instances/mine/route.ts` | GET POST | session-only | ● | AML, ARM |
| `aml/compute-instances/route.ts` | GET POST | session-only | ● | AML, ARM |
| `aml/datastores/route.ts` | GET | session-only | ● | ADLS, AML, ARM, Azure Storage |
| `aml/environments/route.ts` | GET POST PATCH | owner-scoped | ● | ADX, AML, ARM, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Microsoft Graph |
| `aml/experiments/route.ts` | GET | session-only |  | AML, ARM |
| `aml/runs/[runId]/artifact/route.ts` | GET | session-only | ● | ADX, AML, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `aml/runs/[runId]/artifacts/route.ts` | GET | session-only |  | AML, ARM |
| `aml/runs/[runId]/metrics/route.ts` | GET | session-only |  | AML, ARM |
| `aml/runs/[runId]/route.ts` | POST | session-only |  | AML, ARM |
| `aml/runs/[runId]/traces/route.ts` | GET | session-only |  | AML, ARM |
| `aml/runs/route.ts` | GET POST | session-only |  | AML, ARM |

## analytics

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `analytics/visualize/route.ts` | POST | session-only |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |

## apim

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `apim/apis/route.ts` | GET POST DELETE | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/backends/route.ts` | GET POST DELETE | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/developer-portal/route.ts` | GET POST | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/gateways/route.ts` | GET | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/import/route.ts` | POST | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/instances/route.ts` | GET | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/named-values/route.ts` | GET POST DELETE | admin | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Key Vault, Log Analytics |
| `apim/operations/route.ts` | GET | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/products/route.ts` | GET POST DELETE | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/service/route.ts` | GET PATCH | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/subscriptions/[sid]/keys/route.ts` | GET | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/subscriptions/[sid]/route.ts` | PATCH DELETE | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apim/subscriptions/route.ts` | GET POST DELETE | session-only | ● | ADX, APIM, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |

## app-templates

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `app-templates/[templateId]/instantiate/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |

## approval-policies

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `approval-policies/[id]/route.ts` | GET PUT DELETE | admin |  | Cosmos |
| `approval-policies/route.ts` | GET POST | admin |  | Cosmos |

## apps

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `apps/[id]/install/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure Monitor, Azure RBAC, Azure SQL, Azure Storage, Compute, Container Apps, Cosmos, Databricks, Event Hubs, Fabric, IoT Hub, Logic Apps, Managed Identity, Microsoft Graph, PostgreSQL, Power BI, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `apps/install-jobs/[jobId]/route.ts` | GET | owner-scoped |  | Cosmos |
| `apps/supercharge/seed/route.ts` | POST | owner-scoped |  | Cosmos, Synapse |

## apps-catalog

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `apps-catalog/route.ts` | GET POST | session-only |  | Cosmos |

## ask

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ask/route.ts` | POST | session-only | ● | AAS, ADX, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |

## assets

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `assets/freshness/route.ts` | GET PUT | owner-scoped |  | Azure Cache for Redis, Azure Monitor, Cosmos, Microsoft Graph, Purview |
| `assets/lineage/route.ts` | GET | owner-scoped |  | Azure Cache for Redis, Azure Monitor, Cosmos, Microsoft Graph, Purview |
| `assets/materialize/route.ts` | POST | owner-scoped | ● | ADLS, AI Search, ARM, Azure Cache for Redis, Azure Monitor, Azure Storage, Cosmos, Event Grid, Event Hubs / Service Bus, Managed Identity, Microsoft Graph, Power Automate, Power Platform, Purview, Service Bus, Synapse |
| `assets/route.ts` | GET | owner-scoped |  | Azure Cache for Redis, Azure Monitor, Cosmos, Microsoft Graph, Purview |
| `assets/status/route.ts` | GET | owner-scoped |  | Azure Cache for Redis, Azure Monitor, Cosmos, Microsoft Graph, Purview |

## attribute-groups

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `attribute-groups/route.ts` | GET POST | session-only |  | Cosmos |

## auth

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `auth/cli-session/route.ts` | POST | public | ● | Microsoft Graph |
| `auth/me/route.ts` | GET | session-only |  | — |
| `auth/refresh/route.ts` | POST | session-only |  | — |

## azure

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `azure/connectables/route.ts` | GET | session-only |  | ARM, Azure SQL, Cosmos, Event Hubs / Service Bus, Key Vault, Resource Graph, Synapse SQL |
| `azure/function-apps/route.ts` | GET | session-only | ● | ARM, App Service |
| `azure/iothub/policies/route.ts` | GET | session-only |  | ARM, Cosmos, IoT Hub |
| `azure/resources/route.ts` | GET | session-only |  | ADF, ARM, App Service, Azure Networking, Cosmos, Cost Management, Management Groups, Resource Graph |

## business-events

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `business-events/channels/route.ts` | GET | session-only | ● | ARM, Event Grid, Event Hubs |
| `business-events/publish/route.ts` | POST | session-only | ● | ARM, Cosmos, Event Grid, Event Hubs, Event Hubs / Service Bus |
| `business-events/topics/route.ts` | GET POST DELETE | session-only | ● | ARM, Event Grid |
| `business-events/types/route.ts` | GET POST DELETE | session-only | ● | Cosmos |

## canvas

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `canvas/suggest-next/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |

## capacity

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `capacity/admit/route.ts` | POST | admin |  | Loom service |

## catalog

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `catalog/asset/[id]/route.ts` | GET | session-only |  | Azure Monitor, Cosmos, Fabric, Purview |
| `catalog/browse/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Fabric, Microsoft Graph, Purview |
| `catalog/domains/route.ts` | GET POST DELETE | session-only |  | Purview |
| `catalog/find/route.ts` | GET | session-only |  | AI Search, Cosmos |
| `catalog/glossary/route.ts` | GET POST | session-only |  | Purview |
| `catalog/iceberg/config/route.ts` | GET | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `catalog/iceberg/connect/route.ts` | GET | session-only | ● | ADX, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `catalog/iceberg/namespaces/route.ts` | GET POST | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `catalog/iceberg/overview/route.ts` | GET | admin | ● | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `catalog/iceberg/table/route.ts` | GET | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `catalog/iceberg/tables/route.ts` | GET POST DELETE | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `catalog/interop/export/route.ts` | GET | session-only |  | Azure Monitor, Cosmos |
| `catalog/interop/ingest/route.ts` | POST | session-only |  | Azure Monitor, Cosmos, Purview |
| `catalog/lineage/item/route.ts` | GET | session-only |  | Azure Monitor, Cosmos, Fabric, Purview |
| `catalog/lineage/route.ts` | GET | session-only |  | Azure Monitor, Cosmos, Fabric, Purview |
| `catalog/metastores/route.ts` | GET POST | session-only | ● | ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Databricks, Fabric, PostgreSQL, Purview, Resource Graph, Synapse |
| `catalog/permissions/route.ts` | GET POST DELETE | session-only |  | Azure Monitor, Cosmos, Fabric |
| `catalog/register/route.ts` | POST | owner-scoped |  | Azure Monitor, Cosmos, Fabric, Microsoft Graph, Purview |
| `catalog/request-access/route.ts` | POST | session-only |  | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `catalog/search/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Fabric, Microsoft Graph, Purview |
| `catalog/shortcut/route.ts` | GET POST DELETE | session-only | ● | Fabric, Purview |
| `catalog/unity/capabilities/route.ts` | GET | session-only | ● | — |
| `catalog/unity/foreign-catalogs/route.ts` | GET | admin | ● | Cosmos |
| `catalog/unity/governance/route.ts` | GET POST | admin |  | Azure Monitor, Cosmos, Purview |
| `catalog/unity/governed-tags/route.ts` | GET POST | admin |  | Cosmos |

## cdc

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `cdc/connectors/[id]/monitor/route.ts` | GET | owner-scoped |  | ADLS, ARM, Azure Cache for Redis, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `cdc/connectors/[id]/route.ts` | GET DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `cdc/connectors/[id]/state/route.ts` | POST | owner-scoped |  | ADF, ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, Microsoft Graph, PostgreSQL, Resource Graph |
| `cdc/connectors/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure Cache for Redis, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `cdc/connectors/source-tables/route.ts` | POST | session-only |  | Azure SQL, PostgreSQL |

## cloud

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `cloud/route.ts` | GET | public |  | — |

## config

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `config/ui/route.ts` | GET | public |  | Cosmos |

## connections

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `connections/[id]/dependents/route.ts` | GET | session-only |  | Cosmos |
| `connections/[id]/objects/route.ts` | POST | owner-scoped |  | ADX, ARM, Azure Monitor, Azure SQL, Cosmos, Key Vault, Managed Identity, PostgreSQL |
| `connections/[id]/preview/route.ts` | POST | owner-scoped |  | ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, PostgreSQL, Synapse SQL |
| `connections/[id]/purview/route.ts` | POST | owner-scoped | ● | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `connections/[id]/route.ts` | GET PATCH DELETE | owner-scoped | ● | Cosmos, Key Vault |
| `connections/[id]/test/route.ts` | POST | owner-scoped |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity |
| `connections/route.ts` | GET POST DELETE | session-only |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Key Vault, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `connections/test/route.ts` | POST | owner-scoped |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity |

## copilot

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `copilot/code-interpret/route.ts` | POST | session-only | ● | Azure Monitor, Cosmos, Synapse |
| `copilot/complete/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure OpenAI, Cosmos |
| `copilot/dax/route.ts` | POST | session-only |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Dataverse, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `copilot/memory/flush/route.ts` | POST | session-only | ● | AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `copilot/notebook-assist/route.ts` | POST | session-only | ● | ADLS, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |
| `copilot/orchestrate/route.ts` | POST | session-only |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Dataverse, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `copilot/sessions/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos |
| `copilot/sessions/[id]/trace/route.ts` | GET | admin |  | Cosmos |
| `copilot/sessions/route.ts` | GET POST | session-only | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `copilot/skills/[id]/duplicate/route.ts` | POST | session-only |  | Cosmos |
| `copilot/skills/[id]/route.ts` | GET PUT DELETE | session-only |  | Cosmos |
| `copilot/skills/[id]/state/route.ts` | PATCH | admin |  | Cosmos |
| `copilot/skills/route.ts` | GET POST | session-only |  | Cosmos |
| `copilot/skills/suggested/[id]/route.ts` | POST | admin |  | Cosmos |
| `copilot/skills/suggested/route.ts` | GET | admin |  | Cosmos |
| `copilot/status/route.ts` | GET | session-only |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `copilot/tools/[name]/invoke/route.ts` | POST | session-only |  | AAS, ADF, ADLS, ADX, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `copilot/tools/route.ts` | GET | session-only |  | AAS, ADF, ADLS, ADX, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |

## cosmos

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `cosmos/account-management/route.ts` | GET PATCH | session-only |  | ARM, Cosmos |
| `cosmos/account/route.ts` | GET | session-only |  | ARM, Cosmos |
| `cosmos/container-settings/route.ts` | GET PATCH | session-only |  | ARM, Cosmos |
| `cosmos/container-throughput/route.ts` | GET PATCH | session-only |  | ARM, Cosmos |
| `cosmos/containers/route.ts` | GET POST DELETE | session-only |  | ARM, Cosmos |
| `cosmos/databases/route.ts` | GET POST DELETE | session-only |  | ARM, Cosmos |
| `cosmos/items/action/route.ts` | POST | session-only |  | ARM, Cosmos, Managed Identity |
| `cosmos/items/rerank/route.ts` | POST | session-only |  | ARM, Cosmos, Managed Identity |
| `cosmos/items/route.ts` | GET POST | session-only |  | ARM, Cosmos, Managed Identity |
| `cosmos/scripts/execute/route.ts` | POST | session-only |  | ARM, Cosmos, Managed Identity |
| `cosmos/scripts/route.ts` | GET PUT DELETE | session-only |  | ARM, Cosmos |

## cosmos-items

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `cosmos-items/[type]/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `cosmos-items/[type]/route.ts` | POST | owner-scoped |  | ADF, AI Search, Cosmos, Microsoft Graph |

## dab

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `dab/[id]/apply-to-runtime/route.ts` | POST | admin | ● | ARM, Container Apps, Cosmos, Loom service, Microsoft Graph |
| `dab/[id]/config/route.ts` | GET PUT | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `dab/[id]/download/route.ts` | POST | session-only |  | — |
| `dab/[id]/preview/graphql/route.ts` | POST | session-only |  | Loom service |
| `dab/[id]/preview/probe/route.ts` | GET | session-only |  | Loom service |
| `dab/[id]/preview/rest/route.ts` | POST | owner-scoped |  | Cosmos, Loom service, Microsoft Graph |
| `dab/[id]/preview/schema/route.ts` | GET | session-only |  | Loom service |
| `dab/[id]/publish/route.ts` | POST | session-only | ● | APIM, ARM, Loom service |
| `dab/[id]/validate/route.ts` | POST | session-only |  | Loom service |
| `dab/create/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `dab/deploy-source/route.ts` | GET POST | session-only | ● | ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, PostgreSQL, Purview, Resource Graph, Synapse |
| `dab/sources/[kind]/columns/route.ts` | GET | session-only | ● | Azure SQL |
| `dab/sources/[kind]/schema/route.ts` | GET | session-only | ● | Azure SQL |
| `dab/sources/route.ts` | GET | session-only | ● | ARM, Azure SQL, Synapse SQL |

## data-agent

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `data-agent/run-steps/route.ts` | POST | owner-scoped | ● | AAS, ADX, AI Foundry, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |

## data-products

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `data-products/[id]/access-policy/route.ts` | GET PUT | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `data-products/[id]/access-requests/route.ts` | GET POST PATCH | session-only |  | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `data-products/[id]/analytics/route.ts` | GET | owner-scoped |  | Cosmos |
| `data-products/[id]/assets/route.ts` | GET POST DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `data-products/[id]/cdes/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph, Purview |
| `data-products/[id]/certification/route.ts` | GET | session-only |  | Cosmos |
| `data-products/[id]/certify/route.ts` | POST | owner-scoped |  | ADX, AI Search, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `data-products/[id]/contract-quality/route.ts` | GET POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `data-products/[id]/deprecate/route.ts` | POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `data-products/[id]/glossary-terms/route.ts` | GET POST DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `data-products/[id]/health-actions/route.ts` | POST | owner-scoped | ● | ADX, AI Search, ARM, Compute, Cosmos, Managed Identity, Microsoft Graph, Purview |
| `data-products/[id]/observability/route.ts` | GET | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph, Purview |
| `data-products/[id]/okrs/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `data-products/[id]/policies/route.ts` | GET | session-only |  | Cosmos |
| `data-products/[id]/ports/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `data-products/[id]/preview/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `data-products/[id]/principal-search/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `data-products/[id]/route.ts` | GET PATCH DELETE | owner-scoped | ● | ADX, AI Search, ARM, Cosmos, Managed Identity, Microsoft Graph, Purview |
| `data-products/[id]/sla-check/route.ts` | POST | owner-scoped |  | Cosmos |
| `data-products/[id]/status/route.ts` | POST | owner-scoped |  | ADX, AI Search, ARM, Cosmos, Managed Identity, Microsoft Graph, Purview |
| `data-products/[id]/subscribers/route.ts` | GET | owner-scoped |  | Cosmos |
| `data-products/[id]/versions/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `data-products/import/route.ts` | POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `data-products/import/template/route.ts` | GET | session-only |  | — |
| `data-products/jobs/[jobId]/route.ts` | GET | owner-scoped |  | Cosmos |
| `data-products/my-access-requests/route.ts` | GET | session-only |  | Cosmos |
| `data-products/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `data-products/search/route.ts` | POST | session-only | ● | AI Search |

## databricks

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `databricks/catalogs/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `databricks/clusters/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/jobs/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/mlflow/experiments/route.ts` | GET POST | session-only | ● | Azure Monitor, Cosmos |
| `databricks/mlflow/models/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/notebooks/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/pipelines/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/repos/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/serving-endpoints/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/bindings/route.ts` | GET POST PATCH | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/catalogs/route.ts` | GET POST PATCH DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/clean-rooms/route.ts` | GET POST | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/connections/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/data-classification/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/external-locations/route.ts` | GET POST PATCH DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/functions/route.ts` | GET DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/governed-tags/route.ts` | GET POST | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/grants/route.ts` | GET PATCH | admin | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/lineage/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/marketplace/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/metric-views/route.ts` | GET POST | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/models/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/online-tables/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/policies/route.ts` | GET POST | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/principals/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/quality-monitors/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/schemas/route.ts` | GET POST PATCH DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/storage-credentials/route.ts` | GET POST PATCH DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/system-tables/route.ts` | GET POST | admin | ● | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `databricks/unity-catalog/tables/route.ts` | GET POST PATCH DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/tags/route.ts` | GET POST | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/temporary-credentials/route.ts` | POST | session-only | ● | Azure Monitor, Cosmos |
| `databricks/unity-catalog/volumes/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/warehouses/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `databricks/workspace/route.ts` | GET | session-only | ● | — |

## debug

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `debug/cookie/route.ts` | GET | public |  | — |

## delta-sharing

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `delta-sharing/[...path]/route.ts` | GET POST | public | ● | Cosmos |

## demo

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `demo/deploy/[jobId]/route.ts` | GET | session-only |  | Cosmos |
| `demo/deploy/route.ts` | GET POST | session-only |  | Cosmos |

## deploy

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `deploy/discovery/route.ts` | POST | admin |  | ARM, Container Apps, Cosmos, Resource Graph |

## deployment-pipelines

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `deployment-pipelines/[id]/compare/route.ts` | GET | session-only |  | Fabric |
| `deployment-pipelines/[id]/deploy/route.ts` | POST | session-only |  | Fabric |
| `deployment-pipelines/[id]/operations/route.ts` | GET | session-only |  | Fabric |
| `deployment-pipelines/[id]/stages/[stageId]/items/route.ts` | GET | session-only |  | Fabric |
| `deployment-pipelines/[id]/stages/[stageId]/workspace/route.ts` | POST DELETE | session-only |  | Fabric |
| `deployment-pipelines/[id]/stages/route.ts` | GET | session-only |  | Fabric |
| `deployment-pipelines/arm/[name]/operations/route.ts` | GET | session-only |  | ARM |
| `deployment-pipelines/arm/route.ts` | GET | session-only |  | ARM |
| `deployment-pipelines/create/route.ts` | POST | session-only |  | Fabric |
| `deployment-pipelines/git/[workspaceId]/commit/route.ts` | POST | session-only |  | Fabric |
| `deployment-pipelines/git/[workspaceId]/connection/route.ts` | GET POST DELETE | session-only |  | Fabric |
| `deployment-pipelines/git/[workspaceId]/initialize/route.ts` | POST | session-only |  | Fabric |
| `deployment-pipelines/git/[workspaceId]/status/route.ts` | GET | session-only |  | Fabric |
| `deployment-pipelines/git/[workspaceId]/update/route.ts` | POST | session-only |  | Fabric |
| `deployment-pipelines/loom/[id]/approvals/[requestId]/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure Monitor, Azure RBAC, Azure SQL, Azure Storage, Compute, Container Apps, Cosmos, Databricks, Event Hubs, Fabric, IoT Hub, Logic Apps, Managed Identity, Microsoft Graph, PostgreSQL, Power BI, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `deployment-pipelines/loom/[id]/approvals/route.ts` | GET | owner-scoped |  | Cosmos |
| `deployment-pipelines/loom/[id]/compare/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `deployment-pipelines/loom/[id]/deploy/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure Monitor, Azure RBAC, Azure SQL, Azure Storage, Compute, Container Apps, Cosmos, Databricks, Event Hubs, Fabric, IoT Hub, Logic Apps, Managed Identity, Microsoft Graph, PostgreSQL, Power BI, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `deployment-pipelines/loom/[id]/history/route.ts` | GET | owner-scoped |  | Cosmos |
| `deployment-pipelines/loom/[id]/route.ts` | GET DELETE | owner-scoped |  | Cosmos |
| `deployment-pipelines/loom/[id]/stages/[stageId]/approvals/route.ts` | GET PUT | owner-scoped |  | Azure Monitor, Cosmos |
| `deployment-pipelines/loom/[id]/stages/[stageId]/rules/route.ts` | GET PUT | owner-scoped |  | Cosmos |
| `deployment-pipelines/loom/[id]/variables/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `deployment-pipelines/loom/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `deployment-pipelines/route.ts` | GET | session-only |  | Fabric |

## developer

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `developer/tokens/[id]/route.ts` | DELETE | owner-scoped |  | Azure Monitor, Cosmos |
| `developer/tokens/route.ts` | GET POST | session-only |  | Azure Monitor, Cosmos |

## directlake

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `directlake/frame/route.ts` | POST | admin |  | — |
| `directlake/scan/route.ts` | POST | admin |  | — |

## downloads

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `downloads/route.ts` | GET POST | session-only |  | Cosmos |

## dq

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `dq/monitors/route.ts` | GET POST DELETE | session-only | ● | Azure Monitor, Cosmos |
| `dq/results/route.ts` | GET | session-only |  | Cosmos |
| `dq/rules/route.ts` | — | public |  | — |
| `dq/run/route.ts` | POST | session-only | ● | ADX, ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Synapse SQL |

## duckdb

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `duckdb/capabilities/route.ts` | GET | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `duckdb/query/route.ts` | POST | session-only |  | ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |

## ducklake

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ducklake/catalog/route.ts` | GET | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |

## embed

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `embed/query/route.ts` | POST | public |  | ADX, ARM, Azure Cache for Redis, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Synapse SQL |
| `embed/token/route.ts` | POST | session-only |  | Azure Cache for Redis, Azure Monitor, Cosmos |

## estate

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `estate/execute/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `estate/plan/route.ts` | POST | session-only |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |

## eventhubs

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `eventhubs/authrules/[rule]/keys/regenerate/route.ts` | POST | admin | ● | ARM, Cosmos, Event Hubs, Microsoft Graph |
| `eventhubs/authrules/[rule]/keys/route.ts` | POST | admin | ● | ARM, Cosmos, Event Hubs, Microsoft Graph |
| `eventhubs/authrules/route.ts` | GET | session-only | ● | ARM, Event Hubs |
| `eventhubs/capture/route.ts` | GET PUT | session-only | ● | ARM, Event Hubs |
| `eventhubs/consumergroups/route.ts` | GET POST DELETE | session-only | ● | ARM, Event Hubs |
| `eventhubs/data-explorer/route.ts` | GET POST | session-only | ● | Event Hubs, Event Hubs / Service Bus |
| `eventhubs/geodr-actions/route.ts` | POST | session-only | ● | ARM, Event Hubs |
| `eventhubs/geodr/route.ts` | GET | session-only | ● | ARM, Event Hubs |
| `eventhubs/hubs/route.ts` | GET POST DELETE | admin | ● | ARM, Cosmos, Event Hubs |
| `eventhubs/network/route.ts` | GET PUT | session-only | ● | ARM, Event Hubs |
| `eventhubs/private-endpoints/route.ts` | GET POST | session-only | ● | ARM, Event Hubs |
| `eventhubs/schemagroups/route.ts` | GET POST DELETE | session-only | ● | ARM, Event Hubs |

## experience

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `experience/warp/home/route.ts` | GET | session-only |  | Cosmos |
| `experience/warp/transforms/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |

## external-shares

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `external-shares/[id]/accept/route.ts` | POST | session-only |  | Cosmos |
| `external-shares/[id]/route.ts` | GET DELETE | owner-scoped |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity |
| `external-shares/received/route.ts` | GET | session-only |  | Cosmos |
| `external-shares/route.ts` | GET POST | owner-scoped |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |

## fabric

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `fabric/workspaces/route.ts` | GET | session-only |  | Fabric |

## feedback

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `feedback/route.ts` | POST | session-only |  | Cosmos |

## flightsql

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `flightsql/connect/route.ts` | GET | session-only |  | — |
| `flightsql/session/route.ts` | POST | session-only |  | Azure Monitor, Cosmos |

## foundry

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `foundry/accounts/route.ts` | GET | session-only |  | ARM, Azure AI Services |
| `foundry/activity/route.ts` | GET | session-only |  | ARM, Azure AI Services, Azure Monitor |
| `foundry/agents/[name]/route.ts` | GET DELETE | session-only | ● | AI Foundry |
| `foundry/agents/eval/judge/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `foundry/agents/eval/route.ts` | GET POST | session-only | ● | AI Foundry, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `foundry/agents/rollup/route.ts` | GET | session-only |  | Cosmos |
| `foundry/agents/route.ts` | GET POST | session-only | ● | AI Foundry, Cosmos |
| `foundry/agents/run/route.ts` | POST | session-only | ● | AI Foundry, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Cosmos |
| `foundry/agents/spans/route.ts` | GET | session-only | ● | Cosmos |
| `foundry/agents/threads/route.ts` | GET DELETE | owner-scoped |  | Cosmos |
| `foundry/audio/route.ts` | POST | session-only |  | ARM, Azure AI Services |
| `foundry/batch/[batchId]/route.ts` | GET DELETE | session-only |  | ARM, Azure AI Services |
| `foundry/batch/route.ts` | GET POST | session-only |  | ARM, Azure AI Services |
| `foundry/browser-tool/status/route.ts` | GET | session-only |  | — |
| `foundry/chat/route.ts` | POST | session-only | ● | AI Search, ARM, Azure AI Services |
| `foundry/computes/[id]/start/route.ts` | POST | session-only |  | AML, ARM |
| `foundry/computes/[id]/status/route.ts` | GET | session-only |  | AML, ARM |
| `foundry/computes/route.ts` | GET | session-only |  | AML, ARM |
| `foundry/connections/route.ts` | GET POST PATCH DELETE | session-only |  | AML, ARM |
| `foundry/data-sources/route.ts` | GET | session-only | ● | AI Search |
| `foundry/datastores/route.ts` | GET | session-only |  | AML, ARM |
| `foundry/deployments/route.ts` | GET | session-only |  | AML, ARM |
| `foundry/evaluations/files/route.ts` | POST | session-only |  | ARM, Azure AI Services |
| `foundry/evaluations/route.ts` | GET POST DELETE | session-only |  | ARM, Azure AI Services |
| `foundry/fine-tuning/[jobId]/route.ts` | GET POST | session-only |  | ARM, Azure AI Services |
| `foundry/fine-tuning/files/route.ts` | POST | session-only |  | ARM, Azure AI Services |
| `foundry/fine-tuning/route.ts` | GET POST | session-only |  | ARM, Azure AI Services |
| `foundry/images/route.ts` | POST | session-only |  | ARM, Azure AI Services |
| `foundry/keys/route.ts` | GET | session-only |  | ARM, Azure AI Services |
| `foundry/model-deployments/route.ts` | GET POST DELETE | session-only |  | ARM, Azure AI Services |
| `foundry/models-catalog/route.ts` | GET | session-only |  | ARM, Azure AI Services |
| `foundry/networking/route.ts` | GET PATCH | session-only |  | ARM, Azure AI Services |
| `foundry/observability/route.ts` | GET | session-only |  | AML, ARM |
| `foundry/quota/route.ts` | GET POST | session-only |  | ARM, Azure AI Services |
| `foundry/rbac/route.ts` | GET | session-only |  | ARM, Azure AI Services, Azure RBAC |
| `foundry/workspace/route.ts` | GET | session-only |  | AML, ARM |

## git-integration

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `git-integration/commit/route.ts` | POST | owner-scoped |  | Cosmos, Key Vault, Microsoft Graph |
| `git-integration/pull/route.ts` | POST | owner-scoped |  | Cosmos, Key Vault, Microsoft Graph |
| `git-integration/resolve/route.ts` | POST | owner-scoped |  | Cosmos, Key Vault, Microsoft Graph |
| `git-integration/status/route.ts` | GET | owner-scoped |  | Cosmos, Key Vault, Microsoft Graph |

## governance

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `governance/catalog/route.ts` | GET | session-only |  | AI Search, Cosmos |
| `governance/classification-types/route.ts` | GET POST DELETE | session-only |  | Cosmos |
| `governance/classifications/route.ts` | GET | session-only |  | Cosmos |
| `governance/classifications/system/route.ts` | GET | session-only |  | Purview |
| `governance/contract-check/route.ts` | POST | session-only |  | Azure Cache for Redis, Cosmos |
| `governance/copilot/ask/route.ts` | POST | session-only |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `governance/data-contracts/route.ts` | GET | session-only |  | Azure Cache for Redis, Cosmos |
| `governance/dlp/library/route.ts` | GET POST | admin | ● | Cosmos |
| `governance/dlp/meta/route.ts` | GET | session-only |  | Cosmos |
| `governance/dlp/restrict/route.ts` | POST | session-only | ● | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Managed Identity, Resource Graph, Synapse SQL |
| `governance/dlp/scan/route.ts` | GET POST | session-only |  | Cosmos, Purview |
| `governance/dlp/schemas/route.ts` | GET | session-only | ● | ARM, Azure SQL, Managed Identity, Synapse SQL |
| `governance/dlp/violations/route.ts` | GET | session-only |  | Cosmos, Microsoft Graph, Purview |
| `governance/domains/route.ts` | GET POST | session-only |  | Cosmos, Fabric |
| `governance/dq-findings/route.ts` | GET | session-only |  | Cosmos |
| `governance/govern/actions/route.ts` | GET | admin |  | Cosmos |
| `governance/govern/copilot/route.ts` | POST | admin |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `governance/govern/embed/route.ts` | GET | admin | ● | Fabric, Power BI |
| `governance/govern/owner/route.ts` | GET | session-only |  | Cosmos |
| `governance/govern/posture/route.ts` | GET | admin | ● | Cosmos, Log Analytics, Microsoft Graph, Purview |
| `governance/govern/refresh/route.ts` | POST | session-only | ● | — |
| `governance/govern/trigger-scan/route.ts` | GET POST | admin |  | ARM, Compute, Purview |
| `governance/identities/search/route.ts` | GET | admin | ● | Cosmos, Microsoft Graph |
| `governance/insights/route.ts` | GET | session-only |  | Azure Cache for Redis, Cosmos |
| `governance/irm/route.ts` | GET POST | session-only |  | ARM, Azure Monitor, Cosmos, Log Analytics |
| `governance/label-propagation/[itemId]/route.ts` | GET | session-only |  | Cosmos |
| `governance/labels/library/route.ts` | GET POST | admin | ● | Cosmos |
| `governance/lineage/route.ts` | GET | session-only |  | Azure Cache for Redis, Cosmos |
| `governance/pdp-mode/route.ts` | GET | session-only |  | — |
| `governance/policies/route.ts` | GET POST PUT DELETE | session-only | ● | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `governance/policy-code/engine-rules/route.ts` | GET | admin |  | Cosmos |
| `governance/purview/status/route.ts` | GET | session-only |  | ARM, Purview, Resource Graph |
| `governance/scans/register-existing/route.ts` | POST | admin | ● | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `governance/scans/route.ts` | GET POST DELETE | admin |  | ADLS, ADX, ARM, Azure SQL, Azure Storage, Compute, Cosmos, PostgreSQL, Purview, Resource Graph, Synapse |
| `governance/sensitivity/route.ts` | GET | session-only |  | Cosmos |
| `governance/workspace-egress/[id]/route.ts` | GET DELETE | admin |  | ARM, Cosmos |
| `governance/workspace-egress/route.ts` | GET POST | admin |  | ARM, Azure Networking, Cosmos |

## governance-domains

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `governance-domains/route.ts` | GET | session-only |  | Cosmos, Purview |

## health

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `health/deep/route.ts` | GET | public |  | Cosmos |
| `health/route.ts` | GET | public |  | — |

## help-copilot

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `help-copilot/chat/route.ts` | POST | session-only |  | ADF, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Resource Graph |
| `help-copilot/reindex/route.ts` | GET POST | session-only | ● | AI Search, Cosmos |
| `help-copilot/sessions/route.ts` | GET | session-only |  | Cosmos |

## insights

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `insights/digests/[id]/preview/route.ts` | POST | owner-scoped | ● | ADX, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Container Apps, Cosmos, Cost Management, Log Analytics |
| `insights/digests/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `insights/digests/[id]/run/route.ts` | POST | owner-scoped |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `insights/digests/route.ts` | GET POST | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |

## internal

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `internal/assets/reconcile/route.ts` | POST | owner-scoped |  | ADLS, AI Search, ARM, Azure Cache for Redis, Azure Monitor, Azure Storage, Cosmos, Event Grid, Event Hubs / Service Bus, Managed Identity, Microsoft Graph, Power Automate, Power Platform, Purview, Service Bus, Synapse |
| `internal/copilot/eval-probe/route.ts` | GET POST | public |  | AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `internal/copilot/memory/consolidate/route.ts` | GET POST | public |  | AI Search, Cosmos |
| `internal/copilot/search-probe/route.ts` | POST | session-only | ● | AI Search, Cosmos |
| `internal/copilot/skills/learn/route.ts` | GET POST | public |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `internal/copilot/tools/[name]/invoke/route.ts` | POST | session-only |  | AAS, ADF, ADLS, ADX, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `internal/copilot/tools/route.ts` | GET | session-only |  | AAS, ADF, ADLS, ADX, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `internal/cost-anomaly/run/route.ts` | POST | public | ● | ARM, Azure Cache for Redis, Azure Monitor, Cosmos, Cost Management |
| `internal/scheduler/tick/route.ts` | POST | public | ● | ADF, ADX, AML, ARM, Azure Storage, Cosmos, Managed Identity, Resource Graph, Synapse |
| `internal/spark/keep-warm/route.ts` | GET POST | session-only | ● | ARM, Azure Cache for Redis, Azure Monitor, Cosmos, Resource Graph, Synapse |
| `internal/topology/register-domain/route.ts` | POST | public |  | Cosmos |

## iq

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `iq/mcp/route.ts` | GET POST | owner-scoped |  | ADX, AI Search, ARM, Cosmos, Managed Identity, Microsoft Graph |

## items

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `items/[type]/[id]/access-mode/route.ts` | PATCH | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/[type]/[id]/ai-function/route.ts` | GET POST | session-only | ● | AML, ARM, Azure AI Services, Azure Monitor, Azure OpenAI, Cosmos |
| `items/[type]/[id]/alerts/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | ARM, Azure Monitor, Cosmos, Microsoft Graph |
| `items/[type]/[id]/assist/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Azure SQL, Cosmos, Managed Identity, Synapse SQL |
| `items/[type]/[id]/audit/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/[type]/[id]/business-metadata/route.ts` | GET POST | owner-scoped |  | Cosmos, Purview |
| `items/[type]/[id]/canvas-comments/[commentId]/route.ts` | PATCH DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/[type]/[id]/canvas-comments/route.ts` | GET POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/[type]/[id]/canvas-presence/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/[type]/[id]/canvas-suggest/route.ts` | POST | owner-scoped | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Microsoft Graph |
| `items/[type]/[id]/classifications/route.ts` | GET PUT | owner-scoped | ● | Cosmos, Purview |
| `items/[type]/[id]/collab/stream/route.ts` | GET | owner-scoped |  | Azure Cache for Redis, Cosmos, Microsoft Graph |
| `items/[type]/[id]/comments/route.ts` | GET POST PATCH DELETE | owner-scoped |  | Cosmos |
| `items/[type]/[id]/definition/route.ts` | GET PUT | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/[type]/[id]/endorsement/route.ts` | GET PATCH | admin |  | AI Search, Cosmos, Microsoft Graph |
| `items/[type]/[id]/explain/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `items/[type]/[id]/export-check/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/[type]/[id]/impact/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Purview |
| `items/[type]/[id]/lineage/route.ts` | GET | owner-scoped | ● | Azure Monitor, Cosmos, Purview |
| `items/[type]/[id]/monitoring/route.ts` | GET | owner-scoped | ● | ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/[type]/[id]/onelake-security/[role]/cls/route.ts` | GET POST | session-only |  | ADLS, ADX, ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/onelake-security/[role]/rls/route.ts` | GET POST | session-only |  | ADLS, ADX, ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/onelake-security/schema/route.ts` | GET | session-only |  | ADLS, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/optimize/route.ts` | POST | owner-scoped | ● | ADLS, ARM, Azure Monitor, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `items/[type]/[id]/pbi-source/route.ts` | GET | owner-scoped |  | ADX, ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/pbids/route.ts` | GET | owner-scoped |  | ADX, Azure SQL, Cosmos, Synapse SQL |
| `items/[type]/[id]/permissions/route.ts` | GET POST DELETE | owner-scoped |  | ADLS, ARM, Azure RBAC, Azure Storage, Cosmos, Fabric, Managed Identity, Microsoft Graph, Purview, Resource Graph |
| `items/[type]/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos |
| `items/[type]/[id]/security-roles/preview-as/route.ts` | POST | admin |  | ADLS, ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/security-roles/route.ts` | GET POST PUT DELETE | admin |  | ADLS, ARM, Azure Storage, Cosmos, Fabric, Managed Identity, Microsoft Graph |
| `items/[type]/[id]/security/route.ts` | GET POST | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/[type]/[id]/sensitivity-label/route.ts` | GET PUT PATCH DELETE | owner-scoped | ● | ADLS, ADX, ARM, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Fabric, Managed Identity, Microsoft Graph, Purview, Resource Graph, Synapse, Synapse SQL |
| `items/[type]/[id]/sensitivity/route.ts` | GET PUT | owner-scoped | ● | Cosmos, Purview |
| `items/[type]/[id]/share/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `items/[type]/[id]/shortcuts/[name]/route.ts` | PATCH DELETE | owner-scoped |  | ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/shortcuts/[name]/test/route.ts` | POST | owner-scoped |  | ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/shortcuts/route.ts` | GET POST | owner-scoped |  | ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/sql-security/route.ts` | GET POST | owner-scoped | ● | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Synapse SQL |
| `items/[type]/[id]/statistics/route.ts` | GET POST | owner-scoped | ● | ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/[type]/[id]/versions/[versionId]/restore/route.ts` | POST | owner-scoped | ● | Cosmos, Microsoft Graph |
| `items/[type]/[id]/versions/[versionId]/route.ts` | GET | owner-scoped | ● | Cosmos, Microsoft Graph |
| `items/[type]/[id]/versions/route.ts` | GET | owner-scoped | ● | Cosmos, Microsoft Graph |
| `items/[type]/[id]/visual-query/route.ts` | POST | session-only |  | ADLS, ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/activation-sync/[id]/bind-trigger/route.ts` | POST | owner-scoped |  | ADLS, Azure Monitor, Azure Storage, Cosmos, Microsoft Graph |
| `items/activation-sync/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/activation-sync/[id]/run/route.ts` | POST | owner-scoped | ● | ADLS, AI Search, ARM, Azure Cache for Redis, Azure Monitor, Azure Storage, Cosmos, Event Grid, Event Hubs / Service Bus, Managed Identity, Microsoft Graph, Power Automate, Power Platform, Service Bus |
| `items/activation-sync/[id]/runs/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/activation-sync/[id]/schema/route.ts` | GET | owner-scoped | ● | ADLS, Azure Storage, Cosmos, Microsoft Graph, Power Automate, Power Platform |
| `items/activation-sync/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/activator/[id]/adx-source/route.ts` | GET | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/activator/[id]/history/route.ts` | GET | owner-scoped | ● | ARM, Azure Monitor, Cosmos |
| `items/activator/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, ARM, Azure Monitor, Cosmos, Fabric, Microsoft Graph, Power BI, Purview |
| `items/activator/[id]/rules/route.ts` | GET POST PUT PATCH DELETE | owner-scoped | ● | ADX, ARM, Azure Monitor, Cosmos, Fabric, Log Analytics, Managed Identity, Microsoft Graph, Power BI |
| `items/activator/[id]/start/route.ts` | POST | owner-scoped |  | ARM, Azure Monitor, Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/activator/[id]/stop/route.ts` | POST | owner-scoped |  | ARM, Azure Monitor, Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/activator/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Fabric, Microsoft Graph, PostgreSQL, Power BI, Purview, Resource Graph, Synapse |
| `items/adf-dataset/[id]/route.ts` | GET PUT DELETE | session-only |  | ADF, ARM, Resource Graph |
| `items/adf-dataset/route.ts` | GET POST | session-only |  | ADF, ARM, Resource Graph |
| `items/adf-pipeline/[id]/bind/route.ts` | GET POST | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/adf-pipeline/[id]/connections/route.ts` | GET | session-only | ● | ADF, ARM, Resource Graph, Synapse |
| `items/adf-pipeline/[id]/copilot/route.ts` | POST | owner-scoped |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Dataverse, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `items/adf-pipeline/[id]/debug/route.ts` | POST | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/adf-pipeline/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/adf-pipeline/[id]/run/route.ts` | POST | owner-scoped |  | ADF, ARM, Compute, Cosmos, Microsoft Graph, Resource Graph |
| `items/adf-pipeline/[id]/runs/route.ts` | GET | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/adf-pipeline/[id]/triggers/route.ts` | GET POST | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/adf-pipeline/[id]/validate/route.ts` | POST | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/adf-pipeline/route.ts` | GET POST | session-only |  | ADF, ARM, Resource Graph |
| `items/adf-trigger/[id]/route.ts` | GET PUT DELETE | session-only |  | ADF, ARM, Resource Graph |
| `items/adf-trigger/[id]/state/route.ts` | POST | session-only |  | ADF, ARM, Resource Graph |
| `items/adf-trigger/route.ts` | GET POST | session-only |  | ADF, ARM, Resource Graph |
| `items/agent-flow/[id]/a2a/route.ts` | GET POST | owner-scoped |  | AAS, ADX, AI Foundry, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Dataverse, Fabric, Key Vault, Managed Identity, Microsoft Graph, Microsoft Sentinel, Power BI, Synapse SQL |
| `items/agent-flow/[id]/mcp/route.ts` | GET POST | owner-scoped |  | AAS, ADX, AI Foundry, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Dataverse, Fabric, Key Vault, Managed Identity, Microsoft Graph, Microsoft Sentinel, Power BI, Synapse SQL |
| `items/agent-flow/[id]/publish-mcp/route.ts` | POST DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/agent-flow/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/agent-flow/[id]/run/route.ts` | POST | owner-scoped |  | AAS, ADX, AI Foundry, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Dataverse, Fabric, Key Vault, Managed Identity, Microsoft Graph, Microsoft Sentinel, Power BI, Synapse SQL |
| `items/agent-flow/[id]/runs/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/ai-builder-model/[id]/predict/route.ts` | POST | session-only |  | Dataverse, Power Automate, Power Platform |
| `items/ai-builder-model/[id]/publish/route.ts` | POST | session-only |  | Dataverse, Power Automate, Power Platform |
| `items/ai-builder-model/[id]/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/ai-builder-model/[id]/train/route.ts` | POST | session-only |  | Dataverse, Power Automate, Power Platform |
| `items/ai-builder-model/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/ai-enrich/[service]/preview/route.ts` | POST | session-only |  | Azure AI Services |
| `items/ai-enrichment/[id]/preview/route.ts` | POST | owner-scoped | ● | AML, ARM, Azure AI Services, Azure Monitor, Azure OpenAI, Cosmos, Microsoft Graph |
| `items/ai-enrichment/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/ai-enrichment/[id]/run/route.ts` | POST | owner-scoped | ● | AI Search, AML, ARM, Azure AI Services, Azure Monitor, Azure OpenAI, Cosmos, Microsoft Graph |
| `items/ai-enrichment/[id]/runs/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/ai-enrichment/[id]/schema/route.ts` | GET | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/ai-foundry-project/[id]/route.ts` | GET DELETE | session-only |  | AML, ARM |
| `items/ai-foundry-project/route.ts` | GET POST | session-only |  | AML, ARM |
| `items/ai-red-team/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/ai-red-team/[id]/run/route.ts` | POST | owner-scoped | ● | AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Microsoft Graph |
| `items/ai-search-index/[id]/analyze/route.ts` | POST | owner-scoped |  | AI Search, Cosmos |
| `items/ai-search-index/[id]/bind/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos |
| `items/ai-search-index/[id]/indexers/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos |
| `items/ai-search-index/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Cosmos |
| `items/ai-search-index/[id]/search/route.ts` | POST | owner-scoped |  | AI Search, Cosmos |
| `items/ai-search-index/[id]/stats/route.ts` | GET | owner-scoped |  | AI Search, Cosmos |
| `items/ai-search-index/route.ts` | GET POST | session-only |  | AI Search |
| `items/aip-logic/[id]/bind-ontology/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/aip-logic/[id]/deploy/route.ts` | POST | owner-scoped | ● | AI Foundry, AML, ARM, Azure AI Services, Azure OpenAI, Cosmos, Microsoft Graph |
| `items/aip-logic/[id]/eval/route.ts` | GET POST | owner-scoped |  | AAS, ADX, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/aip-logic/[id]/invoke/route.ts` | POST | owner-scoped |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Dataverse, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `items/aip-logic/[id]/publish/route.ts` | POST | owner-scoped | ● | AAS, ADX, AI Search, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Purview, Synapse SQL |
| `items/aip-logic/[id]/route.ts` | — | public |  | — |
| `items/aip-logic/[id]/run-agent/route.ts` | POST | owner-scoped | ● | AI Foundry, Cosmos, Microsoft Graph |
| `items/aip-logic/[id]/versions/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/aip-logic/route.ts` | — | public |  | — |
| `items/airflow-job/[id]/connection/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/airflow-job/[id]/dag-runs/route.ts` | GET POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/airflow-job/[id]/dags/route.ts` | GET PATCH | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/airflow-job/[id]/route.ts` | GET DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/airflow-job/[id]/task-logs/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/airflow-job/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/analysis-board/[id]/run/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/apim-api/[id]/operations/route.ts` | GET POST PUT DELETE | session-only | ● | APIM, ARM |
| `items/apim-api/[id]/revisions/route.ts` | GET POST | session-only |  | APIM, ARM |
| `items/apim-api/[id]/route.ts` | GET PUT DELETE | session-only |  | APIM, ARM |
| `items/apim-api/[id]/spec/route.ts` | GET | session-only |  | APIM, ARM |
| `items/apim-api/[id]/test-call/route.ts` | POST | session-only |  | APIM, ARM |
| `items/apim-api/route.ts` | GET POST | session-only | ● | APIM, ARM |
| `items/apim-policy/[id]/route.ts` | GET PUT | session-only |  | APIM, ARM |
| `items/apim-policy/route.ts` | GET PUT | session-only | ● | APIM, ARM |
| `items/apim-product/[id]/apis/route.ts` | GET POST DELETE | session-only |  | APIM, ARM |
| `items/apim-product/[id]/route.ts` | GET PUT DELETE | session-only |  | APIM, ARM |
| `items/apim-product/[id]/subscriptions/route.ts` | GET | session-only |  | APIM, ARM |
| `items/apim-product/route.ts` | GET POST | session-only | ● | APIM, ARM |
| `items/automl/[id]/assist/route.ts` | — | public |  | — |
| `items/automl/jobs/[name]/route.ts` | GET DELETE | session-only | ● | AML, ARM |
| `items/automl/jobs/route.ts` | GET | session-only | ● | AML, ARM |
| `items/automl/options/route.ts` | GET | session-only | ● | ADLS, AML, ARM, Azure Storage |
| `items/automl/submit/route.ts` | POST | session-only | ● | AML, ARM |
| `items/azure-sql-database/[id]/aad-admin/route.ts` | GET PUT | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/connect/route.ts` | POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/azure-sql-database/[id]/copilot/route.ts` | POST | owner-scoped | ● | AML, ARM, Azure AI Services, Azure OpenAI, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/create-db/route.ts` | POST | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/firewall/route.ts` | GET POST DELETE | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/get-data/route.ts` | POST | owner-scoped | ● | ADF, ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL, Resource Graph |
| `items/azure-sql-database/[id]/maintenance-configs/route.ts` | GET | session-only |  | ARM, Azure Maintenance, Azure SQL |
| `items/azure-sql-database/[id]/mirroring/route.ts` | POST | owner-scoped |  | ADF, ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Resource Graph |
| `items/azure-sql-database/[id]/performance/route.ts` | POST | owner-scoped |  | Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/principal-search/route.ts` | GET | session-only |  | Microsoft Graph |
| `items/azure-sql-database/[id]/queries/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/azure-sql-database/[id]/query/cancel/route.ts` | POST | session-only |  | Azure SQL |
| `items/azure-sql-database/[id]/query/route.ts` | POST | owner-scoped |  | Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/replication/route.ts` | POST | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/restore/route.ts` | GET POST | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/scale/route.ts` | POST | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/search-management/route.ts` | GET POST | owner-scoped |  | Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/share/route.ts` | GET POST DELETE | owner-scoped |  | ARM, Azure RBAC, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/[id]/sql2025-features/route.ts` | POST | owner-scoped |  | Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-database/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/azure-sql-managed-instance/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/azure-sql-server/[id]/databases/route.ts` | GET | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/azure-sql-server/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/batch-pool/jobs/route.ts` | GET POST DELETE | session-only | ● | ARM, Batch, Cosmos, Microsoft Graph |
| `items/batch-pool/route.ts` | GET POST DELETE | session-only | ● | ARM, Batch, Cosmos, Microsoft Graph |
| `items/batch-pool/tasks/route.ts` | GET POST DELETE | session-only | ● | ARM, Batch, Cosmos, Microsoft Graph |
| `items/by-type/route.ts` | GET | admin |  | Cosmos, Microsoft Graph |
| `items/code-report/[id]/content/route.ts` | GET PUT | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/code-report/[id]/render/route.ts` | POST | owner-scoped |  | ADX, ARM, Azure Cache for Redis, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/code-report/validate/route.ts` | POST | session-only |  | Azure Cache for Redis, Cosmos |
| `items/compute/[id]/route.ts` | GET DELETE | session-only |  | AML, ARM |
| `items/compute/[id]/start/route.ts` | POST | session-only |  | AML, ARM |
| `items/compute/[id]/stop/route.ts` | POST | session-only |  | AML, ARM |
| `items/compute/route.ts` | GET POST | session-only |  | AML, ARM |
| `items/content-safety/blocklists/items/route.ts` | GET POST DELETE | session-only |  | Azure AI Services |
| `items/content-safety/blocklists/route.ts` | GET POST DELETE | session-only |  | Azure AI Services |
| `items/content-safety/rai-policies/route.ts` | GET POST DELETE | session-only |  | ARM, Azure AI Services |
| `items/content-safety/route.ts` | GET POST | session-only |  | Azure AI Services |
| `items/copilot-studio-action/[id]/route.ts` | PATCH DELETE | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-action/route.ts` | GET POST | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-agent/[id]/directline-token/route.ts` | POST | session-only |  | Direct Line |
| `items/copilot-studio-agent/[id]/publish/route.ts` | POST | session-only |  | Dataverse, Power Automate, Power Platform |
| `items/copilot-studio-agent/[id]/route.ts` | GET PATCH DELETE | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-agent/route.ts` | GET POST | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-analytics/[id]/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-channel/[id]/publish/route.ts` | POST | session-only |  | Bot Service, Power Automate, Power Platform |
| `items/copilot-studio-channel/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-knowledge/[id]/route.ts` | DELETE | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-knowledge/route.ts` | GET POST | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-topic/[id]/route.ts` | GET PATCH DELETE | session-only |  | Power Automate, Power Platform |
| `items/copilot-studio-topic/route.ts` | GET POST | session-only |  | Power Automate, Power Platform |
| `items/copilot-template-library/[id]/route.ts` | GET POST DELETE | session-only |  | Cosmos, Power Automate, Power Platform |
| `items/copilot-template-library/route.ts` | GET POST | session-only |  | Cosmos |
| `items/copy-job/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview, Synapse |
| `items/copy-job/[id]/run/route.ts` | POST | owner-scoped | ● | ADF, ARM, Azure SQL, Cosmos, Microsoft Graph, Resource Graph |
| `items/copy-job/[id]/runs/route.ts` | GET | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/copy-job/[id]/watermark/route.ts` | GET | owner-scoped |  | Azure SQL, Cosmos, Microsoft Graph |
| `items/copy-job/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/cosmos-db/[id]/gremlin/route.ts` | POST | session-only | ● | ARM, Cosmos |
| `items/cosmos-db/[id]/keys/route.ts` | GET POST | admin |  | ARM, Cosmos, Microsoft Graph |
| `items/cosmos-db/[id]/metrics/route.ts` | GET | session-only | ● | ARM, Cosmos |
| `items/cosmos-gremlin-graph/[id]/query/route.ts` | POST | session-only |  | Cosmos |
| `items/cosmos-gremlin-graph/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/cypher-graph/[id]/assist/route.ts` | — | public |  | — |
| `items/cypher-graph/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/dashboard/[id]/embed-token/route.ts` | POST | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/dashboard/[id]/pin/route.ts` | POST | owner-scoped | ● | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/dashboard/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/dashboard/[id]/tile-embed-token/route.ts` | POST | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/dashboard/[id]/tile-query/route.ts` | POST | owner-scoped | ● | AAS, ADX, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Fabric, Managed Identity, Microsoft Graph, Power BI |
| `items/dashboard/route.ts` | GET | session-only |  | Fabric, Power BI |
| `items/data-agent/[id]/a2a/route.ts` | GET POST | owner-scoped |  | AAS, ADX, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/data-agent/[id]/chat/route.ts` | POST | owner-scoped |  | AAS, ADX, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/data-agent/[id]/conversations/route.ts` | GET POST DELETE | session-only |  | Cosmos |
| `items/data-agent/[id]/copilot/route.ts` | POST | owner-scoped |  | ADX, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/data-agent/[id]/deploy/route.ts` | POST | owner-scoped |  | AI Foundry, Cosmos, Microsoft Graph |
| `items/data-agent/[id]/evaluate/route.ts` | POST | owner-scoped |  | AAS, ADX, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/data-agent/[id]/m365-copilot/route.ts` | GET POST | owner-scoped |  | Bot Service, Copilot Studio, Cosmos, Dataverse, Microsoft Graph, Power Automate, Power Platform |
| `items/data-agent/[id]/mcp/route.ts` | GET POST | owner-scoped |  | AAS, ADX, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/data-agent/[id]/publish-mcp/route.ts` | POST DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/data-agent/[id]/publish/route.ts` | POST | owner-scoped |  | AI Foundry, Cosmos, Microsoft Graph |
| `items/data-agent/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Foundry, AI Search, Cosmos, Microsoft Graph, Power Automate, Power Platform, Purview |
| `items/data-agent/[id]/source-schema/route.ts` | GET | owner-scoped |  | ADX, AI Search, ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/data-agent/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/data-contract/[id]/introspect/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/data-contract/[id]/odcs/route.ts` | GET POST PUT PATCH | owner-scoped |  | AI Search, Azure Monitor, Cosmos, Microsoft Graph |
| `items/data-contract/[id]/quality/route.ts` | GET POST | owner-scoped | ● | ADX, AI Search, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/data-contract/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/data-pipeline/[id]/approval-logicapp/route.ts` | GET | owner-scoped | ● | ARM, Cosmos, Logic Apps, Microsoft Graph |
| `items/data-pipeline/[id]/connections/route.ts` | GET | session-only | ● | ADF, ARM, Resource Graph, Synapse |
| `items/data-pipeline/[id]/copilot/route.ts` | POST | owner-scoped |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Dataverse, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `items/data-pipeline/[id]/debug/route.ts` | POST | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/data-pipeline/[id]/evaluate/route.ts` | POST | owner-scoped | ● | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/data-pipeline/[id]/export/route.ts` | GET | owner-scoped | ● | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/data-pipeline/[id]/integration-runtimes/route.ts` | GET POST DELETE | owner-scoped | ● | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/data-pipeline/[id]/jobs/route.ts` | GET | owner-scoped |  | ADF, ARM, Azure Monitor, Cosmos, Microsoft Graph, Purview, Resource Graph |
| `items/data-pipeline/[id]/output/route.ts` | GET | owner-scoped |  | ADF, ARM, Azure Monitor, Cosmos, Log Analytics, Microsoft Graph, Purview, Resource Graph |
| `items/data-pipeline/[id]/publish/route.ts` | POST | owner-scoped | ● | ADF, ARM, Cosmos, Fabric, Microsoft Graph, Resource Graph |
| `items/data-pipeline/[id]/route.ts` | GET PUT DELETE | owner-scoped | ● | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/data-pipeline/[id]/run/route.ts` | POST | owner-scoped | ● | ADF, ARM, Azure Monitor, Compute, Cosmos, Microsoft Graph, Resource Graph |
| `items/data-pipeline/[id]/triggers/route.ts` | GET POST PUT DELETE | owner-scoped |  | ADF, ARM, App Configuration, Cosmos, Key Vault, Microsoft Graph, Resource Graph |
| `items/data-pipeline/[id]/validate/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/data-pipeline/import/route.ts` | POST | owner-scoped | ● | ADF, ARM, Cosmos, Resource Graph |
| `items/data-pipeline/practice-seed/route.ts` | POST | owner-scoped | ● | ADF, ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Resource Graph |
| `items/data-pipeline/route.ts` | GET POST | owner-scoped |  | ADF, ARM, Cosmos, Resource Graph |
| `items/data-product-instance/[id]/provision/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure Monitor, Azure RBAC, Azure SQL, Azure Storage, Compute, Container Apps, Cosmos, Databricks, Event Hubs, Fabric, IoT Hub, Logic Apps, Managed Identity, Microsoft Graph, PostgreSQL, Power BI, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `items/data-product-instance/[id]/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/data-product-instance/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/data-product-template/[id]/instantiate/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure Monitor, Azure RBAC, Azure SQL, Azure Storage, Compute, Container Apps, Cosmos, Databricks, Event Hubs, Fabric, IoT Hub, Logic Apps, Managed Identity, Microsoft Graph, PostgreSQL, Power BI, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `items/data-product-template/[id]/route.ts` | GET | session-only |  | — |
| `items/data-product-template/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/data-product/[id]/publish-api/route.ts` | POST | owner-scoped | ● | AI Search, APIM, ARM, Cosmos, Microsoft Graph |
| `items/data-product/[id]/register-purview/route.ts` | POST | owner-scoped | ● | AI Search, Cosmos, Microsoft Graph |
| `items/data-quality/[id]/checks/route.ts` | GET POST | owner-scoped | ● | AI Search, ARM, Azure Cache for Redis, Azure Monitor, Cosmos, Managed Identity, Microsoft Graph |
| `items/data-quality/[id]/diff/route.ts` | POST | owner-scoped |  | ADLS, ARM, Azure Cache for Redis, Azure Monitor, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `items/data-quality/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/data-quality/[id]/run/route.ts` | GET POST | owner-scoped | ● | ADX, AI Search, ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/data-science/home/route.ts` | GET | session-only |  | AML, ARM, Cosmos |
| `items/databricks-cluster/[id]/events/route.ts` | GET | session-only |  | Azure Monitor, Cosmos |
| `items/databricks-cluster/[id]/libraries/route.ts` | GET POST DELETE | session-only |  | Azure Monitor, Cosmos |
| `items/databricks-cluster/[id]/route.ts` | GET PATCH DELETE | session-only |  | Azure Monitor, Cosmos |
| `items/databricks-cluster/[id]/state/route.ts` | POST | session-only |  | Azure Monitor, Cosmos |
| `items/databricks-cluster/hygiene/route.ts` | GET POST | admin | ● | Azure Monitor, Cosmos |
| `items/databricks-cluster/options/route.ts` | GET | session-only |  | Azure Monitor, Cosmos |
| `items/databricks-cluster/route.ts` | GET POST | session-only |  | Azure Monitor, Cosmos |
| `items/databricks-job/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-job/[id]/run-output/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-job/[id]/run/route.ts` | POST | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-job/[id]/runs/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-job/route.ts` | GET POST | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-notebook/[id]/command/route.ts` | POST | owner-scoped |  | Azure Monitor, Cosmos, Databricks, Microsoft Graph |
| `items/databricks-notebook/[id]/context/route.ts` | POST DELETE | owner-scoped |  | Azure Monitor, Cosmos, Databricks, Microsoft Graph |
| `items/databricks-notebook/[id]/ensure-cluster/route.ts` | POST | owner-scoped | ● | Azure Monitor, Cosmos, Databricks, Microsoft Graph |
| `items/databricks-notebook/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-notebook/[id]/run/route.ts` | POST | owner-scoped |  | Azure Monitor, Cosmos, Databricks, Microsoft Graph |
| `items/databricks-notebook/[id]/runs/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-notebook/[id]/schedule/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | Azure Monitor, Cosmos, Databricks, Microsoft Graph |
| `items/databricks-notebook/[id]/versions/route.ts` | GET POST | owner-scoped | ● | Cosmos, Microsoft Graph |
| `items/databricks-notebook/list/route.ts` | GET | session-only |  | Azure Monitor, Cosmos |
| `items/databricks-pipeline/[id]/events/route.ts` | GET | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-pipeline/[id]/pipelines/route.ts` | GET | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-pipeline/[id]/spec/route.ts` | GET POST | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-pipeline/[id]/start/route.ts` | POST | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-pipeline/[id]/stop/route.ts` | POST | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-pipeline/[id]/updates/route.ts` | GET | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/cancel/route.ts` | POST | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/clone/route.ts` | POST | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/connection/route.ts` | GET | owner-scoped |  | Azure Monitor, Azure SQL, Cosmos, Microsoft Graph, Synapse SQL |
| `items/databricks-sql-warehouse/[id]/create/route.ts` | POST | owner-scoped | ● | ARM, Azure Monitor, Cosmos, Fabric, Microsoft Graph, Resource Graph, Synapse |
| `items/databricks-sql-warehouse/[id]/ctas/route.ts` | POST | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/delete/route.ts` | POST | owner-scoped | ● | ARM, Azure Monitor, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `items/databricks-sql-warehouse/[id]/edit/route.ts` | POST | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/iqy/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/model/route.ts` | GET POST DELETE | owner-scoped |  | AI Search, Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/query-history/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/query-profile/route.ts` | GET | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/query/route.ts` | POST | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/schema/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/script-out/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/start/route.ts` | POST | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/state/route.ts` | GET POST | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/databricks-sql-warehouse/[id]/warehouses/route.ts` | GET | owner-scoped |  | ARM, Azure Monitor, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `items/dataflow/[id]/refresh/route.ts` | POST | owner-scoped |  | ADF, ADLS, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/dataflow/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/dataflow/config/route.ts` | GET | session-only | ● | — |
| `items/dataflow/copilot/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `items/dataflow/profile/route.ts` | POST | session-only | ● | ARM, Azure SQL, Managed Identity, Synapse SQL |
| `items/dataflow/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/datamart/migrate/route.ts` | POST | owner-scoped | ● | AAS, AI Search, ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/dataset/[id]/lineage/route.ts` | GET | session-only |  | AML, ARM |
| `items/dataset/[id]/preview/route.ts` | GET | session-only | ● | ADLS, AML, ARM, Azure SQL, Azure Storage, Managed Identity, Synapse SQL |
| `items/dataset/[id]/route.ts` | GET | session-only |  | AML, ARM |
| `items/dataset/browse/route.ts` | GET | session-only |  | ADLS, ARM, Azure Storage, Managed Identity |
| `items/dataset/route.ts` | GET POST | session-only |  | AML, ARM |
| `items/dataverse-table/[id]/business-rules/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/dataverse-table/[id]/columns/route.ts` | POST | session-only | ● | Dataverse, Power Automate, Power Platform |
| `items/dataverse-table/[id]/keys/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/dataverse-table/[id]/relationships/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/dataverse-table/[id]/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/dataverse-table/[id]/rows/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/dataverse-table/[id]/views/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/dataverse-table/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/dbt-job/[id]/generate/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/dbt-job/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Azure Monitor, Cosmos, Microsoft Graph, Purview |
| `items/dbt-job/[id]/run/route.ts` | POST | owner-scoped | ● | AI Search, Azure Monitor, Cosmos, Microsoft Graph, Purview |
| `items/dbt-job/[id]/runs/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/dbt-job/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/digital-twin/[id]/event-route/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/digital-twin/[id]/materialize/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/digital-twin/[id]/query/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/digital-twin/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/digital-twin/[id]/source-schema/route.ts` | GET | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/digital-twin/[id]/time-series/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/environment/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/environment/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/evaluation/[id]/route.ts` | GET | owner-scoped |  | AML, ARM, Cosmos |
| `items/evaluation/route.ts` | GET POST | session-only |  | AML, ARM |
| `items/event-grid-topic/route.ts` | GET POST DELETE | session-only | ● | ARM, Cosmos, Event Grid, Microsoft Graph |
| `items/event-hubs-namespace/route.ts` | GET POST DELETE | session-only | ● | ARM, Event Hubs |
| `items/event-schema-set/[id]/check-compat/route.ts` | POST | owner-scoped | ● | Cosmos, Event Hubs, Event Hubs / Service Bus, Microsoft Graph |
| `items/event-schema-set/[id]/route.ts` | GET PATCH DELETE | owner-scoped | ● | Cosmos, Microsoft Graph |
| `items/event-schema-set/[id]/versions/route.ts` | POST | owner-scoped | ● | Cosmos, Event Hubs, Event Hubs / Service Bus, Microsoft Graph |
| `items/event-schema-set/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/eventhouse/[id]/capacity/route.ts` | GET POST | session-only | ● | ADX, ARM, Managed Identity |
| `items/eventhouse/[id]/continuous-export/route.ts` | GET POST | owner-scoped |  | ADLS, ADX, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `items/eventhouse/[id]/database/route.ts` | POST DELETE | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph, Resource Graph |
| `items/eventhouse/[id]/ingest/preview/route.ts` | POST | session-only |  | Azure Storage |
| `items/eventhouse/[id]/ingest/route.ts` | POST | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/eventhouse/[id]/journal/route.ts` | GET | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/eventhouse/[id]/overview/route.ts` | GET | session-only |  | ADX, ARM, Managed Identity |
| `items/eventhouse/[id]/policies/route.ts` | POST PATCH | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph, Resource Graph |
| `items/eventhouse/[id]/purge/route.ts` | GET POST | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/eventhouse/[id]/route.ts` | GET | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph, Resource Graph |
| `items/eventstream/[id]/activator/route.ts` | GET POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure Monitor, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/eventstream/[id]/asa-sync/route.ts` | POST | owner-scoped |  | ADX, ARM, Azure SQL, Azure Storage, Cosmos, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/eventstream/[id]/assist/route.ts` | — | public |  | — |
| `items/eventstream/[id]/business-events/route.ts` | GET POST | owner-scoped | ● | Cosmos, Event Hubs, Event Hubs / Service Bus |
| `items/eventstream/[id]/definition/route.ts` | GET | owner-scoped |  | Cosmos, Fabric |
| `items/eventstream/[id]/events/route.ts` | GET POST | owner-scoped |  | ADLS, ADX, ARM, Azure Monitor, Azure Storage, Cosmos, Event Hubs, Event Hubs / Service Bus, Managed Identity |
| `items/eventstream/[id]/geo-reference/route.ts` | GET POST | owner-scoped | ● | ADLS, ADX, ARM, Azure SQL, Azure Storage, Cosmos, Event Hubs, IoT Hub, Managed Identity, PostgreSQL, Service Bus, Stream Analytics |
| `items/eventstream/[id]/mirror-cdf/route.ts` | GET POST | owner-scoped | ● | ADLS, ARM, Azure Storage, Cosmos, Event Hubs, Event Hubs / Service Bus, Managed Identity |
| `items/eventstream/[id]/provision/route.ts` | POST | owner-scoped | ● | ADX, ARM, Azure SQL, Azure Storage, Cosmos, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/eventstream/[id]/publish/route.ts` | POST | owner-scoped |  | Cosmos, Fabric |
| `items/eventstream/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos |
| `items/eventstream/[id]/source/route.ts` | POST | owner-scoped | ● | ADF, ADLS, ARM, Azure Storage, Cosmos, Event Hubs, Event Hubs / Service Bus, IoT Hub, Managed Identity, Resource Graph, Synapse |
| `items/eventstream/[id]/sql-operator/route.ts` | GET POST | owner-scoped |  | ADX, ARM, Azure SQL, Azure Storage, Cosmos, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/eventstream/spark-binding/route.ts` | GET PUT | admin |  | ARM, Cosmos, Databricks, Synapse |
| `items/feature-table/[id]/online/route.ts` | GET POST | owner-scoped |  | Azure Monitor, Cosmos, PostgreSQL |
| `items/feature-table/[id]/pit-join/route.ts` | POST | owner-scoped |  | Azure Monitor, Cosmos, PostgreSQL |
| `items/feature-table/[id]/route.ts` | GET POST DELETE | owner-scoped | ● | Azure Monitor, Cosmos, PostgreSQL |
| `items/feature-table/[id]/serve/route.ts` | POST | owner-scoped |  | AML, ARM, Azure Monitor, Cosmos, PostgreSQL |
| `items/fine-tuning-job/[id]/deploy/route.ts` | POST | owner-scoped | ● | ARM, Azure AI Services, Azure OpenAI, Cosmos |
| `items/fine-tuning-job/[id]/events/route.ts` | GET | owner-scoped |  | ARM, Azure AI Services, Cosmos |
| `items/fine-tuning-job/[id]/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | ARM, Azure AI Services, Azure OpenAI, Cosmos |
| `items/fine-tuning-job/[id]/safety-eval/route.ts` | POST | owner-scoped | ● | AML, ARM, Azure AI Services, Azure OpenAI, Cosmos |
| `items/geo-dataset/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/geo-map/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/geo-pipeline/[id]/run/route.ts` | POST | owner-scoped | ● | ADF, ARM, Compute, Cosmos, Microsoft Graph, Resource Graph |
| `items/geo-pipeline/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/geo-query/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/gql-graph/[id]/assist/route.ts` | — | public |  | — |
| `items/gql-graph/[id]/query/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/gql-graph/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/graph-model/[id]/materialize/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/graph-model/[id]/query/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/graph-model/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/graph-model/[id]/source-schema/route.ts` | GET | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/graph-model/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/graphql-api/[id]/publish/route.ts` | POST | owner-scoped |  | APIM, ARM, Cosmos, Microsoft Graph |
| `items/graphql-api/[id]/query/route.ts` | POST | owner-scoped |  | APIM, ARM, Cosmos, Microsoft Graph |
| `items/graphql-api/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/health-check/[id]/action-group/route.ts` | GET POST PUT | owner-scoped | ● | AI Search, ARM, Azure Monitor, Cosmos, Logic Apps, Microsoft Graph |
| `items/health-check/[id]/history/route.ts` | GET | owner-scoped | ● | ARM, Azure Monitor, Cosmos, Microsoft Graph |
| `items/health-check/[id]/route.ts` | — | public |  | — |
| `items/health-check/[id]/rule/[ruleId]/route.ts` | PATCH DELETE | owner-scoped | ● | AI Search, ARM, Azure Monitor, Cosmos, Microsoft Graph |
| `items/health-check/[id]/rule/[ruleId]/run/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Log Analytics, Managed Identity, Microsoft Graph |
| `items/health-check/[id]/rule/preview/route.ts` | POST | owner-scoped |  | ADX, ARM, Cosmos, Log Analytics, Managed Identity, Microsoft Graph |
| `items/health-check/[id]/rule/route.ts` | GET POST | owner-scoped | ● | AI Search, ARM, Azure Monitor, Cosmos, Microsoft Graph |
| `items/health-check/route.ts` | — | public |  | — |
| `items/integration-runtime/route.ts` | — | public |  | — |
| `items/kql-dashboard/[id]/activator/route.ts` | GET POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure Monitor, Azure SQL, Azure Storage, Compute, Cosmos, Log Analytics, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/kql-dashboard/[id]/generate-tile/route.ts` | POST | owner-scoped | ● | ADX, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Managed Identity |
| `items/kql-dashboard/[id]/param-values/route.ts` | POST | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity |
| `items/kql-dashboard/[id]/route.ts` | GET PUT | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity |
| `items/kql-dashboard/[id]/run/route.ts` | POST | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity |
| `items/kql-database/[id]/assist/route.ts` | POST | owner-scoped | ● | ADX, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Managed Identity |
| `items/kql-database/[id]/data-connections/route.ts` | GET POST DELETE | owner-scoped | ● | ADX, ARM, Cosmos, Event Hubs, IoT Hub, Managed Identity, Resource Graph |
| `items/kql-database/[id]/follower/route.ts` | GET POST DELETE | owner-scoped |  | ADX, ARM, Cosmos, Resource Graph |
| `items/kql-database/[id]/query/route.ts` | POST | owner-scoped |  | AAS, ADX, ARM, Azure Cache for Redis, Azure SQL, Azure Storage, Cosmos, Managed Identity, Power BI |
| `items/kql-database/[id]/route.ts` | GET | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity |
| `items/kql-database/[id]/schema-graph/route.ts` | GET | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity |
| `items/kql-database/[id]/tables/route.ts` | GET | owner-scoped |  | ADX, ARM, Cosmos, Managed Identity |
| `items/kql-queryset/[id]/assist/route.ts` | POST | owner-scoped | ● | ADX, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Managed Identity |
| `items/kql-queryset/[id]/route.ts` | GET POST PUT | owner-scoped | ● | Azure Monitor, Cosmos |
| `items/kql-queryset/[id]/run/route.ts` | POST | owner-scoped | ● | ADX, ARM, Azure Cache for Redis, Cosmos, Managed Identity |
| `items/lakebase-postgres/[id]/branches/route.ts` | GET POST | owner-scoped |  | ARM, Cosmos, Microsoft Graph, PostgreSQL |
| `items/lakebase-postgres/[id]/pgvector/route.ts` | GET POST | owner-scoped | ● | ARM, Cosmos, Microsoft Graph, PostgreSQL |
| `items/lakebase-postgres/[id]/provision/route.ts` | GET POST | owner-scoped |  | ARM, Cosmos, Microsoft Graph, PostgreSQL |
| `items/lakebase-postgres/[id]/query/route.ts` | POST | owner-scoped | ● | Cosmos, Microsoft Graph, PostgreSQL |
| `items/lakebase-postgres/[id]/replicas/route.ts` | GET POST | owner-scoped |  | ARM, Cosmos, Microsoft Graph, PostgreSQL |
| `items/lakebase-postgres/[id]/route.ts` | GET PATCH | owner-scoped |  | ARM, Cosmos, Databricks, Microsoft Graph, PostgreSQL |
| `items/lakebase-postgres/[id]/snapshot/route.ts` | GET POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/lakehouse-shortcut/route.ts` | GET POST DELETE | owner-scoped | ● | ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/lakehouse/[id]/abfss/route.ts` | GET | session-only |  | ADLS, Azure Storage, Cosmos |
| `items/lakehouse/[id]/assist/route.ts` | — | public |  | — |
| `items/lakehouse/[id]/query/route.ts` | POST | owner-scoped | ● | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/lakehouse/route.ts` | GET | session-only |  | Cosmos |
| `items/linked-service/route.ts` | — | public |  | — |
| `items/logic-app/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, ARM, Cosmos, Logic Apps, Microsoft Graph, Purview |
| `items/logic-app/[id]/run/route.ts` | POST | owner-scoped |  | AI Search, ARM, Cosmos, Logic Apps, Microsoft Graph |
| `items/logic-app/[id]/runs/route.ts` | GET | owner-scoped |  | ARM, Cosmos, Logic Apps, Microsoft Graph |
| `items/loom-app-runtime/[id]/assist/route.ts` | — | public |  | — |
| `items/loom-app-runtime/[id]/build/route.ts` | GET POST | owner-scoped |  | ACR, AI Search, ARM, Azure AI Services, Cosmos, Key Vault, Microsoft Graph |
| `items/loom-app-runtime/[id]/context/route.ts` | GET | owner-scoped |  | AI Search, Azure AI Services, Cosmos, Microsoft Graph |
| `items/loom-app-runtime/[id]/deploy/route.ts` | POST | owner-scoped |  | AI Search, ARM, Azure AI Services, Container Apps, Cosmos, Microsoft Graph |
| `items/loom-app-runtime/[id]/export/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/loom-app-runtime/[id]/git-credential/route.ts` | GET POST DELETE | owner-scoped | ● | Azure DevOps, Cosmos, Key Vault, Microsoft Graph |
| `items/loom-app-runtime/[id]/lifecycle/route.ts` | POST | owner-scoped |  | ARM, Container Apps, Cosmos, Microsoft Graph |
| `items/loom-app-runtime/[id]/logs/route.ts` | GET | owner-scoped |  | Cosmos, Log Analytics, Microsoft Graph |
| `items/loom-app-runtime/[id]/mcp/route.ts` | POST | owner-scoped |  | ARM, Azure Monitor, Container Apps, Cosmos, Microsoft Graph |
| `items/loom-app-runtime/[id]/monitoring/route.ts` | GET | owner-scoped | ● | ARM, Azure Cache for Redis, Container Apps, Cosmos, Cost Management, Microsoft Graph |
| `items/loom-app-runtime/[id]/publish-api/route.ts` | POST | owner-scoped | ● | APIM, ARM, Container Apps, Cosmos, Microsoft Graph, Purview |
| `items/loom-app-runtime/[id]/publish-mcp/route.ts` | POST DELETE | owner-scoped |  | ARM, Container Apps, Cosmos, Microsoft Graph |
| `items/loom-app-runtime/[id]/reconcile/route.ts` | GET POST | owner-scoped |  | ACR, AI Search, ARM, Azure AI Services, Cosmos, Key Vault, Microsoft Graph |
| `items/loom-app-runtime/[id]/resources/route.ts` | GET POST DELETE | owner-scoped | ● | ADLS, ADX, AI Search, ARM, Azure AI Services, Azure RBAC, Azure Storage, Cosmos, Event Hubs, Key Vault, Microsoft Graph, PostgreSQL, Resource Graph |
| `items/loom-app-runtime/[id]/route.ts` | GET DELETE | owner-scoped |  | ARM, Container Apps, Cosmos, Microsoft Graph |
| `items/loom-app-runtime/config/route.ts` | GET | session-only |  | — |
| `items/loom-app-runtime/import/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure AI Services, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/loom-app/[id]/candidates/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/loom-app/[id]/publish/route.ts` | POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/loom-app/[id]/render/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/loom-app/[id]/route.ts` | — | public |  | — |
| `items/map/[id]/geocode/route.ts` | POST | owner-scoped | ● | Azure Maps, Cosmos, Microsoft Graph |
| `items/map/[id]/map-token/route.ts` | GET | owner-scoped |  | Azure Maps, Cosmos, Microsoft Graph |
| `items/map/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/mapping-dataflow/[id]/debug/preview/route.ts` | POST | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `items/mapping-dataflow/[id]/debug/schema/route.ts` | POST | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `items/mapping-dataflow/[id]/debug/session/route.ts` | POST | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `items/mapping-dataflow/[id]/debug/stats/route.ts` | POST | session-only | ● | ADF, ADX, ARM, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics, Resource Graph |
| `items/materialized-lake-view/[id]/adf-pipeline/route.ts` | GET POST | owner-scoped | ● | ADF, ADLS, ARM, Azure Storage, Cosmos, Resource Graph |
| `items/materialized-lake-view/[id]/assist/route.ts` | — | public |  | — |
| `items/materialized-lake-view/[id]/lineage/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/materialized-lake-view/[id]/preview/route.ts` | POST | owner-scoped | ● | ADLS, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |
| `items/materialized-lake-view/[id]/refresh/route.ts` | POST | owner-scoped |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Synapse |
| `items/materialized-lake-view/[id]/runs/route.ts` | GET | owner-scoped | ● | Cosmos, Synapse |
| `items/mirrored-database/[id]/assist/route.ts` | — | public |  | — |
| `items/mirrored-database/[id]/lifecycle/route.ts` | POST | owner-scoped |  | ADF, ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, Microsoft Graph, PostgreSQL, Resource Graph |
| `items/mirrored-database/[id]/monitor/route.ts` | GET | owner-scoped |  | ADF, ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Resource Graph |
| `items/mirrored-database/[id]/open-mirror/route.ts` | GET POST | owner-scoped | ● | ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Synapse |
| `items/mirrored-database/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/mirrored-database/[id]/sources/route.ts` | GET POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/mirrored-database/[id]/sql-endpoint/route.ts` | GET | owner-scoped |  | Azure SQL, Cosmos, Microsoft Graph, Synapse SQL |
| `items/mirrored-database/[id]/state/route.ts` | POST | owner-scoped |  | ADF, ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, Microsoft Graph, PostgreSQL, Resource Graph |
| `items/mirrored-database/[id]/tables/route.ts` | GET | owner-scoped |  | ARM, Azure SQL, Cosmos, Key Vault, Microsoft Graph, PostgreSQL |
| `items/mirrored-database/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/mirrored-database/source-tables/route.ts` | POST | session-only |  | ARM, Azure SQL, Cosmos, PostgreSQL |
| `items/mirrored-database/verify/route.ts` | POST | session-only | ● | Azure SQL |
| `items/mirrored-databricks/[id]/catalog/route.ts` | GET | owner-scoped |  | Azure Monitor, Cosmos, Databricks, Microsoft Graph |
| `items/mirrored-databricks/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/mirrored-databricks/[id]/sql-endpoint/route.ts` | GET | owner-scoped |  | Azure SQL, Cosmos, Microsoft Graph, Synapse SQL |
| `items/mirrored-databricks/catalogs/route.ts` | GET | session-only |  | Azure Monitor, Cosmos |
| `items/mirrored-databricks/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure Monitor, Azure SQL, Azure Storage, Compute, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `items/ml-experiment/[id]/assist/route.ts` | — | public |  | — |
| `items/ml-experiment/[id]/register/route.ts` | POST | session-only |  | AML, ARM |
| `items/ml-experiment/[id]/route.ts` | GET | session-only |  | AML, ARM |
| `items/ml-experiment/[id]/runs/[runId]/metrics/route.ts` | GET | session-only |  | AML, ARM |
| `items/ml-experiment/[id]/runs/route.ts` | GET | session-only |  | AML, ARM |
| `items/ml-experiment/route.ts` | GET | session-only |  | AML, ARM |
| `items/ml-experiment/submit/route.ts` | POST | session-only |  | AML, ARM |
| `items/ml-model/[id]/bind/route.ts` | GET POST | owner-scoped |  | AML, ARM, Cosmos |
| `items/ml-model/[id]/endpoint/route.ts` | GET POST PATCH DELETE | owner-scoped |  | AML, ARM, Cosmos |
| `items/ml-model/[id]/predict/history/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/ml-model/[id]/predict/route.ts` | GET POST | owner-scoped |  | ADLS, AML, ARM, Azure Storage, Cosmos, Synapse |
| `items/ml-model/[id]/predict/status/route.ts` | GET | owner-scoped |  | AML, ARM, Azure Storage, Cosmos, Synapse |
| `items/ml-model/[id]/register/route.ts` | POST | owner-scoped |  | AML, ARM, Cosmos |
| `items/ml-model/[id]/route.ts` | GET | owner-scoped |  | AML, ARM, Cosmos |
| `items/ml-model/[id]/stage/route.ts` | GET POST | owner-scoped |  | AML, ARM, Cosmos |
| `items/ml-model/route.ts` | GET | session-only |  | AML, ARM |
| `items/model-serving-endpoint/[id]/invoke/route.ts` | POST | owner-scoped |  | AML, ARM, Azure Monitor, Cosmos, PostgreSQL |
| `items/model-serving-endpoint/[id]/metrics/route.ts` | GET | owner-scoped |  | AML, ARM, Cosmos |
| `items/model-serving-endpoint/[id]/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | AML, ARM, Azure Monitor, Cosmos |
| `items/model-serving-endpoint/[id]/traffic/route.ts` | POST | owner-scoped |  | AML, ARM, Azure Monitor, Cosmos |
| `items/mounted-adf/[id]/route.ts` | GET DELETE | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/mounted-adf/[id]/run/route.ts` | POST | owner-scoped |  | ADF, ARM, Cosmos, Microsoft Graph, Resource Graph |
| `items/mounted-adf/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/notebook/[id]/deploy-app/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure Cache for Redis, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/notebook/[id]/execute-spark/route.ts` | GET POST | owner-scoped |  | AML, ARM, Azure Storage, Cosmos, Microsoft Graph, Synapse |
| `items/notebook/[id]/jobs/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Microsoft Graph |
| `items/notebook/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/notebook/[id]/run/route.ts` | POST | owner-scoped |  | ADLS, AML, ARM, Azure Monitor, Azure Storage, Cosmos, Microsoft Graph, Synapse |
| `items/notebook/[id]/runs/[runId]/log/route.ts` | GET | owner-scoped |  | AML, Cosmos, Microsoft Graph, Synapse |
| `items/notebook/[id]/runs/[runId]/route.ts` | GET DELETE | owner-scoped |  | AML, ARM, Azure Monitor, Cosmos, Microsoft Graph, Synapse |
| `items/notebook/import/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/notebook/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos |
| `items/notepad/[id]/run-block/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/ontology-sdk/[id]/bind-ontology/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/ontology-sdk/[id]/generate/route.ts` | POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/ontology-sdk/[id]/publish/route.ts` | POST | owner-scoped | ● | AI Search, APIM, ARM, Cosmos, Microsoft Graph, Purview |
| `items/ontology-sdk/[id]/query/route.ts` | POST | owner-scoped | ● | Cosmos, Microsoft Graph |
| `items/ontology-sdk/[id]/route.ts` | — | public |  | — |
| `items/ontology-sdk/route.ts` | — | public |  | — |
| `items/ontology/[id]/activator/route.ts` | GET POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure Monitor, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/ontology/[id]/approvals/route.ts` | GET POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/ontology/[id]/audit-export/route.ts` | GET POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/ontology/[id]/bind/route.ts` | GET POST DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/ontology/[id]/datasource/route.ts` | GET | owner-scoped | ● | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/ontology/[id]/explore/route.ts` | GET POST DELETE | owner-scoped | ● | AI Search, Cosmos, Microsoft Graph, PostgreSQL |
| `items/ontology/[id]/justifications/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/ontology/[id]/links/route.ts` | GET POST DELETE | owner-scoped | ● | Cosmos, Microsoft Graph, PostgreSQL |
| `items/ontology/[id]/objects/[vertexId]/view/route.ts` | GET | admin | ● | ADLS, Cosmos, Key Vault, Microsoft Graph, PostgreSQL |
| `items/ontology/[id]/objects/route.ts` | GET POST | admin | ● | ADLS, Cosmos, Microsoft Graph, PostgreSQL |
| `items/ontology/[id]/resolve/route.ts` | GET | admin |  | AAS, ADLS, ADX, ARM, Azure Cache for Redis, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/ontology/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/ontology/[id]/run-action/route.ts` | GET POST | admin | ● | ADLS, Cosmos, Key Vault, Microsoft Graph, PostgreSQL, Purview |
| `items/ontology/[id]/sync/route.ts` | GET POST DELETE | owner-scoped | ● | ADLS, AI Search, ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Synapse SQL |
| `items/operations-agent/[id]/deploy/route.ts` | POST | owner-scoped | ● | AI Foundry, ARM, Azure Monitor, Cosmos, Microsoft Graph |
| `items/operations-agent/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/operations-agent/[id]/rules/route.ts` | GET POST DELETE | owner-scoped | ● | ADX, ARM, Azure Monitor, Cosmos, Log Analytics, Managed Identity, Microsoft Graph |
| `items/operations-agent/[id]/run/route.ts` | POST | owner-scoped |  | AAS, ADX, AI Foundry, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/paginated-report/[id]/definition/route.ts` | GET PUT | owner-scoped |  | Cosmos |
| `items/paginated-report/[id]/export/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/paginated-report/[id]/preview/route.ts` | POST | session-only |  | ARM, Azure SQL, Managed Identity |
| `items/paginated-report/[id]/rdl/route.ts` | GET PUT | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/paginated-report/[id]/render/route.ts` | POST | owner-scoped |  | AAS, ARM, Azure SQL, Cosmos, Fabric, Managed Identity, Power BI, Synapse SQL |
| `items/paginated-report/[id]/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/paginated-report/capabilities/route.ts` | GET | session-only |  | — |
| `items/paginated-report/route.ts` | GET | session-only |  | Fabric, Power BI |
| `items/plan/[id]/approval-callback/route.ts` | POST | public | ● | AAS, Cosmos |
| `items/plan/[id]/approval/route.ts` | GET POST | owner-scoped | ● | AI Search, ARM, Cosmos, Logic Apps, Microsoft Graph |
| `items/plan/[id]/binding/route.ts` | GET POST | owner-scoped | ● | AI Search, Azure SQL, Cosmos, Microsoft Graph |
| `items/plan/[id]/copilot/route.ts` | POST | owner-scoped |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Microsoft Graph |
| `items/plan/[id]/model/route.ts` | GET POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/plan/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/plan/[id]/writeback/route.ts` | GET POST | owner-scoped | ● | Azure SQL, Cosmos, Microsoft Graph |
| `items/postgres-flexible-server/[id]/databases/route.ts` | GET | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/postgres-flexible-server/[id]/firewall/route.ts` | GET POST DELETE | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/postgres-flexible-server/[id]/query/route.ts` | POST | owner-scoped |  | ARM, Azure SQL, Cosmos, Microsoft Graph, PostgreSQL |
| `items/postgres-flexible-server/route.ts` | GET POST | session-only |  | ARM, PostgreSQL |
| `items/power-app/[id]/publish/route.ts` | POST | owner-scoped |  | Cosmos, Power Automate, Power Platform |
| `items/power-app/[id]/route.ts` | GET | owner-scoped |  | Cosmos, Power Automate, Power Platform |
| `items/power-app/[id]/state/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/power-app/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/power-automate-flow/[id]/definition/route.ts` | GET POST PATCH | session-only | ● | Power Automate, Power Platform |
| `items/power-automate-flow/[id]/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/power-automate-flow/[id]/run/route.ts` | POST | session-only |  | Power Automate, Power Platform |
| `items/power-automate-flow/[id]/runs/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/power-automate-flow/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/power-page/[id]/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/power-page/route.ts` | GET | session-only |  | Power Automate, Power Platform |
| `items/prompt-flow/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AML, ARM, Cosmos |
| `items/prompt-flow/[id]/run/route.ts` | POST | owner-scoped |  | AML, ARM, Cosmos, Microsoft Graph |
| `items/prompt-flow/route.ts` | GET POST | session-only |  | AML, ARM |
| `items/rayfin-app/[id]/render/route.ts` | POST | owner-scoped | ● | AAS, Cosmos, Microsoft Graph |
| `items/rayfin-app/[id]/route.ts` | GET PUT PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/rayfin-app/model-objects/route.ts` | GET | session-only | ● | AAS |
| `items/rayfin-app/models/route.ts` | GET | session-only | ● | AAS, ARM |
| `items/rayfin-app/preview/route.ts` | POST | session-only | ● | AAS |
| `items/recent/route.ts` | GET | session-only |  | Cosmos |
| `items/release-environment/[id]/approve/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Dev Center, Microsoft Graph |
| `items/release-environment/[id]/arm/route.ts` | GET | session-only |  | ARM |
| `items/release-environment/[id]/promote/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Dev Center, Microsoft Graph |
| `items/release-environment/[id]/route.ts` | — | public |  | — |
| `items/release-environment/[id]/swap/route.ts` | GET POST | owner-scoped | ● | AI Search, ARM, App Service, Cosmos, Microsoft Graph |
| `items/release-environment/route.ts` | — | public |  | — |
| `items/report/[id]/ai-visual/route.ts` | POST | owner-scoped |  | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Microsoft Graph |
| `items/report/[id]/connector-objects/route.ts` | POST | owner-scoped |  | ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, PostgreSQL, Synapse SQL |
| `items/report/[id]/connector-preview/route.ts` | POST | owner-scoped |  | ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, PostgreSQL, Synapse SQL |
| `items/report/[id]/data-source/route.ts` | GET PUT | owner-scoped |  | AAS, AI Search, Cosmos, Microsoft Graph |
| `items/report/[id]/definition/route.ts` | PUT | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/report/[id]/embed-token/route.ts` | POST | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/report/[id]/endorsement/route.ts` | GET PUT PATCH | owner-scoped |  | AI Search, ARM, Azure RBAC, Cosmos, Microsoft Graph |
| `items/report/[id]/export/route.ts` | POST | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/report/[id]/fields/route.ts` | GET | owner-scoped |  | AAS, ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, PostgreSQL, Power BI, Synapse SQL |
| `items/report/[id]/map-token/route.ts` | GET | owner-scoped |  | Azure Maps, Cosmos |
| `items/report/[id]/native-query/route.ts` | GET | owner-scoped |  | AAS, ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, PostgreSQL, Synapse SQL |
| `items/report/[id]/pages/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Power BI |
| `items/report/[id]/paginated-embed-token/route.ts` | POST | owner-scoped | ● | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/report/[id]/powerbi-copilot/route.ts` | POST | owner-scoped |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Dataverse, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `items/report/[id]/profile/route.ts` | GET POST | owner-scoped |  | AAS, ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, PostgreSQL, Synapse SQL |
| `items/report/[id]/publish/route.ts` | POST DELETE | owner-scoped |  | Cosmos, Fabric |
| `items/report/[id]/query/route.ts` | POST | owner-scoped |  | AAS, ADLS, ADX, ARM, Azure Cache for Redis, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Fabric, Key Vault, Managed Identity, PostgreSQL, Power BI, Synapse SQL |
| `items/report/[id]/refresh/route.ts` | GET POST | owner-scoped | ● | AAS, ADLS, ADX, AI Search, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Fabric, Key Vault, Managed Identity, Microsoft Graph, PostgreSQL, Power BI, Synapse, Synapse SQL |
| `items/report/[id]/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Power BI |
| `items/report/[id]/script-visual/route.ts` | POST | owner-scoped |  | AAS, ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, PostgreSQL, Synapse SQL |
| `items/report/[id]/sensitivity/route.ts` | GET PUT | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/report/[id]/subscriptions/[subId]/logs/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/report/[id]/subscriptions/[subId]/route.ts` | PATCH DELETE | owner-scoped |  | Cosmos |
| `items/report/[id]/subscriptions/route.ts` | GET POST | session-only |  | Cosmos |
| `items/report/[id]/visual-data/route.ts` | POST | owner-scoped |  | AAS, ADLS, ADX, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, Microsoft Graph, PostgreSQL, Synapse SQL |
| `items/report/[id]/visual/route.ts` | POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/report/copilot/route.ts` | POST | owner-scoped |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Dataverse, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `items/report/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Power BI |
| `items/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/scorecard/[id]/config/route.ts` | GET PATCH | owner-scoped |  | Cosmos |
| `items/scorecard/[id]/goals/route.ts` | GET POST DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/scorecard/[id]/metric-value/route.ts` | GET | session-only |  | AAS, ARM, Azure SQL, Cosmos, Fabric, Managed Identity, Power BI, Synapse SQL |
| `items/scorecard/[id]/route.ts` | GET POST PUT | owner-scoped |  | Cosmos, Fabric, Power BI |
| `items/scorecard/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Power BI |
| `items/semantic-model/[id]/content/route.ts` | GET PUT | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/semantic-model/[id]/copilot-structure/route.ts` | GET POST | owner-scoped |  | AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/datasource/route.ts` | GET POST PUT | owner-scoped | ● | AAS, ADX, ARM, Azure SQL, Cosmos, Fabric, Key Vault, Managed Identity, Microsoft Graph, Power BI, Synapse SQL |
| `items/semantic-model/[id]/dax-query/route.ts` | POST | owner-scoped |  | AAS, AI Search, ARM, Azure Cache for Redis, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/semantic-model/[id]/describe-bulk/route.ts` | GET POST | owner-scoped |  | AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/direct-lake/route.ts` | GET POST PUT | owner-scoped | ● | ADLS, ARM, Azure Cache for Redis, Azure SQL, Azure Storage, Cosmos, Event Grid, Fabric, Managed Identity, Microsoft Graph, Power BI, Synapse SQL |
| `items/semantic-model/[id]/embed-token/route.ts` | POST | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/ingest/route.ts` | POST | owner-scoped | ● | AAS, ADF, ADLS, ARM, Azure Storage, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `items/semantic-model/[id]/measures/route.ts` | POST | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/model-health/route.ts` | GET POST | owner-scoped |  | AAS, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos, Microsoft Graph |
| `items/semantic-model/[id]/model/route.ts` | GET POST PUT PATCH DELETE | owner-scoped |  | AAS, AI Search, Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/prep-for-ai/route.ts` | GET POST | owner-scoped |  | AAS, AI Search, ARM, Azure Cache for Redis, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/semantic-model/[id]/refresh-policy/route.ts` | GET PUT | owner-scoped | ● | Cosmos, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/refresh-schedule/route.ts` | GET PATCH | owner-scoped | ● | AAS, ARM, Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/refresh/route.ts` | GET POST | owner-scoped | ● | AAS, Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/refreshes/route.ts` | GET POST | owner-scoped | ● | AAS, Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/roles/route.ts` | GET POST PUT | owner-scoped | ● | AAS, AI Search, ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Power BI, Synapse SQL |
| `items/semantic-model/[id]/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Power BI |
| `items/semantic-model/[id]/semantic-link/route.ts` | GET POST | owner-scoped |  | AAS, ARM, Azure Cache for Redis, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/semantic-model/[id]/synonyms/route.ts` | GET PUT | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/semantic-model/[id]/take-over/route.ts` | POST | owner-scoped |  | Cosmos, Fabric, Microsoft Graph, Power BI |
| `items/semantic-model/[id]/verified-queries/route.ts` | GET POST | owner-scoped |  | Azure Monitor, Cosmos, Microsoft Graph |
| `items/semantic-model/aas-databases/route.ts` | GET | session-only | ● | AAS, ARM |
| `items/semantic-model/build/route.ts` | POST | session-only |  | Fabric, Power BI |
| `items/semantic-model/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Power BI |
| `items/semantic-model/scaffold/route.ts` | POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `items/semantic-model/workspace-pane/route.ts` | GET POST | owner-scoped | ● | AAS, ARM, Cosmos, Fabric |
| `items/service-bus-namespace/data-explorer/route.ts` | POST | session-only | ● | Event Hubs / Service Bus, Service Bus |
| `items/service-bus-namespace/route.ts` | GET POST DELETE | session-only | ● | ARM, Cosmos, Microsoft Graph, Service Bus |
| `items/slate-app/[id]/generate/route.ts` | POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `items/slate-app/[id]/publish/route.ts` | POST | owner-scoped |  | AI Search, ARM, App Service, Cosmos, Microsoft Graph |
| `items/slate-app/[id]/query/run/route.ts` | POST | owner-scoped | ● | ADX, ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `items/slate-app/[id]/route.ts` | — | public |  | — |
| `items/slate-app/route.ts` | — | public |  | — |
| `items/spark-environment/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/spark-environment/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/spark-job-definition/[id]/files/route.ts` | POST | owner-scoped | ● | ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `items/spark-job-definition/[id]/lineage-targets/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/spark-job-definition/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/spark-job-definition/[id]/runs/[runId]/cancel/route.ts` | POST | owner-scoped | ● | Cosmos, Microsoft Graph, Synapse |
| `items/spark-job-definition/[id]/runs/[runId]/route.ts` | GET | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph, Purview, Synapse |
| `items/spark-job-definition/[id]/runs/route.ts` | GET | owner-scoped | ● | Cosmos, Microsoft Graph, Synapse |
| `items/spark-job-definition/[id]/submit/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph, Synapse |
| `items/spark-job-definition/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/sql-analytics-endpoint/[id]/objects/route.ts` | — | public |  | — |
| `items/sql-analytics-endpoint/[id]/query/route.ts` | — | public |  | — |
| `items/sql-analytics-endpoint/[id]/schema/route.ts` | — | public |  | — |
| `items/sql-database/[id]/route.ts` | GET DELETE | owner-scoped |  | Azure SQL, Cosmos, Fabric, PostgreSQL |
| `items/sql-database/route.ts` | GET POST | owner-scoped |  | Azure SQL, Cosmos, Fabric, PostgreSQL |
| `items/sql-databases/route.ts` | GET | session-only |  | ARM, Azure SQL, PostgreSQL |
| `items/sql-server-2025-vector-index/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/stream-analytics-job/[name]/assist/route.ts` | — | public |  | — |
| `items/stream-analytics-job/[name]/inputs/route.ts` | PUT DELETE | session-only |  | ADX, ARM, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/stream-analytics-job/[name]/metrics/route.ts` | GET | session-only |  | ADX, ARM, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/stream-analytics-job/[name]/outputs/route.ts` | PUT DELETE | session-only |  | ADX, ARM, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/stream-analytics-job/[name]/query/route.ts` | PUT | session-only |  | ADX, ARM, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/stream-analytics-job/[name]/route.ts` | GET | session-only |  | ADX, ARM, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/stream-analytics-job/[name]/state/route.ts` | POST | session-only |  | ADX, ARM, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/stream-analytics-job/[name]/test/route.ts` | POST | session-only |  | ADX, ARM, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/stream-analytics-job/route.ts` | GET | session-only |  | ADX, ARM, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `items/synapse-dedicated-sql-pool/[id]/cancel/route.ts` | POST | session-only |  | Azure SQL |
| `items/synapse-dedicated-sql-pool/[id]/clone/route.ts` | POST | owner-scoped |  | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/synapse-dedicated-sql-pool/[id]/connection/route.ts` | GET | session-only |  | Azure Monitor, Azure SQL, Cosmos, Synapse SQL |
| `items/synapse-dedicated-sql-pool/[id]/model/route.ts` | — | public |  | — |
| `items/synapse-dedicated-sql-pool/[id]/query-history/route.ts` | GET | session-only |  | ARM, Azure SQL, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `items/synapse-dedicated-sql-pool/[id]/query/route.ts` | POST | owner-scoped |  | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/synapse-dedicated-sql-pool/[id]/resume/route.ts` | POST | session-only |  | ARM, Resource Graph, Synapse |
| `items/synapse-dedicated-sql-pool/[id]/schema/route.ts` | GET | owner-scoped |  | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/synapse-dedicated-sql-pool/[id]/script-out/route.ts` | GET | owner-scoped |  | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/synapse-dedicated-sql-pool/[id]/state/route.ts` | GET POST | session-only |  | ARM, Resource Graph, Synapse |
| `items/synapse-notebook/[id]/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/synapse-pipeline/[id]/bind/route.ts` | GET POST | owner-scoped |  | ADF, Cosmos, Microsoft Graph, Synapse |
| `items/synapse-pipeline/[id]/connections/route.ts` | GET | session-only | ● | ADF, ARM, Resource Graph, Synapse |
| `items/synapse-pipeline/[id]/copilot/route.ts` | POST | owner-scoped |  | AAS, ADF, ADLS, ADX, AI Foundry, AI Search, AKS, AML, APIM, ARM, Azure AI Services, Azure Cache for Redis, Azure Monitor, Azure Networking, Azure OpenAI, Azure SQL, Azure Storage, Batch, Compute, Container Apps, Cosmos, Cost Management, Dataverse, Event Grid, Event Hubs, Fabric, IoT Hub, Key Vault, Log Analytics, Managed Identity, Microsoft Graph, Microsoft Sentinel, PostgreSQL, Power Automate, Power BI, Power Platform, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `items/synapse-pipeline/[id]/debug/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph, Synapse |
| `items/synapse-pipeline/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos, Microsoft Graph, Synapse |
| `items/synapse-pipeline/[id]/run/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph, Synapse |
| `items/synapse-pipeline/[id]/runs/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph, Synapse |
| `items/synapse-pipeline/[id]/triggers/route.ts` | GET POST | owner-scoped |  | Cosmos, Microsoft Graph, Synapse |
| `items/synapse-pipeline/list/route.ts` | GET | session-only |  | Synapse |
| `items/synapse-serverless-sql-pool/[id]/cancel/route.ts` | POST | session-only |  | Azure SQL |
| `items/synapse-serverless-sql-pool/[id]/connection/route.ts` | GET | session-only |  | Azure Monitor, Azure SQL, Cosmos, Synapse SQL |
| `items/synapse-serverless-sql-pool/[id]/iqy/route.ts` | POST | session-only |  | — |
| `items/synapse-serverless-sql-pool/[id]/objects/route.ts` | GET | session-only | ● | ARM, Azure SQL, Managed Identity, Synapse SQL |
| `items/synapse-serverless-sql-pool/[id]/query/route.ts` | POST | session-only |  | ARM, Azure SQL, Cosmos, Managed Identity, Synapse SQL |
| `items/synapse-serverless-sql-pool/[id]/schema/route.ts` | GET | session-only |  | ARM, Azure SQL, Managed Identity, Synapse SQL |
| `items/synapse-spark-pool/[id]/auto-pause/route.ts` | POST | session-only |  | ARM, Resource Graph, Synapse |
| `items/synapse-spark-pool/[id]/config/route.ts` | POST | session-only |  | ARM, Resource Graph, Synapse |
| `items/synapse-spark-pool/[id]/route.ts` | GET PUT | session-only |  | ARM, Resource Graph, Synapse |
| `items/synapse-spark-pool/[id]/runs/route.ts` | GET | session-only |  | Synapse |
| `items/synapse-spark-pool/[id]/scale/route.ts` | POST | session-only |  | ARM, Resource Graph, Synapse |
| `items/synapse-spark-pool/[id]/state/route.ts` | GET POST | session-only |  | ARM, Resource Graph, Synapse |
| `items/synapse-spark-pool/[id]/submit/route.ts` | POST | session-only |  | Synapse |
| `items/synapse-spark-pool/list/route.ts` | GET | session-only |  | ARM, Resource Graph, Synapse |
| `items/synthetic-data/[id]/catalog/route.ts` | GET | owner-scoped | ● | Azure Monitor, Cosmos, Microsoft Graph |
| `items/synthetic-data/[id]/generate/route.ts` | POST | owner-scoped | ● | AI Search, Azure Monitor, Cosmos, Microsoft Graph |
| `items/synthetic-data/[id]/preview/route.ts` | POST | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/synthetic-data/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/synthetic-data/[id]/sources/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `items/tapestry/[id]/databases/route.ts` | GET | owner-scoped | ● | Cosmos, Microsoft Graph |
| `items/tapestry/[id]/geo/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/tapestry/[id]/link/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/tapestry/[id]/timeline/route.ts` | POST | owner-scoped | ● | ADX, ARM, Cosmos, Managed Identity, Microsoft Graph |
| `items/tracing/[traceId]/route.ts` | GET | session-only |  | AML, ARM |
| `items/tracing/route.ts` | GET | session-only |  | AML, ARM |
| `items/transformation-project/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/transformation-project/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/user-data-function/[id]/invoke/route.ts` | POST | owner-scoped |  | Cosmos, Fabric, Key Vault, Microsoft Graph |
| `items/user-data-function/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/user-data-function/endpoints/route.ts` | GET | session-only |  | — |
| `items/variable-library/[id]/resolve/route.ts` | POST | owner-scoped |  | Cosmos, Key Vault, Microsoft Graph |
| `items/variable-library/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/vector-store/[id]/index/route.ts` | GET POST PUT | session-only |  | AI Search, PostgreSQL |
| `items/vector-store/[id]/search/route.ts` | POST | session-only | ● | AI Search, AML, ARM, Azure AI Services, Azure OpenAI, PostgreSQL |
| `items/vector-store/[id]/sync/route.ts` | GET POST | session-only |  | AI Search, AML, ARM, Azure AI Services, Azure OpenAI, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |
| `items/vector-store/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/warehouse/[id]/cancel/route.ts` | POST | session-only |  | Azure SQL |
| `items/warehouse/[id]/clone/route.ts` | POST | owner-scoped | ● | ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/warehouse/[id]/copy-into/route.ts` | GET POST | owner-scoped |  | ADLS, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/warehouse/[id]/iqy/route.ts` | POST | session-only |  | — |
| `items/warehouse/[id]/model/route.ts` | — | public |  | — |
| `items/warehouse/[id]/query-acceleration/route.ts` | GET POST | session-only | ● | ARM, Azure SQL, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `items/warehouse/[id]/query/route.ts` | POST | owner-scoped |  | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/warehouse/[id]/restore-points/route.ts` | GET POST | session-only | ● | ARM, Resource Graph, Synapse |
| `items/warehouse/[id]/schema/route.ts` | GET | owner-scoped |  | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/warehouse/[id]/script-out/route.ts` | GET | owner-scoped |  | ARM, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Resource Graph, Synapse, Synapse SQL |
| `items/warehouse/[id]/snapshots/route.ts` | GET POST | session-only | ● | ADLS, ARM, Azure Monitor, Azure Storage, Cosmos, Managed Identity |
| `items/warehouse/[id]/time-travel/route.ts` | GET POST | session-only | ● | ADLS, ARM, Azure Monitor, Azure Storage, Cosmos, Managed Identity |
| `items/warehouse/migrate/import/route.ts` | POST | session-only | ● | ARM, Azure SQL, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `items/warehouse/migrate/scan/route.ts` | POST | session-only |  | — |
| `items/workshop-app/[id]/bind-ontology/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `items/workshop-app/[id]/eject/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `items/workshop-app/[id]/publish/route.ts` | POST | owner-scoped |  | AI Search, ARM, App Service, Cosmos, Microsoft Graph |
| `items/workshop-app/[id]/route.ts` | — | public |  | — |
| `items/workshop-app/[id]/run-action/route.ts` | POST | owner-scoped | ● | ARM, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Purview, Synapse SQL |
| `items/workshop-app/route.ts` | — | public |  | — |

## keyvault

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `keyvault/secret-names/route.ts` | GET | admin |  | ARM, Key Vault, Managed Identity |

## lakehouse

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `lakehouse/ai-clean-suggest/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `lakehouse/containers/route.ts` | GET | session-only |  | ADLS, ARM, Azure Storage, Managed Identity |
| `lakehouse/download/route.ts` | GET | session-only |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Purview |
| `lakehouse/history/route.ts` | GET POST | session-only | ● | ADLS, ARM, Azure Monitor, Azure Storage, Cosmos, Managed Identity |
| `lakehouse/interop/route.ts` | GET PUT | session-only | ● | ADLS, ADX, Azure Monitor, Azure Networking, Azure Storage, Container Apps, Cosmos, Cost Management, Log Analytics, Synapse |
| `lakehouse/load-to-table/route.ts` | POST | session-only | ● | ADLS, ARM, Azure Storage, Resource Graph, Synapse |
| `lakehouse/maintenance/route.ts` | GET POST | session-only |  | ADLS, Azure Storage, Cosmos, Synapse |
| `lakehouse/path/route.ts` | POST DELETE | session-only |  | ADLS, ARM, Azure Storage, Managed Identity |
| `lakehouse/paths/route.ts` | GET | owner-scoped |  | AAS, ADLS, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Power BI |
| `lakehouse/permissions/rls-test/route.ts` | POST | session-only |  | ARM, Azure SQL, Managed Identity, Synapse SQL |
| `lakehouse/permissions/route.ts` | GET POST DELETE | admin |  | ADLS, ARM, Azure RBAC, Azure SQL, Azure Storage, Managed Identity, Microsoft Graph, Resource Graph, Synapse SQL |
| `lakehouse/preview/route.ts` | GET | session-only |  | ADLS, ARM, Azure SQL, Azure Storage, Managed Identity, Synapse SQL |
| `lakehouse/references/paths/route.ts` | GET | owner-scoped |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity |
| `lakehouse/references/route.ts` | GET POST | owner-scoped |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity |
| `lakehouse/schemas/route.ts` | GET POST PATCH DELETE | session-only | ● | Cosmos, Synapse |
| `lakehouse/settings/route.ts` | GET PUT | session-only | ● | ADLS, Azure Monitor, Azure Storage, Cosmos |
| `lakehouse/shortcuts/browse/route.ts` | GET | session-only | ● | ADLS, ARM, Azure Storage, Key Vault, Managed Identity |
| `lakehouse/shortcuts/credentials/route.ts` | POST | session-only | ● | Key Vault |
| `lakehouse/shortcuts/route.ts` | GET POST DELETE | session-only |  | ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, Microsoft Graph, Synapse SQL |
| `lakehouse/shortcuts/sharepoint/route.ts` | GET | session-only | ● | Microsoft Graph |
| `lakehouse/shortcuts/test/route.ts` | POST | session-only | ● | ADLS, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Key Vault, Managed Identity, Microsoft Graph, Synapse SQL |
| `lakehouse/table-stats/route.ts` | GET | session-only | ● | ADLS, Azure Storage, Synapse |
| `lakehouse/tables/route.ts` | GET | owner-scoped |  | ADLS, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `lakehouse/transform-preview/route.ts` | GET POST | session-only | ● | ADLS, Azure Storage, Synapse |
| `lakehouse/upload/route.ts` | POST | session-only |  | ADLS, ARM, Azure Storage, Managed Identity |

## landing-zones

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `landing-zones/[id]/attach/preflight/route.ts` | POST | admin |  | ARM, Cosmos, Resource Graph |
| `landing-zones/[id]/attach/route.ts` | POST | admin |  | ADLS, ADX, ARM, Azure Monitor, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `landing-zones/[id]/services/[serviceId]/route.ts` | DELETE | admin |  | ADLS, Azure Monitor, Cosmos, Key Vault, Microsoft Graph |
| `landing-zones/[id]/services/route.ts` | GET | admin |  | Cosmos |
| `landing-zones/discover/route.ts` | GET | admin |  | ARM, Cosmos, Resource Graph |
| `landing-zones/route.ts` | GET POST | admin |  | ADLS, Azure Monitor, Cosmos, Microsoft Graph |

## learn

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `learn/notebook-import/route.ts` | GET POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, AML, APIM, ARM, Azure Monitor, Azure RBAC, Azure SQL, Azure Storage, Compute, Container Apps, Cosmos, Databricks, Event Hubs, Fabric, IoT Hub, Logic Apps, Managed Identity, Microsoft Graph, PostgreSQL, Power BI, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |

## lineage

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `lineage/openlineage/export/route.ts` | GET | session-only |  | Azure Monitor, Cosmos, Purview |
| `lineage/openlineage/route.ts` | POST | public |  | Azure Monitor, Cosmos, Purview |

## loom

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `loom/capacities/route.ts` | GET | session-only |  | Fabric |
| `loom/compute-targets/[id]/[verb]/route.ts` | POST | session-only |  | ARM, Azure Monitor, Cosmos, Resource Graph, Synapse |
| `loom/compute-targets/databricks-options/route.ts` | GET | session-only |  | Azure Monitor, Cosmos |
| `loom/compute-targets/route.ts` | GET POST | session-only |  | AML, ARM, Azure Monitor, Cosmos, Resource Graph, Synapse |
| `loom/model-serving/endpoints/route.ts` | GET | session-only | ● | AML, ARM, Azure Monitor, Cosmos |
| `loom/shir/route.ts` | GET POST | session-only | ● | ARM, Compute |
| `loom/storage-paths/route.ts` | GET | session-only |  | — |
| `loom/workspaces/route.ts` | GET | session-only |  | Cosmos |

## maps

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `maps/static/route.ts` | GET | session-only |  | Azure Maps |
| `maps/tiles/[...path]/route.ts` | GET | session-only | ● | — |

## marketplace

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `marketplace/catalog/route.ts` | GET | session-only |  | APIM, ARM |
| `marketplace/gate/route.ts` | GET | session-only |  | — |
| `marketplace/mini-app/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, APIM, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `marketplace/products/[id]/certify/route.ts` | POST | owner-scoped |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `marketplace/products/[id]/route.ts` | GET | session-only |  | Cosmos |
| `marketplace/products/[id]/subscribe/route.ts` | POST | session-only |  | Cosmos |
| `marketplace/products/route.ts` | GET POST | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `marketplace/sharing/catalogs/route.ts` | GET DELETE | session-only |  | Azure Monitor, Cosmos |
| `marketplace/sharing/manifest/route.ts` | GET | admin |  | Cosmos |
| `marketplace/sharing/providers/[name]/route.ts` | GET POST DELETE | session-only |  | Azure Monitor, Cosmos |
| `marketplace/sharing/providers/route.ts` | GET POST | session-only | ● | Azure Monitor, Cosmos, Key Vault |
| `marketplace/sharing/publishable-tables/route.ts` | GET | admin |  | ADLS, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Synapse SQL |
| `marketplace/sharing/query/route.ts` | POST | session-only | ● | Azure Monitor, Cosmos |
| `marketplace/sharing/recipients/[name]/route.ts` | GET PATCH DELETE | admin |  | Azure Monitor, Cosmos |
| `marketplace/sharing/recipients/route.ts` | GET POST | admin |  | Azure Monitor, Cosmos |
| `marketplace/sharing/shares/[name]/route.ts` | GET PATCH DELETE | admin |  | Azure Monitor, Cosmos |
| `marketplace/sharing/shares/route.ts` | GET POST | admin |  | Azure Monitor, Cosmos |
| `marketplace/subscriptions/[sid]/keys/regenerate/route.ts` | POST | session-only |  | APIM, ARM |
| `marketplace/subscriptions/[sid]/keys/route.ts` | POST | session-only |  | APIM, ARM |
| `marketplace/subscriptions/[sid]/route.ts` | PATCH DELETE | session-only |  | APIM, ARM |
| `marketplace/subscriptions/route.ts` | GET POST | session-only |  | APIM, ARM |

## mdm

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `mdm/golden-records/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `mdm/match/approve/route.ts` | GET POST DELETE | session-only |  | Cosmos |
| `mdm/match/route.ts` | POST | session-only | ● | Azure Monitor, Cosmos |
| `mdm/merge/route.ts` | POST | session-only | ● | Azure Monitor, Cosmos |
| `mdm/models/route.ts` | GET POST DELETE | session-only |  | Cosmos |
| `mdm/reference-data/route.ts` | GET POST DELETE | session-only |  | Cosmos |

## me

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `me/route.ts` | GET | admin |  | — |

## mesh

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `mesh/a2a/[id]/card/route.ts` | GET | session-only |  | Cosmos |
| `mesh/a2a/delegate/route.ts` | POST | session-only |  | AAS, ADLS, ADX, AI Foundry, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure DevOps, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Dataverse, Fabric, Managed Identity, Microsoft Graph, Microsoft Sentinel, Power BI, Synapse SQL |
| `mesh/agents/[id]/route.ts` | GET PUT DELETE | session-only |  | Cosmos |
| `mesh/agents/route.ts` | GET POST | session-only |  | Cosmos |
| `mesh/catalog/route.ts` | GET | session-only |  | Azure DevOps |
| `mesh/run/route.ts` | POST | session-only |  | AAS, ADLS, ADX, AI Foundry, AI Search, AML, ARM, Azure AI Services, Azure Cache for Redis, Azure DevOps, Azure OpenAI, Azure SQL, Container Apps, Cosmos, Dataverse, Fabric, Managed Identity, Microsoft Graph, Microsoft Sentinel, Power BI, Synapse SQL |

## messaging

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `messaging/metrics/route.ts` | GET | session-only | ● | ARM, Event Grid, Event Hubs, Service Bus |

## metrics

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `metrics/query/route.ts` | POST | session-only |  | ADX, ARM, Azure Cache for Redis, Azure Monitor, Azure SQL, Cosmos, Managed Identity, Synapse SQL |

## migrate

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `migrate/assess/route.ts` | POST | admin | ● | ADX, Azure Cache for Redis, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics, Loom service |
| `migrate/copy/route.ts` | GET POST | admin |  | ADF, ADLS, ARM, Azure Cache for Redis, Azure Monitor, Azure Storage, Cosmos, Resource Graph, Synapse |
| `migrate/translate/route.ts` | POST | admin |  | Azure Cache for Redis, Azure Monitor, Cosmos |

## monitor

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `monitor/action-groups/route.ts` | GET POST | session-only | ● | ARM, Azure Cache for Redis, Azure Monitor, Cosmos |
| `monitor/activities/route.ts` | GET | session-only |  | ARM, Azure Cache for Redis, Azure Monitor, Cosmos, Log Analytics |
| `monitor/activity/route.ts` | GET | session-only |  | ARM, Azure Cache for Redis, Azure Monitor, Cosmos |
| `monitor/alerts/route.ts` | GET POST | session-only | ● | ARM, Azure Cache for Redis, Azure Monitor, Cosmos |
| `monitor/cost/route.ts` | GET | session-only |  | ARM, Azure Cache for Redis, Cosmos, Cost Management |
| `monitor/defender/remediate/route.ts` | POST | session-only |  | ARM, Azure Policy, Azure RBAC |
| `monitor/defender/route.ts` | GET | session-only |  | ARM, Azure Cache for Redis, Cosmos, Defender for Cloud |
| `monitor/diagnostics/route.ts` | GET POST | session-only |  | ARM, Azure Cache for Redis, Cosmos |
| `monitor/health/route.ts` | GET | session-only |  | ARM, Azure Cache for Redis, Cosmos, Resource Graph, Resource Health |
| `monitor/inventory/route.ts` | GET | session-only |  | ARM, Azure Cache for Redis, Cosmos |
| `monitor/logic-app-callback/route.ts` | POST | session-only |  | ARM, Logic Apps |
| `monitor/logs/route.ts` | GET POST | session-only |  | Log Analytics |
| `monitor/metrics/route.ts` | POST | session-only |  | ARM, Azure Cache for Redis, Cosmos |
| `monitor/spark/route.ts` | GET | session-only |  | Log Analytics, Synapse |

## network

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `network/managed-private-endpoints/route.ts` | GET POST DELETE | admin |  | ADLS, ARM, Azure Networking, Azure SQL, Azure Storage, Cosmos, Databricks, Event Hubs / Service Bus, Key Vault, PostgreSQL, Synapse, Synapse SQL |
| `network/pbi-gateway/route.ts` | GET | session-only |  | ARM, Compute |
| `network/private-endpoints/route.ts` | GET | session-only |  | ARM, Azure Networking, Resource Graph |
| `network/vnet-data-gateway/route.ts` | GET | session-only |  | ARM, Azure Networking, Power Platform |
| `network/vpn-profile/route.ts` | GET POST | session-only |  | ARM, Azure Networking |

## notebook

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `notebook/[id]/assist/route.ts` | POST | owner-scoped | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Synapse, Synapse SQL |
| `notebook/[id]/contents/route.ts` | GET PUT | owner-scoped | ● | AML, ARM, Cosmos, Microsoft Graph |
| `notebook/[id]/execute/route.ts` | GET POST | session-only | ● | AML, ARM, Azure Monitor, Cosmos, Resource Graph, Synapse |
| `notebook/[id]/lsp/route.ts` | GET | session-only |  | AML |
| `notebook/[id]/schedule/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | AML, ARM, Cosmos, Microsoft Graph |
| `notebook/[id]/session/route.ts` | GET POST DELETE | session-only | ● | ARM, Azure Monitor, Cosmos, Resource Graph, Synapse |
| `notebook/[id]/wrangler-ai/route.ts` | POST | session-only | ● | AML, ARM, Azure AI Services, Azure Cache for Redis, Azure OpenAI, Cosmos |
| `notebook/execute/route.ts` | POST | session-only |  | — |
| `notebook/wrangler/route.ts` | POST | session-only |  | — |

## notifications

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `notifications/route.ts` | GET POST PATCH | owner-scoped |  | Cosmos |

## observability

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `observability/incidents/[id]/route.ts` | GET | admin |  | Azure Cache for Redis, Azure Monitor, Cosmos, Purview |
| `observability/incidents/[id]/transition/route.ts` | POST | admin |  | Azure Cache for Redis, Azure Monitor, Cosmos |
| `observability/incidents/route.ts` | GET POST | admin |  | ARM, Azure Cache for Redis, Azure Monitor, Cosmos |
| `observability/monitors/[id]/observe/route.ts` | POST | admin |  | ARM, Azure Cache for Redis, Azure Monitor, Cosmos |
| `observability/monitors/route.ts` | GET POST | admin |  | Azure Cache for Redis, Azure Monitor, Cosmos |

## onelake

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `onelake/[itemId]/route.ts` | DELETE | owner-scoped |  | ADLS, AI Search, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `onelake/catalog/route.ts` | GET | session-only | ● | AI Search, Cosmos, Fabric, Power BI |
| `onelake/governance/route.ts` | GET | session-only |  | Cosmos, Purview |
| `onelake/lifecycle/route.ts` | GET PUT | owner-scoped |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity |
| `onelake/paths/route.ts` | GET | session-only |  | ADLS, Azure Storage |
| `onelake/recycle/route.ts` | GET POST DELETE | owner-scoped |  | ADLS, AI Search, ARM, Azure Storage, Cosmos, Managed Identity, Purview |
| `onelake/resolve/route.ts` | GET POST | session-only |  | Loom service |
| `onelake/security/route.ts` | GET POST DELETE | session-only |  | ADLS, ARM, Azure Monitor, Azure RBAC, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Resource Graph |
| `onelake/storage/route.ts` | GET | session-only | ● | ADLS, ARM, Azure Storage, Cosmos, Managed Identity |
| `onelake/tier/route.ts` | GET PUT | session-only |  | ADLS, ARM, Azure Storage, Managed Identity |

## ontology-functions

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ontology-functions/route.ts` | GET POST DELETE | admin |  | Cosmos |

## openapi.json

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `openapi.json/route.ts` | GET | public |  | — |

## org-reports

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `org-reports/render/route.ts` | GET POST | session-only |  | ARM, Azure Cache for Redis, Cosmos, Cost Management, Defender for Cloud, Log Analytics, Microsoft Graph, Purview, Resource Graph |
| `org-reports/route.ts` | GET | session-only |  | Cosmos |

## powerbi

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `powerbi/[group]/route.ts` | GET POST DELETE | session-only | ● | Fabric, Power BI |
| `powerbi/access/route.ts` | GET POST PUT DELETE | session-only | ● | Fabric, Power BI |
| `powerbi/datasources/route.ts` | GET POST | session-only | ● | Fabric, Power BI |
| `powerbi/endorsement/route.ts` | GET PUT | session-only | ● | Fabric, Power BI |
| `powerbi/pipelines/route.ts` | GET POST | session-only |  | Fabric, Power BI |
| `powerbi/workspaces/route.ts` | GET | session-only |  | Fabric, Power BI |

## powerplatform

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `powerplatform/apps/route.ts` | GET DELETE | session-only | ● | Power Automate, Power Platform |
| `powerplatform/connections/route.ts` | GET DELETE | session-only | ● | Power Automate, Power Platform |
| `powerplatform/connectors/route.ts` | GET | session-only | ● | Power Automate, Power Platform |
| `powerplatform/environments/operation/route.ts` | GET | session-only | ● | Power Automate, Power Platform |
| `powerplatform/environments/route.ts` | GET POST PATCH DELETE | session-only | ● | Power Automate, Power Platform |
| `powerplatform/flows/route.ts` | GET POST DELETE | session-only | ● | Power Automate, Power Platform |
| `powerplatform/solutions/route.ts` | GET POST DELETE | session-only | ● | Power Automate, Power Platform |
| `powerplatform/tables/route.ts` | GET POST | session-only | ● | Dataverse, Power Automate, Power Platform |

## pub

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `pub/swa-bundle/route.ts` | GET | public |  | Cosmos |

## real-time-hub

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `real-time-hub/sources/route.ts` | — | public |  | — |

## realtime-hub

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `realtime-hub/connect-source/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Fabric, Key Vault, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `realtime-hub/databases/route.ts` | GET | session-only | ● | ADX, ARM, Managed Identity |
| `realtime-hub/endpoints/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Microsoft Graph |
| `realtime-hub/http-source/route.ts` | POST | session-only |  | Event Hubs, Event Hubs / Service Bus |
| `realtime-hub/keyvault-certificates/route.ts` | GET | session-only | ● | Key Vault |
| `realtime-hub/options/route.ts` | GET | session-only | ● | ARM, Cosmos, Event Hubs, IoT Hub, Resource Graph |
| `realtime-hub/preview/route.ts` | POST | session-only |  | ADX, ARM, Managed Identity |
| `realtime-hub/provision/route.ts` | POST | session-only |  | ARM, Cosmos, Event Hubs, IoT Hub |
| `realtime-hub/streams/route.ts` | GET | owner-scoped |  | Cosmos, Fabric, Microsoft Graph |

## rti-hub

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `rti-hub/route.ts` | GET | owner-scoped | ● | ARM, Cosmos, Event Grid, Event Hubs, Microsoft Graph, Resource Graph |

## running-workloads

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `running-workloads/route.ts` | GET | owner-scoped |  | ADF, ARM, Cosmos, Resource Graph |

## runtime-flags

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `runtime-flags/route.ts` | GET | session-only |  | Azure Cache for Redis, Cosmos |

## s3-gateway

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `s3-gateway/info/route.ts` | GET | session-only |  | — |

## scheduler

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `scheduler/[id]/route.ts` | GET PATCH DELETE | session-only | ● | Cosmos |
| `scheduler/[id]/run/route.ts` | POST | session-only | ● | ADF, ADX, AML, ARM, Azure Storage, Cosmos, Managed Identity, Resource Graph, Synapse |
| `scheduler/[id]/runs/route.ts` | GET | session-only | ● | Cosmos |
| `scheduler/route.ts` | GET POST | session-only | ● | Cosmos |

## scim

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `scim/v2/Groups/[id]/route.ts` | GET PUT PATCH DELETE | public |  | Cosmos |
| `scim/v2/Groups/route.ts` | GET POST | public |  | Cosmos |
| `scim/v2/ResourceTypes/route.ts` | GET | public |  | — |
| `scim/v2/ServiceProviderConfig/route.ts` | GET | public |  | — |
| `scim/v2/Users/[id]/route.ts` | GET PUT PATCH DELETE | public |  | Cosmos |
| `scim/v2/Users/route.ts` | GET POST | public |  | Cosmos |

## search

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `search/items/route.ts` | POST | session-only |  | AI Search, Cosmos |

## semantic-model

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `semantic-model/metric-view/route.ts` | POST | session-only | ● | ARM, Azure SQL, Managed Identity, Synapse SQL |

## setup

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `setup/config/route.ts` | GET | session-only |  | ARM |
| `setup/deploy-preflight/route.ts` | GET | admin |  | ADX, ARM, Azure Networking, Azure RBAC, Azure Storage, Cosmos, Key Vault, Managed Identity |
| `setup/deploy-status/route.ts` | GET | session-only |  | ARM, Cosmos |
| `setup/deploy/route.ts` | POST | admin |  | ADX, ARM, Azure Networking, Azure RBAC, Azure Storage, Container Apps, Cosmos, Key Vault, Managed Identity |
| `setup/discover-services/route.ts` | GET | admin | ● | ADF, ADX, AI Search, APIM, ARM, Azure AI Services, Azure Maps, Azure Storage, Container Apps, Cosmos, Databricks, Event Hubs, Key Vault, PostgreSQL, Purview, Resource Graph, Stream Analytics, Synapse |
| `setup/estate-scan/route.ts` | POST | admin |  | ARM, Container Apps, Cosmos, Resource Graph |
| `setup/existing-aoai/route.ts` | GET | session-only |  | ARM, Azure AI Services, Resource Graph |
| `setup/existing-dlzs/route.ts` | GET | session-only |  | ARM, Cosmos, Resource Graph |
| `setup/existing-storage/route.ts` | GET | session-only |  | ARM, Resource Graph |
| `setup/identity/route.ts` | GET POST | session-only |  | Microsoft Graph |
| `setup/landing-zones/grant/route.ts` | POST | admin |  | ARM, Azure RBAC, Cosmos |
| `setup/landing-zones/route.ts` | GET | session-only |  | ARM, Azure RBAC, Cosmos, Resource Graph |
| `setup/quota-preflight/route.ts` | POST | session-only |  | ARM, Compute |
| `setup/regions/route.ts` | GET | session-only |  | ARM |
| `setup/scan-cosmos/route.ts` | GET | session-only |  | ARM, Cosmos |
| `setup/scan-purview/route.ts` | GET | session-only |  | ARM, Purview, Resource Graph |
| `setup/scan/route.ts` | GET | session-only |  | ARM, Resource Graph |
| `setup/subscriptions/route.ts` | GET | session-only |  | ARM, Cosmos |
| `setup/tenant-topology/route.ts` | GET | session-only |  | Cosmos |
| `setup/validate-adoption/route.ts` | POST | admin | ● | ARM, Azure RBAC, Azure Storage, Container Apps, Cosmos, Resource Graph |
| `setup/wire-existing/route.ts` | POST | admin |  | ARM, Cosmos, Resource Graph |
| `setup/workflow-run-status/route.ts` | GET | session-only | ● | — |

## spark

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `spark/session-pool/route.ts` | GET POST | admin | ● | Azure Monitor, Cosmos, Synapse |

## spark-environment

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `spark-environment/[id]/attach/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph |
| `spark-environment/[id]/libraries/route.ts` | POST DELETE | owner-scoped |  | ADLS, AI Search, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `spark-environment/[id]/publish/route.ts` | POST | owner-scoped |  | AI Search, ARM, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `spark-environment/[id]/validate/route.ts` | GET POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Synapse |

## sql

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `sql/trino/route.ts` | POST | admin | ● | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |

## sqldb

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `sqldb/columns/route.ts` | GET | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/constraints/route.ts` | GET POST PATCH DELETE | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/functions/route.ts` | GET DELETE | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/indexes/route.ts` | GET DELETE | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/preview/route.ts` | GET | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/procedures/route.ts` | GET DELETE | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/rename/route.ts` | POST | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/schemas/route.ts` | GET | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/script/route.ts` | GET | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/table-types/route.ts` | GET DELETE | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/tables/route.ts` | GET DELETE | owner-scoped |  | Azure SQL, Cosmos, Fabric |
| `sqldb/views/route.ts` | GET DELETE | owner-scoped |  | Azure SQL, Cosmos, Fabric |

## storage

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `storage/[account]/containers/[container]/paths/route.ts` | GET | owner-scoped |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `storage/[account]/containers/route.ts` | GET | owner-scoped |  | ADLS, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph |
| `storage/accounts/route.ts` | GET | session-only |  | ARM, Azure Storage |

## streaming-sql

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `streaming-sql/mv/route.ts` | POST | session-only | ● | ADLS, ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Event Hubs / Service Bus, Log Analytics |
| `streaming-sql/query/route.ts` | POST | session-only | ● | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Log Analytics |
| `streaming-sql/status/route.ts` | GET | session-only |  | ADX, Azure Monitor, Azure Networking, Container Apps, Cosmos, Cost Management, Event Hubs / Service Bus, Log Analytics |

## synapse

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `synapse/dataflows/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/datasets/[name]/route.ts` | GET | session-only | ● | Synapse |
| `synapse/datasets/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/environments/route.ts` | GET | session-only |  | Synapse |
| `synapse/integration-runtimes/route.ts` | GET POST DELETE | session-only | ● | ARM, Resource Graph, Synapse |
| `synapse/kqlscripts/[name]/route.ts` | GET PUT DELETE | session-only | ● | ARM, Resource Graph, Synapse |
| `synapse/kqlscripts/[name]/run/route.ts` | POST | session-only | ● | ADX, Synapse |
| `synapse/kqlscripts/route.ts` | GET POST DELETE | session-only | ● | ARM, Resource Graph, Synapse |
| `synapse/linkedservices/[name]/route.ts` | GET | session-only | ● | Synapse |
| `synapse/linkedservices/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/linkedservices/test/route.ts` | POST | session-only | ● | Synapse |
| `synapse/notebooks/[name]/route.ts` | GET PUT DELETE | session-only | ● | ADLS, ARM, Azure Storage, Managed Identity, Synapse |
| `synapse/notebooks/[name]/run-cell/route.ts` | GET POST | session-only | ● | ARM, Resource Graph, Synapse |
| `synapse/notebooks/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/pipelines/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/pools/route.ts` | GET | session-only | ● | ARM, Resource Graph, Synapse |
| `synapse/sparkjobdefinitions/[name]/route.ts` | GET PUT DELETE | session-only | ● | ARM, Resource Graph, Synapse |
| `synapse/sparkjobdefinitions/[name]/run/route.ts` | GET POST | session-only | ● | Synapse |
| `synapse/sparkjobdefinitions/route.ts` | GET POST DELETE | session-only | ● | ARM, Resource Graph, Synapse |
| `synapse/sqlscripts/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/triggers/route.ts` | GET POST DELETE | session-only | ● | Synapse |

## tabs

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `tabs/route.ts` | GET POST | session-only |  | Cosmos |

## telemetry

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `telemetry/rum/route.ts` | GET POST | session-only |  | Azure Cache for Redis, Azure Monitor, Cosmos |

## tenant-theme

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `tenant-theme/route.ts` | GET PUT | session-only |  | Cosmos |

## thread

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `thread/add-data-agent-source/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `thread/analyze-in-notebook/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `thread/analyze-in-powerbi/route.ts` | POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Fabric, Managed Identity, Microsoft Graph, PostgreSQL, Power BI, Purview, Resource Graph, Synapse, Synapse SQL |
| `thread/analyze-with-dax/route.ts` | POST | owner-scoped |  | AAS, ARM, Azure Cache for Redis, Azure SQL, Cosmos, Managed Identity, Microsoft Graph, Purview, Synapse SQL |
| `thread/bind-to-ontology/route.ts` | POST | owner-scoped |  | AI Search, Cosmos, Microsoft Graph, Purview |
| `thread/build-loom-report/route.ts` | POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `thread/build-powerbi-model/route.ts` | POST | session-only | ● | ARM, Azure SQL, Cosmos, Fabric, Managed Identity, Microsoft Graph, Power BI, Purview, Synapse SQL |
| `thread/edges/route.ts` | GET | session-only |  | Cosmos |
| `thread/kql-query-to-dashboard-tile/route.ts` | POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `thread/lakehouse-delta-tables/route.ts` | GET | owner-scoped |  | ADLS, ARM, Azure SQL, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Synapse SQL |
| `thread/materialize-to-kql/route.ts` | POST | owner-scoped | ● | ADLS, ADX, ARM, Azure Storage, Cosmos, Managed Identity, Microsoft Graph, Purview |
| `thread/mirror-to-lakehouse/route.ts` | POST | owner-scoped |  | ADLS, Cosmos, Microsoft Graph, Purview |
| `thread/mirror-to-notebook/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `thread/model-tables/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `thread/open-in-report-builder/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Key Vault, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `thread/promote-medallion/route.ts` | POST | owner-scoped |  | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse |
| `thread/publish-as-api/route.ts` | POST | owner-scoped | ● | ADF, ADLS, ADX, AI Search, ARM, Azure SQL, Azure Storage, Compute, Cosmos, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Synapse, Synapse SQL |
| `thread/warehouse-tables/route.ts` | GET | session-only | ● | Azure SQL, Synapse SQL |

## transform

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `transform/[id]/apply/route.ts` | POST | owner-scoped |  | ARM, Cosmos, Managed Identity, Microsoft Graph |
| `transform/[id]/diff/route.ts` | POST | owner-scoped |  | ARM, Cosmos, Managed Identity, Microsoft Graph |
| `transform/[id]/environments/route.ts` | POST | owner-scoped |  | ARM, Cosmos, Managed Identity, Microsoft Graph |
| `transform/[id]/history/route.ts` | GET | owner-scoped |  | Cosmos, Microsoft Graph |
| `transform/[id]/plan/route.ts` | POST | owner-scoped |  | ARM, Cosmos, Managed Identity, Microsoft Graph |
| `transform/[id]/run/route.ts` | POST | owner-scoped |  | ARM, Cosmos, Managed Identity, Microsoft Graph, Purview |

## user-prefs

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `user-prefs/route.ts` | GET POST DELETE | session-only |  | Cosmos |

## v1

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `v1/whoami/route.ts` | GET | session-only |  | Azure Monitor, Cosmos |

## version

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `version/route.ts` | GET | public |  | — |

## warehouse

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `warehouse/explain/route.ts` | POST | session-only | ● | ARM, Azure SQL, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `warehouse/history/route.ts` | GET | session-only | ● | ARM, Azure SQL, Managed Identity, Resource Graph, Synapse, Synapse SQL |
| `warehouse/query/route.ts` | POST | session-only | ● | ARM, Azure SQL, Cosmos, Managed Identity, Resource Graph, Synapse, Synapse SQL |

## workloads-catalog

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `workloads-catalog/route.ts` | GET POST PATCH DELETE | session-only |  | Cosmos |

## workspaces

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `workspaces/[id]/agent-config/route.ts` | GET PUT | owner-scoped |  | Cosmos, Microsoft Graph |
| `workspaces/[id]/clone/route.ts` | POST | admin |  | ADX, AI Search, ARM, Azure Cache for Redis, Azure Monitor, Azure RBAC, Azure Storage, Cosmos, Event Hubs, Fabric, Managed Identity, Microsoft Graph, Purview, Resource Graph |
| `workspaces/[id]/export/route.ts` | GET | admin |  | Azure Cache for Redis, Azure Monitor, Cosmos, Microsoft Graph |
| `workspaces/[id]/folders/route.ts` | GET POST PATCH DELETE | admin |  | Cosmos |
| `workspaces/[id]/image/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `workspaces/[id]/import/route.ts` | POST | admin |  | AI Search, Azure Cache for Redis, Azure Monitor, Cosmos, Microsoft Graph |
| `workspaces/[id]/items/[itemId]/route.ts` | PATCH DELETE | owner-scoped |  | AI Search, Cosmos, Purview |
| `workspaces/[id]/items/route.ts` | GET POST | admin |  | ADF, AI Search, Cosmos, Microsoft Graph |
| `workspaces/[id]/permissions/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos, Microsoft Graph |
| `workspaces/[id]/powerbi-mapping/route.ts` | GET PUT | owner-scoped | ● | Cosmos, Microsoft Graph |
| `workspaces/[id]/role-assignments/[principalId]/route.ts` | DELETE | admin |  | ARM, Azure RBAC, Cosmos, Fabric, Microsoft Graph |
| `workspaces/[id]/role-assignments/route.ts` | GET POST | admin |  | ARM, Azure RBAC, Cosmos, Fabric, Microsoft Graph |
| `workspaces/[id]/route.ts` | GET PATCH DELETE | admin |  | ADF, ADLS, ADX, AI Search, AML, ARM, Azure Monitor, Azure RBAC, Azure SQL, Azure Storage, Cosmos, Event Hubs, IoT Hub, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `workspaces/[id]/scm/route.ts` | GET POST DELETE | owner-scoped | ● | Cosmos, Key Vault, Microsoft Graph |
| `workspaces/[id]/task-flows/[flowId]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos |
| `workspaces/[id]/task-flows/[flowId]/run/route.ts` | GET POST | owner-scoped |  | ADF, ARM, Azure Monitor, Compute, Cosmos, Microsoft Graph, Resource Graph, Synapse |
| `workspaces/[id]/task-flows/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `workspaces/[id]/time-branches/[branchId]/route.ts` | DELETE | admin |  | Cosmos, Microsoft Graph |
| `workspaces/[id]/time-branches/route.ts` | GET POST | admin |  | Cosmos, Microsoft Graph |
| `workspaces/bulk-delete/route.ts` | GET POST | admin |  | ADF, ADLS, ADX, AI Search, AML, ARM, Azure Monitor, Azure SQL, Azure Storage, Cosmos, Event Hubs, IoT Hub, Managed Identity, Microsoft Graph, PostgreSQL, Purview, Resource Graph, Service Bus, Stream Analytics, Synapse, Synapse SQL |
| `workspaces/route.ts` | GET POST | owner-scoped |  | ADX, AI Search, ARM, Azure Monitor, Azure RBAC, Azure Storage, Cosmos, Event Hubs, Fabric, Managed Identity, Purview, Resource Graph |

## Authorization resolvers (derived)

179 function(s) across 80 module(s) reach an owner / workspace-ACL
decision. Derived by `scripts/ci/_route-auth-scope.mjs` from the seeds above —
nothing here is hand-maintained. A change to this list in a diff means the
authorization surface moved.

| Module | Resolvers |
| --- | --- |
| `apps/fiab-console/app/api/admin/workspaces/[id]/networking/_gate.ts` | `authorizeNetworking` |
| `apps/fiab-console/app/api/adx/_shared.ts` | `guardAdxRequest` |
| `apps/fiab-console/app/api/data-products/_lib/access-gate.ts` | `resolveDataProductDataAccess` |
| `apps/fiab-console/app/api/deployment-pipelines/loom/_lib/pipeline-store.ts` | `loadPipeline`, `ownedWorkspace` |
| `apps/fiab-console/app/api/git-integration/_lib/ctx.ts` | `loadGitCtx` |
| `apps/fiab-console/app/api/items/_lib/adx-item-scope.ts` | `guardAdxItemRequest` |
| `apps/fiab-console/app/api/items/_lib/ai-content-fallback.ts` | `loadContentBackedItem` |
| `apps/fiab-console/app/api/items/_lib/copilot-builder-checkpoints.ts` | `captureBuilderCheckpoint`, `listBuilderCheckpoints`, `restoreBuilderCheckpoint` |
| `apps/fiab-console/app/api/items/_lib/copilot-builder-route.ts` | `GET`, `POST`, `makeCopilotBuilderRoute` |
| `apps/fiab-console/app/api/items/_lib/item-crud.ts` | `accessOptsFor`, `createOwnedItem`, `deleteOwnedItem`, `domainScopeFor`, `listAllOwnedItems`, `listOwnedItems`, `loadOwnedItem`, `loadRecycledItem`, `purgeRecycledItem`, `resolveDomainName`, `restoreOwnedItem`, `softDeleteOwnedItem`, `updateOwnedItem` |
| `apps/fiab-console/app/api/items/_lib/model-store.ts` | `readModelState`, `writeModelState` |
| `apps/fiab-console/app/api/items/_lib/ontology-binding.ts` | `GET`, `POST`, `makeOntologyBindRoute` |
| `apps/fiab-console/app/api/items/_lib/palantir-crud.ts` | `GET`, `PATCH`, `POST`, `listOntologies`, `loadOntologySurface`, `makeCollectionRoute`, `makeItemRoute` |
| `apps/fiab-console/app/api/items/_lib/pbi-content-fallback.ts` | `listContentBackedItems`, `loadContentBackedItem`, `readContentBackedItem` |
| `apps/fiab-console/app/api/items/_lib/semantic-model-checkpoints.ts` | `captureCheckpoint`, `listCheckpoints`, `restoreCheckpoint` |
| `apps/fiab-console/app/api/items/_lib/sql-server-scope.ts` | `loadOwnedSqlItem`, `withBoundSqlServer`, `withOwnedSqlItem` |
| `apps/fiab-console/app/api/items/_lib/synapse-item-scope.ts` | `guardSynapseItemRequest` |
| `apps/fiab-console/app/api/items/_lib/synapse-model.ts` | `DELETE`, `GET`, `POST`, `makeSynapseModelHandlers` |
| `apps/fiab-console/app/api/items/aip-logic/[id]/_block-graph.ts` | `loadEntityBindings`, `resolveUseLlmTools`, `runBlockGraph`, `runSiblingFunction` |
| `apps/fiab-console/app/api/items/aip-logic/[id]/_spindle-eval.ts` | `runSpindleEvalSuite` |
| `apps/fiab-console/app/api/items/aip-logic/[id]/_spindle-grounding.ts` | `resolveSpindleGrounding` |
| `apps/fiab-console/app/api/items/databricks-job/_lib/job-scope.ts` | `authorizeDatabricksJobItem` |
| `apps/fiab-console/app/api/items/databricks-notebook/_lib/notebook-exec-scope.ts` | `authorizeNotebookItem` |
| `apps/fiab-console/app/api/items/databricks-pipeline/_lib/pipeline-scope.ts` | `authorizeDatabricksPipelineItem` |
| `apps/fiab-console/app/api/items/lakebase-postgres/[id]/_shared.ts` | `authItem` |
| `apps/fiab-console/app/api/items/materialized-lake-view/_lib/load.ts` | `loadMlvItem` |
| `apps/fiab-console/app/api/items/scorecard/config-store.ts` | `loadScorecardConfig` |
| `apps/fiab-console/app/api/items/semantic-model/_lib/prep-for-ai-store.ts` | `enrichSemanticModelSources`, `readPrepForAi`, `writePrepForAi` |
| `apps/fiab-console/app/api/notebook/_lib/notebook-access.ts` | `loadAccessibleNotebook` |
| `apps/fiab-console/app/api/sqldb/_shared.ts` | `guardSqlDbRequest`, `loadWs` |
| `apps/fiab-console/app/api/storage/_lib/authorize.ts` | `authorizeStorageAccount`, `boundByAccessibleLakehouse` |
| `apps/fiab-console/lib/activation/run-service.ts` | `executeActivationRun` |
| `apps/fiab-console/lib/admin/service-probes.ts` | `getExerciseRunState`, `startExerciseRun` |
| `apps/fiab-console/lib/api/route-toolkit.ts` | `withWorkspaceOwner` |
| `apps/fiab-console/lib/assets/asset-registry.ts` | `getAssetRegistry` |
| `apps/fiab-console/lib/assets/materialize.ts` | `materializeActivationSync`, `materializeAsset`, `materializeTransform` |
| `apps/fiab-console/lib/auth/item-access.ts` | `resolveItemAccessByOid` |
| `apps/fiab-console/lib/auth/pat.ts` | `revokePatToken` |
| `apps/fiab-console/lib/auth/workspace-access.ts` | `ambientAccessOptsFor`, `ambientCallerTid`, `effectiveCallerTid`, `listAccessibleWorkspaces`, `resolveWorkspaceAccessByOid` |
| `apps/fiab-console/lib/auth/workspace-guard.ts` | `authorizeItemWorkspace`, `authorizeWorkspace`, `requireWorkspace`, `resolveAdminWorkspace` |
| `apps/fiab-console/lib/auth/workspace-list-access.ts` | `authorizeWorkspaceList` |
| `apps/fiab-console/lib/auth/workspace-role.ts` | `resolveWorkspaceRole` |
| `apps/fiab-console/lib/azure/agent-flow-execute.ts` | `resolveFlowSubAgents` |
| `apps/fiab-console/lib/azure/agent-memory-client.ts` | `deleteThread`, `getThread` |
| `apps/fiab-console/lib/azure/agent-mesh-run.ts` | `agentConfig` |
| `apps/fiab-console/lib/azure/attached-services-store.ts` | `applyIntegrationResults`, `loadAttachedService` |
| `apps/fiab-console/lib/azure/connection-auth.ts` | `resolvePgAuthDescribed`, `resolveSqlAuth`, `resolveSqlAuthDescribed` |
| `apps/fiab-console/lib/azure/connections-store.ts` | `loadConnection` |
| `apps/fiab-console/lib/azure/copilot-orchestrator.ts` | `buildDefaultRegistry`, `updateSessionMeta` |
| `apps/fiab-console/lib/azure/feature-store-item.ts` | `loadFeatureTableItem`, `persistFeatureTableItem`, `resolveFeatureTableItem` |
| `apps/fiab-console/lib/azure/fine-tuning-item.ts` | `loadFineTuningItem`, `persistFineTuningItem`, `resolveFineTuningItem` |
| `apps/fiab-console/lib/azure/index-my-data-plan.ts` | `resolveIndexPlan` |
| `apps/fiab-console/lib/azure/iq-mcp-tools.ts` | `callIqTool` |
| `apps/fiab-console/lib/azure/iq-mcp.ts` | `getIqOntology`, `getIqSemanticModel`, `listIqOntologies`, `listIqSemanticModels` |
| `apps/fiab-console/lib/azure/kusto-client.ts` | `loadKustoItem` |
| `apps/fiab-console/lib/azure/linguistic-schema.ts` | `readSynonyms`, `writeSynonyms` |
| `apps/fiab-console/lib/azure/mcp-config-store.ts` | `getMcpServer`, `updateMcpServerTestResult` |
| `apps/fiab-console/lib/azure/model-binding.ts` | `loadModelItem`, `persistModelBinding`, `resolveModelBinding` |
| `apps/fiab-console/lib/azure/model-serving-item.ts` | `loadServingItem`, `persistServingItem`, `resolveServingItem` |
| `apps/fiab-console/lib/azure/pipeline-binding.ts` | `loadPipelineItem`, `persistBinding`, `resolveBinding` |
| `apps/fiab-console/lib/azure/power-app-binding.ts` | `loadPowerAppItem`, `persistPowerAppBinding`, `resolvePowerAppBinding` |
| `apps/fiab-console/lib/azure/report-export-label.ts` | `applySensitivityStamp` |
| `apps/fiab-console/lib/azure/report-model-resolver.ts` | `buildConnectionExecutor`, `resolveReportModel`, `resolveSemanticModel` |
| `apps/fiab-console/lib/azure/search-binding.ts` | `loadSearchItem`, `persistSearchBinding`, `resolveSearchBinding` |
| `apps/fiab-console/lib/azure/tabular-eval-client.ts` | `getModelItem`, `listMeasures`, `listModels`, `listTables`, `warmSemanticModel` |
| `apps/fiab-console/lib/azure/workspace-grants.ts` | `evaluateCosmosGrant` |
| `apps/fiab-console/lib/clients/embed-codes-client.ts` | `revokeEmbedCode` |
| `apps/fiab-console/lib/clients/org-visuals-client.ts` | `deleteOrgVisual`, `toggleOrgVisual` |
| `apps/fiab-console/lib/coe-library/builder/dashboard-store.ts` | `deleteDashboard`, `getDashboard`, `setDashboardPublished`, `updateDashboard` |
| `apps/fiab-console/lib/coe-library/coe-library-client.ts` | `deleteClone`, `setClonePublished` |
| `apps/fiab-console/lib/copilot/a2a-platform-execute.ts` | `executePlatformSkill` |
| `apps/fiab-console/lib/copilot/activator-tools.ts` | `buildActivatorTools`, `resolveRuleOwner` |
| `apps/fiab-console/lib/copilot/dax-tools.ts` | `getModelState`, `handleDescribeModel`, `handleSaveDescriptions` |
| `apps/fiab-console/lib/events/webhook-registry.ts` | `bumpHookStats`, `deleteHook`, `getHook`, `updateHook` |
| `apps/fiab-console/lib/foundry/ontology-resolver.ts` | `resolveOntologyObjectForGrounding` |
| `apps/fiab-console/lib/insights/digest-store.ts` | `getDigest`, `requestRunNow` |
| `apps/fiab-console/lib/semantic-model/calc-objects.ts` | `persistCalcToCosmos` |
| `apps/fiab-console/lib/semantic-model/model-context.ts` | `contextFromContentItem`, `loadModelContext` |
| `apps/fiab-console/lib/semantic-model/modeling-objects.ts` | `handleCalculatedTablePost`, `handleDateTableMarkPost`, `handleMeasurePost`, `handleWhatIfPost`, `readLoomModelState` |
| `apps/fiab-console/lib/semantic-model/plan-metrics.ts` | `persistPlanMetricsToCosmos` |

### Authorization-shaped names that are NOT owner checks

Each was read at its definition. A call to an authorization-shaped name that is
neither derived nor listed here fails the generator (#3625) rather than
silently downgrading the route.

| Symbol | Why it is not an owner check |
| --- | --- |
| `admit` | lib/azure/capacity-broker-client.ts — CAPACITY admission (an LCU budget broker POST /admit), not caller authorization. The name collides with the `admit*` family in items/_lib/sql-server-scope.ts, which bounds a TARGET rather than a caller and is likewise not an owner check. |
| `authorizeTrinoCatalogs` | lib/azure/trino-authz.ts — a pure decision over (referenced, allowed, configured) catalog sets. It authorizes WHICH FEDERATION CATALOGS a statement may touch, a different axis from item ownership; the caller's allowed set is computed by the route. Real authorization, but not the owner/workspace-ACL check this column reports. |
| `enforceCapability` | capability gate — classified by the admin column |
| `guardAdxRequest` | app/api/adx/_shared.ts — RETAINED FOR THE EMBEDDED CONTROL, not for the real helper. HISTORY, because this entry asserted the opposite until 2026-08-17 and the generated inventory repeated it to humans: the real wrapper used to resolve its database with `loadKustoItem(itemId, kql-database, oid)` -> `resolveDatabase(item)` and NEVER null-checked, so a caller naming an item they could not reach silently proceeded against the deployment default DB. That was GHSA-v2g8-gp3r-rg4r finding 1, and it is FIXED — the wrapper now runs `authorizeItemWorkspace` and fails closed with a 404. The derivation therefore reaches a seeded root authorizer through its BODY and resolves before U2 is ever consulted, which is why the eleven adx/* navigator routes now publish `owner-scoped` on evidence rather than on this name. This entry is consequently INERT for the shipped code and is kept only because the exempt list is keyed by NAME: the embedded control "session reached through an unnamed wrapper" builds a SYNTHETIC same-named wrapper that performs no authorization, and deleting this entry fails that control as `unknown`. |
| `requireDomainRole` | domain-role gate — classified by the admin column |
| `requireTenantAdmin` | tenant-admin gate — classified by the admin column |

## Backend signals (derived)

440 module(s) ORIGINATE a backend label — the derivation read an
Azure identifier out of them. Every other route/module below inherits through the
call graph. Nothing in this section is a Loom module name someone typed: the
modules are derived, and only the Microsoft-owned identifier vocabulary is seeded.

### The seeded vocabulary

| Identifier | Backend |
| --- | --- |
| `Microsoft.AlertsManagement` (ARM provider) | Azure Monitor |
| `Microsoft.AnalysisServices` (ARM provider) | AAS |
| `Microsoft.ApiManagement` (ARM provider) | APIM |
| `Microsoft.App` (ARM provider) | Container Apps |
| `Microsoft.ApplicationInsights` (ARM provider) | Azure Monitor |
| `Microsoft.Authorization` (ARM provider) | Azure RBAC |
| `Microsoft.Batch` (ARM provider) | Batch |
| `Microsoft.Billing` (ARM provider) | Cost Management |
| `Microsoft.BotService` (ARM provider) | Bot Service |
| `Microsoft.BusinessAppPlatform` (ARM provider) | Power Platform |
| `Microsoft.CognitiveServices` (ARM provider) | Azure AI Services |
| `Microsoft.Compute` (ARM provider) | Compute |
| `Microsoft.Consumption` (ARM provider) | Cost Management |
| `Microsoft.ContainerRegistry` (ARM provider) | ACR |
| `Microsoft.ContainerService` (ARM provider) | AKS |
| `Microsoft.CostManagement` (ARM provider) | Cost Management |
| `Microsoft.DBForPostgreSQL` (ARM provider) | PostgreSQL |
| `Microsoft.DBforPostgreSQL` (ARM provider) | PostgreSQL |
| `Microsoft.DataFactory` (ARM provider) | ADF |
| `Microsoft.Databricks` (ARM provider) | Databricks |
| `Microsoft.Devices` (ARM provider) | IoT Hub |
| `Microsoft.DocumentDB` (ARM provider) | Cosmos |
| `Microsoft.Dynamics` (ARM provider) | Dataverse |
| `Microsoft.EventGrid` (ARM provider) | Event Grid |
| `Microsoft.EventHub` (ARM provider) | Event Hubs |
| `Microsoft.Insights` (ARM provider) | Azure Monitor |
| `Microsoft.KeyVault` (ARM provider) | Key Vault |
| `Microsoft.Keyvault` (ARM provider) | Key Vault |
| `Microsoft.Kusto` (ARM provider) | ADX |
| `Microsoft.Logic` (ARM provider) | Logic Apps |
| `Microsoft.MachineLearningServices` (ARM provider) | AML |
| `Microsoft.Maintenance` (ARM provider) | Azure Maintenance |
| `Microsoft.ManagedIdentity` (ARM provider) | Managed Identity |
| `Microsoft.Management` (ARM provider) | Management Groups |
| `Microsoft.Maps` (ARM provider) | Azure Maps |
| `Microsoft.Network` (ARM provider) | Azure Networking |
| `Microsoft.OperationalInsights` (ARM provider) | Log Analytics |
| `Microsoft.PolicyInsights` (ARM provider) | Azure Policy |
| `Microsoft.PowerApps` (ARM provider) | Power Platform |
| `Microsoft.PowerPlatform` (ARM provider) | Power Platform |
| `Microsoft.ProcessSimple` (ARM provider) | Power Automate |
| `Microsoft.Purview` (ARM provider) | Purview |
| `Microsoft.ResourceGraph` (ARM provider) | Resource Graph |
| `Microsoft.ResourceHealth` (ARM provider) | Resource Health |
| `Microsoft.Resources` (ARM provider) | ARM |
| `Microsoft.Search` (ARM provider) | AI Search |
| `Microsoft.Security` (ARM provider) | Defender for Cloud |
| `Microsoft.ServiceBus` (ARM provider) | Service Bus |
| `Microsoft.Skills` (ARM provider) | AI Search |
| `Microsoft.Sql` (ARM provider) | Azure SQL |
| `Microsoft.Storage` (ARM provider) | Azure Storage |
| `Microsoft.StreamAnalytics` (ARM provider) | Stream Analytics |
| `Microsoft.Synapse` (ARM provider) | Synapse |
| `Microsoft.Web` (ARM provider) | App Service |
| `*.ai.azure.com` (host) | AI Foundry |
| `*.ai.azure.us` (host) | AI Foundry |
| `*.analysis.usgovcloudapi.net` (host) | Power BI |
| `*.analysis.windows.net` (host) | Power BI |
| `*.asazure.usgovcloudapi.net` (host) | AAS |
| `*.asazure.windows.net` (host) | AAS |
| `*.atlas.microsoft.com` (host) | Azure Maps |
| `*.azconfig.azure.us` (host) | App Configuration |
| `*.azconfig.io` (host) | App Configuration |
| `*.azurecontainerapps.io` (host) | Container Apps |
| `*.azurecontainerapps.us` (host) | Container Apps |
| `*.azurecr.io` (host) | ACR |
| `*.azuredatabricks.net` (host) | Databricks |
| `*.bap.microsoft.com` (host) | Power Platform |
| `*.batch.core.usgovcloudapi.net` (host) | Batch |
| `*.batch.core.windows.net` (host) | Batch |
| `*.blob.core.usgovcloudapi.net` (host) | Azure Storage |
| `*.blob.core.windows.net` (host) | Azure Storage |
| `*.cognitiveservices.azure.com` (host) | Azure AI Services |
| `*.cognitiveservices.azure.us` (host) | Azure AI Services |
| `*.copilotstudio.microsoft.com` (host) | Copilot Studio |
| `*.cosmos.azure.com` (host) | Cosmos |
| `*.cosmos.azure.us` (host) | Cosmos |
| `*.crm.dynamics.com` (host) | Dataverse |
| `*.database.usgovcloudapi.net` (host) | Azure SQL |
| `*.database.windows.net` (host) | Azure SQL |
| `*.databricks.azure.us` (host) | Databricks |
| `*.dev.azure.com` (host) | Azure DevOps |
| `*.dev.azuresynapse.net` (host) | Synapse |
| `*.dev.azuresynapse.usgovcloudapi.net` (host) | Synapse |
| `*.devcenter.azure.com` (host) | Dev Center |
| `*.dfs.core.usgovcloudapi.net` (host) | ADLS |
| `*.dfs.core.windows.net` (host) | ADLS |
| `*.directline.botframework.com` (host) | Direct Line |
| `*.documents.azure.com` (host) | Cosmos |
| `*.documents.azure.us` (host) | Cosmos |
| `*.eventgrid.azure.net` (host) | Event Grid |
| `*.eventhubs.azure.net` (host) | Event Hubs |
| `*.fabric.microsoft.com` (host) | Fabric |
| `*.file.core.usgovcloudapi.net` (host) | Azure Storage |
| `*.file.core.windows.net` (host) | Azure Storage |
| `*.flow.microsoft.com` (host) | Power Automate |
| `*.graph.microsoft.com` (host) | Microsoft Graph |
| `*.kusto.azuresynapse.net` (host) | ADX |
| `*.kusto.usgovcloudapi.net` (host) | ADX |
| `*.kusto.windows.net` (host) | ADX |
| `*.loganalytics.azure.com` (host) | Log Analytics |
| `*.management.azure.com` (host) | ARM |
| `*.management.usgovcloudapi.net` (host) | ARM |
| `*.ml.azure.com` (host) | AML |
| `*.ml.azure.us` (host) | AML |
| `*.monitor.azure.com` (host) | Azure Monitor |
| `*.monitor.azure.us` (host) | Azure Monitor |
| `*.openai.azure.com` (host) | Azure OpenAI |
| `*.openai.azure.us` (host) | Azure OpenAI |
| `*.ossrdbms-aad.database.windows.net` (host) | PostgreSQL |
| `*.postgres.database.azure.com` (host) | PostgreSQL |
| `*.postgres.database.usgovcloudapi.net` (host) | PostgreSQL |
| `*.powerbi.com` (host) | Power BI |
| `*.powerbigov.us` (host) | Power BI |
| `*.prices.azure.com` (host) | Retail Prices API |
| `*.purview.azure.com` (host) | Purview |
| `*.purview.azure.net` (host) | Purview |
| `*.purview.azure.us` (host) | Purview |
| `*.purview.microsoft.com` (host) | Purview |
| `*.redis.azure.com` (host) | Azure Cache for Redis |
| `*.search.azure.com` (host) | AI Search |
| `*.search.azure.us` (host) | AI Search |
| `*.search.usgovcloudapi.net` (host) | AI Search |
| `*.search.windows.net` (host) | AI Search |
| `*.sentinel.microsoft.com` (host) | Microsoft Sentinel |
| `*.servicebus.azure.net` (host) | Service Bus |
| `*.servicebus.usgovcloudapi.net` (host) | Event Hubs / Service Bus |
| `*.servicebus.windows.net` (host) | Event Hubs / Service Bus |
| `*.sql.azuresynapse.net` (host) | Synapse SQL |
| `*.sql.azuresynapse.usgovcloudapi.net` (host) | Synapse SQL |
| `*.storage.azure.com` (host) | Azure Storage |
| `*.vault.azure.net` (host) | Key Vault |
| `*.vault.usgovcloudapi.net` (host) | Key Vault |
| `*.vaultcore.azure.net` (host) | Key Vault |
| `*.vaultcore.usgovcloudapi.net` (host) | Key Vault |
| `*.web.azuresynapse.net` (host) | Synapse |
| `@azure/cosmos` (package) | Cosmos |
| `@azure/storage-blob` (package) | Azure Storage |
| `@azure/storage-file-datalake` (package) | ADLS |
| `mssql` (package) | Azure SQL |

An identifier of one of those THREE SHAPES that is in neither this table nor the
next fails the generator naming the module it was found in. Every entry above is
asserted to have at least one occurrence in the tree — a signal with no
population verifies nothing, which is exactly how `keyvault-client` sat in the
old map covering zero routes while Key Vault went unreported on 19.

### Detected identifiers that are NOT a backend dependency

| Identifier | What it actually is |
| --- | --- |
| `arm:Microsoft.Azure` | not a resource provider — a prefix fragment (e.g. `Microsoft.Azure.Search` skillset type names) with no ARM path behind it. |
| `arm:Microsoft.Default` | not a resource provider — the literal `Microsoft.Default` content-filter policy name in an Azure OpenAI deployment payload. |
| `arm:Microsoft.DefaultV2` | ditto, the v2 content-filter policy name. |
| `host:adf.azure.com` | the ADF STUDIO portal host, used by adfStudioBase() to build a deep link. The ADF control plane is Microsoft.DataFactory over ARM and is a separate entry. |
| `host:adf.azure.us` | the Gov ADF Studio portal host — same as above. |
| `host:admin.microsoft.com` | a Microsoft 365 admin-center deep link rendered in the UI. |
| `host:app.fabric.microsoft.com` | a Fabric PORTAL deep link (the API host api.fabric.microsoft.com is a separate entry and IS a backend). |
| `host:azure.microsoft.com` | a marketing / pricing page link rendered in the deploy planner. Never fetched. |
| `host:azure.us` | ditto — the bare Gov namespace, listed beside `openai.azure.us` in a suffix-classification table. |
| `host:azurewebsites.net` | the default App Service hostname, used to derive a site URL for display in a placeholder example. |
| `host:compliance.microsoft.com` | a Purview compliance-portal deep link rendered in the UI. |
| `host:developer.microsoft.com` | a documentation link in the AAS client header. Never fetched. |
| `host:learn.microsoft.com` | a documentation link, in a comment or a help string rendered in the UI. Never fetched. |
| `host:login.microsoftonline.com` | the Entra token endpoint. Every authenticated call touches it; it is authentication, not a data plane. |
| `host:login.microsoftonline.us` | the Gov Entra token authority (`lib/auth/msal.ts::authorityHost`). Authentication, not a data plane — same verdict as its commercial twin. |
| `host:mcr.microsoft.com` | a container image reference in the MCP server catalog — an image name, not a call. |
| `host:microsoftonline.com` | the bare Entra namespace in the same suffix table; the token endpoint itself is login.microsoftonline.com and is recorded above. |
| `host:microsoftonline.us` | the bare Gov Entra namespace, in `lib/copilot/agent-registry.ts::GOV_INTERNAL_SUFFIXES` — a boundary discriminator, not an endpoint. |
| `host:portal.azure.com` | an Azure portal deep link rendered in the UI. |
| `host:portal.azure.us` | an Azure portal deep link rendered in the UI. |
| `host:schema.management.azure.com` | the ARM TEMPLATE SCHEMA document host ($schema of a Logic App / ARM definition). Not the ARM control plane, which is management.azure.com. |
| `host:schemas.microsoft.com` | an XML/JSON namespace URI — an identifier, never fetched. |
| `host:sts.windows.net` | the Entra v1 token issuer, used for issuer VALIDATION in entra-bearer-verify.ts. |
| `host:usgovcloudapi.net` | a bare sovereign-cloud DNS namespace used to TEST which boundary a URI belongs to, not an endpoint. |
| `host:www.microsoft.com` | a documentation link (the MIP file-inject spec). Never fetched. |
| `pkg:@azure/identity` | the Entra credential chain — how a client authenticates TO a backend, not a backend. Present in 132 modules; treating it as one would put a label on 1,573 of 1,680 routes and mean nothing. |
| `pkg:@azure/msal-node` | MSAL — sign-in / token acquisition, same reason as @azure/identity. |

### Clients whose backend the code does not name

The B2 residue: modules that make a network call and carry no Azure identifier,
because the host only exists in deployment configuration — or because they are
not an Azure service at all. Each was read at its definition. **A module in
this state that is NOT listed here fails the generator** — which is what makes
`—` an assertion rather than the default an absent map entry fell into.

| Module | Backend | Read at its definition |
| --- | --- | --- |
| `apps/fiab-console/app/api/dab/_lib/dab-runtime.ts` | Loom service | the Data API builder bridge. It calls a DAB engine at `LOOM_DAB_PREVIEW_URL` — the shared preview Container App from platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep, one of Loom's own deployments. Whatever data source DAB is configured against is attributed there, not on the route. |
| `apps/fiab-console/lib/access/signin-access-request.ts` | — (none) | its one fetch (:123) POSTs to `LOOM_ACCESS_REQUEST_WEBHOOK` — an operator-supplied Teams incoming webhook or Logic App URL. Which service that is, is deployment configuration and not a property of the code; unset, the function returns false without calling anything. |
| `apps/fiab-console/lib/azure/aca-managed-identity.ts` | — (none) | a custom TokenCredential that GETs the Container Apps managed-identity endpoint ($IDENTITY_ENDPOINT, a localhost-side IMDS-style URL) because @azure/identity cannot parse the ACA response. It mints a token; the service the token is spent on is attributed at the client that spends it. |
| `apps/fiab-console/lib/azure/arm-credential.ts` | — (none) | acquires an ARM-scoped token from the UAMI → DefaultAzureCredential chain and returns it. The ARM base URL it is used WITH lives in cloud-endpoints (armBase()), which is where the ARM label is derived; this module reaches no service of its own. |
| `apps/fiab-console/lib/azure/capacity-broker-client.ts` | Loom service | POSTs /admit to the `loom-capacity-broker` Container App at `LOOM_CAPACITY_BROKER_URL` — one of Loom's OWN services, not an Azure backing service. Whatever Azure resources the broker itself uses are attributed in that app, not on the calling route. |
| `apps/fiab-console/lib/azure/data-access-mode.ts` | — (none) | the (default-OFF) switchboard choosing between the shared Console UAMI and a per-user OBO credential. It selects an IDENTITY; the service that identity is used against is attributed at the client that calls it. |
| `apps/fiab-console/lib/azure/databricks-scale-client.ts` | Databricks | instance pools / environment libraries / Spark conf over the Databricks workspace REST API — `fetchWithTimeout(`https://${host()}${path}`)` where `host()` is `LOOM_DATABRICKS_HOSTNAME`. The host is deployment configuration, so no `azuredatabricks.net` literal appears in the module and the derivation cannot read it. The AAD resource id it authenticates against (2ff814a6-…) IS the Azure Databricks first-party app. |
| `apps/fiab-console/lib/azure/entra-bearer-verify.ts` | — (none) | verifies an INBOUND Entra bearer token. Its only fetch is the tenant JWKS from the Entra OIDC metadata document — authentication, and inbound at that. |
| `apps/fiab-console/lib/azure/fetch-with-timeout.ts` | — (none) | a generic AbortController wrapper around fetch(). The URL is the caller's. |
| `apps/fiab-console/lib/azure/loom-onelake-client.ts` | Loom service | resolves a `loom://` address through the `loom-onelake` Container App at `LOOM_ONELAKE_URL`. It reaches ADLS only INDIRECTLY, through that service; per no-fabric-dependency.md it deliberately never touches an onelake.dfs.fabric host. |
| `apps/fiab-console/lib/azure/obo-token-store.ts` | — (none) | the (default-OFF) On-Behalf-Of token exchange + in-process cache. Entra token acquisition, not a data plane. |
| `apps/fiab-console/lib/azure/openlineage-auth.ts` | — (none) | the same shape for OpenLineage ingest: it fetches the tenant JWKS to validate an inbound token. |
| `apps/fiab-console/lib/azure/scc-labels-client.ts` | Loom service | calls the `azure-functions/scc-labels` PowerShell sidecar at `LOOM_SCC_LABELS_ENDPOINT`, because sensitivity-label CRUD exists ONLY in Security & Compliance PowerShell and has no app-only Graph surface. The route's dependency is the sidecar; the SCC endpoint is reached from there. |
| `apps/fiab-console/lib/azure/script-context.ts` | — (none) | reads deployment values out of the environment so a surfaced remediation command carries real values instead of placeholders. Its one ARM fallback resolves the UAMI principal id through arm-credential. |
| `apps/fiab-console/lib/copilot/a2a-client.ts` | — (none) | the OUTBOUND half of A2A delegation: it fetches an EXTERNAL agent's card and JSON-RPC endpoint at a URL the caller supplies, gated by a2a-egress-guard (refused entirely with no LOOM_A2A_EGRESS_ALLOW). There is no fixed host to name, and by design the target is outside the boundary. |
| `apps/fiab-console/lib/editors/_palantir-codegen.ts` | — (none) | makes NO network call. Its `fetch(` occurrences (:196, :203, :406) are inside GENERATED CLIENT CODE emitted as text — `lines.push('... await fetch(...) ...')` — which NETWORK_CALL_RE matches because strings are deliberately kept. The generator is pure and unit-tested as such. |
| `apps/fiab-console/lib/migrate/migrate-client.ts` | Loom service | the only door to the `apps/loom-migrate` estate-enumeration reader, an internal-ingress ACA app at `LOOM_MIGRATE_URL`. The SOURCE estates it enumerates (Snowflake / Unity Catalog / Fabric / Power BI) are reached by that reader, not by the console. |
| `apps/fiab-console/lib/parity/parity-issue.ts` | GitHub | real GitHub REST (`const GH_API = 'https://api.github.com'`, :23, used at :78 and the issue-create call) under LOOM_FEEDBACK_GITHUB_TOKEN. A genuine backend dependency that is not an AZURE one, so no ARM provider / Azure DNS namespace / Azure SDK identifies it and the derivation cannot see it. |

### Propagation cuts

A cut can only ever REMOVE a label, which is the direction that produced #3592,
so there is one and its full measured effect is stated here — not just its
headline. Emptying it and re-deriving over the whole tree: **1,213 row
label-sets shrink** (Azure Monitor drops off 1,179, **Cosmos off 352**), **0
labels are added**, and **0 rows publish `—` solely because of it**. The test
caps the NUMBER of cuts at three; it does not bound what one cut can hide.

| Module | Why its reach does not propagate to callers |
| --- | --- |
| `apps/fiab-console/lib/resilience/fault-injection.ts` | the chaos/fault-injection harness. It hangs off every Cosmos operation and can emit an audit event, so its reach propagated Azure Monitor onto 1,564 of 1,680 routes. It is a test facility gated on LOOM_FAULT_INJECTION, not a dependency of any route. MEASURED BLAST RADIUS: cutting it shrinks 1,213 row label-sets — Azure Monitor drops off 1,179 and Cosmos off 352 (it imports cosmos-client back) — adds nothing, and leaves 0 rows publishing `—` solely because of it. |

### Modules that originate a backend label (derived)

| Module | Backends |
| --- | --- |
| `apps/fiab-console/app/admin/capacity/page.tsx` | Power BI |
| `apps/fiab-console/app/admin/migrate/page.tsx` | Key Vault |
| `apps/fiab-console/app/admin/scaling/page.tsx` | AML |
| `apps/fiab-console/app/api/adf/factories/create/route.ts` | ADF |
| `apps/fiab-console/app/api/admin/audit-logs/route.ts` | Cosmos |
| `apps/fiab-console/app/api/admin/deploy-plan/cost-estimate/route.ts` | Retail Prices API |
| `apps/fiab-console/app/api/admin/domains/images/route.ts` | ADLS |
| `apps/fiab-console/app/api/admin/gates/[id]/options/route.ts` | Azure AI Services |
| `apps/fiab-console/app/api/admin/network/topology/route.ts` | Azure Networking, Resource Graph |
| `apps/fiab-console/app/api/admin/overview/route.ts` | Cosmos |
| `apps/fiab-console/app/api/admin/scaling/foundry-compute/route.ts` | AML |
| `apps/fiab-console/app/api/admin/scaling/utilization/route.ts` | ADX, AI Search, APIM, Container Apps, Cosmos, Synapse |
| `apps/fiab-console/app/api/admin/security/dlp/simulate/route.ts` | Purview |
| `apps/fiab-console/app/api/admin/security/purview/discover/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/admin/updates/apply/route.ts` | ACR |
| `apps/fiab-console/app/api/admin/usage/embed/route.ts` | Power BI |
| `apps/fiab-console/app/api/admin/workspaces/[id]/route.ts` | Azure Storage |
| `apps/fiab-console/app/api/adx/external-tables/route.ts` | ADLS |
| `apps/fiab-console/app/api/apim/instances/route.ts` | APIM |
| `apps/fiab-console/app/api/apim/named-values/route.ts` | Key Vault |
| `apps/fiab-console/app/api/azure/connectables/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/azure/function-apps/route.ts` | App Service |
| `apps/fiab-console/app/api/azure/iothub/policies/route.ts` | IoT Hub |
| `apps/fiab-console/app/api/azure/resources/route.ts` | ADF, App Service, Azure Networking, Cost Management, Management Groups, Resource Graph |
| `apps/fiab-console/app/api/business-events/channels/route.ts` | Event Grid, Event Hubs |
| `apps/fiab-console/app/api/catalog/domains/route.ts` | Purview |
| `apps/fiab-console/app/api/catalog/metastores/route.ts` | Databricks |
| `apps/fiab-console/app/api/catalog/register/route.ts` | Fabric |
| `apps/fiab-console/app/api/catalog/shortcut/route.ts` | Fabric |
| `apps/fiab-console/app/api/copilot/status/route.ts` | AI Foundry |
| `apps/fiab-console/app/api/dab/_lib/dab-runtime.ts` | Loom service |
| `apps/fiab-console/app/api/data-products/route.ts` | Purview |
| `apps/fiab-console/app/api/data-products/search/route.ts` | AI Search |
| `apps/fiab-console/app/api/foundry/data-sources/route.ts` | AI Search |
| `apps/fiab-console/app/api/governance-domains/route.ts` | Purview |
| `apps/fiab-console/app/api/governance/govern/embed/route.ts` | Power BI |
| `apps/fiab-console/app/api/governance/purview/status/route.ts` | Purview |
| `apps/fiab-console/app/api/items/[type]/[id]/security-roles/route.ts` | Fabric |
| `apps/fiab-console/app/api/items/_lib/sql-server-scope.ts` | Azure SQL, PostgreSQL |
| `apps/fiab-console/app/api/items/activator/[id]/history/route.ts` | Azure Monitor |
| `apps/fiab-console/app/api/items/azure-sql-database/[id]/queries/route.ts` | Cosmos |
| `apps/fiab-console/app/api/items/copilot-template-library/[id]/route.ts` | Cosmos |
| `apps/fiab-console/app/api/items/copilot-template-library/route.ts` | Cosmos |
| `apps/fiab-console/app/api/items/cosmos-db/[id]/keys/route.ts` | Cosmos |
| `apps/fiab-console/app/api/items/dashboard/[id]/tile-query/route.ts` | AAS |
| `apps/fiab-console/app/api/items/data-pipeline/[id]/approval-logicapp/route.ts` | Logic Apps |
| `apps/fiab-console/app/api/items/data-pipeline/practice-seed/route.ts` | ADLS |
| `apps/fiab-console/app/api/items/dataset/browse/route.ts` | ADLS |
| `apps/fiab-console/app/api/items/eventhouse/[id]/capacity/route.ts` | ADX, ARM |
| `apps/fiab-console/app/api/items/eventhouse/[id]/continuous-export/route.ts` | ADLS |
| `apps/fiab-console/app/api/items/eventhouse/[id]/ingest/preview/route.ts` | Azure Storage |
| `apps/fiab-console/app/api/items/eventhouse/[id]/ingest/route.ts` | ADX |
| `apps/fiab-console/app/api/items/eventhouse/[id]/overview/route.ts` | ADX |
| `apps/fiab-console/app/api/items/eventstream/[id]/asa-sync/route.ts` | ADX, Azure Storage, Event Hubs |
| `apps/fiab-console/app/api/items/eventstream/[id]/sql-operator/route.ts` | ADX, Azure Storage, Event Hubs, Stream Analytics |
| `apps/fiab-console/app/api/items/eventstream/spark-binding/route.ts` | Synapse |
| `apps/fiab-console/app/api/items/kql-database/[id]/data-connections/route.ts` | ADX, Event Hubs, IoT Hub |
| `apps/fiab-console/app/api/items/kql-database/[id]/follower/route.ts` | ADX |
| `apps/fiab-console/app/api/items/lakebase-postgres/[id]/provision/route.ts` | PostgreSQL |
| `apps/fiab-console/app/api/items/loom-app-runtime/[id]/git-credential/route.ts` | Azure DevOps |
| `apps/fiab-console/app/api/items/map/[id]/geocode/route.ts` | Azure Maps |
| `apps/fiab-console/app/api/items/mirrored-databricks/[id]/catalog/route.ts` | Databricks |
| `apps/fiab-console/app/api/items/report/[id]/data-source/route.ts` | AAS |
| `apps/fiab-console/app/api/items/report/[id]/fields/route.ts` | AAS |
| `apps/fiab-console/app/api/items/report/[id]/map-token/route.ts` | Azure Maps |
| `apps/fiab-console/app/api/items/spark-job-definition/[id]/files/route.ts` | ADLS |
| `apps/fiab-console/app/api/items/sql-database/[id]/route.ts` | Azure SQL, PostgreSQL |
| `apps/fiab-console/app/api/items/sql-database/route.ts` | Azure SQL, PostgreSQL |
| `apps/fiab-console/app/api/items/stream-analytics-job/[name]/test/route.ts` | Stream Analytics |
| `apps/fiab-console/app/api/items/user-data-function/[id]/invoke/route.ts` | Fabric |
| `apps/fiab-console/app/api/lakehouse/history/route.ts` | ADLS |
| `apps/fiab-console/app/api/lakehouse/settings/route.ts` | ADLS |
| `apps/fiab-console/app/api/lakehouse/table-stats/route.ts` | ADLS |
| `apps/fiab-console/app/api/lakehouse/transform-preview/route.ts` | ADLS |
| `apps/fiab-console/app/api/lakehouse/upload/route.ts` | ADLS |
| `apps/fiab-console/app/api/landing-zones/[id]/attach/preflight/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/landing-zones/[id]/attach/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/landing-zones/discover/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/maps/static/route.ts` | Azure Maps |
| `apps/fiab-console/app/api/mesh/run/route.ts` | Azure OpenAI |
| `apps/fiab-console/app/api/network/pbi-gateway/route.ts` | Compute |
| `apps/fiab-console/app/api/network/private-endpoints/route.ts` | Azure Networking |
| `apps/fiab-console/app/api/network/vnet-data-gateway/route.ts` | Azure Networking, Power Platform |
| `apps/fiab-console/app/api/notebook/[id]/lsp/route.ts` | AML |
| `apps/fiab-console/app/api/onelake/governance/route.ts` | Purview |
| `apps/fiab-console/app/api/powerplatform/environments/operation/route.ts` | Power Platform |
| `apps/fiab-console/app/api/setup/discover-services/route.ts` | ADF, ADX, AI Search, APIM, Azure AI Services, Azure Maps, Azure Storage, Cosmos, Databricks, Event Hubs, Key Vault, PostgreSQL, Purview, Stream Analytics, Synapse |
| `apps/fiab-console/app/api/setup/existing-aoai/route.ts` | Azure AI Services, Resource Graph |
| `apps/fiab-console/app/api/setup/existing-dlzs/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/setup/existing-storage/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/setup/landing-zones/grant/route.ts` | Azure RBAC |
| `apps/fiab-console/app/api/setup/landing-zones/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/setup/quota-preflight/route.ts` | Compute |
| `apps/fiab-console/app/api/setup/scan-cosmos/route.ts` | Cosmos |
| `apps/fiab-console/app/api/setup/scan-purview/route.ts` | Purview, Resource Graph |
| `apps/fiab-console/app/api/setup/scan/route.ts` | Resource Graph |
| `apps/fiab-console/app/api/spark-environment/[id]/libraries/route.ts` | ADLS |
| `apps/fiab-console/app/api/storage/accounts/route.ts` | Azure Storage |
| `apps/fiab-console/app/api/synapse/kqlscripts/[name]/run/route.ts` | Synapse |
| `apps/fiab-console/app/api/thread/build-powerbi-model/route.ts` | Power BI |
| `apps/fiab-console/app/catalog/metastores/page.tsx` | Databricks |
| `apps/fiab-console/app/catalog/unity/page.tsx` | ADLS, Databricks |
| `apps/fiab-console/app/copilot/page.tsx` | AI Foundry |
| `apps/fiab-console/app/governance/purview/page.tsx` | Purview |
| `apps/fiab-console/app/governance/scans/page.tsx` | ADLS |
| `apps/fiab-console/e2e/catalog.uat.ts` | Databricks |
| `apps/fiab-console/lib/admin/env-checks/azure-services.ts` | Azure OpenAI, Container Apps, Cost Management |
| `apps/fiab-console/lib/admin/env-checks/core.ts` | ADX, Azure Monitor, Azure Networking, Container Apps, Cost Management, Log Analytics |
| `apps/fiab-console/lib/admin/env-checks/data-plane.ts` | Azure RBAC |
| `apps/fiab-console/lib/admin/env-checks/observability.ts` | Container Apps |
| `apps/fiab-console/lib/admin/health-probes.ts` | AAS, ADF, AML, Azure Storage, Batch, Event Hubs, Power Platform, Service Bus |
| `apps/fiab-console/lib/admin/lcu-autopilot-loop.ts` | ADX, Synapse |
| `apps/fiab-console/lib/admin/self-audit.ts` | AI Search, Azure AI Services, Microsoft Graph |
| `apps/fiab-console/lib/admin/service-probes.ts` | Power Platform |
| `apps/fiab-console/lib/apps/app-resources.ts` | ADX, AI Search, Azure AI Services, Azure RBAC, Azure Storage, Cosmos, Event Hubs, Key Vault, PostgreSQL, Resource Graph |
| `apps/fiab-console/lib/apps/content-bundles/app-data-governance.ts` | Purview |
| `apps/fiab-console/lib/apps/content-bundles/app-direct-lake-replacement.ts` | ADLS, Azure SQL, Azure Storage, Power BI |
| `apps/fiab-console/lib/apps/content-bundles/app-fabric-mirror-onboard.ts` | Azure SQL |
| `apps/fiab-console/lib/apps/content-bundles/app-federal-data-mesh.ts` | Azure Storage |
| `apps/fiab-console/lib/apps/content-bundles/app-hybrid-topology.ts` | Azure SQL |
| `apps/fiab-console/lib/apps/content-bundles/app-logic-apps-integration.ts` | Logic Apps |
| `apps/fiab-console/lib/apps/content-bundles/app-multi-agency-onboarding.ts` | ARM, Azure Networking, Purview, Resource Graph |
| `apps/fiab-console/lib/apps/content-bundles/app-pipeline-designer.ts` | Resource Graph |
| `apps/fiab-console/lib/apps/content-bundles/app-rag-builder.ts` | Azure AI Services |
| `apps/fiab-console/lib/apps/content-bundles/app-sovereign-ai-agents.ts` | Container Apps |
| `apps/fiab-console/lib/apps/content-bundles/notebook-backend.ts` | ADLS, Key Vault |
| `apps/fiab-console/lib/auth/obo.ts` | Power Automate, Power Platform |
| `apps/fiab-console/lib/auth/pdp/context-loader.ts` | Cosmos |
| `apps/fiab-console/lib/azure/aas-client.ts` | AAS, Fabric, Power BI |
| `apps/fiab-console/lib/azure/aas-server-client.ts` | AAS |
| `apps/fiab-console/lib/azure/activator-client.ts` | Fabric, Power BI |
| `apps/fiab-console/lib/azure/adf-client.ts` | ADF |
| `apps/fiab-console/lib/azure/adls-client.ts` | ADLS, Azure RBAC, Azure Storage |
| `apps/fiab-console/lib/azure/adls-user-client.ts` | ADLS |
| `apps/fiab-console/lib/azure/agent-memory-client.ts` | Cosmos |
| `apps/fiab-console/lib/azure/aisearch-admin.ts` | AI Search |
| `apps/fiab-console/lib/azure/aisearch-client.ts` | AI Search |
| `apps/fiab-console/lib/azure/aisearch-knowledge.ts` | AI Search |
| `apps/fiab-console/lib/azure/aks-arm-client.ts` | AKS |
| `apps/fiab-console/lib/azure/alert-dispatch.ts` | Azure Monitor |
| `apps/fiab-console/lib/azure/aml-automl-client.ts` | AML |
| `apps/fiab-console/lib/azure/aml-client.ts` | ADLS, AML, Azure Storage |
| `apps/fiab-console/lib/azure/aml-environments-client.ts` | AML |
| `apps/fiab-console/lib/azure/aml-spark-client.ts` | AML, Azure Storage |
| `apps/fiab-console/lib/azure/apim-client.ts` | APIM |
| `apps/fiab-console/lib/azure/app-service-slots-client.ts` | App Service |
| `apps/fiab-console/lib/azure/arm-client.ts` | Synapse |
| `apps/fiab-console/lib/azure/arm-deployments-client.ts` | ARM |
| `apps/fiab-console/lib/azure/attach-integration.ts` | Azure Monitor |
| `apps/fiab-console/lib/azure/auto-bind-providers.ts` | ADF |
| `apps/fiab-console/lib/azure/azure-sql-client.ts` | Azure Maintenance, Azure RBAC, Azure SQL |
| `apps/fiab-console/lib/azure/batch-client.ts` | Batch |
| `apps/fiab-console/lib/azure/budgets-client.ts` | Cost Management |
| `apps/fiab-console/lib/azure/business-events-store.ts` | Cosmos |
| `apps/fiab-console/lib/azure/capacity-broker-client.ts` | Loom service |
| `apps/fiab-console/lib/azure/cloud-endpoints-graph.ts` | Microsoft Graph |
| `apps/fiab-console/lib/azure/cloud-endpoints.ts` | AAS, ADF, ADLS, ADX, AI Search, AML, ARM, App Configuration, Azure AI Services, Azure DevOps, Azure Monitor, Azure OpenAI, Azure SQL, Azure Storage, Batch, Cosmos, Event Hubs / Service Bus, Key Vault, Log Analytics, Logic Apps, Power Automate, Power BI, Power Platform, Synapse SQL |
| `apps/fiab-console/lib/azure/connection-probe.ts` | ADX |
| `apps/fiab-console/lib/azure/container-apps-arm-client.ts` | Azure Storage, Container Apps |
| `apps/fiab-console/lib/azure/copilot-orchestrator.ts` | Azure Monitor, Azure OpenAI |
| `apps/fiab-console/lib/azure/copilot-personas-notebook.ts` | Azure OpenAI |
| `apps/fiab-console/lib/azure/copilot-personas.ts` | ADX, Azure Monitor, Synapse |
| `apps/fiab-console/lib/azure/copilot-studio-client.ts` | Bot Service, Copilot Studio, Dataverse, Direct Line, Power Platform |
| `apps/fiab-console/lib/azure/cosmos-account-client.ts` | Cosmos |
| `apps/fiab-console/lib/azure/cosmos-client.ts` | Cosmos |
| `apps/fiab-console/lib/azure/cosmos-data-client.ts` | Cosmos |
| `apps/fiab-console/lib/azure/cosmos-migrations.ts` | Cosmos |
| `apps/fiab-console/lib/azure/cosmos-ttl.ts` | Cosmos |
| `apps/fiab-console/lib/azure/cost-client.ts` | Cost Management |
| `apps/fiab-console/lib/azure/cost-forecast.ts` | Cost Management |
| `apps/fiab-console/lib/azure/data-agent-client.ts` | Container Apps |
| `apps/fiab-console/lib/azure/databricks-discovery.ts` | Databricks |
| `apps/fiab-console/lib/azure/databricks-scale-client.ts` | Databricks |
| `apps/fiab-console/lib/azure/defender-client.ts` | Azure Policy, Azure RBAC, Defender for Cloud |
| `apps/fiab-console/lib/azure/delta-maintenance.ts` | ADLS |
| `apps/fiab-console/lib/azure/devcenter-client.ts` | Dev Center |
| `apps/fiab-console/lib/azure/direct-lake-config-store.ts` | Cosmos |
| `apps/fiab-console/lib/azure/dlp-graph-client.ts` | Purview |
| `apps/fiab-console/lib/azure/domain-chargeback.ts` | Cost Management |
| `apps/fiab-console/lib/azure/domains-client.ts` | Fabric |
| `apps/fiab-console/lib/azure/eventgrid-client.ts` | Azure Storage, Event Grid |
| `apps/fiab-console/lib/azure/eventgrid-topics-client.ts` | Event Grid |
| `apps/fiab-console/lib/azure/eventhubs-client.ts` | Event Hubs, Resource Graph |
| `apps/fiab-console/lib/azure/eventhubs-data-client.ts` | Event Hubs |
| `apps/fiab-console/lib/azure/eventstream-standup.ts` | ADX, Event Hubs, Stream Analytics |
| `apps/fiab-console/lib/azure/fabric-client.ts` | Fabric |
| `apps/fiab-console/lib/azure/fine-tuning-client.ts` | Azure OpenAI |
| `apps/fiab-console/lib/azure/foundry-agent-client.ts` | AI Foundry |
| `apps/fiab-console/lib/azure/foundry-client.ts` | AML |
| `apps/fiab-console/lib/azure/foundry-compute-gate.ts` | AML |
| `apps/fiab-console/lib/azure/foundry-connections-client.ts` | AML |
| `apps/fiab-console/lib/azure/foundry-cs-client.ts` | Azure AI Services, Azure Monitor, Azure RBAC |
| `apps/fiab-console/lib/azure/gremlin-client.ts` | Cosmos |
| `apps/fiab-console/lib/azure/help-copilot-orchestrator.ts` | Cosmos |
| `apps/fiab-console/lib/azure/index-my-data-plan.ts` | Azure Storage |
| `apps/fiab-console/lib/azure/index-my-data.ts` | AI Search, Azure SQL, Azure Storage, Synapse |
| `apps/fiab-console/lib/azure/iothub-client.ts` | IoT Hub |
| `apps/fiab-console/lib/azure/item-permissions-client.ts` | Fabric |
| `apps/fiab-console/lib/azure/kusto-arm-client.ts` | ADX |
| `apps/fiab-console/lib/azure/kusto-client.ts` | ADX, Azure Monitor |
| `apps/fiab-console/lib/azure/lakebase-databricks-client.ts` | Databricks |
| `apps/fiab-console/lib/azure/load-to-table-codegen.ts` | ADLS |
| `apps/fiab-console/lib/azure/loom-apps-client.ts` | ACR, Container Apps |
| `apps/fiab-console/lib/azure/loom-apps-runtime-templates.ts` | AI Search, AML, Azure AI Services, PostgreSQL |
| `apps/fiab-console/lib/azure/loom-data-products-search.ts` | AI Search |
| `apps/fiab-console/lib/azure/loom-docs-index.ts` | AI Search, Cosmos |
| `apps/fiab-console/lib/azure/loom-onelake-client.ts` | Loom service |
| `apps/fiab-console/lib/azure/loom-search.ts` | AI Search |
| `apps/fiab-console/lib/azure/maps-client.ts` | Azure Maps |
| `apps/fiab-console/lib/azure/mcp-catalog.ts` | Azure DevOps |
| `apps/fiab-console/lib/azure/mcp-obo-token-store.ts` | AI Foundry, ARM, Azure SQL, Microsoft Graph, Power BI |
| `apps/fiab-console/lib/azure/memory-vector-index.ts` | AI Search |
| `apps/fiab-console/lib/azure/mlflow-client.ts` | AML |
| `apps/fiab-console/lib/azure/monitor-client.ts` | Azure Monitor, Logic Apps, Resource Graph, Resource Health |
| `apps/fiab-console/lib/azure/network-discovery.ts` | Azure Networking, Compute, Power Platform, Resource Graph |
| `apps/fiab-console/lib/azure/network-topology-graph.ts` | Resource Graph |
| `apps/fiab-console/lib/azure/object-dataset-sync.ts` | AI Search |
| `apps/fiab-console/lib/azure/onelake-catalog-client.ts` | Fabric |
| `apps/fiab-console/lib/azure/onelake-security-client.ts` | ADLS |
| `apps/fiab-console/lib/azure/pe-subresource-groups.ts` | Cosmos, Databricks, Key Vault, PostgreSQL, Synapse |
| `apps/fiab-console/lib/azure/plan-approval-client.ts` | Logic Apps |
| `apps/fiab-console/lib/azure/postgres-flex-client.ts` | PostgreSQL |
| `apps/fiab-console/lib/azure/powerbi-client.ts` | Fabric |
| `apps/fiab-console/lib/azure/powerplatform-client.ts` | Dataverse, Logic Apps, Power Automate, Power Platform |
| `apps/fiab-console/lib/azure/protection-policy-client.ts` | Cosmos |
| `apps/fiab-console/lib/azure/purview-client.ts` | Purview |
| `apps/fiab-console/lib/azure/purview-endpoints.ts` | Purview, Resource Graph |
| `apps/fiab-console/lib/azure/purview-mip-client.ts` | ADLS |
| `apps/fiab-console/lib/azure/purview-source-mapping.ts` | ADLS, ADX, Azure SQL, Azure Storage, Cosmos, PostgreSQL, Synapse, Synapse SQL |
| `apps/fiab-console/lib/azure/purview-unified-client.ts` | Purview |
| `apps/fiab-console/lib/azure/redis-cache-client.ts` | Azure Cache for Redis |
| `apps/fiab-console/lib/azure/report-model-resolver.ts` | AAS, ADX |
| `apps/fiab-console/lib/azure/resolve-aml-target.ts` | AML |
| `apps/fiab-console/lib/azure/resource-graph-coords.ts` | Resource Graph |
| `apps/fiab-console/lib/azure/role-grant-client.ts` | Azure RBAC |
| `apps/fiab-console/lib/azure/scc-dlp-client.ts` | Purview |
| `apps/fiab-console/lib/azure/scc-labels-client.ts` | Loom service |
| `apps/fiab-console/lib/azure/scheduler-store.ts` | Cosmos |
| `apps/fiab-console/lib/azure/search-index-client.ts` | AI Search |
| `apps/fiab-console/lib/azure/servicebus-client.ts` | Service Bus |
| `apps/fiab-console/lib/azure/servicebus-data-client.ts` | Service Bus |
| `apps/fiab-console/lib/azure/shortcut-credentials.ts` | Key Vault |
| `apps/fiab-console/lib/azure/shortcut-engines.ts` | ADLS |
| `apps/fiab-console/lib/azure/skill-usage.ts` | Cosmos |
| `apps/fiab-console/lib/azure/skillset-chain.ts` | AI Search |
| `apps/fiab-console/lib/azure/spark-monitor.ts` | Synapse |
| `apps/fiab-console/lib/azure/spark-pool-resolver.ts` | Synapse |
| `apps/fiab-console/lib/azure/storage-discovery.ts` | Azure Storage |
| `apps/fiab-console/lib/azure/storage-user-token-store.ts` | Azure Storage |
| `apps/fiab-console/lib/azure/stream-analytics-client.ts` | ADX, Azure SQL, Azure Storage, Event Hubs, IoT Hub, PostgreSQL, Service Bus, Stream Analytics |
| `apps/fiab-console/lib/azure/swa-publish.ts` | App Service |
| `apps/fiab-console/lib/azure/synapse-artifacts-client.ts` | ADX, Synapse |
| `apps/fiab-console/lib/azure/synapse-dev-client.ts` | Synapse |
| `apps/fiab-console/lib/azure/synapse-livy-client.ts` | Synapse |
| `apps/fiab-console/lib/azure/synapse-pool-arm.ts` | Synapse |
| `apps/fiab-console/lib/azure/synapse-sql-client.ts` | Azure SQL |
| `apps/fiab-console/lib/azure/topology-inventory.ts` | Resource Graph |
| `apps/fiab-console/lib/azure/trigger-param-resolver.ts` | Key Vault |
| `apps/fiab-console/lib/azure/unity-catalog-account-client.ts` | Databricks |
| `apps/fiab-console/lib/azure/user-pool-registry.ts` | AAS, Azure Storage |
| `apps/fiab-console/lib/azure/vmss-client.ts` | Compute |
| `apps/fiab-console/lib/azure/workspace-grants.ts` | Azure RBAC, Azure Storage, Cosmos, Event Hubs |
| `apps/fiab-console/lib/azure/workspace-identity-client.ts` | Azure RBAC, Managed Identity |
| `apps/fiab-console/lib/azure/workspace-roles-client.ts` | Azure RBAC, Fabric |
| `apps/fiab-console/lib/brain/detectors/cost-model.ts` | Retail Prices API |
| `apps/fiab-console/lib/catalog/item-types/azure-ai-foundry.ts` | AML |
| `apps/fiab-console/lib/catalog/item-types/azure-sql-database.ts` | Azure SQL |
| `apps/fiab-console/lib/catalog/item-types/data-engineering.ts` | Batch |
| `apps/fiab-console/lib/catalog/item-types/data-factory.ts` | ADF, Logic Apps |
| `apps/fiab-console/lib/catalog/item-types/data-science.ts` | AML, Azure OpenAI |
| `apps/fiab-console/lib/catalog/item-types/databases.ts` | Cosmos, PostgreSQL |
| `apps/fiab-console/lib/catalog/item-types/real-time-intelligence.ts` | Event Grid, Event Hubs, Service Bus |
| `apps/fiab-console/lib/catalog/item-types/streaming-analytics.ts` | Event Hubs / Service Bus |
| `apps/fiab-console/lib/cdc/cdc-control-plane.tsx` | PostgreSQL |
| `apps/fiab-console/lib/clients/azure-connections-client.ts` | Azure RBAC, Log Analytics |
| `apps/fiab-console/lib/clients/cmk-client.ts` | Azure RBAC, Azure Storage, Key Vault |
| `apps/fiab-console/lib/clients/cost-client.ts` | Cost Management |
| `apps/fiab-console/lib/clients/git-integration-client.ts` | Azure DevOps |
| `apps/fiab-console/lib/clients/jupyter-server-client.ts` | AML |
| `apps/fiab-console/lib/clients/networking-client.ts` | Azure Networking, Azure Storage |
| `apps/fiab-console/lib/clients/workspace-egress-client.ts` | Azure Networking, Cosmos |
| `apps/fiab-console/lib/coe-library/catalog.ts` | Cost Management |
| `apps/fiab-console/lib/coe-library/report-render/live-bindings.ts` | Cost Management, Resource Graph |
| `apps/fiab-console/lib/coe-library/templates-content.ts` | ARM, Cost Management, Microsoft Graph, Purview, Resource Graph |
| `apps/fiab-console/lib/collab/canvas-comment-store.ts` | Cosmos |
| `apps/fiab-console/lib/collab/canvas-presence-store.ts` | Cosmos |
| `apps/fiab-console/lib/components/admin-security/dlp-manage-policies.tsx` | Purview |
| `apps/fiab-console/lib/components/admin-security/purview-panel.tsx` | Purview |
| `apps/fiab-console/lib/components/admin/apim-named-values-pane.tsx` | Key Vault |
| `apps/fiab-console/lib/components/admin/azure-maps-card.tsx` | Azure Maps |
| `apps/fiab-console/lib/components/admin/copilot-agents-config.tsx` | AI Search, Azure AI Services, Fabric |
| `apps/fiab-console/lib/components/adx/adx-database-tree.tsx` | ADLS |
| `apps/fiab-console/lib/components/ai-search/ai-search-tree.tsx` | AI Search, Azure OpenAI |
| `apps/fiab-console/lib/components/ai-search/index-designers.tsx` | Key Vault |
| `apps/fiab-console/lib/components/ai-search/indexer-ops.tsx` | AI Search |
| `apps/fiab-console/lib/components/azure/azure-backed-field.tsx` | ADX, ARM, Azure Networking, Azure SQL, Azure Storage, Container Apps, Databricks, Event Grid, Event Hubs, Logic Apps, Synapse |
| `apps/fiab-console/lib/components/azure/private-link-target-field.tsx` | ACR, ADF, ADX, AI Search, AML, App Service, Azure AI Services, Azure Monitor, Azure SQL, Azure Storage, Container Apps, Cosmos, Databricks, Event Grid, Event Hubs, Key Vault, PostgreSQL, Purview, Service Bus, Synapse |
| `apps/fiab-console/lib/components/catalog/cross-source-actions.tsx` | ADLS |
| `apps/fiab-console/lib/components/catalog/permission-matrix.tsx` | Databricks |
| `apps/fiab-console/lib/components/connections/connection-builder.tsx` | ADX, Azure SQL, Event Hubs / Service Bus, Key Vault |
| `apps/fiab-console/lib/components/cosmos/cosmos-connect-panel.tsx` | Cosmos |
| `apps/fiab-console/lib/components/cosmos/cosmos-data-explorer.tsx` | Cosmos |
| `apps/fiab-console/lib/components/cosmos/cosmos-script-editor.tsx` | Cosmos |
| `apps/fiab-console/lib/components/cosmos/cosmos-settings-panel.tsx` | Cosmos |
| `apps/fiab-console/lib/components/dbt/dbt-model-graph.tsx` | Fabric, Synapse SQL |
| `apps/fiab-console/lib/components/deploy-planner/planToBicep.ts` | ARM |
| `apps/fiab-console/lib/components/deploy-planner/service-catalog.ts` | Defender for Cloud |
| `apps/fiab-console/lib/components/deployment/deployment-pipelines-pane.tsx` | ARM |
| `apps/fiab-console/lib/components/eventhubs/eventhubs-namespace-editor.tsx` | Event Hubs, Event Hubs / Service Bus |
| `apps/fiab-console/lib/components/foundry/foundry-tree.tsx` | Azure AI Services |
| `apps/fiab-console/lib/components/graph/azure-maps-canvas.tsx` | Azure Maps |
| `apps/fiab-console/lib/components/logic-app/workflow-designer-canvas.tsx` | Logic Apps |
| `apps/fiab-console/lib/components/messaging/metrics-tab.tsx` | Azure Monitor |
| `apps/fiab-console/lib/components/monitor/monitor-action-builder.tsx` | Azure Monitor |
| `apps/fiab-console/lib/components/monitor/monitor-pane.tsx` | Cost Management |
| `apps/fiab-console/lib/components/network/managed-private-endpoints.tsx` | Azure Networking |
| `apps/fiab-console/lib/components/network/network-pane.tsx` | Azure Networking, Synapse, Synapse SQL |
| `apps/fiab-console/lib/components/network/trusted-workspace-access.tsx` | Azure Storage |
| `apps/fiab-console/lib/components/notebook/environment-panel.tsx` | ADLS |
| `apps/fiab-console/lib/components/onelake/properties-panel.tsx` | ADLS |
| `apps/fiab-console/lib/components/onelake/shortcut-wizard.tsx` | ADLS |
| `apps/fiab-console/lib/components/pipeline/activity-catalog.ts` | Azure AI Services |
| `apps/fiab-console/lib/components/pipeline/dataflow-diagram.tsx` | Azure SQL |
| `apps/fiab-console/lib/components/pipeline/manage-panel.tsx` | Azure SQL, Databricks, Synapse SQL |
| `apps/fiab-console/lib/components/pipeline/synapse-workspace-tree.tsx` | Synapse |
| `apps/fiab-console/lib/components/pipeline/trigger-wizard.tsx` | Azure Storage |
| `apps/fiab-console/lib/components/powerbi/dq-source-panel.tsx` | ADX, Synapse SQL |
| `apps/fiab-console/lib/components/purview-gate.tsx` | Purview |
| `apps/fiab-console/lib/components/realtime-hub/connect-source-dialog.tsx` | Key Vault |
| `apps/fiab-console/lib/components/workspace-settings-drawer.tsx` | Azure DevOps, Azure Storage |
| `apps/fiab-console/lib/copilot/activator-tools.ts` | Azure Monitor |
| `apps/fiab-console/lib/copilot/agent-registry.ts` | Azure OpenAI, Fabric, Power BI |
| `apps/fiab-console/lib/copilot/powerbi-skills.ts` | Fabric, Power BI |
| `apps/fiab-console/lib/dataproducts/cosmos-store.ts` | Cosmos |
| `apps/fiab-console/lib/deploy/adoption-catalog.ts` | Container Apps |
| `apps/fiab-console/lib/deploy/discovery-scanner.ts` | Resource Graph |
| `apps/fiab-console/lib/deploy/fitness-probe.ts` | Azure RBAC |
| `apps/fiab-console/lib/deploy/fitness.ts` | Azure RBAC, Azure Storage |
| `apps/fiab-console/lib/editors/_family-utils.ts` | ADLS |
| `apps/fiab-console/lib/editors/airflow-job-editor.tsx` | Azure DevOps |
| `apps/fiab-console/lib/editors/azure-services-editors.tsx` | Azure Storage, Synapse |
| `apps/fiab-console/lib/editors/azure-sql-editors.tsx` | Azure SQL |
| `apps/fiab-console/lib/editors/components/connection-strings-builder.ts` | Azure SQL |
| `apps/fiab-console/lib/editors/components/mirror-source-wizard.tsx` | Azure SQL |
| `apps/fiab-console/lib/editors/components/open-mirror-config.tsx` | Azure Storage |
| `apps/fiab-console/lib/editors/components/predict-wizard.tsx` | ADLS |
| `apps/fiab-console/lib/editors/components/share-dialog.tsx` | Azure SQL |
| `apps/fiab-console/lib/editors/components/sql-restore-panel.tsx` | Azure SQL |
| `apps/fiab-console/lib/editors/components/sql-scale-panel.tsx` | Azure SQL |
| `apps/fiab-console/lib/editors/components/warehouse-alerts.tsx` | Azure Monitor |
| `apps/fiab-console/lib/editors/copilot-studio-editors.tsx` | Direct Line |
| `apps/fiab-console/lib/editors/cosmos-account-editor.tsx` | Cosmos |
| `apps/fiab-console/lib/editors/cross-item-copilot-editor.tsx` | AI Foundry |
| `apps/fiab-console/lib/editors/data-api-builder-editor.tsx` | Azure SQL |
| `apps/fiab-console/lib/editors/data-marketplace.tsx` | AI Search |
| `apps/fiab-console/lib/editors/databricks/job-editor.tsx` | Databricks |
| `apps/fiab-console/lib/editors/databricks/pipeline-editor.tsx` | ADLS |
| `apps/fiab-console/lib/editors/databricks/streaming-object-dialog.tsx` | ADLS |
| `apps/fiab-console/lib/editors/databricks/uc-dialogs.tsx` | ADLS, Azure SQL, Databricks |
| `apps/fiab-console/lib/editors/dataflow-gen2-editor.tsx` | Azure SQL |
| `apps/fiab-console/lib/editors/eventstream/geo-reference.ts` | Azure Storage |
| `apps/fiab-console/lib/editors/foundry-hub-editor.tsx` | AML, Azure AI Services, Key Vault |
| `apps/fiab-console/lib/editors/foundry-playground.tsx` | AI Foundry, AI Search |
| `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` | ADLS, AI Foundry, AI Search, Azure AI Services |
| `apps/fiab-console/lib/editors/geo-editors.tsx` | Azure Maps |
| `apps/fiab-console/lib/editors/graph-editors.tsx` | ADLS |
| `apps/fiab-console/lib/editors/lakehouse-shortcut-editor.tsx` | ADLS, Dataverse |
| `apps/fiab-console/lib/editors/lakehouse/dialogs/shortcut-wizard-dialog.tsx` | ADLS |
| `apps/fiab-console/lib/editors/lakehouse/dialogs/small-dialogs.tsx` | Synapse SQL |
| `apps/fiab-console/lib/editors/lakehouse/lakehouse-editor-shell.tsx` | ADLS |
| `apps/fiab-console/lib/editors/lakehouse/panes/tables-pane.tsx` | ADLS |
| `apps/fiab-console/lib/editors/logic-app-editor.tsx` | Logic Apps |
| `apps/fiab-console/lib/editors/mapping-dataflow-editor.tsx` | ADF |
| `apps/fiab-console/lib/editors/ml-experiment-editor.tsx` | AML |
| `apps/fiab-console/lib/editors/model-serving-endpoint-editor.tsx` | AML |
| `apps/fiab-console/lib/editors/mounted-adf-editor.tsx` | ADF |
| `apps/fiab-console/lib/editors/palantir/health-check-editor.tsx` | Azure Monitor, Logic Apps |
| `apps/fiab-console/lib/editors/palantir/release-environment-editor.tsx` | ACR, App Service |
| `apps/fiab-console/lib/editors/palantir/slate-app-editor.tsx` | App Service |
| `apps/fiab-console/lib/editors/palantir/workshop-app-editor.tsx` | App Service |
| `apps/fiab-console/lib/editors/phase3/activator-editor.tsx` | Azure Monitor |
| `apps/fiab-console/lib/editors/phase3/dashboard-editor.tsx` | Power BI |
| `apps/fiab-console/lib/editors/phase3/eventhouse-editor.tsx` | ADLS, ADX |
| `apps/fiab-console/lib/editors/phase3/kql-dashboard-editor.tsx` | ADX |
| `apps/fiab-console/lib/editors/phase3/kql-database-editor.tsx` | ADX, Event Hubs, IoT Hub |
| `apps/fiab-console/lib/editors/phase3/kql-queryset-editor.tsx` | Azure Monitor |
| `apps/fiab-console/lib/editors/phase3/report-editor.tsx` | AAS, Power BI |
| `apps/fiab-console/lib/editors/phase3/scorecard-editor.tsx` | Power BI |
| `apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx` | Power BI |
| `apps/fiab-console/lib/editors/phase3/semantic-model-editor/aas-panel.tsx` | AAS |
| `apps/fiab-console/lib/editors/phase3/workspace-picker.tsx` | Power BI |
| `apps/fiab-console/lib/editors/phase4/data-agent-editor.tsx` | Azure Monitor |
| `apps/fiab-console/lib/editors/phase4/operations-agent-editor.tsx` | Azure Monitor |
| `apps/fiab-console/lib/editors/pipeline-create-factory-form.tsx` | ARM |
| `apps/fiab-console/lib/editors/pipeline-editor-core.tsx` | ADF |
| `apps/fiab-console/lib/editors/report/map-visual.tsx` | Azure Maps |
| `apps/fiab-console/lib/editors/stream-analytics-editor.tsx` | ADX, Azure Storage, Event Hubs |
| `apps/fiab-console/lib/editors/synapse-spark-editor.tsx` | ADLS |
| `apps/fiab-console/lib/editors/tapestry-editor.tsx` | Azure Maps |
| `apps/fiab-console/lib/editors/unified-sql-database-editor.tsx` | Azure Networking, Azure SQL, PostgreSQL |
| `apps/fiab-console/lib/estate/pause-orchestrator.ts` | AAS, ADX, Compute, Synapse |
| `apps/fiab-console/lib/gates/registry/azure-services.ts` | Cost Management |
| `apps/fiab-console/lib/gates/registry/data-plane.ts` | Azure RBAC |
| `apps/fiab-console/lib/gates/registry/types.ts` | AAS, ADF, ADX, AI Search, AML, APIM, Azure AI Services, Azure Maps, Azure SQL, Azure Storage, Batch, Container Apps, Cosmos, Databricks, Event Hubs, Key Vault, Log Analytics, PostgreSQL, Purview, Service Bus, Synapse |
| `apps/fiab-console/lib/governance/workspace-egress-pane.tsx` | Azure Storage |
| `apps/fiab-console/lib/install/provisioners/_seed-dev-pipeline.ts` | ADLS |
| `apps/fiab-console/lib/install/provisioners/ai-search.ts` | AI Search |
| `apps/fiab-console/lib/install/provisioners/data-product.ts` | Purview |
| `apps/fiab-console/lib/install/provisioners/evaluation.ts` | AML |
| `apps/fiab-console/lib/install/provisioners/eventstream.ts` | Fabric |
| `apps/fiab-console/lib/install/provisioners/kql-dashboard.ts` | Fabric |
| `apps/fiab-console/lib/install/provisioners/kql-db.ts` | ADX |
| `apps/fiab-console/lib/install/provisioners/lakehouse.ts` | Azure Storage, Fabric |
| `apps/fiab-console/lib/install/provisioners/logic-app.ts` | Logic Apps |
| `apps/fiab-console/lib/install/provisioners/mirrored-database.ts` | ADLS |
| `apps/fiab-console/lib/install/provisioners/mirrored-databricks.ts` | Databricks |
| `apps/fiab-console/lib/install/provisioners/notebook.ts` | Synapse |
| `apps/fiab-console/lib/install/provisioners/prompt-flow.ts` | AML |
| `apps/fiab-console/lib/install/provisioners/report.ts` | Fabric |
| `apps/fiab-console/lib/install/provisioners/semantic-model.ts` | Fabric, Power BI |
| `apps/fiab-console/lib/install/provisioners/workspace-monitor.ts` | ADX, APIM, ARM, Azure RBAC, Container Apps |
| `apps/fiab-console/lib/logic-app/auto-bind.ts` | Logic Apps |
| `apps/fiab-console/lib/mcp/catalog.ts` | AI Foundry, ARM, Azure DevOps, Dataverse, Fabric, Microsoft Graph, Microsoft Sentinel, Power BI |
| `apps/fiab-console/lib/mesh/agent-mesh-console.tsx` | Azure OpenAI |
| `apps/fiab-console/lib/migrate/migrate-client.ts` | Loom service |
| `apps/fiab-console/lib/monitor/monitor-alert-editor.tsx` | Azure Monitor |
| `apps/fiab-console/lib/panes/cmk.tsx` | Azure Storage, Key Vault |
| `apps/fiab-console/lib/parity/parity-issue.ts` | GitHub |
| `apps/fiab-console/lib/perf/apply-change.ts` | ADX, Synapse |
| `apps/fiab-console/lib/pipeline/connector-catalog.ts` | ADLS, ADX, Azure SQL, Azure Storage, Cosmos, Databricks, Dataverse, PostgreSQL, Synapse SQL |
| `apps/fiab-console/lib/pipeline/trigger-catalog.ts` | Azure Storage, Event Grid |
| `apps/fiab-console/lib/power-platform/power-automate-editor.tsx` | Logic Apps |
| `apps/fiab-console/lib/semantic-model/calc-objects.ts` | AAS |
| `apps/fiab-console/lib/semantic-model/xmla-writes.ts` | AAS |
| `apps/fiab-console/lib/setup/deploy-preflight.ts` | ADX, ARM, Azure Networking, Azure RBAC, Azure Storage, Cosmos, Key Vault, Managed Identity |
| `apps/fiab-console/lib/setup/estate-scan.ts` | Resource Graph |
| `apps/fiab-console/lib/setup/lz-rbac.ts` | Azure RBAC |
| `apps/fiab-console/lib/setup/user-arm-deploy.ts` | ARM |
| `apps/fiab-console/lib/setup/wire-existing.ts` | Resource Graph |
| `apps/fiab-console/lib/telemetry/rum-ingest.ts` | Azure Monitor |
| `apps/fiab-console/lib/versions/item-version-store.ts` | Cosmos |
