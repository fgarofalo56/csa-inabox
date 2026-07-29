/**
 * LU-8 — the IMPURE half of the Synapse OpenLineage emitters: read what really
 * ran from Azure, build the RunEvents (pure, `synapse-emitters.ts`), and write
 * the resulting edges through the SAME L2 path the openlineage-spark listener
 * ingest uses (`mapRunEventToEdges` → `recordThreadEdge`).
 *
 * There is deliberately NO second lineage store and NO second mapper. The only
 * difference from the listener path is where the event comes from: an in-process
 * harvest of Azure Data Factory / Synapse REST instead of an HTTP POST from a
 * Spark executor.
 *
 * Backends called (all REAL, all Azure-native — no Fabric):
 *   - ADF/Synapse pipeline definition   `getPipeline`      (ARM REST)
 *   - ADF/Synapse datasets              `getDataset`       (ARM REST)
 *   - ADF/Synapse linked services       `getLinkedService` (ARM REST)
 *   - ADF/Synapse activity runs         `listActivityRuns` (ARM REST)
 *   - Synapse Spark batch (Livy)        `getSparkBatchJob` (Synapse dev REST)
 *   - Cosmos `items` (dataset → item)   + Cosmos `thread-edges` (the sink)
 *
 * Every entry point is BEST-EFFORT and non-throwing: lineage is an
 * observability layer over a run that already happened, so a harvest failure
 * must never turn a healthy run poll into an error. Each returns a receipt the
 * caller can surface.
 */

import {
  getPipeline,
  getDataset,
  getLinkedService,
  listActivityRuns,
  type AdfActivityRun,
} from '@/lib/azure/adf-client';
import {
  mapRunEventToEdges,
  type OpenLineageRunEvent,
  type MappedOpenLineageEdge,
} from '@/lib/azure/openlineage-ingest';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { canonicalDatasetIdentity, parseStorageAccountUrl } from '@/lib/lineage/dataset-naming';
import {
  loadWorkspacePathItems,
  resolveOwner,
  foreignOwnerProbe,
  type PathItem,
} from '@/lib/lineage/dataset-item-resolver';
import { auditCrossWorkspaceDenial, auditLineageWrite } from '@/lib/lineage/lineage-audit';
import {
  pipelineRunEvents,
  sparkBatchRunEvent,
  translatorColumnMappings,
  type CopyActivityLineage,
  type ResolvedAdfDataset,
} from '@/lib/lineage/synapse-emitters';
import type { OpenLineageFullRunEvent } from '@/lib/lineage/openlineage';
import type { SessionPayload } from '@/lib/auth/session';

/** ThreadEdge action for pipeline-derived lineage (distinct from the
 *  listener's `openlineage-spark`, so the canvas can tell them apart). */
export const PIPELINE_LINEAGE_ACTION = 'openlineage-pipeline';
/** ThreadEdge action for Loom-side Spark-batch-derived lineage. */
export const SPARK_LINEAGE_ACTION = 'openlineage-spark';

/** Max activities harvested from one pipeline run (write-amplification bound). */
const MAX_ACTIVITIES = 40;
/**
 * Wall clock for ONE harvest. Both entry points sit inside routes the editor
 * POLLS, and a pipeline harvest fans out to ~80 ARM reads; without a deadline a
 * slow/throttled factory stalls the poll response (the failure mode commit
 * 342becae bound on the run path). Past the deadline the harvest stops where it
 * is and reports honestly — lineage is best-effort by design and the next poll
 * (the run is not marked harvested on a partial pass) resumes it.
 */
const HARVEST_BUDGET_MS = 8_000;
/** Bounded in-process dedupe so a polled route harvests a run once per replica. */
const HARVESTED_MAX = 500;
const harvested = new Set<string>();
/** Keys currently being harvested — stops concurrent polls doubling the work. */
const inFlight = new Set<string>();
/**
 * Where a budget-truncated pass stopped, per run key: the index into the
 * pipeline's activity definitions that the NEXT poll should start from.
 *
 * Without this the budget was a treadmill. A truncated pass does not earn the
 * dedupe key (correct — the tail is unharvested), but it still re-entered at
 * activity 0 on the next poll, so on a slow/throttled factory every poll spent
 * the full 8s re-resolving and REWRITING the same leading activities and never
 * reached the tail. The per-principal 5/s limit does not bound that: it permits
 * five 8-second fan-outs per second per user. A resume cursor makes each poll
 * strictly advance instead — the writes are idempotent upserts, so replaying a
 * boundary activity is harmless, but replaying the whole head forever is not.
 */
