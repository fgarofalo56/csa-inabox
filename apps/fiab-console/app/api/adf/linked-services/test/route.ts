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

import { NextRequest } from 'next/server';
import { adfConfigGate, testLinkedService, type AdfLinkedService } from '@/lib/azure/adf-client';
import { apiOk, apiError, apiBadRequest } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req: NextRequest) => {
  const g = adfConfigGate();
  if (g) {
    return apiHonestGateError('svc-adf', {
      missing: [g.missing],
      message: `Data Factory not configured: set ${g.missing}.`,
    });
  }
  const body = await req.json().catch(() => ({}));
  const properties = body?.properties as AdfLinkedService['properties'] | undefined;
  if (!properties || typeof properties.type !== 'string') {
    return apiBadRequest('properties.type is required');
  }
  try {
    await testLinkedService({ name: 'test', properties });
    return apiOk();
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
});
