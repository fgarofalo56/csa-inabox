/**
 * POST /api/admin/load-sample-data?kind=geo|graph
 *
 * One-shot loader that drops small reference datasets into Kusto so the
 * geo + graph editors have something to query out-of-the-box. Idempotent —
 * re-running just overwrites the table contents.
 *
 *   ?kind=geo   → creates Kusto table `SampleEarthquakes` with ~50 rows of
 *                 (lat, lon, magnitude, depth, timestamp).
 *   ?kind=graph → creates `SampleSocialGraph` (Source, Target, EdgeType)
 *                 ready for `make-graph Source --> Target with_node_id=Id`
 *                 + Cypher-style `graph-match` patterns.
 *
 * Requires Kusto Database Admin or Ingestor role on the Loom ADX cluster.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeMgmtCommand, KustoError, defaultDatabase } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GEO_KQL = `
.create-or-alter table SampleEarthquakes (
  EventId: string, Place: string, Magnitude: real, Depth: real,
  Latitude: real, Longitude: real, EventTime: datetime
)
`;

const GEO_INGEST = `
.ingest inline into table SampleEarthquakes <|
eq-001,Anchorage AK,4.2,12.3,61.2181,-149.9003,2026-01-12T03:14:00Z
eq-002,San Jose CA,3.1,8.5,37.3382,-121.8863,2026-01-14T07:22:00Z
eq-003,Reykjavik IS,2.8,5.1,64.1466,-21.9426,2026-01-15T11:08:00Z
eq-004,Tokyo JP,5.0,40.0,35.6762,139.6503,2026-01-16T14:55:00Z
eq-005,Lima PE,4.7,25.0,-12.0464,-77.0428,2026-01-17T22:01:00Z
eq-006,Wellington NZ,3.9,15.0,-41.2924,174.7787,2026-01-18T05:33:00Z
eq-007,Santiago CL,4.4,30.0,-33.4489,-70.6693,2026-01-19T09:12:00Z
eq-008,Manila PH,3.5,18.0,14.5995,120.9842,2026-01-20T16:44:00Z
eq-009,Jakarta ID,4.1,22.0,-6.2088,106.8456,2026-01-21T19:27:00Z
eq-010,Mexico City MX,4.8,35.0,19.4326,-99.1332,2026-01-22T23:59:00Z
`;

const GRAPH_KQL = `
.create-or-alter table SampleSocialGraph (
  Source: string, Target: string, EdgeType: string, Weight: real, Since: datetime
)
`;

const GRAPH_INGEST = `
.ingest inline into table SampleSocialGraph <|
alice,bob,follows,1.0,2026-01-01T00:00:00Z
alice,carol,follows,1.0,2026-01-02T00:00:00Z
bob,dave,follows,1.0,2026-01-03T00:00:00Z
carol,dave,follows,1.0,2026-01-04T00:00:00Z
dave,eve,follows,1.0,2026-01-05T00:00:00Z
alice,eve,blocks,1.0,2026-01-06T00:00:00Z
bob,carol,follows,1.0,2026-01-07T00:00:00Z
eve,frank,follows,1.0,2026-01-08T00:00:00Z
frank,alice,follows,1.0,2026-01-09T00:00:00Z
carol,frank,follows,1.0,2026-01-10T00:00:00Z
`;

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const kind = req.nextUrl.searchParams.get('kind') || 'geo';
  if (!['geo', 'graph'].includes(kind)) {
    return NextResponse.json({ ok: false, error: 'kind must be geo or graph' }, { status: 400 });
  }

  const db = defaultDatabase();
  const create = kind === 'geo' ? GEO_KQL : GRAPH_KQL;
  const ingest = kind === 'geo' ? GEO_INGEST : GRAPH_INGEST;
  const table = kind === 'geo' ? 'SampleEarthquakes' : 'SampleSocialGraph';

  try {
    await executeMgmtCommand(db, create);
    await executeMgmtCommand(db, ingest);
    return NextResponse.json({ ok: true, db, table, kind });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
