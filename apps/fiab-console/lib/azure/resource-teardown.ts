/**
 * Workspace-delete CASCADE — Azure backend teardown.
 *
 * When a workspace (or a bulk selection) is deleted with `?cascade=true`, the
 * user has chosen to DELETE the underlying Azure data/services the workspace's
 * items provisioned — not just de-catalog them. This module maps each item type
 * to the EXISTING teardown client for its Azure-native backend and calls it,
 * best-effort, per resource.
 *
 * Design invariants:
 *   - Best-effort, NEVER throws. Every per-resource delete is wrapped in a
 *     try/catch and classified (deleted / not_found / skipped / error) so one
 *     failing resource can't sink the workspace delete or its siblings.
 *   - SERIAL iteration (not Promise.all) so we don't hammer ARM/Kusto/ADLS with
 *     a burst of concurrent deletes (throttling → false errors).
 *   - Azure-native by DEFAULT (.claude/rules/no-fabric-dependency.md). Fabric /
 *     Power BI-backed items (backend==='fabric'/'powerbi', or a bound
 *     fabricWorkspaceId/powerbiWorkspaceId) are SKIPPED with an honest note —
 *     their objects live in the opt-in Fabric/PBI workspace, not in the
 *     Azure-native estate this cascade owns.
 *
 * Backend refs are read from the item's real state (`state.provisioning`, the
 * shape stamped by the install engine: `{ status, resourceId, secondaryIds }`),
 * plus any top-level state keys individual provisioners write back (eventstream
 * → state.transportHub/asaJobName, activator → state.rules[].azureRuleName,
 * kql → state.databaseName). When a backend id isn't recorded, we fall back to
 * the deterministic naming each provisioner used at install time.
 */

import { deletePath } from '@/lib/azure/adls-client';
import {
  deleteDedicatedSqlPool,
  deletePipeline as synapseDeletePipeline,
} from '@/lib/azure/synapse-dev-client';
import { deleteKustoDatabase } from '@/lib/azure/kusto-arm-client';
import { deleteEventHub } from '@/lib/azure/eventhubs-client';
import { deleteStreamingJob } from '@/lib/azure/stream-analytics-client';
import { deleteMonitorActivatorRule } from '@/lib/azure/activator-monitor';
import { deletePipeline as adfDeletePipeline, deleteAdfCdc } from '@/lib/azure/adf-client';
import {
  deleteUcCatalog,
  deleteJob as dbxDeleteJob,
  deleteWarehouse as dbxDeleteWarehouse,
  permanentDeleteCluster,
  deleteWorkspaceObject,
  deleteRegisteredModel,
  deleteServingEndpoint,
} from '@/lib/azure/databricks-client';
import { deleteNotebook as synapseDeleteNotebook } from '@/lib/azure/synapse-artifacts-client';
import { deleteIndex } from '@/lib/azure/search-index-client';
import { deletePromptFlow } from '@/lib/azure/foundry-client';
import { executeQuery as synapseExec, serverlessTarget } from '@/lib/azure/synapse-sql-client';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type TeardownResourceStatus = 'deleted' | 'not_found' | 'skipped' | 'error';

export interface TeardownResourceResult {
  /** What kind of Azure resource (e.g. 'adls-path', 'adx-database'). */
  kind: string;
  /** Human-readable ref for the resource (name / path / id). */
  ref: string;
  result: TeardownResourceStatus;
  /** Error message (result==='error') or the reason a resource was skipped. */
  error?: string;
}

export interface TeardownOutcome {
  itemId: string;
  itemType: string;
  displayName: string;
  resources: TeardownResourceResult[];
}

