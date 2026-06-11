/**
 * Vitest specs for the unified-domain mapper — one Loom domain written through
 * to BOTH Microsoft Purview (collection) and Databricks Unity Catalog
 * (catalog/schema), each independently optional and NO Fabric dependency.
 *
 * Verifies:
 *   - unityName() maps a Loom id to a valid UC identifier.
 *   - upsert mirrors a root domain → UC catalog + Purview collection.
 *   - upsert mirrors a subdomain → UC schema under the parent's catalog.
 *   - both back-ends unconfigured → both outcomes `skipped:true` (never throws).
 *   - move reparents Purview but reports unity.moveSupported=false (UC has no move).
 *   - a UC "already exists" error is treated as success (idempotent mirror).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return { ManagedIdentityCredential: FakeCred, DefaultAzureCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

const purviewCalls: any[] = [];
const unityCalls: any[] = [];

vi.mock('../purview-client', () => ({
  isPurviewConfigured: () => !!process.env.LOOM_PURVIEW_ACCOUNT,
  domainCollectionName: (idOrName: string) =>
    (idOrName || 'domain').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 36) || 'domain',
  createBusinessDomain: async (body: any) => { purviewCalls.push(['create', body]); return { id: `col-${body.id}` }; },
  updateBusinessDomain: async (id: string, body: any) => { purviewCalls.push(['update', id, body]); return { id }; },
  deleteBusinessDomain: async (id: string) => { purviewCalls.push(['delete', id]); },
}));

vi.mock('../databricks-client', () => ({
  databricksConfigGate: () => (process.env.LOOM_DATABRICKS_HOSTNAME ? null : { missing: 'LOOM_DATABRICKS_HOSTNAME' }),
  createUcCatalog: async (spec: any) => {
    unityCalls.push(['createCatalog', spec]);
    // Sentinel: a domain id of 'dup' simulates a pre-existing UC catalog (409).
    if (spec.name === 'dup') throw new Error('Catalog already exists (RESOURCE_ALREADY_EXISTS)');
    return { name: spec.name };
  },
  createUcSchema: async (spec: any) => { unityCalls.push(['createSchema', spec]); return { name: spec.name }; },
  patchUcCatalog: async (name: string, patch: any) => { unityCalls.push(['patchCatalog', name, patch]); return { name }; },
  patchUcSchema: async (fullName: string, patch: any) => { unityCalls.push(['patchSchema', fullName, patch]); return { name: fullName }; },
  deleteUcCatalog: async (name: string) => { unityCalls.push(['deleteCatalog', name]); },
  deleteUcSchema: async (fullName: string) => { unityCalls.push(['deleteSchema', fullName]); },
  listUcCatalogs: async () => [{ name: 'finance' }, { name: 'operations' }],
  listUcSchemas: async (cat: string) => (cat === 'operations' ? [{ name: 'people' }] : []),
}));

describe('unified-domain-mapper', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    purviewCalls.length = 0;
    unityCalls.length = 0;
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.azuredatabricks.net';
    vi.resetModules();
  });
  afterEach(() => { process.env = { ...ORIG }; vi.restoreAllMocks(); });

  it('unityName maps a Loom id to a valid UC identifier', async () => {
    const { unityName } = await import('../unified-domain-mapper');
    expect(unityName('sales-marketing')).toBe('sales_marketing');
    expect(unityName('123abc')).toBe('d_123abc'); // may not start with a digit
    expect(unityName('')).toBe('domain');
  });

  it('create mirrors a root domain to a UC catalog + a Purview collection', async () => {
    const { mirrorDomainUpsert } = await import('../unified-domain-mapper');
    const res = await mirrorDomainUpsert({ id: 'finance', name: 'Finance', description: 'Money' }, 'create');
    expect(res.purview.ok).toBe(true);
    expect(res.unity.ok).toBe(true);
    expect(res.unity.catalog).toBe('finance');
    expect(unityCalls.find((c) => c[0] === 'createCatalog')[1].name).toBe('finance');
    expect(purviewCalls.find((c) => c[0] === 'create')).toBeTruthy();
  });

  it('create mirrors a subdomain to a UC schema under the parent catalog', async () => {
    const { mirrorDomainUpsert } = await import('../unified-domain-mapper');
    const res = await mirrorDomainUpsert({ id: 'people', name: 'People', parentId: 'operations' }, 'create');
    expect(res.unity.catalog).toBe('operations');
    expect(res.unity.schema).toBe('people');
    const call = unityCalls.find((c) => c[0] === 'createSchema');
    expect(call[1]).toMatchObject({ name: 'people', catalog_name: 'operations' });
  });

  it('both back-ends unconfigured → both skipped, never throws', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    const { mirrorDomainUpsert } = await import('../unified-domain-mapper');
    const res = await mirrorDomainUpsert({ id: 'x', name: 'X' }, 'create');
    expect(res.purview.skipped).toBe(true);
    expect(res.unity.skipped).toBe(true);
    expect(purviewCalls).toHaveLength(0);
    expect(unityCalls).toHaveLength(0);
  });

  it('move reparents Purview but reports unity.moveSupported=false (UC has no move)', async () => {
    const { mirrorDomainMove } = await import('../unified-domain-mapper');
    const res = await mirrorDomainMove({ id: 'sub', name: 'Sub' }, 'finance');
    expect(res.purview.ok).toBe(true);
    expect(res.unity.moveSupported).toBe(false);
    // The Purview update carried the new parent collection slug.
    expect(purviewCalls.find((c) => c[0] === 'update')[2].parentId).toBe('finance');
    // No UC create/patch/delete happened on a move.
    expect(unityCalls).toHaveLength(0);
  });

  it('a UC "already exists" error is treated as a successful (idempotent) mirror', async () => {
    const { mirrorDomainUpsert } = await import('../unified-domain-mapper');
    const res = await mirrorDomainUpsert({ id: 'dup', name: 'Dup' }, 'create');
    expect(res.unity.ok).toBe(true);
  });

  it('unityLinkStatus reports configured catalogs + schemas', async () => {
    const { unityLinkStatus } = await import('../unified-domain-mapper');
    const st = await unityLinkStatus();
    expect(st.configured).toBe(true);
    expect(st.catalogs).toContain('finance');
    expect(st.schemasByCatalog.operations).toContain('people');
  });
});
