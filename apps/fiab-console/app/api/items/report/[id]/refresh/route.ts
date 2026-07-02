/**
 * POST / GET /api/items/report/[id]/refresh
 *
 * REPORT-BUILDER PARITY · WAVE 2 — Azure-native "Refresh now" + last-refreshed
 * state.  This route used to be Power-BI-ONLY: it REQUIRED a `workspaceId` and
 * always ran `getReport` + `refreshDataset` against api.powerbi.com — a
 * default-path Fabric/Power BI dependency and a direct violation of
 * .claude/rules/no-fabric-dependency.md.  It is rewritten so the DEFAULT path is
 * 100% Azure-native re-materialization; Power BI refresh survives ONLY as an
 * explicit opt-in backend.
 *
 * ── POST: resolve → re-materialize (Azure-native DEFAULT) ───────────────────
 *  1. Session + owner-load the report item (loom: content id OR plain Cosmos id,
 *     same pattern as /connector-preview + /data-source).
 *  2. OPT-IN Power BI ONLY — the SINGLE api.powerbi.com touch, NEVER reached by
 *     default: when `state.biBackend==='powerbi'` (or `body.biBackend==='powerbi'`)
 *     AND a `workspaceId` is supplied, run the legacy getReport→refreshDataset
 *     dataset refresh.  Absent that explicit signal the host is never contacted.
 *  3. DEFAULT Azure-native — `resolveReportModel(item, oid)`:
 *       • `unbound`            → 412 honest gate (pick a data source).
 *       • `aas`                → Azure Analysis Services async refresh (AAS is
 *         Azure PaaS, an allowed opt-in backend — NOT Fabric); per-table
 *         `applyRefreshPolicy` when `body.table`; `aasConfigGate` → 412.
 *       • `loom-native`|`connection` → for every model table whose storage mode
 *         is Import or Dual (filtered by `body.table`) submit a REAL Synapse
 *         Spark batch via `refreshMaterializedLakeView(reportTableMlvSpec(…))` —
 *         the SAME MLV spec the resolver reads its cache from, so the Delta the
 *         batch writes == the Delta a visual's OPENROWSET reads.  DirectQuery /
 *         Direct-Lake-only reports have nothing to materialize → a 200 `live`
 *         no-op.  A Synapse/ADLS infra gate from the engine surfaces verbatim as
 *         a 412 (no mock, no silent partial — no-vaporware.md).
 *  4. Persist `state.lastRefresh[table] = { at, batchId, deltaUrl, status,
 *     trigger }` additively (updateOwnedItem) so the editor's last-refreshed
 *     badge + the resolver's `cacheReady` flag are real.
 *
 * ── GET: last-refreshed state + schedule honest-gate ────────────────────────
 *  Returns the persisted `lastRefresh` map and a `schedule` block.  Recurring
 *  scheduled refresh is an HONEST gate (an ADF "Refresh materialized lake view"
 *  pipeline shape exists — buildRefreshAdfPipeline — but the recurring trigger
 *  is not wired yet), naming the exact remediation (LOOM_ADF_FACTORY).
 *
 * No Fabric / Power BI / OneLake host is reached on the default path; every
 * backend is Azure-native (Synapse Spark + ADLS Delta, or Azure Analysis
 * Services).  No mock data — the receipt is a real Livy batch id + Delta URL, or
 * an honest, actionable gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getReport, refreshDataset, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import { updateOwnedItem } from '../../../_lib/item-crud';
import {
  resolveReportModel,
  readReportDataSource,
  reportTableMlvSpec,
  bracket,
  isStorageMode,
  type StorageMode,
  type SourceGroupSqlSource,
  type TableSourceBinding,
} from '@/lib/azure/report-model-resolver';
import { refreshMaterializedLakeView } from '@/lib/azure/materialized-lake-view-engine';
import {
  asyncRefresh,
  applyRefreshPolicy,
  aasConfigGate,
  AasError,
} from '@/lib/azure/aas-incremental-refresh';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST body — all optional. `biBackend`/`workspaceId` opt into Power BI refresh. */
interface RefreshBody {
  /** Refresh only this model table (else every Import/Dual table). */
  table?: string;
  /** Explicit opt-in to the Power BI dataset-refresh path. */
  biBackend?: 'powerbi';
  /** Power BI workspace (group) id — required by the opt-in BI path. */
  workspaceId?: string;
}

