/**
 * Client-side helpers shared by the SQL-family Explorer trees (Synapse
 * Dedicated, Fabric Warehouse). They turn an Explorer node action into a real
 * BFF call:
 *
 *   - sqlRowCount   → POST /query with SELECT COUNT(*) → real row count
 *   - loadSqlScript → GET  /script-out → real OBJECT_DEFINITION / DROP DDL
 *
 * Both are engine-agnostic over the item type, so the Dedicated pool and the
 * Warehouse (same backend) reuse them verbatim.
 */

import type { ScriptObjectType, ScriptMode } from '@/lib/azure/sql-object-scripting';

function bracket(id: string): string {
  return `[${id.replace(/]/g, '')}]`;
}

/** Run a real SELECT COUNT(*) for the object via the item's /query route. */
export async function sqlRowCount(itemType: string, id: string, schema: string, name: string): Promise<number | null> {
  try {
    const r = await fetch(`/api/items/${itemType}/${encodeURIComponent(id)}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT COUNT_BIG(*) AS c FROM ${bracket(schema)}.${bracket(name)};` }),
    });
    const j = await r.json();
    const v = j?.ok ? j?.rows?.[0]?.[0] : null;
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

export interface LoadSqlScriptResult {
  ok: boolean;
  script?: string;
  error?: string;
}

/** Fetch a CREATE/ALTER/DROP script for the object from the item's
 *  /script-out route. Returns the script text or a structured error. */
export async function loadSqlScript(
  itemType: string,
  id: string,
  opts: { type: ScriptObjectType; schema: string; name: string; mode: ScriptMode },
): Promise<LoadSqlScriptResult> {
  try {
    const params = new URLSearchParams({
      schema: opts.schema, name: opts.name, type: opts.type, mode: opts.mode,
    });
    const r = await fetch(`/api/items/${itemType}/${encodeURIComponent(id)}/script-out?${params.toString()}`);
    const j = await r.json();
    if (j?.ok && typeof j.script === 'string') return { ok: true, script: j.script };
    return { ok: false, error: j?.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
