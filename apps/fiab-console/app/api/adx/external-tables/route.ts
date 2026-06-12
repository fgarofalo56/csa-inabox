/**
 * External tables on the ADX/KQL database bound to a kql-database item.
 *
 *   GET    /api/adx/external-tables?id=ITEM
 *            → .show external tables
 *            → { ok, database, externalTables: [{ name, tableType, folder, ... }] }
 *   POST   /api/adx/external-tables?id=ITEM body
 *            { name, kind:'delta'|'storage', abfssUri,
 *              schema?, dataFormat?, folder?, docString?, miObjectId?,
 *              queryAccelerationHotDays? }
 *            → .create-or-alter external table … kind=delta | kind=storage
 *              (+ optional .alter external table … policy query_acceleration)
 *            → { ok, name, kind, rowCount, queryAcceleration }
 *   DELETE /api/adx/external-tables?id=ITEM&name=T
 *            → .drop external table T ifexists
 *            → { ok, name, rowCount }
 *
 * Mirrors `/api/adx/policies` exactly: real Kusto control commands posted to
 * /v1/rest/mgmt through the shared honest-503 guard. No mocks.
 *
 * Two external-table kinds:
 *   - delta:   schema auto-inferred from the Delta log (createExternalDeltaTable).
 *   - storage: explicit CSL schema + dataformat (createExternalStorageTable) —
 *              the schema is assembled structurally by the UI ColumnGridDesigner,
 *              never raw KQL, honoring loom-no-freeform-config.
 *
 * Authoring requires Database Admin (Console UAMI holds AllDatabasesAdmin); the
 * ADX cluster's MI needs Storage Blob Data Reader on the ADLS account. Pure
 * ADX ↔ ADLS Gen2 — no Fabric / OneLake dependency.
 *
 * Grounded in Microsoft Learn:
 *   .show external tables          https://learn.microsoft.com/kusto/management/show-external-tables
 *   .create external table delta   https://learn.microsoft.com/kusto/management/external-tables-delta-lake
 *   .create external table storage https://learn.microsoft.com/kusto/management/external-tables-azure-storage
 *   .drop external table           https://learn.microsoft.com/kusto/management/drop-external-table
 *   query_acceleration policy      https://learn.microsoft.com/kusto/management/query-acceleration-policy
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listExternalTables, createExternalDeltaTable, createExternalStorageTable,
  setQueryAccelerationPolicy, showQueryAccelerationPolicy, dropExternalTable,
  KUSTO_EXTERNAL_TABLE_FORMATS, type KustoExternalTableFormat,
} from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  try {
    const externalTables = await listExternalTables(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, externalTables });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const kind = body?.kind === 'storage' ? 'storage' : 'delta';
  const abfssUri = typeof body?.abfssUri === 'string' ? body.abfssUri.trim() : '';
  const schema = typeof body?.schema === 'string' ? body.schema.trim() : '';
  const dataFormat = typeof body?.dataFormat === 'string' ? body.dataFormat.trim().toLowerCase() : '';
  const folder = typeof body?.folder === 'string' && body.folder.trim() ? body.folder.trim() : undefined;
  const docString = typeof body?.docString === 'string' && body.docString.trim() ? body.docString.trim() : undefined;
  const miObjectId = typeof body?.miObjectId === 'string' && body.miObjectId.trim() ? body.miObjectId.trim() : undefined;
  const hotRaw = body?.queryAccelerationHotDays;
  const hotDays = typeof hotRaw === 'number' && Number.isFinite(hotRaw) && hotRaw >= 1 ? Math.floor(hotRaw) : 0;

  if (!validName(name)) {
    return NextResponse.json(
      { ok: false, error: 'name must be a valid Kusto entity name (letters, digits, underscore; no leading digit)' },
      { status: 400 },
    );
  }
  if (!abfssUri || !/^abfss:\/\//i.test(abfssUri)) {
    return NextResponse.json(
      { ok: false, error: 'abfssUri must be an abfss:// URI (e.g. abfss://container@account.dfs.core.windows.net/path)' },
      { status: 400 },
    );
  }
  if (kind === 'storage') {
    if (!schema) {
      return NextResponse.json({ ok: false, error: 'schema is required for kind=storage (col:type, col:type)' }, { status: 400 });
    }
    if (!(KUSTO_EXTERNAL_TABLE_FORMATS as readonly string[]).includes(dataFormat)) {
      return NextResponse.json(
        { ok: false, error: `dataFormat must be one of ${KUSTO_EXTERNAL_TABLE_FORMATS.join(', ')} for kind=storage` },
        { status: 400 },
      );
    }
  }

  try {
    const r = kind === 'storage'
      ? await createExternalStorageTable(g.ctx.database, name, schema, abfssUri, dataFormat as KustoExternalTableFormat, { folder, docString, miObjectId })
      : await createExternalDeltaTable(g.ctx.database, name, abfssUri, { folder, docString, miObjectId });

    // Optional query-acceleration policy (delta tables benefit most; storage
    // Parquet/CSV also supported). Applied as a follow-up control command.
    let queryAcceleration: unknown = null;
    if (hotDays >= 1) {
      await setQueryAccelerationPolicy(g.ctx.database, name, hotDays);
      queryAcceleration = await showQueryAccelerationPolicy(g.ctx.database, name).catch(() => null);
    }

    return NextResponse.json({ ok: true, name, kind, rowCount: r.rowCount, queryAcceleration });
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
    const r = await dropExternalTable(g.ctx.database, name);
    return NextResponse.json({ ok: true, name, rowCount: r.rowCount });
  } catch (e: any) {
    return adxError(e);
  }
}
