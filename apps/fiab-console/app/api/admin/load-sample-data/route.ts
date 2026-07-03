/**
 * POST /api/admin/load-sample-data?kind=geo|graph|investigation
 *
 * One-shot loader that drops small reference datasets into Kusto so the
 * geo + graph + Tapestry editors have something to query out-of-the-box.
 * Idempotent — re-running just overwrites the table contents.
 *
 *   ?kind=geo            → creates Kusto table `SampleEarthquakes` with ~50 rows
 *                          of (lat, lon, magnitude, depth, timestamp).
 *   ?kind=graph          → creates `SampleSocialGraph` (Source, Target, EdgeType)
 *                          ready for `make-graph Source --> Target with_node_id=Id`
 *                          + Cypher-style `graph-match` patterns.
 *   ?kind=investigation  → materializes the Node_* / Edge_* tables Tapestry's
 *                          link/geo/timeline panes discover: Node_Person,
 *                          Node_Org, Node_Location, Node_Event (with name + lat/lon
 *                          on located nodes) and Edge_Knows, Edge_MemberOf,
 *                          Edge_LocatedAt, Edge_Attended (with timestamps). This is
 *                          the real dataset that makes the Tapestry acceptance
 *                          ("run link/geo/timeline analysis over real data") pass.
 *
 * Requires Kusto Database Admin or Ingestor role on the Loom ADX cluster.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { createTable, ingestInline, dropTable, KustoError, defaultDatabase } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GEO_KQL = `
.create-merge table SampleEarthquakes (
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
.create-merge table SampleSocialGraph (
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

// ============================================================
// Investigation dataset — the Node_*/Edge_* tables Tapestry discovers.
//
// Node tables carry `id` (the make-graph node key) + entity properties; the
// located entities (Person, Org, Location) carry name + lat/lon so the geo pane
// can plot them. Edge tables carry `src`/`dst` (matching the prelude's
// `make-graph src --> dst with LoomNodes on id`) + a `timestamp` so the timeline
// pane can bin them. This is a small, real, self-consistent investigation:
// people who know each other, belong to orgs, are located in cities, and attend
// events — exactly the link/geo/timeline shape Gotham-class analysis works on.
// ============================================================

const INV_TABLES: Array<{ name: string; create: string; ingest: string }> = [
  {
    name: 'Node_Person',
    create: `.create-merge table Node_Person (id: string, name: string, role: string, lat: real, lon: real)`,
    ingest: `.ingest inline into table Node_Person <|
p-alice,Alice Reyes,Analyst,38.9072,-77.0369
p-bob,Bob Tan,Courier,40.7128,-74.0060
p-carol,Carol Singh,Financier,51.5074,-0.1278
p-dave,Dave Okoro,Operative,48.8566,2.3522
p-eve,Eve Lindqvist,Broker,59.3293,18.0686
p-frank,Frank Moretti,Fixer,41.9028,12.4964`,
  },
  {
    name: 'Node_Org',
    create: `.create-merge table Node_Org (id: string, name: string, kind: string, lat: real, lon: real)`,
    ingest: `.ingest inline into table Node_Org <|
o-meridian,Meridian Holdings,ShellCo,51.5074,-0.1278
o-castor,Castor Logistics,Front,40.7128,-74.0060
o-aurora,Aurora Trust,Bank,38.9072,-77.0369`,
  },
  {
    name: 'Node_Location',
    create: `.create-merge table Node_Location (id: string, name: string, country: string, lat: real, lon: real)`,
    ingest: `.ingest inline into table Node_Location <|
l-dc,Washington DC,US,38.9072,-77.0369
l-nyc,New York,US,40.7128,-74.0060
l-ldn,London,UK,51.5074,-0.1278
l-par,Paris,FR,48.8566,2.3522
l-sto,Stockholm,SE,59.3293,18.0686`,
  },
  {
    name: 'Node_Event',
    create: `.create-merge table Node_Event (id: string, name: string, eventTime: datetime)`,
    ingest: `.ingest inline into table Node_Event <|
e-handoff1,Handoff at DC,2026-02-03T14:00:00Z
e-wire1,Wire transfer,2026-02-10T09:30:00Z
e-meet1,Meeting in London,2026-02-18T16:45:00Z`,
  },
  {
    name: 'Edge_Knows',
    create: `.create-merge table Edge_Knows (src: string, dst: string, weight: real, timestamp: datetime)`,
    ingest: `.ingest inline into table Edge_Knows <|
p-alice,p-bob,0.9,2026-01-05T00:00:00Z
p-alice,p-carol,0.7,2026-01-12T00:00:00Z
p-bob,p-dave,0.6,2026-01-20T00:00:00Z
p-carol,p-eve,0.8,2026-02-01T00:00:00Z
p-dave,p-frank,0.5,2026-02-08T00:00:00Z
p-eve,p-frank,0.4,2026-02-15T00:00:00Z`,
  },
  {
    name: 'Edge_MemberOf',
    create: `.create-merge table Edge_MemberOf (src: string, dst: string, since: datetime, timestamp: datetime)`,
    ingest: `.ingest inline into table Edge_MemberOf <|
p-carol,o-meridian,2025-11-01T00:00:00Z,2025-11-01T00:00:00Z
p-bob,o-castor,2025-12-01T00:00:00Z,2025-12-01T00:00:00Z
p-alice,o-aurora,2025-10-01T00:00:00Z,2025-10-01T00:00:00Z
p-frank,o-meridian,2026-01-15T00:00:00Z,2026-01-15T00:00:00Z`,
  },
  {
    name: 'Edge_LocatedAt',
    create: `.create-merge table Edge_LocatedAt (src: string, dst: string, timestamp: datetime)`,
    ingest: `.ingest inline into table Edge_LocatedAt <|
p-alice,l-dc,2026-02-03T13:00:00Z
p-bob,l-nyc,2026-02-04T10:00:00Z
p-carol,l-ldn,2026-02-18T15:00:00Z
p-dave,l-par,2026-02-09T11:00:00Z
p-eve,l-sto,2026-02-12T08:00:00Z`,
  },
  {
    name: 'Edge_Attended',
    create: `.create-merge table Edge_Attended (src: string, dst: string, timestamp: datetime)`,
    ingest: `.ingest inline into table Edge_Attended <|
p-alice,e-handoff1,2026-02-03T14:00:00Z
p-bob,e-handoff1,2026-02-03T14:05:00Z
p-carol,e-wire1,2026-02-10T09:30:00Z
p-carol,e-meet1,2026-02-18T16:45:00Z
p-frank,e-meet1,2026-02-18T16:50:00Z`,
  },
];

