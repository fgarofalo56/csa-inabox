/**
 * POST /api/items/report/[id]/connector-preview
 *
 * Navigator PREVIEW for the report designer's Power BI-style "Get Data"
 * experience (REPORT-BUILDER PARITY · WAVE 1). Given a Get-Data data source —
 * a reusable, KV-backed Loom Connection (`kind:'connection'`), a user-uploaded
 * file staged to ADLS landing (`kind:'file-upload'`), or an existing ADLS Gen2
 * path (`kind:'adls-file'`) — it returns the first N rows of the selected object
 * so the gallery's Navigator can show a live, REAL-data preview BEFORE the
 * source is persisted onto the report.
 *
 * ── Dispatch (thin, like /fields + /query) ─────────────────────────────────
 * This route owns NO backend knowledge. It resolves the source to preview — the
 * live `body.source` (Navigator preview before persist), with an optional
 * `body.objectRef` override for the object the user just clicked in the
 * Navigator, else the report's persisted `state.dataSource` — and hands it to
 * `buildConnectionExecutor` (the ONE place that loads the LoomConnection,
 * resolves its KV secret when the auth method needs one, checks the per-engine
 * env gate, and wires the REAL Azure data-plane client). It then calls
 * `executor.preview(limit)`:
 *   • SQL family (Azure SQL / Synapse / Databricks SQL / generic) → `SELECT TOP N *`
 *   • Cosmos DB                                                    → `SELECT TOP N * FROM c`
 *   • ADLS / Blob / uploaded files                                → serverless OPENROWSET TOP N
 *
 * Rules compliance:
 *  - no-vaporware: every supported connector previews against a real Azure
 *    backend; an unconfigured / unsupported / not-yet-queryable path returns an
 *    honest 412 gate naming the exact connection / role / env (the resolver's
 *    postgresQueryGate / databricksConfigGate / LOOM_SYNAPSE_WORKSPACE / missing
 *    connection), and an incomplete object selection returns an honest 412 gate
 *    naming what to pick. NO mock arrays, NO `return []`.
 *  - no-fabric-dependency: Azure-native default everywhere — no Fabric / Power BI
 *    / OneLake on this path; the executor's clients are all Azure data-plane.
 *  - no-freeform-config: the route validates a structured `ReportDataSource` /
 *    `ReportObjectRef` (picker choices); only the connection's `mode:'query'` /
 *    `mode:'kql'` escape hatch is free text, and it is sql-guard'd upstream.
 *  - no new credential code: the route never touches a data-plane client or a
 *    secret directly — `buildConnectionExecutor` owns all of that.
 *
 * 200 → { ok:true, columns:string[], rows:Record<string,unknown>[], truncated:boolean }
 * 412 → { ok:false, code:'gate', error, missing? }   (honest, actionable)
 * 400 → { ok:false, error }                           (bad body / non-Get-Data source)
 * 4xx/5xx → { ok:false, error, status? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadModelItem } from '@/lib/azure/model-binding';
import { buildConnectionExecutor } from '@/lib/azure/report-model-resolver';
import {
  parseDataSource,
  fromLegacyState,
  isBound,
  isConnectionSource,
  isFileSource,
  type ReportDataSource,
  type ConnectionDataSource,
  type FileUploadDataSource,
  type AdlsFileDataSource,
} from '@/lib/editors/report/report-data-source';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PreviewRequest {
  /** Live source to preview before persist (else the report's saved source). */
  source?: unknown;
  /** The object the user just selected in the Navigator (connection sources). */
  objectRef?: unknown;
  /** Row cap (default 50, clamped 1..1000). */
  limit?: number;
}

/** Clamp a caller-supplied row cap to a safe positive integer (default 50). */
function clampLimit(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 50;
  return Math.min(Math.max(1, v), 1000);
}

/**
 * Honest "incomplete selection" gate copy for a structurally-unbound Get-Data
 * source — `buildConnectionExecutor` does not validate object-ref completeness,
 * so without this the SQL/file executor would run a malformed `FROM` and throw.
 * Name exactly what the author still has to pick (no crash, no mock).
 */
