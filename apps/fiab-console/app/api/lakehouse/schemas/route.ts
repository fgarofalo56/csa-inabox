/**
 * BFF for Lakehouse Schemas (F9) — Azure-native multi-schema CRUD + move-table,
 * NO Fabric dependency. Standard envelope { ok, data?, error?, code?, hint? }.
 *
 *   GET    /api/lakehouse/schemas?lakehouseId=<id>
 *            → list schemas (always includes the immutable 'dbo' default).
 *   POST   /api/lakehouse/schemas   { lakehouseId, name, description? }
 *            → register a schema row, then run `CREATE SCHEMA` on the Synapse
 *              Spark pool via Livy. Honest-gate (503) when no Spark pool.
 *   DELETE /api/lakehouse/schemas?lakehouseId=<id>&name=<schema>
 *            → run `DROP SCHEMA … CASCADE` then drop the registry row.
 *              'dbo' is refused (400).
 *   PATCH  /api/lakehouse/schemas   { lakehouseId, tableName, fromSchema, toSchema }
 *            → `ALTER TABLE <from>.<table> RENAME TO <to>.<table>` (move table).
 *
 * The Spark DDL is the real backend; the schema name format
 * `workspace.lakehouse.schema.table` is Spark 3.x standard SQL (Fabric uses the
 * same engine). When LOOM_SYNAPSE_WORKSPACE is unset the registry still
 * persists and the route returns an honest 503 naming the env var to set — the
 * UI surface stays fully rendered (no Fabric requirement, ever).
 *
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listSchemas,
  createSchemaDoc,
  getSchemaDoc,
  updateSchemaStatus,
  deleteSchemaDoc,
  SCHEMA_NAME_RE,
  DEFAULT_SCHEMA,
} from '@/lib/azure/lakehouse-schemas';
import { runSparkSqlAndWait } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Resolve the Spark pool used for schema DDL (matches synapse.bicep default). */
function sparkPool(): string {
  return process.env.LOOM_DEFAULT_SPARK_POOL || 'loompool';
}

/** True when a Synapse Spark backend is wired for real DDL execution. */
function sparkConfigured(): boolean {
  return !!process.env.LOOM_SYNAPSE_WORKSPACE;
}

