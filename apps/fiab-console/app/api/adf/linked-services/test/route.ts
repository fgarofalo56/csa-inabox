/**
 * Test (validate) a linked-service spec against the deployment-default Data
 * Factory BEFORE the user commits it.
 *
 *   POST /api/adf/linked-services/test   body { properties }  → { ok: true } | { ok:false, error }
 *
 * Calls adf-client.testLinkedService, which PUTs a transient linked service
 * under a temp name + deletes it — a real ARM round-trip that surfaces a
 * malformed `typeProperties`, an unknown connector `type`, an unreachable
 * factory, or a rejected credential shape. No mocks (per no-vaporware.md).
 *
 * Factory is the env-pinned default; honest 503 gate when LOOM_SUBSCRIPTION_ID /
 * LOOM_DLZ_RG / LOOM_ADF_NAME aren't set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { adfConfigGate, testLinkedService, type AdfLinkedService } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = adfConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Data Factory not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const properties = body?.properties as AdfLinkedService['properties'] | undefined;
  if (!properties || typeof properties.type !== 'string') {
    return NextResponse.json({ ok: false, error: 'properties.type is required' }, { status: 400 });
  }
  try {
    await testLinkedService({ name: 'test', properties });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
