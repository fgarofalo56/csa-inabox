/**
 * BR-PAT — scoped API tokens. Unit tests for the pure crypto/parsing helpers,
 * the Cosmos-backed create/resolve/revoke lifecycle, scope enforcement, and the
 * cookie-first fallback ordering of the PAT-aware session resolver.
 *
 * The Cosmos container is mocked with an in-memory store (no live endpoint); the
 * audit emitter and the cookie `getSession` are spies so we can assert the
 * use-after-revoke audit event and the strict cookie-wins fallback order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const store = new Map<string, any>();
  const container = {
    items: {
      create: async (doc: any) => { store.set(doc.id, structuredClone(doc)); return { resource: doc }; },
      query: (q: { query: string; parameters: { name: string; value: any }[] }) => ({
        fetchAll: async () => {
          const rows = [...store.values()];
          const p = Object.fromEntries(q.parameters.map((x) => [x.name, x.value]));
          let res = rows;
          if (q.query.includes('c.createdByOid = @oid')) res = rows.filter((r) => r.createdByOid === p['@oid']);
          else if (q.query.includes('c.tenantId = @t')) res = rows.filter((r) => r.tenantId === p['@t']);
          return { resources: res };
        },
      }),
    },
    item: (id: string) => ({
      read: async () => ({ resource: store.get(id) }),
      patch: async (ops: any[]) => {
        const d = store.get(id);
        if (d) for (const o of ops) if (o.op === 'set') d[String(o.path).replace('/', '')] = o.value;
        return { resource: d };
      },
      replace: async (doc: any) => { store.set(id, structuredClone(doc)); return { resource: doc }; },
    }),
  };
  return { store, container, emitSpy: vi.fn(), getSessionMock: vi.fn() };
});

vi.mock('@/lib/azure/cosmos-client', () => ({ loomPatTokensContainer: async () => h.container }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: h.emitSpy }));
vi.mock('@/lib/auth/session', () => ({ getSession: h.getSessionMock }));

import {
  hashSecret, verifySecret, generateSecret, generateTokenId, formatToken,
  parseToken, parseAuthHeader, clampTtlDays, isExpired, scopeAllowsMethod,
  createPatToken, resolvePat, revokePatToken, listPatTokensForUser,
  listPatTokensForTenant, patCannotMint, patCanAdmin, isPatSession,
  PAT_MAX_TTL_DAYS, PAT_DEFAULT_TTL_DAYS,
} from '../pat';
import { getApiSession, enforcePatAccess } from '../api-session';

const CREATOR = { oid: 'user-1', tid: 'tenant-1', name: 'Dev One', upn: 'dev1@contoso.gov', groups: ['g-eng'] };

beforeEach(() => {
  h.store.clear();
  h.emitSpy.mockReset();
  h.getSessionMock.mockReset();
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('hash / verify roundtrip', () => {
  it('verifies a matching secret and rejects a wrong one', () => {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    expect(verifySecret(secret, hash)).toBe(true);
    expect(verifySecret(secret + 'x', hash)).toBe(false);
    expect(verifySecret('totally-different', hash)).toBe(false);
  });
  it('does not throw on a malformed stored hash', () => {
    expect(verifySecret('abc', 'not-hex-!!')).toBe(false);
  });
  it('a fresh secret is 43 base64url chars and id is 24 hex', () => {
    expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateTokenId()).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('token parsing', () => {
  it('round-trips format → parse', () => {
    const id = generateTokenId(); const secret = generateSecret();
    const parsed = parseToken(formatToken(id, secret));
    expect(parsed).toEqual({ id, secret });
  });
  it('parses a secret that itself contains _ and -', () => {
    const id = 'a'.repeat(24);
    const secret = 'AB_cd-EF' + 'x'.repeat(35); // 43 chars, has _ and -
    expect(parseToken(`loom_pat_${id}_${secret}`)).toEqual({ id, secret });
  });
  it('rejects malformed tokens', () => {
    expect(parseToken('nope')).toBeNull();
    expect(parseToken('loom_pat_short_' + generateSecret())).toBeNull();
    expect(parseToken(null)).toBeNull();
  });
  it('parseAuthHeader accepts Bearer and bare, case-insensitive scheme', () => {
    const t = formatToken(generateTokenId(), generateSecret());
    expect(parseAuthHeader(`Bearer ${t}`)).not.toBeNull();
    expect(parseAuthHeader(`bearer ${t}`)).not.toBeNull();
    expect(parseAuthHeader(t)).not.toBeNull();
    expect(parseAuthHeader('Bearer not-a-pat')).toBeNull();
    expect(parseAuthHeader(null)).toBeNull();
  });
});

describe('ttl clamping + expiry', () => {
  it('defaults, floors, and clamps to the max', () => {
    expect(clampTtlDays(undefined)).toBe(PAT_DEFAULT_TTL_DAYS);
    expect(clampTtlDays(0)).toBe(PAT_DEFAULT_TTL_DAYS);
    expect(clampTtlDays(-5)).toBe(PAT_DEFAULT_TTL_DAYS);
    expect(clampTtlDays(45.9)).toBe(45);
    expect(clampTtlDays(9999)).toBe(PAT_MAX_TTL_DAYS);
  });
  it('isExpired is true past the instant', () => {
    expect(isExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(isExpired({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
    expect(isExpired({ expiresAt: 'garbage' })).toBe(true);
  });
});

describe('scope enforcement', () => {
  it('read-only allows only GET/HEAD/OPTIONS', () => {
    expect(scopeAllowsMethod('read-only', 'GET')).toBe(true);
    expect(scopeAllowsMethod('read-only', 'head')).toBe(true);
    expect(scopeAllowsMethod('read-only', 'POST')).toBe(false);
    expect(scopeAllowsMethod('read-only', 'DELETE')).toBe(false);
  });
  it('read-write and admin allow any verb', () => {
    for (const scope of ['read-write', 'admin'] as const) {
      expect(scopeAllowsMethod(scope, 'POST')).toBe(true);
      expect(scopeAllowsMethod(scope, 'DELETE')).toBe(true);
    }
  });
  it('enforcePatAccess blocks a mutating read-only PAT and passes a GET', () => {
    const patSession = { claims: CREATOR, exp: 0, pat: { tokenId: 't', scope: 'read-only' as const } };
    expect(enforcePatAccess(patSession, 'POST')).not.toBeNull();
    expect(enforcePatAccess(patSession, 'GET')).toBeNull();
    // cookie session (no pat) is never this helper's concern
    expect(enforcePatAccess({ claims: CREATOR, exp: 0 }, 'POST')).toBeNull();
  });
  it('enforcePatAccess blocks a non-admin-scoped PAT from admin surfaces', () => {
    const rw = { claims: CREATOR, exp: 0, pat: { tokenId: 't', scope: 'read-write' as const } };
    expect(enforcePatAccess(rw, 'GET', { adminRequired: true })).not.toBeNull();
  });
});

describe('create → hash stored, secret returned once, audited', () => {
  it('stores only a hash and returns a parseable token', async () => {
    const { view, token } = await createPatToken({ name: 'CI', scope: 'read-write', ttlDays: 30, creator: CREATOR });
    const parsed = parseToken(token)!;
    expect(parsed).not.toBeNull();
    const stored = h.store.get(view.id);
    expect(stored.hash).toBe(hashSecret(parsed.secret));
    expect(stored.hash).not.toContain(parsed.secret); // never the secret itself
    expect(Object.values(stored).join(' ')).not.toContain(parsed.secret);
    expect(h.emitSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'pat.create', targetId: view.id }));
  });
  it('clamps ttl over the max at create', async () => {
    const { view } = await createPatToken({ name: 'X', scope: 'read-only', ttlDays: 9999, creator: CREATOR });
    const ms = Date.parse(view.expiresAt) - Date.parse(view.createdAt);
    expect(Math.round(ms / (24 * 3600 * 1000))).toBe(PAT_MAX_TTL_DAYS);
  });
});

describe('resolvePat', () => {
  async function mint(scope: 'read-only' | 'read-write' | 'admin' = 'read-write') {
    const { token, view } = await createPatToken({ name: 'T', scope, ttlDays: 30, creator: CREATOR });
    return { token, id: view.id };
  }

  it('resolves a live token to a session carrying the pat marker + creator claims', async () => {
    const { token, id } = await mint('read-write');
    const session = await resolvePat(`Bearer ${token}`);
    expect(session).not.toBeNull();
    expect(session!.claims.oid).toBe(CREATOR.oid);
    expect(session!.pat).toEqual({ tokenId: id, scope: 'read-write' });
    expect(isPatSession(session)).toBe(true);
    // lastUsedAt was stamped (best-effort)
    expect(h.store.get(id).lastUsedAt).toBeTruthy();
  });

  it('returns null for a wrong secret WITHOUT auditing (no proof of possession)', async () => {
    const { id } = await mint();
    const forged = formatToken(id, generateSecret());
    expect(await resolvePat(`Bearer ${forged}`)).toBeNull();
    expect(h.emitSpy).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'pat.use-denied' }));
  });

  it('returns null for an unknown id', async () => {
    const bogus = formatToken(generateTokenId(), generateSecret());
    expect(await resolvePat(`Bearer ${bogus}`)).toBeNull();
  });

  it('denies a revoked token and audits use-after-revoke', async () => {
    const { token, id } = await mint();
    await revokePatToken(id, { oid: CREATOR.oid, upn: CREATOR.upn, tid: CREATOR.tid }, false);
    h.emitSpy.mockClear();
    expect(await resolvePat(`Bearer ${token}`)).toBeNull();
    expect(h.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pat.use-denied', outcome: 'denied', detail: expect.objectContaining({ reason: 'revoked' }) }),
    );
  });

  it('denies an expired token and audits it', async () => {
    const { token, id } = await mint();
    h.store.get(id).expiresAt = new Date(Date.now() - 1000).toISOString();
    h.emitSpy.mockClear();
    expect(await resolvePat(`Bearer ${token}`)).toBeNull();
    expect(h.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pat.use-denied', detail: expect.objectContaining({ reason: 'expired' }) }),
    );
  });
});

describe('revoke authorization', () => {
  it('owner can revoke; a different user cannot; re-revoke is a no-op', async () => {
    const { view } = await createPatToken({ name: 'T', scope: 'read-only', creator: CREATOR });
    expect(await revokePatToken(view.id, { oid: 'someone-else', upn: 'x@y' }, false)).toBe('forbidden');
    expect(await revokePatToken(view.id, { oid: CREATOR.oid, upn: CREATOR.upn, tid: CREATOR.tid }, false)).toBe('revoked');
    expect(await revokePatToken(view.id, { oid: CREATOR.oid, upn: CREATOR.upn, tid: CREATOR.tid }, false)).toBe('already-revoked');
  });
  it('admin can revoke within tenant but not across tenants', async () => {
    const { view } = await createPatToken({ name: 'T', scope: 'read-only', creator: CREATOR });
    expect(await revokePatToken(view.id, { oid: 'admin', upn: 'a@y', tid: 'other-tenant' }, true)).toBe('forbidden');
    expect(await revokePatToken(view.id, { oid: 'admin', upn: 'a@y', tid: 'tenant-1' }, true)).toBe('revoked');
  });
  it('revoke of an unknown id is not-found', async () => {
    expect(await revokePatToken('deadbeef', { oid: CREATOR.oid, upn: CREATOR.upn }, false)).toBe('not-found');
  });
});

describe('list scoping', () => {
  it('user list returns only the creator; tenant list returns all in the tenant', async () => {
    await createPatToken({ name: 'A', scope: 'read-only', creator: CREATOR });
    await createPatToken({ name: 'B', scope: 'read-only', creator: { ...CREATOR, oid: 'user-2', upn: 'u2@y' } });
    expect((await listPatTokensForUser('user-1')).length).toBe(1);
    expect((await listPatTokensForTenant('tenant-1')).length).toBe(2);
    expect((await listPatTokensForTenant('other')).length).toBe(0);
  });
});

describe('mint / admin guards', () => {
  it('a PAT session can never mint tokens', () => {
    expect(patCannotMint({ claims: CREATOR, exp: 0, pat: { tokenId: 't', scope: 'admin' } })).toBe(true);
    expect(patCannotMint({ claims: CREATOR, exp: 0 })).toBe(false);
  });
  it('patCanAdmin requires admin scope AND a still-admin creator', () => {
    process.env.LOOM_TENANT_ADMIN_OID = CREATOR.oid;
    expect(patCanAdmin({ claims: CREATOR, exp: 0, pat: { tokenId: 't', scope: 'admin' } })).toBe(true);
    // admin-scoped but creator no longer admin
    delete process.env.LOOM_TENANT_ADMIN_OID;
    expect(patCanAdmin({ claims: CREATOR, exp: 0, pat: { tokenId: 't', scope: 'admin' } })).toBe(false);
    // admin creator but token only read-write
    process.env.LOOM_TENANT_ADMIN_OID = CREATOR.oid;
    expect(patCanAdmin({ claims: CREATOR, exp: 0, pat: { tokenId: 't', scope: 'read-write' } })).toBe(false);
  });
});

describe('getApiSession — cookie-first fallback ordering', () => {
  it('returns the cookie session and NEVER consults the PAT header when a cookie exists', async () => {
    const cookieSession = { claims: CREATOR, exp: 9_999_999_999 };
    h.getSessionMock.mockReturnValue(cookieSession);
    const { token } = await createPatToken({ name: 'T', scope: 'admin', creator: { ...CREATOR, oid: 'other' } });
    const req = { headers: { get: (n: string) => (n.toLowerCase() === 'authorization' ? `Bearer ${token}` : null) }, method: 'GET' };
    const resolved = await getApiSession(req);
    expect(resolved).toBe(cookieSession);
    expect(resolved!.pat).toBeUndefined(); // proves the PAT path was not taken
  });

  it('falls back to the PAT when there is no cookie', async () => {
    h.getSessionMock.mockReturnValue(null);
    const { token, view } = await createPatToken({ name: 'T', scope: 'read-only', creator: CREATOR });
    const req = { headers: { get: (n: string) => (n.toLowerCase() === 'authorization' ? `Bearer ${token}` : null) }, method: 'GET' };
    const resolved = await getApiSession(req);
    expect(resolved!.pat).toEqual({ tokenId: view.id, scope: 'read-only' });
  });

  it('returns null when neither a cookie nor a PAT is present', async () => {
    h.getSessionMock.mockReturnValue(null);
    const req = { headers: { get: () => null }, method: 'GET' };
    expect(await getApiSession(req)).toBeNull();
  });
});
