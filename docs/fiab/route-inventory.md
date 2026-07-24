# CSA Loom — API route inventory (WS-D3)

> GENERATED — do not edit by hand.
> Regenerate: `node scripts/ci/generate-route-inventory.mjs`.
> CI drift gate: `node scripts/ci/generate-route-inventory.mjs --check`.

Taxonomy of every `apps/fiab-console/app/api/**/route.ts` — classified by
auth scope, gate behavior, and backend dependency. Detection mirrors
`scripts/ci/check-route-guards.mjs` (same session / owner-guard / admin signals,
same classic + WS-D1 toolkit export styles).

## Summary

| Metric | Count |
| --- | ---: |
| Total routes | 1590 |
| Public (no session) | 116 |
| Session-only | 572 |
| Owner-scoped | 642 |
| Admin | 260 |
| Gated (backend config) | 519 |
| Areas | 105 |

**Auth scope** — `public`: no session check; `session-only`: signed-in but
no per-resource authz; `owner-scoped`: owner/workspace-ACL check on the
target item; `admin`: tenant/domain-admin gate. **Gated** = the route honest-
gates on a backend being configured (see `docs/fiab/gate-registry.md`).

## a2a

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `a2a/delegate/route.ts` | POST | owner-scoped |  | — |
| `a2a/route.ts` | GET POST | owner-scoped |  | — |

## access-governance

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `access-governance/assignments/[id]/activate/route.ts` | POST | owner-scoped |  | Cosmos |
| `access-governance/backfill/route.ts` | POST | admin |  | Cosmos |
| `access-governance/group-sync/route.ts` | POST | admin | ● | Cosmos |
| `access-governance/report/route.ts` | GET | admin | ● | Cosmos |
| `access-governance/reviews/[id]/decision/route.ts` | POST | admin |  | Cosmos |
| `access-governance/reviews/[id]/route.ts` | GET PATCH DELETE | admin |  | Cosmos |
| `access-governance/reviews/route.ts` | GET POST | admin |  | Cosmos |
| `access-governance/reviews/sweep/route.ts` | POST | admin |  | Cosmos |
| `access-governance/revoke-all/route.ts` | POST | admin |  | Cosmos |
| `access-governance/sweep/route.ts` | POST | admin |  | Cosmos |

## access-packages

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `access-packages/[id]/request/route.ts` | POST | admin |  | Cosmos |
| `access-packages/[id]/route.ts` | GET PUT DELETE | admin |  | Cosmos |
| `access-packages/route.ts` | GET POST | admin |  | Cosmos |

## access-requests

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `access-requests/[id]/decision/route.ts` | POST | admin |  | Cosmos |
| `access-requests/bulk-decision/route.ts` | POST | session-only |  | — |
| `access-requests/public/route.ts` | POST | public |  | Cosmos |
| `access-requests/route.ts` | GET | owner-scoped |  | Cosmos |

## activity

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `activity/route.ts` | GET | owner-scoped |  | Cosmos |

## adf

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `adf/cdc/route.ts` | GET POST DELETE | session-only | ● | ADF |
| `adf/dataflows/[name]/debug/route.ts` | GET POST | public | ● | ADF |
| `adf/dataflows/[name]/route.ts` | GET PUT DELETE | public | ● | ADF |
| `adf/dataflows/route.ts` | GET POST DELETE | session-only | ● | ADF |
| `adf/datasets/[name]/route.ts` | GET | public | ● | ADF |
| `adf/datasets/route.ts` | GET POST DELETE | session-only | ● | ADF |
| `adf/factories/create/route.ts` | POST | session-only |  | — |
| `adf/global-parameters/route.ts` | GET PUT | session-only | ● | ADF |
| `adf/integration-runtimes/route.ts` | GET POST DELETE | session-only | ● | ADF |
| `adf/linked-services/[name]/route.ts` | GET | public | ● | ADF |
| `adf/linked-services/route.ts` | GET POST DELETE | session-only | ● | ADF |
| `adf/linked-services/test/route.ts` | POST | session-only | ● | ADF |
| `adf/managed-private-endpoints/route.ts` | GET POST DELETE | session-only | ● | ADF |
| `adf/pipelines/route.ts` | GET POST DELETE | session-only | ● | ADF |
| `adf/resource-json/route.ts` | GET | session-only | ● | ADF |
| `adf/triggers/route.ts` | GET POST DELETE | session-only | ● | ADF |

## admin

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `admin/access-requests/[id]/route.ts` | PATCH | admin |  | Cosmos |
| `admin/access-requests/route.ts` | GET | admin |  | Cosmos |
| `admin/agent-quality/eval-alert/route.ts` | GET POST DELETE | admin | ● | Azure Monitor |
| `admin/agent-quality/route.ts` | GET | admin | ● | Cosmos |
| `admin/audit-logs/route.ts` | GET | admin |  | Azure Monitor, Cosmos, Purview |
| `admin/autopilot/apply/route.ts` | POST | admin |  | — |
| `admin/autopilot/route.ts` | GET PUT | admin |  | — |
| `admin/autopilot/run/route.ts` | POST | admin |  | — |
| `admin/azure-resources/route.ts` | GET | admin | ● | — |
| `admin/batch-labeling/route.ts` | GET POST | admin |  | Cosmos, Purview |
| `admin/bootstrap-catalogs/route.ts` | POST | admin |  | Cosmos |
| `admin/capacity/chargeback/route.ts` | GET | admin |  | — |
| `admin/capacity/cost/route.ts` | GET | admin |  | Azure Monitor |
| `admin/capacity/guardrails/route.ts` | GET PUT | admin |  | — |
| `admin/capacity/utilization/route.ts` | POST | admin |  | Azure Monitor |
| `admin/capacity/viz-config/route.ts` | GET | admin |  | — |
| `admin/chargeback/attribution/route.ts` | GET | admin |  | — |
| `admin/chargeback/route.ts` | GET | admin |  | Azure Monitor, Cosmos |
| `admin/chargeback/workspaces/route.ts` | GET | admin |  | Azure Monitor |
| `admin/classifications/route.ts` | GET POST DELETE | admin |  | Cosmos, Purview |
| `admin/coe-library/render/route.ts` | GET POST | admin |  | — |
| `admin/coe-library/route.ts` | GET POST DELETE | admin |  | Cosmos |
| `admin/copilot-config/route.ts` | GET PUT | admin |  | Cosmos |
| `admin/copilot-quality/[surface]/route.ts` | GET | admin |  | — |
| `admin/copilot-quality/budgets/route.ts` | GET POST DELETE | admin |  | — |
| `admin/copilot-quality/prompts/[promptId]/route.ts` | GET POST | admin |  | — |
| `admin/copilot-quality/prompts/route.ts` | GET POST | admin |  | — |
| `admin/copilot-quality/route.ts` | GET | admin |  | — |
| `admin/copilot-quality/run/route.ts` | POST | admin | ● | Cosmos |
| `admin/copilot-quality/search/route.ts` | GET | admin |  | — |
| `admin/copilot-quality/tier/route.ts` | GET | admin |  | — |
| `admin/copilot-usage/route.ts` | GET | admin |  | Azure Monitor |
| `admin/copilot/memory/[id]/route.ts` | DELETE | admin |  | — |
| `admin/copilot/memory/audit/route.ts` | GET | admin |  | — |
| `admin/copilot/memory/route.ts` | GET POST | admin |  | — |
| `admin/data-products-backend/route.ts` | GET | admin |  | — |
| `admin/data-quality-rules/route.ts` | GET POST PUT DELETE | admin |  | Cosmos |
| `admin/deploy-plan/cost-estimate/route.ts` | POST | admin |  | — |
| `admin/deploy-plan/route.ts` | GET PUT | admin |  | Cosmos |
| `admin/developer/tokens/[id]/route.ts` | DELETE | admin |  | — |
| `admin/developer/tokens/route.ts` | GET | admin |  | — |
| `admin/diagnostics/bundle/route.ts` | GET | admin |  | Cosmos |
| `admin/domains/[id]/inventory/route.ts` | GET | admin |  | — |
| `admin/domains/assign-workspaces/route.ts` | POST | admin |  | Cosmos |
| `admin/domains/images/route.ts` | GET | admin |  | ADLS |
| `admin/domains/mesh/route.ts` | GET | admin |  | — |
| `admin/domains/purview-status/route.ts` | GET | admin |  | Purview |
| `admin/domains/route.ts` | GET POST PATCH DELETE | admin |  | Cosmos |
| `admin/domains/sync/route.ts` | GET POST | admin |  | — |
| `admin/dspm-ai/route.ts` | GET | admin | ● | — |
| `admin/embed-codes/route.ts` | GET POST DELETE | admin | ● | Cosmos |
| `admin/env-config/route.ts` | GET PUT | admin |  | — |
| `admin/feedback-forwarding/route.ts` | GET PUT | admin |  | Cosmos |
| `admin/finops/anomalies/route.ts` | GET PUT DELETE | admin |  | Cosmos |
| `admin/finops/breakdown/route.ts` | GET | admin |  | — |
| `admin/finops/budgets/route.ts` | GET POST PUT DELETE | admin |  | — |
| `admin/finops/forecast/route.ts` | GET | admin |  | — |
| `admin/gates/[id]/options/route.ts` | GET | admin | ● | — |
| `admin/gates/[id]/resolve/route.ts` | POST | admin | ● | — |
| `admin/gates/route.ts` | GET | admin | ● | — |
| `admin/governance-catalog/reindex/route.ts` | POST | admin | ● | Cosmos |
| `admin/health/exercise/route.ts` | GET POST | admin |  | — |
| `admin/lineage/reconcile/route.ts` | GET POST | admin |  | Purview |
| `admin/load-sample-data/route.ts` | POST | admin |  | ADX |
| `admin/mcp-servers/bridge/route.ts` | GET | admin |  | — |
| `admin/mcp-servers/builtin/route.ts` | GET | admin |  | — |
| `admin/mcp-servers/deploy/route.ts` | GET POST | admin | ● | Cosmos |
| `admin/mcp-servers/deployed/status/route.ts` | GET | admin |  | — |
| `admin/mcp-servers/deployed/teardown/route.ts` | DELETE | admin |  | Cosmos |
| `admin/mcp-servers/ms-remote/config/route.ts` | GET PUT | admin |  | Cosmos |
| `admin/mcp-servers/ms-remote/route.ts` | GET POST | admin |  | Cosmos |
| `admin/mcp-servers/powerbi/route.ts` | GET POST | admin | ● | Cosmos |
| `admin/mcp-servers/route.ts` | GET POST PUT DELETE | admin |  | Cosmos |
| `admin/mcp-servers/test-connection/route.ts` | POST | admin |  | — |
| `admin/model-fabric/route.ts` | GET PUT | admin |  | — |
| `admin/model-fabric/run/route.ts` | POST | admin |  | — |
| `admin/network/topology/route.ts` | GET | admin |  | — |
| `admin/ops-copilot/execute/route.ts` | POST | admin |  | Cosmos |
| `admin/ops-copilot/route.ts` | POST | admin |  | Cosmos |
| `admin/org-visuals/dashboards/render/route.ts` | GET POST | admin |  | — |
| `admin/org-visuals/dashboards/route.ts` | GET POST PUT DELETE | admin |  | Cosmos |
| `admin/org-visuals/route.ts` | GET POST PUT DELETE | admin | ● | Cosmos |
| `admin/overview/route.ts` | GET | admin |  | Azure Monitor, Cosmos |
| `admin/parity-autopilot/route.ts` | GET | admin | ● | — |
| `admin/parity-autopilot/run/route.ts` | POST | admin |  | — |
| `admin/pdp/shadow-report/route.ts` | GET | admin |  | Cosmos |
| `admin/performance/cache-stats/route.ts` | GET | admin |  | — |
| `admin/performance/copilot-slo/route.ts` | GET | admin |  | — |
| `admin/performance/prove-warm/route.ts` | POST | admin | ● | — |
| `admin/performance/recommendations/apply/route.ts` | POST | admin |  | — |
| `admin/performance/recommendations/route.ts` | GET | admin |  | — |
| `admin/performance/retrieval-stats/route.ts` | GET | admin |  | — |
| `admin/performance/route.ts` | GET | admin |  | Cosmos |
| `admin/performance/run/route.ts` | GET POST | admin |  | — |
| `admin/performance/tunables/route.ts` | GET POST | admin |  | — |
| `admin/permissions/capabilities/route.ts` | GET | admin |  | — |
| `admin/permissions/grants/route.ts` | GET POST DELETE | admin |  | Cosmos |
| `admin/permissions/principals/route.ts` | GET | admin |  | — |
| `admin/platform-settings/route.ts` | GET PUT | admin |  | Cosmos |
| `admin/policy-code/reconcile/route.ts` | GET POST | admin |  | — |
| `admin/policy-code/route.ts` | GET PUT | admin |  | — |
| `admin/protection-policies/[id]/route.ts` | GET DELETE | admin |  | — |
| `admin/protection-policies/route.ts` | GET POST | admin |  | — |
| `admin/readiness/export/route.ts` | GET | admin |  | — |
| `admin/readiness/route.ts` | GET | admin | ● | — |
| `admin/refresh-summary/route.ts` | GET | admin | ● | ADF, Azure Monitor, Cosmos |
| `admin/reindex-items/route.ts` | POST | admin |  | Cosmos |
| `admin/rum/route.ts` | GET | admin |  | Azure Monitor |
| `admin/runtime-flags/[id]/route.ts` | PUT | admin |  | — |
| `admin/runtime-flags/route.ts` | GET | admin |  | — |
| `admin/scaling/adx/route.ts` | GET POST PUT | admin |  | ADX ARM |
| `admin/scaling/ai-search/route.ts` | GET POST | admin |  | — |
| `admin/scaling/aks/route.ts` | GET POST | admin |  | — |
| `admin/scaling/apim/route.ts` | GET POST | admin | ● | APIM |
| `admin/scaling/capacity/route.ts` | GET POST | admin |  | — |
| `admin/scaling/compute/purview-managed-vnet/route.ts` | GET POST | admin |  | Purview |
| `admin/scaling/compute/register-purview-shir/route.ts` | GET POST | admin |  | Purview |
| `admin/scaling/compute/route.ts` | GET POST | admin | ● | — |
| `admin/scaling/container-apps/route.ts` | GET POST | admin |  | — |
| `admin/scaling/cosmos/route.ts` | GET POST | admin | ● | Cosmos |
| `admin/scaling/databricks-cluster/route.ts` | GET POST | admin | ● | Databricks |
| `admin/scaling/databricks-warehouse/route.ts` | GET POST | admin | ● | Databricks |
| `admin/scaling/foundry-compute/route.ts` | GET POST | admin |  | — |
| `admin/scaling/synapse-dwu/route.ts` | GET POST | admin | ● | Synapse |
| `admin/scaling/utilization/route.ts` | GET | admin | ● | Azure Monitor |
| `admin/secret-health/route.ts` | GET | admin |  | — |
| `admin/security/dlp/alerts/route.ts` | GET | admin |  | — |
| `admin/security/dlp/manage/route.ts` | GET POST PATCH DELETE | admin | ● | — |
| `admin/security/dlp/policies/route.ts` | GET | admin |  | — |
| `admin/security/dlp/simulate/route.ts` | POST | admin |  | — |
| `admin/security/dlp/violations/route.ts` | GET | admin |  | — |
| `admin/security/mip/applicable-items/route.ts` | GET | admin |  | Cosmos |
| `admin/security/mip/evaluate/route.ts` | POST | admin |  | — |
| `admin/security/mip/labels/[id]/route.ts` | PATCH DELETE | admin | ● | — |
| `admin/security/mip/labels/route.ts` | GET POST | admin | ● | — |
| `admin/security/mip/policies/[id]/route.ts` | PATCH DELETE | admin | ● | — |
| `admin/security/mip/policies/route.ts` | GET POST | admin | ● | — |
| `admin/security/purview/collections/route.ts` | GET | admin | ● | Purview |
| `admin/security/purview/dataquality/route.ts` | GET | admin | ● | Cosmos, Purview |
| `admin/security/purview/discover/route.ts` | GET | admin |  | — |
| `admin/security/purview/domains/route.ts` | GET POST | admin |  | Purview |
| `admin/security/purview/glossary/route.ts` | GET POST | admin |  | Purview |
| `admin/security/purview/scans/route.ts` | GET POST | admin |  | Purview |
| `admin/security/purview/sources/route.ts` | GET POST DELETE | admin | ● | Purview |
| `admin/self-audit/route.ts` | GET POST | admin |  | — |
| `admin/sensitivity-labels/route.ts` | GET POST DELETE | admin |  | Cosmos |
| `admin/slo/route.ts` | GET | admin |  | — |
| `admin/spark-telemetry/audit/route.ts` | GET POST | admin |  | — |
| `admin/spark/chaos/route.ts` | POST | admin | ● | — |
| `admin/spark/health/route.ts` | GET | admin | ● | Synapse |
| `admin/spark/recover/route.ts` | GET POST | admin | ● | — |
| `admin/synthetic-runs/route.ts` | GET | admin | ● | — |
| `admin/tenant-settings/groups/route.ts` | GET | admin | ● | — |
| `admin/tenant-settings/route.ts` | GET PUT | admin |  | Cosmos |
| `admin/updates/apply/route.ts` | GET POST | admin | ● | Cosmos |
| `admin/updates/status/route.ts` | GET | admin | ● | — |
| `admin/usage/embed/route.ts` | GET | admin | ● | — |
| `admin/usage/route.ts` | GET | admin |  | Cosmos |
| `admin/users/route.ts` | GET | admin |  | Cosmos |
| `admin/webhooks/[id]/route.ts` | GET PATCH DELETE | admin |  | — |
| `admin/webhooks/[id]/test/route.ts` | POST | admin |  | — |
| `admin/webhooks/route.ts` | GET POST | admin |  | — |
| `admin/workspaces/[id]/cmk/route.ts` | GET POST DELETE | admin | ● | Cosmos |
| `admin/workspaces/[id]/connections/[connId]/route.ts` | DELETE | admin |  | — |
| `admin/workspaces/[id]/connections/adls-accounts/route.ts` | GET | admin |  | — |
| `admin/workspaces/[id]/connections/log-analytics-workspaces/route.ts` | GET | admin |  | — |
| `admin/workspaces/[id]/connections/route.ts` | GET POST | admin |  | Cosmos |
| `admin/workspaces/[id]/folders/route.ts` | GET POST PATCH DELETE | admin |  | — |
| `admin/workspaces/[id]/git/branch-out/route.ts` | POST | admin |  | Cosmos |
| `admin/workspaces/[id]/git/meta/route.ts` | GET | admin |  | — |
| `admin/workspaces/[id]/git/route.ts` | GET POST DELETE | admin |  | — |
| `admin/workspaces/[id]/git/status/route.ts` | GET | admin |  | — |
| `admin/workspaces/[id]/git/sync/route.ts` | POST | admin |  | Cosmos |
| `admin/workspaces/[id]/identity/route.ts` | GET POST | admin |  | Cosmos |
| `admin/workspaces/[id]/m365/route.ts` | POST | admin |  | Cosmos |
| `admin/workspaces/[id]/networking/inbound/route.ts` | GET POST | admin |  | — |
| `admin/workspaces/[id]/networking/ip-rules/route.ts` | GET POST DELETE | admin |  | — |
| `admin/workspaces/[id]/networking/outbound/route.ts` | GET POST DELETE | admin |  | — |
| `admin/workspaces/[id]/networking/trusted-resources/route.ts` | GET POST DELETE | admin | ● | — |
| `admin/workspaces/[id]/networking/trusted/route.ts` | GET POST DELETE | admin |  | — |
| `admin/workspaces/[id]/route.ts` | GET PATCH DELETE | admin |  | Cosmos |
| `admin/workspaces/[id]/spark/environment/route.ts` | GET POST | admin | ● | Cosmos |
| `admin/workspaces/[id]/spark/jobs/route.ts` | GET POST | admin | ● | — |
| `admin/workspaces/[id]/spark/pools/route.ts` | GET POST DELETE | admin | ● | Cosmos |
| `admin/workspaces/[id]/spark/runtime/route.ts` | GET POST | admin | ● | — |
| `admin/workspaces/[id]/storage-metrics/route.ts` | GET | admin | ● | Azure Monitor |
| `admin/workspaces/[id]/task-flows/[flowId]/route.ts` | GET PUT DELETE | admin |  | — |
| `admin/workspaces/[id]/task-flows/route.ts` | GET POST | admin |  | — |
| `admin/workspaces/route.ts` | GET POST | admin |  | Cosmos |

