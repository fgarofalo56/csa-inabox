/**
 * POST /api/items/ml-experiment/submit
 *
 * Submit a command job (real run) to the Foundry hub. Real ARM PUT of a
 * Command job. Body: { command, environmentId, computeId?, displayName?,
 * experimentName?, codeId? }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { submitCommandJob, FoundryError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.command) return NextResponse.json({ ok: false, error: 'command required' }, { status: 400 });
    if (!body?.environmentId) return NextResponse.json({ ok: false, error: 'environmentId required (azureml:<env>:<ver>)' }, { status: 400 });
    const job = await submitCommandJob({
      command: String(body.command),
      environmentId: String(body.environmentId),
      computeId: body.computeId ? String(body.computeId) : undefined,
      displayName: body.displayName ? String(body.displayName) : undefined,
      experimentName: body.experimentName ? String(body.experimentName) : undefined,
      codeId: body.codeId ? String(body.codeId) : undefined,
    });
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
