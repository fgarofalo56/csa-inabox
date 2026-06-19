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

  const key = deriveKey(secret);
  const payload: SessionPayload = {
    claims,
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
