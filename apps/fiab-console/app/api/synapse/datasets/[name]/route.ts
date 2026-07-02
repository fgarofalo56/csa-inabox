/**
 * A single dataset on the deployment-default Synapse workspace.
 *
 *   GET /api/synapse/datasets/[name]  → { ok, dataset: { name, properties } }
 *
 * Backs the Manage hub's "edit existing dataset" flow for Synapse: the workspace
 * list GET only returns { name, type }, so this returns the full dataset
 * (linked service + location/typeProperties + schema) needed to prefill the
 * DatasetWizard in edit mode. Workspace is the env-pinned default; honest 503
 * gate when LOOM_SYNAPSE_WORKSPACE isn't set. Real Synapse dev-plane REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { synapseConfigGate, getDataset } from '@/lib/azure/synapse-artifacts-client';

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

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const { name } = await ctx.params;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const dataset = await getDataset(name);
    return NextResponse.json({ ok: true, dataset });
  } catch (e: any) {
    const status = /not\s*found|404/i.test(e?.message || '') ? 404 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
