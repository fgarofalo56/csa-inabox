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

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { adfConfigGate, getDataset } from '@/lib/azure/adf-client';
import { apiOk, apiError, apiUnauthorized } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = adfConfigGate();
  if (g) {
    return apiError(`Data Factory not configured: set ${g.missing}.`, 503, { code: 'not_configured', missing: g.missing });
  }
  return null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const g = gate(); if (g) return g;
  const { name } = await ctx.params;
  if (!name) return apiError('name is required', 400);
  try {
    const dataset = await getDataset(name);
    return apiOk({ dataset });
  } catch (e: any) {
    const status = /not\s*found|404/i.test(e?.message || '') ? 404 : 502;
    return apiError(e?.message || String(e), status);
  }
}
