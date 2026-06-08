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
