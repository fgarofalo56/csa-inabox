/**
 * /api/items/semantic-model/[id]/direct-lake
 *
 * The Direct-Lake-shim wiring surface for a semantic model. Lets an operator
 * point a Power BI semantic model at a real ADLS Gen2 Delta source and have the
 * shim keep a warm AAS (Power BI Premium XMLA) cache fresh — 5–30 s — driven by
 * `_delta_log` Event Grid notifications. This is the Azure-native parity for
 * Fabric Direct Lake (which needs a Fabric F-SKU, unavailable in Gov).
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
