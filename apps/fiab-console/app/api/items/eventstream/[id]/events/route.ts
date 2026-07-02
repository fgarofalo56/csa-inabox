/**
 * Eventstream source — live event preview.
 *
 * GET  /api/items/eventstream/[id]/events?nodeIdx=0&maxEvents=20
 *   Peek a bounded batch of recent events from the source node's provisioned
 *   ingest endpoint. Event Hubs has no HTTPS receive path, so peekEvents()
 *   throws EventHubsReceiveUnavailableError until @azure/event-hubs is bundled
 *   + LOOM_EVENTHUB_RECEIVE_ENABLED is set. When that happens, preview stays
 *   REAL via the ADX-sink fallback: if the eventstream's topology records a
 *   KQL Database destination (state.sinks[]/state.sink kind:'kusto', or a
 *   bundle-installed state.content.destinations[] kql entry), the route reads
 *   the newest N rows from that sink table via kusto-client.executeQuery — the
 *   rows the stream actually landed in Azure Data Explorer, which also works
 *   under private networking where AMQP is blocked. Only when NEITHER AMQP
 *   receive NOR an ADX sink is available does the honest 501 dependency-gate
 *   surface (never faked events — no-vaporware.md).
 *
 * POST /api/items/eventstream/[id]/events   body: { nodeIdx, events?, partitionKey? }
 *   Send one or more test events to the source endpoint over the REAL HTTPS
 *   data-plane REST (works today, no AMQP dependency). Lets the operator drive
 *   a live preview end-to-end: POST a test event, then GET to view it once the
 *   receive dependency is enabled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadKustoItem, executeQuery, normalizeClusterUri, qName,
  defaultDatabase, KustoError, type KustoItem,
} from '@/lib/azure/kusto-client';
import {
  sendEvents,
  peekEvents,
  EventHubsReceiveUnavailableError,
  EventHubsDataError,
  type SendEvent,
} from '@/lib/azure/eventhubs-data-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SourceNodeState {
  kind?: string;
  consumerGroup?: string;
  provisionedEndpoint?: { entityPath?: string; fqdn?: string };
}

async function resolveSource(id: string, oid: string, nodeIdx: number): Promise<
  | { ok: true; node: SourceNodeState; item: KustoItem }
  | { ok: false; status: number; error: string }
> {
  const item = await loadKustoItem(id, 'eventstream', oid);
  if (!item) return { ok: false, status: 404, error: 'not found' };
  const sources: any[] = Array.isArray(item.state?.sources)
    ? (item.state!.sources as any[])
    : (item.state?.source ? [item.state.source] : []);
  const node = (nodeIdx >= 0 ? sources[nodeIdx] : sources[0]) as SourceNodeState | undefined;
  if (!node) return { ok: false, status: 404, error: 'source node not found' };
  if (!node.provisionedEndpoint?.entityPath) {
    return { ok: false, status: 409, error: 'Source has no provisioned ingest endpoint yet. Provision the source first.' };
  }
  return { ok: true, node, item };
}

/**
 * Resolve the eventstream's ADX ingestion sink from its persisted topology —
 * the SAME bindings the asa-sync route materializes as the real ASA → ADX
 * output: `state.sinks[]` / `state.sink` with kind 'kusto' (designer-saved),
 * falling back to a bundle-installed `state.content.destinations[]` entry
 * ({ type:'kql-database', config:{ database, table } }). Returns null when the
 * stream has no ADX destination.
 */
function resolveAdxSink(state: Record<string, any> | undefined): { database: string; table: string; clusterUri?: string } | null {
  const sinks: any[] = Array.isArray(state?.sinks)
    ? state!.sinks
    : (state?.sink && typeof state.sink === 'object' ? [state.sink] : []);
  for (const s of sinks) {
    if (String(s?.kind || '').toLowerCase() === 'kusto' && typeof s?.table === 'string' && s.table.trim()) {
      return {
        database: (typeof s.database === 'string' && s.database.trim()) || defaultDatabase(),
        table: s.table.trim(),
        clusterUri: typeof s.kustoClusterUrl === 'string' ? s.kustoClusterUrl : undefined,
      };
    }
  }
  const dests: any[] = Array.isArray(state?.content?.destinations) ? state!.content.destinations : [];
  for (const d of dests) {
    const kind = String(d?.type || d?.kind || '').toLowerCase();
    const cfg = d?.config || {};
    if (['kql-database', 'kusto', 'eventhouse', 'kql'].includes(kind) && typeof cfg.table === 'string' && cfg.table.trim()) {
      return {
        database: (typeof cfg.database === 'string' && cfg.database.trim()) || defaultDatabase(),
        table: cfg.table.trim(),
      };
    }
  }
  return null;
}

