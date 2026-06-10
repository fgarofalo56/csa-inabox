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
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeParameterized } from '@/lib/azure/azure-sql-client';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'copy-job';
const CONTROL_MODULE = 'platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;

  const server = process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
  const database = process.env.LOOM_COPYJOB_CONTROL_SQL_DB || 'loom-control';
  if (!server) {
    return NextResponse.json({
      ok: true,
      configured: false,
      missing: 'LOOM_COPYJOB_CONTROL_SQL_SERVER',
      module: CONTROL_MODULE,
    });
  }

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const spec: any = item.state || {};
    const sourceTable = spec.source?.sourceTable || spec.source?.table || '';
    const sourceName = spec.sourceName || sourceTable;
    if (!sourceName || !sourceTable) {
      // Incremental never configured — nothing to read yet, but control table is reachable.
      return NextResponse.json({ ok: true, configured: true, watermark: null });
    }

    const rows = await executeParameterized<{ source: string; table_name: string; last_value: string | null; updated_utc: string | null }>(
      server,
      database,
      'SELECT source, table_name, last_value, CONVERT(varchar(33), updated_utc, 126) AS updated_utc ' +
      'FROM dbo.copy_watermark WHERE source = @p0 AND table_name = @p1',
      [sourceName, sourceTable],
    );
    return NextResponse.json({ ok: true, configured: true, watermark: rows[0] || null });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