const resumeCursor = new Map<string, number>();

/**
 * True when this run was ALREADY harvested successfully, or is being harvested
 * right now, in this replica.
 *
 * Deliberately a pure QUERY: the key is only recorded by {@link markHarvested},
 * which the callers run **after** a successful pass. Marking before the work
 * (the original shape) meant one transient ARM failure permanently destroyed
 * that run's lineage on the replica — the retry short-circuited on a key that
 * was recorded for an attempt that wrote nothing.
 */
function alreadyHarvested(key: string): boolean {
  return harvested.has(key) || inFlight.has(key);
}

/** Record a SUCCESSFUL harvest, evicting the oldest key when full (Set keeps
 *  insertion order, so this is a real FIFO — not a full flush). */
function markHarvested(key: string): void {
  while (harvested.size >= HARVESTED_MAX) {
    const oldest = harvested.values().next().value;
    if (oldest === undefined) break;
    harvested.delete(oldest);
  }
  harvested.add(key);
  resumeCursor.delete(key);
}

/** Test hook — clears the dedupe set between cases. */
export function __resetHarvestDedupe(): void {
  harvested.clear();
  inFlight.clear();
  resumeCursor.clear();
}

/**
 * The session the edges are WRITTEN with — `recordThreadEdge` partitions on
 * `session.claims.oid`, so this decides whose lineage canvas can see them.
 *
 * It must be the workspace OWNER, not the caller. A workspace shared with ACL
 * members admits any `canWrite` member through `loadOwnedItem`; writing with
 * that member's oid would drop the edges into the member's private thread-edge
 * partition, where the workspace owner's canvas never renders them and every
 * member accumulates their own duplicate copy of the same lineage. This mirrors
 * the L2 ingest route's `machineSession(ws.tenantId)` and its documented reason.
 *
 * `createdBy` still carries the REAL caller (recordThreadEdge prefers `upn`), and
 * the audit rows are keyed on the caller's oid — attribution is not lost, only
 * the partition is normalized. Falls back to the caller when the workspace is
 * unreadable, which is the pre-existing behaviour and never worse.
 */
async function writerSession(session: SessionPayload, workspaceId: string): Promise<SessionPayload> {
  try {
    const ws = await workspacesContainer();
    const { resources } = await ws.items
      .query<{ tenantId: string }>({
        query: 'SELECT TOP 1 c.tenantId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: workspaceId }],
      })
      .fetchAll();
    const ownerOid = resources?.[0]?.tenantId;
    if (!ownerOid || ownerOid === session.claims.oid) return session;
    return { ...session, claims: { ...session.claims, oid: ownerOid } };
  } catch {
    return session;
  }
}

export interface HarvestReceipt {
  ok: boolean;
  /** RunEvents built from the real run. */
  events: number;
  /** Item/dataset edges written to the lineage store. */
  written: number;
  skipped: number;
  /** Edges refused because an endpoint is owned by ANOTHER workspace. */
  denied: number;
  /** Set when nothing was harvested and why (honest, never a silent no-op). */
  reason?: string;
  error?: string;
}

const EMPTY: HarvestReceipt = { ok: true, events: 0, written: 0, skipped: 0, denied: 0 };

// ---------------------------------------------------------------------------
// Shared write path
// ---------------------------------------------------------------------------

/** Everything the write path needs that is not the event itself. */
interface WriteContext {
  session: SessionPayload;
  /** The workspace the caller is authorized for — the ONLY write scope. */
  workspaceId: string;
  /** Audit principal (the caller's oid). */
  principal: string;
  /** Which producer this is, for the audit row. */
  producer: string;
  candidates: PathItem[];
  /** Memoized cross-workspace forgery probe (one query per harvest). */
  probeForeign: (uri: string) => Promise<PathItem | null>;
}

