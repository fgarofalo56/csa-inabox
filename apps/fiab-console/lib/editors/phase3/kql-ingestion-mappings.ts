/**
 * Ingestion-mapping scoping for the KQL database editor's ingest and Event Hub
 * data-connection wizards (#3519).
 *
 * Pure, no React, no IO — the same shape as the other phase3 model modules
 * (`kql-pin-model.ts`, `dashboard-tile-state.ts`, `powerbi-embed-plan.ts`), and
 * extracted here for the reason `check-file-size.mjs` exists: the editor is a
 * ratchet-frozen monolith and pure logic does not belong inside it.
 */

/** One row of `.show database ingestion mappings` (GET /api/adx/ingestion-mappings). */
export type IngestionMappingRef = { name: string; kind?: string; table?: string };

/**
 * The mapping names offerable for a given target table.
 *
 * Kusto scopes an ingestion mapping to a table, so a mapping built for `Events`
 * is not a legal `ingestionMappingReference` when ingesting into `Alerts`. A
 * mapping whose `table` is empty came back database-scoped and stays offered
 * for every table. With NO table picked yet (the data connection's per-event
 * routing case) every mapping is in scope, because the routing decides the
 * table per event.
 *
 * Names are deduped: `.show` returns one row per (table, mapping) pair, and a
 * duplicated <option value> is indistinguishable in the picked result.
 */
export function ingestionMappingOptions(mappings: IngestionMappingRef[], table: string): string[] {
  const t = (table || '').trim().toLowerCase();
  const names = mappings
    .filter((m) => {
      if (!m?.name) return false;
      if (!t) return true;
      const mt = (m.table || '').trim().toLowerCase();
      return !mt || mt === t;
    })
    .map((m) => m.name);
  return Array.from(new Set(names));
}
