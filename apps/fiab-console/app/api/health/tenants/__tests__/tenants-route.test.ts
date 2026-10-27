/**
 * /api/health/tenants/[id] - authorization and gate contract.
 *
 * What would break each test is named inline. The provisioning logic itself is
 * covered in lib/install/provisioners/__tests__/health-tenant-provisioner.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn() }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const enforceCapability = vi.hoisted(() => vi.fn(async (..._a: any[]) => null as any));
vi.mock('@/lib/auth/feature-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/feature-gate')>()),
  enforceCapability: (...a: any[]) => enforceCapability(...a),
}));

const loadOwnedItem = vi.hoisted(() => vi.fn(async (..._a: any[]) => null as any));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItem(...a) }));

import { getSession } from '@/lib/auth/session';
import { POST } from '../[id]/route';

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1', upn: 'a@b.c', groups: [] } };
const req = (body?: unknown) =>
  ({ nextUrl: { pathname: '/api/health/tenants/item-1' }, json: async () => body ?? {} }) as any;
const ctx = { params: Promise.resolve({ id: 'item-1' }) } as any;

beforeEach(() => {
  vi.mocked(getSession).mockReturnValue(SESSION as any);
  enforceCapability.mockResolvedValue(null);
  loadOwnedItem.mockResolvedValue({ id: 'item-1', workspaceId: 'ws-1', itemType: 'health-tenant', displayName: 'Mercy General', state: {} });
  vi.stubEnv('LOOM_HEALTH_CP_URL', '');
  vi.stubEnv('LOOM_HEALTH_CP_AUDIENCE', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('POST /api/health/tenants/[id]', () => {
  it('is gated on health.tenant-admin: a denied caller gets the capability response and the item is never loaded', async () => {
    enforceCapability.mockResolvedValue(NextResponse.json({ ok: false, error: 'no grant' }, { status: 403 }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(enforceCapability).toHaveBeenCalledWith(SESSION, 'health.tenant-admin', 'Contributor');
    // Removing withCapability would let a plain item owner provision a clinical-data tenant.
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });

  it('with the control plane unconfigured returns the 503 health-control-plane gate envelope, not an empty success', async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.gated).toBe(true);
    expect(j.gate.id).toBe('health-control-plane');
    expect(j.gate.fixItHref).toBe('/admin/gates?gate=health-control-plane');
    expect(j.missing).toEqual(['LOOM_HEALTH_CP_URL', 'LOOM_HEALTH_CP_AUDIENCE']);
  });

  it('404s an item the caller cannot load (id probing across tenants)', async () => {
    loadOwnedItem.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });
});
