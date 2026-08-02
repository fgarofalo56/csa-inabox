/**
 * loom-content-id — the `loom:<cosmosItemId>` synthetic-id vocabulary.
 *
 * WHY THIS MODULE EXISTS (#2830). These three symbols used to live only in
 * `pbi-content-fallback.ts`, which pulls in the Cosmos client, the content-bundle
 * types and the scorecard rollup engine. That made them un-importable from the
 * low-level Cosmos primitives (`_lib/item-crud.ts`, `lib/azure/tabular-eval-client.ts`)
 * without risking an import cycle — which is precisely why the id resolution kept
 * being re-implemented, one route at a time, in four separate defects
 * (#2649 / #2818 / #2822 / #2830).
 *
 * They are pure string functions with ZERO dependencies, so every layer can
 * import them. `pbi-content-fallback.ts` re-exports them, so the ~40 existing
 * import sites are unchanged.
 *
 * THE VOCABULARY. A list route surfaces a bundle-installed (Cosmos-backed) item
 * that has no live Power BI object yet under the SYNTHETIC id
 * `loom:<cosmosItemId>`. The editor then threads whatever the list route handed
 * it into every sub-route. Cosmos stores that item under the BARE id, so any
 * lookup that queries `WHERE c.id = @id` with the prefixed form matches nothing
 * and 404s on an item that is sitting right there.
 *
 * WHY STRIPPING IS ALWAYS SAFE. Loom mints item ids with `crypto.randomUUID()`
 * (`item-crud.ts:createOwnedItem`), and a Power BI dataset/report id is likewise
 * a GUID. Neither can begin with `loom:`, so {@link cosmosIdFromLoomId} is the
 * IDENTITY function for every id that is not a synthetic list entry — a live
 * Power BI id passes through byte-identical.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

/** Prefix that marks a synthetic, Cosmos-backed (not-yet-in-PBI) entry. */
export const LOOM_ID_PREFIX = 'loom:';

/** True when `id` is the synthetic list form of a Cosmos-backed item. */
export function isLoomContentId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(LOOM_ID_PREFIX);
}

/**
 * Resolve a possibly-synthetic id to the Cosmos item id.
 *
 * IDENTITY for anything that is not `loom:`-prefixed (see the module note), so
 * it is safe to apply unconditionally at a Cosmos chokepoint.
 */
export function cosmosIdFromLoomId(id: string): string {
  return isLoomContentId(id) ? id.slice(LOOM_ID_PREFIX.length) : id;
}