## adx

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `adx/anomaly/route.ts` | POST | admin |  | ADX |
| `adx/continuous-exports/route.ts` | GET POST DELETE | owner-scoped |  | ADX |
| `adx/external-tables/route.ts` | GET POST DELETE | owner-scoped |  | ADX |
| `adx/functions/route.ts` | GET POST DELETE | owner-scoped |  | ADX |
| `adx/ingestion-mappings/route.ts` | GET POST DELETE | owner-scoped |  | ADX |
| `adx/materialized-views/route.ts` | GET POST DELETE | owner-scoped |  | ADX |
| `adx/overview/route.ts` | GET | owner-scoped |  | ADX |
| `adx/policies/route.ts` | GET POST | owner-scoped |  | ADX |
| `adx/policy-authoring/route.ts` | POST | owner-scoped |  | ADX |
| `adx/principals/route.ts` | GET POST | owner-scoped |  | ADX |
| `adx/rls/route.ts` | GET POST | owner-scoped |  | ADX |
| `adx/tables/route.ts` | GET POST PATCH DELETE | owner-scoped |  | ADX |

## ai-functions

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ai-functions/route.ts` | POST | owner-scoped | ● | — |
| `ai-functions/table/route.ts` | POST | owner-scoped | ● | — |

## ai-search

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ai-search/aliases/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/datasources/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/debug-sessions/route.ts` | GET POST DELETE | session-only | ● | — |
| `ai-search/index-my-data/prepare/route.ts` | GET | owner-scoped |  | — |
| `ai-search/index-my-data/run/route.ts` | POST | owner-scoped | ● | AI Search |
| `ai-search/index-my-data/sources/route.ts` | GET | owner-scoped |  | — |
| `ai-search/indexers/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/indexes/[name]/analyze/route.ts` | POST | session-only | ● | AI Search |
| `ai-search/indexes/[name]/route.ts` | GET PUT | session-only | ● | AI Search |
| `ai-search/indexes/[name]/search/route.ts` | POST | session-only | ● | AI Search |
| `ai-search/indexes/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/knowledge-bases/[name]/retrieve/route.ts` | POST | session-only | ● | — |
| `ai-search/knowledge-bases/[name]/route.ts` | GET | session-only | ● | — |
| `ai-search/knowledge-bases/route.ts` | GET POST DELETE | session-only | ● | — |
| `ai-search/knowledge-sources/route.ts` | GET POST DELETE | session-only | ● | — |
| `ai-search/service/metrics/route.ts` | GET | owner-scoped | ● | — |
| `ai-search/service/route.ts` | GET POST | owner-scoped | ● | — |
| `ai-search/skillsets/route.ts` | GET POST DELETE | session-only | ● | AI Search |
| `ai-search/synonymmaps/route.ts` | GET POST DELETE | session-only | ● | AI Search |

## aml

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `aml/compute-instances/[name]/idle-shutdown/route.ts` | POST | public | ● | AML |
| `aml/compute-instances/[name]/start/route.ts` | POST | public | ● | AML |
| `aml/compute-instances/[name]/stop/route.ts` | POST | public | ● | AML |
| `aml/compute-instances/mine/route.ts` | GET POST | owner-scoped | ● | AML |
| `aml/compute-instances/route.ts` | GET POST | session-only | ● | AML |
| `aml/datastores/route.ts` | GET | session-only | ● | AML |
| `aml/environments/route.ts` | GET POST PATCH | owner-scoped | ● | Cosmos |
| `aml/experiments/route.ts` | GET | session-only |  | — |
| `aml/runs/[runId]/artifact/route.ts` | GET | public | ● | — |
| `aml/runs/[runId]/artifacts/route.ts` | GET | public |  | — |
| `aml/runs/[runId]/metrics/route.ts` | GET | public |  | — |
| `aml/runs/[runId]/route.ts` | POST | public |  | — |
| `aml/runs/[runId]/traces/route.ts` | GET | public |  | — |
| `aml/runs/route.ts` | GET POST | session-only |  | — |

## analytics

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `analytics/visualize/route.ts` | POST | owner-scoped |  | — |

## apim

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `apim/apis/route.ts` | GET POST DELETE | session-only | ● | APIM |
| `apim/backends/route.ts` | GET POST DELETE | session-only | ● | APIM |
| `apim/developer-portal/route.ts` | GET POST | session-only | ● | APIM |
| `apim/gateways/route.ts` | GET | session-only | ● | APIM |
| `apim/import/route.ts` | POST | session-only | ● | APIM |
| `apim/instances/route.ts` | GET | session-only | ● | — |
| `apim/named-values/route.ts` | GET POST DELETE | admin | ● | APIM |
| `apim/operations/route.ts` | GET | session-only | ● | APIM |
| `apim/products/route.ts` | GET POST DELETE | session-only | ● | APIM |
| `apim/service/route.ts` | GET PATCH | session-only | ● | APIM |
| `apim/subscriptions/[sid]/keys/route.ts` | GET | public | ● | APIM |
| `apim/subscriptions/[sid]/route.ts` | PATCH DELETE | public | ● | APIM |
| `apim/subscriptions/route.ts` | GET POST DELETE | session-only | ● | APIM |

## app-templates

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `app-templates/[templateId]/instantiate/route.ts` | POST | owner-scoped |  | — |

## approval-policies

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `approval-policies/[id]/route.ts` | GET PUT DELETE | admin |  | Cosmos |
| `approval-policies/route.ts` | GET POST | admin |  | Cosmos |

## apps

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `apps/[id]/install/route.ts` | POST | owner-scoped |  | ADLS, Cosmos |
| `apps/install-jobs/[jobId]/route.ts` | GET | owner-scoped |  | Cosmos |
| `apps/supercharge/seed/route.ts` | POST | owner-scoped |  | Cosmos |

## apps-catalog

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `apps-catalog/route.ts` | GET POST | owner-scoped |  | Cosmos |

## ask

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ask/route.ts` | POST | owner-scoped | ● | — |

## attribute-groups

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `attribute-groups/route.ts` | GET POST | owner-scoped |  | Cosmos |

## auth

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `auth/cli-session/route.ts` | POST | public | ● | — |
| `auth/me/route.ts` | GET | owner-scoped |  | — |
| `auth/refresh/route.ts` | POST | owner-scoped |  | — |

## azure

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `azure/connectables/route.ts` | GET | owner-scoped |  | — |
| `azure/function-apps/route.ts` | GET | session-only | ● | — |
| `azure/iothub/policies/route.ts` | GET | owner-scoped |  | — |
| `azure/resources/route.ts` | GET | owner-scoped |  | — |

## business-events

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `business-events/channels/route.ts` | GET | session-only | ● | Azure Monitor, Event Hubs |
| `business-events/publish/route.ts` | POST | session-only | ● | Event Hubs |
| `business-events/topics/route.ts` | GET POST DELETE | session-only | ● | — |
| `business-events/types/route.ts` | GET POST DELETE | owner-scoped | ● | — |

## canvas

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `canvas/suggest-next/route.ts` | POST | owner-scoped | ● | — |

## capacity

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `capacity/admit/route.ts` | POST | admin |  | — |

## catalog

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `catalog/asset/[id]/route.ts` | GET | session-only |  | Purview |
| `catalog/browse/route.ts` | GET | owner-scoped |  | Purview |
| `catalog/domains/route.ts` | GET POST DELETE | session-only |  | Purview |
| `catalog/find/route.ts` | GET | owner-scoped |  | — |
| `catalog/glossary/route.ts` | GET POST | session-only |  | Purview |
| `catalog/iceberg/config/route.ts` | GET | public |  | — |
| `catalog/iceberg/connect/route.ts` | GET | session-only | ● | — |
| `catalog/iceberg/namespaces/route.ts` | GET POST | public |  | — |
| `catalog/iceberg/overview/route.ts` | GET | admin | ● | Cosmos |
| `catalog/iceberg/table/route.ts` | GET | public |  | — |
| `catalog/iceberg/tables/route.ts` | GET POST DELETE | public |  | — |
| `catalog/lineage/item/route.ts` | GET | session-only |  | Purview |
| `catalog/lineage/route.ts` | GET | session-only |  | Purview |
| `catalog/metastores/route.ts` | GET POST | owner-scoped | ● | Cosmos, Purview |
| `catalog/permissions/route.ts` | GET POST DELETE | session-only |  | — |
| `catalog/register/route.ts` | POST | owner-scoped | ● | Purview |
| `catalog/request-access/route.ts` | POST | owner-scoped |  | Cosmos |
| `catalog/search/route.ts` | GET | owner-scoped |  | Purview |
| `catalog/shortcut/route.ts` | GET POST DELETE | session-only | ● | Purview |
| `catalog/unity/capabilities/route.ts` | GET | session-only | ● | Databricks |

## cloud

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `cloud/route.ts` | GET | public |  | — |

## config

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `config/ui/route.ts` | GET | public |  | Azure Maps |

## connections

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `connections/[id]/dependents/route.ts` | GET | owner-scoped |  | — |
| `connections/[id]/objects/route.ts` | POST | owner-scoped |  | — |
| `connections/[id]/preview/route.ts` | POST | owner-scoped |  | — |
| `connections/[id]/purview/route.ts` | POST | owner-scoped | ● | — |
| `connections/[id]/route.ts` | GET PATCH DELETE | owner-scoped | ● | Cosmos |
| `connections/[id]/test/route.ts` | POST | owner-scoped |  | — |
| `connections/route.ts` | GET POST DELETE | session-only |  | — |
| `connections/test/route.ts` | POST | owner-scoped |  | — |

## copilot

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `copilot/code-interpret/route.ts` | POST | owner-scoped | ● | Synapse |
| `copilot/complete/route.ts` | POST | owner-scoped | ● | Cosmos |
| `copilot/dax/route.ts` | POST | owner-scoped |  | — |
| `copilot/memory/flush/route.ts` | POST | owner-scoped | ● | — |
| `copilot/notebook-assist/route.ts` | POST | owner-scoped | ● | — |
| `copilot/orchestrate/route.ts` | POST | owner-scoped | ● | — |
| `copilot/sessions/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos |
| `copilot/sessions/[id]/trace/route.ts` | GET | admin |  | Cosmos |
| `copilot/sessions/route.ts` | GET POST | owner-scoped | ● | Cosmos |
| `copilot/skills/[id]/duplicate/route.ts` | POST | owner-scoped |  | — |
| `copilot/skills/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | — |
| `copilot/skills/[id]/state/route.ts` | PATCH | admin |  | — |
| `copilot/skills/route.ts` | GET POST | owner-scoped |  | — |
| `copilot/skills/suggested/[id]/route.ts` | POST | admin |  | — |
| `copilot/skills/suggested/route.ts` | GET | admin |  | — |
| `copilot/status/route.ts` | GET | owner-scoped |  | — |
| `copilot/tools/[name]/invoke/route.ts` | POST | owner-scoped |  | — |
| `copilot/tools/route.ts` | GET | session-only |  | — |

## cosmos

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `cosmos/account-management/route.ts` | GET PATCH | public |  | Cosmos |
| `cosmos/account/route.ts` | GET | public |  | Cosmos |
| `cosmos/container-settings/route.ts` | GET PATCH | public |  | Cosmos |
| `cosmos/container-throughput/route.ts` | GET PATCH | public |  | Cosmos |
| `cosmos/containers/route.ts` | GET POST DELETE | public |  | Cosmos |
| `cosmos/databases/route.ts` | GET POST DELETE | public |  | Cosmos |
| `cosmos/items/action/route.ts` | POST | public |  | — |
| `cosmos/items/rerank/route.ts` | POST | session-only |  | — |
| `cosmos/items/route.ts` | GET POST | public | ● | — |
| `cosmos/scripts/execute/route.ts` | POST | public |  | — |
| `cosmos/scripts/route.ts` | GET PUT DELETE | public |  | Cosmos |

## cosmos-items

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `cosmos-items/[type]/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos |
| `cosmos-items/[type]/route.ts` | POST | owner-scoped |  | Cosmos |

## dab

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `dab/[id]/apply-to-runtime/route.ts` | POST | admin | ● | — |
| `dab/[id]/config/route.ts` | GET PUT | owner-scoped |  | — |
| `dab/[id]/download/route.ts` | POST | session-only |  | — |
| `dab/[id]/preview/graphql/route.ts` | POST | session-only |  | — |
| `dab/[id]/preview/probe/route.ts` | GET | session-only |  | — |
| `dab/[id]/preview/rest/route.ts` | POST | owner-scoped |  | — |
| `dab/[id]/preview/schema/route.ts` | GET | session-only |  | — |
| `dab/[id]/publish/route.ts` | POST | session-only | ● | APIM |
| `dab/[id]/validate/route.ts` | POST | session-only |  | — |
| `dab/create/route.ts` | POST | owner-scoped |  | — |
| `dab/deploy-source/route.ts` | GET POST | owner-scoped | ● | Databricks, Purview |
| `dab/sources/[kind]/columns/route.ts` | GET | session-only | ● | — |
| `dab/sources/[kind]/schema/route.ts` | GET | session-only | ● | — |
| `dab/sources/route.ts` | GET | session-only | ● | — |

## data-agent

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `data-agent/run-steps/route.ts` | POST | owner-scoped | ● | — |

## data-products

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `data-products/[id]/access-policy/route.ts` | GET PUT | owner-scoped |  | — |
| `data-products/[id]/access-requests/route.ts` | GET POST PATCH | owner-scoped |  | Cosmos |
| `data-products/[id]/analytics/route.ts` | GET | owner-scoped |  | Cosmos |
| `data-products/[id]/assets/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos, Purview |
| `data-products/[id]/cdes/route.ts` | GET | owner-scoped |  | Purview |
| `data-products/[id]/certification/route.ts` | GET | owner-scoped |  | Cosmos |
| `data-products/[id]/certify/route.ts` | POST | owner-scoped |  | Cosmos |
| `data-products/[id]/contract-quality/route.ts` | GET POST | owner-scoped | ● | ADX |
| `data-products/[id]/deprecate/route.ts` | POST | owner-scoped |  | — |
| `data-products/[id]/glossary-terms/route.ts` | GET POST DELETE | owner-scoped |  | Purview |
| `data-products/[id]/health-actions/route.ts` | POST | owner-scoped | ● | ADX, Purview |
| `data-products/[id]/observability/route.ts` | GET | owner-scoped | ● | ADX, Purview |
| `data-products/[id]/okrs/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `data-products/[id]/policies/route.ts` | GET | session-only |  | Cosmos |
| `data-products/[id]/ports/route.ts` | GET | session-only |  | Cosmos |
| `data-products/[id]/preview/route.ts` | POST | session-only | ● | ADX, Cosmos |
| `data-products/[id]/principal-search/route.ts` | GET | owner-scoped |  | — |
| `data-products/[id]/route.ts` | GET PATCH DELETE | owner-scoped | ● | Cosmos, Purview |
| `data-products/[id]/sla-check/route.ts` | POST | owner-scoped |  | Cosmos |
| `data-products/[id]/status/route.ts` | POST | owner-scoped |  | Cosmos, Purview |
| `data-products/[id]/subscribers/route.ts` | GET | owner-scoped |  | Cosmos |
| `data-products/[id]/versions/route.ts` | GET POST | owner-scoped |  | — |
| `data-products/import/route.ts` | POST | owner-scoped | ● | ADLS, Cosmos |
| `data-products/import/template/route.ts` | GET | session-only |  | — |
| `data-products/jobs/[jobId]/route.ts` | GET | owner-scoped |  | Cosmos |
| `data-products/my-access-requests/route.ts` | GET | owner-scoped |  | Cosmos |
| `data-products/route.ts` | GET POST | owner-scoped |  | — |
| `data-products/search/route.ts` | POST | owner-scoped | ● | — |

