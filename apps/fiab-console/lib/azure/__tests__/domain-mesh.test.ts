/**
 * Vitest specs for the federated data-mesh READ side (lib/azure/domain-mesh,
 * issue #1483 Wave 4).
 *
 * Verifies:
 *   - a domain's catalog footprint ROLLS UP over its whole subtree (a parent
 *     owns the workspaces + items of every descendant, at arbitrary depth).
 *   - the Unity Catalog target for a deep descendant is computed under its ROOT
 *     ancestor's catalog (root → catalog, descendant → schema).
 *   - each surface degrades to an honest gate (configured:false + hint) when its
 *     back-end is unconfigured — never a fabricated count.
 *   - #3753: the TENANT scope (domains doc, `tenant-settings`) is threaded to
 *     its own container and never collapsed with the workspace scope.
 *   - #3747: the workspace rollup is TENANT-WIDE. It is a cross-partition query
 *     on the stamped `tid`, with NO `partitionKey` option — the two Domains
 *     panels share one counter and cannot disagree.
 *
 * THE #3747 DEFECT THIS PINS. `readWorkspaceTags` ran
 * `WHERE c.tenantId = @t` with `{ partitionKey: ownerOid }`. `Workspace.tenantId`
 * is the partition key and holds the CREATING USER's oid, so the "Federated
 * data-mesh" panel counted only the caller's own workspaces, while
 * `/api/admin/domains workspaceCounts` ran the same shape keyed by
 * `tenantScopeId(session)` — a tid, which keys no workspace partition at all —
 * and reported 0 for every domain. Two panels, two wrong scopes, two different
 * numbers on one screen. The fixture below stamps workspaces from TWO creators
 * with one shared tid so a per-creator read is distinguishable from a
 * tenant-wide one; a single-creator fixture could not tell them apart.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Deep tree: dept → agency → office (3 levels), plus an unrelated root.
const DOMAINS = [
  { id: 'dept', name: 'Department', createdAt: '', createdBy: '', status: 'active', subscriptionIds: ['s1'] },
  { id: 'agency', name: 'Agency', parentId: 'dept', createdAt: '', createdBy: '' },
  { id: 'office', name: 'Office', parentId: 'agency', createdAt: '', createdBy: '' },
  { id: 'lone', name: 'Lone', createdAt: '', createdBy: '' },
];

/**
 * The three scopes are DELIBERATELY different values. Pre-#3753 the route passed
 * one value for the domains doc and the workspace read, so a test that used a
 * single string could not tell a correct implementation from the bug.
 */
const TENANT_SCOPE = 'tid-00000000-0000-0000-0000-00000000tenant';
const CALLER_TID = 'tid-00000000-0000-0000-0000-00000000tenant';
const OWNER_OID = 'oid-11111111-1111-1111-1111-111111111111';
/** A SECOND creator in the same tenant. A per-creator read cannot see these. */
const OTHER_OID = 'oid-22222222-2222-2222-2222-222222222222';

/**
 * Workspace docs as the estate actually stores them: `tenantId` = the CREATOR's
 * oid (the partition key), `tid` = the Entra tenant, stamped by
 * POST /api/workspaces. Two creators, one tenant.
 *
 * `ws-legacy` is a PRE-rel-T11 record: it has a `tenantId` (there has always
 * been a partition key) but NO `tid`, because the stamp did not exist yet.
 * Cosmos `=` does not match an undefined property, so `WHERE c.tid = @tid`
 * cannot see it — which is exactly why the shared counter has to disclose it.
 * Without this row in the fixture, a counter that reports its answer as
 * complete is indistinguishable from one that discloses the gap.
 */
const WS_DOCS: Array<{ id: string; domain: string; tenantId: string; tid?: string }> = [
  { id: 'ws-a', domain: 'agency', tenantId: OWNER_OID, tid: CALLER_TID },
  { id: 'ws-o', domain: 'office', tenantId: OTHER_OID, tid: CALLER_TID },
  { id: 'ws-l', domain: 'lone', tenantId: OTHER_OID, tid: CALLER_TID },
  { id: 'ws-legacy', domain: 'lone', tenantId: OWNER_OID },
];

/** The rows a tenant-scoped predicate CAN match — i.e. everything but legacy. */
const WS_STAMPED = WS_DOCS.filter((w) => w.tid !== undefined);

