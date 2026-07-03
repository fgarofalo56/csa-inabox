#!/usr/bin/env node
/**
 * GUARDRAIL: route-guards  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE: a BFF route that reads or mutates another user's / tenant's data
 *   must authorize the CALLER against that data — not merely confirm the
 *   caller is signed in. `getSession()` alone answers "is someone logged
 *   in", NOT "is THIS user allowed to touch THIS resource". A route that
 *   point-reads / writes a resource by an id taken from the URL with only a
 *   `getSession()` 401 check is a cross-tenant hole: any signed-in user can
 *   pass any id.  (This is exactly the security-roles cross-tenant read that
 *   shipped and was fixed by threading `loadOwnedItem`.)
 *
 * SCOPE (the directories where this hole class lives):
 *   - apps/fiab-console/app/api/items/[type]/[id]/**\/route.ts
 *       the GENERIC per-item handlers — they operate on ANY Cosmos-owned
 *       item by (type, id) and MUST scope to the owner/tenant.
 *   - apps/fiab-console/app/api/items/<type>/[id]/**\/route.ts
 *       the SPECIFIC-per-item-TYPE handlers (e.g. data-agent/[id],
 *       activator/[id], map/[id], kql-dashboard/[id]). These were previously
 *       treated as out-of-scope on the theory that a per-type route only ever
 *       touches a single SHARED Azure resource resolved by type. That theory
 *       was WRONG for the subset that read/mutate a per-tenant Cosmos item (or
 *       a per-item source descriptor / bound database) by the URL [id] — those
 *       are the exact cross-tenant holes that shipped on data-agent/[id]/
 *       source-schema, activator/[id]/adx-source, and adx/anomaly. They are now
 *       IN scope: a genuinely shared-by-type route must be ALLOWLISTED with a
 *       reason; an ownable one must thread loadOwnedItem / an admin gate.
 *   - apps/fiab-console/app/api/adx/**\/route.ts
 *       the ADX / KQL data-plane query routes — they run tenant data on the
 *       SHARED ADX cluster and MUST resolve the target database from an
 *       owner-checked item (guardAdxRequest / loadKustoItem) or gate on a
 *       tenant admin, never a free-form caller-supplied database.
 *   - apps/fiab-console/app/api/admin/**\/route.ts
 *       admin surfaces — must gate on a tenant-admin / capability check, not
 *       just a logged-in session.
 *
 * WHAT COUNTS AS AUTHORIZED (any one of these signals in the handler file):
 *   - a named owner/tenant/admin guard:
 *       loadOwnedItem, updateOwnedItem, deleteOwnedItem, assertOwner,
 *       authorizeWorkspace, requireWorkspace, requireTenantAdmin,
 *       isTenantAdmin, isTenantAdminTier, requireDomainRole, enforceCapability
 *   - the caller identity threaded into the data access:
 *       session.claims.oid / .tid / .tenantId  (owner-scoped Cosmos reads)
 *   - a domain / DLZ / policy gate:
 *       denyIfNoDlzAccess, pdpCheck, loadContentBackedItem
 *
 * A route is FLAGGED when it exports a mutating handler (POST/PUT/PATCH/
 * DELETE) OR a GET (returns data), calls getSession(), matches NONE of the
 * signals above, and is not in the ALLOWLIST below.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY:
 *   Only for routes that legitimately need no per-resource authorization —
 *   e.g. a handler that operates on a SHARED Azure backend resolved purely by
 *   item TYPE (no per-tenant Cosmos ownership to check), or a self/public
 *   endpoint. Add the repo-relative path to ALLOWLIST with a one-line reason.
 *   Prefer FIXING the route (thread `loadOwnedItem` / an admin gate) over
 *   allowlisting — allowlisting an ownable resource re-opens the hole.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

const API_ROOT = path.join(CONSOLE_ROOT, 'app', 'api');

const GUARD_SIGNAL_RE = new RegExp(
  [
    'loadOwnedItem', 'updateOwnedItem', 'deleteOwnedItem', 'assertOwner',
    // createOwnedItem / the recycle-bin + list helpers all resolve the caller's
    // workspace ownership (session.claims.oid partition) INSIDE the helper, so a
    // route that threads one of them is owner-scoped even without a literal
    // claims.oid in the handler.
    'createOwnedItem', 'softDeleteOwnedItem', 'restoreOwnedItem',
    'purgeRecycledItem', 'loadRecycledItem', 'listOwnedItems', 'listAllOwnedItems',
    'authorizeWorkspace', 'requireWorkspace', 'requireTenantAdmin',
    'isTenantAdmin', 'isTenantAdminTier', 'requireDomainRole', 'enforceCapability',
    // domain-tier / DLZ-pane / ops-admin gates: tenant-admin OR domain-admin
    // (canAccessDlzPanes / isAtLeastDomainAdmin) or a purpose-built ops-admin
    // role (callerIsOpsAdmin) — all real admin-tier authz, not a bare session.
    'canAccessDlzPanes', 'isAtLeastDomainAdmin', 'isAtLeastDomainContributor', 'callerIsOpsAdmin',
    'denyIfNoDlzAccess', 'pdpCheck', 'loadContentBackedItem',
    // ADX/KQL data-plane owner-checks: guardAdxRequest owner-checks the bound
    // kql-database item (session.claims.oid → loadKustoItem) + config gate;
    // loadKustoItem / resolveOwnedItemDatabase thread the caller tenant into
    // the item read the same way loadOwnedItem does.
    'guardAdxRequest', 'loadKustoItem', 'resolveOwnedItemDatabase',
    'claims\\.oid', 'claims\\.tid', 'claims\\.tenantId',
  ].join('|'),
);


const MUTATING_EXPORT_RE = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/;
const GET_EXPORT_RE = /export\s+async\s+function\s+GET\b/;
const GETSESSION_RE = /getSession\s*\(/;

// ── Allowlist: routes that legitimately need no per-resource authorization.
// Repo-relative POSIX paths. Each MUST carry a reason.
const ALLOWLIST = new Map([
  // Generic per-item handlers that operate on a SHARED Azure backend resolved
  // by item TYPE (warehouse/AOAI/etc.) — no per-tenant Cosmos ownership to
  // scope; gated by getSession + a type gate.
  ['apps/fiab-console/app/api/items/[type]/[id]/alerts/route.ts', 'analytics alerts over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/assist/route.ts', 'AOAI assist resolved by item type; no per-tenant Cosmos read'],
  ['apps/fiab-console/app/api/items/[type]/[id]/monitoring/route.ts', 'read-only monitoring over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/optimize/route.ts', 'optimize action over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/security/route.ts', 'security-scan over a shared Azure backend resolved by item-type gate'],
  ['apps/fiab-console/app/api/items/[type]/[id]/sql-security/route.ts', 'SQL security over a shared Azure backend resolved by item-type gate'],
  ['apps/fiab-console/app/api/items/[type]/[id]/statistics/route.ts', 'read-only statistics over a shared Azure backend resolved by item type'],

  // Admin routes gated by getSession + org-scoped Cosmos queries (every read
  // binds the caller tenant) or reading deployment-wide config only.
  ['apps/fiab-console/app/api/admin/bootstrap-catalogs/route.ts', 'seeds deployment-wide catalogs; org-scoped, admin surface'],
  ['apps/fiab-console/app/api/admin/copilot-usage/route.ts', 'tenant-scoped usage read; org aggregate'],
  ['apps/fiab-console/app/api/admin/data-products-backend/route.ts', 'deployment-wide backend config read'],
  ['apps/fiab-console/app/api/admin/deploy-plan/cost-estimate/route.ts', 'stateless cost estimator; no per-tenant data'],
  ['apps/fiab-console/app/api/admin/domains/images/route.ts', 'org-scoped domain image read'],
  ['apps/fiab-console/app/api/admin/domains/purview-status/route.ts', 'deployment-wide Purview status read'],
  ['apps/fiab-console/app/api/admin/load-sample-data/route.ts', 'loads sample data into the deployment ADX; admin surface'],
  ['apps/fiab-console/app/api/admin/mcp-servers/bridge/route.ts', 'deployment-wide MCP bridge config'],
  ['apps/fiab-console/app/api/admin/mcp-servers/builtin/route.ts', 'static built-in MCP catalog read'],
  ['apps/fiab-console/app/api/admin/mcp-servers/route.ts', 'admin gate + SSRF egress guard owned by sibling PR #1599 (requireTenantAdmin on POST/PUT); excluded here to avoid a merge conflict — remove this entry once #1599 lands'],
  ['apps/fiab-console/app/api/admin/mcp-servers/test-connection/route.ts', 'stateless connectivity probe; admin gate + egress guard owned by sibling PR #1599; no per-tenant data'],
  ['apps/fiab-console/app/api/admin/tenant-settings/groups/route.ts', 'ambient-tenant group read (Graph); tenant is from the token'],
]);

// ── Specific-per-item-TYPE routes over a SHARED Azure backend ────────────────
// These operate on a single deployment-shared Azure resource resolved by item
// TYPE + the id in the URL (a live ARM/data-plane resource id: cluster, SQL
// warehouse, ADX cluster, ADF factory, Databricks workspace, Power BI/AAS,
// Dataverse, APIM, …). Auth = signed-in + the deployment's Console-UAMI RBAC —
// there is NO per-tenant Cosmos ownership to scope, so getSession() + a type
// gate is the intended authorization. They are IN the widened scan scope but
// legitimately need no per-resource owner-check. Newly ADDED here as part of
// widening the checker to items/<type>/[id]/** — pre-existing routes, not the
// ones fixed in this change (data-agent/[id]/source-schema, activator/[id]/
// adx-source, map/[id]/geocode, adx/anomaly now pass on their own real gates).
// A NEW route under one of these type dirs that reads/mutates a per-tenant
// Cosmos item by [id] must thread loadOwnedItem / an admin gate — do NOT extend
// this list to cover an ownable route.
const SHARED_BACKEND_ITEM_ROUTES = [
  'apps/fiab-console/app/api/items/adf-dataset/[id]/route.ts',
  'apps/fiab-console/app/api/items/adf-pipeline/[id]/connections/route.ts',
  'apps/fiab-console/app/api/items/adf-trigger/[id]/route.ts',
  'apps/fiab-console/app/api/items/adf-trigger/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/[id]/predict/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/[id]/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/[id]/train/route.ts',
  'apps/fiab-console/app/api/items/ai-foundry-project/[id]/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/dag-runs/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/dags/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/task-logs/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/operations/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/revisions/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/spec/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/test-call/route.ts',
  'apps/fiab-console/app/api/items/apim-policy/[id]/route.ts',
  'apps/fiab-console/app/api/items/apim-product/[id]/apis/route.ts',
  'apps/fiab-console/app/api/items/apim-product/[id]/route.ts',
  'apps/fiab-console/app/api/items/apim-product/[id]/subscriptions/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/aad-admin/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/create-db/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/firewall/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/get-data/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/maintenance-configs/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/performance/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/principal-search/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/query/cancel/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/replication/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/scale/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/search-management/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/share/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/sql2025-features/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-server/[id]/databases/route.ts',
  'apps/fiab-console/app/api/items/compute/[id]/route.ts',
  'apps/fiab-console/app/api/items/compute/[id]/start/route.ts',
  'apps/fiab-console/app/api/items/compute/[id]/stop/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-action/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-agent/[id]/directline-token/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-agent/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-agent/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-analytics/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-channel/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-knowledge/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-topic/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-template-library/[id]/route.ts',
  'apps/fiab-console/app/api/items/copy-job/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/cosmos-db/[id]/gremlin/route.ts',
  'apps/fiab-console/app/api/items/cosmos-db/[id]/metrics/route.ts',
  'apps/fiab-console/app/api/items/cosmos-gremlin-graph/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/pin/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/tile-embed-token/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/tile-query/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/approval-logicapp/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/connections/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/debug/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/evaluate/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/integration-runtimes/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/jobs/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/output/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/triggers/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/validate/route.ts',
  'apps/fiab-console/app/api/items/data-product-template/[id]/instantiate/route.ts',
  'apps/fiab-console/app/api/items/data-product-template/[id]/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/[id]/events/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/[id]/libraries/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/[id]/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/databricks-job/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/databricks-job/[id]/run-output/route.ts',
  'apps/fiab-console/app/api/items/databricks-job/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/command/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/context/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/clone/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/create/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/ctas/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/delete/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/edit/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/iqy/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query-history/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query-profile/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/script-out/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/start/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/warehouses/route.ts',
  'apps/fiab-console/app/api/items/dataflow/[id]/refresh/route.ts',
  'apps/fiab-console/app/api/items/dataflow/[id]/route.ts',
  'apps/fiab-console/app/api/items/dataset/[id]/lineage/route.ts',
  'apps/fiab-console/app/api/items/dataset/[id]/preview/route.ts',
  'apps/fiab-console/app/api/items/dataset/[id]/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/business-rules/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/columns/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/keys/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/relationships/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/rows/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/views/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/check-compat/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/capacity/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/continuous-export/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/database/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/ingest/preview/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/ingest/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/journal/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/overview/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/policies/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/purge/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/route.ts',
  'apps/fiab-console/app/api/items/gql-graph/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/graph-model/[id]/materialize/route.ts',
  'apps/fiab-console/app/api/items/graph-model/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/graph-model/[id]/source-schema/route.ts',
  'apps/fiab-console/app/api/items/graphql-api/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/graphql-api/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/lakehouse/[id]/abfss/route.ts',
  'apps/fiab-console/app/api/items/lakehouse/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/logic-app/[id]/route.ts',
  'apps/fiab-console/app/api/items/logic-app/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/lifecycle/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/monitor/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/open-mirror/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/sql-endpoint/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/catalog/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/sql-endpoint/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/[id]/register/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/[id]/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/[id]/runs/[runId]/metrics/route.ts',
  'apps/fiab-console/app/api/items/mounted-adf/[id]/route.ts',
  'apps/fiab-console/app/api/items/mounted-adf/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/execute-spark/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/jobs/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/runs/[runId]/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/[id]/preview/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/[id]/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/databases/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/firewall/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/[id]/definition/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/[id]/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/power-page/[id]/route.ts',
  'apps/fiab-console/app/api/items/prompt-flow/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/release-environment/[id]/arm/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/paginated-embed-token/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/datasource/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/direct-lake/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/ingest/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/measures/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh-policy/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh-schedule/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refreshes/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/take-over/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/clone/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/query-history/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/resume/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/script-out/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/synapse-notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/synapse-pipeline/[id]/connections/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/iqy/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/objects/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/auto-pause/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/config/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/scale/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/submit/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/geo/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/link/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/timeline/route.ts',
  'apps/fiab-console/app/api/items/user-data-function/[id]/invoke/route.ts',
  'apps/fiab-console/app/api/items/vector-store/[id]/index/route.ts',
  'apps/fiab-console/app/api/items/vector-store/[id]/search/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/iqy/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/query-acceleration/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/script-out/route.ts',
];
// ── Routes that USED to be allowlisted as "shared backend / no ownership to
// scope" but actually read/write a per-tenant Cosmos item by a caller-supplied
// (id, workspaceId) — the exact cross-tenant hole this checker exists for.
// They were fixed in the rel-T17 sweep to thread `assertOwner(workspaceId,
// oid)` (or an equivalent owner check), so they now carry a real guard signal
// and PASS on their own. They are listed here so they are EXCLUDED from every
// allowlist below — if a future edit drops the guard, the checker re-flags them
// instead of silently masking the regression.
const NOW_GUARDED = new Set([
  // data-pipeline (reads the per-tenant item to resolve its ADF backing)
  'apps/fiab-console/app/api/items/data-pipeline/[id]/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/approval-logicapp/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/debug/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/evaluate/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/integration-runtimes/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/jobs/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/output/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/triggers/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/validate/route.ts',
  // mirrored-database / mirrored-databricks
  'apps/fiab-console/app/api/items/mirrored-database/[id]/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/lifecycle/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/monitor/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/open-mirror/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/sql-endpoint/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/catalog/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/sql-endpoint/route.ts',
  // logic-app / mounted-adf / notebook family / dataflow / event-schema-set
  'apps/fiab-console/app/api/items/logic-app/[id]/route.ts',
  'apps/fiab-console/app/api/items/logic-app/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/mounted-adf/[id]/route.ts',
  'apps/fiab-console/app/api/items/mounted-adf/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/execute-spark/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/jobs/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/runs/[runId]/route.ts',
  'apps/fiab-console/app/api/items/synapse-notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/dataflow/[id]/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/check-compat/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/versions/route.ts',
  // semantic-model (per-tenant DQ source read/write), airflow-job, activator
  'apps/fiab-console/app/api/items/semantic-model/[id]/datasource/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/ingest/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/model/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/dag-runs/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/dags/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/task-logs/route.ts',
  'apps/fiab-console/app/api/items/activator/[id]/rules/route.ts',
  'apps/fiab-console/app/api/items/activator/[id]/start/route.ts',
  'apps/fiab-console/app/api/items/activator/[id]/stop/route.ts',
  'apps/fiab-console/app/api/items/lakehouse-shortcut/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/practice-seed/route.ts',
  // non-items routes fixed in the same sweep
  'apps/fiab-console/app/api/aml/environments/route.ts',
  'apps/fiab-console/app/api/notebook/[id]/assist/route.ts',
  'apps/fiab-console/app/api/experience/warp/transforms/route.ts',
  'apps/fiab-console/app/api/governance/scans/route.ts',
  'apps/fiab-console/app/api/governance/scans/register-existing/route.ts',
]);

for (const p of SHARED_BACKEND_ITEM_ROUTES) {
  if (NOW_GUARDED.has(p)) continue; // now carries a real owner-check — not allowlisted
  if (!ALLOWLIST.has(p)) {
    ALLOWLIST.set(
      p,
      'specific-per-item-TYPE route over a SHARED Azure backend resolved by item type (auth = signed-in + deployment RBAC); no per-tenant Cosmos ownership to scope',
    );
  }
}

// ── rel-T17: item-TYPE-level list/create + shared sub-collection routes surfaced
// by widening the scan to all of app/api. Each of these talks to a SHARED Azure
// backend (Power BI / AI Foundry / ADF / APIM / Databricks / Stream Analytics /
// Power Platform / ARM by name) — NOT a per-tenant Cosmos partition — so
// getSession()+deployment-RBAC is the intended authz (list/create that DO write
// per-tenant Cosmos go through createOwnedItem/listOwnedItems and pass on their
// own signal). NB: `?workspaceId=` on the Power BI routes (dashboard,
// paginated-report, semantic-model/build) is a Power BI workspace id, not a Loom
// Cosmos partition — an assertOwner check would be wrong there.
const SHARED_BACKEND_TYPE_ROUTES = [
  'apps/fiab-console/app/api/items/adf-dataset/route.ts',
  'apps/fiab-console/app/api/items/adf-pipeline/route.ts',
  'apps/fiab-console/app/api/items/adf-trigger/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/route.ts',
  'apps/fiab-console/app/api/items/ai-foundry-project/route.ts',
  'apps/fiab-console/app/api/items/ai-search-index/route.ts',
  'apps/fiab-console/app/api/items/apim-api/route.ts',
  'apps/fiab-console/app/api/items/apim-policy/route.ts',
  'apps/fiab-console/app/api/items/apim-product/route.ts',
  'apps/fiab-console/app/api/items/automl/jobs/route.ts',
  'apps/fiab-console/app/api/items/automl/jobs/[name]/route.ts',
  'apps/fiab-console/app/api/items/automl/options/route.ts',
  'apps/fiab-console/app/api/items/automl/submit/route.ts',
  'apps/fiab-console/app/api/items/compute/route.ts',
  'apps/fiab-console/app/api/items/content-safety/blocklists/items/route.ts',
  'apps/fiab-console/app/api/items/content-safety/blocklists/route.ts',
  'apps/fiab-console/app/api/items/content-safety/rai-policies/route.ts',
  'apps/fiab-console/app/api/items/content-safety/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-action/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-agent/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-channel/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-knowledge/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-topic/route.ts',
  'apps/fiab-console/app/api/items/copilot-template-library/route.ts',
  'apps/fiab-console/app/api/items/dashboard/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/options/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/route.ts',
  'apps/fiab-console/app/api/items/databricks-job/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/list/route.ts',
  'apps/fiab-console/app/api/items/dataflow/config/route.ts',
  'apps/fiab-console/app/api/items/dataflow/profile/route.ts',
  'apps/fiab-console/app/api/items/dataset/browse/route.ts',
  'apps/fiab-console/app/api/items/dataset/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/route.ts',
  'apps/fiab-console/app/api/items/evaluation/route.ts',
  'apps/fiab-console/app/api/items/event-grid-topic/route.ts',
  'apps/fiab-console/app/api/items/event-hubs-namespace/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/source-tables/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/verify/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/catalogs/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/submit/route.ts',
  'apps/fiab-console/app/api/items/ml-model/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/capabilities/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/route.ts',
  'apps/fiab-console/app/api/items/power-app/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/route.ts',
  'apps/fiab-console/app/api/items/power-page/route.ts',
  'apps/fiab-console/app/api/items/prompt-flow/route.ts',
  'apps/fiab-console/app/api/items/rayfin-app/model-objects/route.ts',
  'apps/fiab-console/app/api/items/rayfin-app/models/route.ts',
  'apps/fiab-console/app/api/items/rayfin-app/preview/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/aas-databases/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/build/route.ts',
  'apps/fiab-console/app/api/items/service-bus-namespace/data-explorer/route.ts',
  'apps/fiab-console/app/api/items/service-bus-namespace/route.ts',
  'apps/fiab-console/app/api/items/sql-databases/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/inputs/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/metrics/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/outputs/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/query/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/state/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/test/route.ts',
  'apps/fiab-console/app/api/items/synapse-pipeline/list/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/list/route.ts',
  'apps/fiab-console/app/api/items/tracing/route.ts',
  'apps/fiab-console/app/api/items/tracing/[traceId]/route.ts',
];
for (const p of SHARED_BACKEND_TYPE_ROUTES) {
  if (NOW_GUARDED.has(p)) continue;
  if (!ALLOWLIST.has(p)) {
    ALLOWLIST.set(
      p,
      'item-TYPE-level list/create or shared sub-collection over a SHARED Azure backend (PBI/Foundry/ADF/APIM/Databricks/ASA/Power Platform/ARM by name); no per-tenant Cosmos partition to scope',
    );
  }
}

// ── rel-T17: remaining non-items session-only-safe routes surfaced by the wider
// scan (per-route so each carries its own honest reason).
for (const [p, reason] of [
  ['apps/fiab-console/app/api/data-products/import/template/route.ts', 'imports a data product from a shared template definition; no per-tenant Cosmos read'],
  ['apps/fiab-console/app/api/data-products/[id]/policies/route.ts', 'consumer-discovery: returns the owner\'s Access-policy purposes for the Request-access dialog (documented cross-tenant read, read-only, non-sensitive)'],
  ['apps/fiab-console/app/api/data-products/[id]/preview/route.ts', 'consumer-discovery: read-only 25-row preview of a discoverable data product (documented, mirrors GET /api/data-products/[id])'],
  ['apps/fiab-console/app/api/governance/classifications/system/route.ts', 'read-only deployment-wide system classification catalog (static)'],
  ['apps/fiab-console/app/api/governance/dlp/schemas/route.ts', 'read-only DLP schema listing over the shared warehouse'],
  ['apps/fiab-console/app/api/governance/purview/status/route.ts', 'read-only deployment-wide Purview status'],
  ['apps/fiab-console/app/api/governance/pdp-mode/route.ts', 'read-only deployment-wide PDP enforcement-mode indicator (non-sensitive LOOM_PDP_ENFORCE value)'],
  ['apps/fiab-console/app/api/marketplace/catalog/route.ts', 'read-only deployment-wide marketplace catalog listing'],
  ['apps/fiab-console/app/api/marketplace/gate/route.ts', 'marketplace entitlement gate check; deployment-wide'],
  ['apps/fiab-console/app/api/marketplace/subscriptions/route.ts', 'APIM subscription list/create over the deployment APIM gateway via Console UAMI (shared backend, same class as /api/apim)'],
  ['apps/fiab-console/app/api/marketplace/subscriptions/[sid]/route.ts', 'APIM subscription detail over the deployment APIM gateway via Console UAMI (shared backend)'],
  ['apps/fiab-console/app/api/marketplace/subscriptions/[sid]/keys/route.ts', 'APIM subscription keys over the deployment APIM gateway via Console UAMI (shared backend)'],
  ['apps/fiab-console/app/api/marketplace/subscriptions/[sid]/keys/regenerate/route.ts', 'APIM subscription key regenerate over the deployment APIM gateway via Console UAMI (shared backend)'],
]) {
  if (!ALLOWLIST.has(p)) ALLOWLIST.set(p, reason);
}

// ── Group-level allowlist: whole app/api sub-trees whose ENTIRE membership is
// session-only-safe by construction, so widening the scan to all of app/api
// doesn't require one line per route. Each prefix carries the CLASS reason it's
// safe. A route under a prefix is allowed UNLESS it's in NOW_GUARDED (a fixed
// per-tenant route that must keep passing on its own owner-check). The three
// safe classes:
//   (A) Shared Azure-backend "service navigators" — every handler operates on
//       the deployment's single Azure resource resolved by an ARM/data-plane
//       name via the Console UAMI's RBAC; there is NO per-tenant Cosmos
//       partition to cross, so getSession()+deployment-RBAC IS the intended
//       authz (same class as SHARED_BACKEND_ITEM_ROUTES, one dir up).
//   (B) Session-scoped Cosmos stores — the handler threads the session object
//       into a store helper that partitions every read/write by the caller's
//       oid; no id from the URL can escape the caller's partition.
//   (C) Global read-only metadata — deployment-wide catalog/config/static data
//       with no per-tenant rows (or an external catalog like Purview/Unity).
const ALLOWLIST_PREFIXES = [
  // (A) shared Azure-backend service navigators
  ['apps/fiab-console/app/api/adf/', 'A: ADF factory navigator over the deployment ADF via Console UAMI'],
  ['apps/fiab-console/app/api/ai-search/', 'A: Azure AI Search navigator over the deployment search service'],
  ['apps/fiab-console/app/api/aml/', 'A: Azure ML navigator over the deployment AML workspace (ARM/data-plane by name)'],
  ['apps/fiab-console/app/api/apim/', 'A: APIM navigator over the deployment APIM instance'],
  ['apps/fiab-console/app/api/azure/', 'A: generic Azure resource navigator (ARM by name)'],
  ['apps/fiab-console/app/api/business-events/', 'A: Event Grid/Event Hubs business-events over the deployment namespace'],
  ['apps/fiab-console/app/api/databricks/', 'A: Databricks navigator over the deployment workspace (REST by id)'],
  ['apps/fiab-console/app/api/deployment-pipelines/', 'A: Fabric/ARM deployment-pipelines over the deployment; resolved by pipeline id via Console UAMI'],
  ['apps/fiab-console/app/api/eventhubs/', 'A: Event Hubs navigator over the deployment namespace'],
  ['apps/fiab-console/app/api/fabric/', 'A: Fabric REST navigator (opt-in); resolved by workspace/item id via Console UAMI'],
  ['apps/fiab-console/app/api/foundry/', 'A: AI Foundry navigator over the deployment Foundry hub (ARM/data-plane by name)'],
  ['apps/fiab-console/app/api/lakehouse/', 'A: ADLS Gen2 lakehouse navigator over the deployment storage (container validated; single shared lake)'],
  ['apps/fiab-console/app/api/marketplace/sharing/', 'A: Delta Sharing / provider navigator over the deployment sharing backend'],
  ['apps/fiab-console/app/api/messaging/', 'A: Service Bus/messaging metrics over the deployment namespace'],
  ['apps/fiab-console/app/api/monitor/', 'A: Azure Monitor navigator over the deployment (Log Analytics/metrics/alerts by resource)'],
  ['apps/fiab-console/app/api/network/', 'A: networking navigator over the deployment (PE/VNet/VPN by resource)'],
  ['apps/fiab-console/app/api/onelake/', 'A: OneLake/ADLS navigator over the deployment storage'],
  ['apps/fiab-console/app/api/powerbi/', 'A: Power BI REST navigator (opt-in) via the Console service principal'],
  ['apps/fiab-console/app/api/powerplatform/', 'A: Power Platform navigator over the deployment environments via the PP management app'],
  ['apps/fiab-console/app/api/realtime-hub/', 'A: Real-Time hub navigator over the deployment Event Hubs/ADX'],
  ['apps/fiab-console/app/api/setup/', 'A: first-run setup/scan over ARM (subscription/topology discovery) via Console UAMI'],
  ['apps/fiab-console/app/api/storage/', 'A: storage-accounts navigator over the deployment subscription (ARM by name)'],
  ['apps/fiab-console/app/api/synapse/', 'A: Synapse artifacts navigator over the deployment workspace (data-plane by name)'],
  ['apps/fiab-console/app/api/warehouse/', 'A: Synapse SQL warehouse query navigator over the deployment pool'],
  ['apps/fiab-console/app/api/dab/', 'A: Data API Builder — create threads createOwnedItem; [id] routes publish to the shared DAB runtime + APIM by id (no per-tenant Cosmos read)'],
  ['apps/fiab-console/app/api/data-agent/', 'A: data-agent chat over the deployment AOAI + ADX'],
  ['apps/fiab-console/app/api/org-reports/', 'A: org-wide report renderer over deployment-scoped aggregates'],
  ['apps/fiab-console/app/api/loom/', 'A: Loom compute-target/capacity/SHIR navigators resolve a shared Azure resource by ARM name via Console UAMI'],
  ['apps/fiab-console/app/api/notebook/', 'A: notebook Livy/LSP/session navigator over the shared Synapse/Databricks compute (per-tenant [id]/assist is in NOW_GUARDED)'],
  // (B) session-scoped Cosmos stores
  ['apps/fiab-console/app/api/connections/', 'B: connections-store partitions every read/write by session.claims.oid'],
  ['apps/fiab-console/app/api/thread/', 'B: thread-edges store scoped to the caller session'],
  // (C) global read-only metadata / external catalog
  ['apps/fiab-console/app/api/catalog/', 'C: federated catalog metadata over external Purview/Unity/Fabric (no per-tenant Cosmos rows)'],
  ['apps/fiab-console/app/api/copilot/', 'C: read-only Copilot tool-catalog metadata'],
  ['apps/fiab-console/app/api/cosmos/', 'C: Cosmos rerank utility over deployment config (no per-tenant item read by id)'],
  ['apps/fiab-console/app/api/help-copilot/', 'C: help index reindex over deployment-wide help content'],
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      walk(full, out);
    } else if (e.name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

function rel(f) {
  return path.relative(REPO_ROOT, f).split(path.sep).join('/');
}

/** A flagged route is intentionally session-only when it's on the per-route
 *  ALLOWLIST, OR under an ALLOWLIST_PREFIXES class — but a NOW_GUARDED route
 *  (a fixed per-tenant hole) is NEVER allowlisted, so if its owner-check ever
 *  regresses the checker re-flags it. */