## databricks

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `databricks/catalogs/route.ts` | GET | session-only | ● | Databricks |
| `databricks/clusters/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/jobs/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/mlflow/experiments/route.ts` | GET POST | session-only | ● | Databricks |
| `databricks/mlflow/models/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/notebooks/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/pipelines/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/repos/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/serving-endpoints/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/bindings/route.ts` | GET POST PATCH | session-only | ● | Databricks |
| `databricks/unity-catalog/catalogs/route.ts` | GET POST PATCH DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/clean-rooms/route.ts` | GET POST | session-only | ● | Databricks |
| `databricks/unity-catalog/connections/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/data-classification/route.ts` | GET | session-only | ● | Databricks |
| `databricks/unity-catalog/external-locations/route.ts` | GET POST PATCH DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/functions/route.ts` | GET DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/governed-tags/route.ts` | GET POST | session-only | ● | Databricks |
| `databricks/unity-catalog/grants/route.ts` | GET PATCH | session-only | ● | Databricks |
| `databricks/unity-catalog/lineage/route.ts` | GET | session-only | ● | Databricks |
| `databricks/unity-catalog/marketplace/route.ts` | GET | session-only | ● | Databricks |
| `databricks/unity-catalog/metric-views/route.ts` | GET POST | session-only | ● | Databricks |
| `databricks/unity-catalog/models/route.ts` | GET | session-only | ● | Databricks |
| `databricks/unity-catalog/online-tables/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/policies/route.ts` | GET POST | session-only | ● | Databricks |
| `databricks/unity-catalog/principals/route.ts` | GET | session-only | ● | Databricks |
| `databricks/unity-catalog/quality-monitors/route.ts` | GET | session-only | ● | Databricks |
| `databricks/unity-catalog/schemas/route.ts` | GET POST PATCH DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/storage-credentials/route.ts` | GET POST PATCH DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/system-tables/route.ts` | GET POST | session-only | ● | Databricks |
| `databricks/unity-catalog/tables/route.ts` | GET POST PATCH DELETE | session-only | ● | Databricks |
| `databricks/unity-catalog/tags/route.ts` | GET POST | session-only | ● | Databricks |
| `databricks/unity-catalog/temporary-credentials/route.ts` | POST | session-only | ● | Databricks |
| `databricks/unity-catalog/volumes/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/warehouses/route.ts` | GET POST DELETE | session-only | ● | Databricks |
| `databricks/workspace/route.ts` | GET | session-only | ● | — |

## debug

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `debug/cookie/route.ts` | GET | public |  | — |

## demo

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `demo/deploy/[jobId]/route.ts` | GET | owner-scoped |  | Cosmos |
| `demo/deploy/route.ts` | GET POST | owner-scoped |  | — |

## deployment-pipelines

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `deployment-pipelines/[id]/compare/route.ts` | GET | session-only |  | — |
| `deployment-pipelines/[id]/deploy/route.ts` | POST | session-only |  | — |
| `deployment-pipelines/[id]/operations/route.ts` | GET | session-only |  | — |
| `deployment-pipelines/[id]/stages/[stageId]/items/route.ts` | GET | session-only |  | — |
| `deployment-pipelines/[id]/stages/[stageId]/workspace/route.ts` | POST DELETE | session-only |  | — |
| `deployment-pipelines/[id]/stages/route.ts` | GET | session-only |  | — |
| `deployment-pipelines/arm/[name]/operations/route.ts` | GET | session-only |  | — |
| `deployment-pipelines/arm/route.ts` | GET | session-only |  | — |
| `deployment-pipelines/create/route.ts` | POST | session-only |  | — |
| `deployment-pipelines/git/[workspaceId]/commit/route.ts` | POST | session-only |  | — |
| `deployment-pipelines/git/[workspaceId]/connection/route.ts` | GET POST DELETE | session-only |  | — |
| `deployment-pipelines/git/[workspaceId]/initialize/route.ts` | POST | session-only |  | — |
| `deployment-pipelines/git/[workspaceId]/status/route.ts` | GET | session-only |  | — |
| `deployment-pipelines/git/[workspaceId]/update/route.ts` | POST | session-only |  | — |
| `deployment-pipelines/loom/[id]/approvals/[requestId]/route.ts` | POST | owner-scoped |  | — |
| `deployment-pipelines/loom/[id]/approvals/route.ts` | GET | owner-scoped |  | — |
| `deployment-pipelines/loom/[id]/compare/route.ts` | GET | owner-scoped |  | — |
| `deployment-pipelines/loom/[id]/deploy/route.ts` | POST | owner-scoped |  | — |
| `deployment-pipelines/loom/[id]/history/route.ts` | GET | public |  | Cosmos |
| `deployment-pipelines/loom/[id]/route.ts` | GET DELETE | public |  | Cosmos |
| `deployment-pipelines/loom/[id]/stages/[stageId]/approvals/route.ts` | GET PUT | owner-scoped |  | — |
| `deployment-pipelines/loom/[id]/stages/[stageId]/rules/route.ts` | GET PUT | public |  | — |
| `deployment-pipelines/loom/[id]/variables/route.ts` | GET | owner-scoped |  | — |
| `deployment-pipelines/loom/route.ts` | GET POST | public |  | Cosmos |
| `deployment-pipelines/route.ts` | GET | session-only |  | — |

## developer

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `developer/tokens/[id]/route.ts` | DELETE | owner-scoped |  | — |
| `developer/tokens/route.ts` | GET POST | owner-scoped |  | — |

## directlake

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `directlake/frame/route.ts` | POST | admin |  | — |
| `directlake/scan/route.ts` | POST | admin |  | — |

## downloads

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `downloads/route.ts` | GET POST | owner-scoped |  | Cosmos |

## dq

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `dq/monitors/route.ts` | GET POST DELETE | owner-scoped | ● | Cosmos |
| `dq/results/route.ts` | GET | owner-scoped |  | — |
| `dq/rules/route.ts` | — | public |  | — |
| `dq/run/route.ts` | POST | owner-scoped | ● | — |

## estate

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `estate/execute/route.ts` | POST | owner-scoped |  | — |
| `estate/plan/route.ts` | POST | owner-scoped |  | — |

## eventhubs

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `eventhubs/authrules/[rule]/keys/regenerate/route.ts` | POST | session-only | ● | Event Hubs |
| `eventhubs/authrules/[rule]/keys/route.ts` | POST | session-only | ● | Event Hubs |
| `eventhubs/authrules/route.ts` | GET | session-only | ● | Event Hubs |
| `eventhubs/capture/route.ts` | GET PUT | session-only | ● | Event Hubs |
| `eventhubs/consumergroups/route.ts` | GET POST DELETE | session-only | ● | Event Hubs |
| `eventhubs/data-explorer/route.ts` | GET POST | session-only | ● | — |
| `eventhubs/geodr-actions/route.ts` | POST | session-only | ● | Event Hubs |
| `eventhubs/geodr/route.ts` | GET | session-only | ● | Event Hubs |
| `eventhubs/hubs/route.ts` | GET POST DELETE | admin | ● | Event Hubs |
| `eventhubs/network/route.ts` | GET PUT | session-only | ● | Event Hubs |
| `eventhubs/private-endpoints/route.ts` | GET POST | session-only | ● | Event Hubs |
| `eventhubs/schemagroups/route.ts` | GET POST DELETE | session-only | ● | Event Hubs |

## experience

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `experience/warp/home/route.ts` | GET | owner-scoped |  | Cosmos |
| `experience/warp/transforms/route.ts` | GET POST | owner-scoped |  | Cosmos |

## external-shares

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `external-shares/[id]/accept/route.ts` | POST | session-only |  | — |
| `external-shares/[id]/route.ts` | GET DELETE | session-only |  | — |
| `external-shares/received/route.ts` | GET | session-only |  | — |
| `external-shares/route.ts` | GET POST | owner-scoped |  | Cosmos |

## fabric

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `fabric/workspaces/route.ts` | GET | session-only |  | — |

## feedback

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `feedback/route.ts` | POST | session-only | ● | — |

## foundry

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `foundry/accounts/route.ts` | GET | session-only |  | — |
| `foundry/activity/route.ts` | GET | session-only |  | — |
| `foundry/agents/[name]/route.ts` | GET DELETE | session-only | ● | — |
| `foundry/agents/eval/judge/route.ts` | POST | session-only | ● | — |
| `foundry/agents/eval/route.ts` | GET POST | owner-scoped | ● | — |
| `foundry/agents/rollup/route.ts` | GET | owner-scoped |  | — |
| `foundry/agents/route.ts` | GET POST | owner-scoped | ● | — |
| `foundry/agents/run/route.ts` | POST | owner-scoped | ● | — |
| `foundry/agents/spans/route.ts` | GET | owner-scoped | ● | — |
| `foundry/agents/threads/route.ts` | GET DELETE | owner-scoped |  | — |
| `foundry/audio/route.ts` | POST | session-only |  | — |
| `foundry/batch/[batchId]/route.ts` | GET DELETE | session-only |  | — |
| `foundry/batch/route.ts` | GET POST | session-only |  | — |
| `foundry/browser-tool/status/route.ts` | GET | session-only |  | — |
| `foundry/chat/route.ts` | POST | session-only | ● | AI Search |
| `foundry/computes/[id]/start/route.ts` | POST | session-only |  | — |
| `foundry/computes/[id]/status/route.ts` | GET | session-only |  | — |
| `foundry/computes/route.ts` | GET | session-only |  | — |
| `foundry/connections/route.ts` | GET POST PATCH DELETE | session-only |  | — |
| `foundry/data-sources/route.ts` | GET | session-only | ● | AI Search |
| `foundry/datastores/route.ts` | GET | session-only |  | — |
| `foundry/deployments/route.ts` | GET | session-only |  | — |
| `foundry/evaluations/files/route.ts` | POST | session-only |  | — |
| `foundry/evaluations/route.ts` | GET POST DELETE | session-only |  | — |
| `foundry/fine-tuning/[jobId]/route.ts` | GET POST | session-only |  | — |
| `foundry/fine-tuning/files/route.ts` | POST | session-only |  | — |
| `foundry/fine-tuning/route.ts` | GET POST | session-only |  | — |
| `foundry/images/route.ts` | POST | session-only |  | — |
| `foundry/keys/route.ts` | GET | session-only |  | — |
| `foundry/model-deployments/route.ts` | GET POST DELETE | session-only |  | — |
| `foundry/models-catalog/route.ts` | GET | session-only |  | — |
| `foundry/networking/route.ts` | GET PATCH | session-only |  | — |
| `foundry/observability/route.ts` | GET | session-only |  | — |
| `foundry/quota/route.ts` | GET POST | session-only |  | — |
| `foundry/rbac/route.ts` | GET | session-only |  | — |
| `foundry/workspace/route.ts` | GET | session-only |  | — |

## git-integration

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `git-integration/commit/route.ts` | POST | public |  | — |
| `git-integration/pull/route.ts` | POST | public |  | — |
| `git-integration/resolve/route.ts` | POST | public |  | — |
| `git-integration/status/route.ts` | GET | public |  | — |

## governance

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `governance/catalog/route.ts` | GET | owner-scoped |  | Cosmos |
| `governance/classification-types/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `governance/classifications/route.ts` | GET | owner-scoped |  | Cosmos |
| `governance/classifications/system/route.ts` | GET | session-only |  | Purview |
| `governance/dlp/library/route.ts` | GET POST | admin | ● | — |
| `governance/dlp/meta/route.ts` | GET | owner-scoped |  | — |
| `governance/dlp/restrict/route.ts` | POST | owner-scoped | ● | ADLS, Cosmos |
| `governance/dlp/scan/route.ts` | GET POST | owner-scoped |  | — |
| `governance/dlp/schemas/route.ts` | GET | session-only | ● | — |
| `governance/dlp/violations/route.ts` | GET | owner-scoped |  | — |
| `governance/domains/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `governance/govern/actions/route.ts` | GET | admin |  | Cosmos |
| `governance/govern/copilot/route.ts` | POST | admin |  | — |
| `governance/govern/embed/route.ts` | GET | admin | ● | — |
| `governance/govern/owner/route.ts` | GET | owner-scoped |  | Cosmos |
| `governance/govern/posture/route.ts` | GET | admin | ● | — |
| `governance/govern/refresh/route.ts` | POST | owner-scoped | ● | — |
| `governance/govern/trigger-scan/route.ts` | GET POST | admin | ● | Purview |
| `governance/identities/search/route.ts` | GET | admin | ● | — |
| `governance/insights/route.ts` | GET | owner-scoped |  | Cosmos |
| `governance/irm/route.ts` | GET POST | owner-scoped |  | — |
| `governance/label-propagation/[itemId]/route.ts` | GET | owner-scoped |  | Cosmos |
| `governance/labels/library/route.ts` | GET POST | admin | ● | — |
| `governance/lineage/route.ts` | GET | owner-scoped |  | Cosmos |
| `governance/pdp-mode/route.ts` | GET | session-only |  | — |
| `governance/policies/route.ts` | GET POST PUT DELETE | owner-scoped | ● | Cosmos |
| `governance/purview/status/route.ts` | GET | session-only | ● | Purview |
| `governance/scans/register-existing/route.ts` | POST | admin | ● | Purview |
| `governance/scans/route.ts` | GET POST DELETE | admin |  | Purview |
| `governance/sensitivity/route.ts` | GET | owner-scoped |  | Cosmos |
| `governance/workspace-egress/[id]/route.ts` | GET DELETE | admin |  | — |
| `governance/workspace-egress/route.ts` | GET POST | admin |  | — |

## governance-domains

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `governance-domains/route.ts` | GET | owner-scoped |  | Cosmos |

## health

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `health/deep/route.ts` | GET | public |  | Cosmos |
| `health/route.ts` | GET | public |  | — |

## help-copilot

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `help-copilot/chat/route.ts` | POST | owner-scoped |  | — |
| `help-copilot/reindex/route.ts` | GET POST | session-only | ● | — |
| `help-copilot/sessions/route.ts` | GET | owner-scoped |  | — |

## internal

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `internal/copilot/eval-probe/route.ts` | GET POST | public |  | — |
| `internal/copilot/memory/consolidate/route.ts` | GET POST | public |  | — |
| `internal/copilot/search-probe/route.ts` | POST | public | ● | — |
| `internal/copilot/skills/learn/route.ts` | GET POST | public |  | — |
| `internal/copilot/tools/[name]/invoke/route.ts` | POST | public |  | — |
| `internal/copilot/tools/route.ts` | GET | public |  | — |
| `internal/cost-anomaly/run/route.ts` | POST | public | ● | Cosmos |
| `internal/scheduler/tick/route.ts` | POST | public | ● | — |
| `internal/spark/keep-warm/route.ts` | GET POST | public | ● | — |
| `internal/topology/register-domain/route.ts` | POST | public |  | — |

## iq

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `iq/mcp/route.ts` | GET POST | owner-scoped |  | — |

## items

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `items/[type]/[id]/access-mode/route.ts` | PATCH | owner-scoped |  | Cosmos |
| `items/[type]/[id]/ai-function/route.ts` | GET POST | owner-scoped | ● | Databricks |
| `items/[type]/[id]/alerts/route.ts` | GET POST PATCH DELETE | session-only | ● | Azure Monitor, Databricks |
| `items/[type]/[id]/assist/route.ts` | POST | session-only | ● | Databricks, Synapse SQL |
| `items/[type]/[id]/audit/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/[type]/[id]/business-metadata/route.ts` | GET POST | owner-scoped | ● | Cosmos, Purview |
| `items/[type]/[id]/canvas-comments/[commentId]/route.ts` | PATCH DELETE | owner-scoped |  | — |
| `items/[type]/[id]/canvas-comments/route.ts` | GET POST | owner-scoped |  | — |
| `items/[type]/[id]/canvas-presence/route.ts` | GET POST DELETE | owner-scoped |  | — |
| `items/[type]/[id]/canvas-suggest/route.ts` | POST | owner-scoped | ● | — |
| `items/[type]/[id]/classifications/route.ts` | GET PUT | owner-scoped | ● | Cosmos, Purview |
| `items/[type]/[id]/comments/route.ts` | GET POST PATCH DELETE | owner-scoped |  | Cosmos |
| `items/[type]/[id]/endorsement/route.ts` | GET PATCH | admin |  | — |
| `items/[type]/[id]/explain/route.ts` | POST | session-only | ● | — |
| `items/[type]/[id]/export-check/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/[type]/[id]/impact/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/[type]/[id]/lineage/route.ts` | GET | owner-scoped | ● | Cosmos, Purview |
| `items/[type]/[id]/monitoring/route.ts` | GET | session-only | ● | Databricks, Synapse SQL, Synapse pool |
| `items/[type]/[id]/onelake-security/[role]/cls/route.ts` | GET POST | owner-scoped |  | — |
| `items/[type]/[id]/onelake-security/[role]/rls/route.ts` | GET POST | owner-scoped |  | — |
| `items/[type]/[id]/onelake-security/schema/route.ts` | GET | owner-scoped |  | ADLS |
| `items/[type]/[id]/optimize/route.ts` | POST | session-only | ● | ADLS, Databricks |
| `items/[type]/[id]/pbi-source/route.ts` | GET | owner-scoped |  | Cosmos, Synapse SQL |
| `items/[type]/[id]/pbids/route.ts` | GET | owner-scoped |  | ADX, Cosmos, Synapse SQL |
| `items/[type]/[id]/permissions/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `items/[type]/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos |
| `items/[type]/[id]/security-roles/preview-as/route.ts` | POST | admin |  | — |
| `items/[type]/[id]/security-roles/route.ts` | GET POST PUT DELETE | admin |  | — |
| `items/[type]/[id]/security/route.ts` | GET POST | session-only | ● | Databricks |
| `items/[type]/[id]/sensitivity-label/route.ts` | GET PUT PATCH DELETE | owner-scoped | ● | Cosmos, Purview |
| `items/[type]/[id]/sensitivity/route.ts` | GET PUT | owner-scoped | ● | Cosmos, Purview |
| `items/[type]/[id]/share/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `items/[type]/[id]/shortcuts/[name]/route.ts` | PATCH DELETE | owner-scoped |  | — |
| `items/[type]/[id]/shortcuts/[name]/test/route.ts` | POST | owner-scoped |  | — |
| `items/[type]/[id]/shortcuts/route.ts` | GET POST | owner-scoped |  | — |
| `items/[type]/[id]/sql-security/route.ts` | GET POST | session-only | ● | Synapse SQL |
| `items/[type]/[id]/statistics/route.ts` | GET POST | session-only | ● | Databricks, Synapse SQL |
| `items/[type]/[id]/versions/[versionId]/restore/route.ts` | POST | owner-scoped | ● | Cosmos |
| `items/[type]/[id]/versions/[versionId]/route.ts` | GET | owner-scoped | ● | — |
| `items/[type]/[id]/versions/route.ts` | GET | owner-scoped | ● | — |
| `items/[type]/[id]/visual-query/route.ts` | POST | owner-scoped |  | Databricks, Synapse SQL, Synapse pool |
| `items/activator/[id]/adx-source/route.ts` | GET | owner-scoped | ● | ADX |
| `items/activator/[id]/history/route.ts` | GET | owner-scoped | ● | Azure Monitor |
| `items/activator/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | — |
| `items/activator/[id]/rules/route.ts` | GET POST PUT PATCH DELETE | owner-scoped | ● | ADX, Azure Monitor, Cosmos |
| `items/activator/[id]/start/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/activator/[id]/stop/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/activator/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/adf-dataset/[id]/route.ts` | GET PUT DELETE | session-only |  | ADF |
| `items/adf-dataset/route.ts` | GET POST | session-only |  | ADF |
| `items/adf-pipeline/[id]/bind/route.ts` | GET POST | owner-scoped |  | ADF |
| `items/adf-pipeline/[id]/connections/route.ts` | GET | session-only | ● | ADF |
| `items/adf-pipeline/[id]/copilot/route.ts` | POST | owner-scoped |  | — |
| `items/adf-pipeline/[id]/debug/route.ts` | POST | owner-scoped |  | ADF |
| `items/adf-pipeline/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | ADF |
| `items/adf-pipeline/[id]/run/route.ts` | POST | owner-scoped |  | ADF |
| `items/adf-pipeline/[id]/runs/route.ts` | GET | owner-scoped |  | ADF |
| `items/adf-pipeline/[id]/triggers/route.ts` | GET POST | owner-scoped |  | ADF |
| `items/adf-pipeline/[id]/validate/route.ts` | POST | owner-scoped |  | ADF |
| `items/adf-pipeline/route.ts` | GET POST | session-only |  | ADF |
| `items/adf-trigger/[id]/route.ts` | GET PUT DELETE | session-only |  | ADF |
| `items/adf-trigger/[id]/state/route.ts` | POST | session-only |  | ADF |
| `items/adf-trigger/route.ts` | GET POST | session-only |  | ADF |
| `items/agent-flow/[id]/a2a/route.ts` | GET POST | owner-scoped |  | — |
| `items/agent-flow/[id]/mcp/route.ts` | GET POST | owner-scoped |  | — |
| `items/agent-flow/[id]/publish-mcp/route.ts` | POST DELETE | owner-scoped |  | Cosmos |
| `items/agent-flow/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/agent-flow/[id]/run/route.ts` | POST | owner-scoped |  | — |
| `items/agent-flow/[id]/runs/route.ts` | GET | owner-scoped |  | — |
| `items/ai-builder-model/[id]/predict/route.ts` | POST | session-only |  | — |
| `items/ai-builder-model/[id]/publish/route.ts` | POST | session-only |  | — |
| `items/ai-builder-model/[id]/route.ts` | GET | session-only |  | — |
| `items/ai-builder-model/[id]/train/route.ts` | POST | session-only |  | — |
| `items/ai-builder-model/route.ts` | GET | session-only |  | — |
| `items/ai-enrich/[service]/preview/route.ts` | POST | session-only |  | — |
| `items/ai-enrichment/[id]/preview/route.ts` | POST | owner-scoped | ● | Databricks |
| `items/ai-enrichment/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | — |
| `items/ai-enrichment/[id]/run/route.ts` | POST | owner-scoped | ● | Databricks |
| `items/ai-enrichment/[id]/runs/route.ts` | GET | owner-scoped |  | — |
| `items/ai-enrichment/[id]/schema/route.ts` | GET | owner-scoped | ● | Databricks |
| `items/ai-foundry-project/[id]/route.ts` | GET DELETE | session-only |  | — |
| `items/ai-foundry-project/route.ts` | GET POST | session-only |  | — |
| `items/ai-red-team/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/ai-red-team/[id]/run/route.ts` | POST | owner-scoped | ● | — |
| `items/ai-search-index/[id]/analyze/route.ts` | POST | owner-scoped |  | AI Search |
| `items/ai-search-index/[id]/bind/route.ts` | GET POST | owner-scoped |  | AI Search |
| `items/ai-search-index/[id]/indexers/route.ts` | GET POST | owner-scoped |  | AI Search |
| `items/ai-search-index/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | AI Search |
| `items/ai-search-index/[id]/search/route.ts` | POST | owner-scoped |  | AI Search |
| `items/ai-search-index/[id]/stats/route.ts` | GET | owner-scoped |  | AI Search |
| `items/ai-search-index/route.ts` | GET POST | session-only |  | AI Search |
| `items/aip-logic/[id]/bind-ontology/route.ts` | GET POST | owner-scoped |  | — |
| `items/aip-logic/[id]/deploy/route.ts` | POST | owner-scoped | ● | Cosmos |
| `items/aip-logic/[id]/eval/route.ts` | GET POST | owner-scoped |  | — |
| `items/aip-logic/[id]/invoke/route.ts` | POST | owner-scoped |  | — |
| `items/aip-logic/[id]/publish/route.ts` | POST | owner-scoped | ● | APIM |
| `items/aip-logic/[id]/route.ts` | — | public |  | — |
| `items/aip-logic/[id]/run-agent/route.ts` | POST | owner-scoped | ● | — |
| `items/aip-logic/[id]/versions/route.ts` | GET POST | owner-scoped |  | — |
| `items/aip-logic/route.ts` | — | public |  | — |
| `items/airflow-job/[id]/connection/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/airflow-job/[id]/dag-runs/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/airflow-job/[id]/dags/route.ts` | GET PATCH | owner-scoped |  | Cosmos |
| `items/airflow-job/[id]/route.ts` | GET DELETE | owner-scoped |  | Cosmos |
| `items/airflow-job/[id]/task-logs/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/airflow-job/route.ts` | GET POST | owner-scoped | ● | Cosmos |
| `items/analysis-board/[id]/run/route.ts` | POST | owner-scoped | ● | ADX |
| `items/apim-api/[id]/operations/route.ts` | GET POST PUT DELETE | session-only | ● | APIM |
| `items/apim-api/[id]/revisions/route.ts` | GET POST | session-only |  | APIM |
| `items/apim-api/[id]/route.ts` | GET PUT DELETE | session-only |  | APIM |
| `items/apim-api/[id]/spec/route.ts` | GET | session-only |  | APIM |
| `items/apim-api/[id]/test-call/route.ts` | POST | session-only |  | APIM |
| `items/apim-api/route.ts` | GET POST | session-only | ● | APIM |
| `items/apim-policy/[id]/route.ts` | GET PUT | session-only |  | APIM |
| `items/apim-policy/route.ts` | GET PUT | session-only | ● | APIM |
| `items/apim-product/[id]/apis/route.ts` | GET POST DELETE | session-only |  | APIM |
| `items/apim-product/[id]/route.ts` | GET PUT DELETE | session-only |  | APIM |
| `items/apim-product/[id]/subscriptions/route.ts` | GET | session-only |  | APIM |
| `items/apim-product/route.ts` | GET POST | session-only | ● | APIM |
| `items/automl/[id]/assist/route.ts` | — | public |  | — |
| `items/automl/jobs/[name]/route.ts` | GET DELETE | session-only | ● | — |
| `items/automl/jobs/route.ts` | GET | session-only | ● | — |
| `items/automl/options/route.ts` | GET | session-only | ● | AML |
| `items/automl/submit/route.ts` | POST | session-only | ● | — |
| `items/azure-sql-database/[id]/aad-admin/route.ts` | GET PUT | session-only |  | — |
| `items/azure-sql-database/[id]/connect/route.ts` | POST | owner-scoped |  | — |
| `items/azure-sql-database/[id]/copilot/route.ts` | POST | owner-scoped | ● | — |
| `items/azure-sql-database/[id]/create-db/route.ts` | POST | session-only |  | — |
| `items/azure-sql-database/[id]/firewall/route.ts` | GET POST DELETE | session-only |  | — |
| `items/azure-sql-database/[id]/get-data/route.ts` | POST | session-only | ● | ADF |
| `items/azure-sql-database/[id]/maintenance-configs/route.ts` | GET | session-only |  | — |
| `items/azure-sql-database/[id]/mirroring/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/azure-sql-database/[id]/performance/route.ts` | POST | session-only |  | — |
| `items/azure-sql-database/[id]/principal-search/route.ts` | GET | session-only |  | — |
| `items/azure-sql-database/[id]/queries/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `items/azure-sql-database/[id]/query/cancel/route.ts` | POST | session-only |  | — |
| `items/azure-sql-database/[id]/query/route.ts` | POST | session-only |  | — |
| `items/azure-sql-database/[id]/replication/route.ts` | POST | session-only |  | — |
| `items/azure-sql-database/[id]/restore/route.ts` | GET POST | session-only |  | — |
| `items/azure-sql-database/[id]/scale/route.ts` | POST | session-only |  | — |
| `items/azure-sql-database/[id]/search-management/route.ts` | GET POST | session-only |  | — |
| `items/azure-sql-database/[id]/share/route.ts` | GET POST DELETE | session-only |  | — |
| `items/azure-sql-database/[id]/sql2025-features/route.ts` | POST | session-only |  | — |
| `items/azure-sql-database/route.ts` | GET POST | owner-scoped |  | — |
| `items/azure-sql-managed-instance/route.ts` | GET POST | owner-scoped |  | — |
| `items/azure-sql-server/[id]/databases/route.ts` | GET | session-only |  | — |
| `items/azure-sql-server/route.ts` | GET POST | owner-scoped |  | — |
| `items/batch-pool/jobs/route.ts` | GET POST DELETE | owner-scoped | ● | Batch |
| `items/batch-pool/route.ts` | GET POST DELETE | owner-scoped | ● | Batch |
| `items/batch-pool/tasks/route.ts` | GET POST DELETE | owner-scoped | ● | Batch |
| `items/by-type/route.ts` | GET | admin |  | Cosmos |
| `items/compute/[id]/route.ts` | GET DELETE | session-only |  | — |
| `items/compute/[id]/start/route.ts` | POST | session-only |  | — |
| `items/compute/[id]/stop/route.ts` | POST | session-only |  | — |
| `items/compute/route.ts` | GET POST | session-only |  | — |
| `items/content-safety/blocklists/items/route.ts` | GET POST DELETE | session-only |  | — |
| `items/content-safety/blocklists/route.ts` | GET POST DELETE | session-only |  | — |
| `items/content-safety/rai-policies/route.ts` | GET POST DELETE | session-only |  | — |
| `items/content-safety/route.ts` | GET POST | session-only |  | — |
| `items/copilot-studio-action/[id]/route.ts` | PATCH DELETE | session-only |  | — |
| `items/copilot-studio-action/route.ts` | GET POST | session-only |  | — |
| `items/copilot-studio-agent/[id]/directline-token/route.ts` | POST | session-only |  | — |
| `items/copilot-studio-agent/[id]/publish/route.ts` | POST | session-only |  | — |
| `items/copilot-studio-agent/[id]/route.ts` | GET PATCH DELETE | session-only |  | — |
| `items/copilot-studio-agent/route.ts` | GET POST | session-only |  | — |
| `items/copilot-studio-analytics/[id]/route.ts` | GET | session-only |  | — |
| `items/copilot-studio-channel/[id]/publish/route.ts` | POST | session-only |  | — |
| `items/copilot-studio-channel/route.ts` | GET | session-only |  | — |
| `items/copilot-studio-knowledge/[id]/route.ts` | DELETE | session-only |  | — |
| `items/copilot-studio-knowledge/route.ts` | GET POST | session-only |  | — |
| `items/copilot-studio-topic/[id]/route.ts` | GET PATCH DELETE | session-only |  | — |
| `items/copilot-studio-topic/route.ts` | GET POST | session-only |  | — |
| `items/copilot-template-library/[id]/route.ts` | GET POST DELETE | session-only |  | — |
| `items/copilot-template-library/route.ts` | GET POST | session-only |  | — |
| `items/copy-job/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Synapse |
| `items/copy-job/[id]/run/route.ts` | POST | owner-scoped | ● | ADF |
| `items/copy-job/[id]/runs/route.ts` | GET | session-only |  | ADF |
| `items/copy-job/[id]/watermark/route.ts` | GET | owner-scoped |  | — |
| `items/copy-job/route.ts` | GET POST | owner-scoped |  | — |
| `items/cosmos-db/[id]/gremlin/route.ts` | POST | session-only | ● | Cosmos |
| `items/cosmos-db/[id]/keys/route.ts` | GET POST | public | ● | Cosmos |
| `items/cosmos-db/[id]/metrics/route.ts` | GET | session-only | ● | Azure Monitor, Cosmos |
| `items/cosmos-gremlin-graph/[id]/query/route.ts` | POST | session-only |  | — |
| `items/cosmos-gremlin-graph/route.ts` | GET POST | owner-scoped |  | — |
| `items/cypher-graph/[id]/assist/route.ts` | — | public |  | — |
| `items/cypher-graph/route.ts` | GET POST | owner-scoped |  | — |
| `items/dashboard/[id]/embed-token/route.ts` | POST | session-only |  | — |
| `items/dashboard/[id]/pin/route.ts` | POST | session-only | ● | — |
| `items/dashboard/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos |
| `items/dashboard/[id]/tile-embed-token/route.ts` | POST | session-only |  | — |
| `items/dashboard/[id]/tile-query/route.ts` | POST | session-only | ● | AAS, ADX |
| `items/dashboard/route.ts` | GET | session-only |  | — |
| `items/data-agent/[id]/a2a/route.ts` | GET POST | owner-scoped |  | — |
| `items/data-agent/[id]/chat/route.ts` | POST | owner-scoped |  | — |
| `items/data-agent/[id]/conversations/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `items/data-agent/[id]/copilot/route.ts` | POST | owner-scoped |  | — |
| `items/data-agent/[id]/deploy/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/data-agent/[id]/evaluate/route.ts` | POST | owner-scoped |  | — |
| `items/data-agent/[id]/m365-copilot/route.ts` | GET POST | owner-scoped | ● | Cosmos |
| `items/data-agent/[id]/mcp/route.ts` | GET POST | owner-scoped |  | — |
| `items/data-agent/[id]/publish-mcp/route.ts` | POST DELETE | owner-scoped |  | Cosmos |
| `items/data-agent/[id]/publish/route.ts` | POST | owner-scoped | ● | Cosmos |
| `items/data-agent/[id]/route.ts` | GET PATCH DELETE | owner-scoped | ● | — |
| `items/data-agent/[id]/source-schema/route.ts` | GET | owner-scoped |  | — |
| `items/data-agent/route.ts` | GET POST | owner-scoped |  | — |
| `items/data-contract/[id]/quality/route.ts` | GET POST | owner-scoped | ● | ADX |
| `items/data-contract/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/data-pipeline/[id]/approval-logicapp/route.ts` | GET | owner-scoped | ● | Cosmos |
| `items/data-pipeline/[id]/connections/route.ts` | GET | session-only | ● | ADF |
| `items/data-pipeline/[id]/copilot/route.ts` | POST | owner-scoped |  | — |
| `items/data-pipeline/[id]/debug/route.ts` | POST | owner-scoped |  | ADF, Cosmos |
| `items/data-pipeline/[id]/evaluate/route.ts` | POST | owner-scoped | ● | ADF, Cosmos |
| `items/data-pipeline/[id]/export/route.ts` | GET | owner-scoped | ● | ADF, Cosmos |
| `items/data-pipeline/[id]/integration-runtimes/route.ts` | GET POST DELETE | owner-scoped | ● | ADF, Cosmos |
| `items/data-pipeline/[id]/jobs/route.ts` | GET | owner-scoped |  | ADF, Cosmos |
| `items/data-pipeline/[id]/output/route.ts` | GET | owner-scoped |  | ADF, Cosmos |
| `items/data-pipeline/[id]/publish/route.ts` | POST | owner-scoped | ● | ADF, Cosmos |
| `items/data-pipeline/[id]/route.ts` | GET PUT DELETE | owner-scoped | ● | ADF, Cosmos |
| `items/data-pipeline/[id]/run/route.ts` | POST | owner-scoped | ● | ADF, Cosmos |
| `items/data-pipeline/[id]/triggers/route.ts` | GET POST PUT DELETE | owner-scoped |  | ADF, Cosmos |
| `items/data-pipeline/[id]/validate/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/data-pipeline/import/route.ts` | POST | owner-scoped | ● | ADF, Cosmos |
| `items/data-pipeline/practice-seed/route.ts` | POST | owner-scoped | ● | ADF, ADLS, Cosmos |
| `items/data-pipeline/route.ts` | GET POST | owner-scoped |  | ADF, Cosmos |
| `items/data-product-instance/[id]/provision/route.ts` | POST | owner-scoped |  | — |
| `items/data-product-instance/[id]/route.ts` | GET | owner-scoped |  | — |
| `items/data-product-instance/route.ts` | GET POST | owner-scoped |  | — |
| `items/data-product-template/[id]/instantiate/route.ts` | POST | owner-scoped |  | — |
| `items/data-product-template/[id]/route.ts` | GET | session-only |  | — |
| `items/data-product-template/route.ts` | GET POST | owner-scoped |  | — |
| `items/data-product/[id]/publish-api/route.ts` | POST | owner-scoped | ● | APIM |
| `items/data-product/[id]/register-purview/route.ts` | POST | owner-scoped | ● | Purview |
| `items/data-quality/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/data-quality/[id]/run/route.ts` | GET POST | owner-scoped | ● | — |
| `items/data-science/home/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/databricks-cluster/[id]/events/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-cluster/[id]/libraries/route.ts` | GET POST DELETE | session-only |  | Databricks |
| `items/databricks-cluster/[id]/route.ts` | GET PATCH DELETE | session-only |  | Databricks |
| `items/databricks-cluster/[id]/state/route.ts` | POST | session-only |  | Databricks |
| `items/databricks-cluster/hygiene/route.ts` | GET POST | admin | ● | Databricks |
| `items/databricks-cluster/options/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-cluster/route.ts` | GET POST | session-only |  | Databricks |
| `items/databricks-job/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Databricks |
| `items/databricks-job/[id]/run-output/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-job/[id]/run/route.ts` | POST | session-only |  | Databricks |
| `items/databricks-job/[id]/runs/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-job/route.ts` | GET POST | session-only |  | Databricks |
| `items/databricks-notebook/[id]/command/route.ts` | POST | session-only |  | Databricks |
| `items/databricks-notebook/[id]/context/route.ts` | POST DELETE | session-only |  | Databricks |
| `items/databricks-notebook/[id]/ensure-cluster/route.ts` | POST | owner-scoped | ● | Databricks |
| `items/databricks-notebook/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos, Databricks |
| `items/databricks-notebook/[id]/run/route.ts` | POST | session-only |  | Databricks |
| `items/databricks-notebook/[id]/runs/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-notebook/[id]/schedule/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | Databricks |
| `items/databricks-notebook/[id]/versions/route.ts` | GET POST | owner-scoped | ● | Cosmos |
| `items/databricks-notebook/list/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-pipeline/[id]/events/route.ts` | GET | session-only | ● | Databricks |
| `items/databricks-pipeline/[id]/pipelines/route.ts` | GET | session-only | ● | Databricks |
| `items/databricks-pipeline/[id]/spec/route.ts` | GET POST | session-only | ● | Databricks |
| `items/databricks-pipeline/[id]/start/route.ts` | POST | session-only | ● | Databricks |
| `items/databricks-pipeline/[id]/stop/route.ts` | POST | session-only | ● | Databricks |
| `items/databricks-pipeline/[id]/updates/route.ts` | GET | session-only | ● | Databricks |
| `items/databricks-sql-warehouse/[id]/cancel/route.ts` | POST | session-only | ● | Databricks |
| `items/databricks-sql-warehouse/[id]/clone/route.ts` | POST | session-only | ● | Databricks |
| `items/databricks-sql-warehouse/[id]/connection/route.ts` | GET | session-only |  | — |
| `items/databricks-sql-warehouse/[id]/create/route.ts` | POST | session-only | ● | Databricks, Synapse |
| `items/databricks-sql-warehouse/[id]/ctas/route.ts` | POST | session-only | ● | Databricks |
| `items/databricks-sql-warehouse/[id]/delete/route.ts` | POST | session-only | ● | Databricks, Synapse |
| `items/databricks-sql-warehouse/[id]/edit/route.ts` | POST | session-only |  | Databricks |
| `items/databricks-sql-warehouse/[id]/iqy/route.ts` | POST | session-only |  | — |
| `items/databricks-sql-warehouse/[id]/model/route.ts` | GET POST DELETE | owner-scoped |  | Databricks |
| `items/databricks-sql-warehouse/[id]/query-history/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-sql-warehouse/[id]/query-profile/route.ts` | GET | session-only | ● | Databricks |
| `items/databricks-sql-warehouse/[id]/query/route.ts` | POST | session-only |  | Databricks |
| `items/databricks-sql-warehouse/[id]/schema/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-sql-warehouse/[id]/script-out/route.ts` | GET | session-only |  | Databricks |
| `items/databricks-sql-warehouse/[id]/start/route.ts` | POST | session-only |  | Databricks |
| `items/databricks-sql-warehouse/[id]/state/route.ts` | GET POST | session-only |  | Databricks |
| `items/databricks-sql-warehouse/[id]/warehouses/route.ts` | GET | session-only |  | Databricks, Synapse |
| `items/dataflow/[id]/refresh/route.ts` | POST | session-only |  | — |
| `items/dataflow/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos |
| `items/dataflow/config/route.ts` | GET | session-only | ● | ADF |
| `items/dataflow/copilot/route.ts` | POST | owner-scoped | ● | — |
| `items/dataflow/profile/route.ts` | POST | session-only | ● | Synapse SQL |
| `items/dataflow/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/datamart/migrate/route.ts` | POST | owner-scoped | ● | AAS, Synapse SQL |
| `items/dataset/[id]/lineage/route.ts` | GET | session-only |  | — |
| `items/dataset/[id]/preview/route.ts` | GET | session-only | ● | ADLS, Synapse SQL |
| `items/dataset/[id]/route.ts` | GET | session-only |  | — |
| `items/dataset/browse/route.ts` | GET | session-only |  | ADLS |
| `items/dataset/route.ts` | GET POST | session-only |  | — |
| `items/dataverse-table/[id]/business-rules/route.ts` | GET | session-only |  | — |
| `items/dataverse-table/[id]/columns/route.ts` | POST | session-only | ● | — |
| `items/dataverse-table/[id]/keys/route.ts` | GET | session-only |  | — |
| `items/dataverse-table/[id]/relationships/route.ts` | GET | session-only |  | — |
| `items/dataverse-table/[id]/route.ts` | GET | session-only |  | — |
| `items/dataverse-table/[id]/rows/route.ts` | GET | session-only |  | — |
| `items/dataverse-table/[id]/views/route.ts` | GET | session-only |  | — |
| `items/dataverse-table/route.ts` | GET | session-only |  | — |
| `items/dbt-job/[id]/generate/route.ts` | GET | owner-scoped |  | — |
| `items/dbt-job/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Databricks |
| `items/dbt-job/[id]/run/route.ts` | POST | owner-scoped | ● | Databricks |
| `items/dbt-job/[id]/runs/route.ts` | GET | owner-scoped |  | Databricks |
| `items/dbt-job/route.ts` | GET POST | owner-scoped |  | — |
| `items/digital-twin/[id]/event-route/route.ts` | GET | owner-scoped |  | — |
| `items/digital-twin/[id]/materialize/route.ts` | POST | owner-scoped | ● | ADX |
| `items/digital-twin/[id]/query/route.ts` | POST | owner-scoped | ● | ADX |
| `items/digital-twin/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/digital-twin/[id]/source-schema/route.ts` | GET | owner-scoped | ● | ADX |
| `items/digital-twin/[id]/time-series/route.ts` | POST | owner-scoped | ● | ADX |
| `items/environment/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | — |
| `items/environment/route.ts` | GET POST | owner-scoped |  | — |
| `items/evaluation/[id]/route.ts` | GET | owner-scoped |  | — |
| `items/evaluation/route.ts` | GET POST | session-only |  | — |
| `items/event-grid-topic/route.ts` | GET POST DELETE | session-only | ● | — |
| `items/event-hubs-namespace/route.ts` | GET POST DELETE | session-only | ● | Event Hubs |
| `items/event-schema-set/[id]/check-compat/route.ts` | POST | owner-scoped | ● | Cosmos, Event Hubs |
| `items/event-schema-set/[id]/route.ts` | GET PATCH DELETE | owner-scoped | ● | Cosmos, Event Hubs |
| `items/event-schema-set/[id]/versions/route.ts` | POST | owner-scoped | ● | Cosmos, Event Hubs |
| `items/event-schema-set/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/eventhouse/[id]/capacity/route.ts` | GET POST | session-only | ● | ADX, Azure Monitor |
| `items/eventhouse/[id]/continuous-export/route.ts` | GET POST | session-only |  | ADLS, ADX |
| `items/eventhouse/[id]/database/route.ts` | POST DELETE | session-only |  | ADX, ADX ARM |
| `items/eventhouse/[id]/ingest/preview/route.ts` | POST | session-only |  | — |
| `items/eventhouse/[id]/ingest/route.ts` | POST | session-only |  | ADX |
| `items/eventhouse/[id]/journal/route.ts` | GET | session-only |  | ADX |
| `items/eventhouse/[id]/overview/route.ts` | GET | session-only |  | ADX, ADX ARM, Azure Monitor |
| `items/eventhouse/[id]/policies/route.ts` | POST PATCH | session-only |  | ADX, ADX ARM |
| `items/eventhouse/[id]/purge/route.ts` | GET POST | session-only |  | ADX |
| `items/eventhouse/[id]/route.ts` | GET | session-only |  | ADX, ADX ARM |
| `items/eventstream/[id]/activator/route.ts` | GET POST | owner-scoped | ● | Azure Monitor, Cosmos |
| `items/eventstream/[id]/asa-sync/route.ts` | POST | owner-scoped |  | ADX, Stream Analytics |
| `items/eventstream/[id]/assist/route.ts` | — | public |  | — |
| `items/eventstream/[id]/business-events/route.ts` | GET POST | owner-scoped | ● | ADX, Event Hubs |
| `items/eventstream/[id]/definition/route.ts` | GET | owner-scoped |  | ADX |
| `items/eventstream/[id]/events/route.ts` | GET POST | owner-scoped |  | ADX |
| `items/eventstream/[id]/geo-reference/route.ts` | GET POST | owner-scoped | ● | ADLS, ADX, Stream Analytics |
| `items/eventstream/[id]/mirror-cdf/route.ts` | GET POST | owner-scoped | ● | ADX, Cosmos |
| `items/eventstream/[id]/provision/route.ts` | POST | owner-scoped | ● | ADX, Event Hubs |
| `items/eventstream/[id]/publish/route.ts` | POST | owner-scoped |  | ADX |
| `items/eventstream/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | ADX, Cosmos |
| `items/eventstream/[id]/source/route.ts` | POST | owner-scoped | ● | ADF, ADX, Event Hubs |
| `items/eventstream/[id]/sql-operator/route.ts` | GET POST | owner-scoped |  | ADX, Stream Analytics |
| `items/eventstream/spark-binding/route.ts` | GET PUT | admin |  | — |
| `items/feature-table/[id]/online/route.ts` | GET POST | owner-scoped |  | — |
| `items/feature-table/[id]/pit-join/route.ts` | POST | owner-scoped |  | — |
| `items/feature-table/[id]/route.ts` | GET POST DELETE | owner-scoped | ● | — |
| `items/feature-table/[id]/serve/route.ts` | POST | owner-scoped |  | — |
| `items/fine-tuning-job/[id]/deploy/route.ts` | POST | owner-scoped | ● | — |
| `items/fine-tuning-job/[id]/events/route.ts` | GET | owner-scoped |  | — |
| `items/fine-tuning-job/[id]/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | — |
| `items/fine-tuning-job/[id]/safety-eval/route.ts` | POST | owner-scoped | ● | — |
| `items/geo-dataset/route.ts` | GET POST | owner-scoped |  | — |
| `items/geo-map/route.ts` | GET POST | owner-scoped |  | — |
| `items/geo-pipeline/[id]/run/route.ts` | POST | owner-scoped | ● | ADF |
| `items/geo-pipeline/route.ts` | GET POST | owner-scoped |  | — |
| `items/geo-query/route.ts` | GET POST | owner-scoped |  | — |
| `items/gql-graph/[id]/assist/route.ts` | — | public |  | — |
| `items/gql-graph/[id]/query/route.ts` | POST | session-only | ● | ADX |
| `items/gql-graph/route.ts` | GET POST | owner-scoped |  | — |
| `items/graph-model/[id]/materialize/route.ts` | POST | session-only | ● | ADX |
| `items/graph-model/[id]/query/route.ts` | POST | session-only | ● | ADX |
| `items/graph-model/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/graph-model/[id]/source-schema/route.ts` | GET | session-only | ● | ADX |
| `items/graph-model/route.ts` | GET POST | owner-scoped |  | — |
| `items/graphql-api/[id]/publish/route.ts` | POST | session-only |  | APIM |
| `items/graphql-api/[id]/query/route.ts` | POST | session-only | ● | APIM |
| `items/graphql-api/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/health-check/[id]/action-group/route.ts` | GET POST PUT | owner-scoped | ● | Azure Monitor |
| `items/health-check/[id]/history/route.ts` | GET | owner-scoped | ● | Azure Monitor |
| `items/health-check/[id]/route.ts` | — | public |  | — |
| `items/health-check/[id]/rule/[ruleId]/route.ts` | PATCH DELETE | owner-scoped | ● | Azure Monitor |
| `items/health-check/[id]/rule/[ruleId]/run/route.ts` | POST | owner-scoped | ● | Azure Monitor |
| `items/health-check/[id]/rule/preview/route.ts` | POST | owner-scoped |  | Azure Monitor |
| `items/health-check/[id]/rule/route.ts` | GET POST | owner-scoped | ● | Azure Monitor |
| `items/health-check/route.ts` | — | public |  | — |
| `items/integration-runtime/route.ts` | — | public |  | — |
| `items/kql-dashboard/[id]/activator/route.ts` | GET POST | owner-scoped | ● | ADX, Azure Monitor, Cosmos |
| `items/kql-dashboard/[id]/generate-tile/route.ts` | POST | owner-scoped | ● | ADX |
| `items/kql-dashboard/[id]/param-values/route.ts` | POST | owner-scoped |  | ADX |
| `items/kql-dashboard/[id]/route.ts` | GET PUT | owner-scoped |  | ADX |
| `items/kql-dashboard/[id]/run/route.ts` | POST | owner-scoped |  | ADX |
| `items/kql-database/[id]/assist/route.ts` | POST | owner-scoped | ● | ADX |
| `items/kql-database/[id]/data-connections/route.ts` | GET POST DELETE | owner-scoped | ● | ADX, ADX ARM, Event Hubs |
| `items/kql-database/[id]/follower/route.ts` | GET POST DELETE | owner-scoped |  | ADX, ADX ARM |
| `items/kql-database/[id]/query/route.ts` | POST | owner-scoped |  | ADX |
| `items/kql-database/[id]/route.ts` | GET | owner-scoped |  | ADX |
| `items/kql-database/[id]/schema-graph/route.ts` | GET | owner-scoped |  | ADX |
| `items/kql-database/[id]/tables/route.ts` | GET | owner-scoped |  | ADX |
| `items/kql-queryset/[id]/assist/route.ts` | POST | owner-scoped | ● | ADX |
| `items/kql-queryset/[id]/route.ts` | GET POST PUT | owner-scoped | ● | ADX |
| `items/kql-queryset/[id]/run/route.ts` | POST | owner-scoped | ● | ADX |
| `items/lakebase-postgres/[id]/branches/route.ts` | GET POST | owner-scoped |  | — |
| `items/lakebase-postgres/[id]/pgvector/route.ts` | GET POST | public | ● | — |
| `items/lakebase-postgres/[id]/provision/route.ts` | GET POST | public |  | — |
| `items/lakebase-postgres/[id]/query/route.ts` | POST | public | ● | — |
| `items/lakebase-postgres/[id]/replicas/route.ts` | GET POST | public |  | — |
| `items/lakebase-postgres/[id]/route.ts` | GET PATCH | public |  | — |
| `items/lakebase-postgres/[id]/snapshot/route.ts` | GET POST | owner-scoped |  | — |
| `items/lakehouse-shortcut/route.ts` | GET POST DELETE | owner-scoped | ● | ADLS, Cosmos, Synapse SQL |
| `items/lakehouse/[id]/abfss/route.ts` | GET | session-only |  | — |
| `items/lakehouse/[id]/assist/route.ts` | — | public |  | — |
| `items/lakehouse/[id]/query/route.ts` | POST | session-only | ● | Synapse SQL |
| `items/lakehouse/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/linked-service/route.ts` | — | public |  | — |
| `items/logic-app/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos |
| `items/logic-app/[id]/run/route.ts` | POST | owner-scoped | ● | Cosmos |
| `items/loom-app-runtime/[id]/assist/route.ts` | — | public |  | — |
| `items/loom-app-runtime/[id]/build/route.ts` | GET POST | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/context/route.ts` | GET | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/deploy/route.ts` | POST | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/export/route.ts` | GET | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/git-credential/route.ts` | GET POST DELETE | owner-scoped | ● | — |
| `items/loom-app-runtime/[id]/lifecycle/route.ts` | POST | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/logs/route.ts` | GET | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/mcp/route.ts` | POST | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/monitoring/route.ts` | GET | owner-scoped | ● | — |
| `items/loom-app-runtime/[id]/publish-api/route.ts` | POST | owner-scoped | ● | APIM |
| `items/loom-app-runtime/[id]/publish-mcp/route.ts` | POST DELETE | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/reconcile/route.ts` | GET POST | owner-scoped |  | — |
| `items/loom-app-runtime/[id]/resources/route.ts` | GET POST DELETE | owner-scoped | ● | — |
| `items/loom-app-runtime/[id]/route.ts` | GET DELETE | owner-scoped |  | — |
| `items/loom-app-runtime/config/route.ts` | GET | session-only |  | — |
| `items/loom-app-runtime/import/route.ts` | POST | owner-scoped |  | — |
| `items/loom-app/[id]/candidates/route.ts` | GET | owner-scoped |  | — |
| `items/loom-app/[id]/publish/route.ts` | POST | owner-scoped |  | — |
| `items/loom-app/[id]/render/route.ts` | GET | owner-scoped |  | — |
| `items/loom-app/[id]/route.ts` | — | public |  | — |
| `items/map/[id]/geocode/route.ts` | POST | owner-scoped | ● | Azure Maps |
| `items/map/[id]/map-token/route.ts` | GET | owner-scoped |  | Azure Maps |
| `items/map/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/mapping-dataflow/[id]/debug/preview/route.ts` | POST | session-only | ● | ADF |
| `items/mapping-dataflow/[id]/debug/schema/route.ts` | POST | public | ● | ADF |
| `items/mapping-dataflow/[id]/debug/session/route.ts` | POST | session-only | ● | ADF |
| `items/mapping-dataflow/[id]/debug/stats/route.ts` | POST | public | ● | ADF |
| `items/materialized-lake-view/[id]/adf-pipeline/route.ts` | GET POST | owner-scoped | ● | ADF |
| `items/materialized-lake-view/[id]/assist/route.ts` | — | public |  | — |
| `items/materialized-lake-view/[id]/lineage/route.ts` | GET POST | owner-scoped |  | — |
| `items/materialized-lake-view/[id]/preview/route.ts` | POST | owner-scoped | ● | Synapse SQL |
| `items/materialized-lake-view/[id]/refresh/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/materialized-lake-view/[id]/runs/route.ts` | GET | owner-scoped | ● | Synapse |
| `items/mirrored-database/[id]/assist/route.ts` | — | public |  | — |
| `items/mirrored-database/[id]/lifecycle/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/mirrored-database/[id]/monitor/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/mirrored-database/[id]/open-mirror/route.ts` | GET POST | owner-scoped | ● | Cosmos, Synapse |
| `items/mirrored-database/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos |
| `items/mirrored-database/[id]/sources/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/mirrored-database/[id]/sql-endpoint/route.ts` | GET | owner-scoped |  | Cosmos, Synapse SQL |
| `items/mirrored-database/[id]/state/route.ts` | POST | owner-scoped |  | Cosmos |
| `items/mirrored-database/[id]/tables/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/mirrored-database/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/mirrored-database/source-tables/route.ts` | POST | session-only |  | Cosmos |
| `items/mirrored-database/verify/route.ts` | POST | session-only | ● | — |
| `items/mirrored-databricks/[id]/catalog/route.ts` | GET | owner-scoped | ● | Cosmos, Databricks |
| `items/mirrored-databricks/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | Cosmos |
| `items/mirrored-databricks/[id]/sql-endpoint/route.ts` | GET | owner-scoped | ● | Cosmos, Synapse SQL |
| `items/mirrored-databricks/catalogs/route.ts` | GET | session-only | ● | Databricks |
| `items/mirrored-databricks/route.ts` | GET POST | owner-scoped | ● | Cosmos |
| `items/ml-experiment/[id]/assist/route.ts` | — | public |  | — |
| `items/ml-experiment/[id]/register/route.ts` | POST | session-only |  | — |
| `items/ml-experiment/[id]/route.ts` | GET | session-only |  | — |
| `items/ml-experiment/[id]/runs/[runId]/metrics/route.ts` | GET | session-only |  | — |
| `items/ml-experiment/[id]/runs/route.ts` | GET | session-only |  | — |
| `items/ml-experiment/route.ts` | GET | session-only |  | — |
| `items/ml-experiment/submit/route.ts` | POST | session-only |  | — |
| `items/ml-model/[id]/bind/route.ts` | GET POST | owner-scoped |  | — |
| `items/ml-model/[id]/endpoint/route.ts` | GET POST PATCH DELETE | owner-scoped |  | — |
| `items/ml-model/[id]/predict/history/route.ts` | GET | owner-scoped |  | — |
| `items/ml-model/[id]/predict/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/ml-model/[id]/predict/status/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/ml-model/[id]/register/route.ts` | POST | owner-scoped |  | — |
| `items/ml-model/[id]/route.ts` | GET | owner-scoped |  | — |
| `items/ml-model/[id]/stage/route.ts` | GET POST | owner-scoped |  | — |
| `items/ml-model/route.ts` | GET | session-only |  | — |
| `items/model-serving-endpoint/[id]/invoke/route.ts` | POST | owner-scoped |  | — |
| `items/model-serving-endpoint/[id]/metrics/route.ts` | GET | owner-scoped |  | — |
| `items/model-serving-endpoint/[id]/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | — |
| `items/model-serving-endpoint/[id]/traffic/route.ts` | POST | owner-scoped |  | — |
| `items/mounted-adf/[id]/route.ts` | GET DELETE | owner-scoped |  | ADF, Cosmos |
| `items/mounted-adf/[id]/run/route.ts` | POST | owner-scoped |  | ADF, Cosmos |
| `items/mounted-adf/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/notebook/[id]/execute-spark/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/notebook/[id]/jobs/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/notebook/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos |
| `items/notebook/[id]/run/route.ts` | POST | owner-scoped | ● | Cosmos |
| `items/notebook/[id]/runs/[runId]/log/route.ts` | GET | owner-scoped |  | — |
| `items/notebook/[id]/runs/[runId]/route.ts` | GET DELETE | owner-scoped |  | Cosmos |
| `items/notebook/import/route.ts` | POST | owner-scoped |  | — |
| `items/notebook/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/notepad/[id]/run-block/route.ts` | POST | owner-scoped | ● | ADX |
| `items/ontology-sdk/[id]/bind-ontology/route.ts` | GET POST | owner-scoped |  | — |
| `items/ontology-sdk/[id]/generate/route.ts` | POST | owner-scoped |  | — |
| `items/ontology-sdk/[id]/publish/route.ts` | POST | owner-scoped | ● | APIM |
| `items/ontology-sdk/[id]/query/route.ts` | POST | owner-scoped | ● | — |
| `items/ontology-sdk/[id]/route.ts` | — | public |  | — |
| `items/ontology-sdk/route.ts` | — | public |  | — |
| `items/ontology/[id]/activator/route.ts` | GET POST | owner-scoped | ● | Azure Monitor, Cosmos |
| `items/ontology/[id]/approvals/route.ts` | GET POST | owner-scoped |  | — |
| `items/ontology/[id]/audit-export/route.ts` | GET POST | owner-scoped |  | — |
| `items/ontology/[id]/bind/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `items/ontology/[id]/datasource/route.ts` | GET | owner-scoped | ● | Synapse SQL, Synapse pool |
| `items/ontology/[id]/explore/route.ts` | GET POST DELETE | owner-scoped | ● | — |
| `items/ontology/[id]/justifications/route.ts` | GET | owner-scoped |  | — |
| `items/ontology/[id]/links/route.ts` | GET POST DELETE | owner-scoped | ● | — |
| `items/ontology/[id]/objects/[vertexId]/view/route.ts` | GET | admin | ● | — |
| `items/ontology/[id]/objects/route.ts` | GET POST | admin | ● | — |
| `items/ontology/[id]/resolve/route.ts` | GET | admin |  | — |
| `items/ontology/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/ontology/[id]/run-action/route.ts` | GET POST | admin | ● | — |
| `items/ontology/[id]/sync/route.ts` | GET POST DELETE | owner-scoped | ● | — |
| `items/operations-agent/[id]/deploy/route.ts` | POST | owner-scoped | ● | Azure Monitor, Cosmos |
| `items/operations-agent/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/operations-agent/[id]/rules/route.ts` | GET POST DELETE | owner-scoped | ● | ADX, Azure Monitor, Cosmos |
| `items/operations-agent/[id]/run/route.ts` | POST | owner-scoped |  | ADX |
| `items/paginated-report/[id]/definition/route.ts` | GET PUT | owner-scoped |  | ADX |
| `items/paginated-report/[id]/export/route.ts` | POST | session-only |  | — |
| `items/paginated-report/[id]/preview/route.ts` | POST | session-only |  | Synapse SQL |
| `items/paginated-report/[id]/rdl/route.ts` | GET PUT | owner-scoped |  | — |
| `items/paginated-report/[id]/render/route.ts` | POST | owner-scoped |  | AAS, ADX |
| `items/paginated-report/[id]/route.ts` | GET | session-only |  | — |
| `items/paginated-report/capabilities/route.ts` | GET | session-only |  | — |
| `items/paginated-report/route.ts` | GET | session-only |  | — |
| `items/plan/[id]/approval-callback/route.ts` | POST | public | ● | AAS, Cosmos |
| `items/plan/[id]/approval/route.ts` | GET POST | owner-scoped | ● | — |
| `items/plan/[id]/binding/route.ts` | GET POST | owner-scoped | ● | — |
| `items/plan/[id]/copilot/route.ts` | POST | owner-scoped |  | — |
| `items/plan/[id]/model/route.ts` | GET POST | owner-scoped |  | — |
| `items/plan/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/plan/[id]/writeback/route.ts` | GET POST | owner-scoped | ● | — |
| `items/postgres-flexible-server/[id]/databases/route.ts` | GET | session-only |  | — |
| `items/postgres-flexible-server/[id]/firewall/route.ts` | GET POST DELETE | session-only |  | — |
| `items/postgres-flexible-server/[id]/query/route.ts` | POST | session-only |  | — |
| `items/postgres-flexible-server/route.ts` | GET POST | session-only |  | — |
| `items/power-app/[id]/publish/route.ts` | POST | owner-scoped |  | — |
| `items/power-app/[id]/route.ts` | GET | owner-scoped |  | — |
| `items/power-app/[id]/state/route.ts` | GET POST | owner-scoped |  | — |
| `items/power-app/route.ts` | GET | session-only |  | — |
| `items/power-automate-flow/[id]/definition/route.ts` | GET POST PATCH | session-only | ● | — |
| `items/power-automate-flow/[id]/route.ts` | GET | session-only |  | — |
| `items/power-automate-flow/[id]/run/route.ts` | POST | session-only |  | — |
| `items/power-automate-flow/[id]/runs/route.ts` | GET | session-only |  | — |
| `items/power-automate-flow/route.ts` | GET | session-only |  | — |
| `items/power-page/[id]/route.ts` | GET | session-only |  | — |
| `items/power-page/route.ts` | GET | session-only |  | — |
| `items/prompt-flow/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | — |
| `items/prompt-flow/[id]/run/route.ts` | POST | session-only |  | — |
| `items/prompt-flow/route.ts` | GET POST | session-only |  | — |
| `items/rayfin-app/[id]/render/route.ts` | POST | owner-scoped | ● | AAS |
| `items/rayfin-app/[id]/route.ts` | GET PUT PATCH DELETE | owner-scoped |  | — |
| `items/rayfin-app/model-objects/route.ts` | GET | session-only | ● | AAS |
| `items/rayfin-app/models/route.ts` | GET | session-only | ● | AAS |
| `items/rayfin-app/preview/route.ts` | POST | session-only | ● | AAS |
| `items/recent/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/release-environment/[id]/approve/route.ts` | GET POST | owner-scoped |  | — |
| `items/release-environment/[id]/arm/route.ts` | GET | session-only |  | — |
| `items/release-environment/[id]/promote/route.ts` | GET POST | owner-scoped |  | — |
| `items/release-environment/[id]/route.ts` | — | public |  | — |
| `items/release-environment/[id]/swap/route.ts` | GET POST | owner-scoped | ● | — |
| `items/release-environment/route.ts` | — | public |  | — |
| `items/report/[id]/ai-visual/route.ts` | POST | owner-scoped |  | — |
| `items/report/[id]/connector-objects/route.ts` | POST | owner-scoped |  | — |
| `items/report/[id]/connector-preview/route.ts` | POST | owner-scoped |  | — |
| `items/report/[id]/data-source/route.ts` | GET PUT | owner-scoped |  | — |
| `items/report/[id]/definition/route.ts` | PUT | owner-scoped |  | — |
| `items/report/[id]/embed-token/route.ts` | POST | session-only |  | — |
| `items/report/[id]/endorsement/route.ts` | GET PUT PATCH | owner-scoped |  | — |
| `items/report/[id]/export/route.ts` | POST | session-only |  | — |
| `items/report/[id]/fields/route.ts` | GET | owner-scoped |  | AAS, Synapse SQL |
| `items/report/[id]/map-token/route.ts` | GET | owner-scoped |  | Azure Maps |
| `items/report/[id]/native-query/route.ts` | GET | owner-scoped |  | AAS |
| `items/report/[id]/pages/route.ts` | GET | owner-scoped |  | — |
| `items/report/[id]/paginated-embed-token/route.ts` | POST | session-only | ● | — |
| `items/report/[id]/powerbi-copilot/route.ts` | POST | owner-scoped | ● | — |
| `items/report/[id]/profile/route.ts` | GET POST | owner-scoped |  | AAS, Synapse SQL |
| `items/report/[id]/publish/route.ts` | POST DELETE | owner-scoped | ● | — |
| `items/report/[id]/query/route.ts` | POST | owner-scoped |  | AAS |
| `items/report/[id]/refresh/route.ts` | GET POST | owner-scoped | ● | — |
| `items/report/[id]/route.ts` | GET | owner-scoped |  | — |
| `items/report/[id]/script-visual/route.ts` | POST | owner-scoped |  | AAS, Synapse SQL |
| `items/report/[id]/sensitivity/route.ts` | GET PUT | owner-scoped |  | — |
| `items/report/[id]/subscriptions/[subId]/logs/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/report/[id]/subscriptions/[subId]/route.ts` | PATCH DELETE | owner-scoped |  | Cosmos |
| `items/report/[id]/subscriptions/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/report/[id]/visual-data/route.ts` | POST | owner-scoped |  | AAS, Synapse SQL |
| `items/report/[id]/visual/route.ts` | POST | owner-scoped |  | — |
| `items/report/copilot/route.ts` | POST | owner-scoped |  | — |
| `items/report/route.ts` | GET | owner-scoped |  | — |
| `items/route.ts` | GET | owner-scoped |  | — |
| `items/scorecard/[id]/config/route.ts` | GET PATCH | owner-scoped |  | — |
| `items/scorecard/[id]/goals/route.ts` | GET POST DELETE | owner-scoped |  | — |
| `items/scorecard/[id]/metric-value/route.ts` | GET | owner-scoped |  | AAS, Cosmos, Synapse SQL |
| `items/scorecard/[id]/route.ts` | GET POST PUT | owner-scoped |  | Cosmos |
| `items/scorecard/route.ts` | GET | owner-scoped |  | — |
| `items/semantic-model/[id]/content/route.ts` | GET PUT | owner-scoped |  | — |
| `items/semantic-model/[id]/copilot-structure/route.ts` | GET POST | owner-scoped |  | AAS |
| `items/semantic-model/[id]/datasource/route.ts` | GET POST PUT | owner-scoped | ● | AAS, ADX, Cosmos, Synapse SQL |
| `items/semantic-model/[id]/dax-query/route.ts` | POST | owner-scoped |  | — |
| `items/semantic-model/[id]/describe-bulk/route.ts` | GET POST | owner-scoped |  | AAS |
| `items/semantic-model/[id]/direct-lake/route.ts` | GET POST PUT | session-only | ● | AAS, Synapse SQL |
| `items/semantic-model/[id]/embed-token/route.ts` | POST | session-only |  | — |
| `items/semantic-model/[id]/ingest/route.ts` | POST | owner-scoped | ● | AAS, ADF, ADLS, Cosmos |
| `items/semantic-model/[id]/measures/route.ts` | POST | session-only |  | — |
| `items/semantic-model/[id]/model-health/route.ts` | GET POST | owner-scoped | ● | — |
| `items/semantic-model/[id]/model/route.ts` | GET POST PUT PATCH DELETE | owner-scoped |  | — |
| `items/semantic-model/[id]/prep-for-ai/route.ts` | GET POST | owner-scoped |  | — |
| `items/semantic-model/[id]/refresh-policy/route.ts` | GET PUT | session-only | ● | — |
| `items/semantic-model/[id]/refresh-schedule/route.ts` | GET PATCH | session-only | ● | — |
| `items/semantic-model/[id]/refresh/route.ts` | GET POST | session-only | ● | — |
| `items/semantic-model/[id]/refreshes/route.ts` | GET POST | session-only | ● | — |
| `items/semantic-model/[id]/roles/route.ts` | GET POST PUT | owner-scoped | ● | Databricks, Synapse SQL |
| `items/semantic-model/[id]/route.ts` | GET | owner-scoped |  | — |
| `items/semantic-model/[id]/semantic-link/route.ts` | GET POST | owner-scoped |  | — |
| `items/semantic-model/[id]/synonyms/route.ts` | GET PUT | owner-scoped |  | — |
| `items/semantic-model/[id]/take-over/route.ts` | POST | session-only |  | — |
| `items/semantic-model/[id]/verified-queries/route.ts` | GET POST | owner-scoped |  | — |
| `items/semantic-model/aas-databases/route.ts` | GET | session-only | ● | — |
| `items/semantic-model/build/route.ts` | POST | session-only |  | — |
| `items/semantic-model/route.ts` | GET | owner-scoped |  | — |
| `items/semantic-model/scaffold/route.ts` | POST | owner-scoped | ● | Synapse SQL |
| `items/semantic-model/workspace-pane/route.ts` | GET POST | owner-scoped | ● | AAS |
| `items/service-bus-namespace/data-explorer/route.ts` | POST | session-only | ● | — |
| `items/service-bus-namespace/route.ts` | GET POST DELETE | session-only | ● | Service Bus |
| `items/slate-app/[id]/generate/route.ts` | POST | owner-scoped |  | — |
| `items/slate-app/[id]/publish/route.ts` | POST | owner-scoped |  | — |
| `items/slate-app/[id]/query/run/route.ts` | POST | owner-scoped | ● | ADX, Synapse SQL |
| `items/slate-app/[id]/route.ts` | — | public |  | — |
| `items/slate-app/route.ts` | — | public |  | — |
| `items/spark-environment/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | — |
| `items/spark-environment/route.ts` | GET POST | owner-scoped |  | — |
| `items/spark-job-definition/[id]/files/route.ts` | POST | owner-scoped | ● | ADLS |
| `items/spark-job-definition/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | — |
| `items/spark-job-definition/[id]/runs/[runId]/cancel/route.ts` | POST | owner-scoped | ● | Synapse |
| `items/spark-job-definition/[id]/runs/[runId]/route.ts` | GET | owner-scoped | ● | Synapse |
| `items/spark-job-definition/[id]/runs/route.ts` | GET | owner-scoped | ● | Synapse |
| `items/spark-job-definition/[id]/submit/route.ts` | POST | owner-scoped |  | Synapse |
| `items/spark-job-definition/route.ts` | GET POST | owner-scoped |  | — |
| `items/sql-analytics-endpoint/[id]/objects/route.ts` | — | public |  | — |
| `items/sql-analytics-endpoint/[id]/query/route.ts` | — | public |  | — |
| `items/sql-analytics-endpoint/[id]/schema/route.ts` | — | public |  | — |
| `items/sql-database/[id]/route.ts` | GET DELETE | owner-scoped |  | Cosmos |
| `items/sql-database/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `items/sql-databases/route.ts` | GET | session-only |  | — |
| `items/sql-server-2025-vector-index/route.ts` | GET POST | owner-scoped |  | — |
| `items/stream-analytics-job/[name]/assist/route.ts` | — | public |  | — |
| `items/stream-analytics-job/[name]/inputs/route.ts` | PUT DELETE | session-only |  | Stream Analytics |
| `items/stream-analytics-job/[name]/metrics/route.ts` | GET | session-only |  | Azure Monitor, Stream Analytics |
| `items/stream-analytics-job/[name]/outputs/route.ts` | PUT DELETE | session-only |  | Stream Analytics |
| `items/stream-analytics-job/[name]/query/route.ts` | PUT | session-only |  | Stream Analytics |
| `items/stream-analytics-job/[name]/route.ts` | GET | session-only |  | Stream Analytics |
| `items/stream-analytics-job/[name]/state/route.ts` | POST | session-only |  | Stream Analytics |
| `items/stream-analytics-job/[name]/test/route.ts` | POST | session-only |  | Stream Analytics |
| `items/stream-analytics-job/route.ts` | GET | session-only | ● | Stream Analytics |
| `items/synapse-dedicated-sql-pool/[id]/cancel/route.ts` | POST | session-only |  | Synapse SQL |
| `items/synapse-dedicated-sql-pool/[id]/clone/route.ts` | POST | session-only |  | Synapse SQL, Synapse pool |
| `items/synapse-dedicated-sql-pool/[id]/connection/route.ts` | GET | session-only |  | — |
| `items/synapse-dedicated-sql-pool/[id]/model/route.ts` | — | public |  | — |
| `items/synapse-dedicated-sql-pool/[id]/query-history/route.ts` | GET | session-only |  | Synapse SQL, Synapse pool |
| `items/synapse-dedicated-sql-pool/[id]/query/route.ts` | POST | owner-scoped |  | Synapse SQL, Synapse pool |
| `items/synapse-dedicated-sql-pool/[id]/resume/route.ts` | POST | session-only |  | Synapse pool |
| `items/synapse-dedicated-sql-pool/[id]/schema/route.ts` | GET | session-only |  | Synapse SQL, Synapse pool |
| `items/synapse-dedicated-sql-pool/[id]/script-out/route.ts` | GET | session-only |  | Synapse SQL, Synapse pool |
| `items/synapse-dedicated-sql-pool/[id]/state/route.ts` | GET POST | session-only |  | Synapse pool |
| `items/synapse-notebook/[id]/route.ts` | GET | owner-scoped |  | Cosmos |
| `items/synapse-pipeline/[id]/bind/route.ts` | GET POST | owner-scoped |  | Synapse |
| `items/synapse-pipeline/[id]/connections/route.ts` | GET | session-only | ● | — |
| `items/synapse-pipeline/[id]/copilot/route.ts` | POST | owner-scoped |  | — |
| `items/synapse-pipeline/[id]/debug/route.ts` | POST | owner-scoped |  | Synapse |
| `items/synapse-pipeline/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | Synapse |
| `items/synapse-pipeline/[id]/run/route.ts` | POST | owner-scoped |  | Synapse |
| `items/synapse-pipeline/[id]/runs/route.ts` | GET | owner-scoped |  | Synapse |
| `items/synapse-pipeline/[id]/triggers/route.ts` | GET POST | owner-scoped |  | Synapse |
| `items/synapse-pipeline/list/route.ts` | GET | session-only |  | Synapse |
| `items/synapse-serverless-sql-pool/[id]/cancel/route.ts` | POST | session-only |  | Synapse SQL |
| `items/synapse-serverless-sql-pool/[id]/connection/route.ts` | GET | session-only |  | — |
| `items/synapse-serverless-sql-pool/[id]/iqy/route.ts` | POST | session-only |  | — |
| `items/synapse-serverless-sql-pool/[id]/objects/route.ts` | GET | session-only | ● | Synapse SQL |
| `items/synapse-serverless-sql-pool/[id]/query/route.ts` | POST | owner-scoped |  | Synapse SQL |
| `items/synapse-serverless-sql-pool/[id]/schema/route.ts` | GET | session-only |  | Synapse SQL |
| `items/synapse-spark-pool/[id]/auto-pause/route.ts` | POST | session-only |  | Synapse |
| `items/synapse-spark-pool/[id]/config/route.ts` | POST | session-only |  | Synapse |
| `items/synapse-spark-pool/[id]/route.ts` | GET PUT | session-only |  | Synapse |
| `items/synapse-spark-pool/[id]/runs/route.ts` | GET | session-only |  | Synapse |
| `items/synapse-spark-pool/[id]/scale/route.ts` | POST | session-only |  | Synapse |
| `items/synapse-spark-pool/[id]/state/route.ts` | GET POST | session-only |  | Synapse |
| `items/synapse-spark-pool/[id]/submit/route.ts` | POST | session-only |  | Synapse |
| `items/synapse-spark-pool/list/route.ts` | GET | session-only |  | Synapse |
| `items/synthetic-data/[id]/catalog/route.ts` | GET | owner-scoped | ● | Databricks |
| `items/synthetic-data/[id]/generate/route.ts` | POST | owner-scoped | ● | Databricks |
| `items/synthetic-data/[id]/preview/route.ts` | POST | owner-scoped |  | — |
| `items/synthetic-data/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/synthetic-data/[id]/sources/route.ts` | GET | owner-scoped |  | — |
| `items/tapestry/[id]/geo/route.ts` | POST | session-only | ● | ADX |
| `items/tapestry/[id]/link/route.ts` | POST | session-only | ● | ADX |
| `items/tapestry/[id]/timeline/route.ts` | POST | session-only | ● | ADX |
| `items/tracing/[traceId]/route.ts` | GET | session-only |  | — |
| `items/tracing/route.ts` | GET | session-only |  | — |
| `items/transformation-project/[id]/route.ts` | GET PUT DELETE | owner-scoped |  | — |
| `items/transformation-project/route.ts` | GET POST | owner-scoped |  | — |
| `items/user-data-function/[id]/invoke/route.ts` | POST | owner-scoped |  | — |
| `items/user-data-function/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/variable-library/[id]/resolve/route.ts` | POST | owner-scoped |  | — |
| `items/variable-library/[id]/route.ts` | GET PATCH DELETE | owner-scoped |  | — |
| `items/vector-store/[id]/index/route.ts` | GET POST PUT | session-only |  | — |
| `items/vector-store/[id]/search/route.ts` | POST | session-only | ● | — |
| `items/vector-store/[id]/sync/route.ts` | GET POST | session-only |  | — |
| `items/vector-store/route.ts` | GET POST | owner-scoped |  | — |
| `items/warehouse/[id]/cancel/route.ts` | POST | session-only |  | Synapse SQL |
| `items/warehouse/[id]/clone/route.ts` | POST | session-only | ● | ADLS, Databricks, Synapse SQL, Synapse pool |
| `items/warehouse/[id]/copy-into/route.ts` | GET POST | session-only |  | ADLS, Synapse SQL, Synapse pool |
| `items/warehouse/[id]/iqy/route.ts` | POST | session-only |  | — |
| `items/warehouse/[id]/model/route.ts` | — | public |  | — |
| `items/warehouse/[id]/query-acceleration/route.ts` | GET POST | session-only | ● | Synapse SQL, Synapse pool |
| `items/warehouse/[id]/query/route.ts` | POST | session-only |  | Synapse SQL, Synapse pool |
| `items/warehouse/[id]/restore-points/route.ts` | GET POST | session-only | ● | Synapse pool |
| `items/warehouse/[id]/schema/route.ts` | GET | session-only |  | Synapse SQL, Synapse pool |
| `items/warehouse/[id]/script-out/route.ts` | GET | session-only |  | Synapse SQL, Synapse pool |
| `items/warehouse/[id]/snapshots/route.ts` | GET POST | session-only | ● | ADLS, Databricks |
| `items/warehouse/[id]/time-travel/route.ts` | GET POST | session-only | ● | ADLS, Databricks |
| `items/warehouse/migrate/import/route.ts` | POST | owner-scoped | ● | Synapse SQL, Synapse pool |
| `items/warehouse/migrate/scan/route.ts` | POST | owner-scoped |  | — |
| `items/workshop-app/[id]/bind-ontology/route.ts` | GET POST | owner-scoped |  | — |
| `items/workshop-app/[id]/eject/route.ts` | POST | owner-scoped |  | — |
| `items/workshop-app/[id]/publish/route.ts` | POST | owner-scoped |  | — |
| `items/workshop-app/[id]/route.ts` | — | public |  | — |
| `items/workshop-app/[id]/run-action/route.ts` | POST | owner-scoped | ● | Synapse SQL |
| `items/workshop-app/route.ts` | — | public |  | — |

## lakehouse

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `lakehouse/ai-clean-suggest/route.ts` | POST | owner-scoped | ● | — |
| `lakehouse/containers/route.ts` | GET | session-only |  | ADLS |
| `lakehouse/download/route.ts` | GET | session-only |  | ADLS |
| `lakehouse/history/route.ts` | GET POST | session-only | ● | ADLS, Databricks |
| `lakehouse/interop/route.ts` | GET PUT | owner-scoped | ● | ADLS, Cosmos, Synapse |
| `lakehouse/load-to-table/route.ts` | POST | session-only | ● | ADLS, Synapse |
| `lakehouse/maintenance/route.ts` | GET POST | owner-scoped |  | ADLS, Cosmos, Synapse |
| `lakehouse/path/route.ts` | POST DELETE | session-only |  | ADLS |
| `lakehouse/paths/route.ts` | GET | owner-scoped |  | ADLS |
| `lakehouse/permissions/rls-test/route.ts` | POST | session-only |  | — |
| `lakehouse/permissions/route.ts` | GET POST DELETE | session-only |  | ADLS |
| `lakehouse/preview/route.ts` | GET | session-only |  | ADLS, Synapse SQL |
| `lakehouse/references/paths/route.ts` | GET | owner-scoped |  | ADLS, Cosmos |
| `lakehouse/references/route.ts` | GET POST | owner-scoped |  | ADLS, Cosmos |
| `lakehouse/schemas/route.ts` | GET POST PATCH DELETE | session-only | ● | Synapse |
| `lakehouse/settings/route.ts` | GET PUT | owner-scoped | ● | ADLS, Cosmos, Databricks |
| `lakehouse/shortcuts/browse/route.ts` | GET | session-only | ● | — |
| `lakehouse/shortcuts/credentials/route.ts` | POST | session-only | ● | — |
| `lakehouse/shortcuts/route.ts` | GET POST DELETE | session-only |  | ADLS |
| `lakehouse/shortcuts/sharepoint/route.ts` | GET | owner-scoped | ● | — |
| `lakehouse/shortcuts/test/route.ts` | POST | session-only | ● | ADLS |
| `lakehouse/table-stats/route.ts` | GET | session-only | ● | ADLS, Synapse |
| `lakehouse/tables/route.ts` | GET | owner-scoped |  | — |
| `lakehouse/transform-preview/route.ts` | GET POST | session-only | ● | ADLS, Synapse |
| `lakehouse/upload/route.ts` | POST | session-only |  | ADLS |

## landing-zones

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `landing-zones/[id]/attach/preflight/route.ts` | POST | admin |  | — |
| `landing-zones/[id]/attach/route.ts` | POST | admin |  | — |
| `landing-zones/[id]/services/[serviceId]/route.ts` | DELETE | admin |  | — |
| `landing-zones/[id]/services/route.ts` | GET | admin |  | — |
| `landing-zones/discover/route.ts` | GET | admin |  | — |
| `landing-zones/route.ts` | GET POST | admin |  | — |

## learn

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `learn/notebook-import/route.ts` | GET POST | owner-scoped |  | Cosmos |

## lineage

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `lineage/openlineage/route.ts` | POST | public |  | Cosmos |

## loom

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `loom/capacities/route.ts` | GET | session-only |  | — |
| `loom/compute-targets/[id]/[verb]/route.ts` | POST | session-only |  | — |
| `loom/compute-targets/databricks-options/route.ts` | GET | session-only |  | Databricks |
| `loom/compute-targets/route.ts` | GET POST | owner-scoped |  | Databricks, Synapse |
| `loom/shir/route.ts` | GET POST | session-only | ● | — |
| `loom/storage-paths/route.ts` | GET | session-only |  | — |
| `loom/workspaces/route.ts` | GET | owner-scoped |  | Cosmos |

## maps

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `maps/static/route.ts` | GET | session-only | ● | Azure Maps |
| `maps/tiles/[...path]/route.ts` | GET | session-only | ● | Azure Maps |

## marketplace

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `marketplace/catalog/route.ts` | GET | session-only |  | APIM |
| `marketplace/gate/route.ts` | GET | session-only |  | — |
| `marketplace/mini-app/route.ts` | POST | owner-scoped |  | APIM |
| `marketplace/products/[id]/certify/route.ts` | POST | owner-scoped |  | — |
| `marketplace/products/[id]/route.ts` | GET | session-only |  | — |
| `marketplace/products/[id]/subscribe/route.ts` | POST | owner-scoped |  | — |
| `marketplace/products/route.ts` | GET POST | owner-scoped |  | — |
| `marketplace/sharing/catalogs/route.ts` | GET DELETE | session-only |  | — |
| `marketplace/sharing/providers/[name]/route.ts` | GET POST DELETE | session-only |  | — |
| `marketplace/sharing/providers/route.ts` | GET POST | session-only | ● | — |
| `marketplace/sharing/query/route.ts` | POST | session-only | ● | Databricks |
| `marketplace/sharing/recipients/[name]/route.ts` | GET DELETE | session-only |  | — |
| `marketplace/sharing/recipients/route.ts` | GET POST | session-only |  | — |
| `marketplace/sharing/shares/[name]/route.ts` | GET PATCH DELETE | session-only |  | — |
| `marketplace/sharing/shares/route.ts` | GET POST | session-only |  | — |
| `marketplace/subscriptions/[sid]/keys/regenerate/route.ts` | POST | session-only |  | APIM |
| `marketplace/subscriptions/[sid]/keys/route.ts` | POST | session-only |  | APIM |
| `marketplace/subscriptions/[sid]/route.ts` | PATCH DELETE | session-only |  | APIM |
| `marketplace/subscriptions/route.ts` | GET POST | session-only |  | APIM |

## mdm

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `mdm/golden-records/route.ts` | GET | owner-scoped | ● | — |
| `mdm/match/approve/route.ts` | GET POST DELETE | owner-scoped |  | — |
| `mdm/match/route.ts` | POST | owner-scoped | ● | — |
| `mdm/merge/route.ts` | POST | owner-scoped | ● | — |
| `mdm/models/route.ts` | GET POST DELETE | owner-scoped |  | — |
| `mdm/reference-data/route.ts` | GET POST DELETE | owner-scoped |  | — |

## me

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `me/route.ts` | GET | admin |  | — |

## mesh

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `mesh/a2a/[id]/card/route.ts` | GET | session-only |  | — |
| `mesh/a2a/delegate/route.ts` | POST | session-only |  | — |
| `mesh/agents/[id]/route.ts` | GET PUT DELETE | session-only |  | — |
| `mesh/agents/route.ts` | GET POST | owner-scoped |  | — |
| `mesh/catalog/route.ts` | GET | session-only |  | — |
| `mesh/run/route.ts` | POST | session-only |  | — |

## messaging

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `messaging/metrics/route.ts` | GET | session-only | ● | Azure Monitor, Event Hubs, Service Bus |

## monitor

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `monitor/action-groups/route.ts` | GET POST | session-only | ● | Azure Monitor |
| `monitor/activities/route.ts` | GET | session-only |  | Azure Monitor |
| `monitor/activity/route.ts` | GET | session-only |  | Azure Monitor |
| `monitor/alerts/route.ts` | GET POST | session-only | ● | Azure Monitor |
| `monitor/cost/route.ts` | GET | session-only |  | Azure Monitor |
| `monitor/defender/remediate/route.ts` | POST | session-only |  | Azure Monitor |
| `monitor/defender/route.ts` | GET | session-only |  | Azure Monitor |
| `monitor/diagnostics/route.ts` | GET POST | session-only |  | Azure Monitor |
| `monitor/health/route.ts` | GET | session-only |  | Azure Monitor |
| `monitor/inventory/route.ts` | GET | session-only |  | Azure Monitor |
| `monitor/logic-app-callback/route.ts` | POST | session-only |  | Azure Monitor |
| `monitor/logs/route.ts` | GET POST | session-only |  | Azure Monitor |
| `monitor/metrics/route.ts` | POST | session-only |  | Azure Monitor |
| `monitor/spark/route.ts` | GET | session-only |  | Azure Monitor |

## network

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `network/managed-private-endpoints/route.ts` | GET POST DELETE | admin |  | — |
| `network/pbi-gateway/route.ts` | GET | session-only |  | — |
| `network/private-endpoints/route.ts` | GET | owner-scoped |  | — |
| `network/vnet-data-gateway/route.ts` | GET | session-only |  | — |
| `network/vpn-profile/route.ts` | GET POST | session-only |  | — |

## notebook

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `notebook/[id]/assist/route.ts` | POST | owner-scoped | ● | Cosmos, Synapse SQL |
| `notebook/[id]/contents/route.ts` | GET PUT | owner-scoped | ● | — |
| `notebook/[id]/execute/route.ts` | GET POST | session-only | ● | — |
| `notebook/[id]/lsp/route.ts` | GET | session-only |  | — |
| `notebook/[id]/schedule/route.ts` | GET POST PATCH DELETE | owner-scoped | ● | — |
| `notebook/[id]/session/route.ts` | GET POST DELETE | session-only | ● | — |
| `notebook/[id]/wrangler-ai/route.ts` | POST | owner-scoped | ● | — |
| `notebook/execute/route.ts` | POST | session-only |  | — |
| `notebook/wrangler/route.ts` | POST | session-only |  | — |

## notifications

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `notifications/route.ts` | GET POST PATCH | owner-scoped |  | Cosmos |

## onelake

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `onelake/[itemId]/route.ts` | DELETE | owner-scoped |  | Cosmos |
| `onelake/catalog/route.ts` | GET | owner-scoped | ● | Cosmos |
| `onelake/governance/route.ts` | GET | owner-scoped |  | Cosmos, Purview |
| `onelake/lifecycle/route.ts` | GET PUT | owner-scoped |  | ADLS, Cosmos |
| `onelake/paths/route.ts` | GET | session-only |  | ADLS |
| `onelake/recycle/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `onelake/resolve/route.ts` | GET POST | session-only | ● | — |
| `onelake/security/route.ts` | GET POST DELETE | session-only |  | ADLS |
| `onelake/storage/route.ts` | GET | owner-scoped | ● | ADLS, Cosmos |
| `onelake/tier/route.ts` | GET PUT | session-only |  | ADLS |