/** A table to re-materialize: its name + the base SELECT its cache holds. */
interface MaterializeTable {
  table: string;
  baseSelectSql: string;
  mode: StorageMode;
}

/** One persisted refresh record on `state.lastRefresh[table]`. */
interface LastRefreshRecord {
  at: string;
  batchId: string;
  deltaUrl: string;
  status: 'submitted';
  trigger: 'editor';
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers.
// ───────────────────────────────────────────────────────────────────────────

/** Validate a persisted `state.tableStorage` bag into mode-per-table. */
function parseTableStorage(value: unknown): Record<string, { mode: StorageMode }> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, { mode: StorageMode }> = {};
  for (const [table, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const mode = (raw as Record<string, unknown>).mode;
    if (isStorageMode(mode)) out[table] = { mode };
  }
  return out;
}

/**
 * Reconstruct a table's base SELECT — what the MLV Spark batch materializes —
 * from a resolved source-group binding's LIVE relation.  Mirrors the resolver's
 * own `relationsFromTableMap` / direct-query base SELECT EXACTLY (a table maps to
 * `SELECT * FROM [schema].[table]`; a derived relation reuses its guarded SELECT)
 * so the Delta this batch writes is the Delta the resolver's cache reads.
 */
function baseSelectFromBinding(b: TableSourceBinding): string | null {
  const from = b.live?.from;
  if (!from) return null;
  if (from.kind === 'table') {
    const rel = from.schema ? `${bracket(from.schema)}.${bracket(from.table)}` : bracket(from.table);
    return `SELECT * FROM ${rel}`;
  }
  if (from.kind === 'derived') {
    return from.sql && from.sql.trim() ? from.sql : null;
  }
  return null;
}

/** Import/Dual tables (with their base SELECT) from a loom-native source-group source. */
function materializableFromSourceGroups(sg: SourceGroupSqlSource): MaterializeTable[] {
  const out: MaterializeTable[] = [];
  for (const [table, binding] of Object.entries(sg.bindings)) {
    // DirectQuery = live only; DirectLake = serverless OPENROWSET over the
    // table's own Delta (no materialization step). Only Import/Dual cache.
    if (binding.storageMode !== 'Import' && binding.storageMode !== 'Dual') continue;
    const baseSelectSql = baseSelectFromBinding(binding);
    if (baseSelectSql) out.push({ table, baseSelectSql, mode: binding.storageMode });
  }
  return out;
}

/**
 * Import/Dual tables for a connection-backed report.  The resolver hands
 * connection sources a ConnectionExecutor (not a source-group source), so the
 * per-table cache base SELECT is derived from the persisted connection objectRef
 * + `state.tableStorage`.  The table name matches the executor's Fields-pane
 * table name (`ref.table` for a table object, `'Query'` for a custom SELECT).
 */
function materializableFromConnection(
  item: WorkspaceItem,
  tableStorage: Record<string, { mode: StorageMode }>,
): MaterializeTable[] {
  const source = readReportDataSource(item);
  if (!source || source.kind !== 'connection') return [];
  const ref = source.objectRef;
  let table: string;
  let baseSelectSql: string;
  if (ref.mode === 'table') {
    table = ref.table;
    const rel = ref.schema ? `${bracket(ref.schema)}.${bracket(ref.table)}` : bracket(ref.table);
    baseSelectSql = `SELECT * FROM ${rel}`;
  } else if (ref.mode === 'query') {
    table = 'Query';
    baseSelectSql = ref.sql;
  } else {
    // file / kql connection objects are not a materializable tabular cache here.
    return [];
  }
  const ts = tableStorage[table];
  if (!ts || (ts.mode !== 'Import' && ts.mode !== 'Dual')) return [];
  return [{ table, baseSelectSql, mode: ts.mode }];
}

/** Derive the report's current refresh mode for GET (cheap — no Synapse probe). */
function deriveRefreshMode(item: WorkspaceItem): 'aas' | 'materialize' | 'live' {
  const source = readReportDataSource(item);
  if (source?.kind === 'aas') return 'aas';
  const ts = parseTableStorage((item.state as Record<string, unknown> | undefined)?.tableStorage);
  for (const v of Object.values(ts)) {
    if (v.mode === 'Import' || v.mode === 'Dual') return 'materialize';
  }
  return 'live';
}

/** Honest gate copy when AAS incremental refresh is selected but unconfigured. */
const AAS_REFRESH_GATE =
  'Azure Analysis Services refresh needs its XMLA endpoint. Set LOOM_AAS_XMLA_ENDPOINT (the AAS ' +
  'model URL, e.g. https://<region>.asazure.windows.net/servers/<server>/models/<model>) and grant ' +
  'the Console managed identity server administrator on the AAS instance. AAS is Azure-native — no ' +
  'Microsoft Fabric required — or switch the report to a Loom semantic model (the default).';

/** Honest gate copy for the not-yet-wired recurring refresh schedule. */
const SCHEDULE_GATE =
  'A recurring refresh schedule needs an Azure Data Factory to host the "Refresh materialized lake ' +
  'view" pipeline. Set LOOM_ADF_FACTORY (and grant the Console managed identity Data Factory ' +
  'Contributor) to enable scheduled refresh. Until then use Refresh now. No Microsoft Fabric required.';

// ───────────────────────────────────────────────────────────────────────────
// POST — Azure-native re-materialization (default) / opt-in Power BI refresh.
// ───────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;
  const oid = session.claims.oid;

