/**
 * GET /api/items/activator/[id]/adx-source
 * GET /api/items/activator/[id]/adx-source?database=<db>
 *
 * Source-picker metadata for authoring an Activator rule over an Eventhouse /
 * KQL Database (Azure Data Explorer). Returns the real cluster URI + default
 * database (resolved from LOOM_KUSTO_*), the live list of databases on the
 * cluster, and — when ?database is supplied — the tables in that database. This
 * is what lets the editor's Eventhouse source picker offer a real cluster +
 * database + table selection (RTI streams land in ADX, not Log Analytics).
 *
 * Everything comes from live Kusto control commands (kusto-client) — no mocks.
 * When LOOM_KUSTO_* is unset (a non-ADX deploy) or the Console UAMI lacks
 * cluster rights, the call fails and we surface an honest Azure infra-gate
 * (NOT a Fabric gate) so the picker shows a precise MessageBar and the LA source
 * remains available.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  clusterUri, defaultDatabase, listDatabases, listTables, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'activator';

/** Distinct, non-empty ADX databases already bound to this activator's saved
 *  rules (state.rules[].adxDatabase). These are the databases the item is
 *  actually scoped to; the picker defaults to them instead of the whole
 *  shared cluster. */
function boundAdxDatabases(state: Record<string, unknown> | undefined): string[] {
  const rules = Array.isArray((state as any)?.rules) ? ((state as any).rules as any[]) : [];
  const out = new Set<string>();
  for (const r of rules) {
    const db = typeof r?.adxDatabase === 'string' ? r.adxDatabase.trim() : '';
    if (db) out.add(db);
  }
  return [...out];
}

function kustoGate(e: any): NextResponse {
  if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Data Explorer ${e.status}: not authorized to browse the Eventhouse cluster.`,
      gate: { reason: 'The Console UAMI needs query rights on the ADX / Eventhouse cluster.', remediation: 'Grant the Console UAMI AllDatabasesViewer (or Database Viewer) on the ADX cluster. No Microsoft Fabric required.' },
    }, { status: 403 });
  }
  return NextResponse.json({
    ok: false,
    error: `Eventhouse / ADX not reachable: ${e?.message || String(e)}`,
    gate: { reason: 'The ADX / Eventhouse cluster is not configured or reachable.', remediation: 'Set LOOM_KUSTO_CLUSTER_URI (and LOOM_KUSTO_DEFAULT_DB) to your Eventhouse cluster, or author the rule over a Log Analytics source instead. No Microsoft Fabric required.' },
  }, { status: e instanceof KustoError && e.status >= 400 ? e.status : 503 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // OWNERSHIP gate — this route browses databases + tables on the SHARED ADX
  // cluster. A bare session let ANY signed-in user enumerate every database on
  // the cluster (cross-tenant metadata leak). Require that the caller owns the
  // activator item in [id]; 404 (don't leak existence) otherwise. A not-yet-
  // saved activator (id === 'new') only needs a session.
  const { id } = await ctx.params;
  let boundDbs: string[] = [];
  if (id && id !== 'new') {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'activator not found or not owned by you' }, { status: 404 });
    boundDbs = boundAdxDatabases(item.state as Record<string, unknown> | undefined);
  }

  const which = req.nextUrl.searchParams.get('database')?.trim() || '';
  try {
    if (which) {
      // Scope table browsing to a database the activator is already bound to
      // when it has any; otherwise (first ADX rule being authored on an owned
      // item) listing tables for a picked database is acceptable.
      if (boundDbs.length && !boundDbs.includes(which)) {
        return NextResponse.json(
          { ok: false, error: `database "${which}" is not bound to this activator.`, code: 'database_forbidden' },
          { status: 403 },
        );
      }
      const tables = await listTables(which);
      return NextResponse.json({ ok: true, cluster: clusterUri(), database: which, tables });
    }
    // Prefer the activator's own bound database(s) over enumerating the whole
    // shared cluster. Only when the item has no ADX rule yet do we fall back to
    // listing the cluster's databases (acceptable for an owned item) so the
    // picker can author the first rule.
    const databases = boundDbs.length ? boundDbs.map((name) => ({ name })) : await listDatabases();
    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      defaultDatabase: boundDbs[0] || defaultDatabase(),
      databases,
      configured: !!process.env.LOOM_KUSTO_CLUSTER_URI,
    });
  } catch (e: any) {
    return kustoGate(e);
  }
}
