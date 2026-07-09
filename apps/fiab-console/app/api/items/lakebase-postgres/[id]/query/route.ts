/**
 * POST /api/items/lakebase-postgres/[id]/query
 *   body: { database?, sql }
 *
 * Execute caller-authored SQL against the item's bound Flexible Server over the
 * REAL pg wire protocol, authenticated with a Microsoft Entra token (no stored
 * password). Caller-authorized — the Query tab runs arbitrary SQL exactly like
 * the T-SQL editor. Requires write access (DDL/DML). Returns columns + rows.
 *
 * Honest gate: when LOOM_POSTGRES_AAD_USER is unset the route 503s naming the
 * one-time pgaadauth_create_principal setup (the full editor still renders).
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import { executePostgresQuery, postgresQueryGate, PostgresError } from '@/lib/azure/postgres-flex-client';
import { authItem, isError, requireBoundServer } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id, { write: true });
  if (isError(r)) return r.error;
  const { state } = r;

  const bound = requireBoundServer(state);
  if ('error' in bound) return bound.error;

  const gate = postgresQueryGate();
  if (gate) return apiError(gate.detail, 503, { code: 'not_configured', missing: gate.missing });

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }
  const sql = String(body?.sql || '').trim();
  if (!sql) return apiError('sql required', 400);
  const database = String(body?.database || state.database || 'postgres');

  try {
    const result = await executePostgresQuery(bound.server.fqdn, database, sql);
    return apiOk({ result });
  } catch (e) {
    if (e instanceof PostgresError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'query failed');
  }
}
