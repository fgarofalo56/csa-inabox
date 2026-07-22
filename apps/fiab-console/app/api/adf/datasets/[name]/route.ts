/**
 * A single dataset on the deployment-default Data Factory.
 *
 *   GET /api/adf/datasets/[name]  → { ok, dataset: { name, properties } }
 *
 * Backs the Manage hub's "edit existing dataset" flow: the editor loads the
 * full dataset (linked service + location/typeProperties + schema) and prefills
 * the DatasetWizard in edit mode. Factory is the env-pinned default; honest 503
 * gate when LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME are unset. Real
 * ARM REST. No mocks.
 */

import { adfConfigGate, getDataset } from '@/lib/azure/adf-client';
import { apiOk, apiError } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';

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
  if (!name) return apiError('name is required', 400);
  try {
    const dataset = await getDataset(name);
    return apiOk({ dataset });
  } catch (e: any) {
    const status = /not\s*found|404/i.test(e?.message || '') ? 404 : 502;
    return apiError(e?.message || String(e), status);
  }
});
