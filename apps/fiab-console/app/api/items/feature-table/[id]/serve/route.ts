/**
 * POST /api/items/feature-table/[id]/serve
 *   body { endpoint: string, entityKeys: { <pk>: value }, payload?: string }
 *
 * The feature-lookup-at-serving path (WS-2.1 acceptance, wired into WS-1.2):
 *   1. look up the LATEST online features for the entity keys from the Lakebase/
 *      pgvector online store (real indexed SELECT),
 *   2. merge them into the caller's scoring payload,
 *   3. invoke the named model-serving endpoint (Azure ML online endpoint /
 *      Databricks Mosaic — model-serving-client) with the enriched payload,
 *   4. return the looked-up features + the model response + round-trip latency.
 *
 * Owner-scoped via resolveFeatureTableItem(id, session.claims.oid). The serving
 * endpoint is a shared Azure backend resolved by name (same class as the
 * model-serving invoke route).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import { resolveFeatureTableItem, featureTableItemErrorResponse } from '@/lib/azure/feature-store-item';
import {
  lookupOnlineFeatures, mergeFeaturesIntoPayload, onlineStoreGate, FeatureStoreError,
} from '@/lib/azure/feature-store-client';
import {
  invokeServingEndpoint, shapeInvokePayload, resolveServingBackend, ServingError,
} from '@/lib/azure/model-serving-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;

  let spec;
  try {
    ({ spec } = await resolveFeatureTableItem(id, session.claims.oid));
  } catch (e) {
    const { status, body } = featureTableItemErrorResponse(e);
    return apiError(body.error, status, { code: body.code });
  }
  if (!spec) return apiError('Define the feature table first (no spec saved).', 409, { code: 'no_spec' });

  const gate = onlineStoreGate();
  if (gate) return apiError(gate.hint, 503, { code: gate.gateId, missing: gate.missing, gate });

  let body: any;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const endpoint = String(body?.endpoint || '').trim();
  const entityKeys = (body?.entityKeys && typeof body.entityKeys === 'object') ? body.entityKeys as Record<string, unknown> : {};
  if (!endpoint) return apiError('A serving endpoint name is required.', 400);
  if (!Object.keys(entityKeys).length) return apiError('entityKeys (the entity id values to look up) are required.', 400);

  // 1) online feature lookup at inference.
  let lookup;
  try {
    lookup = await lookupOnlineFeatures(spec, entityKeys);
  } catch (e: any) {
    if (e instanceof FeatureStoreError) return apiHonestError(e, e.status);
    return apiServerError(e, 'Feature lookup failed.', 'feature_lookup_failed');
  }
  if (!lookup.found) {
    return apiError(
      `No online feature row for the given entity keys in ${lookup.onlineTable}. Publish the online table first, or check the key values.`,
      404, { code: 'feature_not_found', onlineTable: lookup.onlineTable },
    );
  }

  // 2) merge features into the scoring payload.
  let basePayload: unknown;
  try {
    basePayload = shapeInvokePayload(String(body?.payload ?? '{}'), resolveServingBackend());
  } catch (e: any) {
    return apiError(e?.message || 'invalid payload', 400);
  }
  const merged = mergeFeaturesIntoPayload(basePayload, lookup.features);

  // 3) invoke the serving endpoint with the enriched payload.
  try {
    const result = await invokeServingEndpoint(endpoint, merged);
    return apiOk({
      features: lookup.features,
      onlineTable: lookup.onlineTable,
      lookupMs: lookup.executionMs,
      merged,
      status: result.status,
      latencyMs: result.latencyMs,
      result: result.body,
    });
  } catch (e: any) {
    if (e instanceof ServingError) return apiHonestError(e, e.status);
    return apiServerError(e, 'Serving invocation failed.', 'serving_invoke_failed');
  }
}