/** What each backing store was actually addressed with. */
const seen: {
  domainsDocScope: string[];
  wsQueries: Array<{ query: string; params: Record<string, unknown>; partitionKey: unknown }>;
} = { domainsDocScope: [], wsQueries: [] };

vi.mock('../domain-registry', () => ({
  loadOrSeedDomains: async (tenantId: string) => {
    seen.domainsDocScope.push(tenantId);
    return { id: `domains:${tenantId}`, tenantId, kind: 'domains', items: DOMAINS, updatedAt: '' };
  },
}));

/**
 * A workspaces container that HONORS the query it is given, so a scoping bug
 * shows up as a different row count rather than passing on a fixture that
 * returns everything regardless. Supports the shapes at issue:
 * `WHERE c.tid = @tid` (tenant-wide) and `WHERE c.tenantId = @t` (per-creator),
 * plus the `{ partitionKey }` option, which additionally narrows — and the
 * `SELECT VALUE COUNT(1) … NOT IS_DEFINED(c.tid)` disclosure count, answered
 * with the real Cosmos shape (a bare scalar in `resources[0]`, not a document),
 * so a reader that mis-parses it reads 0 and the gap goes unreported.
 */
vi.mock('../cosmos-client', () => ({
  workspacesContainer: async () => ({
    items: {
      query: (spec: any, opts?: { partitionKey?: string }) => {
        const params: Record<string, unknown> = {};
        for (const p of spec?.parameters || []) params[p.name] = p.value;
        seen.wsQueries.push({ query: String(spec?.query || ''), params, partitionKey: opts?.partitionKey });
        const q = String(spec?.query || '');
        if (/NOT\s+IS_DEFINED\(c\.tid\)/i.test(q)) {
          return {
            fetchAll: async () => ({ resources: [WS_DOCS.filter((w) => w.tid === undefined).length] }),
          };
        }
        let rows = WS_DOCS;
        if (/c\.tid\s*=\s*@tid/.test(q)) rows = rows.filter((w) => w.tid === params['@tid']);
        if (/c\.tenantId\s*=\s*@t\b/.test(q)) rows = rows.filter((w) => w.tenantId === params['@t']);
        if (opts?.partitionKey !== undefined) rows = rows.filter((w) => w.tenantId === opts.partitionKey);
        return { fetchAll: async () => ({ resources: rows.map((w) => ({ id: w.id, domain: w.domain })) }) };
      },
    },
  }),
  itemsContainer: async () => ({
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [
            { w: 'ws-a', n: 3 },
            { w: 'ws-o', n: 5 },
            { w: 'ws-l', n: 2 },
          ],
        }),
      }),
    },
  }),
  workspaceRolesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));

let unityConfigured = true;
let purviewConfigured = true;
vi.mock('../unified-domain-mapper', () => ({
  unityName: (id: string) => (id || 'domain').toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'domain',
  unityLinkStatus: async () => (unityConfigured
    ? { configured: true, catalogs: ['dept'], schemasByCatalog: { dept: ['agency', 'office'] } }
    : { configured: false, catalogs: [], schemasByCatalog: {}, hint: 'set LOOM_DATABRICKS_HOSTNAME' }),
}));
vi.mock('../purview-client', () => ({
  isPurviewConfigured: () => purviewConfigured,
  domainCollectionName: (id: string) => (id || 'domain').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 36),
}));

import { getDomainMesh } from '../domain-mesh';
import { listTenantWorkspaceTags } from '@/lib/clients/workspaces-client';

