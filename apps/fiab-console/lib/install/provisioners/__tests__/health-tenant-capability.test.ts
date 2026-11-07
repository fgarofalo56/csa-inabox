/**
 * healthTenantProvisioner is fail-closed on health.tenant-admin (D12).
 *
 * PROVISIONERS entries run from the app installer and from deployment-pipeline
 * promotion with no capability gate of their own, so the provisioner enforces it.
 * The REAL checkCapability runs; only the grants store and the control-plane
 * client are faked. The session is an ordinary non-admin (no admin group, no
 * bootstrap oid); the D12 block at the end proves a Loom tenant admin is NOT
 * admitted without an explicit grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const grants = vi.hoisted(() => ({ rows: [] as any[] }));
const cpCalls = vi.hoisted(() => ({ n: 0, names: [] as string[] }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: grants.rows }) }) },
  }),
  itemsContainer: async () => ({
    item: () => ({
      read: async () => ({ resource: { id: 'item-1', workspaceId: 'ws-1', state: {} } }),
      replace: async () => ({}),
    }),
  }),
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/app/api/health/tenants/_lib/cp-client', async (orig) => {
  const real = await orig<typeof import('@/app/api/health/tenants/_lib/cp-client')>();
  const spy = (name: string) => async () => { cpCalls.n++; cpCalls.names.push(name); return null; };
  return {
    ...real,
    // Configured, so a call that gets past the gate would reach the (spied) control plane.
    readCpConfig: () => ({ baseUrl: 'https://cp', audience: 'api://cp' }),
    cp: { ...real.cp, getTenant: spy('getTenant'), listStamps: spy('listStamps'), createTenant: spy('createTenant'), submitJob: spy('submitJob') },
  };
});

import { healthTenantProvisioner } from '../health-tenant';

const session = (oid: string) => ({ claims: { oid, tid: 'tid-1', upn: `${oid}@x.y`, groups: [] } }) as any;
const run = (oid: string) => healthTenantProvisioner({
  session: session(oid), target: { mode: 'shared' }, cosmosItemId: 'item-1', workspaceId: 'ws-1',
  displayName: 'Mercy General', content: {}, appId: 'app-x',
} as any);

beforeEach(() => {
  grants.rows = []; cpCalls.n = 0; cpCalls.names = [];
  vi.stubEnv('LOOM_TENANT_ADMIN_GROUP_ID', '');
  vi.stubEnv('LOOM_TENANT_ADMIN_OID', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('healthTenantProvisioner capability gate', () => {
  it('a non-admin with NO grant: zero control-plane calls and a truthful denial naming the capability', async () => {
    const r = await run('plain-user');
    // Removing the gate makes cpCalls.n >= 1 (getTenant is the first call) and status stop being 'failed'.
    expect(cpCalls.n, `control plane was called: ${cpCalls.names.join(',')}`).toBe(0);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/health\.tenant-admin/);
    expect(r.error).toMatch(/forbidden/);
  });

  it('a Reader-only grant is not enough: Contributor is required (role boundary)', async () => {
    grants.rows = [{ capabilityId: 'health.tenant-admin', principalId: 'reader-user', role: 'Reader', tenantId: 'tid-1' }];
    const r = await run('reader-user');
    expect(cpCalls.n).toBe(0);
    expect(r.status).toBe('failed');
  });

  it('a session WITH a Contributor grant proceeds and reaches the control plane', async () => {
    grants.rows = [{ capabilityId: 'health.tenant-admin', principalId: 'granted-user', role: 'Contributor', tenantId: 'tid-1' }];
    await run('granted-user');
    // Breaks if the gate denies a granted user: getTenant is never reached and n stays 0.
    expect(cpCalls.names[0]).toBe('getTenant');
    expect(cpCalls.n).toBeGreaterThan(0);
  });
});

describe('D12: a Loom tenant admin does not inherit health.tenant-admin', () => {
  it('a Loom tenant admin (bootstrap oid) with NO health grant is denied and the control plane is never contacted', async () => {
    vi.stubEnv('LOOM_TENANT_ADMIN_OID', 'loom-admin');
    const r = await run('loom-admin');
    // Reintroducing the isTenantAdmin bypass makes cpCalls.n >= 1 and the status stop being 'failed'.
    expect(cpCalls.n, `control plane was called: ${cpCalls.names.join(',')}`).toBe(0);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/health\.tenant-admin/);
  });

  it('a Loom tenant admin WITH an explicit grant proceeds (the grant, not the admin role, is what admits)', async () => {
    vi.stubEnv('LOOM_TENANT_ADMIN_OID', 'loom-admin');
    grants.rows = [{ capabilityId: 'health.tenant-admin', principalId: 'loom-admin', role: 'Contributor', tenantId: 'tid-1' }];
    await run('loom-admin');
    expect(cpCalls.names[0]).toBe('getTenant');
  });

  it('a grant on an ANCESTOR (workload.admin) does not admit, even if the store returns it', async () => {
    // The fake store ignores the query filter and returns this row, as a loosened query would.
    grants.rows = [{ capabilityId: 'workload.admin', principalId: 'parent-user', role: 'Admin', tenantId: 'tid-1' }];
    const r = await run('parent-user');
    // Widening the match to the ancestor chain makes n >= 1.
    expect(cpCalls.n).toBe(0);
    expect(r.status).toBe('failed');
  });
});
