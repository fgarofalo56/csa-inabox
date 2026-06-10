/**
 * /api/aml/automl/[name]
 *
 * Single AutoML job — status polling (monitoring) + cancel.
 *
 *   GET    /api/aml/automl/{name}   → getAutoMLJob() (poll for the monitor view)
 *   DELETE /api/aml/automl/{name}   → cancelAmlJob() (Cancel button)
 *
 * Real backend (lib/azure/aml-client.ts):
 *   GET  <ws>/jobs/{name}
 *   POST <ws>/jobs/{name}/cancel
 * https://learn.microsoft.com/rest/api/azureml/jobs/get
 * https://learn.microsoft.com/rest/api/azureml/jobs/cancel
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getAutoMLJob,
  cancelAmlJob,
  amlConfigGate,
  AmlError,
} from '@/lib/azure/aml-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gateBody() {
  const gate = amlConfigGate();
  if (!gate) return null;
  return NextResponse.json({
    ok: true,
    configured: false,
    missing: gate.missing,
    hint: `Azure ML workspace not addressable (missing ${gate.missing}).`,
  });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gated = gateBody();
  if (gated) return gated;

  const { name } = await ctx.params;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });

  try {
    const job = await getAutoMLJob(name);
    if (!job) return NextResponse.json({ ok: false, error: 'AutoML job not found' }, { status: 404 });
    return NextResponse.json({ ok: true, configured: true, job });
  } catch (e: any) {
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gated = gateBody();
  if (gated) return gated;

  const { name } = await ctx.params;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });

  try {
    await cancelAmlJob(name);
    return NextResponse.json({ ok: true, configured: true, canceled: name });
  } catch (e: any) {
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
