/**
 * Read-only database policies on the ADX/KQL database bound to a kql-database item.
 *
 *   GET /api/adx/policies?id=ITEM → { ok, database, policies: [{ kind, policy, raw }] }
 *
 * Real Kusto control commands (`.show database <db> policy <kind>`) to
 * /v1/rest/mgmt — one per policy (retention / caching / sharding / mergepolicy /
 * streamingingestion). Unset/unsupported policies are skipped, not errored.
 * Honest 503 gate via the shared guard. No mocks. Read-only (no POST/DELETE).
 */

import { NextRequest, NextResponse } from 'next/server';
import { showDatabasePolicies } from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError } from '../_shared';

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
