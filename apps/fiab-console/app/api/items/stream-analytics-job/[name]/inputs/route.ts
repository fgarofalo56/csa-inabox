/**
 * PUT /api/items/stream-analytics-job/[name]/inputs
 *   Body: AsaInputCreateSpec
 *   Real ARM PUT against Microsoft.StreamAnalytics/streamingjobs/{name}/inputs/{spec.name}
 *
 * DELETE /api/items/stream-analytics-job/[name]/inputs?inputName=foo
 *   Real ARM DELETE for the named input.
 *
 * No mock arrays. Honest 501 gate when ASA env vars are unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createOrUpdateInput,
  deleteInput,
  AsaNotConfiguredError,
  type AsaInputCreateSpec,
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

  let spec: AsaInputCreateSpec;
  try {
    spec = (await req.json()) as AsaInputCreateSpec;
  } catch {
    return bad(400, 'invalid JSON body');
  }
  if (!spec?.name) return bad(400, 'input name required');
  if (!spec.inputType) return bad(400, 'inputType (Stream|Reference) required');
  if (!spec.datasourceType) return bad(400, 'datasourceType required');
  if (!spec.serialization) return bad(400, 'serialization (Json|Csv|Avro) required');

  try {
    const created = await createOrUpdateInput(jobName, spec);
    return NextResponse.json({ ok: true, input: created });
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
  const inputName = new URL(req.url).searchParams.get('inputName');
  if (!jobName) return bad(400, 'job name required');
  if (!inputName) return bad(400, 'inputName query param required');

  try {
    await deleteInput(jobName, inputName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return bad(501, e.message, HINT);
    }
    return bad(502, e?.message || String(e), HINT);
  }
}
