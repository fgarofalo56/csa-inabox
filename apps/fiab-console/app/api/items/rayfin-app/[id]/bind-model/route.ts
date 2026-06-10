/**
 * /api/items/rayfin-app/[id]/bind-model — the semantic-model binding surface for
 * a Rayfin "data app" (Microsoft Fabric Apps, Build 2026 — "Create an app
 * connected to a semantic model", the --template dataapp flow).
 *
 * The base Rayfin editor covers the GENERAL case: define entities → a backend
 * (SQL database + Data APIs) is generated. The DATA-APP case is different: the
 * app does NOT define its own schema, it BINDS to an existing semantic model and
 * queries it with DAX through the Execute DAX Queries API. This route supplies
 * the two things that flow needs against a REAL backend:
 *
 *   GET  ?workspaceId=<opt> → { ok, models: BoundModelLite[], probe, binding? }
 *        Lists the semantic models the app can bind to:
 *          • Azure-native DEFAULT — Loom-native semantic-model items from Cosmos
 *            (always available, no Fabric/Power BI) + the tabular databases on
 *            the env-pinned Azure Analysis Services server (when configured).
 *          • Opt-in — Power BI / Fabric datasets in a bound workspace (only when
 *            ?workspaceId= is supplied), via the Power BI REST.
 *        `probe` reports which DAX execution path is live so the editor renders
 *        an honest capability badge instead of a dead "Run" button.
 *
 *   POST { modelId, dax, workspaceId?, database?, region? } →
 *        Runs the supplied DAX query against the bound model — the SAME call the
 *        deployed data app makes at runtime (Execute DAX Queries) — so the
 *        operator proves the binding works before `npx rayfin up`:
 *          • Azure-native DEFAULT — AAS XMLA /query (executeDaxQuery) against the
 *            chosen database on the env-pinned AAS server.
 *          • Opt-in — Power BI executeQueries when a workspaceId + live dataset
 *            id are supplied.
 *          • Neither configured → 200 { ok:false, probeUnavailable } (honest
 *            gate, never a dead control) naming the exact env var to set.
 *
 *   PUT  { modelId, name, source, workspaceId?, queries? } → persists the chosen
 *        binding onto state.modelBinding (merged with the base spec).
 *
 * Per .claude/rules/no-fabric-dependency.md the Azure-native path is the DEFAULT
 * and works with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET; Fabric/Power BI is strictly
 * opt-in via ?workspaceId=. Per .claude/rules/no-vaporware.md every value is a
 * real Cosmos/ARM/XMLA/REST read — no mocks, no `return []` placeholders.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import {
  listContentBackedItems, semanticModelDetailFromContent, LOOM_ID_PREFIX,
} from '../../../_lib/pbi-content-fallback';
import {
  listDatabases, aasServerConfigGate, envAasServerName, envAasServerRegion, AasError,
} from '@/lib/azure/aas-server-client';
import { executeDaxQuery, aasConfigGate } from '@/lib/azure/aas-client';
import { listDatasets, executeDatasetQueries, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'rayfin-app';

interface BoundModelLite {
  /** loom:<cosmosId> | aas:<db> | <pbiDatasetId> — opaque id the POST understands. */
  id: string;
  name: string;
  /** Where the model lives — drives the DAX execution path on POST. */
  source: 'loom' | 'aas' | 'powerbi';
  /** Tables (when known) so the editor can suggest a starter DAX query. */
  tableCount?: number;
  /** AAS server processing state / storage mode, surfaced as a chip. */
  detail?: string;
}

/** Which DAX execution path(s) are live right now. */
interface ProbeCapability {
  aasAvailable: boolean;
  powerbiAvailable: boolean;
  /** Honest remediation when nothing is wired. */
  hint?: string;
}

async function loomModels(tenantId: string): Promise<BoundModelLite[]> {
  const items = await listContentBackedItems('semantic-model', 'semantic-model', tenantId);
  return items.map((it) => {
    const detail = semanticModelDetailFromContent(it);
    return {
      id: `${LOOM_ID_PREFIX}${it.id}`,
      name: it.displayName,
      source: 'loom' as const,
      tableCount: detail?.tables?.length ?? 0,
    };
  });
}

