/**
 * embed-token — short-lived, scoped, HMAC-signed EMBED TOKENS for Loom's
 * Fabric-FREE embedded-analytics story (N18).
 *
 * ## Why (and why NOT Power BI Embedded)
 *
 * Power BI Embedded now requires a Fabric F-SKU capacity — a hard Fabric
 * dependency this platform forbids (`no-fabric-dependency.md`). This module is
 * the Azure-native replacement: a host application authenticated to Loom (the
 * "app owns data" model) mints a self-contained token carrying an EFFECTIVE
 * IDENTITY + its row-level-security claims for one of its end-users, hands it to
 * a `<loom-report>` web component / `@csa-loom/embed` React wrapper, and the
 * component fetches a governed metric through `POST /api/embed/query`. There is
 * NO Power BI host, NO F-SKU, NO Fabric workspace — identical on every cloud,
 * and this IS the Gov embed story.
 *
 * ## Shape of a token
 *
 *   loom_embed_<payload-b64url>.<sig-b64url>
 *     payload = base64url(JSON EmbedTokenClaims)
 *     sig     = base64url( HMAC-SHA256(payload-b64url, key) )
 *
 * It is a compact HS256-style JWS (not a full JWT — single algorithm, single
 * audience, no header negotiation, so there is no `alg:none` downgrade surface).
 * The token is STATELESS: verification needs only the derived key, so a public
 * host page can present it with no Loom cookie and no Cosmos round-trip.
 *
 * ## Signing key (KV/derived — never inline)
 *
 * The HMAC key is HKDF-derived from the already-required `SESSION_SECRET`
 * (injected via Key Vault secretRef in the deployment) under a DISTINCT `info`
 * label (`loom-embed-token-v1`) — the same pattern `session.ts` uses for its
 * at-rest key. So an embed token can never be replayed as a session cookie (or
 * vice-versa), and N18 adds NO new secret / env var to the deployment.
 *
 * ## Expiry
 *
 *   default 10 min, hard max 60 min (clamped at mint, re-checked on verify). An
 *   expired or tampered token verifies to `null` — a denied use.
 *
 * ## RLS is enforced at QUERY TIME, not here
 *
 * This module only CARRIES the identity's RLS claims. The actual row filtering
 * happens in the N15 metric compiler, which ANDs the claims into the WHERE as
 * bound parameters / centrally-escaped literals (see `metric-compiler.ts`
 * `CompileMetricArgs.rls`). Two different token identities therefore compile to
 * different rows from the SAME governed metric — engine-level, never
 * client-side row hiding.
 *
 * Pure + I/O-free (crypto only) so it is fully unit-testable. IL5: the token is
 * minted + verified entirely in-boundary; no external egress.
 */

import crypto from 'node:crypto';
import type { MetricFilter } from '@/lib/metrics/metric-compiler';

/** Bearer prefix — `loom_embed_<payload>.<sig>`. */
export const EMBED_TOKEN_PREFIX = 'loom_embed_';
/** Single audience — an embed token is ONLY valid at the embed data endpoint. */
export const EMBED_AUDIENCE = 'loom-embed';
/** Issuer stamped into every token. */
export const EMBED_ISSUER = 'csa-loom';
/** Default token lifetime (seconds) when the caller doesn't specify one. */
export const EMBED_DEFAULT_TTL_SECS = 10 * 60; // 10 min
/** Hard ceiling on token lifetime (seconds). A mint above this clamps down. */
export const EMBED_MAX_TTL_SECS = 60 * 60; // 1 h
/** Floor on token lifetime (seconds) — a positive-but-tiny TTL clamps up. */
export const EMBED_MIN_TTL_SECS = 30;
/** Max distinct RLS dimensions carried in one token (abuse cap). */
export const EMBED_MAX_RLS_DIMENSIONS = 32;

/** An RLS claim value: a scalar (compiled to `=`) or an array (compiled to `in`). */
export type RlsClaimValue = string | number | Array<string | number>;

