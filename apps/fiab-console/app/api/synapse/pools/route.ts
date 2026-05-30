/**
 * Compute pools attached to the deployment-default Synapse workspace
 * (read-only). Backs the "Spark pools" and "SQL pools" list rows in the
 * Workspace Resources navigator (Synapse Studio Manage hub → Analytics pools).
 *
 *   GET /api/synapse/pools → { ok, sparkPools: [{name, nodeSize, sparkVersion, state}],
 *                                  sqlPools:   [{name, status, sku}] }
 *
 * Read-only here — pool authoring (create / scale / pause / resume) lives in
 * the dedicated scaling editors (/api/admin/scaling/*). Workspace is the
 * env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE isn't set.
 * Real ARM REST (Microsoft.Synapse/workspaces/{ws}/bigDataPools|sqlPools). No mocks.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSparkPools, listDedicatedSqlPools } from '@/lib/azure/synapse-dev-client';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const [spark, sql] = await Promise.all([listSparkPools(), listDedicatedSqlPools()]);
    const sparkPools = spark.map((p) => ({
      name: p.name,
      nodeSize: p.properties?.nodeSize,
      sparkVersion: p.properties?.sparkVersion,
      state: p.properties?.provisioningState,
    }));
    const sqlPools = sql.map((p) => ({ name: p.name, status: p.status, sku: p.sku?.name }));
    return NextResponse.json({ ok: true, sparkPools, sqlPools });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