async function aasModels(): Promise<BoundModelLite[]> {
  // Honest gate — AAS unconfigured or unavailable in Gov returns no rows; the
  // Loom-native list still makes the picker usable.
  if (aasServerConfigGate()) return [];
  const dbs = await listDatabases();
  return dbs.map((d) => ({
    id: `aas:${d.name}`,
    name: d.name,
    source: 'aas' as const,
    detail: [d.storageMode, d.state].filter(Boolean).join(' · ') || undefined,
  }));
}

async function powerbiModels(workspaceId: string): Promise<BoundModelLite[]> {
  const datasets = await listDatasets(workspaceId);
  return datasets
    .filter((d) => !String(d.id).startsWith(LOOM_ID_PREFIX)) // those are listed via loomModels
    .map((d) => ({ id: d.id, name: d.name, source: 'powerbi' as const }));
}

function probeCapability(workspaceId: string | null): ProbeCapability {
  const aasAvailable = !aasServerConfigGate() && !!envAasServerName();
  const powerbiAvailable = !!workspaceId;
  return {
    aasAvailable,
    powerbiAvailable,
    hint: aasAvailable || powerbiAvailable
      ? undefined
      : 'No live DAX execution path is configured. Set LOOM_AAS_SERVER_NAME + LOOM_AAS_REGION '
        + '(Azure Analysis Services — the Azure-native default), or open this app from a Power BI '
        + 'workspace (pass ?workspaceId=) to query a Fabric/Power BI dataset. Binding is still saved '
        + 'and emitted in the generated data-app scaffold either way.',
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const tenantId = s.claims.oid;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');

  // The base item is optional for listing (the editor lists models before the
  // app is saved), but if an id is supplied we surface the persisted binding.
  let bound: unknown = undefined;
  if (id && id !== 'new') {
    try {
      const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
      bound = (item?.state as any)?.modelBinding;
    } catch { /* listing still works */ }
  }

  const models: BoundModelLite[] = [];
  const errors: string[] = [];

  // Azure-native DEFAULT: Loom-native models (Cosmos) + AAS databases.
  try { models.push(...await loomModels(tenantId)); }
  catch (e: any) { errors.push(`loom: ${e?.message || String(e)}`); }
  try { models.push(...await aasModels()); }
  catch (e: any) { if (!(e instanceof AasError)) errors.push(`aas: ${e?.message || String(e)}`); }

  // Opt-in: Power BI / Fabric datasets when a workspace is supplied.
  if (workspaceId) {
    try { models.push(...await powerbiModels(workspaceId)); }
    catch (e: any) {
      const msg = e instanceof PowerBiError ? `Power BI ${e.status}: ${e.message}` : (e?.message || String(e));
      errors.push(`powerbi: ${msg}`);
    }
  }

  const govGate = aasConfigGate();
  return NextResponse.json({
    ok: true,
    models,
    probe: probeCapability(workspaceId),
    aasServer: envAasServerName() || undefined,
    aasRegion: envAasServerRegion() || undefined,
    ...(bound ? { binding: bound } : {}),
    ...(errors.length ? { notices: errors } : {}),
    ...(govGate ? { govGate } : {}),
  });
}

interface ProbeBody {
  modelId?: string;
  dax?: string;
  workspaceId?: string;
  /** AAS database name override (defaults to the model id's db). */
  database?: string;
  /** AAS region override (defaults to LOOM_AAS_REGION). */
  region?: string;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  await ctx.params; // id not needed for the probe; the model id carries the target
  const body = (await req.json().catch(() => ({}))) as ProbeBody;

  const modelId = (body.modelId || '').trim();
  const dax = (body.dax || '').trim();
  if (!modelId) return NextResponse.json({ ok: false, error: 'modelId is required' }, { status: 400 });
  if (!dax) return NextResponse.json({ ok: false, error: 'a DAX query is required' }, { status: 400 });
  if (!/^\s*(EVALUATE|DEFINE)\b/i.test(dax)) {
    return NextResponse.json(
      { ok: false, error: 'DAX must start with EVALUATE (or DEFINE … EVALUATE) — the Execute DAX Queries API only accepts table queries.' },
      { status: 400 },
    );
  }

  const workspaceId = (body.workspaceId || '').trim() || null;

  // Power BI / Fabric path (opt-in) — only when a workspace + live dataset id.
  if (workspaceId && !modelId.startsWith('aas:') && !modelId.startsWith(LOOM_ID_PREFIX)) {
    try {
      const j = await executeDatasetQueries(workspaceId, modelId, dax);
      const rows = j?.results?.[0]?.tables?.[0]?.rows || [];
      return NextResponse.json({ ok: true, source: 'powerbi', rows, rowCount: rows.length });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
    }
  }

  // Azure-native DEFAULT — AAS XMLA /query against the env-pinned server.
  const gate = aasServerConfigGate();
  const region = (body.region || envAasServerRegion()).trim();
  const server = envAasServerName().trim();
  if (gate || !region || !server) {
    return NextResponse.json({
      ok: false,
      probeUnavailable: true,
      missing: gate?.missing || (!server ? 'LOOM_AAS_SERVER_NAME' : 'LOOM_AAS_REGION'),
      detail:
        'No Azure Analysis Services server is configured for live DAX probing. Set LOOM_AAS_SERVER_NAME '
        + 'and LOOM_AAS_REGION on the Console container app (the Console UAMI needs the AAS server '
        + 'administrator role), or open this app from a Power BI workspace to probe a Fabric/Power BI '
        + 'dataset. The binding + generated data-app scaffold are unaffected — this only runs a live '
        + 'verification query. No Microsoft Fabric workspace is required.',
    });
  }

  const database = (body.database || '').trim()
    || (modelId.startsWith('aas:') ? modelId.slice('aas:'.length) : '');
  if (!database) {
    return NextResponse.json(
      { ok: false, error: 'Select an Azure Analysis Services model (aas:<db>) to probe with DAX, or supply a database name.' },
      { status: 400 },
    );
  }

  try {
    const { columns, rows } = await executeDaxQuery({ region, server, database }, dax);
    return NextResponse.json({ ok: true, source: 'aas', database, columns, rows, rowCount: rows.length });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}

interface BindingBody {
  modelId?: string;
  name?: string;
  source?: BoundModelLite['source'];
  workspaceId?: string;
  /** Named, saved DAX queries the data app ships with. */
  queries?: Array<{ name?: string; dax?: string }>;
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: false, error: 'save the app before binding a model (no id yet)' }, { status: 400 });
  const tenantId = s.claims.oid;
  const body = (await req.json().catch(() => ({}))) as BindingBody;

  // Load current state so we MERGE the binding with the base spec rather than
  // clobbering it (updateOwnedItem replaces state wholesale).
  const current = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  if (!current) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const baseState = (current.state && typeof current.state === 'object' ? current.state : {}) as Record<string, unknown>;

  const modelId = (body.modelId || '').trim();
  if (!modelId) {
    // Empty binding = unbind (revert to the general-case backend).
    const updated = await updateOwnedItem(id, ITEM_TYPE, tenantId, {
      state: { ...baseState, modelBinding: null },
    });
    if (!updated) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, unbound: true, updatedAt: updated.updatedAt });
  }

  const queries = Array.isArray(body.queries)
    ? body.queries
        .map((q) => ({ name: String(q?.name || '').trim(), dax: String(q?.dax || '').trim() }))
        .filter((q) => q.name && q.dax)
    : [];

  const modelBinding = {
    modelId,
    name: String(body.name || '').trim() || modelId,
    source: (body.source as BoundModelLite['source']) || 'loom',
    workspaceId: String(body.workspaceId || '').trim() || undefined,
    queries,
    updatedAt: new Date().toISOString(),
  };

  const updated = await updateOwnedItem(id, ITEM_TYPE, tenantId, {
    state: { ...baseState, modelBinding },
  });
  if (!updated) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, binding: modelBinding, updatedAt: updated.updatedAt });
}
