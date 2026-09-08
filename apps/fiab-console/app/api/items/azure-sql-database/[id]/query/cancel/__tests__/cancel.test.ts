/**
 * Unit tests for /api/items/azure-sql-database/[id]/query/cancel BFF route.
 *
 *   1. unauthenticated → 401
 *   2. missing requestId → 400
 *   3. unknown requestId, no intent store → idempotent { ok:true, cancelled:false }
 *   4. unknown requestId, intent store up → { ok:true, cancelled:'requested' }
 *   5. live request → calls request.cancel() (TDS ATTENTION) and removes it
 *   6. cancel() throwing → 502
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// vi.mock factories are hoisted above module-scope consts, so the shared map
// must itself be hoisted (vi.hoisted) to be referenceable inside the factory.
const { liveRequests, recordCancelIntent } = vi.hoisted(() => ({
  liveRequests: new Map<string, { cancel: () => void }>(),
  recordCancelIntent: vi.fn(async (_requestId: string) => false),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/azure-sql-client', () => ({ liveRequests, recordCancelIntent }));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';

function postReq(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  liveRequests.clear();
  // Default: no intent store reachable (local dev / no Cosmos endpoint).
  recordCancelIntent.mockResolvedValue(false);
});

describe('POST /api/items/azure-sql-database/[id]/query/cancel', () => {
  it('returns 401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(postReq({ requestId: 'r1' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when requestId missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
  });

  it('is idempotent for an unknown requestId when no intent store is reachable', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(postReq({ requestId: 'gone' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.cancelled).toBe(false);
  });

  it('cancels a live request (sends TDS ATTENTION) and removes it', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const cancel = vi.fn();
    liveRequests.set('r1', { cancel });
    const res = await POST(postReq({ requestId: 'r1' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.cancelled).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(liveRequests.has('r1')).toBe(false);
    // A locally-owned request is cancelled directly — no intent is published.
    expect(recordCancelIntent).not.toHaveBeenCalled();
  });

  it('returns 502 when cancel() throws', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    liveRequests.set('r1', { cancel: () => { throw new Error('boom'); } });
    const res = await POST(postReq({ requestId: 'r1' }));
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.ok).toBe(false);
    expect(j.error).toContain('boom');
  });
});

/**
 * #3400 / #3399 — the guidance this route and `azure-sql-client` carried was
 * FALSE, and following it would have broken the estate.
 *
 * Both files told the reader that a scaled-out console should "enable ingress
 * sticky sessions (`ingress.stickySessions.affinity: 'sticky'`) or run a single
 * replica". Measured against the templates that actually deploy this console:
 *
 *   - admin-plane/main.bicep declares loom-console `multiRevision: true` with
 *     `minReplicas: 2`. Neither escape hatch describes the estate.
 *   - ACA REQUIRES `affinity:'none'` in multiple-revision mode, and
 *     app-deployments.bicep now ASSERTS that value on every deploy, with a
 *     comment naming this exact caller: "The one caller that wants affinity is
 *     SQL query-cancel — see #3400; its fix is a cross-replica cancel signal,
 *     not affinity." A sticky value set out-of-band failed 4 of 4
 *     console-bluegreen-roll runs.
 *
 * So the product's own source instructed the operator to perform plumbing the
 * platform forbids and self-heals away — an R7 assertion the code never
 * established, and a user-performed step under auto-bind-by-default.
 *
 * The cross-replica intent store now EXISTS (azure-sql-client:
 * `recordCancelIntent` + the poll watcher), so the wrong-replica case is no
 * longer a no-op. What these assertions pin is that the route still never
 * over-claims: `cancelled:'requested'` when the signal was persisted,
 * `cancelled:false` when it could not be, and `cancelled:true` only when this
 * replica cancelled the request itself.
 */
