/**
 * POST /api/items/lakehouse/[id]/query
 *
 * Runs T-SQL for a Lakehouse SQL analytics endpoint. In this deployment a
 * Lakehouse is an ADLS Gen2 medallion container (bronze/silver/gold/landing)
 * whose tabular SQL surface is Synapse Serverless (OPENROWSET over the lake
 * files + Delta tables) — the same backend the Files/Preview tab uses. This is
 * the lakehouse's own SQL route, calling the real Synapse Serverless TDS client
 * (no mock data).
 *
 * Body: { sql: string }
 *
 * Item scope:
 *   - The caller is authorized against the lakehouse ITEM through
 *     `_lib/adx-item-scope.ts::guardAdxItemRequest` (owner → tenant admin →
 *     shared ACL, with the workspace resolved from the item, and a 404 for an id
 *     naming no lakehouse). Read roles are accepted: the endpoint is read-only,
 *     and a shared Viewer runs the editor's SQL tab and the entity-diagram
 *     column enrichment through it.
 *   - The SQL tab runs in a server-chosen database, never one named by the
 *     request. For a caller who is not a tenant admin it is always `master`.
 *     A tenant admin runs in the database the item records (`state.sqlDatabase`
 *     or `state.sqlEndpointDatabase`, both server-owned state keys that a
 *     client write cannot set), else `master`.
 *   - For a caller who is not a tenant admin, the SQL text passes
 *     `../../_lib/query-scope.ts` before it runs: SELECT statements only, no
 *     `sys` catalog, and every OPENROWSET(BULK …) location must be a literal
 *     URL inside this item's container and root. A construct the classifier
 *     does not accept is a 400 that names it; a location outside the item root
 *     is a 403. Both carry a `remediation`. Tenant admins run SQL unchanged, as
 *     on the other lakehouse routes.
 *   - Objects already defined in the database the query runs in (views,
 *     external tables) are not re-checked here; a per-item serverless database
 *     rooted at the item root is the durable form of this boundary and is
 *     tracked separately.
 *
 * Background:
 *  - Fabric lakehouse SQL analytics endpoint: a read-only T-SQL endpoint over
 *    the lakehouse Delta tables (https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint).
 *  - OPENROWSET serverless over raw CSV/Parquet:
 *    https://learn.microsoft.com/azure/synapse-analytics/sql/develop-openrowset
 */

import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { serverlessTarget, executeQuery, getSynapseSqlSuffix } from '@/lib/azure/synapse-sql-client';
import { guardAdxItemRequest } from '../../../_lib/adx-item-scope';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { apiServerError } from '@/lib/api/respond';
import { resolveLakehouseStorage } from '@/lib/azure/lakehouse-abfss';
import { lakehouseStorageWithheldResponse } from '@/app/api/lakehouse/_lib/item-scope';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { analyzeLakehouseQuery, confineQueryLocation, type QueryRefusal } from '../../_lib/query-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The database every caller who is not a tenant admin runs in. */
const READER_DATABASE = 'master';

/**
 * The Serverless database a TENANT ADMIN's query runs in. Serverless exposes
 * `master` plus any explicitly-created serverless databases; the item may record
 * one in `state.sqlDatabase`, otherwise `master`. Both keys are server-owned
 * (`SERVER_OWNED_STATE_KEYS`, and cleared on create), so no client write sets
 * them; no provisioner writes them today either.
 */
