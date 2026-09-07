/**
 * POST /api/items/[type]/[id]/export-check — the auth prologue, pinned.
 *
 * WHY THIS FILE EXISTS. #3941 migrated this route's `loadItem` onto
 * `authorizeItemWorkspace`, which made it a "touched baselined route" under
 * `scripts/ci/check-route-toolkit.mjs` rule 2 (the boy-scout rule). The codemod
 * REFUSES it — falsifiable in one command:
 *
 *   node scripts/codemods/migrate-route-toolkit.mjs --file=app/api/items/[type]/[id]/export-check/route.ts
 *   → SKIPPED (POST: getSession() without the exact 401 guard)
 *
 * because the 401 is `apiError('Unauthorized', 401)` rather than the literal
 * shape `withSession` replaces. So the route takes a `TOUCH_EXEMPT` entry, and
 * an exemption with no compensating control is just an unwatched hole. Its
 * three siblings in the same exemption already pin their 401
 * (`impact-route.test.ts:66`, `lineage/__tests__/route.test.ts:108`,
 * `sensitivity-label/__tests__/route.test.ts:110`); this one did not. Now it
 * does: deleting the prologue fails a merge-blocking test rather than passing
 * quietly.
 *
 * The second assertion is the one that actually matters. A 401 alone would
 * still pass if the handler authenticated AFTER reading Cosmos — so this
 * asserts the item container was never reached, i.e. nothing about the item
 * leaked before the caller was identified.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => null as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

/** Reached only if the handler queries items — which it must not, unauthed. */
const itemsReached = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => {
    itemsReached();
    return { items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } };
  },
}));

/** Reached only if the handler authorizes — also unreachable unauthed. */
const authorizeReached = vi.fn();
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: async () => { authorizeReached(); return null; },
}));

// The MIP/protection graph pulls ARM + identity clients on import; stub them so
// route import is fast and no credential probing happens. None of these paths
// is reachable in an unauthenticated request anyway.
vi.mock('@/lib/azure/mip-graph-client', () => ({
  getSensitivityLabel: async () => null,
  getSensitivityLabelWithRights: async () => null,
}));
vi.mock('@/lib/azure/label-protection', () => ({ checkExportProtection: () => ({ blocked: false }) }));
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) });
const req = (body: unknown) => ({ json: async () => body }) as any;

beforeEach(() => { getSessionMock.mockReturnValue(null as any); });
afterEach(() => { vi.clearAllMocks(); });

describe('POST /api/items/[type]/[id]/export-check — auth prologue', () => {
  it('401s when unauthenticated', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ format: 'csv' }), ctx('lakehouse', 'item-1'));
    expect(r.status).toBe(401);
  });

  it('reads NOTHING about the item before the caller is identified', async () => {
    const { POST } = await import('../route');
    await POST(req({ format: 'csv' }), ctx('lakehouse', 'item-1'));
    expect(itemsReached, 'Cosmos was queried on an unauthenticated request').not.toHaveBeenCalled();
    expect(authorizeReached, 'the workspace ladder ran without a session').not.toHaveBeenCalled();
  });

  it('CONTROL — an authenticated caller gets past the prologue', async () => {
    // Without this the two assertions above would also pass against a handler
    // that returned 401 unconditionally, i.e. against a broken route.
    getSessionMock.mockReturnValue({
      claims: { oid: 'ten-1', upn: 'u@t.com', name: 'U' },
      exp: Date.now() / 1000 + 3600,
    } as any);
    const { POST } = await import('../route');
    const r = await POST(req({ format: 'csv' }), ctx('lakehouse', 'item-1'));
    expect(r.status).not.toBe(401);
    expect(itemsReached).toHaveBeenCalled();
  });
});
