/**
 * BFF for Lakehouse Schemas (F9) — Azure-native multi-schema CRUD + move-table,
 * NO Fabric dependency. Standard envelope { ok, data?, error?, code?, remediation? }.
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
 * When LOOM_SYNAPSE_WORKSPACE is unset the registry still persists and the
 * route returns an honest 503 naming the env var to set — the UI surface stays
 * fully rendered (no Fabric requirement, ever).
 *
 * Item scope: every verb names the lakehouse item and authorizes it (404 when
 * the caller cannot reach it). GET needs read access; POST, DELETE and PATCH
 * change the lakehouse and need edit rights. The registry is keyed by the item
 * id.
 *
 * Spark namespace: the Spark pool's metastore is shared by every lakehouse, so
 * each item's schemas live in Spark databases named from the item id
 * (`sparkDatabaseFor`, `lh_<digest>_<schema>`). The route derives every
 * database name it creates, drops or moves between from the AUTHORIZED item id;
 * a registry row only says which of this item's schemas exist. Consequences:
 *
 * - DELETE drops the Spark database only for a row recorded with this item's
 *   database name. A row saved before item namespaces (no `sparkDatabase`) is
 *   removed from the registry and its Spark schema is kept (`sparkSchemaKept`).
 * - PATCH moves tables only between two of this item's namespaced schemas.
 *   `dbo` is refused as a source or target, and so is a row without an item
 *   namespace.
 *
 * Rows saved under the earlier container-name key are read as a fallback when
 * exactly one lakehouse item is bound to that container
 * (`legacyContainerKeyFor`); GET lists them with `legacy: true`.
 *
 * Every refusal carries `code` and `remediation` alongside `error`.
 *
 * Runtime: nodejs, force-dynamic.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listSchemas,
  createSchemaDoc,
  getSchemaDoc,
  updateSchemaStatus,
  deleteSchemaDoc,
  SCHEMA_NAME_RE,
  DEFAULT_SCHEMA,
  type LakehouseSchemaDoc,
} from '@/lib/azure/lakehouse-schemas';
import { runSparkSqlAndWait } from '@/lib/azure/synapse-dev-client';
import { withSession } from '@/lib/api/route-toolkit';
import { quoteIdent } from '@/lib/sql/quoting';
import { authorizeItem } from '../_lib/refusal-envelope';
import { legacyContainerKeyFor } from '../_lib/legacy-container-key';
import { ITEM_SCHEMA_NAME_MAX, sparkDatabaseFor } from '../_lib/spark-namespace';

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

const READ_ONLY_MESSAGE =
  'Your role on this lakehouse is read-only, so Loom did not change its schemas. A workspace '
  + 'Member/Admin, or an item grant that includes Edit, can make this change.';

const NAME_RULE = `1-${ITEM_SCHEMA_NAME_MAX} characters: letters, digits and underscores only`;

/** Spark SQL identifier: backtick-quoted, embedded backticks doubled. */
function sparkIdent(name: string): string {
  return quoteIdent(name, 'databricks-sql');
}

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function refuse(status: number, code: string, error: string, remediation: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, code, error, remediation, ...extra }, { status });
}

const sparkError = (e: unknown) =>
  refuse(502, 'spark_error', sanitize(e), 'Check that the Spark pool is running and reachable, then retry.');

const registryError = (e: any) =>
  refuse(502, typeof e?.code === 'string' ? e.code : 'registry_error', sanitize(e), 'Retry in a moment.');

function validName(name: string): boolean {
  return SCHEMA_NAME_RE.test(name) && name.length <= ITEM_SCHEMA_NAME_MAX;
}

function isDefaultName(name: string): boolean {
  return name.toLowerCase() === DEFAULT_SCHEMA;
}

/** A row carries this item's Spark namespace for `name`. */
function namespaced(lakehouseId: string, doc: LakehouseSchemaDoc | null): boolean {
  return !!doc && !doc.isDefault && doc.sparkDatabase === sparkDatabaseFor(lakehouseId, doc.name);
}

