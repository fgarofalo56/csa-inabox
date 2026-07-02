/**
 * Unity Catalog CONNECTIONS + FOREIGN CATALOGS (Lakehouse Federation) — wave c2.
 *
 *   GET    /api/databricks/unity-catalog/connections      → { ok, connections[] }
 *   POST   /api/databricks/unity-catalog/connections      → create
 *            { action:'create-connection', name, type, options[], comment?, ifNotExists?, warehouseId? }
 *            { action:'create-foreign-catalog', name, connection, database, comment?, ifNotExists?, warehouseId? }
 *   DELETE /api/databricks/unity-catalog/connections?name=  → drop connection
 *
 * Real Databricks Unity Catalog:
 *   - list/delete via REST GET/DELETE /api/2.1/unity-catalog/connections[/{name}]
 *   - CREATE CONNECTION / CREATE FOREIGN CATALOG via SQL DDL on the SQL warehouse
 *     so credential options can use secret('scope','key') instead of plaintext.
 *   Learn: https://learn.microsoft.com/azure/databricks/sql/language-manual/sql-ref-syntax-ddl-create-connection
 *          https://learn.microsoft.com/azure/databricks/query-federation/database-federation
 *
 * SECRETS: a connection password may be supplied either as a Databricks secret
 * reference ({ kind:'secret', scope, key }) — the recommended path — or as a
 * literal ({ kind:'string', value }). The create receipt NEVER echoes the SQL
 * for a connection (it can contain a password literal); only executionMs is
 * returned, and the request body is never logged. Honest gate when Databricks is
 * unconfigured or at the GCC-High / DoD boundary.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost, listConnections, deleteConnection,
  createUcConnection, createUcForeignCatalog,
} from '@/lib/azure/unity-catalog-client';
import {
  UcBuildError,
  type UcConnectionType, type UcConnectionOption, type UcConnectionOptionValue,
} from '@/lib/sql/uc-security-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONNECTION_TYPES = new Set<UcConnectionType>([
  'SQLSERVER', 'SQLDW', 'POSTGRESQL', 'MYSQL', 'SNOWFLAKE', 'REDSHIFT',
]);

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
        `Lakehouse Federation connections are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account (Microsoft Entra-connected Unity Catalog metastore).`,
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

/** Coerce a loosely-typed option-value from the request into the strict union;
 *  buildCreateConnection re-validates and rejects bad keys/values. */
function toOptionValue(v: any): UcConnectionOptionValue {
  const kind = String(v?.kind || 'string');
  if (kind === 'secret') return { kind: 'secret', scope: String(v?.scope ?? ''), key: String(v?.key ?? '') };
  if (kind === 'int') return { kind: 'int', value: String(v?.value ?? '') };
  return { kind: 'string', value: String(v?.value ?? '') };
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });
  try {
    const host = await primaryWorkspaceHost();
    const connections = await listConnections(host);
    return NextResponse.json({ ok: true, connections });
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

  const action = String(body?.action || 'create-connection');

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(body?.warehouseId ? String(body.warehouseId).trim() : undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    if (action === 'create-foreign-catalog') {
      const name = String(body?.name || '').trim();
      const connection = String(body?.connection || '').trim();
      const database = String(body?.database || '').trim();
      if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
      if (!connection) return NextResponse.json({ ok: false, error: 'connection is required' }, { status: 400 });
      if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });
      const r = await createUcForeignCatalog(warehouseId, {
        name, connection, database,
        comment: body?.comment ? String(body.comment) : undefined,
        ifNotExists: body?.ifNotExists === true,
      });
      return NextResponse.json({ ok: true, sql: r.sql, executionMs: r.executionMs, executedBy: session.claims.upn });
    }

    // default: create-connection
    const name = String(body?.name || '').trim();
    const type = String(body?.type || '').toUpperCase().trim() as UcConnectionType;
    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    if (!CONNECTION_TYPES.has(type)) {
      return NextResponse.json({ ok: false, error: `type must be one of ${[...CONNECTION_TYPES].join(', ')}` }, { status: 400 });
    }
    const rawOptions: any[] = Array.isArray(body?.options) ? body.options : [];
    const options: UcConnectionOption[] = rawOptions
      .filter((o) => o && String(o?.key ?? '').trim())
      .map((o) => ({ key: String(o.key).trim(), value: toOptionValue(o.value) }));
    if (!options.length) {
      return NextResponse.json({ ok: false, error: 'at least one connection option is required (host, user, …)' }, { status: 400 });
    }
    // createUcConnection returns ONLY executionMs — the SQL may contain a literal
    // password and is never returned to the client (per the wave-c2 secret rule).
    const r = await createUcConnection(warehouseId, {
      name, type, options,
      comment: body?.comment ? String(body.comment) : undefined,
      ifNotExists: body?.ifNotExists === true,
    });
    return NextResponse.json({ ok: true, executionMs: r.executionMs, executedBy: session.claims.upn });
  } catch (e: any) {
    const status = e instanceof UcBuildError ? 400 : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const host = await primaryWorkspaceHost();
    await deleteConnection(host, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
