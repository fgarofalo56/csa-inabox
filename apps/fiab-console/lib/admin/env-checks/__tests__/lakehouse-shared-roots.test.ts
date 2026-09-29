/**
 * Readiness check "Lakehouses sharing a storage root".
 *
 * The rows are literal `LakehouseRootFacts`, the shape `listLakehouseRootFacts`
 * projects. Every arm names the value that breaks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let ROWS: unknown[] = [];
let READ_FAILS: unknown = null;
vi.mock('@/lib/azure/lakehouse-abfss', () => ({
  listLakehouseRootFacts: async () => {
    if (READ_FAILS) throw READ_FAILS;
    return ROWS;
  },
}));

import {
  findSharedLakehouseRoots,
  lakehouseSharedRootsCheck,
  probeLakehouseSharedRoots,
} from '@/lib/admin/env-checks/lakehouse-shared-roots';

const BEFORE = '2026-09-01T00:00:00.000Z';
const AFTER = '2026-09-29T12:00:00.000Z';

/** Two older lakehouses named "Sales" with no recorded binding: both derive `lakehouses/Sales`. */
const SALES_A = { id: 'lh-a', displayName: 'Sales', createdAt: BEFORE };
const SALES_B = { id: 'lh-b', displayName: 'Sales', createdAt: BEFORE };
/** Shares a STRING prefix with `lakehouses/Sales`, not a segment prefix. */
const ARCHIVE = { id: 'lh-c', displayName: 'Sales-archive', createdAt: BEFORE };
/** A new lakehouse named "Sales": its root is `lakehouses/Sales--lh-d`. */
const SALES_NEW = { id: 'lh-d', displayName: 'Sales', createdAt: AFTER };

beforeEach(() => {
  ROWS = [];
  READ_FAILS = null;
});

describe('findSharedLakehouseRoots', () => {
  // FAILS IF the grouping drops either member (ids length 1 or 0), or if the
  // item-root lakehouse lh-d is grouped with them (ids length 3): lh-d's root is
  // `lakehouses/Sales--lh-d`, a different first segment after `lakehouses`.
  it('lists the two same-name older lakehouses, and not the new one', () => {
    const groups = findSharedLakehouseRoots([SALES_A, SALES_B, SALES_NEW, ARCHIVE]);
    expect(groups).toEqual([{ ids: ['lh-a', 'lh-b'], roots: ['<container not recorded>/lakehouses/Sales'] }]);
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
});

describe('lakehouseSharedRootsCheck', () => {
  // FAILS IF ids are included by default (the detail would contain `lh-a`), or
  // if the count is wrong (the detail would not read "across 2 lakehouse(s)").
  it('reports the count and hides the ids by default', () => {
    const r = lakehouseSharedRootsCheck([SALES_A, SALES_B, ARCHIVE]);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('1 shared storage root(s) across 2 lakehouse(s) (of 3 checked)');
    expect(r.detail).not.toContain('lh-a');
    expect(r.detail).not.toContain('lh-b');
  });

  // FAILS IF includeIds is ignored: the detail would not contain both ids.
  it('lists both ids when the caller asks for them', () => {
    const r = lakehouseSharedRootsCheck([SALES_A, SALES_B, ARCHIVE], { includeIds: true });
    expect(r.detail).toContain('lh-a, lh-b');
    expect(r.detail).not.toContain('lh-c');
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
  // path never reads the rows (it would pass on an empty set).
  it('evaluates the rows it reads', async () => {
    ROWS = [SALES_A, SALES_B];
    const r = await probeLakehouseSharedRoots({ includeIds: true });
    expect(r.status).toBe('warn');
    expect(r.inconclusive).toBeUndefined();
    expect(r.detail).toContain('lh-a, lh-b');
  });
});
