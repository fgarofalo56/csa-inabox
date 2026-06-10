/**
 * GET    /api/items/automl/jobs/[name]   — poll a single AutoML job's status
 * DELETE /api/items/automl/jobs/[name]   — cancel a running AutoML job
 *
 * Real ARM:
 *   GET  .../workspaces/{ws}/jobs/{name}?api-version=2024-10-01
 *   POST .../workspaces/{ws}/jobs/{name}/cancel?api-version=2024-10-01
 *
 * Honest gate: 200 + { ok:false, configured:false, hint } when env unset.
 * Azure-native default — no Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getAutoMlJob, cancelAutoMlJob, automlConfigGate, AutoMlError } from '@/lib/azure/aml-automl-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gateResponse(missing: string) {
  return NextResponse.json(
    {
      ok: false,
      configured: false,
      error: 'Azure ML workspace not configured',
      hint: `Set ${missing} to monitor AutoML runs.`,
    },
    { status: 200 },
  );
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { name } = await params;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  const gate = automlConfigGate();
  if (gate) return gateResponse(gate.missing);

  try {
    const job = await getAutoMlJob(name);
    if (!job) return NextResponse.json({ ok: false, error: 'job not found' }, { status: 404 });
    return NextResponse.json({ ok: true, configured: true, job });
  } catch (e: any) {
    const status = e instanceof AutoMlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { name } = await params;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  const gate = automlConfigGate();
  if (gate) return gateResponse(gate.missing);

  try {
    await cancelAutoMlJob(name);
    return NextResponse.json({ ok: true, configured: true, canceled: name });
  } catch (e: any) {
    const status = e instanceof AutoMlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
