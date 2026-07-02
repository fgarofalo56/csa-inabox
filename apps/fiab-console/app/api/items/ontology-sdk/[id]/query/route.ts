/**
 * POST /api/items/ontology-sdk/[id]/query
 *   body: { mode:'rest'|'graphql', objectType?, first?, filter?, orderby?, select?, graphql? }
 *   → { ok, mode, url?, columns?, rows?, rowCount?, raw }
 *
 * The live "Try it" API Explorer for a generated Ontology SDK. Proxies the REAL
 * Data API Builder (DAB) runtime — REST (OData) + GraphQL — that serves the
 * bound ontology's object types on Azure Container Apps (Entra auth; the call is
 * made server-side so no token/secret reaches the browser). Runtime base URL is
 * resolved from the item's own `state.serviceUrl` (set at publish) first, then
 * the shared preview runtime `LOOM_DAB_PREVIEW_URL`.
 *
 * Honest infra-gate (503) when neither a per-item DAB serviceUrl nor
 * LOOM_DAB_PREVIEW_URL is set — the full "Try it" surface still renders and the
 * gate names the exact remediation. 100% Azure-native (DAB on ACA), no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'ontology-sdk';
const DAB_RUNTIME_ENV = 'LOOM_DAB_PREVIEW_URL';

function err(error: string, status: number, code?: string, gate?: { reason: string; remediation: string }) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

/** Shape a JSON REST/GraphQL array into the uniform { columns, rows } table. */
function shapeRows(arr: unknown): { columns: string[]; rows: unknown[][] } {
  const records: Array<Record<string, unknown>> = (Array.isArray(arr) ? arr : arr == null ? [] : [arr])
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : { value: r }));
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const rec of records.slice(0, 200)) {
    for (const k of Object.keys(rec)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  }
  const rows = records.map((rec) => columns.map((c) => {
    const v = rec[c];
    return v != null && typeof v === 'object' ? JSON.stringify(v) : v;
  }));
  return { columns, rows };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the Ontology SDK item first (no id yet)', 400, 'no_id');

  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('Ontology SDK item not found', 404, 'not_found');
  const state = (item.state || {}) as Record<string, unknown>;

  const base = (String(state.serviceUrl || '').trim() || String(process.env[DAB_RUNTIME_ENV] || '').trim()).replace(/\/+$/, '');
  if (!base) {
    return err(
      'No Data API runtime is configured for this SDK.',
      503, 'dab_not_configured',
      {
        reason: 'The "Try it" explorer proxies the Data API Builder runtime (Azure Container Apps) that serves this ontology.',
        remediation: `Set this item's DAB service URL (Try it → Runtime), or set ${DAB_RUNTIME_ENV} on the Console. No Microsoft Fabric required.`,
      },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    mode?: string; objectType?: string; first?: number; filter?: string; orderby?: string; select?: string; graphql?: string;
  };
  const mode = body?.mode === 'graphql' ? 'graphql' : 'rest';

  try {
    if (mode === 'graphql') {
      const query = String(body?.graphql || '').trim();
      if (!query) return err('a GraphQL query is required', 400, 'no_query');
      if (query.length > 65_536) return err('GraphQL query too large (>64KB)', 413, 'too_large');
      const graphqlPath = String(state.graphqlPath || '/graphql');
      const url = `${base}${graphqlPath.startsWith('/') ? '' : '/'}${graphqlPath}`;
      const upstream = await fetch(url, {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query }),
      });
      const text = await upstream.text();
      let raw: unknown = text;
      try { raw = text ? JSON.parse(text) : {}; } catch { /* leave as text */ }
      if (!upstream.ok) return err(`GraphQL query failed: HTTP ${upstream.status} — ${text.slice(0, 300)}`, 502, 'graphql_failed');
      // Extract the first array under data.* for a tabular view.
      const data = (raw as any)?.data;
      let firstArray: unknown = null;
      if (data && typeof data === 'object') {
        for (const v of Object.values(data)) {
          if (Array.isArray(v)) { firstArray = v; break; }
          if (v && typeof v === 'object' && Array.isArray((v as any).items)) { firstArray = (v as any).items; break; }
        }
      }
      const shaped = firstArray != null ? shapeRows(firstArray) : { columns: [], rows: [] };
      return NextResponse.json({ ok: true, mode, url, columns: shaped.columns, rows: shaped.rows, rowCount: shaped.rows.length, raw });
    }

    // REST (OData)
    const objectType = String(body?.objectType || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!objectType) return err('an object type is required for a REST query', 400, 'no_object_type');
    const restBase = String(state.restPath || '/api');
    const params = new URLSearchParams();
    if (body?.select) params.set('$select', String(body.select));
    if (body?.filter) params.set('$filter', String(body.filter));
    if (body?.orderby) params.set('$orderby', String(body.orderby));
    params.set('$first', String(Math.min(Math.max(Number(body?.first) || 25, 1), 200)));
    const path = `${restBase.replace(/\/+$/, '')}/${objectType}?${params.toString()}`;
    const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    const upstream = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    const text = await upstream.text();
    let raw: unknown = text;
    try { raw = text ? JSON.parse(text) : {}; } catch { /* leave as text */ }
    if (!upstream.ok) return err(`REST query failed: HTTP ${upstream.status} — ${text.slice(0, 300)}`, 502, 'rest_failed');
    const arr = Array.isArray((raw as any)?.value) ? (raw as any).value : Array.isArray(raw) ? raw : [];
    const shaped = shapeRows(arr);
    return NextResponse.json({ ok: true, mode, url, columns: shaped.columns, rows: shaped.rows, rowCount: shaped.rows.length, raw });
  } catch (e: unknown) {
    return err(`Data API request failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'request_failed');
  }
}