/**
 * Write one built RunEvent's edges through the L2 mapper + sink.
 *
 * Endpoint identity, in order:
 *   1. the Loom item that OWNS the physical path (longest-prefix, shared
 *      resolver) — a deep-linkable node on the canvas;
 *   2. a dataset owned by an item in ANOTHER workspace ⇒ **the edge is refused
 *      and the denial is audited**. This is the SAME rule the L2 ingest route
 *      enforces (`findForeignOwner` → 403 `cross_workspace_write`); two
 *      producers writing one store must not disagree about it, or the weaker
 *      one becomes the way around the stronger one. Recording a foreign
 *      workspace's storage account / container / folder structure into this
 *      caller's graph is a real disclosure, durably written and rendered.
 *   3. otherwise the canonical dataset id itself, recorded as an EXTERNAL
 *      endpoint. The asset is real (the run just read/wrote it) and its
 *      canonical id normalizes to the same `path:` / `uc:` key the Purview and
 *      Unity Catalog overlays use, so it merges with their node instead of
 *      dangling. It is NOT deep-linked, because there is no Loom item to open.
 */
async function writeEventEdges(
  ctx: WriteContext,
  event: OpenLineageFullRunEvent,
  action: string,
): Promise<{ written: number; skipped: number; denied: number }> {
  const mapped = mapRunEventToEdges(event as unknown as OpenLineageRunEvent);
  if (!mapped.ok) return { written: 0, skipped: 0, denied: 0 };
  let written = 0;
  let skipped = 0;
  let denied = 0;
  for (const edge of mapped.edges as MappedOpenLineageEdge[]) {
    const from = await endpoint(edge.fromUri, ctx);
    const to = await endpoint(edge.toUri, ctx);
    if (from.foreign || to.foreign) { denied += 1; continue; }
    if (from.id === to.id) { skipped += 1; continue; }
    await recordThreadEdge(ctx.session, {
      fromItemId: from.id,
      fromType: from.type,
      fromName: from.name,
      ...(from.external ? { fromExternal: true } : {}),
      toItemId: to.id,
      toType: to.type,
      toName: to.name,
      ...(to.external ? { toExternal: true } : {}),
      action,
      ...(edge.columnMappings.length ? { columnMappings: edge.columnMappings } : {}),
    });
    written += 1;
  }
  return { written, skipped, denied };
}

interface Endpoint { id: string; type: string; name: string; external?: boolean; foreign?: boolean }

/** Resolve one dataset URI to its lineage-graph endpoint (see writeEventEdges). */
async function endpoint(uri: string, ctx: WriteContext): Promise<Endpoint> {
  const owner = resolveOwner(uri, ctx.candidates);
  if (owner) {
    return { id: owner.id, type: owner.itemType, name: owner.displayName || owner.id };
  }
  const foreign = await ctx.probeForeign(uri);
  if (foreign) {
    await auditCrossWorkspaceDenial({
      principal: ctx.principal,
      producer: ctx.producer,
      authorizedWorkspaceId: ctx.workspaceId,
      targetWorkspaceId: foreign.workspaceId,
      uri: canonicalDatasetIdentity(uri),
      itemId: foreign.id,
    });
    return { id: foreign.id, type: foreign.itemType, name: foreign.id, foreign: true };
  }
  const canonical = canonicalDatasetIdentity(uri);
  return { id: canonical, type: 'dataset', name: shortDatasetLabel(canonical), external: true };
}

/** Human label for an external dataset node: the last two path segments. */
function shortDatasetLabel(uri: string): string {
  const tail = uri.split('/').filter(Boolean).slice(-2).join('/');
  return tail || uri;
}

// ---------------------------------------------------------------------------
// Synapse / ADF pipeline runs
// ---------------------------------------------------------------------------

