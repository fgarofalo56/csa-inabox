/**
 * LU-7 — the PUBLISH path and the SERVE path must compile the SAME document.
 *
 * This drives the REAL `reconcilePolicyCode` (with Cosmos / Trino / Graph
 * mocked) and compares the version it actually publishes against the version
 * the engine-rules route would compute for the same policy set and environment.
 *
 * ## Why this test exists in this shape
 *
 * A pure "the hashes agree" test over `buildTrinoRulesDocument` passes even
 * while the divergence is live, because it feeds BOTH sides the same options by
 * construction. The defect was that reconcile built its option object by hand
 * (`{ ucVariant, tenantId }`) and dropped `trinoDefaultCatalog`, so it was the
 * CALL SITE that diverged, not the compiler. Only invoking the real function
 * observes that.
 *
 * Measured effect of the bug, under `LOOM_TRINO_ICEBERG_CATALOG=lake` with a
 * 2-part `sales.orders` resource:
 *   publish → {"catalog":"^iceberg$"}   serve → {"catalog":"^lake$"}
 * Permanent `stale`, reconcile never reports applied, the hedged detail
 * resolves to the false "the engine cannot reach the Console" claim — and the
 * engine governs `lake.sales.orders` while the document an admin inspects says
 * `iceberg.sales.orders`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks: the Azure edges reconcile touches ────────────────────────────────
const upserted: any[] = [];
const store = new Map<string, any>();

vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: async () => ({
    item: (id: string) => ({
      read: async () => ({ resource: store.get(id) }),
    }),
    items: {
      upsert: async (doc: any) => {
        upserted.push(doc);
        store.set(doc.id, doc);
        return { resource: doc };
      },
    },
  }),
  auditLogContainer: async () => ({ items: { upsert: async () => ({}) } }),
}));

vi.mock('@/lib/azure/uc-backend', () => ({
  resolveUcBackend: () => 'oss' as const,
  isOssUc: () => true,
  ossUcBase: () => 'https://loom-unity.internal',
}));

// The engine is present and un-sealed, so the trino backend is not gated.
vi.mock('@/lib/azure/trino-client', () => ({
  trinoConfigGate: () => null,
  isTrinoSealed: () => false,
}));

// No group principals in this policy set, but the import must resolve.
vi.mock('@/lib/azure/graph-identity-client', () => ({
  getGroupTransitiveMembers: async () => [],
}));

import { reconcilePolicyCode } from '../reconcile';
import { normalizePolicyCodeSet } from '../dsl';
import {
  compileTrino,
  buildTrinoRulesDocument,
  rulesVersion,
  trinoCompileOptionsFromEnv,
} from '../compilers/trino';

/** A deliberately 2-PART resource — it resolves against the lake catalog. */
const TWO_PART_SET = normalizePolicyCodeSet({
  apiVersion: 'loom.governance/v1',
  name: 'two-part',
  statements: [{
    id: 's1',
    principals: [{ kind: 'user', id: 'u1', name: 'alice@contoso.com' }],
    resources: [{ backend: 'trino', object: 'sales.orders' }],
    actions: ['read'],
    condition: { rowFilter: '[Region] = USERPRINCIPALNAME()', maskColumns: ['ssn'] },
  }],
});

const TENANT = 'tenant-1';

/** What the engine-rules route computes for the SAME set + environment. */
function serveSideVersion() {
  const docOptions = {
    ...trinoCompileOptionsFromEnv(),
    trinoGroupProvider: false,
    // The entrypoint always sends its wired catalog list.
    catalogs: [
      { name: 'system', allow: 'read-only' as const },
      { name: 'jmx', allow: 'read-only' as const },
      { name: 'memory', allow: 'all' as const },
      { name: (process.env.LOOM_TRINO_ICEBERG_CATALOG || 'iceberg'), allow: 'read-only' as const },
    ],
  };
  return rulesVersion(buildTrinoRulesDocument(compileTrino(TWO_PART_SET, docOptions), docOptions));
}

function publishedDoc() {
  return upserted.filter((d) => d.kind === 'trino-engine-rules').at(-1);
}

beforeEach(() => {
  upserted.length = 0;
  store.clear();
  delete process.env.LOOM_TRINO_ICEBERG_CATALOG;
  delete process.env.LOOM_TRINO_SESSION_USER;
});

afterEach(() => {
  delete process.env.LOOM_TRINO_ICEBERG_CATALOG;
  delete process.env.LOOM_TRINO_SESSION_USER;
});

describe('reconcilePolicyCode → Trino: publish and serve compile the same document', () => {
  it('agrees under a NON-DEFAULT lake catalog with a 2-part resource', async () => {
    // THE regression. With the bug, publish compiled `iceberg.sales.orders`
    // and serve compiled `lake.sales.orders` — versions could never converge.
    process.env.LOOM_TRINO_ICEBERG_CATALOG = 'lake';

    await reconcilePolicyCode(TWO_PART_SET, { apply: true, tenantId: TENANT, updatedBy: 'test' });

    const doc = publishedDoc();
    expect(doc).toBeDefined();
    expect(doc.version).toBe(serveSideVersion());
  });

  it('the published document names the DEPLOYMENT lake, not the code default', async () => {
    process.env.LOOM_TRINO_ICEBERG_CATALOG = 'lake';
    await reconcilePolicyCode(TWO_PART_SET, { apply: true, tenantId: TENANT, updatedBy: 'test' });

    const rule = publishedDoc().rules.tables.find((r: any) => r.user === '^alice@contoso\\.com$');
    expect(rule.catalog).toBe('^lake$');
    // The control and the document an admin inspects must name the same table.
    expect(rule.catalog).not.toBe('^iceberg$');
  });

  it('agrees on the DEFAULT deployment too (no env set)', async () => {
    await reconcilePolicyCode(TWO_PART_SET, { apply: true, tenantId: TENANT, updatedBy: 'test' });
    expect(publishedDoc().version).toBe(serveSideVersion());
  });

  it('carries the session user through to the impersonation rule', async () => {
    process.env.LOOM_TRINO_ICEBERG_CATALOG = 'lake';
    process.env.LOOM_TRINO_SESSION_USER = 'svc-loom';
    await reconcilePolicyCode(TWO_PART_SET, { apply: true, tenantId: TENANT, updatedBy: 'test' });

    expect(publishedDoc().rules.impersonation[0].original_user).toBe('^svc-loom$');
    expect(publishedDoc().version).toBe(serveSideVersion());
  });

  it('the row filter and the column mask both reach the published document', async () => {
    process.env.LOOM_TRINO_ICEBERG_CATALOG = 'lake';
    await reconcilePolicyCode(TWO_PART_SET, { apply: true, tenantId: TENANT, updatedBy: 'test' });

    const rule = publishedDoc().rules.tables.find((r: any) => r.user === '^alice@contoso\\.com$');
    expect(rule.filter).toBe('"Region" = current_user');
    expect(rule.columns).toEqual([{ name: 'ssn', mask: 'NULL' }]);
  });

  it('stores the policy projection with an EMPTY catalog section', async () => {
    // The stored doc is not a servable artifact — the route renders the catalog
    // section around the list the engine reports at fetch time. Persisting a
    // placeholder would record a catalog rule the engine is never served.
    process.env.LOOM_TRINO_ICEBERG_CATALOG = 'lake';
    await reconcilePolicyCode(TWO_PART_SET, { apply: true, tenantId: TENANT, updatedBy: 'test' });
    expect(publishedDoc().rules.catalogs).toEqual([]);
  });
});
