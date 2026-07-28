/**
 * LU-4 (remediation) — the principal-probe authorization predicate and the
 * access-review audit writer.
 *
 * Both are security primitives, so the specs are written as ATTACKS: the
 * interesting assertions are the ones where the answer must be NO.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn(async () => ({}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create } })),
}));

import { isSelfPrincipal, decidePrincipalProbe } from '@/lib/auth/uc-principal-probe';
import { recordUcAccessReview, auditUcAccessReview, UC_ACCESS_REVIEW_KIND } from '../uc-access-review-audit';
import type { SessionPayload } from '@/lib/auth/session';

const SESSION = {
  claims: { oid: 'oid-1', upn: 'ada@contoso.com', email: 'ada.lovelace@contoso.com', name: 'Ada Lovelace', tid: 'tid-1' },
  exp: 9_999_999_999,
} as unknown as SessionPayload;

beforeEach(() => { create.mockClear(); });

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
});
