/**
 * POST /api/health/tenants/[id] - the provisioner's `no-stamp` / `unconfigured` phase reaches the client (#5377).
 *
 * Before: the body was the bare gate envelope with no `phase`, so a client reading `phase` (the G1 spec) saw
 * undefined and timed out after 12 minutes instead of failing with the real reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const grants = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: grants.rows }) }) },
  }),
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/session')>()), getSession: vi.fn() }));

const loadOwnedItem = vi.hoisted(() => vi.fn(async (..._a: any[]) => null as any));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItem(...a) }));

const ensure = vi.hoisted(() => vi.fn(async (..._a: any[]) => ({}) as any));
vi.mock('@/lib/install/provisioners/health-tenant', async (orig) => ({
  ...(await orig<typeof import('@/lib/install/provisioners/health-tenant')>()),
  ensureHealthTenant: (...a: any[]) => ensure(...a),
}));

import { getSession } from '@/lib/auth/session';
import { POST } from '../[id]/route';

const req = () => ({ nextUrl: { pathname: '/api/health/tenants/item-1' }, json: async () => ({}) }) as any;
const ctx = { params: Promise.resolve({ id: 'item-1' }) } as any;

beforeEach(() => {
  vi.mocked(getSession).mockReturnValue({ claims: { oid: 'oid-1', tid: 'tid-1', upn: 'a@b.c', groups: [] } } as any);
  grants.rows = [{ capabilityId: 'health.tenant-admin', principalId: 'oid-1', role: 'Contributor', tenantId: 'tid-1' }];
  loadOwnedItem.mockResolvedValue({ id: 'item-1', workspaceId: 'ws-1', itemType: 'health-tenant', displayName: 'Mercy General', state: {} });
});
afterEach(() => { vi.clearAllMocks(); });

describe('POST /api/health/tenants/[id] phase surfacing (#5377)', () => {
  it('no-stamp answers 503 with phase "no-stamp" AND the provisioner message, envelope intact', async () => {
    const message = "The configured default stamp 'dev01' is not registered in the health control plane.";
    ensure.mockResolvedValue({ phase: 'no-stamp', gateId: 'health-stamp-capacity', message, steps: [] });
    const res = await POST(req(), ctx);
    const j = await res.json();
    expect(res.status).toBe(503);
    // Breaks (undefined) if the route returns the bare envelope again, which is what hid the cause for 12 minutes.
    expect(j.phase).toBe('no-stamp');
    // Breaks if the message is replaced by the generic gate remediation.
    expect(j.error).toBe(message);
    // The editor's contract is unchanged: gated + gate.id + fixItHref.
    expect(j.gated).toBe(true);
    expect(j.gate.id).toBe('health-stamp-capacity');
    expect(j.missing).toEqual(['LOOM_HEALTH_DEFAULT_STAMP_ID']);
  });

  it('unconfigured answers 503 with phase "unconfigured"', async () => {
    ensure.mockResolvedValue({ phase: 'unconfigured', gateId: 'health-control-plane', missing: ['LOOM_HEALTH_CP_URL'], message: 'not configured', steps: [] });
    const res = await POST(req(), ctx);
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.phase).toBe('unconfigured');
    expect(j.missing).toEqual(['LOOM_HEALTH_CP_URL']);
  });
});
