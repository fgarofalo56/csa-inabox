/**
 * POST /api/items/model-serving-endpoint/[id]/invoke
 *   body { endpoint: string, payload: string, featureLookup?: {
 *            featureTableItemId: string, entityKeys: { <pk>: value } } }
 * Scores real data against the serving endpoint from the console. AML: reads the
 * scoring URI + a listkeys key and POSTs the data plane. Databricks: POSTs the
 * Mosaic `/serving-endpoints/{name}/invocations`. Returns the model response +
 * measured round-trip latency (feeds the invoke console + latency tile).
 *
 * WS-2.1 feature-lookup-at-serving: when `featureLookup` is present, the LATEST
 * online features for the entity keys are read from the referenced feature-table
 * item's Lakebase/pgvector online store and merged into the scoring payload
 * BEFORE the endpoint is invoked — the Feature Store online-serving wire-in.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  invokeServingEndpoint, shapeInvokePayload, resolveServingBackend, ServingError,
} from '@/lib/azure/model-serving-client';
import { resolveServingItem, servingItemErrorResponse } from '@/lib/azure/model-serving-item';
import { resolveFeatureTableItem } from '@/lib/azure/feature-store-item';
import {
  lookupOnlineFeatures, mergeFeaturesIntoPayload, FeatureStoreError,
} from '@/lib/azure/feature-store-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveServingItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = servingItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const endpoint = String(body?.endpoint || '').trim();
  if (!endpoint) return NextResponse.json({ ok: false, error: 'endpoint is required' }, { status: 400 });
  let payload: unknown;
  try {
    payload = shapeInvokePayload(String(body?.payload ?? ''), resolveServingBackend());
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'invalid payload' }, { status: 400 });
  }

  // WS-2.1 — optional feature-lookup-at-serving: enrich the payload with the
  // latest online features for the entity keys before scoring.
  let features: Record<string, unknown> | undefined;
  const fl = body?.featureLookup;
  if (fl && typeof fl === 'object' && fl.featureTableItemId) {
    try {
      const { spec } = await resolveFeatureTableItem(String(fl.featureTableItemId), session.claims.oid);
      if (!spec) return NextResponse.json({ ok: false, error: 'The referenced feature table has no saved spec.' }, { status: 409 });
      const entityKeys = (fl.entityKeys && typeof fl.entityKeys === 'object') ? fl.entityKeys : {};
      const lookup = await lookupOnlineFeatures(spec, entityKeys);
      if (!lookup.found) {
        return NextResponse.json({ ok: false, error: `No online feature row for the entity keys in ${lookup.onlineTable}.`, code: 'feature_not_found' }, { status: 404 });
      }
      features = lookup.features;
      payload = mergeFeaturesIntoPayload(payload, features);
    } catch (e: any) {
      const status = e instanceof FeatureStoreError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  try {
    const result = await invokeServingEndpoint(endpoint, payload);
    return NextResponse.json({ ok: result.status < 400, status: result.status, latencyMs: result.latencyMs, result: result.body, ...(features ? { features } : {}) });
  } catch (e: any) {
    const status = e instanceof ServingError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
