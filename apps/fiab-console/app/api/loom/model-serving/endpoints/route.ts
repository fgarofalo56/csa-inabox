/**
 * GET /api/loom/model-serving/endpoints → { ok, endpoints, backend }
 *
 * The BACKEND-AGNOSTIC serving-endpoint lister — the discovery call behind the
 * "pick a serving endpoint" control in the feature-table editor.
 *
 * WHY IT LIVES HERE AND NOT UNDER /api/databricks OR /api/aml. Every invoke path
 * in this tree goes through `model-serving-client`, which dispatches on
 * `resolveServingBackend()`: Databricks Mosaic when
 * `LOOM_MODEL_SERVING_BACKEND=databricks`, otherwise the Azure ML online-endpoint
 * plane — and Azure ML is the DEFAULT. The existing Databricks-only route
 * (`/api/databricks/serving-endpoints`) lists a different population from the one
 * `invokeServingEndpoint` will call, so a picker fed by it would offer names the
 * action cannot use on the default backend, and would be dead in Azure
 * Government, where Databricks model serving is not GA (`cloud-parity.md`). This
 * is a Loom-level navigator that hides which backend answers — the same shape as
 * the sibling `/api/loom/compute-targets/*` routes.
 *
 * An unconfigured backend returns the STRUCTURED honest gate (503 + the exact
 * env var and the Fix-it target, `ux-baseline.md` G2) rather than an empty list:
 * "there are none" and "I could not ask" must stay distinguishable
 * (`deploy-integrity.md` R7).
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import {
  listServingEndpoints, servingConfigGate, resolveServingBackend, ServingError,
} from '@/lib/azure/model-serving-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async () => {
  const gate = servingConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: gate.gateId, error: gate.hint, missing: gate.missing, gate },
      { status: 503 },
    );
  }

  try {
    const endpoints = await listServingEndpoints();
    return NextResponse.json({ ok: true, backend: resolveServingBackend(), endpoints });
  } catch (e: any) {
    const status = e instanceof ServingError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
