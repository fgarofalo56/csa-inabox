/**
 * Unity Catalog PRIMITIVES — the error type and two pure helpers that both
 * `unity-catalog-client.ts` and `uc-system-tables.ts` need.
 *
 * ## Why this file exists
 *
 * `unity-catalog-client.ts` sits AT its frozen `check-file-size` ceiling
 * (2900 LOC). LU-3 has to add the audit `try/finally` to `ucFetch` in that file,
 * and the ratchet's documented remedy is decomposition, never a raised ceiling —
 * so the 165-line Databricks **system tables** block moved to
 * `uc-system-tables.ts`.
 *
 * That module needs `UnityCatalogError` + `ucRows` + `clampInt`, which lived in
 * the client. Importing them back from the client would make a cycle
 * (`unity-catalog-client` -> `uc-system-tables` -> `unity-catalog-client`), and
 * the client must keep re-exporting the system-table readers so no caller has to
 * change its import. Hoisting the three shared leaves here keeps every edge
 * pointing one way:
 *
 *   unity-catalog-client ─┬─▶ uc-primitives
 *                         └─▶ uc-system-tables ──▶ uc-primitives
 *
 * `unity-catalog-client` re-exports `UnityCatalogError`, so every existing
 * `import { UnityCatalogError } from '@/lib/azure/unity-catalog-client'` — and
 * every `instanceof` against it — is unchanged: a re-export is the same class
 * binding, not a copy.
 */
import type { QueryResult } from './databricks-client';

/**
 * A Unity Catalog / Loom Unity call that failed, carrying the upstream status,
 * the response body, and the endpoint. `status` is what
 * `unity-audit.ts`'s `unityOutcomeForError()` reads to separate an authorization
 * DENIAL (401/403) from an ordinary failure.
 */
export class UnityCatalogError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'UnityCatalogError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

/** QueryResult rows → array of column-keyed objects. */
export function ucRows(r: QueryResult): Record<string, unknown>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

/** Clamp a caller-supplied integer into [min,max], falling back to `def`. */
export const clampInt = (v: number | undefined, def: number, min: number, max: number): number => {
  const n = Number.isFinite(v as number) ? Math.trunc(v as number) : def;
  return Math.min(max, Math.max(min, n));
};
