/**
 * Policies on the ADX/KQL database bound to a kql-database item.
 *
 *   GET  /api/adx/policies?id=ITEM → { ok, database, policies: [{ kind, policy, raw }] }
 *   POST /api/adx/policies?id=ITEM body { targetTable, source, query,
 *          isTransactional?, propagateIngestionProperties? }
 *        → .alter table ["<targetTable>"] policy update @'[{...}]'
 *        → { ok, targetTable, rowCount, policy: { policy, raw } }
 *
 * GET issues real Kusto control commands (`.show database <db> policy <kind>`)
 * to /v1/rest/mgmt — one per database-scoped policy (retention / caching /
 * sharding / mergepolicy / streamingingestion). Unset/unsupported policies are
 * skipped, not errored.
 *
 * POST sets a table-scoped *update policy* (transform-on-ingest ETL): when rows
 * land in `source`, the `query` (a stored function call or inline KQL over the
 * source) runs and its output is appended to `targetTable`. The handler then
 * reads `.show table policy update` back and returns it as the receipt.
 *
 * Honest 503 gate via the shared guard. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  showDatabasePolicies, setTableUpdatePolicy, showTableUpdatePolicy,
} from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  try {
    const policies = await showDatabasePolicies(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, policies });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const targetTable = typeof body?.targetTable === 'string' ? body.targetTable.trim() : '';
  const source = typeof body?.source === 'string' ? body.source.trim() : '';
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  const isTransactional = body?.isTransactional === true;
  const propagateIngestionProperties = body?.propagateIngestionProperties === true;
  if (!validName(targetTable)) {
    return NextResponse.json(
      { ok: false, error: 'targetTable must be a valid Kusto entity name (letters, digits, underscore)' },
      { status: 400 },
    );
  }
  if (!validName(source)) {
    return NextResponse.json(
      { ok: false, error: 'source must be a valid Kusto entity name' },
      { status: 400 },
    );
  }
  if (!query) {
    return NextResponse.json(
      { ok: false, error: 'query is required (stored function call or inline KQL expression)' },
      { status: 400 },
    );
  }
  try {
    const r = await setTableUpdatePolicy(g.ctx.database, targetTable, [{
      IsEnabled: true,
      Source: source,
      Query: query,
      IsTransactional: isTransactional,
      PropagateIngestionProperties: propagateIngestionProperties,
    }]);
    // Read the policy back from the cluster as the receipt.
    const applied = await showTableUpdatePolicy(g.ctx.database, targetTable).catch(() => null);
    return NextResponse.json({ ok: true, targetTable, rowCount: r.rowCount, policy: applied });
  } catch (e: any) {
    return adxError(e);
  }
}
