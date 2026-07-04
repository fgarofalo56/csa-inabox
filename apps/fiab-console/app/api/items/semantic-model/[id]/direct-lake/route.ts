/**
 * /api/items/semantic-model/[id]/direct-lake
 *
 * Two complementary Azure-native Direct Lake surfaces on one route:
 *
 *   POST → DirectQuery-style query with transparent Serverless fallback.
 *   GET  → Direct-Lake-shim wiring status (config + refresh runs + Event Grid).
 *   PUT  → upsert the Direct-Lake-shim config + ensure Event Grid wiring.
 *
 * ── POST: Direct Lake query with Serverless fallback ─────────────────────────
 * Analogous to Fabric's "Direct Lake on SQL" DirectQuery fallback behavior
 * (learn.microsoft.com/fabric/fundamentals/direct-lake-overview#fallback):
 * when the warm AAS cache (a Power BI Import/Premium model whose VertiPaq cache
 * is refreshed on every Gold Delta commit) is FRESH, data is served from the
 * in-memory cache via the Power BI executeQueries REST API. When the cache is
 * STALE or UNBUILT, the SAME data is served transparently via Synapse Serverless
 * OPENROWSET over the Gold Delta files on ADLS Gen2 — no error, no gap.
 *
 * Cache freshness: the last SUCCESSFUL dataset refresh must be within
 * LOOM_DL_CACHE_TTL_SECONDS (default 3600; 0 = always Serverless). If Power BI
 * is unconfigured, the dataset 404s, or the warm DAX query fails, the route
 * falls through to Serverless silently.
 *
 * Body:  { workspaceId: string; table: string; maxRows?: number; sql?: string }
 * Reply: { ok; servingFrom: 'warm-cache'|'serverless-fallback'; columns; rows;
 *          rowCount; executionMs; endpoint?; truncated?; deltaPath?;
 *          lastRefreshedAt?; cacheTtlSeconds? }
 *
 * Honest infra gates (per no-vaporware.md):
 *   - LOOM_SYNAPSE_WORKSPACE missing → 503 naming the var
 *   - LOOM_GOLD_URL missing (when a table query is requested) → 503 naming it
 *
 * No Fabric / OneLake / Power BI dependency on the DEFAULT (Serverless) path
 * (per no-fabric-dependency.md). The warm-cache path is strictly opt-in: it is
 * only attempted when a Power BI workspace is bound and the model was refreshed
 * recently; otherwise Serverless serves every query. RBAC:
 *   Synapse: Console UAMI needs Storage Blob Data Reader on the Gold ADLS
 *            container (already granted by the landing-zone Bicep) + CONNECT on
 *            the serverless DB.
 *   Power BI (warm path only): UAMI must be a workspace Member.
 *
 * ── GET / PUT: Direct-Lake-shim wiring surface ───────────────────────────────
 * Lets an operator point a Power BI semantic model at a real ADLS Gen2 Delta
 * source and have the shim keep a warm AAS (Power BI Premium XMLA) cache fresh —
 * 5–30 s — driven by `_delta_log` Event Grid notifications. This is the
 * Azure-native parity for Fabric Direct Lake (which needs a Fabric F-SKU,
 * unavailable in Gov).
 *
 *   GET  → { ok, shimEnabled, hint?, config?, runs[], eventGrid? }
 *          reads the stored shim config (Cosmos `direct-lake-config`), the last
 *          N enhanced-refresh runs (Power BI), and the Event Grid subscription
 *          status. When the shim is disabled, returns shimEnabled:false + the
 *          honest setup hint (no calls made).
 *
 *   PUT  → upserts the shim config + (best-effort) ensures the Event Grid system
 *          topic + Service Bus subscription for the Delta source's storage
 *          account. Body: { deltaSourcePath, freshnessSlaSeconds, tables[],
 *          workspaceId, datasetId, powerBIWorkspaceId? }.
 *
 * No mocks. Real Cosmos write, real ARM Event Grid PUT, real Power BI history.
 * Honest gates: shim-disabled (LOOM_DIRECT_LAKE_SHIM_ENABLED unset) and
 * Event-Grid-queue-missing (LOOM_DIRECT_LAKE_SHIM_QUEUE_ID unset) are surfaced
 * structurally, never faked.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  executeQuery,
  serverlessTarget,
  getSynapseSqlSuffix,
  buildDeltaOpenRowsetSql,
  goldDeltaBulkUrl,
} from '@/lib/azure/synapse-sql-client';
import { listRefreshHistory, executeDatasetQueries } from '@/lib/azure/powerbi-client';
import {
  listShimRefreshHistory,
  shimEnabled,
  SHIM_DISABLED_HINT,
  AasError,
} from '@/lib/azure/aas-client';
import {
  getShimConfig,
  upsertShimConfig,
  SHIM_REFRESH_POLICIES,
  type DirectLakeShimConfig,
  type ShimTableConfig,
  type ShimRefreshPolicy,
} from '@/lib/azure/direct-lake-config-store';
import {
  ensureShimSubscription,
  getShimSubscriptionStatus,
  parseDeltaSource,
  toAbfss,
  EventGridError,
} from '@/lib/azure/eventgrid-client';
import { xmlaEndpointFromWorkspace } from '@/lib/azure/cloud-endpoints';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Seconds before the warm AAS cache is considered stale. 0 = always Serverless. */
function cacheTtlSeconds(): number {
  const v = parseInt(process.env.LOOM_DL_CACHE_TTL_SECONDS || '3600', 10);
  return isNaN(v) || v < 0 ? 3600 : v;
}

