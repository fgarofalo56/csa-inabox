/**
 * #3826 site 3 — THE ADMIN WORKSPACE INVENTORY MUST BE TENANT-SCOPED.
 *
 * `listAllWorkspacesAdmin` issued `SELECT * FROM c` with NO tenant predicate.
 * The `workspaces` container is partitioned on `/tenantId`, which in this
 * codebase holds the CREATING USER'S OID — not an Entra tenant — so the
 * cross-partition fan-out that makes the admin inventory work at all also
 * crossed every tenant in the account.
 *
 * WHY THE ROUTE'S `isTenantAdmin` GATE DID NOT COVER IT, which is the whole
 * point: that gate establishes the caller is AN admin. It never establishes
 * WHICH TENANT they administer, and it does not narrow the query behind it by
 * one row. Two consumers took the unfiltered set — the `/admin/workspaces`
 * inventory (names, owners, domains, storage account ids) and
 * `lib/azure/workspace-chargeback.ts`, which additionally ALLOCATED one
 * tenant's real Cost Management dollars across another tenant's workspaces.
 *
 * ASSERTIONS ARE ON THE QUERY TEXT AND PARAMETERS, not only on the returned
 * rows. A post-hoc `.filter()` would satisfy a rows-only assertion while still
 * reading, materialising and paying RU for every other tenant's records — and
 * would still have disclosed them to anything that logged the raw result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queries: any[] = [];
const wsFetchAll = vi.fn();
const itemsFetchAll = vi.fn(async () => ({ resources: [] }));
const rolesFetchAll = vi.fn(async () => ({ resources: [] }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    items: {
      query: (spec: any) => {
        queries.push(spec);
        return { fetchAll: async () => wsFetchAll(spec) };
      },
    },
  }),
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: itemsFetchAll }) } }),
  workspaceRolesContainer: async () => ({ items: { query: () => ({ fetchAll: rolesFetchAll }) } }),
}));

import { listAllWorkspacesAdmin } from '../workspaces-client';

const HOME_TID = '11111111-1111-1111-1111-111111111111';
const FOREIGN_TID = '22222222-2222-2222-2222-222222222222';

const MINE = { id: 'ws-mine', tenantId: 'oid-a', tid: HOME_TID, name: 'Mine' };
const THEIRS = { id: 'ws-theirs', tenantId: 'oid-b', tid: FOREIGN_TID, name: 'Theirs' };
const LEGACY = { id: 'ws-legacy', tenantId: 'oid-c', name: 'Legacy' };

/** The exact tenant predicate. Pinned as TEXT — see the spec that uses it. */
const SCOPED_SCAN = 'SELECT * FROM c WHERE c.tid = @tid';