/** Resolve an ADF dataset reference (by name) into the emitter's input shape. */
async function resolveDataset(
  name: string,
  cache: Map<string, ResolvedAdfDataset | null>,
): Promise<ResolvedAdfDataset | null> {
  if (cache.has(name)) return cache.get(name) || null;
  let out: ResolvedAdfDataset | null = null;
  try {
    const ds = await getDataset(name);
    const props = (ds.properties || {}) as Record<string, any>;
    const tp = (props.typeProperties || {}) as Record<string, any>;
    const rawCols = (Array.isArray(props.schema) && props.schema.length ? props.schema : props.structure) as
      | Array<Record<string, unknown>>
      | undefined;
    const columns = (rawCols || []).map((c) => String(c?.name ?? '')).filter(Boolean);

    const lsName = props.linkedServiceName?.referenceName as string | undefined;
    let linkedServiceUrl: string | undefined;
    let sqlServer: string | undefined;
    let sqlDatabase: string | undefined;
    if (lsName) {
      const ls = await getLinkedService(lsName).catch(() => null);
      const lsProps = (ls?.properties || {}) as Record<string, any>;
      const lsTp = (lsProps.typeProperties || {}) as Record<string, any>;
      const url = typeof lsTp.url === 'string' ? lsTp.url : typeof lsTp.serviceEndpoint === 'string' ? lsTp.serviceEndpoint : '';
      if (url && parseStorageAccountUrl(url)) linkedServiceUrl = url;
      const conn = typeof lsTp.connectionString === 'string' ? lsTp.connectionString : '';
      if (conn) {
        // A literal ADO.NET connection string (KV-referenced secrets arrive as
        // an object, not a string — those simply yield no host, and the SQL
        // dataset still joins on its `database.schema.table` name).
        sqlServer = /(?:^|;)\s*(?:server|data source)\s*=\s*(?:tcp:)?([^,;]+)/i.exec(conn)?.[1]?.trim();
        sqlDatabase = /(?:^|;)\s*(?:initial catalog|database)\s*=\s*([^;]+)/i.exec(conn)?.[1]?.trim();
      }
      if (!sqlDatabase && typeof lsTp.database === 'string') sqlDatabase = lsTp.database;
    }

    const isTable = typeof tp.table === 'string' || typeof tp.tableName === 'string';
    out = {
      name,
      type: props.type,
      ...(tp.location ? { location: tp.location } : {}),
      ...(linkedServiceUrl ? { linkedServiceUrl } : {}),
      ...(isTable
        ? {
            sqlServer,
            sqlDatabase,
            sqlSchema: typeof tp.schema === 'string' ? tp.schema : undefined,
            sqlTable: String(tp.table ?? tp.tableName ?? ''),
          }
        : {}),
      ...(columns.length ? { columns } : {}),
    };
  } catch {
    out = null; // dataset unreadable — that activity contributes no lineage
  }
  cache.set(name, out);
  return out;
}

export interface HarvestPipelineInput {
  /** Loom workspace owning the pipeline item (scopes item resolution). */
  workspaceId: string;
  /** ADF/Synapse pipeline name (`state.adfPipelineName`). */
  adfPipelineName: string;
  /** Factory / workspace name for the OL job namespace. */
  factoryName: string;
  /** The pipeline run to harvest. */
  runId: string;
  runStatus?: string;
  runEnd?: string;
  /** Pre-fetched activity runs (the Output pane already has them). */
  activityRuns?: AdfActivityRun[];
}

/**
 * Harvest ONE Synapse/ADF pipeline run into OpenLineage events and write the
 * resulting lineage. Only activities that actually ran are considered, and each
 * emits with its own status, so a failed Copy never stamps an edge.
 *
 * Non-throwing; deduped per (workspace, run) per replica so a polled route can
 * call it on every poll without re-reading ADF.
 */
