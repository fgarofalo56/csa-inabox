/**
 * PUT /api/items/stream-analytics-job/[name]/outputs
 *   Body: AsaOutputCreateSpec
 *   Real ARM PUT against Microsoft.StreamAnalytics/streamingjobs/{name}/outputs/{spec.name}
 *
 * DELETE /api/items/stream-analytics-job/[name]/outputs?outputName=foo
 *   Real ARM DELETE for the named output.
 *
 * No mock arrays. Honest 501 gate when ASA env vars are unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createOrUpdateOutput,
  deleteOutput,
  AsaNotConfiguredError,
  type AsaOutputCreateSpec,
} from '@/lib/azure/stream-analytics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different).';

function bad(status: number, error: string, hint?: string) {
  return NextResponse.json({ ok: false, error, hint }, { status });
}

export async function PUT(req: NextRequest, ctx: { params: { name: string } }) {
  const s = getSession();
  if (!s) return bad(401, 'unauthenticated');
  const jobName = ctx.params?.name;
  if (!jobName) return bad(400, 'job name required');

  let spec: AsaOutputCreateSpec;
  try {
    spec = (await req.json()) as AsaOutputCreateSpec;
  } catch {
    return bad(400, 'invalid JSON body');
  }
  if (!spec?.name) return bad(400, 'output name required');
  if (!spec.datasourceType) return bad(400, 'datasourceType required');

  try {
    const created = await createOrUpdateOutput(jobName, spec);
    return NextResponse.json({ ok: true, output: created });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return bad(501, e.message, HINT);
    }
    return bad(502, e?.message || String(e), HINT);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: { name: string } }) {
  const s = getSession();
  if (!s) return bad(401, 'unauthenticated');
  const jobName = ctx.params?.name;
  const outputName = new URL(req.url).searchParams.get('outputName');
  if (!jobName) return bad(400, 'job name required');
  if (!outputName) return bad(400, 'outputName query param required');

  try {
    await deleteOutput(jobName, outputName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return bad(501, e.message, HINT);
    }
    return bad(502, e?.message || String(e), HINT);
  }
}