function adminSqlDatabase(state: Record<string, unknown> | undefined): string {
  for (const key of ['sqlDatabase', 'sqlEndpointDatabase'] as const) {
    const v = state?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'master';
}

function refusalResponse(r: QueryRefusal): NextResponse {
  return NextResponse.json(
    { ok: false, error: r.error, code: r.code, construct: r.construct, remediation: r.remediation },
    { status: r.status },
  );
}

/**
 * Confine a non-admin caller's SQL to this item's storage root, or return the
 * response that refuses it. The item's storage binding is read only when the
 * query names a location, so a metadata query never waits on it.
 */
async function confineToItem(sqlText: string, item: WorkspaceItem, database: string): Promise<NextResponse | null> {
  const analysis = analyzeLakehouseQuery(sqlText, { database });
  if (!analysis.ok) return refusalResponse(analysis);
  if (analysis.locations.length === 0) return null;
  let storage: Awaited<ReturnType<typeof resolveLakehouseStorage>>;
  try {
    storage = await resolveLakehouseStorage(item.id, item.workspaceId);
  } catch (e) {
    // Fail closed with a structured body: an unread binding confirms nothing.
    return apiServerError(e);
  }
  if (!storage.ok) {
    const withheld = lakehouseStorageWithheldResponse(storage.reason);
    if (withheld) return withheld;
    return NextResponse.json(
      {
        ok: false,
        error:
          'No lakehouse storage is configured for this deployment, so the files this query names cannot be '
          + 'confirmed as this lakehouse\'s own.',
        code: 'lakehouse_storage_unbound',
        remediation:
          'The DLZ Bicep deploy sets LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL. Once one is set, Loom resolves and '
          + 'records this lakehouse\'s storage root itself; there is no per-item step.',
      },
      { status: 409 },
    );
  }
  for (const location of analysis.locations) {
    const confined = confineQueryLocation(location, storage.bound);
    if (!confined.ok) return refusalResponse(confined);
  }
  return null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'lakehouse',
    notFound: 'lakehouse not found',
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { session, item } = guard.ctx;

  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  if (!sqlText) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });

  // Item scope for the SQL text itself; tenant admins run SQL unchanged.
  const admin = isTenantAdmin(session);
  const database = admin ? adminSqlDatabase(item.state) : READER_DATABASE;
  if (!admin) {
    const refused = await confineToItem(sqlText, item, database);
    if (refused) return refused;
  }

  // Honest infra-gate: the lakehouse SQL endpoint requires a configured
  // Synapse Serverless workspace. Name the exact env var if it's missing,
  // rather than letting executeQuery throw an opaque "Missing env var".
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Lakehouse SQL analytics endpoint not provisioned in this deployment. ' +
          'Set LOOM_SYNAPSE_WORKSPACE (the Synapse workspace whose -ondemand serverless ' +
          'endpoint serves OPENROWSET over the medallion lake) and grant the Console UAMI ' +
          'the Synapse SQL admin / Storage Blob Data Reader roles.',
        code: 'synapse_not_configured',
      },
      { status: 503 },
    );
  }

  try {
    const result = await executeQuery(serverlessTarget(database), sqlText);
    return NextResponse.json({
      ok: true,
      ...result,
      endpoint: `${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.${getSynapseSqlSuffix()}`,
      database,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    // Sanitize: never surface a raw HTML error body to the UI (a firewall /
    // gateway 403 returns an XHTML page). Strip tags + collapse whitespace.
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    
    // Cold-start timeout: Synapse serverless OPENROWSET on CSV can take 30-60s on first run.
    // Surface a user-friendly message with honest remediation instead of a raw 502.
    const isColdTimeout = /timeout|cold/.test(raw);
    if (isColdTimeout) {
      return NextResponse.json(
        {
          ok: false,
          transient: true,
          retryAfterMs: 10_000,
          code: 'synapse_cold_start',
          error:
            'Query took longer than 60 seconds (Synapse serverless pool cold-start). ' +
            'OPENROWSET over CSV files can be slow on first execution. ' +
            'Retry the query — the pool will stay warm and subsequent queries run faster. ' +
            'For better performance, materialize the data as a Parquet or Delta table via a notebook.',
        },
        { status: 504 },
      );
    }
    
    const is403 = /\b403\b|forbidden|not allowed|denied/i.test(raw);
    if (is403) {
      // Auth-or-firewall denial: the endpoint is provisioned but the Console
      // identity can't reach/authorize against it. Honest gate, no HTML dump.
      return NextResponse.json(
        {
          ok: false,
          // A just-created container / just-granted role can 403 for a few
          // minutes while RBAC propagates to the SQL engine — let the editor
          // auto-retry a few times before showing the standing-gate text.
          transient: true,
          retryAfterMs: 20_000,
          code: 'synapse_access_denied',
          error:
            'If this container or file was just created, storage permissions may still be propagating (up to ~5 minutes). ' +
            'Otherwise: access denied to the Synapse Serverless SQL endpoint ' +
            `(${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.${getSynapseSqlSuffix()}). ` +
            'Two grants are required and one is missing in this deployment: ' +
            '(1) the Console UAMI must have CONNECT + db_datareader on the serverless DB ' +
            '(run: CREATE LOGIN/USER FROM EXTERNAL PROVIDER for the UAMI + GRANT), and ' +
            '(2) the Container App must be allowed through the Synapse SQL firewall ' +
            '(add its outbound IP / a managed private endpoint). ' +
            'See docs/fiab/v3-tenant-bootstrap.md.',
        },
        { status: 502 },
      );
    }
    // Empty / non-existent target path. OPENROWSET errors ("Content of
    // directory on path '…' cannot be listed", "Cannot bulk load … does not
    // exist", "path … not found") when the file/folder it points at has no
    // data yet — e.g. a shortcut to an Event Hubs capture path before any
    // events land, or a medallion folder not yet populated. This is an honest
    // "no data yet" state, not a failure — surface it as such, not a raw
    // EREQUEST.
    const isEmptyPath = /cannot be listed|does not exist|not found|no files|path.*could not be found|0x80070002/i.test(raw);
    if (isEmptyPath) {
      const m = raw.match(/path '([^']+)'/i);
      const where = m ? ` ('${m[1]}')` : '';
      return NextResponse.json(
        {
          ok: false,
          code: 'empty_or_missing_path',
          error:
            `No data at the query target${where} yet. The path is empty or doesn't exist — ` +
            `for a shortcut, its source hasn't been populated (e.g. an Event Hubs capture ` +
            `path before any events land, or a folder not yet written). Point the query/` +
            `shortcut at a populated path, run the pipeline/capture that fills it, or upload ` +
            `a file, then re-run. (No rows is expected until then.)`,
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: raw.slice(0, 400),
        code: e?.code,
        sqlState: e?.originalError?.info?.state,
        sqlNumber: e?.number,
      },
      { status: 502 },
    );
  }
}