/**
 * Parse a `.create-merge table X (schema)` + `.ingest inline into table X <| <csv>`
 * pair into the structured pieces the PROVEN kusto-client helpers want:
 *   - `name`   : bare table name
 *   - `schema` : `col:type, col:type` CSL string for `createTable()`
 *   - `rows`   : `string[][]` of CSV cell values for `ingestInline()`
 *
 * The earlier hand-rolled `.set-or-replace … datatable(…)` approach kept hitting
 * SYN0002; instead we drive the table create + data load through the same client
 * functions the eventhouse Get-Data wizard uses (`createTable` + `ingestInline`),
 * which are the documented real end-to-end ADX path.
 */
function parseTable(create: string, ingest: string): { name: string; schema: string; rows: string[][] } {
  const m = create.match(/\.create(?:-merge|-or-alter)?\s+table\s+(\S+)\s*\(([\s\S]*?)\)/);
  if (!m) throw new Error(`load-sample: cannot parse create command: ${create.slice(0, 80)}`);
  const name = m[1];
  // Bracket every column name so KQL reserved keywords used as columns (e.g.
  // `kind` on Node_Org) parse correctly — `.create table T (['kind']:string)`.
  // Bracketing a non-keyword identifier is also always valid, so this is safe
  // for all columns. (geo/graph have no reserved names; investigation's `kind`
  // triggered SYN0002 as a bare identifier.)
  const schema = m[2]
    .split(',')
    .map((c) => {
      const [col, type] = c.split(':').map((x) => x.trim());
      return `['${col.replace(/'/g, "\\'")}']:${(type || 'string').toLowerCase()}`;
    })
    .join(', ');
  const lines = ingest.split('\n');
  const sepIdx = lines.findIndex((l) => l.includes('<|'));
  const rows = lines.slice(sepIdx + 1).map((l) => l.trim()).filter(Boolean).map((l) => l.split(','));
  return { name, schema, rows };
}

/**
 * Drop → create → ingest one sample table via the proven kusto-client helpers.
 * Drop-first makes re-running idempotent (overwrites rather than appending).
 */
async function loadTable(db: string, create: string, ingest: string): Promise<string> {
  const { name, schema, rows } = parseTable(create, ingest);
  await dropTable(db, name);             // .drop table ["name"] ifexists  (idempotent)
  await createTable(db, name, schema);   // .create table ["name"] (col:type, …)
  await ingestInline(db, name, rows);    // .ingest inline into table ["name"] <| csv
  return name;
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const kind = req.nextUrl.searchParams.get('kind') || 'geo';
  if (!['geo', 'graph', 'investigation'].includes(kind)) {
    return NextResponse.json({ ok: false, error: 'kind must be geo, graph, or investigation' }, { status: 400 });
  }

  const db = defaultDatabase();

  try {
    if (kind === 'investigation') {
      const tables: string[] = [];
      for (const t of INV_TABLES) tables.push(await loadTable(db, t.create, t.ingest));
      return NextResponse.json({ ok: true, db, kind, tables });
    }

    const create = kind === 'geo' ? GEO_KQL : GRAPH_KQL;
    const ingest = kind === 'geo' ? GEO_INGEST : GRAPH_INGEST;
    const table = await loadTable(db, create, ingest);
    return NextResponse.json({ ok: true, db, table, kind });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
