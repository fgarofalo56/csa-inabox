/**
 * Single KQL script artifact on the deployment-default workspace. Backs the
 * KQL-script editor (Synapse Studio Develop hub → KQL scripts → open a script):
 * returns the FULL script shape (content.query + currentConnection) so the
 * editor can render the query text + Connect/Database selection, and lists the
 * workspace's live Kusto pools + the selected pool's databases for the
 * "Connect to" / "Use database" dropdowns.
 *
 *   GET    /api/synapse/kqlscripts/[name]            → { ok, kqlScript:{name,properties}, pools, databases }
 *   GET    /api/synapse/kqlscripts/[name]?pool=NAME  → databases for that pool (dropdown change)
 *   PUT    /api/synapse/kqlscripts/[name] body { properties } → upsert full script
 *   DELETE /api/synapse/kqlscripts/[name]            → delete
 *
 * Real Synapse dev-plane REST (api-version 2020-12-01) + ARM kustoPools.
 * Honest 503 gate when LOOM_SYNAPSE_WORKSPACE unset. No mocks.
 *
 * Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/kql-scripts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, getKqlScript, upsertKqlScript, deleteKqlScript,
  type SynapseKqlScript,
} from '@/lib/azure/synapse-artifacts-client';
import { listKustoPools, listKustoPoolDatabases } from '@/lib/azure/synapse-dev-client';

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

export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid KQL script name' }, { status: 400 });
  const poolParam = req.nextUrl.searchParams.get('pool')?.trim();
  try {
    // Pool-only probe (dropdown change in the editor) — just return databases.
    if (poolParam) {
      const databases = await listKustoPoolDatabases(poolParam).catch(() => []);
      return NextResponse.json({ ok: true, databases });
    }
    const sc = await getKqlScript(name);
    if (!sc) return NextResponse.json({ ok: false, error: `KQL script '${name}' not found` }, { status: 404 });
    const pools = await listKustoPools().catch(() => []);
    const selectedPool = sc.properties?.content?.currentConnection?.poolName;
    const databases = selectedPool ? await listKustoPoolDatabases(selectedPool).catch(() => []) : [];
    return NextResponse.json({
      ok: true,
      kqlScript: { name: sc.name, properties: sc.properties },
      pools: pools.map((p) => ({ name: p.name, state: p.state })),
      databases,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const properties = body?.properties as SynapseKqlScript['properties'] | undefined;
  if (!properties || typeof properties !== 'object') {
    return NextResponse.json({ ok: false, error: 'properties is required' }, { status: 400 });
  }
  try {
    const saved = await upsertKqlScript(name, { name, properties });
    return NextResponse.json({ ok: true, kqlScript: { name: saved.name || name } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid KQL script name' }, { status: 400 });
  try {
    await deleteKqlScript(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
