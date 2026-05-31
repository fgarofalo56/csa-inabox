/**
 * Data flows (Synapse Mapping Data Flows) on the deployment-default Synapse
 * workspace. Backs the "Data flows" group in the Workspace Resources navigator.
 *
 *   GET    /api/synapse/dataflows            → { ok, dataflows: [{name, type}] }
 *   POST   /api/synapse/dataflows            body { name, properties? } → upsert
 *   DELETE /api/synapse/dataflows?name=NAME  → delete
 *
 * When `properties` is omitted, a minimal empty MappingDataFlow is created so
 * the operator can open it and design the transformation. Workspace is the
 * env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE isn't set.
 * Real Synapse dev-plane REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, listDataFlows, upsertDataFlow, deleteDataFlow,
  type SynapseDataFlow,
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
    const dataflows = (await listDataFlows()).map((d) => ({
      name: d.name,
      type: d.properties?.type || 'MappingDataFlow',
    }));
    return NextResponse.json({ ok: true, dataflows });
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
  const properties = (body?.properties as SynapseDataFlow['properties']) || {
    // A minimal-but-valid empty Mapping Data Flow: no sources/sinks yet, an
    // empty script. The operator wires sources/transforms/sinks afterwards.
    type: 'MappingDataFlow',
    typeProperties: { sources: [], sinks: [], transformations: [], scriptLines: [] },
  };
  if (typeof properties.type !== 'string') properties.type = 'MappingDataFlow';
  try {
    const saved = await upsertDataFlow(name, { name, properties });
    return NextResponse.json({ ok: true, dataflow: { name: saved.name, type: saved.properties?.type } });
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
    await deleteDataFlow(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