/**
 * ISO timestamp of the last COMPLETED dataset refresh, or null when no completed
 * refresh exists or Power BI is unreachable (unconfigured / 404 / token error) —
 * in which case the caller serves from Serverless.
 */
async function lastCompletedRefreshAt(workspaceId: string, datasetId: string): Promise<string | null> {
  try {
    const history = await listRefreshHistory(workspaceId, datasetId, 10);
    const last = history.find((r) => r.status === 'Completed');
    return last?.endTime ?? null;
  } catch {
    return null;
  }
}

function isCacheWarm(lastRefreshAt: string | null, ttlSeconds: number): boolean {
  if (ttlSeconds === 0 || !lastRefreshAt) return false;
  const ageMs = Date.now() - new Date(lastRefreshAt).getTime();
  if (isNaN(ageMs)) return false;
  return ageMs < ttlSeconds * 1000;
}

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  const table = (body?.table || '').toString().trim();
  const rawSql = (body?.sql || '').toString().trim();
  const maxRows = Math.min(Math.max(1, parseInt(body?.maxRows ?? '1000', 10) || 1000), 5_000);
  const id = (await ctx.params).id;

  if (!table && !rawSql) {
    return NextResponse.json({ ok: false, error: 'table or sql required' }, { status: 400 });
  }

  // Synapse Serverless is required for the fallback path (and for raw sql).
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Synapse Serverless not configured. Set LOOM_SYNAPSE_WORKSPACE to the ' +
          'Synapse workspace whose -ondemand endpoint serves OPENROWSET over the ' +
          'Gold Delta tables, and grant the Console UAMI Storage Blob Data Reader ' +
          'on the Gold container. Required for Direct Lake Serverless fallback.',
        code: 'synapse_not_configured',
      },
      { status: 503 },
    );
  }

  const started = Date.now();
  const endpoint = `${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.${getSynapseSqlSuffix()}`;

  // ── Raw SQL path: always Serverless, skip the cache check. ──────────────────
  if (rawSql) {
    if (rawSql.length > 65_536) {
      return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });
    }
    try {
      const result = await executeQuery(serverlessTarget('master'), rawSql, 60_000);
      return NextResponse.json({ ok: true, servingFrom: 'serverless-fallback', endpoint, ...result });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: sanitize(e), code: e?.code }, { status: 502 });
    }
  }

  // ── Table path: try warm cache, then fall back to Serverless. ───────────────
  const ttl = cacheTtlSeconds();
  // Only probe Power BI when a workspace is actually bound (opt-in warm path).
  const lastAt = workspaceId ? await lastCompletedRefreshAt(workspaceId, id) : null;
  const warm = !!workspaceId && isCacheWarm(lastAt, ttl);

  if (warm) {
    // Warm path: DAX EVALUATE TOPN via the Power BI executeQueries REST API.
    try {
      const dax = `EVALUATE TOPN(${maxRows}, '${escapeSqlLiteral(table)}')`;
      const pbiResult = await executeDatasetQueries(workspaceId, id, dax);
      const pbiRows = pbiResult.results?.[0]?.tables?.[0]?.rows ?? [];
      const columns = pbiRows.length > 0 ? Object.keys(pbiRows[0]) : [];
      return NextResponse.json({
        ok: true,
        servingFrom: 'warm-cache',
        lastRefreshedAt: lastAt,
        cacheTtlSeconds: ttl,
        columns,
        rows: pbiRows.map((r) => columns.map((c) => r[c])),
        rowCount: pbiRows.length,
        executionMs: Date.now() - started,
        truncated: pbiRows.length >= maxRows,
      });
    } catch (e: any) {
      // Power BI query failed (model unloaded, capacity paused, etc.) → fall
      // through transparently to Serverless. Log for diagnostics only.
      console.warn('[direct-lake] warm-cache DAX query failed, falling back to Serverless:', e?.message);
    }
  }

  // ── Serverless fallback path (the Azure-native DEFAULT). ─────────────────────
  let deltaUrl: string;
  try {
    deltaUrl = goldDeltaBulkUrl(table);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message, code: 'gold_url_not_configured' }, { status: 503 });
  }

  const openrowsetSql = buildDeltaOpenRowsetSql(deltaUrl, maxRows);

  try {
    const result = await executeQuery(serverlessTarget('master'), openrowsetSql, 60_000);
    return NextResponse.json({
      ok: true,
      servingFrom: 'serverless-fallback',
      lastRefreshedAt: lastAt,
      cacheTtlSeconds: ttl,
      endpoint,
      deltaPath: deltaUrl,
      ...result,
    });
  } catch (e: any) {
    const raw = sanitize(e);
    if (/timeout|cold/.test(raw)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'synapse_cold_start',
          error:
            'Serverless fallback took longer than 60 seconds (cold-start). ' +
            'Retry — the pool stays warm and subsequent queries run faster.',
        },
        { status: 504 },
      );
    }
    return NextResponse.json({ ok: false, error: raw, code: e?.code }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  if (!shimEnabled()) {
    return NextResponse.json({ ok: true, shimEnabled: false, hint: SHIM_DISABLED_HINT, runs: [], config: null });
  }

  try {
    const config = await getShimConfig(id);
    const workspaceId = req.nextUrl.searchParams.get('workspaceId') || config?.workspaceId || '';

    let runs: Awaited<ReturnType<typeof listShimRefreshHistory>> = [];
    if (workspaceId) {
      try {
        runs = await listShimRefreshHistory({ workspaceId, datasetId: id }, 10);
      } catch (e) {
        // History is best-effort — a model that's never refreshed / a PBI authz
        // gap shouldn't blank the whole panel. Surface as a soft note.
        if (!(e instanceof AasError)) throw e;
      }
    }

    let eventGrid = null;
    if (config?.deltaSourcePath) {
      const ref = parseDeltaSource(config.deltaSourcePath);
      if (ref) {
        try { eventGrid = await getShimSubscriptionStatus(ref.account); }
        catch (e) { if (!(e instanceof EventGridError)) throw e; }
      }
    }

    return NextResponse.json({ ok: true, shimEnabled: true, config: config ?? null, runs, eventGrid });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

interface PutBody {
  deltaSourcePath?: string;
  freshnessSlaSeconds?: number;
  workspaceId?: string;
  datasetId?: string;
  powerBIWorkspaceId?: string;
  tables?: Array<{
    tableName?: string;
    schema?: string;
    policy?: string;
    partitionColumn?: string;
    maxStalenessSeconds?: number;
  }>;
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  if (!shimEnabled()) {
    return NextResponse.json({ ok: false, shimEnabled: false, error: SHIM_DISABLED_HINT }, { status: 409 });
  }

  let body: PutBody;
  try { body = (await req.json()) as PutBody; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const deltaSourcePath = (body.deltaSourcePath || '').trim();
  const workspaceId = (body.workspaceId || '').trim();
  if (!deltaSourcePath) return NextResponse.json({ ok: false, error: 'deltaSourcePath is required' }, { status: 400 });
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId is required' }, { status: 400 });

  const ref = parseDeltaSource(deltaSourcePath);
  if (!ref) {
    return NextResponse.json(
      { ok: false, error: 'deltaSourcePath must be an ADLS Gen2 URI (abfss://container@account.dfs… or https://account.dfs…/container/…)' },
      { status: 400 },
    );
  }

  // Normalise the SLA + per-table policies. The tables map is keyed by
  // "schema.table" (the shim's lookup key); a bare table name defaults to the
  // "dbo" schema so a single-name input still matches.
  const sla = Number.isFinite(body.freshnessSlaSeconds) ? Number(body.freshnessSlaSeconds) : 300;
  const tables: Record<string, ShimTableConfig> = {};
  for (const t of body.tables || []) {
    const name = (t.tableName || '').trim();
    if (!name) continue;
    const policy: ShimRefreshPolicy = SHIM_REFRESH_POLICIES.includes(t.policy as ShimRefreshPolicy)
      ? (t.policy as ShimRefreshPolicy)
      : 'Partition';
    const schema = (t.schema || (name.includes('.') ? name.split('.')[0] : 'dbo')).trim();
    const bareName = name.includes('.') ? name.split('.').slice(1).join('.') : name;
    const key = `${schema}.${bareName}`;
    tables[key] = {
      tableName: bareName,
      policy,
      ...(t.partitionColumn ? { partitionColumn: t.partitionColumn.trim() } : {}),
      maxStalenessSeconds:
        Number.isFinite(t.maxStalenessSeconds) && Number(t.maxStalenessSeconds) > 0
          ? Number(t.maxStalenessSeconds)
          : Math.max(30, sla > 0 ? sla : 30),
    };
  }

  const config: DirectLakeShimConfig = {
    id,
    workspaceId,
    powerBIWorkspaceId: (body.powerBIWorkspaceId || workspaceId).trim(),
    datasetId: (body.datasetId || id).trim(),
    xmlaEndpoint: xmlaEndpointFromWorkspace(workspaceId),
    deltaSourcePath: toAbfss(ref),
    freshnessSlaSeconds: sla,
    tables,
  };

  try {
    const saved = await upsertShimConfig(config, session.claims?.oid || session.claims?.name);

    // Best-effort Event Grid wiring. When LOOM_DIRECT_LAKE_SHIM_QUEUE_ID is
    // unset we DON'T fail the save (the Cosmos config is the shim's source of
    // truth and the aas.bicep deploy may already own the subscription) —
    // instead we return an honest note so the UI can render the gate.
    let eventGrid = null;
    let eventGridNote: string | null = null;
    try {
      eventGrid = await ensureShimSubscription(ref.account);
    } catch (e) {
      if (e instanceof EventGridError) eventGridNote = e.message;
      else throw e;
    }

    return NextResponse.json({ ok: true, config: saved, eventGrid, eventGridNote });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
