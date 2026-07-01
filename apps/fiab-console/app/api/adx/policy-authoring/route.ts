/**
 * Retention + caching policy AUTHORING on the ADX/KQL database bound to a
 * kql-database item. The read-only current policies are surfaced by
 * `/api/adx/policies` (GET); this route ALTERS them — the same authoring the
 * ADX portal / Fabric RTI "Retention" + "Caching" policy dialogs perform.
 *
 *   POST /api/adx/policy-authoring?id=ITEM  body:
 *     { kind: 'retention', scope: 'database'|'table', table?,
 *       softDeleteDays: number, recoverability: 'Enabled'|'Disabled' }
 *       → .alter [table|database] policy retention '{"SoftDeletePeriod":…,"Recoverability":…}'
 *     { kind: 'caching',   scope: 'database'|'table', table?,
 *       hotValue: number, hotUnit: 'm'|'h'|'d' }
 *       → .alter [table|database] policy caching hot = <value><unit>
 *     → { ok, database, kind, scope, table?, policy }  (policy = read-back receipt)
 *
 * Real Kusto control commands to /v1/rest/mgmt (Console UAMI holds
 * AllDatabasesAdmin). Requires Database Admin (table scope also accepts Table
 * Admin); a principal lacking the role gets a 403/Forbidden from the cluster,
 * returned verbatim so the UI renders the honest "needs Database Admin" gate.
 * Honest 503 via the shared guard when LOOM_KUSTO_CLUSTER_URI is unset. No mocks.
 *
 * Grounded in Microsoft Learn:
 *   retention policy  https://learn.microsoft.com/kusto/management/retention-policy
 *   caching policy    https://learn.microsoft.com/kusto/management/cache-policy
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  KUSTO_RECOVERABILITY, type KustoRecoverability,
  setTableRetentionPolicy, setDatabaseRetentionPolicy,
  setTableCachingPolicy, setDatabaseCachingPolicy,
  showTablePolicy, showDatabasePolicy,
} from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));

  const kind = body?.kind === 'caching' ? 'caching' : body?.kind === 'retention' ? 'retention' : '';
  const scope = body?.scope === 'table' ? 'table' : 'database';
  const table = typeof body?.table === 'string' ? body.table.trim() : '';

  if (!kind) {
    return NextResponse.json({ ok: false, error: "kind must be 'retention' or 'caching'" }, { status: 400 });
  }
  if (scope === 'table' && !validName(table)) {
    return NextResponse.json({ ok: false, error: 'table must be a valid Kusto entity name for table scope' }, { status: 400 });
  }

  try {
    if (kind === 'retention') {
      const softDeleteDays = Number(body?.softDeleteDays);
      const recoverability: KustoRecoverability =
        body?.recoverability === 'Disabled' ? 'Disabled' : 'Enabled';
      if (!Number.isFinite(softDeleteDays) || softDeleteDays < 0) {
        return NextResponse.json({ ok: false, error: 'softDeleteDays must be a non-negative integer' }, { status: 400 });
      }
      if (!(KUSTO_RECOVERABILITY as readonly string[]).includes(recoverability)) {
        return NextResponse.json({ ok: false, error: "recoverability must be 'Enabled' or 'Disabled'" }, { status: 400 });
      }
      if (scope === 'table') await setTableRetentionPolicy(g.ctx.database, table, softDeleteDays, recoverability);
      else await setDatabaseRetentionPolicy(g.ctx.database, softDeleteDays, recoverability);
    } else {
      const hotValue = Number(body?.hotValue);
      const hotUnit = ['m', 'h', 'd'].includes(body?.hotUnit) ? String(body.hotUnit) : 'd';
      if (!Number.isFinite(hotValue) || hotValue < 0) {
        return NextResponse.json({ ok: false, error: 'hotValue must be a non-negative integer' }, { status: 400 });
      }
      const hot = `${Math.floor(hotValue)}${hotUnit}`;
      if (scope === 'table') await setTableCachingPolicy(g.ctx.database, table, hot);
      else await setDatabaseCachingPolicy(g.ctx.database, hot);
    }

    // Read the applied policy back from the cluster as the receipt.
    const policy = scope === 'table'
      ? await showTablePolicy(g.ctx.database, table, kind).catch(() => null)
      : await showDatabasePolicy(g.ctx.database, kind).catch(() => null);

    return NextResponse.json({
      ok: true,
      database: g.ctx.database,
      kind,
      scope,
      table: scope === 'table' ? table : undefined,
      policy,
    });
  } catch (e: any) {
    return adxError(e);
  }
}
