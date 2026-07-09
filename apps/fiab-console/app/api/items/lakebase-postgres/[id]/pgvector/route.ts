/**
 * GET  /api/items/lakebase-postgres/[id]/pgvector
 *   Current `azure.extensions` allowlist + whether pgvector is enabled on this
 *   item (Lakebase-Search parity: hybrid vector + full-text on Flexible Server).
 *
 * POST /api/items/lakebase-postgres/[id]/pgvector
 *   { action: 'enable' }
 *     Control plane: add VECTOR to the server's azure.extensions allowlist (ARM).
 *     Data plane: CREATE EXTENSION IF NOT EXISTS "vector" (real pg wire protocol)
 *     when LOOM_POSTGRES_AAD_USER is wired; otherwise the ARM allowlist still
 *     succeeds and the response carries an honest note for the CREATE step.
 *   { action: 'search', table, vectorColumn, distance, limit, vector[], schema?, selectColumns? }
 *     Run a parameterized kNN vector-distance query (real rows). The query
 *     vector binds to $1 — no client value is interpolated into the SQL.
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import {
  getExtensionsAllowlist, allowlistExtension, executePostgresBatch, postgresQueryGate, PostgresError,
} from '@/lib/azure/postgres-flex-client';
import {
  buildCreateExtensionSql, buildVectorSearchSql, toVectorLiteral, clampLimit,
  PGVECTOR_ALLOWLIST_TOKEN, type VectorDistance,
} from '@/lib/azure/lakebase-query-builders';
import { saveLakebase } from '@/lib/lakebase/lakebase-store';
import { authItem, isError, requireBoundServer } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DISTANCE: VectorDistance[] = ['cosine', 'l2', 'inner_product'];

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id);
  if (isError(r)) return r.error;
  const bound = requireBoundServer(r.state);
  if ('error' in bound) return bound.error;
  try {
    const allowlist = await getExtensionsAllowlist(bound.server.id || bound.server.name);
    return apiOk({
      allowlist,
      enabled: !!r.state.pgvectorEnabled,
      queryGate: postgresQueryGate(),
    });
  } catch (e) {
    if (e instanceof PostgresError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'failed to read pgvector state');
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id, { write: true });
  if (isError(r)) return r.error;
  const { item, state } = r;
  const bound = requireBoundServer(state);
  if ('error' in bound) return bound.error;

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }
  const action = String(body?.action || 'enable');
  const server = bound.server;
  const database = String(body?.database || state.database || 'postgres');

  try {
    if (action === 'enable') {
      // Control plane (ARM) — always real, no data-plane auth needed.
      const allowlist = await allowlistExtension(server.id || server.name, PGVECTOR_ALLOWLIST_TOKEN);
      // Data plane — CREATE EXTENSION needs the Entra query principal.
      const gate = postgresQueryGate();
      if (gate) {
        return apiOk({
          allowlist,
          extensionCreated: false,
          note: `azure.extensions allowlist updated (VECTOR). CREATE EXTENSION requires ${gate.missing}: ${gate.detail}`,
          queryGate: gate,
        });
      }
      const [res] = await executePostgresBatch(server.fqdn, database, [{ sql: buildCreateExtensionSql() }]);
      const updated = await saveLakebase(item, { pgvectorEnabled: true });
      return apiOk({ allowlist, extensionCreated: true, command: res.command, config: (updated.state as any).lakebase });
    }

    if (action === 'search') {
      const gate = postgresQueryGate();
      if (gate) return apiError(gate.detail, 503, { code: 'not_configured', missing: gate.missing });
      const distance = VALID_DISTANCE.includes(body?.distance) ? (body.distance as VectorDistance) : 'cosine';
      const table = String(body?.table || '').trim();
      const vectorColumn = String(body?.vectorColumn || '').trim();
      if (!table || !vectorColumn) return apiError('table and vectorColumn are required', 400);
      const vec = Array.isArray(body?.vector) ? body.vector.map((n: unknown) => Number(n)) : [];
      let literal: string;
      try { literal = toVectorLiteral(vec); } catch (e) { return apiError(e instanceof Error ? e.message : 'invalid vector', 400); }
      const selectColumns = Array.isArray(body?.selectColumns)
        ? body.selectColumns.map((c: unknown) => String(c)).filter(Boolean)
        : undefined;
      const built = buildVectorSearchSql({
        schema: typeof body?.schema === 'string' && body.schema ? body.schema : undefined,
        table, vectorColumn, distance, limit: clampLimit(Number(body?.limit)), selectColumns,
      });
      const [result] = await executePostgresBatch(server.fqdn, database, [{ sql: built.sql, params: [literal] }]);
      return apiOk({ result, operator: built.operator });
    }

    return apiError(`unknown action '${action}'`, 400);
  } catch (e) {
    if (e instanceof PostgresError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'pgvector operation failed');
  }
}
