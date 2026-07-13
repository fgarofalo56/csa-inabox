/**
 * network-discovery-fanout.test — the multi-subscription fan-out fix behind the
 * "Couldn't read private endpoints — took longer than 6s and timed out" failure.
 *
 * Exercises the REAL listPrivateEndpoints() code path (stubbing @azure/identity +
 * global.fetch — no live ARM), verifying:
 *   1. FAST PATH: a single Azure Resource Graph query returns every PE across subs
 *      and the per-subscription ARM list is NOT used.
 *   2. FALLBACK: when ARG errors, it falls back to a PARALLEL per-subscription ARM
 *      list; a subscription that errors is recorded in `failed` (an honest partial
 *      result) while the healthy subscriptions still return their endpoints.
 *   3. PER-SUB TIMEOUT: a subscription whose scan never settles is bounded by the
 *      per-sub deadline and recorded as failed — it can't hang the whole query.
 * Per no-vaporware, these run the actual function, not a mock of it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// Tight per-sub deadline so the "hangs forever" case resolves the test quickly.
// `vi.hoisted` runs BEFORE the (hoisted) import so the module reads it at load —
// a plain top-level assignment would run AFTER the import and be too late.
vi.hoisted(() => {
  process.env.LOOM_NETWORK_PER_SUB_TIMEOUT_MS = '300';
  process.env.LOOM_SUBSCRIPTION_ID = ''; // force multi-sub enumeration
});

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { listPrivateEndpoints, type FailedSub } from '../network-discovery';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const SUB_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUB_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A private-endpoint ARM/ARG resource with one approved blob connection. */
function peResource(sub: string, name: string) {
  return {
    id: `/subscriptions/${sub}/resourceGroups/rg-net/providers/Microsoft.Network/privateEndpoints/${name}`,
    name,
    location: 'eastus2',
    subscriptionId: sub,
    properties: {
      customDnsConfigs: [{ fqdn: `${name}.blob.core.windows.net`, ipAddresses: ['10.0.0.4'] }],
      privateLinkServiceConnections: [{
        properties: {
          privateLinkServiceId: `/subscriptions/${sub}/resourceGroups/rg-net/providers/Microsoft.Storage/storageAccounts/${name}`,
          groupIds: ['blob'],
          privateLinkServiceConnectionState: { status: 'Approved' },
        },
      }],
    },
  };
}

describe('listPrivateEndpoints — cross-sub fan-out', () => {
  it('FAST PATH: uses a single Resource Graph query and skips the per-sub ARM list', async () => {
    let argCalls = 0;
    let perSubListCalls = 0;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/subscriptions?api-version')) {
        return json({ value: [{ subscriptionId: SUB_A }, { subscriptionId: SUB_B }] });
      }
      if (u.includes('/providers/Microsoft.ResourceGraph/resources')) {
        argCalls += 1;
        return json({ data: [peResource(SUB_A, 'pea'), peResource(SUB_B, 'peb')] });
      }
      if (u.includes('/providers/Microsoft.Network/privateEndpoints')) {
        perSubListCalls += 1;
        return json({ value: [] });
      }
      return json({ value: [] });
    }) as any;

    const failed: FailedSub[] = [];
    const eps = await listPrivateEndpoints(failed);

    expect(argCalls).toBe(1);
    expect(perSubListCalls).toBe(0);           // ARG covered it — no per-sub fan-out
    expect(eps).toHaveLength(2);
    expect(eps.map((e) => e.name).sort()).toEqual(['pea', 'peb']);
    expect(eps[0].state).toBe('Approved');
    expect(eps.every((e) => e.dns[0].ips.includes('10.0.0.4'))).toBe(true);
    expect(failed).toHaveLength(0);
  });

  it('FALLBACK: ARG error → PARALLEL per-sub list; one bad sub becomes a partial note', async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/subscriptions?api-version')) {
        return json({ value: [{ subscriptionId: SUB_A }, { subscriptionId: SUB_B }] });
      }
      if (u.includes('/providers/Microsoft.ResourceGraph/resources')) {
        return json({ error: { message: 'correlationId … ARG unavailable' } }, 403);
      }
      if (u.includes(`/subscriptions/${SUB_A}/providers/Microsoft.Network/privateEndpoints`)) {
        return json({ value: [peResource(SUB_A, 'pea')] });
      }
      if (u.includes(`/subscriptions/${SUB_B}/providers/Microsoft.Network/privateEndpoints`)) {
        return json({ error: { message: 'Forbidden' } }, 403); // this sub is unreadable
      }
      return json({ value: [] });
    }) as any;

    const failed: FailedSub[] = [];
    const eps = await listPrivateEndpoints(failed);

    // Healthy subscription still returns its endpoint (never blanked)…
    expect(eps.map((e) => e.name)).toEqual(['pea']);
    // …and the unreadable one is recorded for the honest partial-results note.
    expect(failed).toHaveLength(1);
    expect(failed[0].subscriptionId).toBe(SUB_B);
  });

  it('PER-SUB TIMEOUT: a subscription that never settles is bounded and recorded', async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/subscriptions?api-version')) {
        return json({ value: [{ subscriptionId: SUB_A }, { subscriptionId: SUB_B }] });
      }
      if (u.includes('/providers/Microsoft.ResourceGraph/resources')) {
        return json({ error: { message: 'ARG off' } }, 500); // force per-sub fallback
      }
      if (u.includes(`/subscriptions/${SUB_A}/providers/Microsoft.Network/privateEndpoints`)) {
        return json({ value: [peResource(SUB_A, 'pea')] });
      }
      if (u.includes(`/subscriptions/${SUB_B}/providers/Microsoft.Network/privateEndpoints`)) {
        return new Promise<Response>(() => { /* never resolves — simulates a hung sub */ });
      }
      return json({ value: [] });
    }) as any;

    const failed: FailedSub[] = [];
    const started = Date.now();
    const eps = await listPrivateEndpoints(failed);

    // The hung sub was bounded by the ~300ms per-sub deadline, not left to hang.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(eps.map((e) => e.name)).toEqual(['pea']);
    expect(failed).toHaveLength(1);
    expect(failed[0].subscriptionId).toBe(SUB_B);
    expect(failed[0].reason).toMatch(/exceeded/i);
  });
});