## ontology-functions

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `ontology-functions/route.ts` | GET POST DELETE | admin |  | — |

## openapi.json

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `openapi.json/route.ts` | GET | public |  | — |

## org-reports

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `org-reports/render/route.ts` | GET POST | session-only |  | — |
| `org-reports/route.ts` | GET | session-only |  | — |

## powerbi

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `powerbi/[group]/route.ts` | GET POST DELETE | session-only | ● | — |
| `powerbi/access/route.ts` | GET POST PUT DELETE | session-only | ● | — |
| `powerbi/datasources/route.ts` | GET POST | session-only | ● | — |
| `powerbi/endorsement/route.ts` | GET PUT | session-only | ● | — |
| `powerbi/pipelines/route.ts` | GET POST | session-only |  | — |
| `powerbi/workspaces/route.ts` | GET | session-only |  | — |

## powerplatform

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `powerplatform/apps/route.ts` | GET DELETE | session-only | ● | — |
| `powerplatform/connections/route.ts` | GET DELETE | session-only | ● | — |
| `powerplatform/connectors/route.ts` | GET | session-only | ● | — |
| `powerplatform/environments/operation/route.ts` | GET | session-only | ● | — |
| `powerplatform/environments/route.ts` | GET POST PATCH DELETE | session-only | ● | — |
| `powerplatform/flows/route.ts` | GET POST DELETE | session-only | ● | — |
| `powerplatform/tables/route.ts` | GET POST | session-only | ● | — |

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
| `realtime-hub/connect-source/route.ts` | POST | owner-scoped |  | — |
| `realtime-hub/databases/route.ts` | GET | session-only | ● | ADX |
| `realtime-hub/endpoints/route.ts` | GET | owner-scoped |  | — |
| `realtime-hub/http-source/route.ts` | POST | session-only |  | — |
| `realtime-hub/keyvault-certificates/route.ts` | GET | session-only | ● | — |
| `realtime-hub/options/route.ts` | GET | session-only | ● | Event Hubs |
| `realtime-hub/preview/route.ts` | POST | session-only |  | ADX |
| `realtime-hub/provision/route.ts` | POST | session-only |  | Event Hubs |
| `realtime-hub/streams/route.ts` | GET | owner-scoped |  | — |

