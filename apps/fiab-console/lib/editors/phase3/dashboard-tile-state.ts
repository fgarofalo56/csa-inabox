/**
 * dashboard-tile-state — pure render-state discriminator for a Loom dashboard
 * tile body (extracted so it can be unit-tested off the jsdom render path).
 *
 * Bug this fixes (no-vaporware.md / ux-baseline.md — loading states must be
 * designed, never a misleading empty state):
 *
 *   DashboardEditor.runLoomTile sets an OPTIMISTIC in-flight marker before a
 *   tile query resolves:
 *
 *       setLoomResults(prev => ({ ...prev,
 *         [tile.id]: { ok: true, rows: prev[tile.id]?.rows, columns: … } }))
 *
 *   On a tile's FIRST run `prev[tile.id]` is undefined, so the marker is
 *   `{ ok: true, rows: undefined }`. The old LoomTileBody only special-cased a
 *   fully-absent `result` for the "Running…" spinner, so this marker fell
 *   through to `!result.rows || length === 0` → it rendered **"No rows."** for
 *   the entire duration of the first query. On initial dashboard load every
 *   tile runs at once, so the whole canvas read "No rows." until each ADX/DAX
 *   query returned — indistinguishable from a genuinely empty result.
 *
 * The discriminator: a RESOLVED result always sets `rows` to `j.rows || []`
 * (never undefined), so `result.ok && result.rows === undefined` uniquely
 * identifies the optimistic in-flight marker → 'loading'. A refresh of a tile
 * that already had rows keeps those rows on the marker (`rows` defined) → it
 * stays on 'data' and shows the prior values while re-querying (Power BI-style,
 * no spinner flash) rather than blanking.
 */

import type { KqlResult } from './kql-results';

export type LoomTileBodyState = 'loading' | 'error' | 'empty' | 'data';

/**
 * Classify a tile's KqlResult into its render state.
 *   - undefined result                    → 'loading' (never queried)
 *   - optimistic marker (ok, rows undef)  → 'loading' (query in flight)
 *   - !ok                                 → 'error'   (honest gate / failure)
 *   - ok, resolved to zero rows           → 'empty'
 *   - ok, ≥1 row                          → 'data'
 */
export function loomTileBodyState(result?: KqlResult): LoomTileBodyState {
  if (!result) return 'loading';
  // Optimistic in-flight marker: a resolved result always carries rows (`[]` at
  // minimum), so `rows === undefined` means the query has not returned yet.
  if (result.ok && result.rows === undefined) return 'loading';
  if (!result.ok) return 'error';
  if (!result.rows || result.rows.length === 0) return 'empty';
  return 'data';
}