/**
 * ADX-sink preview fallback: read the newest `maxEvents` rows the stream
 * ingested into its KQL Database destination (real /v1/rest/query via
 * kusto-client — no mocks). Rows are shaped like peeked events so the
 * RTI-hub drawer renders them with the same card list: the row's columns
 * become the event body; ingestion_time() (when the table's IngestionTime
 * policy is on) becomes enqueuedTime.
 */
async function peekFromAdxSink(
  sink: { database: string; table: string; clusterUri?: string },
  maxEvents: number,
): Promise<Array<{ body: unknown; enqueuedTime?: string }>> {
  const kql = `${qName(sink.table)}\n| extend _ingestedAt = ingestion_time()\n| top ${maxEvents} by _ingestedAt desc`;
  const clusterUri = normalizeClusterUri(sink.clusterUri) || undefined;
  const res = await executeQuery(sink.database, kql, clusterUri ? { clusterUri } : undefined);
  const tsIdx = res.columns.indexOf('_ingestedAt');
  return res.rows.map((row) => {
    const body: Record<string, unknown> = {};
    res.columns.forEach((c, i) => { if (i !== tsIdx) body[c] = row[i]; });
    const ts = tsIdx >= 0 ? row[tsIdx] : undefined;
    return { body, ...(ts ? { enqueuedTime: String(ts) } : {}) };
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const nodeIdx = Number(req.nextUrl.searchParams.get('nodeIdx') ?? '0') || 0;
  const maxEvents = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('maxEvents') ?? '20') || 20));
  try {
    const id = (await ctx.params).id;
    const r = await resolveSource(id, session.claims.oid, nodeIdx);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    try {
      const hub = r.node.provisionedEndpoint!.entityPath!;
      const result = await peekEvents(hub, {
        maxEvents,
        fromLatest: true,
        consumerGroup: r.node.consumerGroup || '$Default',
      });
      return NextResponse.json({ ok: true, events: result.events, source: 'eventhub' });
    } catch (e: any) {
      if (e instanceof EventHubsReceiveUnavailableError) {
        // AMQP receive unavailable → ALWAYS-REAL fallback: read the newest rows
        // the stream ingested into its ADX sink table (works under private
        // networking too). Only when no ADX sink exists does the honest 501
        // dependency-gate remain.
        const sink = resolveAdxSink(r.item.state);
        if (!sink) {
          return NextResponse.json(
            {
              ok: false, code: e.code, dependency: e.dependency, envVar: e.envVar,
              hint: `${e.hint ? `${e.hint} ` : ''}Alternatively, add a KQL Database destination to this eventstream (and push it to ASA) — the preview then reads the newest ingested rows straight from Azure Data Explorer, no AMQP needed.`,
              error: e.message,
            },
            { status: 501 },
          );
        }
        try {
          const events = await peekFromAdxSink(sink, maxEvents);
          return NextResponse.json({
            ok: true,
            events,
            source: 'adx-sink',
            sink: { database: sink.database, table: sink.table },
            note:
              `Live AMQP receive is not enabled in this runtime${e.envVar ? ` (${e.envVar} unset)` : ''}; ` +
              `showing the newest ${events.length} row${events.length === 1 ? '' : 's'} ingested into this stream's ` +
              `ADX sink table '${sink.table}' (database '${sink.database}') — real Azure Data Explorer data.`,
          });
        } catch (ke: any) {
          const status = ke instanceof KustoError && ke.status >= 400 ? ke.status : 502;
          return NextResponse.json({
            ok: false,
            error:
              `Live AMQP receive is not enabled and the ADX-sink preview fallback failed against ` +
              `table '${sink.table}' (database '${sink.database}'): ${ke?.message || String(ke)}. ` +
              `Verify LOOM_KUSTO_CLUSTER_URI and that the Console UAMI has Database Viewer on the cluster, ` +
              `or start the stream's ASA job so rows land in the sink. No Microsoft Fabric required.`,
          }, { status });
        }
      }
      throw e;
    }
  } catch (e: any) {
    if (e instanceof EventHubsDataError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const nodeIdx = Number.isInteger(body?.nodeIdx) ? body.nodeIdx : 0;
  const partitionKey: string | undefined = typeof body?.partitionKey === 'string' ? body.partitionKey : undefined;
  const events: SendEvent[] = Array.isArray(body?.events) && body.events.length
    ? body.events
    : [{ body: { hello: 'loom', ts: new Date().toISOString(), test: true } }];
  try {
    const id = (await ctx.params).id;
    const r = await resolveSource(id, session.claims.oid, nodeIdx);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    const hub = r.node.provisionedEndpoint!.entityPath!;
    const out = await sendEvents(hub, events, { partitionKey });
    return NextResponse.json({ ok: true, sent: out.sent, status: out.status, batched: out.batched });
  } catch (e: any) {
    if (e instanceof EventHubsDataError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
