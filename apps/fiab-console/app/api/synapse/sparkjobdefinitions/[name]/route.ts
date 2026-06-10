/**
 * Single Spark job definition artifact on the deployment-default workspace.
 * Backs the Spark-job-definition editor (Synapse Studio Develop hub → Spark job
 * definitions → open a definition): returns the FULL definition shape (target
 * pool, language, jobProperties) plus the workspace's live Spark pools for the
 * "Spark pool" dropdown.
 *
 *   GET    /api/synapse/sparkjobdefinitions/[name] → { ok, sparkJobDefinition:{name,properties}, pools }
 *   PUT    /api/synapse/sparkjobdefinitions/[name] body { properties } → upsert full definition
 *   DELETE /api/synapse/sparkjobdefinitions/[name] → delete
 *
 * Real Synapse dev-plane REST (api-version 2020-12-01) + ARM bigDataPools.
 * Honest 503 gate when LOOM_SYNAPSE_WORKSPACE unset. No mocks.
 *
 * Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/spark-job-definition
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, getSparkJobDefinition, upsertSparkJobDefinition, deleteSparkJobDefinition,
  type SynapseSparkJobDefinition,
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

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid Spark job definition name' }, { status: 400 });
  try {
    const def = await getSparkJobDefinition(name);
    if (!def) return NextResponse.json({ ok: false, error: `Spark job definition '${name}' not found` }, { status: 404 });
    const pools = await listSparkPools().catch(() => []);
    return NextResponse.json({
      ok: true,
      sparkJobDefinition: { name: def.name, properties: def.properties },
      pools: (pools || []).map((p: any) => ({ name: p.name, sparkVersion: p.properties?.sparkVersion, nodeSize: p.properties?.nodeSize })),
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
  const properties = body?.properties as SynapseSparkJobDefinition['properties'] | undefined;
  if (!properties || typeof properties !== 'object') {
    return NextResponse.json({ ok: false, error: 'properties is required' }, { status: 400 });
  }
  if (!properties.targetBigDataPool?.referenceName) {
    return NextResponse.json({ ok: false, error: 'targetBigDataPool.referenceName is required — pick a Spark pool' }, { status: 400 });
  }
  try {
    const saved = await upsertSparkJobDefinition(name, { name, properties });
    return NextResponse.json({ ok: true, sparkJobDefinition: { name: saved.name || name } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid Spark job definition name' }, { status: 400 });
  try {
    await deleteSparkJobDefinition(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
