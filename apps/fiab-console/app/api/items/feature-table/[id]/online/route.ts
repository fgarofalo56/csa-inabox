/**
 * /api/items/feature-table/[id]/online
 *   GET  → { ok, onlineGate, onlineTable, count } — online serving-store status.
 *   POST → publish (materialise) the latest features per entity into the online
 *          Lakebase/pgvector table. Real read (offline engine) + real upsert (pg).
 *
 * Owner-scoped via resolveFeatureTableItem(id, session.claims.oid).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import { resolveFeatureTableItem, featureTableItemErrorResponse } from '@/lib/azure/feature-store-item';
import {
  onlineStoreGate, publishOnline, defaultOnlineTable, FeatureStoreError,
} from '@/lib/azure/feature-store-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    const { spec } = await resolveFeatureTableItem(id, session.claims.oid);
    if (!spec) return apiError('Define the feature table first.', 409, { code: 'no_spec' });
    return apiOk({
      onlineGate: onlineStoreGate(),
      onlineTable: spec.onlineTable || defaultOnlineTable(spec.fullName),
    });
  } catch (e) {
    const { status, body } = featureTableItemErrorResponse(e);
    return apiError(body.error, status, { code: body.code });
  }
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  try {
    const res = await publishOnline(spec);
    return apiOk({ published: res.published, onlineTable: res.onlineTable, executionMs: res.executionMs });
  } catch (e: any) {
    if (e instanceof FeatureStoreError) return apiHonestError(e, e.status);
    return apiServerError(e, 'Failed to publish the online feature table.', 'online_publish_failed');
  }
}
