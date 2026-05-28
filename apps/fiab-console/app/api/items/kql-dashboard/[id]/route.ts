/**
 * GET /api/items/kql-dashboard/[id]  — read dashboard tiles from Cosmos state.tiles
 * PUT /api/items/kql-dashboard/[id]  — save tiles
 *
 * state.tiles shape: [{ title: string, kql: string, viz: 'table'|'line'|'bar', database?: string }]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadKustoItem, saveItemState, resolveDatabase, defaultDatabase,
  executeQuery, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Tile {
  title: string;
  kql: string;
  viz: 'table' | 'line' | 'bar';
  database?: string;
}

const VALID_VIZ = new Set(['table', 'line', 'bar']);

function sanitizeTiles(input: any): Tile[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((t: any): Tile => ({
      title: String(t?.title || 'Untitled tile').slice(0, 200),
      kql: String(t?.kql || ''),
      viz: VALID_VIZ.has(t?.viz) ? t.viz : 'table',
      database: t?.database ? String(t.database) : undefined,
    }))
    .filter((t) => t.kql.length > 0 && t.kql.length <= 65_536)
    .slice(0, 100);
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const item = await loadKustoItem(ctx.params.id, 'kql-dashboard', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const tiles: Tile[] = Array.isArray(item.state?.tiles) ? item.state!.tiles : [];

    // Optional ?run=1 — execute every tile and inline its results.
    // Optional ?time=last-1h|last-24h|last-7d|last-30d|all|ago(NNN)
    // Optional ?param.<name>=<value> — substituted into each tile's KQL
    //   anywhere it sees `_loomParam_<name>` (literal token, no escaping).
    const run = req.nextUrl.searchParams.get('run') === '1';
    const timeKey = req.nextUrl.searchParams.get('time') || 'last-24h';
    const TIME_MAP: Record<string, string> = {
      'last-15m': 'ago(15m)',
      'last-1h': 'ago(1h)',
      'last-24h': 'ago(24h)',
      'last-7d': 'ago(7d)',
      'last-30d': 'ago(30d)',
      'all': 'datetime(1970-01-01)',
    };
    const timeFrom = TIME_MAP[timeKey] || timeKey; // allow operators to pass raw ago(...) too

    // Build the param-substitution map from query params named `param.<k>`.
    const paramSubs: Record<string, string> = {};
    req.nextUrl.searchParams.forEach((v, k) => {
      if (k.startsWith('param.')) paramSubs[k.slice(6)] = v;
    });

    const substitute = (kql: string): string => {
      let out = kql.replace(/_loomTimeFrom\b/g, timeFrom);
      for (const [k, v] of Object.entries(paramSubs)) {
        // Best-effort literal substitution. KQL injection is the operator's
        // responsibility (they wrote the dashboard); we don't quote.
        out = out.replace(new RegExp(`_loomParam_${k.replace(/[^a-zA-Z0-9_]/g, '_')}\\b`, 'g'), v);
      }
      return out;
    };

    const rendered = run
      ? await Promise.all(tiles.map(async (t) => {
          try {
            const result = await executeQuery(t.database || resolveDatabase(item), substitute(t.kql));
            return { ...t, result };
          } catch (e: any) {
            return { ...t, error: e?.message || String(e) };
          }
        }))
      : tiles;

    return NextResponse.json({
      ok: true,
      displayName: item.displayName,
      database: resolveDatabase(item),
      defaultDatabase: defaultDatabase(),
      tiles: rendered,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const tiles = sanitizeTiles(body?.tiles);
  try {
    const item = await loadKustoItem(ctx.params.id, 'kql-dashboard', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const patch: Record<string, any> = { tiles };
    if (typeof body?.databaseName === 'string' && body.databaseName.trim()) {
      patch.databaseName = body.databaseName.trim();
    }
    const saved = await saveItemState(item, patch);
    return NextResponse.json({ ok: true, tiles: saved.state?.tiles || [] });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
