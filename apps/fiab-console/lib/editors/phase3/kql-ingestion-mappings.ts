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

/**
 * What the mapping picker actually KNOWS right now (#4357 re-review nit 2).
 *
 * The editor held two booleans and a string — `loading`, `error`, and an
 * options array — and an empty array with neither flag set was rendered as
 * *"No ingestion mapping is defined … on this database yet"*. That state is
 * reached three ways, and only ONE of them is an absence:
 *
 *   - the fetch finished and the database really has none      → `none`
 *   - the effect returned early (no id, or id === 'new')       → NOT a read
 *   - the very first frame, before the effect ran at all       → NOT a read
 *
 * Asserting absence over a read that never ran is the same R7 shape this PR
 * removed from the agent and workspace pickers, one surface further down. So
 * the state is computed here, `read` is set only by a COMPLETED fetch, and
 * `unread` gets its own copy in the editor.
 *
 * Precedence is deliberate: a failed read reports `error` (it carries the
 * route's reason) even though `read` is also false, because "could not be read
 * (reason)" is strictly more informative than "not read yet".
 */
export type MappingListState = 'loading' | 'error' | 'unread' | 'none' | 'ready';

export function mappingListState(s: {
  loading: boolean;
  error: string | null;
  read: boolean;
  optionCount: number;
}): MappingListState {
  if (s.loading) return 'loading';
  if (s.error) return 'error';
  if (!s.read) return 'unread';
  return s.optionCount > 0 ? 'ready' : 'none';
}

/**
 * The caption for the free-text fallback, one sentence per state.
 *
 * It lives HERE rather than inline in the editor for the reason this module
 * exists (`check-file-size.mjs`: the editor is a ratchet-frozen monolith), and
 * because the ingest wizard and the data-connection wizard were carrying two
 * hand-maintained copies of the same four sentences — which is how one of them
 * kept the absence claim after the other lost it. `undefined` for `ready`: a
 * picker is showing, so there is nothing to explain.
 */
export function mappingListHint(
  s: { loading: boolean; error: string | null; read: boolean; optionCount: number },
  table: string,
): string | undefined {
  const t = (table || '').trim();
  switch (mappingListState(s)) {
    case 'loading':
      return 'Reading the database’s ingestion mappings…';
    case 'error':
      return `The mapping list could not be read (${s.error}) — this does not mean none exist; type the name if you know it.`;
    case 'unread':
      return 'The database’s ingestion mappings have not been read yet — type the name if you know it.';
    case 'none':
      return `No ingestion mapping is defined${t ? ` for ${t}` : ''} on this database yet — leave blank for the identity mapping, or build one with Home → New → Ingestion mapping.`;
    default:
      return undefined;
  }
}
