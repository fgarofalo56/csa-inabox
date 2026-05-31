/**
 * Ingestion mappings on the ADX/KQL database bound to a kql-database item.
 *
 *   GET    /api/adx/ingestion-mappings?id=ITEM
 *            → { ok, mappings: [{name, kind, table, mapping}] }
 *   POST   /api/adx/ingestion-mappings?id=ITEM
 *            body { name, kind, table, mapping } → .create-or-alter table ... ingestion <kind> mapping
 *   DELETE /api/adx/ingestion-mappings?id=ITEM&name=NAME&kind=KIND[&table=T]
 *            → .drop <table|database> ... ingestion <kind> mapping NAME
 *
 * `mapping` is the mapping definition formatted as a JSON value (array of
 * { column, datatype?, Properties }). Real Kusto control commands to
 * /v1/rest/mgmt. Honest 503 gate. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listIngestionMappings, createIngestionMapping, dropIngestionMapping } from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KIND_RE = /^(csv|json|avro|parquet|orc|w3clogfile)$/i;

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  try {
    const mappings = await listIngestionMappings(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, mappings });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  const kind: string = typeof body?.kind === 'string' ? body.kind.trim() : '';
  const table: string = typeof body?.table === 'string' ? body.table.trim() : '';
  const mapping: string = typeof body?.mapping === 'string' ? body.mapping.trim() : '';
  if (!validName(name)) return NextResponse.json({ ok: false, error: 'name must start with a letter/underscore' }, { status: 400 });
  if (!KIND_RE.test(kind)) return NextResponse.json({ ok: false, error: 'kind must be one of csv, json, avro, parquet, orc, w3clogfile' }, { status: 400 });
  if (!table) return NextResponse.json({ ok: false, error: 'table is required (table-scoped mapping)' }, { status: 400 });
  if (!mapping) return NextResponse.json({ ok: false, error: 'mapping (JSON definition) is required' }, { status: 400 });
  try {
    const r = await createIngestionMapping(g.ctx.database, table, kind, name, mapping);
    return NextResponse.json({ ok: true, name, kind, table, rowCount: r.rowCount });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  const kind = req.nextUrl.searchParams.get('kind')?.trim();
  const table = req.nextUrl.searchParams.get('table')?.trim() || undefined;
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  if (!kind || !KIND_RE.test(kind)) return NextResponse.json({ ok: false, error: 'kind query param must be csv|json|avro|parquet|orc|w3clogfile' }, { status: 400 });
  try {
    await dropIngestionMapping(g.ctx.database, kind, name, table);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return adxError(e);
  }
}