## rti-hub

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `rti-hub/route.ts` | GET | owner-scoped | ● | Event Hubs |

## running-workloads

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `running-workloads/route.ts` | GET | owner-scoped | ● | Cosmos |

## runtime-flags

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `runtime-flags/route.ts` | GET | session-only |  | — |

## scheduler

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `scheduler/[id]/route.ts` | GET PATCH DELETE | owner-scoped | ● | — |
| `scheduler/[id]/run/route.ts` | POST | owner-scoped | ● | — |
| `scheduler/[id]/runs/route.ts` | GET | owner-scoped | ● | — |
| `scheduler/route.ts` | GET POST | owner-scoped | ● | — |

## scim

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `scim/v2/Groups/[id]/route.ts` | GET PUT PATCH DELETE | public |  | — |
| `scim/v2/Groups/route.ts` | GET POST | public |  | — |
| `scim/v2/ResourceTypes/route.ts` | GET | public |  | — |
| `scim/v2/ServiceProviderConfig/route.ts` | GET | public |  | — |
| `scim/v2/Users/[id]/route.ts` | GET PUT PATCH DELETE | public |  | — |
| `scim/v2/Users/route.ts` | GET POST | public |  | — |

## search

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `search/items/route.ts` | POST | owner-scoped |  | Cosmos |