/** The main scan is query #1; the unstamped COUNT is query #2. */
function wireStore(rows: any[], legacyCount = 0) {
  wsFetchAll.mockImplementation(async (spec: any) => {
    if (/COUNT\(1\)/.test(spec.query)) return { resources: [legacyCount] };
    const tid = spec.parameters?.find((p: any) => p.name === '@tid')?.value;
    // THIS MOCK CANNOT PARSE SQL, AND THAT IS A MEASURED BLIND SPOT, NOT AN
    // ASSUMPTION. It answers `r.tid === tid`, i.e. it models what the predicate
    // is SUPPOSED to mean. So it is honest about a predicate that is absent
    // (undefined `tid` -> every row, which is the pre-fix behaviour) but blind
    // to one that is WIDENED — measured: mutating the query to
    // `WHERE c.tid = @tid OR NOT IS_DEFINED(c.tid)` left this file at RC=0,
    // 10/10 passing, with unstamped records readmitted to every tenant's
    // inventory. That is the classic fixture-models-the-code failure, and the
    // row-level specs below cannot close it. `pins the tenant predicate as
    // EXACT TEXT` is what closes it.
    return { resources: tid ? rows.filter((r) => r.tid === tid) : rows };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
});

describe('#3826 — the scan is scoped IN THE QUERY', () => {
  it('carries a tenant predicate and binds the caller tid as a PARAMETER', async () => {
    wireStore([MINE, THEIRS, LEGACY]);
    await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    const scan = queries[0];
    // The predicate exists…
    expect(scan.query).toMatch(/WHERE\s+c\.tid\s*=\s*@tid/);
    // …and the value is BOUND, never interpolated into the text.
    expect(scan.query).not.toContain(HOME_TID);
    expect(scan.parameters).toEqual([{ name: '@tid', value: HOME_TID }]);
  });

  it('pins the tenant predicate as EXACT TEXT — a WIDENED predicate is a red build', async () => {
    // WHY EXACT TEXT AND NOT A REGEX. The first draft of this suite asserted
    // `expect(scan.query).toMatch(/WHERE\s+c\.tid\s*=\s*@tid/)`, which is
    // satisfied by a predicate that still CONTAINS that clause and then ORs
    // something back in. Measured on this tree, mutating the query to
    //
    //     SELECT * FROM c WHERE c.tid = @tid OR NOT IS_DEFINED(c.tid)
    //
    // left every other spec in this file GREEN (RC=0, 10/10) while restoring
    // unstamped records to every tenant's inventory — the narrow bypass, which
    // is the one that actually gets written, because it looks like a tightening
    // and still blocks the cross-tenant case a reviewer would think to try.
    //
    // A security predicate is not a detail the tests should be relaxed about:
    // pinning it as text means ANY change to it — widening, narrowing, or a
    // rename — has to be argued for in review rather than merely compiling.
    wireStore([MINE, THEIRS, LEGACY]);
    await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    expect(queries[0].query).toBe(SCOPED_SCAN);
  });

  it('the predicate is a single conjunctive scope — no OR, no IS_DEFINED escape', async () => {
    // Stated independently of the exact-text pin so the FAILURE MESSAGE names
    // the mechanism when someone widens it, instead of just diffing two strings.
    wireStore([MINE]);
    await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    expect(queries[0].query).not.toMatch(/\bOR\b/i);
    expect(queries[0].query).not.toMatch(/IS_DEFINED/i);
  });

  it('returns EXACTLY the in-tenant workspace — not a count, the identity', async () => {
    wireStore([MINE, THEIRS, LEGACY]);
    const out = await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    expect(out.workspaces.map((w) => w.id)).toEqual(['ws-mine']);
  });

  it('a FOREIGN admin sees exactly their own — the two scopes are disjoint', async () => {
    // Two callers, one store. A filter that is scoped to the wrong thing (or to
    // nothing) cannot produce disjoint answers for both.
    wireStore([MINE, THEIRS, LEGACY]);
    const a = await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    const b = await listAllWorkspacesAdmin({ callerTid: FOREIGN_TID });
    expect(a.workspaces.map((w) => w.id)).toEqual(['ws-mine']);
    expect(b.workspaces.map((w) => w.id)).toEqual(['ws-theirs']);
  });

  it('an UNSTAMPED workspace belongs to nobody and appears for NEITHER tenant', async () => {
    wireStore([MINE, THEIRS, LEGACY]);
    const a = await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    const b = await listAllWorkspacesAdmin({ callerTid: FOREIGN_TID });
    expect(a.workspaces.map((w) => w.id)).not.toContain('ws-legacy');
    expect(b.workspaces.map((w) => w.id)).not.toContain('ws-legacy');
  });
});

describe('#3826 — a caller with no confirmable tenant FAILS CLOSED', () => {
  it('returns an empty inventory and NEVER issues the scan', async () => {
    wireStore([MINE, THEIRS, LEGACY]);
    const out = await listAllWorkspacesAdmin({ callerTid: undefined });
    expect(out.workspaces).toEqual([]);
    // The important half: not "filtered to nothing" but NOT QUERIED AT ALL.
    expect(queries).toHaveLength(0);
  });

  it('says WHY, rather than presenting an empty tenant as the truth (R7)', async () => {
    wireStore([MINE]);
    const out = await listAllWorkspacesAdmin({ callerTid: undefined });
    expect(out.degraded).toBe(true);
    expect(out.degradedReasons).toEqual(['tenant-scope-unconfirmed']);
    expect(out.legacyRemediation).toContain('tid');
  });

  it('an EMPTY STRING tid is treated as absent, not as a tenant', async () => {
    wireStore([MINE]);
    const out = await listAllWorkspacesAdmin({ callerTid: '' });
    expect(out.workspaces).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});

describe('#3826 — excluded legacy records are DISCLOSED, not silently dropped', () => {
  it('reports the unstamped count with its remediation', async () => {
    wireStore([MINE, THEIRS, LEGACY], 3);
    const out = await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    expect(out.legacyUnstampedExcluded).toBe(3);
    expect(out.legacyRemediation).toContain('backfill-workspace-tid');
  });

  it('emits NO remediation when there is nothing excluded — no phantom warning', async () => {
    wireStore([MINE], 0);
    const out = await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    expect(out.legacyUnstampedExcluded).toBe(0);
    expect(out.legacyRemediation).toBeUndefined();
  });

  it('an EMPTY in-tenant result still reports the exclusion count', async () => {
    // The case that matters operationally: an estate whose workspaces are ALL
    // unstamped reads as "you have no workspaces" unless this is surfaced.
    wireStore([LEGACY], 1);
    const out = await listAllWorkspacesAdmin({ callerTid: HOME_TID });
    expect(out.workspaces).toEqual([]);
    expect(out.legacyUnstampedExcluded).toBe(1);
  });
});
