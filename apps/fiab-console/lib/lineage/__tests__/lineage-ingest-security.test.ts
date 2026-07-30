/**
 * LU-8 — SECURITY SPECS for the OpenLineage INGEST path. Every case is an
 * ATTACK, not a happy path.
 *
 * Scope note (round 4): this PR was reduced to the ingest/identity half of LU-8
 * — the shared canonical-naming module, the extracted dataset->item resolver,
 * the shared denial audit, and `POST /api/lineage/openlineage` itself. The two
 * Synapse emitters and their five polled routes moved to a follow-up PR, and the
 * specs that drive them moved with them. What stays here is everything the KEPT
 * production path can actually be attacked through:
 *
 *   1. a credential (SAS / userinfo) riding into a value Loom PERSISTS as a
 *      thread-edge endpoint or the denial audit's `target`, and RENDERS as a
 *      canvas node label;
 *   2. an ownership CLAIM widening itself so a foreign dataset resolves to a
 *      local owner — which short-circuits the cross-workspace forgery probe and
 *      turns a would-be 403 into an allow;
 *   3. the forgery probe failing to fire because the two sides of the
 *      comparison were spelled differently.
 *
 * Each spec asserts the DENIAL. A spec proving a legitimate write succeeds
 * proves nothing about any of these. The route-level end-to-end cases live in
 * `app/api/lineage/openlineage/__tests__/denial-audit-strip.test.ts`; the
 * hostile-input budget guards live in `lineage-security-r3.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => {
  class UnityCatalogNotConfiguredError extends Error {}
  class UnityCatalogError extends Error { status = 500; }
  class PurviewNotConfiguredError extends Error {}
  class PurviewError extends Error { status = 500; }
  return { UnityCatalogNotConfiguredError, UnityCatalogError, PurviewNotConfiguredError, PurviewError };
});

const mocks = vi.hoisted(() => ({
  queryItems: vi.fn((_q: string) => ({ resources: [] as any[] })),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  // The resolver runs TWO different queries against `items`: the
  // workspace-scoped candidate load (`WHERE c.workspaceId = @w`) and the
  // cross-workspace forgery probe (`WHERE c.workspaceId != @w`). Dispatch on the
  // query text, not on call order, so a spec cannot pass by accident.
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({ fetchAll: async () => mocks.queryItems(String(spec?.query || '')) }),
    },
  }),
  auditLogContainer: async () => ({ items: { create: async (d: any) => ({ resource: d }) } }),
  workspacesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [{ tenantId: 'owner-1' }] }) }) },
  }),
}));

vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/thread/thread-edges', () => ({
  recordThreadEdge: vi.fn(async () => {}),
  listThreadEdges: vi.fn(async () => []),
}));
vi.mock('@/lib/azure/purview-client', () => ({
  getLineageSubgraph: vi.fn(),
  isPurviewConfigured: vi.fn(() => false),
  PurviewNotConfiguredError: H.PurviewNotConfiguredError,
  PurviewError: H.PurviewError,
}));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  getTableLineage: vi.fn(),
  getTableLineageSystemTables: vi.fn(),
  getColumnLineageSystemTables: vi.fn(),
  lineageWarehouseId: vi.fn(() => null),
  listWorkspaceHostnames: vi.fn(() => { throw new H.UnityCatalogNotConfiguredError('uc off'); }),
  UnityCatalogNotConfiguredError: H.UnityCatalogNotConfiguredError,
  UnityCatalogError: H.UnityCatalogError,
}));
vi.mock('@/lib/azure/asset-identity', () => ({
  resolveAssetIdentities: vi.fn(async (i: any) => i),
  storagePathIdentity: vi.fn(() => undefined),
}));

import {
  canonicalStorageUri,
  parseStorageUri,
  stripUriCredentials,
} from '@/lib/lineage/dataset-naming';
import { statePaths, resolveOwner, findForeignOwner } from '@/lib/lineage/dataset-item-resolver';
import { normalizeIdentity } from '@/lib/azure/unified-lineage';
import { datasetUri } from '@/lib/azure/openlineage-ingest';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryItems.mockImplementation(() => ({ resources: [] }));
});

// ===========================================================================
// 1. SAS TOKEN / CREDENTIAL LEAK
// ===========================================================================

describe('ATTACK: a SAS token must never reach the persisted lineage store', () => {
  const SAS = 'https://stloom.blob.core.windows.net/data/silver/sales?sv=2021-08-06&st=2026-01-01&sig=SUPERSECRETSIGNATURE%3D';
  const SAS_ABFSS = 'abfss://data@stloom.dfs.core.windows.net/silver/sales?sv=2021-08-06&sig=SUPERSECRETSIGNATURE';

  it('strips the query string from the canonical identity (https and abfss spellings)', () => {
    expect(canonicalStorageUri(SAS)).toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(canonicalStorageUri(SAS_ABFSS)).toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(parseStorageUri(SAS)!.path).toBe('silver/sales');
    for (const v of [canonicalStorageUri(SAS), canonicalStorageUri(SAS_ABFSS), normalizeIdentity(SAS)]) {
      expect(v).not.toMatch(/sig=/i);
      expect(v).not.toMatch(/supersecret/i);
    }
  });

  it('strips the query string on the NON-Azure fallback path too (nothing passes through raw)', () => {
    // s3 is not parseable as Azure storage — the fallback used to return the
    // raw string, query and all.
    const s3 = 's3://bucket/key?X-Amz-Signature=DEADBEEF';
    expect(canonicalStorageUri(s3)).toBe('s3://bucket/key');
    expect(normalizeIdentity(s3)).not.toMatch(/signature/i);
  });

  it('strips URI userinfo — a password must not be smuggled into the account slot', () => {
    const withCreds = 'https://user:hunter2@stloom.dfs.core.windows.net/data/silver';
    expect(stripUriCredentials(withCreds)).toBe('https://stloom.dfs.core.windows.net/data/silver');
    expect(canonicalStorageUri(withCreds)).toBe('abfss://data@stloom.dfs.core.windows.net/silver');
    expect(canonicalStorageUri(withCreds)).not.toMatch(/hunter2/);
    // …and the abfss `container@account` form, which is NOT userinfo, survives.
    expect(canonicalStorageUri('abfss://data@stloom.dfs.core.windows.net/silver'))
      .toBe('abfss://data@stloom.dfs.core.windows.net/silver');
  });

  it('refuses to treat a credential pair as an account name', () => {
    // `[^./]+` would happily capture `user:p%40ss@stloom` as the account.
    expect(parseStorageUri('abfss://data@user:p%40ss@stloom.dfs.core.windows.net/silver')).toBeNull();
  });

  it('a SAS arriving as an OpenLineage {namespace, name} pair is stripped at the join', () => {
    // The ingest producer's own entry point: `datasetUri` joins the pair, and
    // whatever it returns is what the resolver prefix-matches, the audit door
    // records, and `normalizeIdentity` turns into a rendered node id.
    const joined = datasetUri({
      namespace: 'abfss://data@stloom.dfs.core.windows.net',
      name: `/silver/sales?${'sv=2021-08-06&sig=SUPERSECRETSIGNATURE'}`,
    });
    expect(normalizeIdentity(joined)).toBe('path:abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(normalizeIdentity(joined)).not.toMatch(/supersecret/i);
  });
});

// ===========================================================================
// 2. OWNERSHIP-CLAIM WIDENING  (a resolved LOCAL owner suppresses the probe)
// ===========================================================================

describe('ATTACK: a folded ownership claim must not swallow sibling datasets', () => {
  it('an item rooted at a part-file folder does NOT claim the parent folder', () => {
    // foldToTableFolder('warehouses/part-a') === 'warehouses'. If that fold were
    // applied to the CLAIM, this item would own every dataset under
    // /warehouses — including other teams' — and, because a resolved local
    // owner short-circuits the foreign probe, a would-be 403 would become an
    // allow.
    const claim = statePaths({ adlsRoot: 'abfss://data@stloom.dfs.core.windows.net/warehouses/part-a' });
    expect(claim).toEqual(['abfss://data@stloom.dfs.core.windows.net/warehouses/part-a']);

    const item = { id: 'i1', workspaceId: 'ws1', itemType: 'lakehouse', paths: claim };
    // A sibling under the PARENT folder must not resolve to it.
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/warehouses/other-team', [item])).toBeNull();
    // Its own subtree still does.
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/warehouses/part-a/f.parquet', [item])?.id).toBe('i1');
  });
});

// ===========================================================================
// 3. THE FORGERY PROBE MUST FIRE ACROSS SPELLINGS
// ===========================================================================

describe('ATTACK: a dataset owned by ANOTHER workspace must be found however it is spelled', () => {
  it('the foreign probe still matches across spellings after canonicalization', async () => {
    // The extraction folded BOTH sides through canonicalStorageUri. Prove the
    // probe still fires when the foreign item stored the https spelling and the
    // incoming URI is abfss (the case that previously silently missed).
    mocks.queryItems.mockReturnValue({
      resources: [{ id: 'foreign', workspaceId: 'ws2', itemType: 'lakehouse',
        state: { adlsRoot: 'https://stother.dfs.core.windows.net/secret/finance' } }],
    } as any);
    const hit = await findForeignOwner('abfss://secret@stother.dfs.core.windows.net/finance/payroll/_delta_log', 'ws1');
    expect(hit?.workspaceId).toBe('ws2');
    // …and does NOT fire on a prefix look-alike (no false 403 / no false owner).
    const miss = await findForeignOwner('abfss://secret@stother.dfs.core.windows.net/finance-archive/x', 'ws1');
    expect(miss).toBeNull();
  });
});

// ===========================================================================
// 4. ONELAKE identities must not be silently re-keyed
// ===========================================================================

describe('OneLake keeps its own spelling', () => {
  it('is not folded into a fabricated container@account identity', () => {
    const ol = 'https://onelake.dfs.fabric.microsoft.com/wsid/lhid/Tables/sales';
    expect(parseStorageUri(ol)).toBeNull();
    // The pre-existing OneLake join key is preserved (the workspace GUID is NOT
    // fabricated into a container slot).
    expect(normalizeIdentity(ol)).toBe(`path:${ol.toLowerCase()}`);
  });
});