const SPARK_GATE_HINT =
  'Schema DDL runs on a Synapse Spark pool via Livy. Set LOOM_SYNAPSE_WORKSPACE ' +
  '(and LOOM_DEFAULT_SPARK_POOL if your pool is not named "loompool") on the ' +
  'Console Container App, and grant the Console UAMI Synapse Administrator on ' +
  'the workspace. The schema is registered in the catalog meanwhile.';

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId')?.trim();
  if (!lakehouseId) return NextResponse.json({ ok: false, error: 'lakehouseId is required' }, { status: 400 });

  try {
    const schemas = await listSchemas(lakehouseId);
    return NextResponse.json({ ok: true, schemas });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: sanitize(e), code: e?.code }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const name = (body?.name || '').toString().trim();
  const description = typeof body?.description === 'string' ? body.description : undefined;

  if (!lakehouseId) return NextResponse.json({ ok: false, error: 'lakehouseId is required' }, { status: 400 });
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (name === DEFAULT_SCHEMA) {
    return NextResponse.json({ ok: false, code: 'reserved_schema', error: `'${DEFAULT_SCHEMA}' is the immutable default schema and cannot be created.` }, { status: 400 });
  }
  if (!SCHEMA_NAME_RE.test(name)) {
    return NextResponse.json({ ok: false, code: 'bad_name', error: 'name must be 1-128 chars: letters, digits, and underscores only.' }, { status: 400 });
  }

  const createdBy = session.claims.upn;
  const tenantId = (session.claims as any).tid || (session.claims as any).tenantId;

  // 1) Register the catalog row first (so the UI always has the schema), then
  //    run the real DDL. Status starts 'pending' until the Spark DDL settles.
  let row;
  try {
    row = await createSchemaDoc({ lakehouseId, tenantId, name, description, status: 'pending', createdBy });
  } catch (e: any) {
    const code = e?.code === 'bad_name' || e?.code === 'reserved_schema' ? e.code : undefined;
    const status = code ? 400 : 502;
    return NextResponse.json({ ok: false, code, error: sanitize(e) }, { status });
  }

  // 2) Honest gate when no Spark backend is wired — keep the row pending.
  if (!sparkConfigured()) {
    const pending = await updateSchemaStatus(lakehouseId, name, 'pending', SPARK_GATE_HINT);
    return NextResponse.json({ ok: false, code: 'spark_not_configured', error: SPARK_GATE_HINT, hint: SPARK_GATE_HINT, data: pending ?? row }, { status: 503 });
  }

  // 3) Run CREATE SCHEMA IF NOT EXISTS `<name>` on the Spark pool via Livy.
  try {
    await runSparkSqlAndWait(sparkPool(), `CREATE SCHEMA IF NOT EXISTS \`${name}\``);
    const active = await updateSchemaStatus(lakehouseId, name, 'active');
    return NextResponse.json({ ok: true, data: active ?? row });
  } catch (e: any) {
    const msg = sanitize(e);
    const errRow = await updateSchemaStatus(lakehouseId, name, 'error', msg);
    return NextResponse.json({ ok: false, code: 'spark_error', error: msg, data: errRow ?? row }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId')?.trim();
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!lakehouseId || !name) {
    return NextResponse.json({ ok: false, error: 'lakehouseId and name are required' }, { status: 400 });
  }
  if (name === DEFAULT_SCHEMA) {
    return NextResponse.json({ ok: false, code: 'reserved_schema', error: `'${DEFAULT_SCHEMA}' is the immutable default schema and cannot be deleted.` }, { status: 400 });
  }
  if (!SCHEMA_NAME_RE.test(name)) {
    return NextResponse.json({ ok: false, code: 'bad_name', error: 'invalid schema name' }, { status: 400 });
  }

  try {
    const existing = await getSchemaDoc(lakehouseId, name);
    // Drop the Spark schema (CASCADE) when a Spark backend is wired. Best-effort:
    // a missing/already-dropped schema must not block the registry-row delete.
    if (existing && sparkConfigured()) {
      try {
        await runSparkSqlAndWait(sparkPool(), `DROP SCHEMA IF EXISTS \`${name}\` CASCADE`);
      } catch {
        /* best-effort — surface nothing; the row delete proceeds */
      }
    }
    await deleteSchemaDoc(lakehouseId, name);
    return NextResponse.json({ ok: true, data: { name } });
  } catch (e: any) {
    const code = e?.code === 'reserved_schema' ? e.code : e?.code;
    const status = e?.code === 'reserved_schema' ? 400 : 502;
    return NextResponse.json({ ok: false, code, error: sanitize(e) }, { status });
  }
}

export async function PATCH(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const tableName = (body?.tableName || '').toString().trim();
  const fromSchema = (body?.fromSchema || '').toString().trim() || DEFAULT_SCHEMA;
  const toSchema = (body?.toSchema || '').toString().trim();

  if (!lakehouseId) return NextResponse.json({ ok: false, error: 'lakehouseId is required' }, { status: 400 });
  if (!tableName) return NextResponse.json({ ok: false, error: 'tableName is required' }, { status: 400 });
  if (!toSchema) return NextResponse.json({ ok: false, error: 'toSchema is required' }, { status: 400 });
  for (const [label, v] of [['tableName', tableName], ['fromSchema', fromSchema], ['toSchema', toSchema]] as const) {
    if (!SCHEMA_NAME_RE.test(v)) {
      return NextResponse.json({ ok: false, code: 'bad_name', error: `${label} must be 1-128 chars: letters, digits, and underscores only.` }, { status: 400 });
    }
  }
  if (fromSchema === toSchema) {
    return NextResponse.json({ ok: false, error: 'fromSchema and toSchema are the same — nothing to move.' }, { status: 400 });
  }

  // Honest gate when no Spark backend is wired.
  if (!sparkConfigured()) {
    return NextResponse.json({ ok: false, code: 'spark_not_configured', error: SPARK_GATE_HINT, hint: SPARK_GATE_HINT }, { status: 503 });
  }

  // ALTER TABLE `<from>`.`<table>` RENAME TO `<to>`.`<table>` — Spark 3.x move.
  const sql = `ALTER TABLE \`${fromSchema}\`.\`${tableName}\` RENAME TO \`${toSchema}\`.\`${tableName}\``;
  try {
    await runSparkSqlAndWait(sparkPool(), sql);
    return NextResponse.json({
      ok: true,
      data: { tableName, fromSchema, toSchema, namespace: `${lakehouseId}.${toSchema}.${tableName}` },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, code: 'spark_error', error: sanitize(e) }, { status: 502 });
  }
}
