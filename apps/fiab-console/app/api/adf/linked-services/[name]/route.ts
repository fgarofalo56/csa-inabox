/**
 * A single linked service on the deployment-default Data Factory.
 *
 *   GET /api/adf/linked-services/[name]  → { ok, linkedService: { name, properties } }
 *
 * Backs the Manage hub's "edit existing linked service" flow: the editor loads
 * the full `properties.typeProperties` of an existing linked service and
 * prefills the per-connector structured form. Factory is the env-pinned default;
 * honest 503 gate when LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME are
 * unset. Real ARM REST. No mocks.
 */

import { NextResponse } from 'next/server';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';
import { adfConfigGate, getLinkedService } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WS-D2: ADF config gate normalized onto the shared gate envelope (check unchanged).
function gate() {
  const g = adfConfigGate();
  if (g) {
    return apiHonestGateError('svc-adf', {
      missing: [g.missing],
      message: `Data Factory not configured: set ${g.missing}.`,
    });
  }
  return null;
}

export const GET = withSession<{ name: string }>(async (_req, { params }) => {
  const g = gate(); if (g) return g;
  const { name } = params;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const linkedService = await getLinkedService(name);
    return NextResponse.json({ ok: true, linkedService });
  } catch (e: any) {
    const status = /not\s*found|404/i.test(e?.message || '') ? 404 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
