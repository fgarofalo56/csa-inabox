/**
 * #4805 — operator decision 2026-09-30, "Guardrails in-product" (d): a CLI /
 * VS Code device-code session never SELF-GRANTS through a self-serve catalog
 * request. Its request takes the governed path (an approver decides), while the
 * SAME claims in a browser session still get the immediate grant.
 *
 * Real session crypto and the real route; only Cosmos, the grant client and the
 * cookie store are faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';

const grantCalls: any[] = [];
vi.mock('@/lib/azure/access-policy-client', () => ({
  enforceAccessGrant: async (input: any) => {
    grantCalls.push(input);
    return { status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-1' };
  },
}));
const workflowRows: any[] = [];
const container = (sink?: any[]) => ({
  items: { create: async (doc: any) => { sink?.push(doc); return { resource: doc }; } },
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => container(),
  notificationsContainer: async () => container(),
  accessRequestWorkflowContainer: async () => container(workflowRows),
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

const selfServe = () =>
  new NextRequest('https://loom.example/api/catalog/request-access', {
    method: 'POST',
    body: JSON.stringify({ assetId: 'lh1', assetName: 'Sales', itemType: 'lakehouse', permission: 'read', accessModel: 'self-serve', scopeType: 'adls-container', scopeRef: 'bronze' }),
  });

beforeEach(() => {
  grantCalls.length = 0;
  workflowRows.length = 0;
});

describe('#4805 (d) self-serve catalog access from a device-code session', () => {
  it('a device-code session does NOT self-grant: no grant call, a governed request is recorded instead', async () => {
    cookieValue = encodeSessionCookie(deviceCode());
    const res = await POST(selfServe(), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    // RED if the device-code check is removed: the grant client would be called
    // and the answer would be `granted: true`.
    expect(grantCalls).toHaveLength(0);
    expect(body.granted).toBeUndefined();
    expect(body.ok).toBe(true);
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]).toMatchObject({ tier: 'manager', status: 'open', scopeRef: 'bronze' });
  });

  it('control: the same claims in a browser session get the immediate self-serve grant', async () => {
    cookieValue = encodeSessionCookie(browser());
    const res = await POST(selfServe(), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    expect(grantCalls).toHaveLength(1);
    expect(body).toMatchObject({ ok: true, granted: true, roleAssignmentId: 'ra-1' });
    expect(workflowRows).toHaveLength(0);
  });
});
