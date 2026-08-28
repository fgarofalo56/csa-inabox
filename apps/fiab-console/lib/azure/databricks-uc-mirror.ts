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
import { updatePermissions, resolveWorkspaceHostnames } from '@/lib/azure/unity-catalog-client';

/**
 * The privileges a mirror needs on the catalog it mounts, in the REST
 * permissions API's spelling (`USE_CATALOG`, not the SQL `USE CATALOG`). Same
 * set `/api/catalog/permissions` grants for the Reader role, minus the volume
 * read a table mirror never uses.
 */
export const UC_MIRROR_PRIVILEGES = ['USE_CATALOG', 'USE_SCHEMA', 'SELECT'] as const;

export interface UcSelfGrantOutcome {
  granted: boolean;
  /** The principal the grant was made to, when one could be resolved. */
  principal?: string;
  /** Why the platform could NOT grant. Present only when `granted` is false. */
  reason?: string;
}

/**
 * SELF-GRANT the mirror's read privileges on a Unity Catalog (#3509).
 *
 * WHY THIS EXISTS. The mirrored-databricks provisioner used to answer a
 * privilege-shaped failure with a remediation telling the operator to grant
 * `USE CATALOG` / `USE SCHEMA` / `SELECT` to the Console UAMI by hand — while
 * `unity-catalog-client` had exported `updatePermissions()` and
 * `grantPrivilegesSQL()` the whole time. auto-bind-by-default.md: a remediation
 * whose fix is an action the PLATFORM could have taken is a defect.
 *
 * WHY THE REST PATH, NOT `grantPrivilegesSQL`. The SQL form needs a running SQL
 * warehouse; a workspace can legitimately have none, and failing the mirror
 * because no warehouse is running would trade one gate for another.
 * `updatePermissions` is a control-plane PATCH with no compute dependency, and
 * it is the same call `/api/catalog/permissions` makes on its default path.
 *
 * It FAILS CLOSED and says why. If the Console UAMI is not itself entitled to
 * grant on that catalog (it is not the owner and holds no MANAGE), Databricks
 * refuses and this reports the refusal verbatim — a genuine deploy-time gap,
 * which is the one thing an honest gate is still for.
 */
export async function selfGrantUcMirrorPrivileges(catalogName: string): Promise<UcSelfGrantOutcome> {
  const principal = (process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID || '').trim();
  if (!principal) {
    return {
      granted: false,
      reason:
        'the Console identity could not be named (neither LOOM_UAMI_CLIENT_ID nor AZURE_CLIENT_ID is set), so ' +
        'there is no principal to grant to. Nothing was changed.',
    };
  }
  let host: string;
  try {
    const hosts = await resolveWorkspaceHostnames();
    if (!hosts.length) {
      return { granted: false, reason: 'no Databricks workspace hostname resolved, so the grant had nowhere to go.' };
    }
    host = hosts[0];
  } catch (e: any) {
    return { granted: false, reason: `the Databricks workspace hostname could not be resolved: ${e?.message || e}` };
  }
  try {
    await updatePermissions(host, 'CATALOG', catalogName, {
      add: [{ principal, privileges: [...UC_MIRROR_PRIVILEGES] }],
    });
    return { granted: true, principal };
  } catch (e: any) {
    return {
      granted: false,
      principal,
      reason:
        `Databricks refused the grant of ${UC_MIRROR_PRIVILEGES.join(' / ')} on CATALOG ${catalogName} to ` +
        `${principal}: ${e?.message || e}`,
    };
  }
}

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
