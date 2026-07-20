/**
 * BFF route test for POST /api/dab/[id]/apply-to-runtime (task #19).
 * Verifies the admin guard, honest gates, no-entities 409, and success shape.
 * The ARM client + item listing are mocked like sibling route tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-admin' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const isAdminMock = vi.fn(() => true);
vi.mock('@/lib/auth/domain-role', () => ({ isTenantAdminTier: (...a: any[]) => isAdminMock(...a) }));

const gateMock = vi.fn(() => null as null | { missing: string });
const targetMock = vi.fn(() => ({ baseUrl: 'https://dab-loom-xyz.happy.eastus.azurecontainerapps.io' }));
vi.mock('@/app/api/dab/_lib/dab-runtime', () => ({
  dabRuntimeGate: (...a: any[]) => gateMock(...a),
  dabRuntimeTarget: (...a: any[]) => targetMock(...a),
}));

const entity = (name: string) => ({
  name, source: { object: `gold.${name}`, type: 'table' }, rest: { enabled: true }, graphql: { enabled: true },
  permissions: [{ role: 'anonymous', actions: [{ action: 'read' }] }],
});
const dabConfig = (names: string[]) => ({
  sourceRef: { kind: 'mssql', database: 'loompool' },
  runtime: { rest: { enabled: true, path: '/api', requestBodyStrict: true }, graphql: { enabled: true, path: '/graphql', allowIntrospection: true }, host: { mode: 'development', corsOrigins: [], corsAllowCredentials: false, authProvider: 'Simulator' }, cache: { enabled: false, ttlSeconds: 5 }, pagination: { defaultPageSize: 100, maxPageSize: 100000 } },
  entities: names.map(entity),
});
const listOwnedItemsMock = vi.fn(async (..._a: any[]) => [
  { id: 'b', displayName: 'Orders REST API', state: { dabConfig: dabConfig(['Order', 'Customer']) } },
  { id: 'a', displayName: 'Sales GraphQL API', state: { dabConfig: dabConfig(['Product']) } },
] as any);
vi.mock('@/app/api/items/_lib/item-crud', () => ({ listOwnedItems: (...a: any[]) => listOwnedItemsMock(...a) }));

const updateContainerAppEnvMock = vi.fn(async (..._a: any[]) => ({ name: 'dab-loom-xyz', provisioningState: 'Updating', changed: [], secretsChanged: ['DAB_CONFIG_B64'] }));
vi.mock('@/lib/azure/container-apps-arm-client', () => {
  class AcaNotConfiguredError extends Error { constructor(public missing: string[]) { super('not configured'); this.name = 'AcaNotConfiguredError'; } }
  class AcaArmError extends Error { constructor(public status: number, _b?: unknown, msg?: string) { super(msg || 'arm'); this.name = 'AcaArmError'; } }
  return { updateContainerAppEnv: (...a: any[]) => updateContainerAppEnvMock(...a), AcaNotConfiguredError, AcaArmError };
});
import { AcaNotConfiguredError, AcaArmError } from '@/lib/azure/container-apps-arm-client';

import { POST } from '../route';
const ctx = (id = 'b') => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest('http://localhost/api/dab/b/apply-to-runtime', { method: 'POST' });

describe('dab apply-to-runtime route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({ claims: { oid: 'oid-admin' } } as any);
    isAdminMock.mockReturnValue(true);
    gateMock.mockReturnValue(null);
    targetMock.mockReturnValue({ baseUrl: 'https://dab-loom-xyz.happy.eastus.azurecontainerapps.io' });
    listOwnedItemsMock.mockResolvedValue([
      { id: 'b', displayName: 'Orders REST API', state: { dabConfig: dabConfig(['Order', 'Customer']) } },
      { id: 'a', displayName: 'Sales GraphQL API', state: { dabConfig: dabConfig(['Product']) } },
    ] as any);
    updateContainerAppEnvMock.mockResolvedValue({ name: 'dab-loom-xyz', provisioningState: 'Updating', changed: [], secretsChanged: ['DAB_CONFIG_B64'] });
  });

  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(401);
  });

  it('403 when caller is not a tenant admin', async () => {
    isAdminMock.mockReturnValue(false);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect(updateContainerAppEnvMock).not.toHaveBeenCalled();
  });

  it('503 honest gate when the preview runtime is unset', async () => {
    gateMock.mockReturnValue({ missing: 'LOOM_DAB_PREVIEW_URL' });
    const res = await POST(req(), ctx());
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.gate.missing).toBe('LOOM_DAB_PREVIEW_URL');
  });

  it('409 when no DAB entities are authored on any item', async () => {
    listOwnedItemsMock.mockResolvedValue([{ id: 'b', displayName: 'Empty', state: { dabConfig: dabConfig([]) } }] as any);
    const res = await POST(req(), ctx());
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('no_entities');
  });

  it('503 honest gate when the ACA/ARM target is unconfigured', async () => {
    updateContainerAppEnvMock.mockRejectedValue(new AcaNotConfiguredError(['LOOM_SUBSCRIPTION_ID', 'LOOM_ACA_RG (or LOOM_ADMIN_RG)']));
    const res = await POST(req(), ctx());
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.gate.missing).toContain('LOOM_SUBSCRIPTION_ID');
  });

  it('surfaces an ARM permission error as an honest gate (not a 500 leak)', async () => {
    updateContainerAppEnvMock.mockRejectedValue(new AcaArmError(403, undefined, 'forbidden'));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
  });

  it('merges all DAB items and applies to the shared runtime (success shape)', async () => {
    const res = await POST(req(), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.entitiesApplied).toEqual(['Product', 'Order', 'Customer']); // itemId 'a' sorts before 'b'
    expect(j.collisions).toEqual([]);
    expect(j.dabApp).toBe('dab-loom-xyz');
    expect(j.revisionState).toBe('Updating');
    // applied the merged config as the dab-config-b64 secret
    const [appName, changes, opts] = updateContainerAppEnvMock.mock.calls[0];
    expect(appName).toBe('dab-loom-xyz');
    expect(changes).toEqual({});
    expect(Object.keys(opts.secrets)).toEqual(['DAB_CONFIG_B64']);
    const decoded = Buffer.from(opts.secrets.DAB_CONFIG_B64, 'base64').toString('utf-8');
    expect(decoded).toContain('Order');
    expect(decoded).toContain('Product');
  });
});
