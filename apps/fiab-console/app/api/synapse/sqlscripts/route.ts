/**
 * SQL scripts on the deployment-default Synapse workspace. Backs the "SQL
 * scripts" group in the Workspace Resources navigator (the Synapse Studio
 * Develop hub → SQL scripts surface).
 *
 *   GET    /api/synapse/sqlscripts            → { ok, sqlScripts: [{name, pool}] }
 *   POST   /api/synapse/sqlscripts            body { name, properties? } → upsert (empty serverless script if omitted)
 *   DELETE /api/synapse/sqlscripts?name=NAME  → delete
 *
 * Workspace is the env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE
 * isn't set. Real Synapse dev-plane REST (api-version 2020-12-01). No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, listSqlScripts, upsertSqlScript, deleteSqlScript, emptySqlScriptProperties,
  type SynapseSqlScript,
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

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const sqlScripts = (await listSqlScripts()).map((sq) => ({
      name: sq.name,
      pool: sq.properties?.content?.currentConnection?.poolName,
    }));
    return NextResponse.json({ ok: true, sqlScripts });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _' }, { status: 400 });
  const properties = (body?.properties as SynapseSqlScript['properties']) || emptySqlScriptProperties();
  try {
    const saved = await upsertSqlScript(name, { name, properties });
    return NextResponse.json({ ok: true, sqlScript: { name: saved.name } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteSqlScript(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
