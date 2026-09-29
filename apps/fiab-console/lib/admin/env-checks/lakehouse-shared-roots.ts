/**
 * Readiness check: lakehouses sharing a storage root.
 *
 * NOT a registry fragment. The fragments beside this file are pure env-presence
 * specs merged by ./index.ts and safe in a client bundle; this module reads the
 * items store, so it is server-only and ./index.ts deliberately does not import
 * or re-export it. Callers import it by path.
 *
 * WHAT IT REPORTS. Every lakehouse keeps its files under one directory in one
 * container (its "root"). Lakehouses created before `LAKEHOUSE_ITEM_ROOT_SINCE`
 * were given a root derived from their display name (`lakehouses/<name>`), and
 * existing items keep that root — no data is moved. So two older lakehouses with
 * the same name, or one whose name is a path prefix of another's
 * (`lakehouses/Sales` and `lakehouses/Sales/2024`), resolve to the same or
 * nested directories. This check lists them so an admin can decide what to do
 * with each.
 *
 * WHICH ROOT IS COMPARED. Exactly the one the storage resolver compares before it
 * uses a name-only root: `lakehouseRootLocation` and `lakehouseRootsOverlap`
 * (lib/azure/backing-name.ts) over `listLakehouseRootFacts`
 * (lib/azure/lakehouse-abfss.ts). One definition, so the check and the resolver
 * cannot disagree about which items share a root. An unrecorded container or
 * account is treated as possibly equal to any, and roots are compared SEGMENT-
 * WISE: `lakehouses/Sales` overlaps `lakehouses/Sales/2024` but not
 * `lakehouses/Sales-archive`.
 *
 * IDS ARE OPT-IN. `GET /api/admin/self-audit` is readable by any signed-in user,
 * so the default result carries the COUNT only; `includeIds: true` is for an
 * admin-gated surface (the readiness route is `withCapability(..., 'Admin')`).
 */
import type { CheckResult } from './core';
import {
  lakehouseRootLocation,
  lakehouseRootsOverlap,
  type LakehouseRootFacts,
  type LakehouseRootLocation,
} from '@/lib/azure/backing-name';

export const LAKEHOUSE_SHARED_ROOTS_CHECK_ID = 'lakehouse-shared-roots';

/** A set of lakehouses whose roots are equal or nested in one another. */
export interface SharedRootGroup {
  ids: string[];
  roots: string[];
}

function describe(l: LakehouseRootLocation): string {
  const where = `${l.account ? `${l.account}/` : ''}${l.container ?? '<container not recorded>'}`;
  return `${where}/${l.segments.join('/')}`;
}

/**
 * Group lakehouses whose roots overlap. Groups of one are dropped. Overlap is
 * joined transitively (A~B and B~C put A, B and C in one group), because a
 * decision about B has to consider both of the items it shares with.
 */
export function findSharedLakehouseRoots(rows: readonly LakehouseRootFacts[]): SharedRootGroup[] {
  const locs = rows.map(lakehouseRootLocation).filter((l): l is LakehouseRootLocation => !!l);
  const parent = locs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < locs.length; i++) {
    for (let j = i + 1; j < locs.length; j++) {
      if (lakehouseRootsOverlap(locs[i], locs[j])) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map<number, LakehouseRootLocation[]>();
  locs.forEach((l, i) => {
    const r = find(i);
    byRoot.set(r, [...(byRoot.get(r) ?? []), l]);
  });
  return [...byRoot.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const sorted = [...g].sort((a, b) => a.id.localeCompare(b.id));
      return { ids: sorted.map((l) => l.id), roots: [...new Set(sorted.map(describe))].sort() };
    })
    .sort((a, b) => a.ids[0].localeCompare(b.ids[0]));
}

const BASE = {
  id: LAKEHOUSE_SHARED_ROOTS_CHECK_ID,
  category: 'data-plane' as const,
  title: 'Lakehouses sharing a storage root',
  severity: 'recommended' as const,
};

const REMEDIATION =
  'Each listed group is two or more lakehouses whose files resolve to the same (or a nested) directory. '
  + 'Lakehouses created from 2026-09-29 get their own root automatically; these are older items that keep '
  + 'the root they already had. Until a group is resolved, Loom does not attach an unrecorded root to any '
  + 'member of it. For each group, keep the lakehouse that owns the data, and move or delete the others '
  + '(or copy their data to a new lakehouse, which gets its own root).';

/** Pure: the readiness result for a set of lakehouse rows. */
export function lakehouseSharedRootsCheck(
  rows: readonly LakehouseRootFacts[],
  opts: { includeIds?: boolean } = {},
): CheckResult {
  const groups = findSharedLakehouseRoots(rows);
  if (!groups.length) {
    return {
      ...BASE,
      status: 'pass',
      detail: `${rows.length} lakehouse(s) checked; no two share a storage root.`,
    };
  }
  const affected = groups.reduce((n, g) => n + g.ids.length, 0);
  const head = `${groups.length} shared storage root(s) across ${affected} lakehouse(s) (of ${rows.length} checked).`;
  const detail = opts.includeIds
    ? `${head} ${groups.map((g) => `[${g.roots.join(', ')}: ${g.ids.join(', ')}]`).join(' ')}`
    : `${head} Item ids are listed on the admin readiness page.`;
  return { ...BASE, status: 'warn', detail, remediation: REMEDIATION };
}

/**
 * Live: read every lakehouse item (recycled ones excluded) and evaluate.
 * A failed read is `inconclusive`, never a pass: the check did not look.
 */
export async function probeLakehouseSharedRoots(
  opts: { includeIds?: boolean } = {},
): Promise<CheckResult> {
  let rows: LakehouseRootFacts[];
  try {
    const { listLakehouseRootFacts } = await import('@/lib/azure/lakehouse-abfss');
    rows = await listLakehouseRootFacts();
  } catch (e: unknown) {
    // The store's own message is not echoed: this result can reach any signed-in
    // user through the self-audit route. The status code alone is kept.
    const code = (e as { code?: unknown } | null)?.code;
    const codeText = typeof code === 'number' || (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code))
      ? ` (code ${code})`
      : '';
    return {
      ...BASE,
      status: 'warn',
      inconclusive: true,
      detail: `Could not read the lakehouse items${codeText}, so this check did not run.`,
    };
  }
  return lakehouseSharedRootsCheck(rows, opts);
}
