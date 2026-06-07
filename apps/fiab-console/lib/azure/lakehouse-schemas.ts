/**
 * Lakehouse multi-schema registry (F9) — Azure-native parity with Microsoft
 * Fabric's schema-enabled lakehouse, with NO Fabric dependency.
 *
 * A schema is a named namespace under a lakehouse. Tables live under
 * `Tables/<schema>/<table>/` in ADLS Gen2 and are queryable via the 4-part
 * name `workspace.lakehouse.schema.table`. `dbo` is the immutable default
 * schema present on every schema-enabled lakehouse — it is synthetic (never
 * persisted) and can never be renamed or deleted, mirroring Fabric.
 *
 * The registry (this module) is the source of truth — it lives in the Cosmos
 * `lakehouse-schemas` container (PK `/lakehouseId`). The real DDL
 * (`CREATE SCHEMA` / `ALTER TABLE … RENAME TO` / `DROP SCHEMA`) is orchestrated
 * by the BFF route against a Synapse Spark pool via Livy. When no Spark pool is
 * configured the registry still persists (honest gate), so the UI is never
 * empty and never errors.
 *
 * Auth: Console UAMI via cosmos-client.ts (Cosmos DB Built-in Data Contributor).
 * Per .claude/rules/no-vaporware.md — real Cosmos reads/writes, no mock arrays.
 */

import { lakehouseSchemasContainer } from './cosmos-client';

export type SchemaStatus = 'active' | 'pending' | 'error';

/** Schema name rule — letters, digits, underscores; 1-128 chars (Fabric/Spark). */
export const SCHEMA_NAME_RE = /^[A-Za-z0-9_]{1,128}$/;

/** The immutable default schema present on every schema-enabled lakehouse. */
export const DEFAULT_SCHEMA = 'dbo';

export interface LakehouseSchemaDoc {
  /** `<lakehouseId>::<name>` — re-creating the same schema upserts. */
  id: string;
  /** Partition key — the Loom lakehouse (container or item id). */
  lakehouseId: string;
  /** Tenant id for isolation in cross-lakehouse queries. */
  tenantId?: string;
  /** Validated /^[A-Za-z0-9_]{1,128}$/. */
  name: string;
  description?: string;
  /** true only for the synthetic 'dbo' row. */
  isDefault: boolean;
  status: SchemaStatus;
  /** Last engine error / honest-gate hint when status != 'active'. */
  statusDetail?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Definition the BFF passes when creating a schema (server fills derived + audit fields). */
export interface SchemaDef {
  lakehouseId: string;
  tenantId?: string;
  name: string;
  description?: string;
  status?: SchemaStatus;
  statusDetail?: string;
  createdBy: string;
}

export function schemaDocId(lakehouseId: string, name: string): string {
  return `${lakehouseId}::${name}`;
}

/** The synthetic immutable default-schema row (never stored in Cosmos). */
function defaultSchemaRow(lakehouseId: string): LakehouseSchemaDoc {
  return {
    id: schemaDocId(lakehouseId, DEFAULT_SCHEMA),
    lakehouseId,
    name: DEFAULT_SCHEMA,
    description: 'Default schema (immutable). Tables with no explicit schema live here.',
    isDefault: true,
    status: 'active',
    createdBy: 'system',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}

/**
 * List all schemas for a lakehouse (single-partition query). Always prepends
 * the synthetic immutable `dbo` row so the Fabric invariant holds even on a
 * brand-new lakehouse with no Cosmos rows yet.
 */
export async function listSchemas(lakehouseId: string): Promise<LakehouseSchemaDoc[]> {
  const c = await lakehouseSchemasContainer();
  const { resources } = await c.items
    .query<LakehouseSchemaDoc>(
      {
        query: 'SELECT * FROM c WHERE c.lakehouseId = @lh AND (NOT IS_DEFINED(c.isDefault) OR c.isDefault = false) ORDER BY c.name ASC',
        parameters: [{ name: '@lh', value: lakehouseId }],
      },
      { partitionKey: lakehouseId },
    )
    .fetchAll();
  // Defensive: drop any accidental 'dbo' row, then prepend the synthetic one.
  const nonDefault = resources.filter((r) => r.name !== DEFAULT_SCHEMA);
  return [defaultSchemaRow(lakehouseId), ...nonDefault];
}

/** Read a single schema by name within a lakehouse. Returns the synthetic dbo for 'dbo'. */
export async function getSchemaDoc(lakehouseId: string, name: string): Promise<LakehouseSchemaDoc | null> {
  if (name === DEFAULT_SCHEMA) return defaultSchemaRow(lakehouseId);
  const c = await lakehouseSchemasContainer();
  try {
    const { resource } = await c.item(schemaDocId(lakehouseId, name), lakehouseId).read<LakehouseSchemaDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Create (upsert) a schema from a definition. Refuses to persist 'dbo' (synthetic). */
export async function createSchemaDoc(def: SchemaDef): Promise<LakehouseSchemaDoc> {
  if (def.name === DEFAULT_SCHEMA) {
    throw Object.assign(new Error("'dbo' is the immutable default schema and cannot be created"), { code: 'reserved_schema' });
  }
  if (!SCHEMA_NAME_RE.test(def.name)) {
    throw Object.assign(new Error('schema name must be 1-128 chars (letters, digits, underscores)'), { code: 'bad_name' });
  }
  const id = schemaDocId(def.lakehouseId, def.name);
  const now = new Date().toISOString();
  const existing = await getSchemaDoc(def.lakehouseId, def.name);
  const doc: LakehouseSchemaDoc = {
    id,
    lakehouseId: def.lakehouseId,
    tenantId: def.tenantId,
    name: def.name,
    description: def.description,
    isDefault: false,
    status: def.status ?? 'active',
    statusDetail: def.statusDetail,
    createdBy: existing?.createdBy ?? def.createdBy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const c = await lakehouseSchemasContainer();
  const { resource } = await c.items.upsert<LakehouseSchemaDoc>(doc);
  return resource ?? doc;
}

/** Patch a schema's status/statusDetail (used after the Livy DDL settles). */
export async function updateSchemaStatus(
  lakehouseId: string,
  name: string,
  status: SchemaStatus,
  statusDetail?: string,
): Promise<LakehouseSchemaDoc | null> {
  if (name === DEFAULT_SCHEMA) return defaultSchemaRow(lakehouseId);
  const existing = await getSchemaDoc(lakehouseId, name);
  if (!existing) return null;
  const updated: LakehouseSchemaDoc = { ...existing, status, statusDetail, updatedAt: new Date().toISOString() };
  const c = await lakehouseSchemasContainer();
  const { resource } = await c.items.upsert<LakehouseSchemaDoc>(updated);
  return resource ?? updated;
}

/** Delete a schema row. Refuses to delete 'dbo'. NEVER touches underlying bytes here. */
export async function deleteSchemaDoc(lakehouseId: string, name: string): Promise<{ ok: true }> {
  if (name === DEFAULT_SCHEMA) {
    throw Object.assign(new Error("'dbo' is the immutable default schema and cannot be deleted"), { code: 'reserved_schema' });
  }
  const c = await lakehouseSchemasContainer();
  try {
    await c.item(schemaDocId(lakehouseId, name), lakehouseId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return { ok: true };
}