  const body = (await req.json().catch(() => ({}))) as RefreshBody;

  const item = await loadContentBackedItem(cosmosId, 'report', oid);
  const state = (item?.state || {}) as Record<string, unknown>;

  // ── OPT-IN Power BI refresh — the ONLY api.powerbi.com touch, never default.
  // Triggered only by an explicit signal (report state.biBackend or a body flag)
  // PLUS a workspace id. Works even when the report isn't a Loom item (back-compat
  // with the original workspaceId-in-body caller).
  const optInPowerBi = state.biBackend === 'powerbi' || body.biBackend === 'powerbi';
  const workspaceId = (body.workspaceId || (typeof state.biWorkspaceId === 'string' ? state.biWorkspaceId : '') || '')
    .toString()
    .trim();
  if (optInPowerBi && workspaceId) {
    const pbiReportId = (typeof state.biReportId === 'string' && state.biReportId.trim()
      ? state.biReportId.trim()
      : rawId);
    try {
      const report = await getReport(workspaceId, pbiReportId);
      if (!report.datasetId) {
        return NextResponse.json(
          { ok: false, error: 'report has no underlying dataset to refresh (e.g. a live-connection or RDL report)' },
          { status: 409 },
        );
      }
      await refreshDataset(workspaceId, report.datasetId);
      return NextResponse.json({ ok: true, mode: 'powerbi', datasetId: report.datasetId });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // ── DEFAULT path requires the owned Loom report item.
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // Resolve the report's data source → its Azure-native backend.
  let resolved: Awaited<ReturnType<typeof resolveReportModel>>;
  try {
    resolved = await resolveReportModel(item, oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Unbound → honest 412 (pick a data source).
  if (resolved.backend === 'unbound') {
    return NextResponse.json(
      {
        ok: false,
        code: 'gate',
        error: resolved.gate.error,
        ...(resolved.gate.missing ? { missing: resolved.gate.missing } : {}),
      },
      { status: 412 },
    );
  }

  // AAS-bound → Azure Analysis Services async refresh (Azure PaaS opt-in backend).
  if (resolved.backend === 'aas') {
    const gate = aasConfigGate();
    if (gate) {
      return NextResponse.json(
        { ok: false, code: 'gate', error: AAS_REFRESH_GATE, missing: gate.missing },
        { status: 412 },
      );
    }
    try {
      if (body.table) {
        // Per-table apply (rebuilds that table's incremental-refresh partitions).
        await applyRefreshPolicy(body.table, { type: 'full' });
        return NextResponse.json({ ok: true, mode: 'aas', table: body.table });
      }
      const { requestId } = await asyncRefresh({ type: 'full', applyRefreshPolicy: true });
      return NextResponse.json({ ok: true, mode: 'aas', requestId });
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // loom-native | connection → Azure-native materialization of Import/Dual tables.
  const tableStorage = parseTableStorage(state.tableStorage);
  let tables: MaterializeTable[] =
    resolved.backend === 'loom-native'
      ? resolved.sqlSource.mode === 'source-groups'
        ? materializableFromSourceGroups(resolved.sqlSource)
        : [] // table-map / derived ⇒ no per-table storage ⇒ nothing to materialize
      : materializableFromConnection(item, tableStorage);

  // Scope to a single table when requested.
  if (body.table) tables = tables.filter((t) => t.table === body.table);

  // DirectQuery / Direct-Lake only — live source, nothing to materialize (no-op).
  if (tables.length === 0) {
    return NextResponse.json({
      ok: true,
      mode: 'live',
      message: 'Live source (DirectQuery/Direct Lake) — nothing to materialize.',
    });
  }

  // Persist whatever has materialized so far (called on success AND before a gate
  // so earlier real submits are never lost).
  const refreshed: Array<{ table: string; batchId: string; deltaUrl: string }> = [];
  const now = new Date().toISOString();
  const lastRefresh: Record<string, LastRefreshRecord> = {
    ...((state.lastRefresh as Record<string, LastRefreshRecord> | undefined) || {}),
  };
  async function persist(): Promise<void> {
    if (refreshed.length === 0) return;
    const newState = { ...state, lastRefresh };
    await updateOwnedItem(cosmosId, 'report', oid, { state: newState });
  }

  for (const t of tables) {
    // The SHARED MLV spec — the resolver builds the read-side cache relation from
    // this exact spec, so the Spark batch writes the Delta the report reads.
    const spec = reportTableMlvSpec(item.id, t.table, t.baseSelectSql);
    let outcome: Awaited<ReturnType<typeof refreshMaterializedLakeView>>;
    try {
      outcome = await refreshMaterializedLakeView(spec, { itemId: item.id, trigger: 'editor' });
    } catch (e: any) {
      await persist();
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }

    if (outcome.ok) {
      const batchId = String(outcome.batch.id);
      refreshed.push({ table: t.table, batchId, deltaUrl: outcome.deltaUrl });
      lastRefresh[t.table] = {
        at: now,
        batchId,
        deltaUrl: outcome.deltaUrl,
        status: 'submitted',
        trigger: 'editor',
      };
    } else if (outcome.gate) {
      // Honest, actionable Synapse/ADLS infra gate — surfaced verbatim.
      await persist();
      return NextResponse.json(
        {
          ok: false,
          code: 'gate',
          error: outcome.error,
          remediation: outcome.remediation,
          missing: outcome.code,
          ...(outcome.link ? { link: outcome.link } : {}),
        },
        { status: 412 },
      );
    } else {
      await persist();
      return NextResponse.json({ ok: false, error: outcome.error }, { status: 502 });
    }
  }

  await persist();
  return NextResponse.json({ ok: true, mode: 'materialize', refreshed, lastRefresh });
}

// ───────────────────────────────────────────────────────────────────────────
// GET — last-refreshed state + recurring-schedule honest gate.
// ───────────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  const state = (item.state || {}) as Record<string, unknown>;
  const lastRefresh = (state.lastRefresh as Record<string, unknown> | undefined) || {};

  return NextResponse.json({
    ok: true,
    mode: deriveRefreshMode(item),
    lastRefresh,
    schedule: {
      configured: false,
      gate: { error: SCHEDULE_GATE, missing: 'LOOM_ADF_FACTORY' },
    },
  });
}
