/**
 * POST /api/items/digital-twin/[id]/query  (FGC-12)
 *   body: { pattern: string, mode?: 'kql-graph' | 'opencypher', database?: string,
 *           backend?: 'adx' | 'adt' }
 *
 * Twin-graph explorer — run a `graph-match` (or openCypher) pattern over the
 * materialized twin graph on Azure Data Explorer. By DEFAULT (backend:'adx')
 * this discovers the twin's `DT_<key>_E_*` / `DT_<key>_R_*` tables, builds the
 * labeled property graph with KQL `make-graph`, then runs the caller's pattern
 * against `G` — the SAME Kusto graph engine "Graph in Fabric" is built on, with
 * NO Microsoft Fabric dependency.
 *
 * Azure Digital Twins (backend:'adt') is a strict opt-in alternate, honest-gated
 * on LOOM_ADT_ENDPOINT — never the default (per .claude/rules/no-fabric-dependency.md,
 * FGC-12: ADX-native graph is the DEFAULT, Azure Digital Twins strictly opt-in).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { executeQuery, listTables, defaultDatabase, kustoConfigGate, KustoError } from '@/lib/azure/kusto-client';
import {
  normalizeTwinModel, buildTwinGraphPrelude, composeTwinGraphQuery, twinKey, entityTable, relTable,
} from '@/lib/editors/digital-twin-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  const item = await loadOwnedItem(id, 'digital-twin', s.claims.oid, { allowReadRoles: true });
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const pattern: string = (body?.pattern || '').toString();
  const mode: string = body?.mode === 'opencypher' ? 'opencypher' : 'kql-graph';
  const backend: string = body?.backend === 'adt' ? 'adt' : 'adx';
  if (!pattern.trim()) return NextResponse.json({ ok: false, error: 'pattern required' }, { status: 400 });

  // ── Azure Digital Twins (opt-in only) ──────────────────────────────────
  if (backend === 'adt') {
    const endpoint = process.env.LOOM_ADT_ENDPOINT;
    if (!endpoint) {
      return NextResponse.json({
        ok: false,
        code: 'adt_not_configured',
        error: 'Azure Digital Twins backend is opt-in and requires LOOM_ADT_ENDPOINT (deploy platform/fiab/bicep/modules/integration/adt-instance.bicep and grant the Console UAMI Azure Digital Twins Data Owner). The default Azure-native ADX backend needs no ADT — omit backend:"adt" to use it.',
      }, { status: 503 });
    }
    return NextResponse.json({
      ok: false,
      code: 'adt_query_deferred',
      error: 'Azure Digital Twins is configured but ADT twin-query dispatch is a tracked FGC-12 follow-up. Use the default ADX backend for graph exploration.',
    }, { status: 501 });
  }

  // ── Azure-native default: ADX Kusto graph engine ───────────────────────
  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      code: 'not_configured',
      error: `Twin-graph query needs Azure Data Explorer. Set ${gate.missing} (the ADX cluster that backs Loom twins) and grant the Console UAMI Database Viewer. No Microsoft Fabric required.`,
    }, { status: 503 });
  }

  const model = normalizeTwinModel(item.state as Record<string, unknown>);
  const key = twinKey(id);
  const db = String(body?.database || model.database || defaultDatabase());
  try {
    const live = new Set((await listTables(db)).map((t) => t.name));
    const nodeTables = model.entities.map((e) => entityTable(key, e.apiName)).filter((t) => live.has(t));
    const edgeTables = model.relationships.map((r) => relTable(key, r.apiName)).filter((t) => live.has(t));
    if (nodeTables.length === 0 || edgeTables.length === 0) {
      return NextResponse.json({
        ok: false,
        error: 'No materialized twin graph found. Define entities + relationships and click Build twin graph first (creates DT_*/DT_* tables in ADX).',
      }, { status: 400 });
    }

    const prelude = buildTwinGraphPrelude(nodeTables, edgeTables);
    const directives = mode === 'opencypher'
      ? '#crp query_language=opencypher\n#crp query_graph_reference=G\n'
      : '';
    const full = `${directives}${composeTwinGraphQuery(prelude, pattern)}`;

    const result = await executeQuery(db, full);
    return NextResponse.json({
      ok: true, backend: 'adx', mode, database: db,
      graph: { nodeTables, edgeTables }, ...result,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return NextResponse.json({ ok: false, error: raw.slice(0, 600) }, { status: status === 401 || status === 403 ? 200 : 502 });
  }
}
