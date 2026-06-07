/**
 * delta-schema — read the column names + types of the REAL Delta tables in the
 * lakehouse medallion containers, straight from each table's Delta transaction
 * log (`_delta_log/0.json` → `metaData.schemaString`). This is the delta-rs
 * ground truth: no Spark session, no Synapse pool, and NO Fabric / OneLake
 * dependency (per no-fabric-dependency.md). Used to ground the Notebook Copilot
 * pane in the user's actual schema so suggestions reference real columns.
 *
 * Pure parsing lives in `delta-schema-parse.ts` (import-free, unit-tested);
 * this module adds the ADLS I/O. Everything soft-fails to an empty result when
 * ADLS isn't configured or the identity lacks Storage Blob Data Reader —
 * grounding is optional, the chat still works without it.
 */

import { scanLakehouseTables, type CatalogTable } from './synapse-catalog-client';
import { downloadFile } from './adls-client';
import { parseDeltaSchema, formatSchemaLine } from './delta-schema-parse';

export { deltaTypeLabel, parseDeltaSchema, formatSchemaLine, type DeltaField } from './delta-schema-parse';

/**
 * Build a compact datastore-schema context block for the Copilot prompt by
 * scanning the bronze/silver/gold lakehouse containers and reading each Delta
 * table's `_delta_log/0.json`. Soft-fails to '' so the chat still works without
 * grounding. Capped at `maxTables` to keep the prompt small.
 */
export async function buildDatastoreSchema(maxTables = 20): Promise<string> {
  let tables: CatalogTable[];
  try {
    tables = await scanLakehouseTables({ containers: ['bronze', 'silver', 'gold'] });
  } catch {
    return '';
  }
  const deltaTables = tables.filter((t) => t.format === 'delta' && t.status === 'ok').slice(0, maxTables);
  const lines: string[] = [];
  for (const t of deltaTables) {
    try {
      const { body } = await downloadFile(t.schema, `Tables/${t.name}/_delta_log/00000000000000000000.json`);
      lines.push(formatSchemaLine(t, parseDeltaSchema(body.toString('utf-8'))));
    } catch {
      /* one table's log unreadable — skip, never fail the whole context */
    }
  }
  return lines.join('\n');
}
