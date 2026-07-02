/**
 * Continuous-export AUTHORING on the ADX/KQL database bound to a kql-database
 * item. The read-only list is also surfaced by `/api/adx/overview`; this route
 * CREATES / EDITS / DROPS jobs — the same authoring the ADX portal / Fabric RTI
 * "Continuous export" surface performs.
 *
 *   GET    /api/adx/continuous-exports?id=ITEM
 *            → .show continuous-exports
 *            → { ok, database, continuousExports: [{ name, externalTableName, query, ... }] }
 *   POST   /api/adx/continuous-exports?id=ITEM  body
 *            { name, sourceTable, externalTable, interval, query? }
 *            → .create-or-alter continuous-export NAME over (src) to table ext
 *                with (intervalBetweenRuns=…, managedIdentity=system) <| query
 *            → { ok, name, continuousExport }   (read-back receipt)
 *   DELETE /api/adx/continuous-exports?id=ITEM&name=CE
 *            → .drop continuous-export CE
 *            → { ok, name }
 *
 * The `externalTable` must already exist (author it via `/api/adx/external-tables`).
 * Real Kusto control commands to /v1/rest/mgmt (Console UAMI holds
 * AllDatabasesAdmin). Requires Database Admin; a principal lacking the role gets
 * a 403/Forbidden returned verbatim so the UI renders the honest gate. Honest
 * 503 via the shared guard when LOOM_KUSTO_CLUSTER_URI is unset. No mocks.
 *
 * Grounded in Microsoft Learn (Continuous data export):
 *   .create-or-alter continuous-export  https://learn.microsoft.com/kusto/management/data-export/create-alter-continuous
 *   .show continuous-export[s]           https://learn.microsoft.com/kusto/management/data-export/show-continuous-export
 *   .drop continuous-export             https://learn.microsoft.com/kusto/management/data-export/drop-continuous-export
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listContinuousExports, createOrAlterContinuousExport,
  showContinuousExport, dropContinuousExport,
} from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  try {
    const continuousExports = await listContinuousExports(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, continuousExports });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const sourceTable = typeof body?.sourceTable === 'string' ? body.sourceTable.trim() : '';
  const externalTable = typeof body?.externalTable === 'string' ? body.externalTable.trim() : '';
  const interval = typeof body?.interval === 'string' ? body.interval.trim() : '';
  const query = typeof body?.query === 'string' && body.query.trim() ? body.query.trim() : undefined;

  if (!validName(name)) {
    return NextResponse.json({ ok: false, error: 'name must be a valid Kusto entity name (letters, digits, underscore; no leading digit)' }, { status: 400 });
  }
  if (!validName(sourceTable)) {
    return NextResponse.json({ ok: false, error: 'sourceTable must be a valid Kusto entity name' }, { status: 400 });
  }
  if (!validName(externalTable)) {
    return NextResponse.json({ ok: false, error: 'externalTable must be a valid Kusto entity name (create it first via External tables)' }, { status: 400 });
  }
  if (!/^\d+[smhd]$/.test(interval)) {
    return NextResponse.json({ ok: false, error: 'interval must be a KQL timespan e.g. 5m, 1h, 24h' }, { status: 400 });
  }

  try {
    await createOrAlterContinuousExport(g.ctx.database, name, sourceTable, externalTable, interval, { query });
    const continuousExport = await showContinuousExport(g.ctx.database, name).catch(() => null);
    return NextResponse.json({ ok: true, database: g.ctx.database, name, continuousExport });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const name = req.nextUrl.searchParams.get('name')?.trim() || '';
  if (!validName(name)) {
    return NextResponse.json({ ok: false, error: 'name query param is required and must be a valid Kusto entity name' }, { status: 400 });
  }
  try {
    const r = await dropContinuousExport(g.ctx.database, name);
    return NextResponse.json({ ok: true, name, rowCount: r.rowCount });
  } catch (e: any) {
    return adxError(e);
  }
}
