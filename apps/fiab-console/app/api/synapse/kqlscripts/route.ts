/**
 * KQL scripts on the deployment-default Synapse workspace. Backs the "KQL
 * scripts" group in the Workspace Resources navigator (the Synapse Studio
 * Develop hub → KQL scripts surface — Data Explorer / Kusto authoring).
 *
 *   GET    /api/synapse/kqlscripts            → { ok, kqlScripts: [{name, pool, database}], pools, databases }
 *   POST   /api/synapse/kqlscripts            body { name, pool?, database? } → upsert (empty script if omitted)
 *   DELETE /api/synapse/kqlscripts?name=NAME  → delete
 *
 * Azure-native default: scripts run against a Synapse Data Explorer (Kusto)
 * pool (Microsoft.Synapse/workspaces/{ws}/kustoPools) — never a Fabric
 * Eventhouse, never a separate ADX deployment. The GET also returns the live
 * Kusto pools (from ARM) so the create dialog + editor can pin a connection.
 *
 * Workspace is the env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE
 * isn't set. Real Synapse dev-plane REST (api-version 2020-12-01). No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, listKqlScripts, upsertKqlScript, deleteKqlScript, emptyKqlScriptProperties,
  type SynapseKqlScript,
} from '@/lib/azure/synapse-artifacts-client';
import { listKustoPools } from '@/lib/azure/synapse-dev-client';

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
    const [scripts, pools] = await Promise.all([
      listKqlScripts(),
      listKustoPools().catch(() => []),
    ]);
    const kqlScripts = scripts.map((sc) => ({
      name: sc.name,
      pool: sc.properties?.content?.currentConnection?.poolName,
      database: sc.properties?.content?.currentConnection?.databaseName,
    }));
    return NextResponse.json({ ok: true, kqlScripts, pools: pools.map((p) => ({ name: p.name, state: p.state })) });
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
  const pool: string | undefined = typeof body?.pool === 'string' && body.pool.trim() ? body.pool.trim() : undefined;
  const database: string | undefined = typeof body?.database === 'string' && body.database.trim() ? body.database.trim() : undefined;
  const properties = (body?.properties as SynapseKqlScript['properties']) || emptyKqlScriptProperties(pool, database);
  try {
    const saved = await upsertKqlScript(name, { name, properties });
    return NextResponse.json({ ok: true, kqlScript: { name: saved.name || name } });
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
    await deleteKqlScript(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
