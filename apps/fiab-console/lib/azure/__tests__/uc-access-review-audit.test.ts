/**
 * LU-4 (remediation) — the principal-probe authorization predicate and the
 * access-review audit writer.
 *
 * Both are security primitives, so the specs are written as ATTACKS: the
 * interesting assertions are the ones where the answer must be NO.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn(async () => ({}));
const emitAuditEvent = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create } })),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a) }));

import { isSelfPrincipal, decidePrincipalProbe } from '@/lib/auth/uc-principal-probe';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { recordUcAccessReview, auditUcAccessReview, UC_ACCESS_REVIEW_KIND } from '../uc-access-review-audit';
import type { SessionPayload } from '@/lib/auth/session';

const SESSION = {
  claims: { oid: 'oid-1', upn: 'ada@contoso.com', email: 'ada.lovelace@contoso.com', name: 'Ada Lovelace', tid: 'tid-1' },
  exp: 9_999_999_999,
} as unknown as SessionPayload;

beforeEach(() => { create.mockClear(); emitAuditEvent.mockClear(); });

describe('isSelfPrincipal', () => {
  it('accepts the caller\'s own oid, upn and mail — case-insensitively', () => {
    for (const me of ['oid-1', 'ada@contoso.com', 'ADA@Contoso.com', 'ada.lovelace@contoso.com', '  ada@contoso.com  ']) {
      expect(isSelfPrincipal(SESSION, me)).toBe(true);
    }
  });

  it('REFUSES the display name — it is neither unique nor directory-controlled', () => {
    // Matching on it would let "Ada Lovelace" probe a GROUP named "Ada Lovelace".
    expect(isSelfPrincipal(SESSION, 'Ada Lovelace')).toBe(false);
  });

  it('REFUSES a third party, a group, a prefix, and a suffix collision', () => {
    for (const other of [
      'ceo@contoso.com', 'platform-admins', 'oid-12', 'oid-', 'ada@contoso.com.evil.com',
      'xada@contoso.com', '', '   ',
    ]) {
      expect(isSelfPrincipal(SESSION, other)).toBe(false);
    }
  });

  it('REFUSES an empty claim matching an empty probe (no vacuous self)', () => {
    const noMail = { claims: { oid: 'o', upn: 'u@x', name: 'n' }, exp: 1 } as unknown as SessionPayload;
    expect(isSelfPrincipal(noMail, '')).toBe(false);
  });
});

describe('decidePrincipalProbe', () => {
  it('DENIES a non-admin probing a third party, with an actionable reason', () => {
    const d = decidePrincipalProbe(SESSION, 'ceo@contoso.com', false);
    expect(d.allowed).toBe(false);
    expect(d.basis).toBeUndefined();
    expect(d.reason).toMatch(/tenant admins/);
    expect(d.remediation).toMatch(/LOOM_TENANT_ADMIN/);
  });

  it('allows self and tenant admin, and records WHICH basis applied', () => {
    expect(decidePrincipalProbe(SESSION, 'ada@contoso.com', false)).toMatchObject({ allowed: true, basis: 'self' });
    expect(decidePrincipalProbe(SESSION, 'ceo@contoso.com', true)).toMatchObject({ allowed: true, basis: 'tenant-admin' });
  });

  // ── ROUND-3: the remediation must actually remediate (ux-baseline G2) ──────
  it('does NOT send the denied caller to /admin/permissions, which cannot unblock them', () => {
    const d = decidePrincipalProbe(SESSION, 'ceo@contoso.com', false);
    // The gate is `isTenantAdmin(session)` (lib/auth/feature-gate.ts), which
    // reads ONLY LOOM_TENANT_ADMIN_GROUP_ID group claims and
    // LOOM_TENANT_ADMIN_OID. It never consults the Cosmos feature-grant table
    // that /admin/permissions writes, so the old text — "access can also be
    // granted at /admin/permissions" — was a dead end.
    expect(d.remediation).not.toMatch(/can\s+also\s+be\s+granted\s+at\s+\/admin\/permissions/i);
    expect(d.remediation).toMatch(/LOOM_TENANT_ADMIN_GROUP_ID/);
    expect(d.remediation).toMatch(/LOOM_TENANT_ADMIN_OID/);
    // If it mentions /admin/permissions at all, it must say it does NOT work.
    if (/\/admin\/permissions/.test(d.remediation!)) {
      expect(d.remediation).toMatch(/does NOT confer it/);
    }
  });

  it('isTenantAdmin is a SYNCHRONOUS token-claims check — it cannot be querying Cosmos', () => {
    // Structural proof of the claim the remediation text now makes. An async
    // Cosmos lookup could not return a plain boolean here.
    const notAdmin = isTenantAdmin({ claims: { oid: 'nobody', upn: 'n@x', groups: [] } } as any);
    expect(typeof notAdmin).toBe('boolean');
    expect(notAdmin).toBe(false);
  });
});

describe('recordUcAccessReview', () => {
  it('writes an audit row carrying WHO asked about WHOM, and the outcome', async () => {
    await recordUcAccessReview(SESSION, {
      securableType: 'TABLE', securableName: 'main.sales.pii', effective: true,
      probedPrincipal: 'ceo@contoso.com', decision: 'denied-principal-probe',
      nowIso: '2026-07-28T00:00:00.000Z',
    });
    expect(create).toHaveBeenCalledTimes(1);
    const rec = create.mock.calls[0][0] as any;
    expect(rec).toMatchObject({
      kind: UC_ACCESS_REVIEW_KIND,
      category: 'access-review',
      decision: 'denied-principal-probe',
      itemId: 'unity-catalog:TABLE:main.sales.pii',
      securableType: 'TABLE',
      probedPrincipal: 'ceo@contoso.com',
      actorOid: 'oid-1',
      actorUpn: 'ada@contoso.com',
      tenantId: 'tid-1',
      at: '2026-07-28T00:00:00.000Z',
    });
  });

  it('gives every row a distinct id (two identical queries do not collide)', async () => {
    const input = {
      securableType: 'CATALOG', securableName: 'main', effective: true,
      decision: 'allowed' as const, nowIso: '2026-07-28T00:00:00.000Z',
    };
    await recordUcAccessReview(SESSION, input);
    await recordUcAccessReview(SESSION, input);
    const [a, b] = create.mock.calls.map((c) => (c[0] as any).id);
    expect(a).not.toBe(b);
  });

  it('names the metastore rather than writing an empty partition key', async () => {
    await recordUcAccessReview(SESSION, {
      securableType: 'METASTORE', securableName: '', effective: true,
      decision: 'allowed', nowIso: '2026-07-28T00:00:00.000Z',
    });
    expect((create.mock.calls[0][0] as any).itemId).toBe('unity-catalog:METASTORE:(metastore)');
  });

  it('auditUcAccessReview swallows a sink failure (audit must never break the read)', async () => {
    create.mockRejectedValueOnce(new Error('cosmos 503'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(auditUcAccessReview(SESSION, {
      securableType: 'CATALOG', securableName: 'main', effective: true,
      decision: 'allowed', nowIso: '2026-07-28T00:00:00.000Z',
    })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ── ROUND-3 ───────────────────────────────────────────────────────────────
  // The module claimed the rows "surface in the existing Admin → Audit Logs
  // reader" and that "an enumeration sweep cannot run untraced". Neither was
  // true: the reader queried `c.tenantId = <viewer oid>` while this writer
  // records the Entra `tid`, and nothing fanned the row out to the SIEM.

  it('scopes the row on the Entra TENANT id, which is what the reader now selects on', async () => {
    await recordUcAccessReview(SESSION, {
      securableType: 'TABLE', securableName: 'main.sales.pii', effective: true,
      decision: 'allowed', nowIso: '2026-07-28T00:00:00.000Z',
    });
    const rec = create.mock.calls[0][0] as any;
    expect(rec.tenantId).toBe('tid-1');
    // The join is asserted end-to-end against the reader's own predicate in
    // app/api/admin/audit-logs/__tests__/route.test.ts — a row with this
    // `tenantId` must come back for a tenant admin whose `tid` is `tid-1`. That
    // is the assertion nobody was making, and it was false.
    expect(rec.tenantId).not.toBe(rec.actorOid);
  });

  it('fans the SAME record out to the SIEM stream — Cosmos is not the only sink', async () => {
    await recordUcAccessReview(SESSION, {
      securableType: 'TABLE', securableName: 'main.sales.pii', effective: true,
      probedPrincipal: 'ceo@contoso.com', decision: 'denied-principal-probe',
      nowIso: '2026-07-28T00:00:00.000Z',
    });
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(emitAuditEvent.mock.calls[0][0]).toMatchObject({
      actorOid: 'oid-1',
      action: 'unity-catalog.access-review.denied',
      targetType: 'unity-catalog-securable',
      targetId: 'unity-catalog:TABLE:main.sales.pii',
      outcome: 'denied',
      tenantId: 'tid-1',
    });
    expect((emitAuditEvent.mock.calls[0][0] as any).detail).toMatchObject({
      probedPrincipal: 'ceo@contoso.com', decision: 'denied-principal-probe',
    });
  });

  it('marks an ALLOWED sweep as a success read, with its blast-radius counters', async () => {
    await recordUcAccessReview(SESSION, {
      securableType: 'CATALOG', securableName: 'main', effective: true,
      decision: 'allowed', resultPrincipals: 42, closureSize: 7,
      nowIso: '2026-07-28T00:00:00.000Z',
    });
    expect(emitAuditEvent.mock.calls[0][0]).toMatchObject({
      action: 'unity-catalog.access-review.read', outcome: 'success',
    });
    expect((emitAuditEvent.mock.calls[0][0] as any).detail)
      .toMatchObject({ resultPrincipals: 42, closureSize: 7 });
  });
});
