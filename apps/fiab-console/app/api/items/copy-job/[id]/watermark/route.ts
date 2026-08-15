/**
 * GET /api/items/copy-job/[id]/watermark
 *
 * Reads this copy job's checkpoint from the dbo.copy_watermark control table in
 * Azure SQL (azure-sql-client, real TDS+AAD — no mock). The same row backs both
 * Incremental mode (high-water mark in last_value) and CDC mode (last processed
 * log-sequence number in last_value). Backs the Watermark / CDC checkpoint panel
 * in the Copy job editor and lets the UI prove each run advanced the checkpoint.
 *
 * When LOOM_COPYJOB_CONTROL_SQL_SERVER is unset the route returns an honest
 * config gate (configured:false + the exact env var + bicep module) rather than
 * an error, so the editor can render the no-vaporware MessageBar.
 *
 * AUTHORIZATION — `withWorkspaceOwner(…, { allowReadRoles: true })` (R3).
 *   This is a strictly READ-ONLY panel, so it admits shared read roles, which is
 *   what every sibling read surface on an item already does
 *   (agent-flow/[id]/runs, activation-sync/[id]/runs, ai-enrichment/[id]/runs,
 *   airflow-job/[id]/dag-runs, and the GET half of [type]/[id]/definition).
 *   The hand-rolled prologue this replaces called
 *   `loadOwnedItem(id, ITEM_TYPE, oid)` with NO options, and that helper is
 *   WRITE-SCOPED by default (`if (!opts.allowReadRoles && !access.canWrite)
 *   return null`) — so a Viewer/Contributor with legitimate read access to the
 *   workspace got a 404 on the checkpoint panel while the rest of the editor
 *   loaded. Read surfaces on one item disagreeing about who may read is the
 *   defect class #3499 found; this is the same shape.
 *
 *   The wrapper also threads the caller's session into `loadOwnedItem`, so the
 *   cross-tenant `tid` boundary runs from the session CLAIMS rather than the
 *   ambient-cookie fallback (#2703) — the hand-rolled call did not.
 */

import { apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { executeParameterized } from '@/lib/azure/azure-sql-client';
import { tsql } from '@/lib/sql/trusted-sql';
import { jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'copy-job';
const CONTROL_MODULE = 'platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep';

interface WatermarkRow {
  source: string;
  table_name: string;
  last_value: string | null;
  updated_utc: string | null;
}

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (_req, { item }) => {
  const server = process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
  const database = process.env.LOOM_COPYJOB_CONTROL_SQL_DB || 'loom-control';
  if (!server) {
    return apiOk({ configured: false, missing: 'LOOM_COPYJOB_CONTROL_SQL_SERVER', module: CONTROL_MODULE });
  }

  try {
    const spec: any = item.state || {};
    const sourceTable = spec.source?.sourceTable || spec.source?.table || '';
    const sourceName = spec.sourceName || sourceTable;
    if (!sourceName || !sourceTable) {
      // Incremental never configured — nothing to read yet, but control table is reachable.
      return apiOk({ configured: true, watermark: null });
    }

    const rows = await executeParameterized<WatermarkRow>(
      server,
      database,
      tsql`SELECT source, table_name, last_value, CONVERT(varchar(33), updated_utc, 126) AS updated_utc FROM dbo.copy_watermark WHERE source = @p0 AND table_name = @p1`,
      [sourceName, sourceTable],
    );
    return apiOk({ configured: true, watermark: rows[0] || null });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
});
