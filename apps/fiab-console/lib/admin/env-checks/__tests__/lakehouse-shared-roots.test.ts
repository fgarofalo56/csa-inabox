/**
 * Readiness check "Lakehouses sharing a storage root".
 *
 * The rows are literal `LakehouseRootFacts`, the shape `listLakehouseRootFacts`
 * projects. Every arm names the value that breaks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let ROWS: unknown[] = [];
let READ_FAILS: unknown = null;
/** The options each live read was made with. */
const READ_OPTS: unknown[] = [];
vi.mock('@/lib/azure/lakehouse-abfss', () => ({
  listLakehouseRootFacts: async (_items: unknown, opts: unknown) => {
    READ_OPTS.push(opts);
    if (READ_FAILS) throw READ_FAILS;
    return ROWS;
  },
}));

import {
  findSharedLakehouseRoots,
  lakehouseSharedRootsCheck,
  probeLakehouseSharedRoots,
  LAKEHOUSE_SHARED_ROOTS_REMEDIATION,
} from '@/lib/admin/env-checks/lakehouse-shared-roots';

const BEFORE = '2026-09-01T00:00:00.000Z';
const AFTER = '2026-09-29T12:00:00.000Z';

/** Two older lakehouses named "Sales" with no recorded binding: both derive `lakehouses/Sales`. */
const SALES_A = { id: 'lh-a', workspaceId: 'ws-1', displayName: 'Sales', createdAt: BEFORE };
const SALES_B = { id: 'lh-b', workspaceId: 'ws-2', displayName: 'Sales', createdAt: BEFORE };
/** Shares a STRING prefix with `lakehouses/Sales`, not a segment prefix. */
const ARCHIVE = { id: 'lh-c', workspaceId: 'ws-1', displayName: 'Sales-archive', createdAt: BEFORE };
/** A new lakehouse named "Sales": its root is `lakehouses/Sales--lh-d`. */
const SALES_NEW = { id: 'lh-d', workspaceId: 'ws-1', displayName: 'Sales', createdAt: AFTER };

beforeEach(() => {
  ROWS = [];
  READ_FAILS = null;
  READ_OPTS.length = 0;
});

describe('findSharedLakehouseRoots', () => {
  // FAILS IF the grouping drops either member (ids length 1 or 0), or if the
  // item-root lakehouse lh-d is grouped with them (ids length 3): lh-d's root is
  // `lakehouses/Sales--lh-d`, a different first segment after `lakehouses`.
  // The member rows FAIL IF the name, workspace or link is dropped, or if an
  // unrecorded root is reported as recorded.
  it('lists the two same-name older lakehouses, by name and workspace, and not the new one', () => {
    const groups = findSharedLakehouseRoots([SALES_A, SALES_B, SALES_NEW, ARCHIVE]);
    expect(groups).toEqual([{
      ids: ['lh-a', 'lh-b'],
      roots: ['<container not recorded>/lakehouses/Sales'],
      members: [
        { id: 'lh-a', name: 'Sales', workspaceId: 'ws-1', href: '/items/lakehouse/lh-a', recorded: false, recycled: false },
        { id: 'lh-b', name: 'Sales', workspaceId: 'ws-2', href: '/items/lakehouse/lh-b', recorded: false, recycled: false },
      ],
    }]);
  });

  // FAILS IF a recycled row is not flagged (recycled false), or a recorded root
  // is not flagged (recorded false). The two flags are set on different
  // members so a swap of the two fields is also seen.
  it('flags the recorded member and the recycled member', () => {
    const recorded = { ...SALES_A, adlsContainer: 'bronze', lakehouseRoot: 'lakehouses/Sales' };
    const recycled = { ...SALES_B, recycled: { at: AFTER, by: 'owner-1' } };
    const [g] = findSharedLakehouseRoots([recorded, recycled]);
    expect(g.members.map((m) => [m.id, m.recorded, m.recycled])).toEqual([
      ['lh-a', true, false],
      ['lh-b', false, true],
    ]);
  });

  // FAILS IF overlap is a string-prefix test: `lakehouses/Sales-archive` starts
  // with `lakehouses/Sales`, and the result would be one group of two.
  it('does not group Sales with Sales-archive', () => {
    expect('lakehouses/Sales-archive'.startsWith('lakehouses/Sales')).toBe(true);
    expect(findSharedLakehouseRoots([SALES_A, ARCHIVE])).toEqual([]);
  });

  // FAILS IF nesting is not treated as sharing: `lakehouses/Sales/2024` sits
  // inside `lakehouses/Sales`, so a result of [] is the defect.
  it('groups a nested root with the root it sits inside', () => {
    const nested = { id: 'lh-n', displayName: 'Sales/2024', createdAt: BEFORE };
    expect(findSharedLakehouseRoots([SALES_A, nested]).map((g) => g.ids)).toEqual([['lh-a', 'lh-n']]);
  });

  // FAILS IF recorded containers are ignored: both bound roots are
  // `lakehouses/Sales`, but in different containers, so they do not share.
  it('does not group equal roots recorded in different containers', () => {
    const inBronze = { id: 'lh-x', lakehouseRoot: 'lakehouses/Sales', adlsContainer: 'bronze', createdAt: BEFORE };
    const inLanding = { id: 'lh-y', lakehouseRoot: 'lakehouses/Sales', adlsContainer: 'landing', createdAt: BEFORE };
    expect(findSharedLakehouseRoots([inBronze, inLanding])).toEqual([]);
    // Paired positive: the same two in ONE container do share.
    expect(findSharedLakehouseRoots([inBronze, { ...inLanding, adlsContainer: 'bronze' }]).map((g) => g.ids))
      .toEqual([['lh-x', 'lh-y']]);
  });

  // FAILS IF a recorded root is read by the item's age rather than by the
  // record: lh-z was created after the cutover but records `lakehouses/Sales`
  // in bronze, the root lh-a records. Read by age, lh-z would count at its
  // derived item root `lakehouses/Sales--lh-z`, and the result would be [].
  it('groups by the recorded root even for an item created after the cutover', () => {
    const olderRecorded = { ...SALES_A, adlsContainer: 'bronze', lakehouseRoot: 'lakehouses/Sales' };
    const newerRecorded = { id: 'lh-z', displayName: 'Sales', createdAt: AFTER, adlsContainer: 'bronze', lakehouseRoot: 'lakehouses/Sales' };
    expect(findSharedLakehouseRoots([olderRecorded, newerRecorded]).map((g) => g.ids)).toEqual([['lh-a', 'lh-z']]);
    // Paired positive: without the record, lh-z sits at its own item root and shares nothing.
    const { adlsContainer: _c, lakehouseRoot: _r, ...newerUnrecorded } = newerRecorded;
    expect(findSharedLakehouseRoots([olderRecorded, newerUnrecorded])).toEqual([]);
  });
});

