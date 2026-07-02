/**
 * Integration runtimes on the deployment-default Synapse workspace (the pipeline
 * Manage hub, Synapse engine).
 *
 *   GET    /api/synapse/integration-runtimes            → { ok, runtimes: [{...ir, state}] }
 *          (each IR enriched with its live state via getStatus)
 *   POST   /api/synapse/integration-runtimes
 *          body { name, properties }                → upsert (Managed | SelfHosted)
 *          body { name, action: 'start'|'stop' }    → lifecycle (SelfHosted node set)
 *          body { name, action: 'authKeys' }        → Self-Hosted install (auth) keys
 *   DELETE /api/synapse/integration-runtimes?name=NAME → delete
 *
 * Workspace is the env-pinned default (LOOM_SYNAPSE_WORKSPACE); honest 503 gate
 * when LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_SYNAPSE_WORKSPACE aren't set.
 * Real Synapse management ARM REST (Microsoft.Synapse/workspaces/{ws}/
 * integrationRuntimes, api-version 2021-06-01). No mocks — the ADF analogue of
 * this route, pointed at the Synapse provider.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate,
  listSynapseIntegrationRuntimes, getSynapseIntegrationRuntimeStatus,
  upsertSynapseIntegrationRuntime, startSynapseIr, stopSynapseIr, deleteSynapseIr,
  listSynapseIrAuthKeys,
  type SynapseIntegrationRuntime,
} from '@/lib/azure/synapse-dev-client';

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
    const irs = await listSynapseIntegrationRuntimes();
    // Enrich with live state. getStatus per IR is best-effort — a failing
    // status probe must not blank the whole list.
    const runtimes = await Promise.all(
      irs.map(async (ir) => {
        let state: string | undefined;
        try {
          const st = await getSynapseIntegrationRuntimeStatus(ir.name);
          state = st.properties?.state;
        } catch { /* leave state undefined */ }
        return {
          name: ir.name,
          type: ir.properties?.type,
          description: ir.properties?.description,
          state,
        };
      }),
    );
    return NextResponse.json({ ok: true, runtimes });
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

  try {
    if (body.action === 'start') { await startSynapseIr(name); return NextResponse.json({ ok: true, action: 'start' }); }
    if (body.action === 'stop')  { await stopSynapseIr(name);  return NextResponse.json({ ok: true, action: 'stop' }); }
    if (body.action === 'authKeys') {
      const authKeys = await listSynapseIrAuthKeys(name);
      return NextResponse.json({ ok: true, authKeys });
    }

    const properties = body?.properties as SynapseIntegrationRuntime['properties'] | undefined;
    if (!properties || (properties.type !== 'Managed' && properties.type !== 'SelfHosted')) {
      return NextResponse.json({ ok: false, error: "properties.type must be 'Managed' or 'SelfHosted'" }, { status: 400 });
    }
    const saved = await upsertSynapseIntegrationRuntime(name, { name, properties });
    return NextResponse.json({ ok: true, runtime: { name: saved.name || name, type: saved.properties?.type, description: saved.properties?.description } });
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
    await deleteSynapseIr(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
