/**
 * POST /api/connections/[id]/preview
 *
 * ANALYZE (preview) for a SAVED Loom Connection — the first N rows of a picked
 * object (a table/view, a Cosmos container, an ADX table, or a custom read-only
 * query), shown by the Connections page's "Analyze data" dialog after the user
 * selects a node from POST /api/connections/[id]/objects. Connection-keyed twin
 * of the report designer's connector-preview: it builds a `ConnectionDataSource`
 * from the stored connection + the posted `objectRef` and hands it to the shared
 * {@link buildConnectionExecutor} — the ONE place that loads the LoomConnection,
 * resolves its KV secret, checks the per-engine env gate, and wires the REAL
 * Azure data-plane client (SELECT TOP N / take N). No mock rows; an unconfigured
 * or unsupported path returns an honest 412 gate naming the exact remediation.
 * NO Fabric / Power BI / OneLake on any branch (no-fabric-dependency).
 *
 * Body: { objectRef: { mode:'table', schema?, table } | { mode:'query', sql }
 *                    | { mode:'kql', kql }, limit?: number }
 *
 * 200 → { ok:true, columns:string[], rows:Record<string,unknown>[], truncated }
 * 412 → { ok:false, code:'gate', error, missing? }   (honest, actionable)
 * 400 → bad body · 404 → connection not found · 401 → unauthenticated · 5xx
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadConnection, type ConnectionType } from '@/lib/azure/connections-store';
import {
  buildConnectionExecutor,
  type ConnectionDataSource,
  type ReportConnType,
  type ReportObjectRef,
} from '@/lib/azure/report-model-resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PreviewRequest {
  objectRef?: unknown;
  limit?: number;
}

/** Clamp a caller-supplied row cap to a safe positive integer (default 50). */
function clampLimit(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 50;
  return Math.min(Math.max(1, v), 1000);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Parse a wire `objectRef` into a discriminated `ReportObjectRef` (default table). */
function parseObjectRef(value: unknown): ReportObjectRef | null {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  switch (v.mode) {
    case 'query': {
      const sql = str(v.sql);
      return sql ? { mode: 'query', sql } : null;
    }
    case 'kql': {
      const kql = str(v.kql);
      return kql ? { mode: 'kql', kql } : null;
    }
    case 'file': {
      const containerPath = str(v.containerPath);
      return containerPath ? { mode: 'file', containerPath, format: str(v.format) || 'parquet' } : null;
    }
    case 'table':
    default: {
      const table = str(v.table);
      if (!table) return null;
      const schema = str(v.schema);
      return { mode: 'table', table, ...(schema ? { schema } : {}) };
    }
  }
}

/** Map a stored ConnectionType to the report data-source ReportConnType, or null
 *  for the non-tabular types (Event Hubs / Service Bus / Key Vault). */
function toReportConnType(t: ConnectionType): ReportConnType | null {
  switch (t) {
    case 'azure-sql': return 'azure-sql';
    case 'synapse-dedicated': return 'synapse-dedicated';
    case 'synapse-serverless': return 'synapse-serverless';
    case 'generic-sql': return 'generic-sql';
    case 'databricks-sql': return 'databricks-sql';
    case 'postgres': return 'postgres';
    case 'cosmos': return 'cosmos';
    case 'storage-adls': return 'storage-adls';
    case 'adx': return 'adx';
    default: return null;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const id = (await ctx.params).id;
  const conn = await loadConnection(session.claims.oid, id);
  if (!conn) return NextResponse.json({ ok: false, error: 'connection not found' }, { status: 404 });

  const connType = toReportConnType(conn.type);
  if (!connType) {
    return NextResponse.json(
      {
        ok: false,
        code: 'gate',
        error:
          `A "${conn.type}" connection isn't a tabular data source, so its rows can't be previewed. Use ` +
          'it where it is bound (eventstream, activator, or an item secret).',
        missing: 'connType',
      },
      { status: 412 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as PreviewRequest;
  const limit = clampLimit(body.limit);
  const objectRef = parseObjectRef(body.objectRef);
  if (!objectRef) {
    return NextResponse.json(
      { ok: false, error: 'Pick an object to preview — a table, a container, or a custom query.' },
      { status: 400 },
    );
  }

  // buildConnectionExecutor loads the connection itself (by id + tenant) and owns
  // ALL backend knowledge — the route never touches a data-plane client or secret.
  const source: ConnectionDataSource = { kind: 'connection', connectionId: id, connType, objectRef };
  let resolved: Awaited<ReturnType<typeof buildConnectionExecutor>>;
  try {
    resolved = await buildConnectionExecutor(source, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), status: 502 }, { status: 502 });
  }

  if (resolved.backend === 'unbound') {
    return NextResponse.json(
      {
        ok: false,
        code: 'gate',
        error: resolved.gate.error,
        ...(resolved.gate.missing ? { missing: resolved.gate.missing } : {}),
      },
      { status: 412 },
    );
  }

  try {
    const out = await resolved.executor.preview(limit);
    return NextResponse.json({ ok: true, columns: out.columns, rows: out.rows, truncated: out.truncated });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), status: 502 }, { status: 502 });
  }
}