export async function harvestPipelineRunLineage(
  session: SessionPayload,
  input: HarvestPipelineInput,
): Promise<HarvestReceipt> {
  if (!input.runId || !input.adfPipelineName) return { ...EMPTY, reason: 'no pipeline run to harvest' };
  const status = (input.runStatus || '').toLowerCase();
  // Succeeded-only, and NEVER on an unknown status: the caller must tell us
  // what the run did. An absent status used to skip this gate entirely, so the
  // Output pane harvested FAILED runs (the jobs route's guard did not cover it).
  if (status !== 'succeeded') {
    return {
      ...EMPTY,
      reason: `run status ${input.runStatus || 'unknown'} — lineage is only stamped for a succeeded run`,
    };
  }
  const key = `adf:${input.workspaceId}:${input.runId}`;
  if (alreadyHarvested(key)) {
    return { ...EMPTY, reason: 'already harvested in this replica' };
  }
  inFlight.add(key);
  const deadline = Date.now() + HARVEST_BUDGET_MS;
  try {
    const pipeline = await getPipeline(input.adfPipelineName);
    const defs = ((pipeline.properties?.activities || []) as Array<Record<string, any>>).slice(0, MAX_ACTIVITIES);
    if (!defs.length) { markHarvested(key); return { ...EMPTY, reason: 'pipeline has no activities' }; }

    const runs = input.activityRuns ?? (await listActivityRuns(input.runId).catch(() => [] as AdfActivityRun[]));
    const statusByActivity = new Map<string, string>();
    for (const r of runs) if (r.activityName) statusByActivity.set(r.activityName, r.status || '');

    const cache = new Map<string, ResolvedAdfDataset | null>();
    const activities: CopyActivityLineage[] = [];
    let truncated = false;
    // Resume where the last budget-truncated pass stopped, so each poll makes
    // forward progress instead of re-walking the head of the pipeline forever.
    const start = Math.min(resumeCursor.get(key) ?? 0, defs.length);
    let cursor = start;
    for (let i = start; i < defs.length; i += 1) {
      const a = defs[i];
      cursor = i;
      if (Date.now() > deadline) { truncated = true; break; } // wall clock, not just a page cap
      cursor = i + 1;
      const type = String(a?.type || '');
      if (type.toLowerCase() !== 'copy') continue; // only Copy declares a dataset pair
      const name = String(a?.name || '');
      // When we have activity-run rows, honour them: an activity that did not
      // run in THIS run contributes nothing.
      const actStatus = statusByActivity.size ? statusByActivity.get(name) : input.runStatus;
      if (statusByActivity.size && !actStatus) continue;
      const srcRef = (a?.inputs || [])[0]?.referenceName;
      const snkRef = (a?.outputs || [])[0]?.referenceName;
      if (!srcRef || !snkRef) continue;
      const [source, sink] = await Promise.all([
        resolveDataset(String(srcRef), cache),
        resolveDataset(String(snkRef), cache),
      ]);
      if (!source || !sink) continue;
      activities.push({
        activityName: name,
        activityType: type,
        source,
        sink,
        columnMappings: translatorColumnMappings(a?.typeProperties?.translator),
        status: actStatus || input.runStatus,
      });
    }
    if (!activities.length) {
      if (truncated) {
        resumeCursor.set(key, cursor);
      } else {
        markHarvested(key);
      }
      return { ...EMPTY, reason: truncated ? 'harvest budget exhausted — will resume on the next poll' : 'no Copy activity with a resolvable source and sink' };
    }

    const events = pipelineRunEvents({
      factoryName: input.factoryName,
      pipelineName: input.adfPipelineName,
      runId: input.runId,
      runStatus: input.runStatus,
      runEnd: input.runEnd,
      activities,
    });
    const ctx: WriteContext = {
      session: await writerSession(session, input.workspaceId),
      workspaceId: input.workspaceId,
      principal: session.claims.oid,
      producer: 'adf-pipeline-harvest',
      candidates: await loadWorkspacePathItems(input.workspaceId),
      probeForeign: foreignOwnerProbe(input.workspaceId),
    };
    let written = 0;
    let skipped = 0;
    let denied = 0;
    for (const ev of events) {
      const r = await writeEventEdges(ctx, ev, PIPELINE_LINEAGE_ACTION);
      written += r.written;
      skipped += r.skipped;
      denied += r.denied;
    }
    await auditLineageWrite({
      principal: ctx.principal,
      producer: ctx.producer,
      workspaceId: input.workspaceId,
      runKey: input.runId,
      written,
      denied,
    });
    // Only a COMPLETE pass earns the dedupe key — a partial/failed one must be
    // retried by the next poll, which resumes from the cursor rather than
    // rewriting the activities this pass already wrote.
    if (truncated) resumeCursor.set(key, cursor);
    else markHarvested(key);
    return { ok: true, events: events.length, written, skipped, denied, ...(truncated ? { reason: `harvest budget exhausted after ${cursor}/${defs.length} activities — resumes on the next poll` } : {}) };
  } catch (e) {
    return { ...EMPTY, ok: false, error: (e as Error)?.message || String(e) };
  } finally {
    inFlight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Synapse Spark batch runs
// ---------------------------------------------------------------------------

export interface HarvestSparkInput {
  workspaceId: string;
  /** Synapse workspace name for the OL job namespace. */
  synapseWorkspaceName: string;
  poolName: string;
  batchId: number | string;
  jobName: string;
  /** Livy batch state (`success` / `dead` / `killed` / `running`). */
  state?: string;
  args?: string[];
  conf?: Record<string, string>;
  eventTime?: string;
  /**
   * True when the caller PROVED this Livy batch was submitted by the Loom item
   * being viewed (see `batchBelongsToItem` in the run route).
   *
   * Livy batch ids are POOL-scoped, not Loom-workspace-scoped: every item on a
   * shared Synapse pool sees the same id space, and any authenticated member
   * can name an arbitrary integer. Without attribution the harvest would
   * persist another team's `abfss://` inputs and outputs — storage account,
   * container and folder structure — as edges and node labels in this caller's
   * own graph. Unattributed ⇒ no write.
   */
  attributed?: boolean;
}

/**
 * Harvest ONE Synapse Spark batch (Livy) run. Emits only when the submitted
 * batch declared both an input and an output dataset (conf declaration or
 * argv flags — see `parseSparkDatasets`); otherwise returns an honest reason
 * naming the higher-fidelity option (the openlineage-spark listener), never a
 * guessed edge.
 */
export async function harvestSparkBatchLineage(
  session: SessionPayload,
  input: HarvestSparkInput,
): Promise<HarvestReceipt> {
  if (!input.attributed) {
    return {
      ...EMPTY,
      reason:
        `batch ${input.batchId} on pool ${input.poolName} was not submitted by this Loom item — ` +
        'Livy batch ids are pool-scoped, so lineage is only stamped for a batch this item owns',
    };
  }
  const state = (input.state || '').toLowerCase();
  if (state !== 'success') {
    return { ...EMPTY, reason: `batch state ${input.state || 'unknown'} — lineage is only stamped on success` };
  }
  // Livy batch ids restart from 0 when a pool is recreated (this estate has
  // done exactly that: loompool → loompool2), so the id alone is NOT unique
  // over time. The submit time disambiguates two genuinely different runs that
  // share an id — otherwise the second is dropped as "already harvested" and
  // downstream OL consumers conflate them under one deterministic run id.
  const key = `spark:${input.workspaceId}:${input.poolName}:${input.batchId}:${input.eventTime || ''}`;
  if (alreadyHarvested(key)) {
    return { ...EMPTY, reason: 'already harvested in this replica' };
  }
  inFlight.add(key);
  try {
    const event = sparkBatchRunEvent({
      workspaceName: input.synapseWorkspaceName,
      poolName: input.poolName,
      batchId: input.batchId,
      jobName: input.jobName,
      state: input.state,
      args: input.args,
      conf: input.conf,
      eventTime: input.eventTime,
    });
    if (!event) {
      markHarvested(key);
      return {
        ...EMPTY,
        reason:
          'the batch declared no storage input+output (set spark.loom.lineage.inputs/outputs, ' +
          'pass --input/--output paths, or wire the openlineage-spark listener for full column lineage)',
      };
    }
    const ctx: WriteContext = {
      session: await writerSession(session, input.workspaceId),
      workspaceId: input.workspaceId,
      principal: session.claims.oid,
      producer: 'synapse-spark-harvest',
      candidates: await loadWorkspacePathItems(input.workspaceId),
      probeForeign: foreignOwnerProbe(input.workspaceId),
    };
    const r = await writeEventEdges(ctx, event, SPARK_LINEAGE_ACTION);
    await auditLineageWrite({
      principal: ctx.principal,
      producer: ctx.producer,
      workspaceId: input.workspaceId,
      runKey: `${input.poolName}:${input.batchId}`,
      written: r.written,
      denied: r.denied,
    });
    markHarvested(key);
    return { ok: true, events: 1, written: r.written, skipped: r.skipped, denied: r.denied };
  } catch (e) {
    return { ...EMPTY, ok: false, error: (e as Error)?.message || String(e) };
  } finally {
    inFlight.delete(key);
  }
}