describe('cancel route honesty (#3400)', () => {
  const SRC_ROUTE = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8');
  const SRC_CLIENT = readFileSync(
    join(process.cwd(), 'lib', 'azure', 'azure-sql-client.ts'),
    'utf8',
  );

  it('neither file instructs the operator to enable sticky sessions', () => {
    for (const [name, src] of [['cancel/route.ts', SRC_ROUTE], ['azure-sql-client.ts', SRC_CLIENT]] as const) {
      expect(src, `${name} still prescribes affinity:'sticky'`).not.toMatch(/enable ingress sticky sessions/i);
      expect(src, `${name} still offers affinity:'sticky' as the remedy`)
        .not.toMatch(/stickySessions\.affinity:\s*'sticky'\)?\s*(?:or run a single replica|\*\/)/i);
    }
  });

  it('both files record that affinity is FORBIDDEN and name the real mechanism', () => {
    for (const [name, src] of [['cancel/route.ts', SRC_ROUTE], ['azure-sql-client.ts', SRC_CLIENT]] as const) {
      expect(src, `${name} does not say affinity is not the answer`).toMatch(/NOT SESSION AFFINITY|NOT "FIX" THIS WITH SESSION AFFINITY/i);
      expect(src, `${name} does not name the cross-replica signal`).toMatch(/cross-replica cancel signal/i);
      expect(src, `${name} does not record the multiRevision constraint`).toMatch(/multiRevision/);
    }
  });

  it('neither file still claims the intent store is unimplemented', () => {
    for (const [name, src] of [['cancel/route.ts', SRC_ROUTE], ['azure-sql-client.ts', SRC_CLIENT]] as const) {
      expect(src, `${name} still says the store is not implemented`)
        .not.toMatch(/store is (?:NOT|not) implemented yet/);
    }
  });

  it('an unknown requestId with NO reachable store reports the no-op honestly', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    recordCancelIntent.mockResolvedValue(false);
    const res = await POST(postReq({ requestId: 'elsewhere' }));
    const j = await res.json();
    expect(j.cancelled).toBe(false);
    expect(j.crossReplica).toBe(false);
    // It must say which of the two causes it CANNOT distinguish, rather than
    // asserting one of them as fact.
    expect(j.reason).toMatch(/cannot distinguish/i);
    expect(j.reason).toMatch(/replica that received this call/i);
    // And it must not tell the operator to go set an affinity the platform
    // forbids (auto-bind-by-default: no user-performed plumbing).
    expect(j.reason).not.toMatch(/sticky/i);
  });

  /**
   * RED before the fix: the route had no intent store at all, so a requestId
   * owned by another replica returned `cancelled:false` and the signal died
   * there. GREEN now: the intent is persisted and the response says exactly
   * that — 'requested', not 'cancelled'.
   */
  it('publishes a cross-replica intent when the id is not local, and reports it as REQUESTED', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    recordCancelIntent.mockResolvedValue(true);
    const res = await POST(postReq({ requestId: 'on-another-replica' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(recordCancelIntent).toHaveBeenCalledWith('on-another-replica');
    expect(j.ok).toBe(true);
    expect(j.crossReplica).toBe(true);
    // NOT `true` — persisting a signal is not observing a cancellation (R7).
    expect(j.cancelled).toBe('requested');
    expect(j.cancelled).not.toBe(true);
    // It must point at the thing that DOES establish the cancellation.
    expect(j.reason).toMatch(/ECANCEL/);
    expect(j.reason).toMatch(/does not claim/i);
  });
});

/**
 * The client half of the cross-replica signal (#3400): the replica that OWNS
 * the request must notice an intent published by a different replica and send
 * the TDS ATTENTION packet itself.
 *
 * RED before the fix: `azure-sql-client` had no watcher and no intent store, so
 * `_pollCancelIntentsOnce` did not exist and nothing ever consumed an intent.
 *
 * Uses `importActual` because the describe block above mocks the whole module.
 * The intent store is injected, so this exercises the real poll logic with no
 * Cosmos and no network.
 */
describe('azure-sql-client cancel-intent watcher (#3400)', () => {
  it('cancels a locally-owned request when an intent exists for its id', async () => {
    const client = await vi.importActual<typeof import('@/lib/azure/azure-sql-client')>(
      '@/lib/azure/azure-sql-client',
    );
    const intents = new Set<string>(['mine']);
    const cleared: string[] = [];
    client._setCancelIntentStore({
      record: async (id) => { intents.add(id); },
      has: async (id) => intents.has(id),
      clear: async (id) => { intents.delete(id); cleared.push(id); },
    });

    const cancel = vi.fn();
    const untouched = vi.fn();
    client.liveRequests.set('mine', { cancel } as any);
    client.liveRequests.set('no-intent', { cancel: untouched } as any);

    await client._pollCancelIntentsOnce();

    expect(cancel).toHaveBeenCalledOnce();
    expect(untouched).not.toHaveBeenCalled();
    // The cancelled request is deregistered; the other is left alone.
    expect(client.liveRequests.has('mine')).toBe(false);
    expect(client.liveRequests.has('no-intent')).toBe(true);
    // The spent intent is cleaned up so it can never cancel a later request.
    expect(cleared).toContain('mine');

    client.liveRequests.clear();
    client._setCancelIntentStore(null);
  });

  it('does nothing when no intent store is configured', async () => {
    const client = await vi.importActual<typeof import('@/lib/azure/azure-sql-client')>(
      '@/lib/azure/azure-sql-client',
    );
    client._setCancelIntentStore(null);
    const cancel = vi.fn();
    client.liveRequests.set('mine', { cancel } as any);
    // No LOOM_COSMOS_ENDPOINT in the test env → the store is off, and the poll
    // must be a silent no-op rather than an error or a spurious cancel.
    await client._pollCancelIntentsOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(client.liveRequests.has('mine')).toBe(true);
    client.liveRequests.clear();
  });
});
