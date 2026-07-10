/**
 * Vitest specs for the whole-hierarchy domain reconciler (lib/azure/domain-sync).
 *
 * Verifies:
 *   - dry run computes mirrored vs missing per target against probed remote state.
 *   - apply upserts every domain (roots before subdomains) and never deletes.
 *   - drift: a remote collection / a schema under a Loom-managed catalog with no
 *     matching Loom domain is REPORTED, never deleted.
 *   - both targets unconfigured → skipped + honest hints, never throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return { ManagedIdentityCredential: FakeCred, DefaultAzureCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

// Cosmos is only touched by save/load status — not by runDomainSync. A minimal
// stub keeps the import graph resolvable.
vi.mock('../cosmos-client', () => ({
  tenantSettingsContainer: async () => ({
    items: { upsert: async () => ({}) },
    item: () => ({ read: async () => ({ resource: undefined }) }),
  }),
}));

const DOMAINS = [
  { id: 'finance', name: 'Finance', createdAt: '', createdBy: '' },
  { id: 'operations', name: 'Operations', createdAt: '', createdBy: '' },
  { id: 'people', name: 'People', parentId: 'operations', createdAt: '', createdBy: '' },
];

vi.mock('../domain-registry', () => ({
  loadOrSeedDomains: async () => ({ id: 'domains:t', tenantId: 't', kind: 'domains', items: DOMAINS, updatedAt: '' }),
}));

const upsertCalls: any[] = [];
vi.mock('../unified-domain-mapper', () => ({
  unityName: (id: string) => (id || 'domain').toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'domain',
  mirrorDomainUpsert: async (spec: any) => {
    upsertCalls.push(spec.id);
    const isSub = !!spec.parentId;
    const catalog = isSub ? spec.parentId.replace(/-/g, '_') : spec.id.replace(/-/g, '_');
    const schema = isSub ? spec.id.replace(/-/g, '_') : undefined;
    return {
      purview: { ok: true, purviewId: spec.id, detail: 'ok' },
      unity: { ok: true, catalog, schema, detail: 'ok' },
    };
  },
}));

class PurviewNotConfiguredError extends Error {}
class PurviewError extends Error { status: number; constructor(s: number) { super('e'); this.status = s; } }

let purviewConfigured = true;
let unityConfigured = true;
vi.mock('../purview-client', () => ({
  isPurviewConfigured: () => purviewConfigured,
  domainCollectionName: (id: string) => (id || 'domain').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 36),
  listCollections: async () => [
    { name: 'root' }, // the root collection (no parentCollection)
    { name: 'finance', parentCollection: 'root' },
    { name: 'orphan-col', parentCollection: 'root' }, // no Loom domain → drift
  ],
  PurviewNotConfiguredError,
  PurviewError,
}));

vi.mock('../databricks-client', () => ({
  databricksConfigGate: () => (unityConfigured ? null : { missing: 'LOOM_DATABRICKS_HOSTNAME' }),
  listUcCatalogs: async () => [{ name: 'finance' }, { name: 'operations' }],
  // 'people' matches the Loom subdomain; 'legacy' under managed catalog → drift.
  listUcSchemas: async (cat: string) => (cat === 'operations' ? [{ name: 'people' }, { name: 'legacy' }] : []),
}));

describe('domain-sync reconciler', () => {
  beforeEach(() => { upsertCalls.length = 0; purviewConfigured = true; unityConfigured = true; vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('dry run computes mirrored vs missing per target and reports drift', async () => {
    const { runDomainSync } = await import('../domain-sync');
    const res = await runDomainSync('t', 'me', { apply: false });

    expect(res.applied).toBe(false);
    expect(res.domainCount).toBe(3);
    expect(upsertCalls).toEqual([]); // dry run mutates nothing

    const byId = Object.fromEntries(res.rows.map((r) => [r.id, r]));
    expect(byId.finance.purview.state).toBe('mirrored');
    expect(byId.operations.purview.state).toBe('missing');
    expect(byId.people.purview.state).toBe('missing');

    expect(byId.finance.unity.state).toBe('mirrored'); // catalog present
    expect(byId.operations.unity.state).toBe('mirrored'); // catalog present
    expect(byId.people.unity.state).toBe('mirrored'); // schema operations.people present

    // Drift: an unmanaged Purview collection + an unmanaged UC schema, never deleted.
    const driftNames = res.drift.map((d) => `${d.target}:${d.name}`);
    expect(driftNames).toContain('purview:orphan-col');
    expect(driftNames).toContain('unity:operations.legacy');
    expect(driftNames).not.toContain('purview:root'); // the root collection is never drift
  });

  it('apply upserts every domain roots-first and never deletes', async () => {
    const { runDomainSync } = await import('../domain-sync');
    const res = await runDomainSync('t', 'me', { apply: true });

    expect(res.applied).toBe(true);
    expect(upsertCalls.length).toBe(3);
    // Roots (finance, operations) come before the subdomain (people).
    expect(upsertCalls.indexOf('people')).toBeGreaterThan(upsertCalls.indexOf('operations'));
    expect(res.rows.every((r) => r.purview.state === 'created' && r.unity.state === 'created')).toBe(true);
  });

  it('both targets unconfigured → skipped + honest hints, never throws', async () => {
    purviewConfigured = false;
    unityConfigured = false;
    const { runDomainSync } = await import('../domain-sync');
    const res = await runDomainSync('t', 'me', { apply: true });

    expect(res.purview.configured).toBe(false);
    expect(res.unity.configured).toBe(false);
    expect(res.purview.hint).toBeTruthy();
    expect(res.unity.hint).toBeTruthy();
    expect(res.rows.every((r) => r.purview.state === 'skipped' && r.unity.state === 'skipped')).toBe(true);
    expect(upsertCalls).toEqual([]); // nothing to apply when no target configured
    expect(res.drift).toEqual([]);
  });
});
