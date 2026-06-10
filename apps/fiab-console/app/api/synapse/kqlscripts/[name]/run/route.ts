/**
 * Run a KQL script against its Synapse Data Explorer (Kusto) pool. Backs the
 * KQL-script editor's "Run" button.
 *
 *   POST /api/synapse/kqlscripts/[name]/run
 *     body { query?, pool?, database? }
 *     → executes the (optionally overridden) query against the pool's database
 *       and returns { ok, columns, columnTypes, rows, rowCount, truncated, executionMs }.
 *
 * Resolution order for the connection: explicit body { pool, database } →
 * the saved script's content.currentConnection. If no pool resolves, returns an
 * honest gate: { ok:false, code:'no_pool', error:'Assign a Kusto pool…' } so the
 * editor shows a precise MessageBar instead of a 500. The pool is a
 * workspace-scoped Synapse Kusto pool — Azure-native, no Fabric, no separate ADX.
 *
 * Real Synapse Kusto pool v1 query REST. Honest 503 gate when
 * LOOM_SYNAPSE_WORKSPACE unset. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, getKqlScript, runKqlOnPool,
} from '@/lib/azure/synapse-artifacts-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

function gate() {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid KQL script name' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  let query: string = typeof body?.query === 'string' ? body.query : '';
  let pool: string = typeof body?.pool === 'string' ? body.pool.trim() : '';
  let database: string = typeof body?.database === 'string' ? body.database.trim() : '';

  try {
    // Fill any missing piece from the saved script.
    if (!query.trim() || !pool || !database) {
      const sc = await getKqlScript(name);
      const conn = sc?.properties?.content?.currentConnection;
      if (!query.trim()) query = sc?.properties?.content?.query || '';
      if (!pool) pool = conn?.poolName || '';
      if (!database) database = conn?.databaseName || '';
    }

    if (!query.trim()) {
      return NextResponse.json({ ok: false, error: 'query is empty — write a KQL query first' }, { status: 400 });
    }
    if (!pool) {
      return NextResponse.json(
        {
          ok: false,
          code: 'no_pool',
          error: 'Assign a Synapse Data Explorer (Kusto) pool before running. Pick a pool in "Connect to", or create one on the workspace (Microsoft.Synapse/workspaces/{ws}/kustoPools).',
        },
        { status: 409 },
      );
    }
    if (!database) {
      return NextResponse.json(
        { ok: false, code: 'no_database', error: 'Select a database in "Use database" before running.' },
        { status: 409 },
      );
    }

    const result = await runKqlOnPool(pool, database, query);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
