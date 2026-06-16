/**
 * databricks-uc-mirror.ts — resolve the queryable Delta tables of a mounted
 * Unity Catalog so a `mirrored-databricks` item can pair a Synapse Serverless
 * SQL endpoint over them (audit H8).
 *
 * A MirroredAzureDatabricksCatalog "mirror" is, on the Azure-native path, a
 * mount of a UC catalog whose tables are Delta files already living in ADLS
 * Gen2. To make that catalog queryable in Loom we enumerate the catalog's
 * tables, keep the Delta ones that expose a resolvable `storage_location`
 * (the abfss:// root containing `_delta_log`), and hand them to the Synapse
 * Serverless provisioner, which builds one OPENROWSET(...FORMAT='delta') view
 * per table. This is the Azure-native "shortcut" — no Microsoft Fabric /
 * OneLake; the Synapse workspace MSI reads the same Delta files the UC governs.
 *
 * All calls hit the real Databricks Unity Catalog REST surface via
 * databricks-client. No mock data (no-vaporware.md).
 */
import {
  listUcSchemas,
  listUcTables,
  getUcTable,
  databricksConfigGate,
} from '@/lib/azure/databricks-client';

export interface UcMirrorTable {
  schema: string;
  table: string;
  /** Absolute abfss:// (or https dfs) Delta root containing `_delta_log`. */
  storageLocation: string;
  format?: string;
}

export interface UcMirrorResolution {
  ok: boolean;
  /** Honest gate code when not ok — surfaced to the editor MessageBar. */
  code?: 'NO_DATABRICKS' | 'NO_CATALOG' | 'NO_TABLES' | 'ERROR';
  error?: string;
  catalogName?: string;
  tables: UcMirrorTable[];
  /** Tables found but skipped (no resolvable Delta storage location). */
  skipped: number;
}

/** True when a UC table is a Delta table we can read by storage location. */
function isQueryableDelta(t: { table_type?: string; data_source_format?: string; storage_location?: string }): boolean {
  if (!t.storage_location) return false;
  const fmt = (t.data_source_format || '').toUpperCase();
  // Delta tables (EXTERNAL or MANAGED) are readable via OPENROWSET FORMAT=delta.
  // VIEW / MATERIALIZED_VIEW have no single storage_location to read.
  if (t.table_type === 'VIEW' || t.table_type === 'MATERIALIZED_VIEW') return false;
  return fmt === '' || fmt === 'DELTA';
}

/**
 * Resolve all queryable Delta tables in a UC catalog. Walks every schema, lists
 * its tables, and (when the list response omits `storage_location`) fetches the
 * full table to obtain it. Optionally scoped to a subset of tables.
 */
export async function resolveUcMirrorTables(
  catalogName: string,
  opts: { schemaFilter?: string; tableSubset?: Array<{ schema: string; table: string }> } = {},
): Promise<UcMirrorResolution> {
  const gate = databricksConfigGate();
  if (gate) {
    return {
      ok: false,
      code: 'NO_DATABRICKS',
      error: `Databricks workspace not configured (set ${gate.missing}).`,
      tables: [],
      skipped: 0,
    };
  }
  if (!catalogName) {
    return { ok: false, code: 'NO_CATALOG', error: 'catalogName is required', tables: [], skipped: 0 };
  }

  try {
    const schemas = await listUcSchemas(catalogName);
    const wanted = opts.tableSubset && opts.tableSubset.length
      ? new Set(opts.tableSubset.map((t) => `${t.schema}.${t.table}`.toLowerCase()))
      : null;

    const out: UcMirrorTable[] = [];
    let skipped = 0;
    for (const sch of schemas) {
      // UC ships an `information_schema` per catalog — never a data table.
      if (sch.name === 'information_schema') continue;
      if (opts.schemaFilter && sch.name !== opts.schemaFilter) continue;
      const tables = await listUcTables(catalogName, sch.name);
      for (const t of tables) {
        if (wanted && !wanted.has(`${sch.name}.${t.name}`.toLowerCase())) continue;
        let loc = t.storage_location;
        let fmt = t.data_source_format;
        let ttype = t.table_type;
        // The list endpoint sometimes omits storage_location; fetch the table.
        if (!loc && t.full_name) {
          try {
            const full = await getUcTable(t.full_name);
            loc = full.storage_location;
            fmt = full.data_source_format || fmt;
            ttype = full.table_type || ttype;
          } catch {
            /* fall through — counted as skipped below */
          }
        }
        if (isQueryableDelta({ table_type: ttype, data_source_format: fmt, storage_location: loc })) {
          out.push({ schema: sch.name, table: t.name, storageLocation: loc!, format: fmt || 'DELTA' });
        } else {
          skipped += 1;
        }
      }
    }

    if (out.length === 0) {
      return {
        ok: false,
        code: 'NO_TABLES',
        error:
          `Catalog "${catalogName}" has no queryable Delta tables with a resolvable ADLS storage location ` +
          `(${skipped} table(s) skipped).`,
        catalogName,
        tables: [],
        skipped,
      };
    }
    return { ok: true, catalogName, tables: out, skipped };
  } catch (e: any) {
    return { ok: false, code: 'ERROR', error: e?.message || String(e), catalogName, tables: [], skipped: 0 };
  }
}
