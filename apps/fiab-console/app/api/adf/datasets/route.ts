/**
 * Datasets on the SELECTED (or deployment-default) Data Factory (the Manage hub).
 *
 *   GET    /api/adf/datasets            → { ok, datasets }
 *   POST   /api/adf/datasets            body { name, properties }  → upsert
 *   DELETE /api/adf/datasets?name=NAME  → delete
 *
 * A dataset must carry `properties.type` and a `linkedServiceName` reference
 * (an existing linked service). Factory: the editor appends the selected
 * factory's coords (factorySubscriptionId / factoryResourceGroup / factoryName);
 * absent → the env-pinned default. Honest 503 gate when neither is configured.
 * Real ARM REST. No mocks.
 */

import type { NextRequest } from 'next/server';
import { withFactoryFromRequest } from '@/lib/azure/adf-factory-context';
import { apiOk, apiError } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';
import {
  adfConfigGate, listDatasets, upsertDataset, deleteDataset,
  type AdfDataset,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

// WS-D2: the ADF config gate normalized onto the shared gate envelope. The
// CHECK is unchanged (`adfConfigGate()`, preserving the anyOf LOOM_ADF_FACTORY /
// LOOM_ADF_RG semantics); only the response shape is normalized — now
// { ok:false, gated:true, gate:{ id:'svc-adf', remediation, fixItHref } } with
// the back-compat code/error/missing mirrors intact. Kept INSIDE the factory
// closure so it reflects the selected factory, not a pre-resolution guess.
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

// WS-D1: session-only routes adopted onto `withSession`. The factory scope +
// the (normalized) gate stay inside the wrapped body exactly as before.
export const GET = withSession((req: NextRequest) => withFactoryFromRequest(req, async () => {
  const g = gate(); if (g) return g;
  try {
    const datasets = await listDatasets();
    return apiOk({ datasets });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}));

export const POST = withSession(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  return withFactoryFromRequest(req, async () => {
    const g = gate(); if (g) return g;
    const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return apiError('name is required', 400);
    if (!NAME_RE.test(name)) return apiError('name must be 1-260 chars: letters, digits, _', 400);
    const properties = body?.properties as AdfDataset['properties'] | undefined;
    if (!properties || typeof properties.type !== 'string') {
      return apiError('properties.type is required', 400);
    }
    if (!properties.linkedServiceName?.referenceName) {
      return apiError('properties.linkedServiceName.referenceName is required', 400);
    }
    // Force the reference type so ADF accepts it regardless of caller payload.
    properties.linkedServiceName = {
      referenceName: properties.linkedServiceName.referenceName,
      type: 'LinkedServiceReference',
      ...(properties.linkedServiceName.parameters ? { parameters: properties.linkedServiceName.parameters } : {}),
    };
    try {
      const saved = await upsertDataset(name, { name, properties });
      return apiOk({ dataset: saved });
    } catch (e: any) {
      return apiError(e?.message || String(e), 502);
    }
  });
});

export const DELETE = withSession((req: NextRequest) => withFactoryFromRequest(req, async () => {
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return apiError('name query param is required', 400);
  try {
    await deleteDataset(name);
    return apiOk();
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}));