## semantic-model

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `semantic-model/metric-view/route.ts` | POST | session-only | ● | Synapse SQL |

## setup

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `setup/config/route.ts` | GET | session-only |  | — |
| `setup/deploy-preflight/route.ts` | GET | admin |  | — |
| `setup/deploy-status/route.ts` | GET | session-only |  | — |
| `setup/deploy/route.ts` | POST | admin |  | — |
| `setup/discover-services/route.ts` | GET | admin | ● | — |
| `setup/existing-aoai/route.ts` | GET | session-only |  | — |
| `setup/existing-dlzs/route.ts` | GET | owner-scoped |  | — |
| `setup/existing-storage/route.ts` | GET | session-only |  | — |
| `setup/identity/route.ts` | GET POST | owner-scoped |  | — |
| `setup/landing-zones/grant/route.ts` | POST | admin |  | — |
| `setup/landing-zones/route.ts` | GET | session-only |  | — |
| `setup/quota-preflight/route.ts` | POST | session-only |  | — |
| `setup/regions/route.ts` | GET | session-only |  | — |
| `setup/scan-cosmos/route.ts` | GET | session-only |  | — |
| `setup/scan-purview/route.ts` | GET | session-only |  | — |
| `setup/scan-services/route.ts` | GET | session-only |  | — |
| `setup/scan/route.ts` | GET | session-only |  | — |
| `setup/subscriptions/route.ts` | GET | owner-scoped |  | — |
| `setup/tenant-topology/route.ts` | GET | session-only |  | — |
| `setup/wire-existing/route.ts` | POST | session-only |  | — |
| `setup/workflow-run-status/route.ts` | GET | session-only | ● | — |

