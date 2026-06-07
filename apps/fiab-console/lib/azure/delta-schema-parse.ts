/**
 * delta-schema-parse — PURE Delta `_delta_log` schema parsing helpers, with no
 * Azure-SDK imports so they are unit-testable in isolation. The I/O wrapper
 * (`buildDatastoreSchema`, which scans ADLS) lives in `delta-schema.ts` and
 * re-exports these.
 */

import type { CatalogTable } from './synapse-catalog-client';

export interface DeltaField {
  name: string;
  type: string;
}

/**
 * Coerce a Delta `schemaString` field `type` (a string for primitives, or a
 * nested struct / array / map object) into a short, human-readable label.
 */
export function deltaTypeLabel(type: unknown): string {
  if (typeof type === 'string') return type;
  if (type && typeof type === 'object') {
    const t = type as Record<string, unknown>;
    if (t.type === 'array' && t.elementType) return `array<${deltaTypeLabel(t.elementType)}>`;
    if (t.type === 'map') return `map<${deltaTypeLabel(t.keyType)},${deltaTypeLabel(t.valueType)}>`;
    if (t.type === 'struct') return 'struct';
    if (typeof t.type === 'string') return t.type;
  }
  return 'unknown';
}

/**
 * Parse a Delta `_delta_log/0.json` payload (newline-delimited JSON actions)
 * into the ordered list of fields from the first `metaData.schemaString`.
 */
export function parseDeltaSchema(json: string): DeltaField[] {
  const fields: DeltaField[] = [];
  for (const line of json.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let action: any;
    try {
      action = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const schemaString = action?.metaData?.schemaString;
    if (typeof schemaString !== 'string') continue;
    try {
      const schema = JSON.parse(schemaString);
      if (Array.isArray(schema?.fields)) {
        for (const f of schema.fields) {
          if (f?.name) fields.push({ name: String(f.name), type: deltaTypeLabel(f.type) });
        }
      }
    } catch {
      /* malformed metaData — skip this table */
    }
    if (fields.length) break; // first metaData line holds the create-time schema
  }
  return fields;
}

/** Format one table's fields into the compact prompt line `schema.name: [a:type, …]`. */
export function formatSchemaLine(table: Pick<CatalogTable, 'schema' | 'name'>, fields: DeltaField[]): string {
  if (!fields.length) return `${table.schema}.${table.name}: (schema unavailable)`;
  const cols = fields.map((f) => `${f.name}:${f.type}`).join(', ');
  return `${table.schema}.${table.name}: [${cols}]`;
}
