/**
 * External tables for the ADX/KQL database bound to a kql-database item.
 *
 *   GET    /api/adx/external-tables?id=ITEM
 *     → { ok, database, externalTables: [{ name, tableType, folder }] }
 *     → .show external tables
 *
 *   POST   /api/adx/external-tables?id=ITEM
 *     body { name, kind: 'delta'|'storage', ... }
 *       kind='delta'   { name, abfssUri, folder?, docString? }    → .create-or-alter external table … kind=delta
 *       kind='storage' { name, schema, dataFormat, connectionString, folder?, docString? }
 *                                                                 → .create-or-alter external table … kind=storage
 *     → { ok, name, kind }
 *
 *   DELETE /api/adx/external-tables?id=ITEM&name=N
 *     → .drop external table N ifexists
 *     → { ok }
 *
 * Real Kusto control commands to /v1/rest/mgmt. Database User to create,
 * Table Admin to alter/drop. Honest 503 gate when LOOM_KUSTO_CLUSTER_URI is
 * unset. No mocks. No Fabric / OneLake dependency — targets the stand-alone
 * ADX cluster.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listExternalTables, createExternalStorageTable, createOrAlterExternalTableDelta,
  dropExternalTable,
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
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  const kind: string = typeof body?.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  const folder: string | undefined = typeof body?.folder === 'string' && body.folder.trim() ? body.folder.trim() : undefined;
  const docString: string | undefined = typeof body?.docString === 'string' && body.docString.trim() ? body.docString.trim() : undefined;

  if (!validName(name)) {
    return NextResponse.json({ ok: false, error: 'name must start with a letter/underscore (letters, digits, _)' }, { status: 400 });
  }
  if (kind !== 'delta' && kind !== 'storage') {
    return NextResponse.json({ ok: false, error: "kind must be 'delta' or 'storage'" }, { status: 400 });
  }

  try {
    if (kind === 'delta') {
      const abfssUri: string = typeof body?.abfssUri === 'string' ? body.abfssUri.trim() : '';
      if (!/^abfss:\/\//i.test(abfssUri)) {
        return NextResponse.json({ ok: false, error: 'abfssUri must start with abfss://' }, { status: 400 });
      }
      await createOrAlterExternalTableDelta(g.ctx.database, name, abfssUri);
    } else {
      const schema: string = typeof body?.schema === 'string' ? body.schema.trim() : '';
      const dataFormat: string = typeof body?.dataFormat === 'string' ? body.dataFormat.trim() : '';
      const connectionString: string = typeof body?.connectionString === 'string' ? body.connectionString.trim() : '';
      if (!schema) return NextResponse.json({ ok: false, error: 'schema is required, e.g. "ts:datetime, v:long"' }, { status: 400 });
      if (!dataFormat) return NextResponse.json({ ok: false, error: 'dataFormat is required, e.g. csv | json | parquet' }, { status: 400 });
      if (!connectionString) return NextResponse.json({ ok: false, error: 'connectionString is required' }, { status: 400 });
      await createExternalStorageTable(g.ctx.database, name, schema, dataFormat, connectionString, { folder, docString });
    }
    return NextResponse.json({ ok: true, name, kind });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await dropExternalTable(g.ctx.database, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return adxError(e);
  }
}
