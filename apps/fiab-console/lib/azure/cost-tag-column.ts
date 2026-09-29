/**
 * Which column of a Cost Management `query` response carries the TAG VALUE when
 * the request groups by `{ type: 'TagKey', name: <key> }`.
 *
 * Measured against api-version 2023-03-01 (the version every cost module here
 * pins): a TagKey grouping returns TWO tag columns, `TagKey` and `TagValue`.
 * `TagKey` holds the key's own name on every row (e.g. `environment`), and
 * `TagValue` holds the value, or null for spend on a resource without the tag:
 *
 *   columns: Cost, ResourceGroupName, TagKey, TagValue, Currency
 *   row:     [10.5, 'rg-a', 'environment', 'commercial', 'USD']
 *   row:     [ 4.0, 'rg-a', 'environment', null,         'USD']
 *
 * Reading `TagKey` as the value (the earlier "first column that is not Cost /
 * RG / Currency" heuristic) folds every row into one bucket named after the
 * key. So: `TagValue` first; a column named after the key itself as the only
 * fallback; otherwise -1, and the caller treats every row as untagged rather
 * than guessing.
 */
export function tagValueColumnIndex(cols: any[], tagKey?: string): number {
  const lower = (cols || []).map((c) => String(c?.name || '').toLowerCase());
  const iVal = lower.indexOf('tagvalue');
  if (iVal >= 0) return iVal;
  const key = (tagKey || '').trim().toLowerCase();
  if (key && key !== 'tagkey') {
    const iKey = lower.indexOf(key);
    if (iKey >= 0) return iKey;
  }
  return -1;
}
