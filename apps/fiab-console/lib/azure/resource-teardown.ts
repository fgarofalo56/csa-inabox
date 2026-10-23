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
import { deleteStreamingJob, getJobTags, readAsaConfig } from '@/lib/azure/stream-analytics-client';
import { asaJobNameForItem } from '@/lib/azure/asa-job-name';
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
import { decodeIdList } from '@/lib/install/secondary-id-list'; // #3920 — list-valued secondaryIds decoder.

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
  /** True when the resource was RETAINED only because a safety check could not run (fail closed). */
  unverified?: boolean;
}

export interface TeardownOutcome {
  itemId: string;
  itemType: string;
  displayName: string;
  resources: TeardownResourceResult[];
}

export interface TeardownOptions {
  /**
   * RECORDED-ONLY mode (the generic item-delete route, #5046). A resource is
   * deleted only when the item's persisted state NAMES it. Every fallback that
   * derives a name from the display name or the item id is disabled, and a
   * recorded ref that points at a SHARED resource (the shared dedicated SQL
   * pool, the workspace-monitor database) is skipped rather than deleted. The
   * workspace-delete cascade keeps its historical derive-on-missing behaviour
   * (default `false`) because the operator opted into `?cascade=true`.
   */
  recordedOnly?: boolean;
  /**
   * Recorded-only cross-item lookup: does any OTHER item record one of these
   * values as its backing resource? Returns that item, or null when none does.
   * Throwing means "could not check" and the delete is retained (fail closed).
   * REQUIRED for recorded-only deletes to run at all.
   */
  sharedCheck?: (selfItemId: string, values: string[]) => Promise<{ id: string; workspaceId: string; itemType: string } | null>;
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
function stField(item: TeardownItem, key: string): string | undefined {
  const v = (item.state as any)?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function resourceId(item: TeardownItem): string | undefined {
  const v = provRecord(item).resourceId;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function backendOf(item: TeardownItem): string | undefined {
  return sid(item, 'backend') || stField(item, 'backend');
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

/** The platform-wide workspace-monitor ADX database (workspace-monitor.ts MONITOR_DB). */
function isSharedAdxDatabase(db: string): boolean {
  return db === (process.env.LOOM_WORKSPACE_MONITOR_DB || 'loomdb_workspace_monitor');
}

/**
 * Delete the Stream Analytics job whose name was DERIVED from the item id
 * (no `asaJobName` recorded), but only after PROVING the job is this item's.
 *
 * `standUpEventstreamAzure` stamps the ARM tag `loomItemId=<item id>` on every
 * job it creates. The derived name is only 8 chars of the id, so the name alone
 * cannot establish ownership; the tag can. Outcomes, each stating only what was
 * established (deploy-integrity.md R7):
 *   - ASA not configured          -> null (nothing to look for, no row)
 *   - job absent (404)            -> not_found
 *   - tag === item id             -> delete it
 *   - tag absent / different      -> skipped (NOT deleted), reason names the tag seen
 *   - tag read failed             -> error, "could not verify ownership"
 * Jobs created before the tag existed carry no tag and are skipped here; they
 * are removed by the approval-gated leftover cleanup, not guessed at.
 */
async function deriveOwnedAsaJob(itemId: string, candidate?: string): Promise<TeardownResourceResult | null> {
  try { readAsaConfig(); } catch { return null; }
  // `candidate` is an UNTRUSTED top-level `state.asaJobName` (any Member can
  // PATCH it, and asa-sync/sql-operator write operator-chosen job names there);
  // it is only a name to look at, and the tag decides whether it is ours.
  const name = candidate || asaJobNameForItem(itemId);
  let tags: Record<string, string> | null;
  try {
    tags = await getJobTags(name);
  } catch (e: any) {
    return {
      kind: 'stream-analytics-job',
      ref: name,
      result: 'error',
      error: `Could not verify ownership of Stream Analytics job '${name}' (tag read failed: ${(e?.message || String(e)).slice(0, 200)}); it was NOT deleted.`,
    };
  }
  if (tags === null) return { kind: 'stream-analytics-job', ref: name, result: 'not_found' };
  if (tags.loomItemId !== itemId) {
    return skip(
      'stream-analytics-job',
      name,
      `Job '${name}' exists but its loomItemId tag is ${tags.loomItemId ? `'${tags.loomItemId}'` : 'absent'}, not this item's id, and no job name is recorded in the item's server-owned provisioning receipt; not deleted.`,
    );
  }
  return attemptDelete('stream-analytics-job', name, () => deleteStreamingJob(name));
}

/**
 * Run one delete, classifying the outcome. Never throws. A 404 / "not found" /
 * "does not exist" is reported as `not_found` (already gone — an idempotent
 * success for teardown), any other failure as `error` with the message.
 */
async function attemptDelete(
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
  opts: TeardownOptions = {},
): Promise<TeardownOutcome> {
  const recordedOnly = opts.recordedOnly === true;
  const type = item.itemType;
  const displayName = item.displayName || item.id;
  const resources: TeardownResourceResult[] = [];
  const push = (r: TeardownResourceResult) => resources.push(r);

  // #5046 review blocker 2 - in recorded-only mode ONLY the server-owned
  // `state.provisioning` receipt is trusted. Every plain top-level state key
  // (transportHub, asaJobName, databaseName, pipelineName, notebookPath,
  // indexName, rules[], ...) is writable by any Member who can PATCH the item,
  // so reading one would let that Member aim a delete at another workspace's
  // resource. `st` is shadowed to "absent" so no case below can reach one.
  // `provisioning` itself is in SERVER_DERIVED_SCOPE_KEYS: PATCH can neither set
  // nor drop it. (`state.autoBind` is NOT protected, so it is not read either.)
  const st = (i: TeardownItem, k: string): string | undefined => (recordedOnly ? undefined : stField(i, k));
  if (recordedOnly && Object.keys(provRecord(item)).length === 0) {
    push(skip(type, '(none)', 'The item has no server-owned provisioning receipt (state.provisioning), so there is no trustworthy record of a backing resource; nothing was deleted.'));
    return { itemId: item.id, itemType: type, displayName, resources };
  }

  // Every delete goes through here. In recorded-only mode it first proves no
  // OTHER item records the same backing resource (two items can share a name:
  // e.g. same-named KQL databases in two workspaces), and fails CLOSED when the
  // lookup is unavailable or was not supplied.
  const attempt = async (
    kind: string,
    ref: string,
    fn: () => Promise<unknown>,
    sharedValues: string[] = [ref],
  ): Promise<TeardownResourceResult> => {
    if (recordedOnly) {
      if (!opts.sharedCheck) {
        return { ...skip(kind, ref, 'No cross-item lookup is available, so it could not be verified that no other item records this resource; not deleted.'), unverified: true };
      }
      try {
        const other = await opts.sharedCheck(item.id, sharedValues);
        if (other) {
          return skip(kind, ref, `Shared by another item (${other.itemType} ${other.id} in workspace ${other.workspaceId}) that records the same backing resource; not deleted.`);
        }
      } catch (e: any) {
        return {
          ...skip(kind, ref, `Could not verify that no other item records this resource (cross-item lookup failed: ${(e?.message || String(e)).slice(0, 200)}); not deleted.`),
          unverified: true,
        };
      }
    }
    return attemptDelete(kind, ref, fn);
  };
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
      const recordedRoot =
        sid(item, 'rootPath') ||
        (rid && rid.includes('/') ? rid.split('/').slice(1).join('/') : undefined);
      // Recorded-only never falls back to `lakehouses/<displayName>`: a recursive
      // ADLS delete on a name guessed from the display name is the exact blind
      // delete #5046 forbids. An empty root would also be the container itself.
      const rawRoot = recordedRoot || (recordedOnly ? '' : `lakehouses/${safeName(displayName) || item.id}`);
      // The value handed to deletePath is the SANITISED one: `safeName` drops
      // '', '.' and '..' segments, and a root that tried traversal is refused
      // outright rather than quietly rewritten to a different (shallower) path.
      const rootPath = safeName(rawRoot);
      const rootSegments = rootPath ? rootPath.split('/').length : 0;
      if (rawRoot.replace(/\\/g, '/').split('/').some((s) => s.trim() === '..')) {
        push(skip('adls-path', `${container || '(unknown)'}/${rawRoot}`, 'The recorded ADLS root contains a ".." segment; refused, data left in place.'));
      } else if (recordedOnly && rootSegments < 2) {
        // A single segment is a top-level folder shared by the container, and an
        // empty root is the container itself.
        push(skip('adls-path', container || '(unknown)', rootSegments === 0
          ? 'No ADLS root path is recorded in the server-owned provisioning receipt; data left in place (a path is never derived from the display name).'
          : `The recorded ADLS root '${rootPath}' has fewer than 2 path segments (it could be a shared top-level folder); data left in place.`));
      } else if (container && /[/\\]/.test(container)) {
        push(skip('adls-path', container, 'The recorded ADLS container name contains a path separator; refused.'));
      } else if (container) {
        push(
          await attempt('adls-path', `${container}/${rootPath}`, () => deletePath(container, `${rootPath}/`, true),
            [rootPath, `${container}/${rootPath}`]),
        );
      } else {
        push(skip('adls-path', rootPath, 'No ADLS container recorded on the item state; data left in place.'));
      }
      // Best-effort: drop the Synapse serverless OPENROWSET views this lakehouse
      // registered (state.provisioning.secondaryIds.synapseViews). #3920 — that
      // value is now a JSON array; `decodeIdList` reads both it and the legacy
      // `"a,b,c"` form still persisted on pre-#3920 items. Reading it with a
      // bare `split(',')` after the encoding change would hand `["lakehouse` to
      // the `DROP VIEW ${v}` interpolation below and orphan every real view.
      const views = decodeIdList(sid(item, 'synapseViews'));
      if (views.length && process.env.LOOM_SYNAPSE_WORKSPACE) {
        const db = (process.env.LOOM_SYNAPSE_LAKEHOUSE_DB || 'loom_lakehouse').replace(/[^A-Za-z0-9_]/g, '_');
        const target = serverlessTarget(db);
        for (const v of views) {
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
      } else if (recordedOnly && !shared) {
        // The shared-pool env is the only way to tell a per-item pool from the
        // shared one. Unset means "cannot tell", and unknown is not deletable.
        push(skip('synapse-dedicated-sql-pool', db, 'LOOM_SYNAPSE_DEDICATED_POOL is not set, so it cannot be verified that the recorded pool is not the shared one; pool retained.'));
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
      if (db && recordedOnly && isSharedAdxDatabase(db)) {
        push(skip('adx-database', db, 'The recorded database is the shared workspace-monitor database; retained.'));
      } else if (db) {
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
        const hubName = (hub.includes('/') ? hub.split('/').pop()! : hub).trim();
        if (hubName) {
          push(await attempt('event-hub', hubName, () => deleteEventHub(hubName)));
        } else {
          push(skip('event-hub', hub, 'The recorded Event Hub reference has an empty name segment; nothing was deleted.'));
        }
      } else {
        push(skip('event-hub', '(unknown)', 'No Event Hub recorded on the item state.'));
      }
      // The job name is a pure function of the item id, so a missing
      // `asaJobName` ref (the auto-bind seed path never records it) does not
      // strand the job. The derived name is only tried when ASA is configured,
      // and deleteStreamingJob treats 404 as already-gone, so an eventstream
      // that never had a transform job costs one idempotent DELETE, not an error.
      // Ownership proof is the SERVER-OWNED receipt only. A top-level
      // `state.asaJobName` is user-editable (PATCH) and is also where
      // asa-sync / sql-operator store an operator-chosen job that this item did
      // not create, so it is only a candidate NAME: the loomItemId tag decides.
      const trustedJob = sid(item, 'asaJobName');
      if (trustedJob) {
        push(await attempt('stream-analytics-job', trustedJob, () => deleteStreamingJob(trustedJob)));
      } else {
        const derived = await deriveOwnedAsaJob(item.id, stField(item, 'asaJobName'));
        if (derived) push(derived);
      }
      break;
    }

    // --- Activator → Azure Monitor scheduled-query alert rule(s) --------------
    case 'activator': {
      // `state.rules[].azureRuleName` is a top-level, user-editable key: ignored
      // in recorded-only mode (only the receipt's last authored rule is trusted).
      const rules = recordedOnly ? undefined : (item.state as any)?.rules;
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
      if (recordedOnly) {
        // The provisioner records that root as `secondaryIds.adlsRoot` (abfss).
        // Recorded-only deletes THAT, not a path rebuilt from ids.
        const root = parseAbfss(sid(item, 'adlsRoot') || '');
        // The ref encodes the item's own scope (mirrors/<workspaceId>/<itemId>);
        // a root that is not exactly that item's is retained, not deleted.
        const expected = `mirrors/${item.workspaceId}/${item.id}`;
        if (root && root.path && root.path !== expected) {
          push(skip('adls-path', `${root.container}/${root.path}`, `The recorded Bronze root is not this item's own mirror root ('${expected}'); retained.`));
        } else if (root && root.path) {
          push(await attempt('adls-path', `${root.container}/${root.path}`, () => deletePath(root.container, `${root.path}/`, true),
            [root.path, `${root.container}/${root.path}`]));
        } else {
          push(skip('adls-path', '(unknown)', 'No Bronze mirror root (adlsRoot) is recorded on the item state; landed data left in place.'));
        }
      } else {
        push(
          await attempt('adls-path', `bronze/mirrors/${item.workspaceId}/${item.id}`, () =>
            deletePath('bronze', `mirrors/${item.workspaceId}/${item.id}/`, true),
          ),
        );
      }
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
      const recordedModel = sid(item, 'modelName');
      if (recordedOnly && !recordedModel) {
        // ml-model.ts records the notebook path / run id, never the registered
        // model name, so a display-name-derived delete would be a blind one.
        push(skip('databricks-registered-model', '(unknown)', 'No registered model name is recorded on the item state; the model and any serving endpoint are left in place.'));
        break;
      }
      const model = recordedModel || safeName(displayName) || item.id;
      push(await attempt('databricks-registered-model', model, () => deleteRegisteredModel(model)));
      // Best-effort: a matching serving endpoint (may not exist → not_found).
      push(await attempt('databricks-serving-endpoint', model, () => deleteServingEndpoint(model)));
      break;
    }

    // --- Materialized lake view → Delta tree ----------------------------------
    case 'materialized-lake-view': {
      const deltaUrl = sid(item, 'deltaUrl') || resourceId(item);
      const parsed = deltaUrl ? parseAbfss(deltaUrl) : null;
      const mlvSegs = parsed ? parsed.path.split('/') : [];
      if (parsed && mlvSegs.some((s) => s === '..' || s === '.' || s === '')) {
        push(skip('adls-path', `${parsed.container}/${parsed.path}`, 'The recorded Delta path has an empty, "." or ".." segment; refused, data left in place.'));
      } else if (parsed && recordedOnly && mlvSegs.length < 2) {
        push(skip('adls-path', `${parsed.container}/${parsed.path}`, 'The recorded Delta path has fewer than 2 segments (could be a shared top-level folder); data left in place.'));
      } else if (parsed) {
        push(
          await attempt('adls-path', `${parsed.container}/${parsed.path}`, () =>
            deletePath(parsed.container, `${parsed.path}/`, true),
            [parsed.path, `${parsed.container}/${parsed.path}`],
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
      if (db && recordedOnly && isSharedAdxDatabase(db)) {
        // The monitor DB is a platform-wide constant (workspace-monitor.ts
        // MONITOR_DB), not per item: one item's delete must not drop it.
        push(skip('adx-database', db, 'The workspace-monitor database is shared by the whole platform; retained.'));
      } else if (db) push(await attempt('adx-database', db, () => deleteKustoDatabase(db)));
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
