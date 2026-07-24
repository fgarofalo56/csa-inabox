/**
 * Contract test for POST /api/embed/token (N18): mints a short-lived signed
 * embed token, audited emit-first, FLAG0-gated. Session + Cosmos + audit stubbed.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ auditLogContainer: vi.fn() }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
// Faithful lightweight withSession (avoids the item-crud/cosmos import chain the
// real toolkit pulls in) — same 401-then-invoke contract the route relies on.
vi.mock('@/lib/api/route-toolkit', async () => {
  const { getSession } = await import('@/lib/auth/session');
  const { apiUnauthorized, apiServerError } = await import('@/lib/api/respond');
  return {
    withSession: (handler: (req: unknown, ctx: { session: unknown; params: unknown }) => unknown) =>
      async (req: unknown, ctx?: { params?: Promise<unknown> }) => {
        const session = (getSession as unknown as () => unknown)();
        if (!session) return apiUnauthorized();
        try {
          return await handler(req, { session, params: ctx?.params ? await ctx.params : {} });
        } catch (e) {
          return apiServerError(e);
        }
      },
  };
});

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { verifyEmbedToken } from '@/lib/embed/embed-token';

function req(body: unknown) {
  return { json: async () => body } as never;
}
const ctx = { params: Promise.resolve({}) };
const auditCreate = vi.fn().mockResolvedValue({});

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-session-secret-for-embed-tokens';
});

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    claims: { oid: 'owner-1', tid: 'tenant-1', upn: 'owner@acme.com' },
  });
  (runtimeFlag as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (auditLogContainer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ items: { create: auditCreate } });
});

describe('POST /api/embed/token', () => {
  it('mints a verifiable, identity-scoped token and audits the mint (emit-first)', async () => {
    const res = await POST(req({ reportId: 'rep-1', identity: { sub: 'viewer@acme.com', rls: { region: 'West' } } }), ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; token: string; reportId: string };
    expect(json.ok).toBe(true);
    expect(json.reportId).toBe('rep-1');

    // The token verifies + carries the owner + effective identity + RLS claims.
    const claims = verifyEmbedToken(json.token);
    expect(claims).not.toBeNull();
    expect(claims?.oid).toBe('owner-1');
    expect(claims?.sub).toBe('viewer@acme.com');
    expect(claims?.rls).toEqual({ region: 'West' });

    // SIEM fan-out fired, and it never leaks the token secret.
    expect(emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'embed-token.mint', targetType: 'embed-token', targetId: 'rep-1' }),
    );
    const emitted = (emitAuditEvent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(emitted)).not.toContain(json.token);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('defaults the effective identity sub to the caller when none is given', async () => {
    const res = await POST(req({ reportId: 'rep-2' }), ctx);
    const json = (await res.json()) as { token: string };
    const claims = verifyEmbedToken(json.token);
    expect(claims?.sub).toBe('owner@acme.com');
    expect(claims?.rls).toEqual({});
  });

  it('400s without a reportId', async () => {
    const res = await POST(req({ identity: { sub: 'x' } }), ctx);
    expect(res.status).toBe(400);
  });

  it('503 guided gate when the FLAG0 kill-switch is OFF', async () => {
    (runtimeFlag as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const res = await POST(req({ reportId: 'rep-1' }), ctx);
    expect(res.status).toBe(503);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('embed_off');
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });
});