/** RLS predicate claims: governed dimension name → the identity's allowed value(s). */
export interface RlsClaims {
  [dimension: string]: RlsClaimValue;
}

/** The viewer the token represents + its RLS claims. */
export interface EffectiveIdentity {
  /** Stable identifier of the viewer (audit provenance; e.g. an email or app-user id). */
  sub: string;
  /** RLS claims applied at query time. Empty ⇒ no row-level restriction. */
  rls: RlsClaims;
}

/** The verified payload carried inside a token. */
export interface EmbedTokenClaims {
  /** The report the token is scoped to (provenance + audit; the query resolves the owner's governed metrics). */
  reportId: string;
  /** Spec-owner Entra oid — the governed-metric partition + the audit tenant owner. */
  oid: string;
  /** Spec-owner tenant id. */
  tid: string;
  /** Effective viewer identity (audit). */
  sub: string;
  /** The identity's RLS claims (applied at query time by the metric compiler). */
  rls: RlsClaims;
  /** Single audience — always {@link EMBED_AUDIENCE}. */
  aud: string;
  /** Issuer — always {@link EMBED_ISSUER}. */
  iss: string;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). */
  exp: number;
}

/** Input to {@link mintEmbedToken}. */
export interface MintEmbedTokenInput {
  reportId: string;
  /** The signed-in owner minting the token — becomes the governed-metric partition. */
  owner: { oid: string; tid: string };
  identity: EffectiveIdentity;
  /** Requested lifetime (seconds) — clamped to [MIN, MAX], defaulting when absent/invalid. */
  ttlSeconds?: number;
  /** Injectable clock (ms) for deterministic tests. */
  now?: number;
}

/** Result of a mint — the one-time token string + its decoded claims. */
export interface MintedEmbedToken {
  token: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
  /** Expiry (unix seconds). */
  expiresAtEpoch: number;
  claims: EmbedTokenClaims;
}

// ── Signing key (HKDF from SESSION_SECRET) ───────────────────────────────────

function embedSigningKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const ab = crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf-8'),
    Buffer.alloc(32),
    Buffer.from('loom-embed-token-v1'),
    32,
  );
  return Buffer.from(ab as ArrayBuffer);
}

/** HMAC-SHA256 of the payload segment → base64url. */
function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', embedSigningKey()).update(payloadB64).digest('base64url');
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Clamp a requested TTL (seconds) into [MIN, MAX], defaulting when absent/invalid. */
export function clampEmbedTtl(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return EMBED_DEFAULT_TTL_SECS;
  return Math.min(Math.max(Math.floor(n), EMBED_MIN_TTL_SECS), EMBED_MAX_TTL_SECS);
}

/**
 * Sanitize raw RLS claims into the canonical {@link RlsClaims} shape: keep only
 * scalar (string/finite-number) or array-of-scalar values, drop everything else,
 * and cap the dimension count. Dimension NAMES are NOT trusted here — they are
 * whitelisted against the governed model by the compiler (an unknown dimension
 * fails the query closed), so this only guarantees value well-formedness.
 */
export function normalizeRlsClaims(raw: unknown): RlsClaims {
  const out: RlsClaims = {};
  if (!raw || typeof raw !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= EMBED_MAX_RLS_DIMENSIONS) break;
    const dim = String(k || '').trim();
    if (!dim) continue;
    if (Array.isArray(v)) {
      const vals = v.filter((x): x is string | number =>
        typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)),
      );
      if (!vals.length) continue;
      out[dim] = vals;
      n++;
    } else if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      out[dim] = v;
      n++;
    }
  }
  return out;
}

/**
 * Convert an identity's RLS claims into structured {@link MetricFilter}
 * predicates for the N15 compiler: a scalar becomes `= value`, an array becomes
 * `in [values]`. Values are NEVER spliced — the compiler binds them as TDS
 * parameters / escapes them through the central quoting helpers.
 */
