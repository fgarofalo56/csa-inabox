/**
 * Spark job definitions on the deployment-default Synapse workspace. Backs the
 * "Spark job definitions" group in the Workspace Resources navigator (the
 * Synapse Studio Develop hub → Spark job definitions surface).
 *
 *   GET    /api/synapse/sparkjobdefinitions            → { ok, sparkJobDefinitions: [{name, pool, language}], pools }
 *   POST   /api/synapse/sparkjobdefinitions            body { name, pool } → upsert (empty def targeting the pool)
 *   DELETE /api/synapse/sparkjobdefinitions?name=NAME  → delete
 *
 * Azure-native: a Spark job definition is a batch Spark JAR/.py job that runs
 * as a Livy batch against a Synapse Spark Big Data pool — no Fabric. The GET
 * returns the live Spark pools (from ARM) so the create dialog can pin a target.
 *
 * Workspace is the env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE
 * isn't set. Real Synapse dev-plane REST (api-version 2020-12-01). No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, listSparkJobDefinitions, upsertSparkJobDefinition, deleteSparkJobDefinition,
  emptySparkJobDefinitionProperties,
} from '@/lib/azure/synapse-artifacts-client';
import { listSparkPools } from '@/lib/azure/synapse-dev-client';

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
    const [defs, pools] = await Promise.all([
      listSparkJobDefinitions(),
      listSparkPools().catch(() => []),
    ]);
    const sparkJobDefinitions = defs.map((d) => ({
      name: d.name,
      pool: d.properties?.targetBigDataPool?.referenceName,
      language: d.properties?.language,
    }));
    return NextResponse.json({
      ok: true,
      sparkJobDefinitions,
      pools: (pools || []).map((p: any) => ({ name: p.name, sparkVersion: p.properties?.sparkVersion, nodeSize: p.properties?.nodeSize })),
    });
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
  const pool: string = typeof body?.pool === 'string' ? body.pool.trim() : '';
  // A SJD must target a real Spark pool — there's no Synapse default. Require it.
  const properties = body?.properties || (pool ? emptySparkJobDefinitionProperties(pool) : null);
  if (!properties) {
    return NextResponse.json(
      { ok: false, error: 'pool is required — pick a Spark Big Data pool for the job to run on' },
      { status: 400 },
    );
  }
  try {
    const saved = await upsertSparkJobDefinition(name, { name, properties });
    return NextResponse.json({ ok: true, sparkJobDefinition: { name: saved.name || name } });
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
    await deleteSparkJobDefinition(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