export const GET = withSession(async (req: NextRequest, { session }) => {

  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId')?.trim();
  if (!lakehouseId) {
    return refuse(400, 'bad_request', 'lakehouseId is required', 'Open the lakehouse from its workspace and retry.');
  }

  try {
    const access = await authorizeItem(session, lakehouseId);
    if (access instanceof NextResponse) return access;
    const own = await listSchemas(lakehouseId);
    const seen = new Set(own.map((s) => s.name.toLowerCase()));
    const schemas: Array<LakehouseSchemaDoc & { legacy?: boolean }> = own.map((s) =>
      s.isDefault ? { ...s, sparkDatabase: sparkDatabaseFor(lakehouseId, DEFAULT_SCHEMA) } : s,
    );
    const legacyKey = await legacyContainerKeyFor(lakehouseId, access.item.workspaceId);
    if (legacyKey) {
      for (const s of await listSchemas(legacyKey)) {
        if (s.isDefault || seen.has(s.name.toLowerCase())) continue;
        seen.add(s.name.toLowerCase());
        schemas.push({ ...s, legacy: true });
      }
    }
    return NextResponse.json({ ok: true, schemas });
  } catch (e: any) {
    return registryError(e);
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const name = (body?.name || '').toString().trim();
  const description = typeof body?.description === 'string' ? body.description : undefined;

  if (!lakehouseId) {
    return refuse(400, 'bad_request', 'lakehouseId is required', 'Open the lakehouse from its workspace and retry.');
  }
  if (!name) return refuse(400, 'bad_name', 'name is required', `Enter a schema name of ${NAME_RULE}.`);
  if (isDefaultName(name)) {
    return refuse(
      400,
      'reserved_schema',
      `'${DEFAULT_SCHEMA}' is the immutable default schema and cannot be created.`,
      `Pick a different name; '${DEFAULT_SCHEMA}' already exists on every lakehouse.`,
    );
  }
  if (!validName(name)) {
    return refuse(400, 'bad_name', `name must be ${NAME_RULE}.`, `Enter a schema name of ${NAME_RULE}.`);
  }

  const access = await authorizeItem(session, lakehouseId, { write: true, readOnlyMessage: READ_ONLY_MESSAGE });
  if (access instanceof NextResponse) return access;

  const createdBy = session.claims.upn;
  const tenantId = (session.claims as any).tid || (session.claims as any).tenantId;
  const sparkDatabase = sparkDatabaseFor(lakehouseId, name);

  // 1) Register the catalog row first (so the UI always has the schema), then
  //    run the real DDL. Status starts 'pending' until the Spark DDL settles.
  //    Spark database names are case-insensitive, so two schemas that differ
  //    only in case would share one database: refuse the second.
  let row;
  try {
    const clash = (await listSchemas(lakehouseId)).find(
      (s) => !s.isDefault && s.name !== name && s.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) {
      return refuse(
        409,
        'schema_exists',
        `This lakehouse already has a schema named '${clash.name}', which differs from '${name}' only in letter case.`,
        `Use the existing schema '${clash.name}', or pick a name that differs by more than letter case.`,
      );
    }
    row = await createSchemaDoc({ lakehouseId, tenantId, name, description, status: 'pending', sparkDatabase, createdBy });
  } catch (e: any) {
    if (e?.code === 'bad_name' || e?.code === 'reserved_schema') {
      return refuse(400, e.code, sanitize(e), `Enter a schema name of ${NAME_RULE}, other than '${DEFAULT_SCHEMA}'.`);
    }
    return registryError(e);
  }

  // 2) Honest gate when no Spark backend is wired — keep the row pending.
  if (!sparkConfigured()) {
    const pending = await updateSchemaStatus(lakehouseId, name, 'pending', SPARK_GATE_HINT);
    return refuse(503, 'spark_not_configured', SPARK_GATE_HINT, SPARK_GATE_HINT, {
      hint: SPARK_GATE_HINT,
      data: pending ?? row,
    });
  }

  // 3) Run CREATE SCHEMA IF NOT EXISTS `<item database>` on the Spark pool via
  //    Livy — in the BACKGROUND. A COLD Livy/Spark session cold-start takes
  //    minutes, which blew past the Front Door ~30-240s window → HTTP 504 (with
  //    a raw HTML body) on a freshly-idle pool. The catalog row is already
  //    registered (step 1) so the schema is usable in the catalog immediately;
  //    the Spark metastore database materializes async and the row flips to
  //    'active' (or 'error') when the DDL settles. CREATE SCHEMA IF NOT EXISTS
  //    is idempotent, so a retry is safe. (Same floating-promise pattern as
  //    /api/apps/[id]/install.)
  void (async () => {
    try {
      await runSparkSqlAndWait(sparkPool(), `CREATE SCHEMA IF NOT EXISTS ${sparkIdent(sparkDatabase)}`);
      await updateSchemaStatus(lakehouseId, name, 'active');
    } catch (e: any) {
      await updateSchemaStatus(lakehouseId, name, 'error', sanitize(e));
    }
  })();
  return NextResponse.json({
    ok: true,
    data: row,
    sparkDatabase,
    materializing: true,
    note:
      'Schema registered in the catalog. Its Spark database is being created in the background ' +
      `(CREATE SCHEMA ${sparkDatabase} on the Spark pool via Livy) — it can take a minute or two while the Spark ` +
      `session warms up, then the schema shows as active. In a notebook, address its tables as ${sparkDatabase}.<table>.`,
  });
});

export const DELETE = withSession(async (req: NextRequest, { session }) => {

  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId')?.trim();
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!lakehouseId || !name) {
    return refuse(400, 'bad_request', 'lakehouseId and name are required', 'Pick the schema to delete from the lakehouse editor.');
  }
  if (isDefaultName(name)) {
    return refuse(
      400,
      'reserved_schema',
      `'${DEFAULT_SCHEMA}' is the immutable default schema and cannot be deleted.`,
      `Delete the tables in '${DEFAULT_SCHEMA}' individually instead.`,
    );
  }
  if (!SCHEMA_NAME_RE.test(name)) {
    return refuse(400, 'bad_name', 'invalid schema name', 'Pick the schema to delete from the lakehouse editor.');
  }

  try {
    const access = await authorizeItem(session, lakehouseId, { write: true, readOnlyMessage: READ_ONLY_MESSAGE });
    if (access instanceof NextResponse) return access;

    let key = lakehouseId;
    let existing = await getSchemaDoc(lakehouseId, name);
    if (!existing) {
      const legacyKey = await legacyContainerKeyFor(lakehouseId, access.item.workspaceId);
      if (legacyKey) {
        existing = await getSchemaDoc(legacyKey, name);
        if (existing) key = legacyKey;
      }
    }
    if (!existing) {
      return refuse(
        404,
        'unknown_schema',
        `Schema '${name}' is not registered on this lakehouse.`,
        'Refresh the schema list; it may already have been deleted.',
      );
    }

    // The database to drop is derived from the authorized item id. A row that
    // does not record that same name (a row from before item namespaces) never
    // leads to a DROP: its Spark schema is kept and only the row is removed.
    const ownDatabase = key === lakehouseId && namespaced(lakehouseId, existing) ? sparkDatabaseFor(lakehouseId, name) : null;
    let sparkSchemaKept = !ownDatabase;
    if (ownDatabase && sparkConfigured()) {
      try {
        await runSparkSqlAndWait(sparkPool(), `DROP SCHEMA IF EXISTS ${sparkIdent(ownDatabase)} CASCADE`);
      } catch {
        // Best-effort: a missing or already-dropped database must not block the
        // registry-row delete. Report the database as kept so the UI says so.
        sparkSchemaKept = true;
      }
    }
    await deleteSchemaDoc(key, name);
    return NextResponse.json({
      ok: true,
      data: { name, sparkSchemaKept, ...(ownDatabase ? { sparkDatabase: ownDatabase } : {}) },
      ...(sparkSchemaKept
        ? {
            note: ownDatabase
              ? `Removed the schema from this lakehouse. Loom could not drop its Spark database ${ownDatabase}; `
                + 'drop it from a notebook if it still exists.'
              : 'Removed the schema from this lakehouse. It was registered before lakehouse schemas had their own '
                + 'Spark databases, so Loom did not drop any Spark schema for it.',
          }
        : {}),
    });
  } catch (e: any) {
    if (e?.code === 'reserved_schema') {
      return refuse(400, 'reserved_schema', sanitize(e), `Delete the tables in '${DEFAULT_SCHEMA}' individually instead.`);
    }
    return registryError(e);
  }
});

