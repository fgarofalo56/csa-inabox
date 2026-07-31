/**
 * Credential-bearing Service Bus actions must AUTHORIZE, not just authenticate.
 *
 * `list-keys` and `regenerate-keys` return live SAS keys for the SHARED,
 * env-pinned namespace (LOOM_SERVICEBUS_NAMESPACE) — infrastructure the whole
 * tenant sits on, not a per-user resource, so there is no ownership to scope
 * against. They were reachable by ANY signed-in session.
 *
 * The precedent for the fix is in-repo: /api/ai-search/service already gates the
 * equivalent surface with `denyIfNoDlzAccess` and states the reason in a comment
 * — "a getSession-only gate would let any authenticated user read admin keys +
 * rescale the shared service."
 *
 * These tests pin the SPLIT, which is the part most likely to regress: the
 * non-credential actions on this same route stay open to ordinary users. A fix
 * that simply gated the whole route would pass a naive "does it 403" test while
 * breaking the Service Bus navigator for everyone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/azure/servicebus-client', () => ({
  servicebusConfigGate: vi.fn(() => null),
  getNamespaceProperties: vi.fn(async () => ({})),
  listQueues: vi.fn(async () => []),
  createQueue: vi.fn(async () => ({ name: 'q1' })),
  deleteQueue: vi.fn(async () => ({})),
  listTopics: vi.fn(async () => []),
  createTopic: vi.fn(async () => ({})),
  deleteTopic: vi.fn(async () => ({})),
  listSubscriptions: vi.fn(async () => []),
  createSubscription: vi.fn(async () => ({})),
  deleteSubscription: vi.fn(async () => ({})),
  listRules: vi.fn(async () => []),
  createRule: vi.fn(async () => ({})),
  deleteRule: vi.fn(async () => ({})),
  listNamespaceAuthRules: vi.fn(async () => [{ name: 'RootManageSharedAccessKey' }]),
  createNamespaceAuthRule: vi.fn(async () => ({ name: 'r' })),
  deleteNamespaceAuthRule: vi.fn(async () => ({})),
  listNamespaceKeys: vi.fn(async () => ({ primaryKey: 'k1', secondaryKey: 'k2' })),
  regenerateNamespaceKeys: vi.fn(async () => ({ primaryKey: 'new', secondaryKey: 'k2' })),
  getNetworkRuleSet: vi.fn(async () => ({})),
  listPrivateEndpointConnections: vi.fn(async () => []),
  iso8601Duration: vi.fn(() => undefined),
}));

import { NextResponse } from 'next/server';
import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { listNamespaceKeys, regenerateNamespaceKeys } from '@/lib/azure/servicebus-client';

const FORBIDDEN = () => NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });

function post(body: unknown) {
  return { json: async () => body, nextUrl: { searchParams: new URLSearchParams() } } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'user-1' } });
});

describe('service-bus-namespace — credential actions require authorization', () => {
  it('403s list-keys for a signed-in NON-admin', async () => {
    (denyIfNoDlzAccess as any).mockResolvedValue(FORBIDDEN());
    const res = await POST(post({ action: 'list-keys', rule: 'RootManageSharedAccessKey' }));
    expect(res.status).toBe(403);
    // The key fetch must not have run at all — a 403 body with the keys already
    // read server-side would still be a leak through logs/traces.
    expect(listNamespaceKeys).not.toHaveBeenCalled();
  });

  it('403s regenerate-keys for a signed-in NON-admin', async () => {
    (denyIfNoDlzAccess as any).mockResolvedValue(FORBIDDEN());
    const res = await POST(post({ action: 'regenerate-keys', rule: 'RootManageSharedAccessKey' }));
    expect(res.status).toBe(403);
    expect(regenerateNamespaceKeys).not.toHaveBeenCalled();
  });

  it('allows list-keys for an admin', async () => {
    (denyIfNoDlzAccess as any).mockResolvedValue(null);
    const res = await POST(post({ action: 'list-keys', rule: 'RootManageSharedAccessKey' }));
    expect(res.status).toBe(200);
    expect(listNamespaceKeys).toHaveBeenCalledWith('RootManageSharedAccessKey');
  });

  it('leaves NON-credential actions open to ordinary users', async () => {
    // The blast-radius half. Gating the whole route would break the navigator
    // for every non-admin; only the key-bearing actions are privileged.
    (denyIfNoDlzAccess as any).mockResolvedValue(FORBIDDEN());
    const res = await POST(post({ action: 'create-queue', name: 'q1' }));
    expect(res.status).toBe(200);
    expect(denyIfNoDlzAccess).not.toHaveBeenCalled();
  });
});