function isAllowed(r) {
  if (NOW_GUARDED.has(r)) return false;
  if (ALLOWLIST.has(r)) return true;
  for (const [prefix] of ALLOWLIST_PREFIXES) if (r.startsWith(prefix)) return true;
  return false;
}

function main() {
  // Widened (rel-T17): scan EVERY route under app/api, not just items/admin/adx.
  // The class-based ALLOWLIST_PREFIXES keep the legit session-only groups green.
  const files = walk(API_ROOT);
  const seen = new Set();
  const uniqueFiles = files.filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
  const violations = [];
  let scanned = 0;
  let allowlistedHits = 0;

  for (const f of uniqueFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const hasMutating = MUTATING_EXPORT_RE.test(src);
    const hasGet = GET_EXPORT_RE.test(src);
    if (!hasMutating && !hasGet) continue; // no data surface to guard
    if (!GETSESSION_RE.test(src)) continue; // not session-based; out of this check's remit
    scanned++;
    if (GUARD_SIGNAL_RE.test(src)) continue; // authorized (owner/tenant/admin check present)
    const r = rel(f);
    if (isAllowed(r)) { allowlistedHits++; continue; } // intentional shared/session/self route
    violations.push(r);
  }

  console.log(`[route-guards] scanned ${scanned} session-based routes across app/api`);
  console.log(`[route-guards] allowlisted intentional routes hit: ${allowlistedHits} (${ALLOWLIST.size} per-route + ${ALLOWLIST_PREFIXES.length} class prefixes)`);
  console.log(`[route-guards] violations: ${violations.length}`);
  if (violations.length) {
    console.error('\n[route-guards] FAIL — these routes are gated only by getSession() with no');
    console.error('owner/tenant/admin authorization (potential cross-tenant access):');
    for (const v of violations) console.error(`  - ${v}`);
    console.error('\nFix: thread `loadOwnedItem(id, type, session.claims.oid)` (item routes) or an');
    console.error('admin gate (`requireTenantAdmin` / `isTenantAdmin` / `enforceCapability`) so the');
    console.error('caller is authorized against the specific resource. If the route legitimately');
    console.error('needs no per-resource check (shared Azure backend resolved by type, or a self/');
    console.error('public endpoint), add it to ALLOWLIST in scripts/ci/check-route-guards.mjs with a reason.');
    process.exit(1);
  }
  console.log('[route-guards] OK — every session-based item/admin route is authorized or allowlisted.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