export const PATCH = withSession(async (req: NextRequest, { session }) => {

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const tableName = (body?.tableName || '').toString().trim();
  const fromSchema = (body?.fromSchema || '').toString().trim() || DEFAULT_SCHEMA;
  const toSchema = (body?.toSchema || '').toString().trim();

  if (!lakehouseId) {
    return refuse(400, 'bad_request', 'lakehouseId is required', 'Open the lakehouse from its workspace and retry.');
  }
  if (!tableName) return refuse(400, 'bad_request', 'tableName is required', 'Pick the table to move.');
  if (!toSchema) return refuse(400, 'bad_request', 'toSchema is required', 'Pick the schema to move the table to.');
  for (const [label, v] of [['tableName', tableName], ['fromSchema', fromSchema], ['toSchema', toSchema]] as const) {
    if (!SCHEMA_NAME_RE.test(v)) {
      return refuse(
        400,
        'bad_name',
        `${label} must be 1-128 chars: letters, digits, and underscores only.`,
        'Pick the table and schemas from the lakehouse editor.',
      );
    }
  }
  if (fromSchema.toLowerCase() === toSchema.toLowerCase()) {
    return refuse(400, 'bad_request', 'fromSchema and toSchema are the same — nothing to move.', 'Pick a different target schema.');
  }
  if (isDefaultName(fromSchema) || isDefaultName(toSchema)) {
    return refuse(
      400,
      'reserved_schema',
      `Tables cannot be moved into or out of the default schema '${DEFAULT_SCHEMA}'.`,
      'Move tables between schemas you created on this lakehouse, or load the data into the target schema directly.',
    );
  }

  const access = await authorizeItem(session, lakehouseId, { write: true, readOnlyMessage: READ_ONLY_MESSAGE });
  if (access instanceof NextResponse) return access;

  // Honest gate when no Spark backend is wired.
  if (!sparkConfigured()) {
    return refuse(503, 'spark_not_configured', SPARK_GATE_HINT, SPARK_GATE_HINT, { hint: SPARK_GATE_HINT });
  }

  try {
    // Both schemas must be this item's namespaced schemas. Only their names
    // come from the registry; the database names are derived from the item id.
    for (const schema of [fromSchema, toSchema]) {
      const doc = await getSchemaDoc(lakehouseId, schema);
      if (namespaced(lakehouseId, doc)) continue;
      if (doc) {
        return refuse(
          409,
          'legacy_schema',
          `Schema '${schema}' was registered before lakehouse schemas had their own Spark databases, so Loom does not move tables for it.`,
          `Create a new schema, load or copy the table into it, then delete '${schema}'.`,
        );
      }
      const legacyKey = await legacyContainerKeyFor(lakehouseId, access.item.workspaceId);
      if (legacyKey && (await getSchemaDoc(legacyKey, schema))) {
        return refuse(
          409,
          'legacy_schema',
          `Schema '${schema}' was registered before lakehouse schemas had their own Spark databases, so Loom does not move tables for it.`,
          `Create a new schema, load or copy the table into it, then delete '${schema}'.`,
        );
      }
      return refuse(
        404,
        'unknown_schema',
        `Schema '${schema}' is not registered on this lakehouse.`,
        'Create the schema first, then move the table.',
      );
    }
    const fromDb = sparkDatabaseFor(lakehouseId, fromSchema);
    const toDb = sparkDatabaseFor(lakehouseId, toSchema);
    // ALTER TABLE `<from db>`.`<table>` RENAME TO `<to db>`.`<table>` — Spark 3.x move.
    const sql = `ALTER TABLE ${sparkIdent(fromDb)}.${sparkIdent(tableName)} RENAME TO ${sparkIdent(toDb)}.${sparkIdent(tableName)}`;
    await runSparkSqlAndWait(sparkPool(), sql);
    return NextResponse.json({
      ok: true,
      data: { tableName, fromSchema, toSchema, sparkTable: `${toDb}.${tableName}` },
    });
  } catch (e: any) {
    return sparkError(e);
  }
});
