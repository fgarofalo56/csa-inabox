/**
 * Unit tests for /api/items/azure-sql-database/[id]/query/cancel BFF route.
 *
 *   1. unauthenticated → 401
 *   2. missing requestId → 400
 *   3. unknown requestId → idempotent { ok:true, cancelled:false }
 *   4. live request → calls request.cancel() (TDS ATTENTION) and removes it
 *   5. cancel() throwing → 502
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// vi.mock factories are hoisted above module-scope consts, so the shared map
// must itself be hoisted (vi.hoisted) to be referenceable inside the factory.
const { liveRequests } = vi.hoisted(() => ({
  liveRequests: new Map<string, { cancel: () => void }>(),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/azure-sql-client', () => ({ liveRequests }));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';

function postReq(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  liveRequests.clear();
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

  it('is idempotent for an unknown requestId (already completed)', async () => {
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
 * The cross-replica intent store that WOULD fix the underlying no-op needs a
 * Cosmos container registered in `lib/azure/cosmos-client.ts` and in the cosmos
 * bicep `loomContainers` list; both are outside this change. Until it lands the
 * route must report the no-op honestly rather than claim a cancellation, which
 * is what these assertions pin.
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

  it('an unknown requestId reports the no-op honestly — no invented cause', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
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
});