/** Minimal item shape the teardown needs (a full Cosmos item doc, state included). */
export interface TeardownItem {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName?: string;
  state?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// State-reading helpers
// ---------------------------------------------------------------------------

interface ProvRecord {
  status?: string;
  resourceId?: string;
  secondaryIds?: Record<string, string>;
}

function provRecord(item: TeardownItem): ProvRecord {
  const p = (item.state as any)?.provisioning;
  return p && typeof p === 'object' ? (p as ProvRecord) : {};
}

/** A provisioning secondaryId value (trimmed) or undefined. */
function sid(item: TeardownItem, key: string): string | undefined {
  const v = provRecord(item).secondaryIds?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** A top-level state key value (string, trimmed) or undefined. */
function st(item: TeardownItem, key: string): string | undefined {
  const v = (item.state as any)?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function resourceId(item: TeardownItem): string | undefined {
  const v = provRecord(item).resourceId;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function backendOf(item: TeardownItem): string | undefined {
  return sid(item, 'backend') || st(item, 'backend');
}

/** Reproduce the provisioners' safe path/name sanitiser (adls safeRelPath). */
function safeName(s: string | undefined): string {
  return String(s || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/** Parse an abfss URL (abfss://container@host/path) into {container, path}. */
function parseAbfss(url: string): { container: string; path: string } | null {
  const m = /^abfss:\/\/([^@/]+)@[^/]+\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  return { container: m[1], path: m[2].replace(/\/+$/, '') };
}

/**
 * Run one delete, classifying the outcome. Never throws. A 404 / "not found" /
 * "does not exist" is reported as `not_found` (already gone — an idempotent
 * success for teardown), any other failure as `error` with the message.
 */
async function attempt(
  kind: string,
  ref: string,
  fn: () => Promise<unknown>,
): Promise<TeardownResourceResult> {
  try {
    await fn();
    return { kind, ref, result: 'deleted' };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/\b404\b|not[\s_-]?found|does not exist|no such/i.test(msg)) {
      return { kind, ref, result: 'not_found' };
    }
    return { kind, ref, result: 'error', error: msg.slice(0, 300) };
  }
}

function skip(kind: string, ref: string, reason: string): TeardownResourceResult {
  return { kind, ref, result: 'skipped', error: reason };
}

// ---------------------------------------------------------------------------
// Per-item teardown
// ---------------------------------------------------------------------------

/**
 * Tear down the Azure backend(s) a single item provisioned. Returns a per-item
 * receipt of every resource touched. Never throws.
 */
export async function teardownItemBackend(
  item: TeardownItem,
  tenantId: string,
): Promise<TeardownOutcome> {
  const type = item.itemType;
  const displayName = item.displayName || item.id;
  const resources: TeardownResourceResult[] = [];
  const push = (r: TeardownResourceResult) => resources.push(r);
  const be = backendOf(item);
  const sids = provRecord(item).secondaryIds || {};

  // Fabric / Power BI-backed (opt-in) items: their backend object lives in the
  // Fabric/PBI workspace — the Azure-native cascade does not own it. Skip with
  // an honest note (no-fabric-dependency.md: never REQUIRE Fabric to run).
  if (
    be === 'fabric' ||
    be === 'powerbi' ||
    be === 'powerbi-push' ||
    sids.fabricWorkspaceId ||
    sids.powerbiWorkspaceId
  ) {
    push(
      skip(
        type,
        resourceId(item) || sids.fabricWorkspaceId || sids.powerbiWorkspaceId || '(fabric/powerbi)',
        'Fabric / Power BI-backed (opt-in) item — its backend object lives in the Fabric / Power BI workspace and is not torn down by the Azure-native cascade. Remove it in that workspace if desired.',
      ),
    );
    return { itemId: item.id, itemType: type, displayName, resources };
  }

  switch (type) {
    // --- Lakehouse → ADLS Gen2 Delta tree (+ Synapse OPENROWSET views) --------
    case 'lakehouse': {
      const rid = resourceId(item); // "<container>/<root>" on the azure-native path
      const container =
        sid(item, 'container') || (rid && rid.includes('/') ? rid.split('/')[0] : undefined);
      const rootPath =
        sid(item, 'rootPath') ||
        (rid && rid.includes('/') ? rid.split('/').slice(1).join('/') : undefined) ||
        `lakehouses/${safeName(displayName) || item.id}`;
      if (container) {
        push(
          await attempt('adls-path', `${container}/${rootPath}`, () =>
            deletePath(container, `${rootPath.replace(/\/+$/, '')}/`, true),
          ),
        );
      } else {
        push(skip('adls-path', rootPath, 'No ADLS container recorded on the item state; data left in place.'));
      }
      // Best-effort: drop the Synapse serverless OPENROWSET views this lakehouse
      // registered (state.provisioning.secondaryIds.synapseViews = "a,b,c").
      const views = sid(item, 'synapseViews');
      if (views && process.env.LOOM_SYNAPSE_WORKSPACE) {
        const db = (process.env.LOOM_SYNAPSE_LAKEHOUSE_DB || 'loom_lakehouse').replace(/[^A-Za-z0-9_]/g, '_');
        const target = serverlessTarget(db);
        for (const v of views.split(',').map((x) => x.trim()).filter(Boolean)) {
          push(
            await attempt('synapse-view', `${db}.${v}`, () =>
              synapseExec(target, `IF OBJECT_ID('${escapeSqlLiteral(v)}','V') IS NOT NULL DROP VIEW ${v};`),
            ),
          );
        }
      }
      break;
    }

    // --- Warehouse → Synapse dedicated SQL pool -------------------------------
    // The warehouse's tables live INSIDE the shared dedicated SQL pool
    // (LOOM_SYNAPSE_DEDICATED_POOL). Deleting that pool would destroy every
    // sibling warehouse, so when the recorded database IS the shared pool we
    // retain it (honest skip). A per-item dedicated pool (name != shared pool)
    // is deleted outright.
    case 'warehouse': {
      const db = sid(item, 'database');
      const shared = process.env.LOOM_SYNAPSE_DEDICATED_POOL;
      if (!db) {
        push(skip('synapse-dedicated-sql-pool', '(unknown)', 'No dedicated SQL pool recorded on the item state.'));
      } else if (shared && db === shared) {
        push(
          skip(
            'synapse-dedicated-sql-pool',
            db,
            'Warehouse tables live in the SHARED dedicated SQL pool (LOOM_SYNAPSE_DEDICATED_POOL); deleting the pool would destroy sibling warehouses. Pool retained.',
          ),
        );
      } else {
        push(await attempt('synapse-dedicated-sql-pool', db, () => deleteDedicatedSqlPool(db)));
      }
      break;
    }

    // --- KQL database / Eventhouse → ADX database -----------------------------
    case 'kql-database':
    case 'eventhouse': {
      const db = sid(item, 'database') || st(item, 'databaseName') || resourceId(item);
      if (db) {
        // Deleting the ADX database drops its tables + any child data connections.
        push(await attempt('adx-database', db, () => deleteKustoDatabase(db)));
      } else {
        push(skip('adx-database', '(unknown)', 'No ADX database recorded on the item state.'));
      }
      break;
    }

    // --- Eventstream → Event Hub (+ Stream Analytics transform job) -----------
    case 'eventstream': {
      const hub = st(item, 'transportHub') || sid(item, 'eventHub') || resourceId(item);
      if (hub) {
        // transportHub / eventHub are the hub NAME; ehId is the ARM id — take the leaf.
        const hubName = hub.includes('/') ? hub.split('/').pop()! : hub;
        push(await attempt('event-hub', hubName, () => deleteEventHub(hubName)));
      } else {
        push(skip('event-hub', '(unknown)', 'No Event Hub recorded on the item state.'));
      }
      const asaJob = st(item, 'asaJobName') || sid(item, 'asaJobName');
      if (asaJob) {
        push(await attempt('stream-analytics-job', asaJob, () => deleteStreamingJob(asaJob)));
      }
      break;
    }

    // --- Activator → Azure Monitor scheduled-query alert rule(s) --------------
    case 'activator': {
      const rules = (item.state as any)?.rules;
      const names: string[] = Array.isArray(rules)
        ? rules.map((r: any) => r?.azureRuleName).filter((n: any) => typeof n === 'string' && n)
        : [];
      const rid = resourceId(item); // last authored azureRuleName
      if (names.length === 0 && rid) names.push(rid);
      if (names.length === 0) {
        push(skip('monitor-alert-rule', '(unknown)', 'No Azure Monitor alert rules recorded on the item state.'));
      }
      for (const name of names) {
        push(await attempt('monitor-alert-rule', name, () => deleteMonitorActivatorRule(name)));
      }
      break;
    }

    // --- Pipelines → Synapse / ADF pipeline -----------------------------------
    case 'synapse-pipeline': {
      const name = sid(item, 'pipelineName') || st(item, 'pipelineName') || resourceId(item);
      if (name) push(await attempt('synapse-pipeline', name, () => synapseDeletePipeline(name)));
      else push(skip('synapse-pipeline', '(unknown)', 'No pipeline name recorded on the item state.'));
      break;
    }
    case 'adf-pipeline': {
      const name = sid(item, 'pipelineName') || st(item, 'pipelineName') || resourceId(item);
      if (name) push(await attempt('adf-pipeline', name, () => adfDeletePipeline(name)));
      else push(skip('adf-pipeline', '(unknown)', 'No pipeline name recorded on the item state.'));
      break;
    }
    case 'data-pipeline': {
      const name = sid(item, 'pipelineName') || st(item, 'pipelineName') || resourceId(item);
      if (!name) {
        push(skip('data-pipeline', '(unknown)', 'No pipeline name recorded on the item state.'));
      } else if (be === 'adf') {
        push(await attempt('adf-pipeline', name, () => adfDeletePipeline(name)));
      } else {
        push(await attempt('synapse-pipeline', name, () => synapseDeletePipeline(name)));
      }
      break;
    }

    // --- Mirrored database → ADF CDC pipeline + Bronze Delta tree --------------
    case 'mirrored-database': {
      const pipeline = sid(item, 'pipeline') || resourceId(item);
      if (pipeline) push(await attempt('adf-cdc-pipeline', pipeline, () => deleteAdfCdc(pipeline)));
      else push(skip('adf-cdc-pipeline', '(unknown)', 'No CDC pipeline recorded on the item state.'));
      // The mirror engine lands each table under bronze/mirrors/<ws>/<itemId>/…
      push(
        await attempt('adls-path', `bronze/mirrors/${item.workspaceId}/${item.id}`, () =>
          deletePath('bronze', `mirrors/${item.workspaceId}/${item.id}/`, true),
        ),
      );
      break;
    }

    // --- Mirrored Databricks → Unity Catalog catalog --------------------------
    case 'mirrored-databricks': {
      const cat = resourceId(item) || sid(item, 'catalog') || sid(item, 'catalogName');
      if (cat) push(await attempt('databricks-uc-catalog', cat, () => deleteUcCatalog(cat, true)));
      else push(skip('databricks-uc-catalog', '(unknown)', 'No UC catalog recorded on the item state.'));
      break;
    }

    // --- Databricks job -------------------------------------------------------
    case 'databricks-job': {
      const jobId = sid(item, 'jobId') || resourceId(item);
      if (jobId && /^\d+$/.test(jobId)) {
        push(await attempt('databricks-job', jobId, () => dbxDeleteJob(Number(jobId))));
      } else {
        push(skip('databricks-job', jobId || '(unknown)', 'No numeric Databricks job id recorded on the item state.'));
      }
      break;
    }

    // --- Databricks SQL warehouse ---------------------------------------------
    case 'databricks-sql-warehouse': {
      const id = st(item, 'warehouseId') || sid(item, 'warehouseId') || resourceId(item) || st(item, 'id');
      if (id) push(await attempt('databricks-sql-warehouse', id, () => dbxDeleteWarehouse(id)));
      else push(skip('databricks-sql-warehouse', '(unknown)', 'No SQL warehouse id recorded on the item state.'));
      break;
    }

    // --- Databricks cluster ---------------------------------------------------
    case 'databricks-cluster': {
      const cid = st(item, 'clusterId') || sid(item, 'clusterId') || resourceId(item);
      if (cid) push(await attempt('databricks-cluster', cid, () => permanentDeleteCluster(cid)));
      else push(skip('databricks-cluster', '(unknown)', 'No cluster id recorded on the item state.'));
      break;
    }

    // --- Databricks notebook --------------------------------------------------
    case 'databricks-notebook': {
      const path = sid(item, 'notebookPath') || st(item, 'notebookPath') || resourceId(item);
      if (path && !/^\d+$/.test(path)) {
        push(await attempt('databricks-notebook', path, () => deleteWorkspaceObject(path, true)));
      } else {
        push(skip('databricks-notebook', path || '(unknown)', 'No Databricks notebook path recorded on the item state.'));
      }
      break;
    }

    // --- Notebook (synapse or databricks backend) -----------------------------
    case 'notebook': {
      if (be === 'synapse') {
        const name = sid(item, 'synapseNotebook');
        if (name) push(await attempt('synapse-notebook', name, () => synapseDeleteNotebook(name)));
        else push(skip('synapse-notebook', '(unknown)', 'No Synapse notebook name recorded on the item state.'));
      } else if (be === 'databricks') {
        const path = sid(item, 'databricksPath');
        if (path) push(await attempt('databricks-notebook', path, () => deleteWorkspaceObject(path, true)));
        else push(skip('databricks-notebook', '(unknown)', 'No Databricks notebook path recorded on the item state.'));
      } else {
        push(skip('notebook', resourceId(item) || '(none)', 'Notebook has no recorded Azure backend (catalog-only).'));
      }
      break;
    }

    // --- ML model → UC/MLflow registered model (+ serving endpoint) -----------
    case 'ml-model': {
      const model = sid(item, 'modelName') || safeName(displayName) || item.id;
      push(await attempt('databricks-registered-model', model, () => deleteRegisteredModel(model)));
      // Best-effort: a matching serving endpoint (may not exist → not_found).
      push(await attempt('databricks-serving-endpoint', model, () => deleteServingEndpoint(model)));
      break;
    }

    // --- Materialized lake view → Delta tree ----------------------------------
    case 'materialized-lake-view': {
      const deltaUrl = sid(item, 'deltaUrl') || resourceId(item);
      const parsed = deltaUrl ? parseAbfss(deltaUrl) : null;
      if (parsed) {
        push(
          await attempt('adls-path', `${parsed.container}/${parsed.path}`, () =>
            deletePath(parsed.container, `${parsed.path}/`, true),
          ),
        );
      } else {
        push(skip('adls-path', deltaUrl || '(unknown)', 'Could not resolve the MLV Delta path from the item state.'));
      }
      break;
    }

    // --- AI Search index ------------------------------------------------------
    case 'ai-search-index': {
      const idx = resourceId(item) || st(item, 'indexName') || sid(item, 'index');
      const svc = sid(item, 'service');
      if (idx) push(await attempt('ai-search-index', idx, () => deleteIndex(idx, svc)));
      else push(skip('ai-search-index', '(unknown)', 'No AI Search index recorded on the item state.'));
      break;
    }

    // --- Prompt flow → AI Foundry flow ----------------------------------------
    case 'prompt-flow': {
      const project = sid(item, 'project');
      const flowId = resourceId(item);
      if (project && flowId) push(await attempt('prompt-flow', flowId, () => deletePromptFlow(project, flowId)));
      else push(skip('prompt-flow', flowId || '(unknown)', 'No AI Foundry project/flow recorded on the item state.'));
      break;
    }

    // --- Workspace monitor → ADX usage/perf database --------------------------
    case 'workspace-monitor': {
      const db = sid(item, 'database') || resourceId(item);
      if (db) push(await attempt('adx-database', db, () => deleteKustoDatabase(db)));
      else push(skip('adx-database', '(unknown)', 'No ADX database recorded on the item state.'));
      break;
    }

    // --- Catalog-only item types (no dedicated Azure backend to delete) --------
    // kql-dashboard (tiles query a sibling's ADX DB), kql-queryset (rides the
    // parent DB), semantic-model / report (Loom-native tabular over the
    // warehouse/lakehouse), dataset, data-product (Purview metadata GC'd by
    // lineage-gc), evaluation (a run record), logic-app (no teardown client),
    // synapse-serverless-sql-pool (views over the lake removed with the lake).
    default: {
      push(skip(type, resourceId(item) || '(none)', 'No dedicated Azure backend to delete for this item type (catalog record only).'));
      break;
    }
  }

  return { itemId: item.id, itemType: type, displayName, resources };
}

/**
 * Tear down every item's Azure backend, SERIALLY (never in parallel), returning
 * a per-item receipt. Best-effort — a failing item can't stop the rest. Called
 * BEFORE the Cosmos item docs are deleted, so item.state (with its backend refs)
 * is still available.
 */
export async function teardownWorkspaceBackends(
  items: TeardownItem[],
  tenantId: string,
): Promise<TeardownOutcome[]> {
  const out: TeardownOutcome[] = [];
  for (const item of items) {
    try {
      out.push(await teardownItemBackend(item, tenantId));
    } catch (e: any) {
      // teardownItemBackend never throws, but belt-and-braces: record it.
      out.push({
        itemId: item.id,
        itemType: item.itemType,
        displayName: item.displayName || item.id,
        resources: [{ kind: item.itemType, ref: '(item)', result: 'error', error: (e?.message || String(e)).slice(0, 300) }],
      });
    }
  }
  return out;
}
