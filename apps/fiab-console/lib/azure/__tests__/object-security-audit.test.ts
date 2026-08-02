/**
 * Object-level security audit writer (WS-4.3) — the record it hands to Cosmos.
 *
 * The point of these specs is #2650: the row has to be RETRIEVABLE, not merely
 * written. Admin → Audit Logs selects with
 * `ARRAY_CONTAINS(@tenants, c.tenantId)` over `[viewer.oid, viewer.tid]`, so a
 * document with no `tenantId` property can never be returned. This writer used
 * to record `...(c.tid ? { tenantId: c.tid } : {})`, which produced exactly that
 * document for any session without a `tid` claim (minted / automation / PAT) —
 * an enforcement decision nobody could ever read back.
 *
 * The end-to-end join against the reader's real predicate lives in
 * app/api/admin/audit-logs/__tests__/route.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn(async (doc: unknown) => ({ resource: doc }));
vi.mock('../cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { create } }),
}));

import { recordObjectSecurityEvent, auditObjectSecurity, OBJECT_SECURITY_KIND } from '../object-security-audit';
import type { SessionPayload } from '@/lib/auth/session';

const WITH_TID = {
  claims: { oid: 'oid-1', upn: 'ada@contoso.com', name: 'Ada Lovelace', tid: 'tid-1' },
  exp: 9_999_999_999,
} as unknown as SessionPayload;

/** Minted / automation / PAT session: an `oid`, no `tid`. */
const NO_TID = {
  claims: { oid: 'oid-1', upn: 'automation@contoso.com', name: 'Automation' },
  exp: 9_999_999_999,
} as unknown as SessionPayload;

const INPUT = {
  ontologyId: 'onto-7',
  ontologyName: 'Enterprise',
  decision: 'read-masked' as const,
  objectType: 'Customer',
  maskedProperties: ['ssn'],
  filteredCount: 3,
  nowIso: '2026-07-29T16:58:21.844Z',
};

beforeEach(() => { create.mockClear(); });

describe('recordObjectSecurityEvent', () => {
  it('records the enforcement decision with its actor and blast radius', async () => {
    await recordObjectSecurityEvent(WITH_TID, INPUT);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      itemId: 'onto-7',                       // partition key = ontology id
      kind: OBJECT_SECURITY_KIND,
      category: 'object-security',
      decision: 'read-masked',
      objectType: 'Customer',
      maskedProperties: ['ssn'],
      filteredCount: 3,
      actorOid: 'oid-1',
      tenantId: 'tid-1',
      at: '2026-07-29T16:58:21.844Z',
    });
  });

  // ── #2650 ─────────────────────────────────────────────────────────────────
  it('ALWAYS writes a tenantId — a tid-less session falls back to the actor oid', async () => {
    await recordObjectSecurityEvent(NO_TID, INPUT);
    const rec = create.mock.calls[0][0] as Record<string, unknown>;
    // hasOwnProperty, not truthiness: Cosmos drops an `undefined` value, and the
    // reader's ARRAY_CONTAINS never matches an absent property.
    expect(Object.prototype.hasOwnProperty.call(rec, 'tenantId')).toBe(true);
    expect(rec.tenantId).toBe('oid-1');
  });

  it('leaves genuinely optional fields off (the fix did not blanket-fill the doc)', async () => {
    await recordObjectSecurityEvent(NO_TID, {
      ontologyId: 'onto-7', decision: 'action-denied', nowIso: '2026-07-29T16:58:21.844Z',
    });
    const rec = create.mock.calls[0][0] as Record<string, unknown>;
    for (const k of ['ontologyName', 'objectType', 'action', 'targetId', 'maskedProperties', 'filteredCount', 'actorGroups']) {
      expect(Object.prototype.hasOwnProperty.call(rec, k)).toBe(false);
    }
  });

  it('auditObjectSecurity swallows a sink failure — audit never breaks the guarded read', async () => {
    create.mockRejectedValueOnce(new Error('cosmos 503'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    auditObjectSecurity(NO_TID, INPUT);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