function incompleteGate(source: ReportDataSource): { error: string; missing: string } {
  if (source.kind === 'connection') {
    if (!source.connectionId.trim()) {
      return {
        error:
          'No connection is bound yet. Open "Data source" → Get data and pick (or add) a connection.',
        missing: 'connection',
      };
    }
    return {
      error:
        'Pick an object to preview — a table, a file, or a custom query — inside the connection.',
      missing: 'objectRef',
    };
  }
  // file-upload | adls-file
  return {
    error:
      'The file data source is incomplete. Re-pick the uploaded file or ADLS path (a path and a ' +
      'format are required).',
    missing: 'dataSource',
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as PreviewRequest;
  const limit = clampLimit(body.limit);

  // Load the report item (loom: content id OR plain Cosmos id), owner-checked —
  // identical pattern to /fields + /query.
  const id = (await ctx.params).id;
  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) {
      return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
    }
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) {
      return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
    }
  }

  // Resolve the source to preview: the live `body.source` (Navigator preview
  // before persist) wins; otherwise the report's persisted data source.
  let source: ReportDataSource | null;
  if (body.source !== undefined && body.source !== null) {
    source = parseDataSource(body.source);
    if (!source) {
      return NextResponse.json(
        { ok: false, error: 'Invalid "source" in request body.' },
        { status: 400 },
      );
    }
  } else {
    source = fromLegacyState((item.state || {}) as Record<string, unknown>);
  }
  if (!source) {
    return NextResponse.json(
      {
        ok: false,
        code: 'gate',
        error:
          'This report has no data source yet. Open "Data source" → Get data and pick a connection, ' +
          'an uploaded file, or an ADLS path to preview.',
        missing: 'dataSource',
      },
      { status: 412 },
    );
  }

  // Navigator object override: when the user clicks a table/file in the Navigator
  // the client sends the selected objectRef alongside the (possibly already-saved)
  // connection source — splice it in so the preview targets that object. Re-parse
  // through `parseDataSource` so the objectRef is normalized + mode-discriminated.
  if (body.objectRef !== undefined && source.kind === 'connection') {
    const merged = parseDataSource({ ...source, objectRef: body.objectRef });
    if (merged && merged.kind === 'connection') source = merged;
  }

  // Connector preview applies ONLY to the Get-Data kinds. A semantic-model /
  // direct-query / aas source has no "connector" to navigate — its rows come from
  // /query and its schema from /fields.
  if (!isConnectionSource(source) && !isFileSource(source)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Connector preview applies only to Get Data sources (a connection, an uploaded file, or an ' +
          'ADLS path). Use the report’s Fields/Query endpoints for a semantic model or direct query.',
      },
      { status: 400 },
    );
  }

  // Honest structural gate (no crash, no mock): the connection/file object isn't
  // fully specified yet — name exactly what to pick.
  if (!isBound(source)) {
    const gate = incompleteGate(source);
    return NextResponse.json({ ok: false, code: 'gate', ...gate }, { status: 412 });
  }

  // Resolve the source → a real ConnectionExecutor (or an honest infra/connection
  // gate). `buildConnectionExecutor` owns ALL backend knowledge: it loads the
  // LoomConnection, resolves its KV secret, checks the per-engine env gate, and
  // wires the REAL Azure data-plane client. The route never touches a client.
  const getData = source as ConnectionDataSource | FileUploadDataSource | AdlsFileDataSource;
  let resolved: Awaited<ReturnType<typeof buildConnectionExecutor>>;
  try {
    resolved = await buildConnectionExecutor(getData, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), status: 502 },
      { status: 502 },
    );
  }

  // Honest 412 gate — name the exact connection / role / env that's missing.
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

  // Real Navigator preview: SELECT/​take TOP N against the live Azure backend.
  try {
    const out = await resolved.executor.preview(limit);
    return NextResponse.json({
      ok: true,
      columns: out.columns,
      rows: out.rows,
      truncated: out.truncated,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), status: 502 },
      { status: 502 },
    );
  }
}
