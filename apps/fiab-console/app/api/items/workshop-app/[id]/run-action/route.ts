/**
 * Atelier (workshop-app, audit-T51 / T145) — run a data action.
 *
 * POST /api/items/workshop-app/[id]/run-action
 *   body:
 *     { entityType, op: 'list', top? }                              → read rows
 *     { entityType, op: 'create', values: {col: value, ...} }       → INSERT
 *     { entityType, op: 'update', values: {...}, key: {column,value} } → UPDATE
 *   → { ok, op, entityType, columns?, rows?, rowCount?, recordsAffected? } | gate
 *
 * An Atelier app's operational actions read/write the data behind the bound
 * ontology entity types. This route resolves the app's bound ontology + the
 * ontology's warehouse binding for `entityType` (state.entityBindings), then
 * runs a REAL statement against the Azure-native backend (Synapse dedicated SQL
 * pool via the live TDS path). Writes are parameterized via `sp_executesql`
 * (synapse-sql-client SynapseQueryParam) — values are bound, never spliced, so
 * write-back is SQL-injection-safe.
 *
 * Per no-fabric-dependency.md the default is Azure-native (Synapse), no Fabric.
 * Honest 503 when Synapse env is unset; honest 409 when no warehouse source is
 * bound to the type. Read (`list`) is also served by the sibling /data route;
 * this route additionally performs the write-back the action defines.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, type SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import { resolveEntityBinding, safeIdent } from '../../_shared/binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

/** Coerce a values map into validated {column, value} pairs (safe idents only). */
function safeValues(values: unknown): Array<{ column: string; value: string | null }> {
  if (!values || typeof values !== 'object') return [];
  const out: Array<{ column: string; value: string | null }> = [];
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    const col = safeIdent(k);
    if (!col) continue;
    out.push({ column: col, value: v == null ? null : String(v) });
  }
  return out;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the Atelier app first', 400, 'no_id');

  const body = (await req.json().catch(() => ({}))) as {
    entityType?: string; op?: string; top?: number;
    values?: Record<string, unknown>; key?: { column?: string; value?: unknown };
  };
  const entityType = String(body.entityType || '').trim();
  if (!entityType) return err('entityType is required', 400, 'bad_request');
  const op = body.op === 'create' ? 'create' : body.op === 'update' ? 'update' : 'list';

  const resolved = await resolveEntityBinding(id, entityType, s.claims.oid);
  if (!resolved.ok) return err(resolved.error, resolved.status, resolved.code, resolved.gate);
  const { target, table } = resolved;

  try {
    if (op === 'list') {
      const top = Math.min(Math.max(Number(body.top) || 50, 1), 1000);
      const result = await executeQuery(target, `SELECT TOP (${top}) * FROM [${table}]`, 60_000);
      return NextResponse.json({ ok: true, op, entityType, columns: result.columns, rows: result.rows, rowCount: result.rows.length });
    }

    if (op === 'create') {
      const vals = safeValues(body.values);
      if (vals.length === 0) return err('create requires at least one valid column=value', 400, 'no_values');
      const cols = vals.map((v) => `[${v.column}]`).join(', ');
      const markers = vals.map((_, i) => `@p${i}`).join(', ');
      const params: SynapseQueryParam[] = vals.map((v, i) => ({ name: `p${i}`, value: v.value }));
      const result = await executeQuery(target, `INSERT INTO [${table}] (${cols}) VALUES (${markers})`, 60_000, params);
      return NextResponse.json({ ok: true, op, entityType, recordsAffected: result.recordsAffected, messages: result.messages });
    }

    // op === 'update'
    const vals = safeValues(body.values);
    if (vals.length === 0) return err('update requires at least one valid column=value', 400, 'no_values');
    const keyCol = safeIdent(String(body.key?.column || ''));
    if (!keyCol) return err('update requires a valid key column', 400, 'no_key');
    const setClause = vals.map((v, i) => `[${v.column}] = @p${i}`).join(', ');
    const params: SynapseQueryParam[] = vals.map((v, i) => ({ name: `p${i}`, value: v.value }));
    params.push({ name: 'kv', value: body.key?.value == null ? null : String(body.key.value) });
    const result = await executeQuery(target, `UPDATE [${table}] SET ${setClause} WHERE [${keyCol}] = @kv`, 60_000, params);
    return NextResponse.json({ ok: true, op, entityType, recordsAffected: result.recordsAffected, messages: result.messages });
  } catch (e: unknown) {
    return err(`Query failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'query_failed');
  }
}