## spark

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `spark/session-pool/route.ts` | GET POST | admin | ● | — |

## spark-environment

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `spark-environment/[id]/attach/route.ts` | GET POST | owner-scoped |  | — |
| `spark-environment/[id]/libraries/route.ts` | POST DELETE | owner-scoped |  | ADLS |
| `spark-environment/[id]/publish/route.ts` | POST | owner-scoped |  | Synapse |
| `spark-environment/[id]/validate/route.ts` | GET POST | owner-scoped |  | Synapse |

## sqldb

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `sqldb/columns/route.ts` | GET | public |  | — |
| `sqldb/constraints/route.ts` | GET POST PATCH DELETE | public |  | — |
| `sqldb/functions/route.ts` | GET DELETE | public |  | — |
| `sqldb/indexes/route.ts` | GET DELETE | public |  | — |
| `sqldb/preview/route.ts` | GET | public |  | — |
| `sqldb/procedures/route.ts` | GET DELETE | public |  | — |
| `sqldb/rename/route.ts` | POST | public |  | — |
| `sqldb/schemas/route.ts` | GET | public |  | — |
| `sqldb/script/route.ts` | GET | public |  | — |
| `sqldb/table-types/route.ts` | GET DELETE | public |  | — |
| `sqldb/tables/route.ts` | GET DELETE | public |  | — |
| `sqldb/views/route.ts` | GET DELETE | public |  | — |

