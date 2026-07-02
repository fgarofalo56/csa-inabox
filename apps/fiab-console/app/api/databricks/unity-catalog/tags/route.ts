/**
 * Unity Catalog TAGS — plain object/column tag assignments.
 *
 *   GET  /api/databricks/unity-catalog/tags?catalog=&schema=&table=[&warehouseId=]
 *          → { ok, tableTags[], columnTags[] }   (read information_schema)
 *   POST /api/databricks/unity-catalog/tags
 *          body { action:'set'|'unset', catalog, schema?, name, column?, kind?,
 *                 tags?:[{key,value}], keys?:[], warehouseId? }
 *          → { ok, sql, executionMs }
 *
 * Real Databricks SQL DDL (Learn-grounded), executed over the SQL Statement
 * Execution API — no mocks:
 *   ALTER {CATALOG|SCHEMA|TABLE|VIEW|VOLUME} … SET/UNSET TAGS (…)
 *   ALTER TABLE … ALTER COLUMN c SET/UNSET TAGS (…)
 *   read: information_schema.{table_tags,column_tags}
 *   https://learn.microsoft.com/azure/databricks/database-objects/tags
 *
 * Console UAMI needs `APPLY TAG` (+ `USE SCHEMA`/`USE CATALOG`) on the object —
 * UC 403s are surfaced verbatim. Unity Catalog is a Commercial/GCC capability;
 * at the GCC-High / DoD boundary the route returns an honest gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { readUcObjectTags, applyUcTags, type UcTagPair } from '@/lib/azure/unity-catalog-client';
import { UcBuildError } from '@/lib/sql/uc-security-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate { gated: true; error: string }

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Unity Catalog tag governance is not available at the ${cloudBoundaryLabel()} boundary. ` +
        `UC tags require a Commercial or GCC Databricks workspace (Microsoft Entra-connected metastore).`,
    };
  }
  return null;
}

async function resolveWarehouseId(requested?: string): Promise<string> {
  if (requested) return requested;
  const warehouses = await listWarehouses();
  const running = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
  if (!running) throw new Error('No SQL warehouse found. Create or start a SQL warehouse in the Databricks workspace.');
  return running.id;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const catalog = req.nextUrl.searchParams.get('catalog')?.trim();
  const schema = req.nextUrl.searchParams.get('schema')?.trim() || undefined;
  const table = req.nextUrl.searchParams.get('table')?.trim() || undefined;
  if (!catalog) return NextResponse.json({ ok: false, error: 'catalog is required' }, { status: 400 });

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(req.nextUrl.searchParams.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    const { tableTags, columnTags } = await readUcObjectTags(warehouseId, catalog, { schema, table });
    return NextResponse.json({ ok: true, catalog, schema: schema || null, table: table || null, tableTags, columnTags });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const action = body?.action === 'unset' ? 'unset' : 'set';
  const catalog = String(body?.catalog || '').trim();
  const schema = body?.schema ? String(body.schema).trim() : undefined;
  const name = String(body?.name || '').trim();
  const column = body?.column ? String(body.column).trim() : undefined;
  const kind = body?.kind ? String(body.kind).toUpperCase().trim() : undefined;
  if (!catalog || !name) return NextResponse.json({ ok: false, error: 'catalog and name are required' }, { status: 400 });

  const tags: UcTagPair[] = Array.isArray(body?.tags)
    ? body.tags.map((t: any) => ({ key: String(t?.key || '').trim(), value: String(t?.value ?? '') })).filter((t: UcTagPair) => t.key)
    : [];
  const keys: string[] = Array.isArray(body?.keys) ? body.keys.map((k: any) => String(k || '').trim()).filter(Boolean) : [];

  if (action === 'set' && tags.length === 0) return NextResponse.json({ ok: false, error: 'tags[] (key+value) is required to set tags' }, { status: 400 });
  if (action === 'unset' && keys.length === 0) return NextResponse.json({ ok: false, error: 'keys[] is required to unset tags' }, { status: 400 });

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(body?.warehouseId ? String(body.warehouseId).trim() : undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    const r = await applyUcTags(warehouseId, {
      action, catalog, schema, name, column,
      kind: (kind as any) || undefined,
      tags, keys,
    });
    return NextResponse.json({ ok: true, sql: r.sql, executionMs: r.executionMs, executedBy: session.claims.upn });
  } catch (e: any) {
    const status = e instanceof UcBuildError ? 400 : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}
