/**
 * POST /api/items/feature-table/[id]/pit-join
 *   body { spine: { fullName, entityKeys[], timestampKey, carryColumns?, limit? }, preview? }
 *
 * Builds the point-in-time (AS-OF) join of the spine/label table onto this
 * feature table and — unless `preview` — RUNS it against the active offline
 * engine (Databricks SQL warehouse / Postgres) and returns real rows. This is
 * the "PIT-join to a training set" acceptance path.
 *
 * Owner-scoped via resolveFeatureTableItem(id, session.claims.oid).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import { resolveFeatureTableItem, featureTableItemErrorResponse } from '@/lib/azure/feature-store-item';
import {
  runPitJoin, buildPitJoinSql, resolveFeatureStoreBackend, FeatureStoreError,
  type PitSpineSpec,
} from '@/lib/azure/feature-store-client';

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

  let body: any;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const s = body?.spine || {};
  const spine: PitSpineSpec = {
    fullName: String(s.fullName || '').trim(),
    entityKeys: Array.isArray(s.entityKeys) ? s.entityKeys.map((k: any) => String(k).trim()).filter(Boolean) : [],
    timestampKey: String(s.timestampKey || '').trim(),
    carryColumns: Array.isArray(s.carryColumns) ? s.carryColumns.map((c: any) => String(c).trim()).filter(Boolean) : [],
    limit: Number(s.limit) || undefined,
  };

  const backend = spec.offlineBackend || resolveFeatureStoreBackend();
  // Build first so an invalid spec is a 400 (not a 500) before touching a backend.
  let sql: string;
  try {
    sql = buildPitJoinSql(spine, spec, backend);
  } catch (e: any) {
    if (e instanceof FeatureStoreError) return apiError(e.message, e.status);
    return apiServerError(e, 'Failed to build the point-in-time join.', 'pit_build_failed');
  }

  if (body?.preview) return apiOk({ preview: true, sql, backend });

  try {
    const res = await runPitJoin(spine, spec);
    return apiOk({ sql: res.sql, backend: res.backend, columns: res.columns, rows: res.rows, rowCount: res.rowCount, executionMs: res.executionMs });
  } catch (e: any) {
    if (e instanceof FeatureStoreError) return apiHonestError(e, e.status);
    // A backend SQL error (missing table / column) is an honest, user-actionable
    // message — surface it verbatim so the user can fix the spine, not a generic 500.
    return apiHonestError(e, 502);
  }
}
