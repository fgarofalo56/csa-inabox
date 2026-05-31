/**
 * Read-only database overview for the ADX navigator footer/info rows.
 *
 *   GET /api/adx/overview?id=ITEM
 *     → { ok, database, schema, continuousExports: [{name, externalTableName, isRunning}] }
 *
 * Backs the honest read-only "Database schema" + "Continuous export" rows in
 * the navigator. Continuous export *authoring* (.create-or-alter
 * continuous-export) requires an external table + Database Admin and is
 * surfaced as a coming row, not wired here. Real Kusto control commands to
 * /v1/rest/mgmt. Honest 503 gate. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseSchemaJson, listContinuousExports } from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  try {
    // These are best-effort: a freshly-created DB may have neither. Don't fail
    // the whole overview if continuous-exports isn't permitted for the caller.
    const [schema, continuousExports] = await Promise.all([
      getDatabaseSchemaJson(g.ctx.database).catch(() => null),
      listContinuousExports(g.ctx.database).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, database: g.ctx.database, schema, continuousExports });
  } catch (e: any) {
    return adxError(e);
  }
}