describe('lakehouseSharedRootsCheck', () => {
  // FAILS IF ids are included by default (the detail would contain `lh-a`, and
  // groups would be set), or if the count is wrong.
  it('reports the count and hides the members by default', () => {
    const r = lakehouseSharedRootsCheck([SALES_A, SALES_B, ARCHIVE]);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('1 shared storage root(s) across 2 lakehouse(s) (of 3 checked)');
    expect(r.detail).not.toContain('lh-a');
    expect(r.groups).toBeUndefined();
  });

  // FAILS IF includeIds is ignored (no names or ids in the detail, no groups),
  // or if the detail lists bare ids without the item names.
  it('names each member, with its id, when the caller asks for them', () => {
    const r = lakehouseSharedRootsCheck([SALES_A, SALES_B, ARCHIVE], { includeIds: true });
    expect(r.detail).toContain('Sales (lh-a), Sales (lh-b)');
    expect(r.detail).not.toContain('lh-c');
    expect(r.groups?.map((g) => g.ids)).toEqual([['lh-a', 'lh-b']]);
  });

  // FAILS IF a recycled member is listed without saying so.
  it('marks a recycled member in the detail', () => {
    const r = lakehouseSharedRootsCheck([SALES_A, { ...SALES_B, recycled: { at: AFTER } }], { includeIds: true });
    expect(r.detail).toContain('Sales (lh-b, recycled)');
    expect(r.detail).toContain('Sales (lh-a)');
  });

  // The remediation text is what the admin acts on. FAILS IF it stops naming
  // the one-step action, or claims files are moved (the action creates a new
  // root for the other members; it copies and deletes nothing).
  it('names the Keep root action and says nothing is copied or deleted', () => {
    const r = lakehouseSharedRootsCheck([SALES_A, SALES_B], { includeIds: true });
    expect(r.remediation).toBe(LAKEHOUSE_SHARED_ROOTS_REMEDIATION);
    expect(r.remediation).toContain('Keep root for');
    expect(r.remediation).toContain('Nothing is copied or deleted');
    expect(r.remediation).not.toMatch(/\bmove/i);
  });

  // FAILS IF the check warns with no group (status 'warn' here).
  it('passes when no two lakehouses share a root', () => {
    expect(lakehouseSharedRootsCheck([SALES_A, ARCHIVE, SALES_NEW]).status).toBe('pass');
  });
});

describe('probeLakehouseSharedRoots', () => {
  // FAILS IF a failed read is scored as a pass (status 'pass', no rows), or if
  // the store's message is echoed into the detail.
  it('marks a failed read inconclusive and does not echo the store message', async () => {
    READ_FAILS = Object.assign(new Error('internal endpoint text'), { code: 503 });
    const r = await probeLakehouseSharedRoots();
    expect(r.status).toBe('warn');
    expect(r.inconclusive).toBe(true);
    expect(r.detail).toContain('code 503');
    expect(r.detail).not.toContain('internal endpoint text');
  });

  // Positive twin: a successful read reaches the evaluation. FAILS IF the live
  // path never reads the rows (it would pass on an empty set), or reads
  // without recycled items (READ_OPTS would not carry includeRecycled: true).
  it('evaluates the rows it reads, recycled items included', async () => {
    ROWS = [SALES_A, SALES_B];
    const r = await probeLakehouseSharedRoots({ includeIds: true });
    expect(r.status).toBe('warn');
    expect(r.inconclusive).toBeUndefined();
    expect(r.detail).toContain('Sales (lh-a), Sales (lh-b)');
    expect(READ_OPTS).toEqual([{ includeRecycled: true }]);
  });
});
