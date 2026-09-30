/**
 * Readiness check: lakehouses sharing a storage root.
 *
 * NOT a registry fragment. The fragments beside this file are pure env-presence
 * specs merged by ./index.ts and safe in a client bundle; this module reads the
 * items store, so it is server-only and ./index.ts deliberately does not import
 * or re-export it. Callers import it by path.
 *
 * WHAT IT REPORTS. Every lakehouse keeps its files under one directory in one
 * container (its "root"). New lakehouses get a root that carries their item id,
 * which no other item can share. Older ones can have a root derived from their
 * display name (`lakehouses/<name>`), recorded on the item or not. Where two
 * lakehouses' roots are equal or nested, this check lists them, by name and
 * workspace, with a link to each, so an admin can pick which one keeps the root:
 * the "Keep root for <item>" action (POST /api/admin/lakehouse-roots/keep).
 *
 * WHICH ROOT IS COMPARED. The one the storage resolver would use:
 * `lakehouseRootLocation` and `lakehouseRootsOverlap` (lib/azure/backing-name.ts)
 * over `listLakehouseRootFacts` (lib/azure/lakehouse-abfss.ts), recycled items
 * included since their files remain until purge. An unrecorded container or
 * account is treated as possibly equal to any, and roots are compared SEGMENT-
 * WISE: `lakehouses/Sales` overlaps `lakehouses/Sales/2024` but not
 * `lakehouses/Sales-archive`. A listed group is a POSSIBLE conflict: whether a
 * member is withheld depends on what the resolver finds (a directory marked for
 * one item, for instance, stays that item's).
 *
 * NAMES AND IDS ARE OPT-IN. The default result carries the COUNT only, which
 * suits a general diagnostics surface; `includeIds: true` is what the admin
 * readiness route (`withCapability(..., 'Admin')`) asks for, and it adds the
 * members of each group.
 */
import type { CheckResult } from './core';
import {
  lakehouseRootLocation,
  lakehouseRootsOverlap,
  type LakehouseRootFacts,
  type LakehouseRootLocation,
} from '@/lib/azure/backing-name';

export const LAKEHOUSE_SHARED_ROOTS_CHECK_ID = 'lakehouse-shared-roots';

/**
 * The check's title as Admin > Readiness shows it. The storage resolver's
 * `root-shared` message names the check by THIS constant, so the text a user
 * is pointed to and the heading an admin finds cannot drift apart.
 */
export const LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE = 'Lakehouses sharing a storage root';

/** One lakehouse in a shared-root group, as the admin sees it. */
export interface SharedRootMember {
  id: string;
  name: string;
  workspaceId: string;
  /** Deep link to the item's editor. */
  href: string;
  /** The item records this root (installer receipt or binding), rather than deriving it. */
  recorded: boolean;
  /** The item is in the recycle bin; its files remain until it is purged. */
  recycled: boolean;
}

/** A set of lakehouses whose roots are equal or nested in one another. */
export interface SharedRootGroup {
  ids: string[];
  roots: string[];
  members: SharedRootMember[];
}

/** The check result, plus the groups when the caller asked for members. */
export type LakehouseSharedRootsResult = CheckResult & { groups?: SharedRootGroup[] };

function describe(l: LakehouseRootLocation): string {
  const where = `${l.account ? `${l.account}/` : ''}${l.container ?? '<container not recorded>'}`;
  return `${where}/${l.segments.join('/')}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Group lakehouses whose roots overlap. Groups of one are dropped. Overlap is
 * joined transitively (A~B and B~C put A, B and C in one group), because a
 * decision about B has to consider both of the items it shares with.
 */
export function findSharedLakehouseRoots(rows: readonly LakehouseRootFacts[]): SharedRootGroup[] {
  const facts = new Map(rows.map((r) => [str(r.id), r]));
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
      return {
        ids: sorted.map((l) => l.id),
        roots: [...new Set(sorted.map(describe))].sort(),
        members: sorted.map((l) => {
          const f = facts.get(l.id);
          return {
            id: l.id,
            name: str(f?.displayName) || l.id,
            workspaceId: str(f?.workspaceId),
            href: `/items/lakehouse/${encodeURIComponent(l.id)}`,
            recorded: l.recorded,
            recycled: !!f?.recycled,
          };
        }),
      };
    })
    .sort((a, b) => a.ids[0].localeCompare(b.ids[0]));
}

const BASE = {
  id: LAKEHOUSE_SHARED_ROOTS_CHECK_ID,
  category: 'data-plane' as const,
  title: LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE,
  severity: 'recommended' as const,
};

/**
 * What the admin does, and what Loom does meanwhile. Kept true to the resolver:
 * a member that records the root, or whose directory is marked for it, keeps
 * opening; a member Loom cannot tell apart from another is not opened until the
 * group is resolved.
 */
export const LAKEHOUSE_SHARED_ROOTS_REMEDIATION =
  'Each group is two or more lakehouses whose storage roots are the same directory, or one inside the other. '
  + 'Until a group is resolved, Loom does not open that directory for a member it cannot confirm is the only one '
  + 'using it, so some members show a "storage location is also used by another item" message. To resolve a group, '
  + 'choose "Keep root for <lakehouse>" on the lakehouse whose data it is: that lakehouse keeps the directory, and '
  + 'every other member is given a new, empty root of its own. Nothing is copied or deleted.';

/** Pure: the readiness result for a set of lakehouse rows. */
export function lakehouseSharedRootsCheck(
  rows: readonly LakehouseRootFacts[],
  opts: { includeIds?: boolean } = {},
): LakehouseSharedRootsResult {
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
  if (!opts.includeIds) {
    return {
      ...BASE,
      status: 'warn',
      detail: `${head} The lakehouses are listed on the admin readiness page.`,
      remediation: LAKEHOUSE_SHARED_ROOTS_REMEDIATION,
    };
  }
  const named = groups
    .map((g) => `[${g.roots.join(', ')}: ${g.members.map((m) => `${m.name} (${m.id}${m.recycled ? ', recycled' : ''})`).join(', ')}]`)
    .join(' ');
  return { ...BASE, status: 'warn', detail: `${head} ${named}`, remediation: LAKEHOUSE_SHARED_ROOTS_REMEDIATION, groups };
}

/**
 * Live: read every lakehouse item (recycled ones included) and evaluate.
 * A failed read is `inconclusive`, never a pass: the check did not look.
 */
export async function probeLakehouseSharedRoots(
  opts: { includeIds?: boolean } = {},
): Promise<LakehouseSharedRootsResult> {
  let rows: LakehouseRootFacts[];
  try {
    const { listLakehouseRootFacts } = await import('@/lib/azure/lakehouse-abfss');
    rows = await listLakehouseRootFacts(undefined, { includeRecycled: true });
  } catch (e: unknown) {
    // The store's own message is not echoed, so the result reads the same on
    // every surface that shows it. The status code alone is kept.
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
