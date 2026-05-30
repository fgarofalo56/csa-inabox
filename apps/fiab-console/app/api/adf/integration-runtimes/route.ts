/**
 * Integration runtimes on the deployment-default Data Factory (the Manage hub).
 *
 *   GET    /api/adf/integration-runtimes            → { ok, runtimes: [{...ir, state}] }
 *          (each IR enriched with its live state via getStatus)
 *   POST   /api/adf/integration-runtimes
 *          body { name, properties }              → upsert (Managed | SelfHosted)
 *          body { name, action: 'start'|'stop' }  → lifecycle (SelfHosted node set)
 *   DELETE /api/adf/integration-runtimes?name=NAME → delete
 *
 * Factory is the env-pinned default; honest 503 gate when LOOM_SUBSCRIPTION_ID /
 * LOOM_DLZ_RG / LOOM_ADF_NAME aren't set. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfConfigGate,
  listIntegrationRuntimes, getIntegrationRuntimeStatus, upsertIntegrationRuntime,
  startIntegrationRuntime, stopIntegrationRuntime, deleteIntegrationRuntime,
  type AdfIntegrationRuntime,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

function gate() {
  const g = adfConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Data Factory not configured: set ${g.missing}.`, missing: g.missing },
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
    const irs = await listIntegrationRuntimes();
    // Enrich with live state. getStatus per IR is best-effort — a failing
    // status probe must not blank the whole list.
    const runtimes = await Promise.all(
      irs.map(async (ir) => {
        let state: string | undefined;
        try {
          const st = await getIntegrationRuntimeStatus(ir.name);
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
    if (body.action === 'start') { await startIntegrationRuntime(name); return NextResponse.json({ ok: true, action: 'start' }); }
    if (body.action === 'stop')  { await stopIntegrationRuntime(name);  return NextResponse.json({ ok: true, action: 'stop' }); }

    const properties = body?.properties as AdfIntegrationRuntime['properties'] | undefined;
    if (!properties || (properties.type !== 'Managed' && properties.type !== 'SelfHosted')) {
      return NextResponse.json({ ok: false, error: "properties.type must be 'Managed' or 'SelfHosted'" }, { status: 400 });
    }
    const saved = await upsertIntegrationRuntime(name, { name, properties });
    return NextResponse.json({ ok: true, runtime: { name: saved.name, type: saved.properties?.type, description: saved.properties?.description } });
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
    await deleteIntegrationRuntime(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
