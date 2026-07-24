/**
 * POST /api/streaming-sql/query — the streaming-SQL read edge (N7a).
 *
 * Runs a READ-ONLY statement (SELECT / SHOW / DESCRIBE / EXPLAIN) on the
 * RisingWave frontend — previewing a materialized view's live rows, browsing the
 * catalog, or explaining a plan. Mutations go through /api/streaming-sql/mv.
 *
 * Gate-enveloped: when LOOM_RISINGWAVE_URL is unset the route 503s with the
 * normalized gate envelope (the editor renders the Fix-it). Every execution —
 * success or failure — writes an `_auditLog` data-access row.
 *
 * 200 → { ok:true, columns, rows, rowCount, elapsedMs }
 * 400 → statement refused by the read-only guard / SQL error
 * 401 → unauthenticated
 * 503 → tier not configured (gate envelope)
 */
import { apiError, apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { backendGateResponse } from '@/lib/api/gate-envelope';
import {
  RISINGWAVE_GATE_ID,
  RisingWaveError,
  logStreamingSqlAccess,
  runStreamingQuery,
} from '@/lib/azure/risingwave-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  sql?: unknown;
  maxRows?: unknown;
  itemId?: unknown;
  workspaceId?: unknown;
}

export const POST = withSession(async (req, { session }) => {
  const gated = backendGateResponse(RISINGWAVE_GATE_ID);
  if (gated) return gated;

  const body = (await req.json().catch(() => ({}))) as Body;
  const sql = typeof body.sql === 'string' ? body.sql.trim() : '';
  if (!sql) {
    return apiError('A SQL statement is required (SELECT / SHOW / DESCRIBE / EXPLAIN).', 400);
  }
  const maxRows = typeof body.maxRows === 'number' && Number.isFinite(body.maxRows)
    ? Math.floor(body.maxRows)
    : undefined;
  const itemId = typeof body.itemId === 'string' ? body.itemId : undefined;
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
  const tenantId = session.claims.tid || session.claims.oid;
  const audit = {
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn,
    tenantId,
    sql,
    itemId,
    workspaceId,
    operation: 'streaming.query' as const,
  };

  try {
    const result = await runStreamingQuery(sql, { maxRows });
    await logStreamingSqlAccess({ ...audit, outcome: 'success', rowCount: result.rowCount, elapsedMs: result.elapsedMs });
    return apiOk({
      engine: 'risingwave',
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      elapsedMs: result.elapsedMs,
      command: result.command,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logStreamingSqlAccess({ ...audit, outcome: 'failure', detail: message });
    if (e instanceof RisingWaveError) return apiError(e.message, e.status, { code: e.code });
    // A refused statement / SQL error is user-actionable — surface it verbatim.
    return apiError(message.slice(0, 600), 400, { code: 'query_failed' });
  }
});