export function rlsClaimsToFilters(rls: RlsClaims | undefined | null): MetricFilter[] {
  if (!rls) return [];
  const out: MetricFilter[] = [];
  for (const [dimension, value] of Object.entries(rls)) {
    if (value === null || value === undefined) continue;
    const dim = dimension.trim();
    if (!dim) continue;
    if (Array.isArray(value)) {
      const vals = value.filter((v) => v !== null && v !== undefined);
      if (!vals.length) continue;
      out.push({ dimension: dim, op: 'in', value: vals });
    } else {
      out.push({ dimension: dim, op: '=', value });
    }
  }
  return out;
}

// ── Mint / verify ────────────────────────────────────────────────────────────

/**
 * Mint a short-lived, scoped, signed embed token for one effective identity.
 * TTL is clamped to [MIN, MAX]; the RLS claims are normalized; the payload is
 * HMAC-signed with the derived key. Pure (crypto only) — the route wraps this
 * with the audit write.
 */
export function mintEmbedToken(input: MintEmbedTokenInput): MintedEmbedToken {
  const now = input.now ?? Date.now();
  const iat = Math.floor(now / 1000);
  const exp = iat + clampEmbedTtl(input.ttlSeconds);
  const claims: EmbedTokenClaims = {
    reportId: String(input.reportId || '').trim(),
    oid: input.owner.oid,
    tid: input.owner.tid || input.owner.oid,
    sub: String(input.identity.sub || '').trim() || input.owner.oid,
    rls: normalizeRlsClaims(input.identity.rls),
    aud: EMBED_AUDIENCE,
    iss: EMBED_ISSUER,
    iat,
    exp,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf-8').toString('base64url');
  const token = `${EMBED_TOKEN_PREFIX}${payloadB64}.${sign(payloadB64)}`;
  return { token, expiresAt: new Date(exp * 1000).toISOString(), expiresAtEpoch: exp, claims };
}

/**
 * Verify a token: check the prefix + shape, recompute the HMAC and compare in
 * CONSTANT TIME, then validate the audience, issuer, and expiry. Returns the
 * decoded claims on success or `null` for ANY failure (malformed, wrong
 * signature, wrong audience, expired). NEVER throws — a bad token is simply a
 * denied use the caller maps to 401.
 */
export function verifyEmbedToken(
  token: string | null | undefined,
  now: number = Date.now(),
): EmbedTokenClaims | null {
  if (!token) return null;
  const t = token.trim();
  if (!t.startsWith(EMBED_TOKEN_PREFIX)) return null;
  const rest = t.slice(EMBED_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot >= rest.length - 1) return null;
  const payloadB64 = rest.slice(0, dot);
  const providedSig = rest.slice(dot + 1);

  // Constant-time signature comparison (compare raw HMAC bytes; a wrong length
  // short-circuits without leaking timing).
  let expected: Buffer;
  try {
    expected = crypto.createHmac('sha256', embedSigningKey()).update(payloadB64).digest();
  } catch {
    return null;
  }
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSig, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  let claims: EmbedTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as EmbedTokenClaims;
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  if (claims.aud !== EMBED_AUDIENCE || claims.iss !== EMBED_ISSUER) return null;
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return null;
  if (!claims.oid || !claims.reportId) return null;
  // Defensive: re-normalize the RLS claims so a hand-crafted (but validly
  // signed, i.e. same-key) payload can't smuggle a non-scalar into the compiler.
  claims.rls = normalizeRlsClaims(claims.rls);
  return claims;
}

/**
 * Extract an embed token from an `Authorization: Bearer …` value (or a bare
 * `x-loom-embed-token` value). Returns the raw token only when it carries the
 * embed prefix, else null (so a PAT/cookie header is ignored, not mis-parsed).
 */
export function parseEmbedAuthHeader(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  const bearer = /^bearer\s+(.+)$/i.exec(trimmed);
  const raw = bearer ? bearer[1].trim() : trimmed;
  return raw.startsWith(EMBED_TOKEN_PREFIX) ? raw : null;
}