## storage

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `storage/accounts/route.ts` | GET | session-only |  | — |

## synapse

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `synapse/dataflows/route.ts` | GET POST DELETE | session-only | ● | — |
| `synapse/datasets/[name]/route.ts` | GET | session-only | ● | — |
| `synapse/datasets/route.ts` | GET POST DELETE | session-only | ● | — |
| `synapse/environments/route.ts` | GET | session-only |  | — |
| `synapse/integration-runtimes/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/kqlscripts/[name]/route.ts` | GET PUT DELETE | session-only | ● | Synapse |
| `synapse/kqlscripts/[name]/run/route.ts` | POST | session-only | ● | — |
| `synapse/kqlscripts/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/linkedservices/[name]/route.ts` | GET | session-only | ● | — |
| `synapse/linkedservices/route.ts` | GET POST DELETE | session-only | ● | — |
| `synapse/linkedservices/test/route.ts` | POST | session-only | ● | — |
| `synapse/notebooks/[name]/route.ts` | GET PUT DELETE | session-only | ● | ADLS |
| `synapse/notebooks/[name]/run-cell/route.ts` | GET POST | session-only | ● | Synapse |
| `synapse/notebooks/route.ts` | GET POST DELETE | session-only | ● | — |
| `synapse/pipelines/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/pools/route.ts` | GET | session-only | ● | Synapse |
| `synapse/sparkjobdefinitions/[name]/route.ts` | GET PUT DELETE | session-only | ● | Synapse |
| `synapse/sparkjobdefinitions/[name]/run/route.ts` | GET POST | session-only | ● | Synapse |
| `synapse/sparkjobdefinitions/route.ts` | GET POST DELETE | session-only | ● | Synapse |
| `synapse/sqlscripts/route.ts` | GET POST DELETE | session-only | ● | — |
| `synapse/triggers/route.ts` | GET POST DELETE | session-only | ● | Synapse |

## tabs

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `tabs/route.ts` | GET POST | owner-scoped |  | Cosmos |

## telemetry

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `telemetry/rum/route.ts` | GET POST | session-only |  | — |

## tenant-theme

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `tenant-theme/route.ts` | GET PUT | owner-scoped |  | Cosmos |

## thread

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `thread/add-data-agent-source/route.ts` | POST | owner-scoped |  | — |
| `thread/analyze-in-notebook/route.ts` | POST | owner-scoped |  | — |
| `thread/analyze-in-powerbi/route.ts` | POST | owner-scoped | ● | Cosmos, Synapse SQL |
| `thread/analyze-with-dax/route.ts` | POST | owner-scoped |  | — |
| `thread/bind-to-ontology/route.ts` | POST | owner-scoped |  | — |
| `thread/build-loom-report/route.ts` | POST | owner-scoped | ● | Synapse SQL |
| `thread/build-powerbi-model/route.ts` | POST | owner-scoped | ● | Synapse SQL |
| `thread/edges/route.ts` | GET | session-only |  | — |
| `thread/kql-query-to-dashboard-tile/route.ts` | POST | owner-scoped | ● | ADX |
| `thread/lakehouse-delta-tables/route.ts` | GET | owner-scoped |  | — |
| `thread/materialize-to-kql/route.ts` | POST | owner-scoped | ● | ADX |
| `thread/mirror-to-lakehouse/route.ts` | POST | owner-scoped |  | — |
| `thread/mirror-to-notebook/route.ts` | POST | owner-scoped |  | — |
| `thread/model-tables/route.ts` | GET | owner-scoped |  | — |
| `thread/open-in-report-builder/route.ts` | POST | owner-scoped |  | ADX, Cosmos |
| `thread/promote-medallion/route.ts` | POST | owner-scoped |  | — |
| `thread/publish-as-api/route.ts` | POST | owner-scoped | ● | Synapse SQL |
| `thread/warehouse-tables/route.ts` | GET | session-only | ● | Synapse SQL |

## transform

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `transform/[id]/apply/route.ts` | POST | owner-scoped |  | — |
| `transform/[id]/diff/route.ts` | POST | owner-scoped |  | — |
| `transform/[id]/environments/route.ts` | POST | owner-scoped |  | — |
| `transform/[id]/history/route.ts` | GET | owner-scoped |  | — |
| `transform/[id]/plan/route.ts` | POST | owner-scoped |  | — |
| `transform/[id]/run/route.ts` | POST | owner-scoped |  | — |

## user-prefs

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `user-prefs/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |

## v1

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `v1/whoami/route.ts` | GET | owner-scoped |  | — |

## version

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `version/route.ts` | GET | public |  | — |

## warehouse

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `warehouse/explain/route.ts` | POST | session-only | ● | Synapse SQL, Synapse pool |
| `warehouse/history/route.ts` | GET | session-only | ● | Synapse SQL, Synapse pool |
| `warehouse/query/route.ts` | POST | session-only | ● | Synapse SQL, Synapse pool |

## workloads-catalog

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `workloads-catalog/route.ts` | GET POST PATCH DELETE | owner-scoped |  | Cosmos |

## workspaces

| Route | Methods | Auth scope | Gated | Backends |
| --- | --- | --- | :---: | --- |
| `workspaces/[id]/agent-config/route.ts` | GET PUT | owner-scoped |  | — |
| `workspaces/[id]/folders/route.ts` | GET POST PATCH DELETE | admin |  | Cosmos |
| `workspaces/[id]/image/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `workspaces/[id]/items/[itemId]/route.ts` | PATCH DELETE | owner-scoped |  | Cosmos |
| `workspaces/[id]/items/route.ts` | GET POST | admin |  | Cosmos |
| `workspaces/[id]/permissions/route.ts` | GET POST DELETE | owner-scoped |  | Cosmos |
| `workspaces/[id]/powerbi-mapping/route.ts` | GET PUT | owner-scoped | ● | Cosmos |
| `workspaces/[id]/role-assignments/[principalId]/route.ts` | DELETE | admin |  | — |
| `workspaces/[id]/role-assignments/route.ts` | GET POST | admin |  | — |
| `workspaces/[id]/route.ts` | GET PATCH DELETE | admin |  | Cosmos |
| `workspaces/[id]/scm/route.ts` | GET POST DELETE | owner-scoped | ● | Cosmos |
| `workspaces/[id]/task-flows/[flowId]/route.ts` | GET PUT DELETE | owner-scoped |  | Cosmos |
| `workspaces/[id]/task-flows/[flowId]/run/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `workspaces/[id]/task-flows/route.ts` | GET POST | owner-scoped |  | Cosmos |
| `workspaces/[id]/time-branches/[branchId]/route.ts` | DELETE | admin |  | — |
| `workspaces/[id]/time-branches/route.ts` | GET POST | admin |  | — |
| `workspaces/bulk-delete/route.ts` | GET POST | admin |  | Cosmos |
| `workspaces/route.ts` | GET POST | owner-scoped |  | Cosmos |
