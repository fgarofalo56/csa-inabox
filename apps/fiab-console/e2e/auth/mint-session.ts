/**
 * Unattended session-cookie minter for the CSA Loom verification harness.
 *
 * Replicates `encodeSessionCookie` from lib/auth/session.ts using ONLY
 * Node.js built-ins — intentionally does NOT import from lib/auth/session.ts
 * because that module pulls in `next/headers`, which throws outside the
 * Next.js runtime (would break Playwright global-setup and CI).
 *
 * Security note: SESSION_SECRET is read exclusively from process.env.
 * It must NEVER be hardcoded, logged, or committed.
 *
 * Encoding (must match lib/auth/session.ts exactly):
 *   key  = HKDF-SHA-256(ikm=SESSION_SECRET, salt=32×0x00, info='loom-session-v1', len=32)
 *   body = AES-256-GCM encrypt(JSON.stringify({ claims, exp }))
 *   wire = base64url( iv(12) || authTag(16) || ciphertext )
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types (mirrors lib/auth/msal.ts — copied to avoid the next/headers pull)
// ---------------------------------------------------------------------------
export interface UserClaims {
  oid: string;
  name: string;
  email?: string;
  upn: string;
  groups?: string[];
}

export interface SessionPayload {
  claims: UserClaims;
  /** Unix epoch seconds. */
  exp: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const ALG = 'aes-256-gcm' as const;
const IV_LEN = 12;
const TAG_LEN = 16;
const HKDF_INFO = 'loom-session-v1';
const COOKIE_NAME = 'loom_session';

/**
 * A placeholder/sentinel oid — all-zero except the final nibble. The TS mirror
 * of the same constant in mint-cookie.mjs; both exist because this module
 * deliberately imports nothing (see the header note on next/headers).
 */
const PLACEHOLDER_OID = /^0{8}-0{4}-0{4}-0{4}-0{11}[0-9a-f]$/i;

