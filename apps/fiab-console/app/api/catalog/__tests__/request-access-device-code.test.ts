/**
 * #4805 — operator decision 2026-09-30, "Guardrails in-product" (d): a CLI /
 * VS Code device-code session never SELF-GRANTS through a self-serve catalog
 * request. Its request takes the governed path (an approver decides), while the
 * SAME claims in a browser session still get the immediate grant.
 *
 * The requested asset is served from the catalog the way the route reads it
 * (#4838): a PUBLISHED, self-serve data product whose output port names the
 * container a lakehouse in the same workspace is bound to. The access model and
 * the scope come from that record, never the body; the body below carries
 * decoys (`accessModel`, `scopeRef`) that must be ignored.
 *
 * Real session crypto and the real route; only Cosmos, discovery, the grant
 * client and the cookie store are faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';

const grantCalls: any[] = [];
vi.mock('@/lib/azure/access-policy-client', () => ({
  enforceAccessGrant: async (input: any) => {
    grantCalls.push(input);
    return { status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-1', preexisting: false };
  },
}));
const workflowRows: any[] = [];
const sink = (rows?: any[]) => ({
  items: { create: async (doc: any) => { rows?.push(doc); return { resource: doc }; } },
});
vi.mock('@/lib/azure/cosmos-client', async () => {
  const { makePartitionedContainer } = await import('@/app/api/access-requests/__tests__/partitioned-cosmos-fake');
  const items = makePartitionedContainer({
    partitionKeyPath: '/workspaceId',
    seed: [
      { id: 'lh-gold', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Gold lake', state: { adlsContainer: 'gold' } },
      {
        id: 'dp-1', workspaceId: 'ws-1', itemType: 'data-product', displayName: 'Gold sales',
        state: { lifecycleState: 'published', accessModel: 'self-serve', ports: { output: [{ name: 'gold-out', kind: 'adls', ref: 'gold' }] } },
      },
    ],
  });
  return {
    itemsContainer: async () => items,
    auditLogContainer: async () => sink(),
    notificationsContainer: async () => sink(),
    accessRequestWorkflowContainer: async () => sink(workflowRows),
  };
});
vi.mock('@/lib/dataproducts/discoverability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dataproducts/discoverability')>()),
  resolveDiscoveryAccess: vi.fn(async () => 'discoverable'),
}));
let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: () => ({ get: (name: string) => (cookieValue ? { name, value: cookieValue } : undefined) }),
}));

import { encodeSessionCookie, type SessionPayload } from '@/lib/auth/session';
import { POST } from '../request-access/route';

const claims = { oid: 'aaaaaaaa-0000-0000-0000-0000000000c1', tid: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Cy', upn: 'cy@contoso.com' };
const exp = () => Math.floor(Date.now() / 1000) + 600;
const browser = (): SessionPayload => ({ claims: { ...claims }, exp: exp() });
const deviceCode = (): SessionPayload => ({ claims: { ...claims }, exp: exp(), authVia: 'device_code' });

// Read access to the self-serve product. `accessModel` / `scopeRef` are decoys
// the route must ignore: the product decides both.
const selfServe = () =>
  new NextRequest('https://loom.example/api/catalog/request-access', {
    method: 'POST',
    body: JSON.stringify({ assetId: 'dp-1', permission: 'read', accessModel: 'governed', scopeType: 'adls-container', scopeRef: 'decoy' }),
  });

beforeEach(() => {
  grantCalls.length = 0;
  workflowRows.length = 0;
});

describe('#4805 (d) self-serve catalog access from a device-code session', () => {
  it('a device-code session does NOT self-grant: no grant call, a governed request on the product\'s scope instead', async () => {
    cookieValue = encodeSessionCookie(deviceCode());
    const res = await POST(selfServe(), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    // RED if the device-code check (`!isDeviceCodeSession(s)`) is removed: the
    // product is self-serve and its port is bound, so the grant client would be
    // called once and the answer would be `granted: true` with no request row.
    expect(grantCalls).toHaveLength(0);
    expect(body.granted).toBeUndefined();
    expect(body.ok).toBe(true);
    expect(workflowRows).toHaveLength(1);
    // The scope is the product's bound container, not the body's decoy.
    expect(workflowRows[0]).toMatchObject({ tier: 'manager', status: 'open', scopeType: 'adls-container', scopeRef: 'gold' });
  });

  it('control: the same claims in a browser session get the immediate self-serve grant', async () => {
    // RED if the fixture stopped reaching the self-serve branch (unpublished,
    // not self-serve, or an unbound port): no grant call, and a request row.
    cookieValue = encodeSessionCookie(browser());
    const res = await POST(selfServe(), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]).toMatchObject({ principalId: claims.oid, scopeType: 'adls-container', scopeRef: 'gold', permission: 'read' });
    expect(body).toMatchObject({ ok: true, granted: true, roleAssignmentId: 'ra-1' });
    expect(workflowRows).toHaveLength(0);
  });
});
