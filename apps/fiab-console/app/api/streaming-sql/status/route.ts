/**
 * GET /api/streaming-sql/status — the live streaming-SQL tier status (N7a).
 *
 * Returns the REAL RisingWave status read off its own `rw_catalog` (version,
 * every materialized view with its definition + backfill progress + current
 * materialized row count, and the connected source / sink counts). When
 * `LOOM_RISINGWAVE_URL` is unset the route 503s with the normalized gate
 * envelope; the streaming-sql editor still renders fully and shows the Fix-it.
 *
 * Never fabricates a status: an unreachable tier is reported as unreachable with
 * the upstream reason.
 *
 * 200 → { ok:true, configured, engine, version?, materializedViews, sourceCount, sinkCount }
 * 200 → { ok:true, configured:false, gate:{…} }   (tier not deployed)
 * 401 → unauthenticated
 * 502 → tier unreachable
 */
import { apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { buildGateEnvelope } from '@/lib/api/gate-envelope';
import {
  RISINGWAVE_GATE_ID,
  RisingWaveError,
  eventHubKafkaBootstrap,
  isRisingWaveConfigured,
  logStreamingSqlAccess,
  readStreamingStatus,
} from '@/lib/azure/risingwave-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req, { session }) => {
  const kafkaBootstrap = eventHubKafkaBootstrap();

  if (!isRisingWaveConfigured()) {
    return apiOk({
      configured: false,
      engine: 'risingwave' as const,
      gate: buildGateEnvelope(RISINGWAVE_GATE_ID, { missing: ['LOOM_RISINGWAVE_URL'] }).gate,
      kafkaBootstrap,
      note:
        'The RisingWave stateful-streaming tier is not deployed in this environment. Deploy '
        + 'platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep and set LOOM_RISINGWAVE_URL to '
        + 'author streaming materialized views. Azure Stream Analytics still covers simple streaming jobs '
        + '(the stream-analytics-job item).',
    });
  }

  const tenantId = session.claims.tid || session.claims.oid;
  try {
    const status = await readStreamingStatus();
    await logStreamingSqlAccess({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      tenantId,
      operation: 'streaming.status',
      sql: '',
      outcome: 'success',
      rowCount: status.materializedViews.length,
    });
    return apiOk({ configured: true, kafkaBootstrap, ...status });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await logStreamingSqlAccess({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      tenantId,
      operation: 'streaming.status',
      sql: '',
      outcome: 'failure',
      detail,
    });
    return apiOk({
      configured: true,
      engine: 'risingwave' as const,
      kafkaBootstrap,
      unreachable: (e instanceof RisingWaveError ? e.message : detail).slice(0, 400),
      materializedViews: [],
      sourceCount: 0,
      sinkCount: 0,
    });
  }
});
