/**
 * kql-pin-model — pure helper for pinning a tile onto an EXISTING KQL / Real-Time
 * dashboard from a sibling surface (KQL Queryset "Save to dashboard", etc.).
 *
 * Why this exists (correctness / no-vaporware): the kql-dashboard PUT handler
 * (`app/api/items/kql-dashboard/[id]/route.ts`) rebuilds the WHOLE persisted
 * model from the request body via `sanitizeModel(body)` and always writes
 * `dataSources`, `parameters`, and `baseQueries` from that sanitized model. So a
 * PUT body of just `{ tiles }` sanitizes to EMPTY dataSources / parameters /
 * baseQueries and DESTROYS them on the target dashboard — every tile bound to a
 * named data source breaks, every dashboard parameter and base-query (`let`)
 * definition vanishes. `mergePinnedTile` round-trips the full model read from GET
 * and appends the new tile, so pinning is additive and non-destructive.
 */

/** The subset of the kql-dashboard GET response we round-trip on a pin. */
export interface DashboardModelSnapshot {
  ok?: boolean;
  tiles?: unknown[];
  dataSources?: unknown[];
  parameters?: unknown[];
  baseQueries?: unknown[];
  timeRange?: string;
  autoRefreshMs?: number;
}

export interface PinnedTile {
  title: string;
  kql: string;
  viz: string;
  database?: string;
}

/** The PUT body shape sent to kql-dashboard/[id]. */
export interface DashboardPutBody {
  tiles: unknown[];
  dataSources?: unknown[];
  parameters?: unknown[];
  baseQueries?: unknown[];
  timeRange?: string;
  autoRefreshMs?: number;
}

/**
 * Append `tile` to the target dashboard's tiles while preserving its data
 * sources, parameters, base queries, and settings. Never mutates `cur`.
 */
export function mergePinnedTile(
  cur: DashboardModelSnapshot | null | undefined,
  tile: PinnedTile,
): DashboardPutBody {
  const tiles = Array.isArray(cur?.tiles) ? [...(cur!.tiles as unknown[])] : [];
  tiles.push(tile);
  return {
    tiles,
    // Round-trip the rest of the model so the PUT handler's full-model rewrite
    // does not blank them out. `undefined` fields are dropped by JSON.stringify,
    // and sanitizeModel treats a missing key the same as an empty array.
    dataSources: cur?.dataSources,
    parameters: cur?.parameters,
    baseQueries: cur?.baseQueries,
    timeRange: cur?.timeRange,
    autoRefreshMs: cur?.autoRefreshMs,
  };
}