describe('getDomainMesh (federated read)', () => {
  beforeEach(() => {
    unityConfigured = true;
    purviewConfigured = true;
    seen.domainsDocScope = [];
    seen.wsQueries = [];
  });

  // #3753 — the mesh route used to hand ONE value (the caller's raw `claims.oid`)
  // to both stores. The domains document is per-TENANT and #3282 moved
  // GET /api/admin/domains onto `tenantScopeId()`, so the oid-keyed read resolved
  // a PRIVATE, auto-seeded copy that silently disagreed with the authoritative
  // list. That separation still holds.
  it('addresses the domains doc by TENANT scope', async () => {
    await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    expect(seen.domainsDocScope).toEqual([TENANT_SCOPE]);
  });

  // #3747 — the load-bearing assertion. A partitionKey on the workspace read IS
  // the defect: it narrows a tenant-wide count to one creator's partition.
  it('reads workspaces TENANT-WIDE: predicate on tid, and NO partitionKey', async () => {
    await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    // Assert over the SCOPED read specifically, not over the total number of
    // queries: the disclosure count (`NOT IS_DEFINED(c.tid)`) is a second,
    // deliberate query and a bare length assertion would forbid it.
    const scoped = seen.wsQueries.filter((x) => /c\.tid\s*=\s*@tid/.test(x.query));
    expect(scoped).toHaveLength(1);
    const q = scoped[0];
    expect(q.query, 'still scoping by the creator-oid partition key').not.toMatch(/c\.tenantId/);
    expect(q.params['@tid']).toBe(CALLER_TID);
    // A cross-partition fan-out is exactly the absence of this option — on
    // EVERY query this counter issues, not just the scoped one.
    expect(
      seen.wsQueries.every((x) => x.partitionKey === undefined),
      'a partitionKey narrows the count to one creator',
    ).toBe(true);
  });

  it('counts workspaces from EVERY creator in the tenant, not just the caller', async () => {
    const mesh = await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    const byId = Object.fromEntries(mesh.rows.map((r) => [r.id, r]));
    // ws-a is the caller's; ws-o and ws-l belong to OTHER_OID. A per-creator
    // read would see only ws-a, so dept would roll up 1 workspace and lone 0.
    expect(byId.dept.rolledWorkspaces).toBe(2);
    expect(byId.lone.rolledWorkspaces).toBe(1);
  });

  it('both Domains panels derive from the SAME counter, so they cannot disagree', async () => {
    const mesh = await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    // The list route's workspaceCounts is this call, grouped by domain.
    const tags = await listTenantWorkspaceTags({ callerTid: CALLER_TID });
    const listCounts: Record<string, number> = {};
    for (const w of tags.workspaces) if (w.domain) listCounts[w.domain] = (listCounts[w.domain] || 0) + 1;
    const meshDirect = Object.fromEntries(
      mesh.rows.filter((r) => r.directWorkspaces).map((r) => [r.id, r.directWorkspaces]),
    );
    expect(listCounts).toEqual(meshDirect);
    expect(Object.values(listCounts).reduce((a, b) => a + b, 0)).toBe(WS_STAMPED.length);
  });

  /**
   * The regression the shared counter itself introduced (review of PR #4316).
   *
   * `listTenantWorkspaceTags` inherited `listAllWorkspacesAdmin`'s
   * `WHERE c.tid = @tid` predicate but not its legacy disclosure, so an estate
   * with pre-rel-T11 records answered `degraded:false, degradedReasons:[]` and
   * the mesh turned that into `configured:true` with a `total` it had not
   * established was complete. /admin/workspaces showed "N record(s) excluded"
   * for the same container while both Domains surfaces showed a shorter number
   * silently — a NEW cross-surface disagreement, created by the fix whose whole
   * purpose was that the panels cannot drift apart.
   */
  it('discloses workspace records it could not attribute, instead of reporting a short count as complete', async () => {
    const tags = await listTenantWorkspaceTags({ callerTid: CALLER_TID });
    const unstamped = WS_DOCS.filter((w) => w.tid === undefined).length;
    expect(unstamped, 'fixture must contain a legacy record or this proves nothing').toBeGreaterThan(0);

    // The count travels with the answer …
    expect(tags.legacyUnstampedExcluded).toBe(unstamped);
    // … the answer is not claimed to be complete …
    expect(tags.degraded).toBe(true);
    expect(tags.degradedReasons).toContain('legacy-unstamped-excluded');
    // … it is still a SCOPED answer, not a refusal (the mesh must not zero out) …
    expect(tags.scopeUnconfirmed).toBe(false);
    expect(tags.workspaces).toHaveLength(WS_STAMPED.length);
    // … and it names the same remediation /admin/workspaces names.
    expect(tags.legacyRemediation).toMatch(/backfill-workspace-tid\.mjs/);
  });

  it('carries that disclosure onto the mesh panel, without zeroing the rollup', async () => {
    const mesh = await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    expect(mesh.surfaces.catalog.configured, 'an incomplete count is not an unscoped one').toBe(true);
    expect(mesh.surfaces.catalog.workspaces).toBe(WS_STAMPED.length);
    expect(mesh.surfaces.catalog.legacyUnstampedExcluded).toBe(
      WS_DOCS.filter((w) => w.tid === undefined).length,
    );
    expect(mesh.surfaces.catalog.hint).toMatch(/backfill-workspace-tid\.mjs/);
  });

  it('reports ZERO excluded — and no hint — on an estate where every record is stamped', async () => {
    const legacy = WS_DOCS.filter((w) => w.tid === undefined);
    for (const w of legacy) w.tid = CALLER_TID; // stamp them, as the backfill would
    try {
      const tags = await listTenantWorkspaceTags({ callerTid: CALLER_TID });
      expect(tags.legacyUnstampedExcluded).toBe(0);
      expect(tags.degraded, 'a complete answer must not report itself degraded').toBe(false);
      expect(tags.degradedReasons).toEqual([]);
      expect(tags.legacyRemediation).toBeUndefined();
      const mesh = await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
      expect(mesh.surfaces.catalog.legacyUnstampedExcluded).toBe(0);
      expect(mesh.surfaces.catalog.hint, 'a hint on a complete count is a false warning').toBeUndefined();
      expect(mesh.surfaces.catalog.workspaces).toBe(WS_DOCS.length);
    } finally {
      for (const w of legacy) delete w.tid;
    }
  });

  it('fails CLOSED on a session with no tid — empty rollup with a named hint, never unscoped', async () => {
    const mesh = await getDomainMesh(TENANT_SCOPE, undefined, 'me');
    expect(seen.wsQueries, 'an unscoped workspace read was issued').toHaveLength(0);
    expect(mesh.surfaces.catalog.configured).toBe(false);
    expect(mesh.surfaces.catalog.hint).toMatch(/tid/);
    expect(mesh.rows.every((r) => r.rolledWorkspaces === 0)).toBe(true);
  });

  it('rolls catalog workspaces + items up the whole subtree', async () => {
    const mesh = await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    const byId = Object.fromEntries(mesh.rows.map((r) => [r.id, r]));

    // office (leaf): only its own ws + items (ws-o = 5 items).
    expect(byId.office.rolledWorkspaces).toBe(1);
    expect(byId.office.rolledItems).toBe(5);
    // agency: its own ws-a (3 items) + office's ws-o (5 items) = 2 ws / 8 items.
    expect(byId.agency.rolledWorkspaces).toBe(2);
    expect(byId.agency.rolledItems).toBe(8);
    // dept (root): whole subtree = agency(ws-a) + office(ws-o) = 2 ws / 8 items.
    expect(byId.dept.rolledWorkspaces).toBe(2);
    expect(byId.dept.rolledItems).toBe(8);
    // lone: independent (ws-l = 2 items).
    expect(byId.lone.rolledWorkspaces).toBe(1);
    expect(byId.lone.rolledItems).toBe(2);
  });

  it('maps a deep descendant onto its ROOT ancestor UC catalog', async () => {
    const mesh = await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    const office = mesh.rows.find((r) => r.id === 'office')!;
    // office is level 3; its UC target is a schema under the ROOT (dept) catalog.
    expect(office.unity.target).toBe('dept.office');
    expect(office.unity.present).toBe(true);
    expect(office.depth).toBe(3);
  });

  it('lineage is traceable when a source is configured AND the domain has assets', async () => {
    const mesh = await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    // Both sources on → lineage active, listing both.
    expect(mesh.surfaces.lineage.configured).toBe(true);
    expect(mesh.surfaces.lineage.sources).toEqual(['Purview Data Map', 'Unity Catalog']);
    const dept = mesh.rows.find((r) => r.id === 'dept')!;
    expect(dept.lineage.present).toBe(true); // dept has rolled-up assets
  });

  it('honest-gates every surface when the back-end is unconfigured', async () => {
    unityConfigured = false;
    purviewConfigured = false;
    const mesh = await getDomainMesh(TENANT_SCOPE, CALLER_TID, 'me');
    expect(mesh.surfaces.unity.configured).toBe(false);
    expect(mesh.surfaces.unity.hint).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
    expect(mesh.surfaces.purview.configured).toBe(false);
    expect(mesh.surfaces.purview.hint).toMatch(/LOOM_PURVIEW_ACCOUNT/);
    // No lineage source configured → lineage honest-gated too.
    expect(mesh.surfaces.lineage.configured).toBe(false);
    expect(mesh.surfaces.lineage.sources).toEqual([]);
    const dept = mesh.rows.find((r) => r.id === 'dept')!;
    expect(dept.unity.present).toBe(false);
    expect(dept.purview.present).toBe(false);
    expect(dept.lineage.present).toBe(false);
    // Catalog still works (Cosmos), so the rollup is unaffected by the gates.
    expect(dept.rolledWorkspaces).toBe(2);
  });
});
