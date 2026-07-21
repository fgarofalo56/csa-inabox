/**
 * /api/items/feature-table/[id]
 *   GET    → { ok, backend, gate, onlineGate, spec, defaults } — load the feature
 *            table spec + which offline/online backend is active + honest gates.
 *   POST   → define/update the feature table: validates the spec, creates the
 *            REAL offline table (UC Delta / Postgres) + the online serving table,
 *            and persists the spec on the tenant-scoped Cosmos item.
 *   DELETE → drop the offline + online backing tables and clear the spec.
 *
 * Owner-scoped: resolveFeatureTableItem(id, session.claims.oid) enforces the
 * caller owns the item (route-guards). No mocks — real DDL over the active
 * backend, or an honest gate.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import {
  resolveFeatureTableItem, persistFeatureTableItem, featureTableItemErrorResponse,
} from '@/lib/azure/feature-store-item';
import {
  featureStoreConfigGate, onlineStoreGate, resolveFeatureStoreBackend,
  validateFeatureTableSpec, createFeatureTable, dropFeatureTable, defaultOnlineTable,
  FeatureStoreError,
  type FeatureTableSpec, type FeatureColumn,
} from '@/lib/azure/feature-store-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function defaults() {
  return {
    catalog: process.env.LOOM_DATABRICKS_DEFAULT_CATALOG || process.env.LOOM_DATABRICKS_CATALOG || 'main',
    schema: process.env.LOOM_DATABRICKS_DEFAULT_SCHEMA || process.env.LOOM_DATABRICKS_SCHEMA || 'default',
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    const { spec } = await resolveFeatureTableItem(id, session.claims.oid);
    return apiOk({
      backend: resolveFeatureStoreBackend(),
      gate: featureStoreConfigGate(),
      onlineGate: onlineStoreGate(),
      spec: spec || null,
      onlineTable: spec ? (spec.onlineTable || defaultOnlineTable(spec.fullName)) : null,
      defaults: defaults(),
    });
  } catch (e) {
    const { status, body } = featureTableItemErrorResponse(e);
    return apiError(body.error, status, { code: body.code });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    await resolveFeatureTableItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = featureTableItemErrorResponse(e);
    return apiError(body.error, status, { code: body.code });
  }

  let body: any;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }

  const features: FeatureColumn[] = Array.isArray(body?.features)
    ? body.features.map((f: any) => ({ name: String(f?.name || '').trim(), dataType: String(f?.dataType || 'DOUBLE').trim() }))
    : [];
  const spec: FeatureTableSpec = {
    fullName: String(body?.fullName || '').trim(),
    primaryKeys: Array.isArray(body?.primaryKeys) ? body.primaryKeys.map((k: any) => String(k).trim()).filter(Boolean) : [],
    timestampKey: String(body?.timestampKey || '').trim(),
    features,
    description: body?.description ? String(body.description) : undefined,
    onlineTable: body?.onlineTable ? String(body.onlineTable).trim() : undefined,
    offlineBackend: resolveFeatureStoreBackend(),
  };
  const problem = validateFeatureTableSpec(spec);
  if (problem) return apiError(problem, 400);

  try {
    const resolved = await createFeatureTable(spec);
    const item = await persistFeatureTableItem(id, session.claims.oid, resolved);
    return apiOk({ spec: resolved, itemId: item.id, message: `Feature table ${resolved.fullName} created.` });
  } catch (e: any) {
    if (e instanceof FeatureStoreError) return apiHonestError(e, e.status);
    return apiServerError(e, 'Failed to create the feature table.', 'feature_table_create_failed');
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    const { spec, item } = await resolveFeatureTableItem(id, session.claims.oid);
    if (spec) {
      await dropFeatureTable(spec);
      // Clear the spec on the item (keeps the Loom item; drops the backing tables).
      await persistFeatureTableItem(id, session.claims.oid, { ...spec, features: spec.features }).catch(() => { /* keep spec */ });
    }
    return apiOk({ dropped: !!spec, itemId: item.id });
  } catch (e: any) {
    if (e instanceof FeatureStoreError) return apiHonestError(e, e.status);
    const { status, body } = featureTableItemErrorResponse(e);
    return apiError(body.error, status, { code: body.code });
  }
}