/**
 * An Entra object id is a single GUID. Anything else is not one. The TS mirror
 * of `GUID_RE` in mint-cookie.mjs (itself byte-identical to the one in
 * scripts/ci/resolve-automation-oid.mjs); the drift guard pins all of it.
 */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Refuse to mint under an absent, malformed, or placeholder oid.
 *
 * A minted session performs REAL writes, and Cosmos partitions `workspaces` on
 * the creator oid — so a placeholder writes into a partition no principal can
 * sign in and enumerate. That debris reports success and is invisible
 * afterwards (#3801/#3804).
 *
 * The parameter is deliberately typed `oid?: string | null` rather than
 * `Pick<UserClaims, 'oid'>`. This function's whole purpose is the absent case,
 * and a required `oid: string` declares that case impossible — which forces a
 * caller holding `string | undefined` (every `process.env` read) to write
 * `as string` on the very value being validated. A cast that silences the
 * checker at the guard is how a fail-open gets reintroduced (#3804).
 *
 * @param claims - the claims about to be sealed into the cookie.
 * @returns the validated oid.
 */
export function requireAutomationOid(claims: { oid?: string | null }): string {
  // NORMALIZE BEFORE TESTING, and hand the normalized value back (#3805 review).
  // Kept byte-identical to the expression in mint-cookie.mjs — the drift guard in
  // e2e/auth/__tests__/require-automation-oid.test.mjs compares the two files and
  // fails if they diverge.
  //
  // Testing the RAW string let every padded placeholder through: "…0001\r",
  // "…0001 " and " …0001" were all ACCEPTED while the bare form was refused.
  // GitHub does not trim repo-variable values and `az -o tsv` carries CR, so the
  // padded form is the realistic one — and it seals a claim that matches neither
  // a real principal nor `LOOM_TENANT_ADMIN_OID`, i.e. an unreachable partition
  // AND a silent drop to non-admin.
  //
  // `|| ''` rather than `?? ''` on purpose: normalization must not widen what is
  // accepted, and `??` would turn a falsy non-null oid into a passing string.
  const oid = String((claims && claims.oid) || '')
    .replace(/\r/g, '')
    .trim();
  if (!oid) {
    throw new Error(
      '[mint-session] claims.oid is required and was not set.\n' +
      '  A minted session performs REAL writes and Cosmos partitions on the creator oid,\n' +
      '  so it must run as a real principal. Set LOOM_AUTOMATION_OID (or UAT_OID) to the\n' +
      '  automation identity for this estate. Refusing to mint without one (#3804).',
    );
  }
  if (oid.includes(',')) {
    throw new Error(
      `[mint-session] claims.oid is a comma-separated list (${oid}) and was refused.\n` +
      '  feature-gate.ts compares session.claims.oid === LOOM_TENANT_ADMIN_OID with strict\n' +
      '  equality, so "a,b" matches neither a nor b — the run mints, drops to non-admin, and\n' +
      '  reports the resulting 403s as endpoint defects.\n' +
      '  Set LOOM_AUTOMATION_OID (or UAT_OID) to a single object id.',
    );
  }
  if (!GUID_RE.test(oid)) {
    throw new Error(
      `[mint-session] claims.oid is not a GUID (${oid}) and was refused.\n` +
      '  It names no Entra object, so the session it would mint asserts an identity that\n' +
      '  cannot sign in — the same unreachable-partition debris a placeholder produces\n' +
      '  (#3801/#3804), reached by a different route.\n' +
      '  Set LOOM_AUTOMATION_OID (or UAT_OID) to a real automation identity.',
    );
  }
  if (PLACEHOLDER_OID.test(oid)) {
    throw new Error(
      `[mint-session] claims.oid is a placeholder (${oid}) and was refused.\n` +
      '  Writes under a placeholder land in a Cosmos partition no principal can sign in to\n' +
      '  and enumerate — invisible debris that reports success (#3801/#3804).\n' +
      '  Set LOOM_AUTOMATION_OID (or UAT_OID) to a real automation identity.',
    );
  }
  return oid;
}

/** Derive the AES-256 key from SESSION_SECRET — identical to lib/auth/session.ts */
function deriveKey(sessionSecret: string): Buffer {
  const ab = crypto.hkdfSync(
    'sha256',
    Buffer.from(sessionSecret, 'utf-8'),
    Buffer.alloc(32),               // salt: 32 zero bytes (matches server)
    Buffer.from(HKDF_INFO),
    32,
  );
  return Buffer.from(ab as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Mint a `loom_session` cookie value identical to the one the BFF writes.
 *
 * Reads SESSION_SECRET from process.env — throws immediately if absent.
 *
 * @param claims - Identity claims baked into the session.
 * @param ttlSecs - Cookie lifetime in seconds (default 8 hours = 28800).
 * @returns base64url-encoded cookie value.
 */
export function mintLoomSessionCookie(
  claims: UserClaims,
  ttlSecs = 28_800,
): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      '[mint-session] SESSION_SECRET env var is required. ' +
      'Pull it at runtime from the loom Key Vault (secret name: session-secret) ' +
      'and set it via ::add-mask:: before this step.',
    );
  }
  // Guard the identity here, not only at each call site — this is the single
  // chokepoint every TS caller (mintStorageState, global-setup, the specs)
  // funnels through, mirroring requireAutomationOid in mint-cookie.mjs (#3804).
  //
  // SEAL THE VALIDATED VALUE (#3805 review). Calling the guard for its throw and
  // then encrypting `claims` verbatim would validate one string and ship another.
  const sealed: UserClaims = { ...claims, oid: requireAutomationOid(claims) };

  const key = deriveKey(secret);
  const payload: SessionPayload = {
    claims: sealed,
    exp: Math.floor(Date.now() / 1000) + ttlSecs,
  };

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // wire = iv || authTag || ciphertext  →  base64url
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/**
 * Build a Playwright `storageState` object pre-loaded with a minted
 * `loom_session` cookie so tests skip the MSAL browser flow entirely.
 *
 * @param opts.baseUrl - The console URL (e.g. https://loom-console.b02.azurefd.net)
 * @param opts.claims  - Identity claims for the automation identity.
 * @param opts.ttlSecs - Cookie TTL in seconds (default 28 800 = 8 h).
 */
export function mintStorageState(opts: {
  baseUrl: string;
  claims: UserClaims;
  ttlSecs?: number;
}): import('@playwright/test').BrowserContextOptions['storageState'] {
  const { baseUrl, claims, ttlSecs = 28_800 } = opts;
  const host = new URL(baseUrl).hostname;
  const cookieValue = mintLoomSessionCookie(claims, ttlSecs);
  const expires = Math.floor(Date.now() / 1000) + ttlSecs;

  return {
    cookies: [
      {
        name: COOKIE_NAME,
        value: cookieValue,
        domain: host,
        path: '/',
        expires,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
}
