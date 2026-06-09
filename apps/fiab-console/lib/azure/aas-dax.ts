/**
 * aas-dax — pure, credential-free helpers for the Loom-native report renderer.
 *
 * Split out from aas-client.ts so the deterministic DAX-synthesis / row-shaping
 * / binding-resolution logic can be imported and unit-tested WITHOUT pulling in
 * @azure/identity (which the credentialed executeAasQuery needs). No network,
 * no Azure SDK — only cloud-endpoints (suffix/parse) helpers.
 */

import { parseAasServer } from './cloud-endpoints';

/** Parsed row shape returned by the AAS query endpoint. */
export type AasRow = Record<string, unknown>;

/** Single result table from the AAS executeQueries response. */
export interface AasTable {
  rows: AasRow[];
}

/** Full executeQueries response envelope. */
export interface AasQueryResult {
  results: Array<{ tables: AasTable[] }>;
}

/**
 * Resolve the AAS binding for a report item. Prefers the per-item state
 * (`state.aasServer` / `state.aasDatabase`); falls back to the platform-level
 * `LOOM_AAS_SERVER` / `LOOM_AAS_DATABASE` env vars. Returns null when neither
 * a server nor a database can be resolved, or the server string can't be
 * parsed into region + serverName.
 */
export function resolveAasBinding(
  stateServer?: string,
  stateDatabase?: string,
): { region: string; serverName: string; database: string } | null {
  const server = (stateServer || process.env.LOOM_AAS_SERVER || '').trim();
  const database = (stateDatabase || process.env.LOOM_AAS_DATABASE || '').trim();
  if (!server || !database) return null;
  const parsed = parseAasServer(server);
  if (!parsed) return null;
  return { ...parsed, database };
}

/**
 * Synthesize a safe DAX EVALUATE expression from a visual's `field` definition.
 * Every branch returns a real, executable DAX string (no vaporware):
 *   - already an EVALUATE expression          → pass through
 *   - measure/column ([..]) + card type       → EVALUATE ROW("Value", <field>)
 *   - measure/column ([..]) + other type      → EVALUATE TOPN(100, ROW("Value", <field>))
 *   - bare table name (no brackets / parens)  → EVALUATE TOPN(100, <table>)
 *   - empty field                             → null (caller skips the visual)
 */
export function buildDaxFromVisual(visual: { type: string; field?: string }): string | null {
  const field = (visual.field || '').trim();
  if (!field) return null;
  if (/^EVALUATE\b/i.test(field)) return field;
  // Measure or column reference: contains [ but not a function-call paren.
  if (field.includes('[') && !field.includes('(')) {
    if (visual.type === 'card') return `EVALUATE ROW("Value", ${field})`;
    return `EVALUATE TOPN(100, ROW("Value", ${field}))`;
  }
  // Plain table name — TOPN guard avoids full-table dumps.
  return `EVALUATE TOPN(100, ${field})`;
}

/**
 * Flatten the AAS query response into a simple rows array, stripping the AAS
 * column-name prefix ("[Table].[Column]" / "[Column]" → "Column") for the UI.
 */
export function flattenAasRows(result: AasQueryResult): AasRow[] {
  const tables = result?.results?.[0]?.tables;
  if (!tables?.length) return [];
  return (tables[0].rows || []).map((row) => {
    const flat: AasRow = {};
    for (const [k, v] of Object.entries(row)) {
      const bare = k
        .replace(/^\[[^\]]+\]\.\[([^\]]+)\]$/, '$1')
        .replace(/^\[([^\]]+)\]$/, '$1');
      flat[bare] = v;
    }
    return flat;
  });
}
