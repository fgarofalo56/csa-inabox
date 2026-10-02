/**
 * The Spark metastore namespace of one lakehouse item.
 *
 * The Synapse Spark pool's metastore is shared by every lakehouse in the
 * deployment, so a schema or table name on its own does not say which item it
 * belongs to. Each lakehouse item therefore gets its own Spark databases,
 * named from a digest of the item id:
 *
 *   lh_<first 12 hex chars of sha256(itemId)>_<schema, lower-cased>
 *
 * A route that creates, drops or moves Spark objects for an item derives the
 * database name here from the authorized item id; it never takes a database
 * name from the request. Spark database names are case-insensitive, so the
 * schema part is lower-cased, and the whole name stays within the 128-char
 * metastore limit (prefix 16 chars + schema of at most 112).
 */
import { createHash } from 'node:crypto';

/** `lh_` + 12 hex + `_`. */
const PREFIX_LENGTH = 16;

/** The metastore's database-name limit. */
export const SPARK_DATABASE_MAX = 128;

/** Longest schema name that still fits the item namespace. */
export const ITEM_SCHEMA_NAME_MAX = SPARK_DATABASE_MAX - PREFIX_LENGTH;

/** Shape of every database name `sparkDatabaseFor` returns. */
export const ITEM_SPARK_DATABASE_RE = /^lh_[0-9a-f]{12}_[a-z0-9_]{1,112}$/;

/** The item's digest prefix, `lh_<12 hex>_`. */
export function itemSparkPrefix(lakehouseId: string): string {
  const digest = createHash('sha256').update(String(lakehouseId), 'utf8').digest('hex').slice(0, 12);
  return `lh_${digest}_`;
}

/**
 * The Spark database that holds `schema` for the lakehouse item `lakehouseId`.
 * Throws when the schema name cannot form a valid database name (callers
 * validate first, so a throw is a programming error, not user input).
 */
export function sparkDatabaseFor(lakehouseId: string, schema: string): string {
  if (!lakehouseId) throw new Error('sparkDatabaseFor: lakehouseId is required');
  const db = `${itemSparkPrefix(lakehouseId)}${String(schema).toLowerCase()}`;
  if (!ITEM_SPARK_DATABASE_RE.test(db)) {
    throw new Error(`sparkDatabaseFor: '${schema}' does not form a valid Spark database name`);
  }
  return db;
}
