/**
 * POST /api/streaming-sql/mv — the streaming-SQL authoring edge (N7a).
 *
 * The privileged MUTATION path: CREATE/DROP a streaming MATERIALIZED VIEW,
 * SOURCE or SINK on the RisingWave tier. Two request shapes:
 *   - { sql }                        — an authored streaming-DDL statement,
 *                                      validated by assertStreamingDdl.
 *   - { kind, spec }                 — a STRUCTURED spec the server compiles to
 *                                      DDL via the pure builders (no-freeform):
 *       'mv-join'        → buildTwoStreamJoinMvSql
 *       'eventhub-source'→ buildEventHubKafkaSourceSql (Event Hubs Kafka endpoint)
 *       'lake-sink'      → buildLakeSinkSql (Delta / Iceberg on the DLZ lake)
 *
 * Gate-enveloped (503 when LOOM_RISINGWAVE_URL is unset). Audited: the mutation
 * emits its audit-stream event FIRST (synchronously) before the Cosmos write.
 *
 * 200 → { ok:true, sql, command, rowCount, elapsedMs }
 * 400 → statement refused / invalid spec
 * 401 → unauthenticated
 * 503 → tier not configured (gate envelope)
 */
import { apiError, apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { backendGateResponse } from '@/lib/api/gate-envelope';
import {
  RISINGWAVE_GATE_ID,
  RisingWaveError,
  buildEventHubKafkaSourceSql,
  buildLakeSinkSql,
  buildTwoStreamJoinMvSql,
  executeStreamingDdl,
  logStreamingSqlAccess,
  type EventHubSourceSpec,
  type LakeSinkSpec,
  type TwoStreamJoinSpec,
} from '@/lib/azure/risingwave-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  sql?: unknown;
  kind?: unknown;
  spec?: unknown;
  itemId?: unknown;
  workspaceId?: unknown;
}

/** Compile the request body to a single streaming-DDL statement. */
function ddlFromBody(body: Body): string {
  if (typeof body.sql === 'string' && body.sql.trim()) return body.sql.trim();
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const spec = (body.spec && typeof body.spec === 'object') ? (body.spec as Record<string, unknown>) : null;
  if (!kind || !spec) {
    throw new RisingWaveError('Provide either `sql` or a `{ kind, spec }` builder request.', 400, 'bad_request');
  }
  switch (kind) {
    case 'mv-join':
      return buildTwoStreamJoinMvSql(spec as unknown as TwoStreamJoinSpec);
    case 'eventhub-source':
      return buildEventHubKafkaSourceSql(spec as unknown as EventHubSourceSpec);
    case 'lake-sink':
      return buildLakeSinkSql(spec as unknown as LakeSinkSpec);
    default:
      throw new RisingWaveError(`Unknown builder kind "${kind}".`, 400, 'unknown_kind');
  }
}

export const POST = withSession(async (req, { session }) => {
  const gated = backendGateResponse(RISINGWAVE_GATE_ID);
  if (gated) return gated;

  const body = (await req.json().catch(() => ({}))) as Body;
  const itemId = typeof body.itemId === 'string' ? body.itemId : undefined;
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
  const tenantId = session.claims.tid || session.claims.oid;

  let sql: string;
  try {
    sql = ddlFromBody(body);
  } catch (e) {
    if (e instanceof RisingWaveError) return apiError(e.message, e.status, { code: e.code });
    return apiError(e instanceof Error ? e.message : String(e), 400);
  }

  const audit = {
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn,
    tenantId,
    sql,
    itemId,
    workspaceId,
    operation: 'streaming.ddl' as const,
  };

  try {
    const result = await executeStreamingDdl(sql);
    await logStreamingSqlAccess({ ...audit, outcome: 'success', rowCount: result.rowCount, elapsedMs: result.elapsedMs });
    return apiOk({ sql, engine: 'risingwave', command: result.command, rowCount: result.rowCount, elapsedMs: result.elapsedMs });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logStreamingSqlAccess({ ...audit, outcome: 'failure', detail: message });
    if (e instanceof RisingWaveError) return apiError(e.message, e.status, { code: e.code });
    return apiError(message.slice(0, 600), 400, { code: 'ddl_failed' });
  }
});
