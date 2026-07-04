/**
 * POST /api/items/report/[id]/connector-objects
 *
 * Navigator OBJECT INTROSPECTION for the report designer's Power BI-style
 * "Get Data" experience (REPORT-BUILDER PARITY · WAVE 2). The W1 Navigator gave
 * a row PREVIEW (POST .../connector-preview → executor.preview(N)); this route
 * gives the TREE: the real catalog → schema → tables/views structure the user
 * expands and multi-selects in the Fluent `Tree`, BEFORE a source is persisted.
 *
 * This route is a THIN DISPATCHER (rel-T64): it owner-loads the report item,
 * resolves the source to introspect, derives the provider, and delegates to the
 * per-provider introspection + the NavNode wire adapter, which live in reusable
 * lib modules:
 *   • lib/report/navigator/introspect.ts — the contract types, gate helpers, and
 *     per-provider introspection against the EXISTING Azure data-plane / ARM
 *     clients (sql-objects / databricks / postgres / cosmos / kusto / adls /
 *     synapse-catalog). Every node is a REAL introspected object (no-vaporware);
 *     NO Fabric / Power BI / OneLake host is reached on any branch
 *     (no-fabric-dependency). An unconfigured backend returns an honest 412 gate.
 *   • lib/report/navigator/wire.ts — the `NavigatorObject → NavNode` adapter + the
 *     opaque `childToken` codec the connector dialog echoes back to lazily expand
 *     a branch. `respond` builds the 200 body; `resolveCoords` decodes the
 *     requested tree position.
 *
 * 200 → { ok:true, provider, level, capabilities:{ directQueryCapable },
 *         nodes: NavNode[] }                          (dialog reads `nodes`)
 * 412 → { ok:false, code:'gate', error, missing? }   (honest, actionable)
 * 400 → { ok:false, error }                           (bad body / non-Get-Data source)
 * 4xx/5xx → { ok:false, error, status? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadModelItem } from '@/lib/azure/model-binding';
import {
  parseDataSource,
  fromLegacyState,
  type ReportDataSource,
  type ConnectionDataSource,
  type FileUploadDataSource,
  type AdlsFileDataSource,
} from '@/lib/editors/report/report-data-source';
import { loadConnection } from '@/lib/azure/connections-store';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  gate,
  bad,
  fail,
  leafName,
  providerForConnType,
  introspectSql,
  introspectDatabricks,
  introspectPostgres,
  introspectCosmos,
  introspectAdx,
  introspectAdls,
  introspectLakehouse,
  type NavProvider,
  type NavigatorObject,
  type ObjectsRequest,
} from '@/lib/report/navigator/introspect';
import { resolveCoords, respond } from '@/lib/report/navigator/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as ObjectsRequest;
  // Decode the tree position: the dialog echoes a branch's opaque `parent`
  // childToken (null at root); a non-dialog caller may pass explicit coords.
  const coords = resolveCoords(body);
  const level = coords.level;

  // Load the report item (loom: content id OR plain Cosmos id), owner-checked —
  // identical pattern to /connector-preview + /fields + /query.
  const id = (await ctx.params).id;
  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
  }

  // Resolve the source to introspect: the live `body.source` (Navigator before
  // persist, incl. the W1 get-data bind step) wins; else the persisted source.
  let source: ReportDataSource | null;
  if (body.source !== undefined && body.source !== null) {
    source = parseDataSource(body.source);
    if (!source) return bad('Invalid "source" in request body.');
  } else {
    source = fromLegacyState((item.state || {}) as Record<string, unknown>);
  }
  if (!source) {
    return gate(
      'This report has no data source yet. Open "Data source" → Get data and pick a connection, an ' +
        'uploaded file, or an ADLS path to browse its objects.',
      'dataSource',
    );
  }

  // The Navigator applies ONLY to Get-Data sources (a connection or a file). A
  // semantic-model / direct-query / aas source has no connector tree to browse.
  if (source.kind !== 'connection' && source.kind !== 'file-upload' && source.kind !== 'adls-file') {
    return bad(
      'Object navigation applies only to Get Data sources (a connection, an uploaded file, or an ADLS ' +
        'path). A semantic model, direct query, or Analysis Services binding has no connector tree.',
    );
  }

  // An explicit `provider:'lakehouse'` (in the body or carried in the childToken)
  // switches an ADLS / serverless source to the managed Delta-table catalog.
  const wantLakehouse = coords.provider === 'lakehouse' || body.provider === 'lakehouse';

  try {
    // ── File sources (no connection) ──────────────────────────────────────────
    if (source.kind === 'file-upload') {
      // A staged upload IS the object — surface it as a single selectable leaf so
      // the Navigator shows the bound file (never a blank tree).
      const f = source as FileUploadDataSource;
      const objects: NavigatorObject[] = f.containerPath
        ? [{
            name: f.fileName || leafName(f.containerPath),
            kind: 'file',
            containerPath: f.containerPath,
            format: f.format,
            deltaBacked: (f.format || '').toLowerCase() === 'delta',
            hasChildren: false,
            selectable: true,
            objectRef: { mode: 'file', containerPath: f.containerPath, format: f.format },
          }]
        : [];
      return respond('adls', coords, objects);
    }

    if (source.kind === 'adls-file') {
      const a = source as AdlsFileDataSource;
      const provider: NavProvider = wantLakehouse ? 'lakehouse' : 'adls';
      const result = wantLakehouse
        ? await introspectLakehouse(level, coords.container || a.container)
        : await introspectAdls(level, coords.container || a.container, coords.path ?? a.path);
      if (result instanceof NextResponse) return result;
      return respond(provider, coords, result);
    }

    // ── Connection sources ────────────────────────────────────────────────────
    const conn0 = source as ConnectionDataSource;
    if (!conn0.connectionId) {
      return gate(
        'This report\'s Get Data source has no connection bound yet. Open "Data source" and pick (or add) a connection.',
        'connection',
      );
    }
    const conn = await loadConnection(session.claims.oid, conn0.connectionId);
    if (!conn) {
      return gate(
        `The bound connection (${conn0.connectionId}) was not found in this tenant. Re-pick a connection in the report's Data source panel.`,
        'connection',
      );
    }

    // Storage / serverless connections can browse either raw ADLS paths or the
    // managed Delta-table catalog (provider:'lakehouse').
    if (conn.type === 'storage-adls' || (wantLakehouse && conn.type === 'synapse-serverless')) {
      const provider: NavProvider = wantLakehouse ? 'lakehouse' : 'adls';
      const result = wantLakehouse
        ? await introspectLakehouse(level, coords.container)
        : await introspectAdls(level, coords.container, coords.path);
      if (result instanceof NextResponse) return result;
      return respond(provider, coords, result);
    }

    const provider = providerForConnType(conn.type);
    let objects: NavigatorObject[] | NextResponse;
    switch (provider) {
      case 'sql':
        try {
          objects = await introspectSql(conn, level, coords.schema);
        } catch (e: any) {
          if (e?.gateMissing) return gate(e.message, e.gateMissing);
          throw e;
        }
        break;
      case 'databricks':
        objects = await introspectDatabricks(conn, level, coords.catalog, coords.schema);
        break;
      case 'postgres':
        objects = await introspectPostgres(conn, level, coords.schema);
        break;
      case 'cosmos':
        objects = await introspectCosmos(conn, level);
        break;
      case 'adx':
        objects = await introspectAdx(conn, level);
        break;
      default:
        // event-hub / service-bus / key-vault — not a tabular report source.
        return gate(
          `A "${conn.type}" connection isn't browsable as a report source. Pick an Azure SQL, Synapse, ` +
            'Databricks SQL, PostgreSQL, Cosmos DB, or ADLS/Blob connection.',
          'connType',
        );
    }
    if (objects instanceof NextResponse) return objects;
    return respond(provider, coords, objects);
  } catch (e: any) {
    return fail(e);
  }
}
