import { describe, it, expect, beforeAll } from 'vitest';
import {
  mintEmbedToken,
  verifyEmbedToken,
  clampEmbedTtl,
  normalizeRlsClaims,
  rlsClaimsToFilters,
  parseEmbedAuthHeader,
  EMBED_TOKEN_PREFIX,
  EMBED_AUDIENCE,
  EMBED_DEFAULT_TTL_SECS,
  EMBED_MAX_TTL_SECS,
  EMBED_MIN_TTL_SECS,
} from '../embed-token';

// The HMAC key derives from SESSION_SECRET (KV secretRef in prod) — set it for the suite.
beforeAll(() => {
  process.env.SESSION_SECRET = 'test-session-secret-for-embed-tokens';
});

const OWNER = { oid: 'owner-oid-1', tid: 'tenant-1' };

describe('mintEmbedToken — short-lived, scoped, signed', () => {
  it('mints a prefixed, dotted, signed token that round-trips through verify', () => {
    const now = 1_700_000_000_000;
    const { token, claims, expiresAtEpoch } = mintEmbedToken({
      reportId: 'rep-1',
      owner: OWNER,
      identity: { sub: 'viewer@acme.com', rls: { region: 'West' } },
      ttlSeconds: 600,
      now,
    });
    expect(token.startsWith(EMBED_TOKEN_PREFIX)).toBe(true);
    expect(token).toContain('.'); // payload.sig
    expect(claims.aud).toBe(EMBED_AUDIENCE);
    expect(claims.oid).toBe('owner-oid-1');
    expect(claims.reportId).toBe('rep-1');
    expect(claims.sub).toBe('viewer@acme.com');
    expect(claims.rls).toEqual({ region: 'West' });
    expect(expiresAtEpoch).toBe(Math.floor(now / 1000) + 600);

    const verified = verifyEmbedToken(token, now + 60_000);
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe('viewer@acme.com');
    expect(verified?.rls).toEqual({ region: 'West' });
  });

  it('is SCOPED to a single audience — a token is only the embed audience', () => {
    const { claims } = mintEmbedToken({ reportId: 'r', owner: OWNER, identity: { sub: 's', rls: {} } });
    expect(claims.aud).toBe(EMBED_AUDIENCE);
    expect(claims.iss).toBe('csa-loom');
  });

  it('clamps the TTL to [MIN, MAX] and defaults an invalid TTL', () => {
    expect(clampEmbedTtl(600)).toBe(600);
    expect(clampEmbedTtl(999_999)).toBe(EMBED_MAX_TTL_SECS);
    expect(clampEmbedTtl(1)).toBe(EMBED_MIN_TTL_SECS);
    expect(clampEmbedTtl(0)).toBe(EMBED_DEFAULT_TTL_SECS);
    expect(clampEmbedTtl(-5)).toBe(EMBED_DEFAULT_TTL_SECS);
    expect(clampEmbedTtl('nope')).toBe(EMBED_DEFAULT_TTL_SECS);
    expect(clampEmbedTtl(undefined)).toBe(EMBED_DEFAULT_TTL_SECS);
  });
});

describe('verifyEmbedToken — expiry + tamper rejection', () => {
  it('REJECTS an expired token (null, never throws)', () => {
    const now = 1_700_000_000_000;
    const { token } = mintEmbedToken({ reportId: 'r', owner: OWNER, identity: { sub: 's', rls: {} }, ttlSeconds: 60, now });
    // 61s later → past exp.
    expect(verifyEmbedToken(token, now + 61_000)).toBeNull();
    // still valid a moment before exp.
    expect(verifyEmbedToken(token, now + 59_000)).not.toBeNull();
  });

  it('REJECTS a tampered payload (signature mismatch)', () => {
    const { token, claims } = mintEmbedToken({
      reportId: 'r',
      owner: OWNER,
      identity: { sub: 's', rls: { region: 'West' } },
    });
    // Forge a wider RLS claim and re-encode the payload WITHOUT re-signing.
    const forged = { ...claims, rls: { region: 'East' } };
    const forgedPayload = Buffer.from(JSON.stringify(forged), 'utf-8').toString('base64url');
    const sig = token.slice(EMBED_TOKEN_PREFIX.length).split('.')[1];
    const forgedToken = `${EMBED_TOKEN_PREFIX}${forgedPayload}.${sig}`;
    expect(verifyEmbedToken(forgedToken)).toBeNull();
  });

  it('REJECTS a token signed with a DIFFERENT secret', () => {
    const { token } = mintEmbedToken({ reportId: 'r', owner: OWNER, identity: { sub: 's', rls: {} } });
    const original = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'a-completely-different-secret';
    try {
      expect(verifyEmbedToken(token)).toBeNull();
    } finally {
      process.env.SESSION_SECRET = original;
    }
  });

  it('REJECTS malformed / non-embed inputs without throwing', () => {
    expect(verifyEmbedToken(null)).toBeNull();
    expect(verifyEmbedToken('')).toBeNull();
    expect(verifyEmbedToken('loom_pat_abc_secret')).toBeNull();
    expect(verifyEmbedToken(`${EMBED_TOKEN_PREFIX}no-dot`)).toBeNull();
    expect(verifyEmbedToken(`${EMBED_TOKEN_PREFIX}.sigonly`)).toBeNull();
  });
});

describe('normalizeRlsClaims — value hardening', () => {
  it('keeps scalars + arrays-of-scalars, drops everything else', () => {
    expect(
      normalizeRlsClaims({
        region: 'West',
        year: 2024,
        depts: ['Sales', 'Marketing'],
        bad_obj: { a: 1 },
        bad_null: null,
        bad_nan: Number.NaN,
        '': 'blank-key-dropped',
      }),
    ).toEqual({ region: 'West', year: 2024, depts: ['Sales', 'Marketing'] });
  });

  it('returns an empty object for non-object input', () => {
    expect(normalizeRlsClaims(undefined)).toEqual({});
    expect(normalizeRlsClaims('nope')).toEqual({});
  });
});

describe('rlsClaimsToFilters — claims → structured predicates', () => {
  it('scalar → =, array → in (values never spliced)', () => {
    expect(rlsClaimsToFilters({ region: 'West', depts: ['Sales', 'Ops'] })).toEqual([
      { dimension: 'region', op: '=', value: 'West' },
      { dimension: 'depts', op: 'in', value: ['Sales', 'Ops'] },
    ]);
  });

  it('empty / nullish claims → no filters', () => {
    expect(rlsClaimsToFilters({})).toEqual([]);
    expect(rlsClaimsToFilters(undefined)).toEqual([]);
  });
});

describe('parseEmbedAuthHeader', () => {
  it('accepts a bearer or bare embed token, ignores other schemes', () => {
    const t = `${EMBED_TOKEN_PREFIX}abc.def`;
    expect(parseEmbedAuthHeader(`Bearer ${t}`)).toBe(t);
    expect(parseEmbedAuthHeader(t)).toBe(t);
    expect(parseEmbedAuthHeader('Bearer loom_pat_x_y')).toBeNull();
    expect(parseEmbedAuthHeader(null)).toBeNull();
  });
});
