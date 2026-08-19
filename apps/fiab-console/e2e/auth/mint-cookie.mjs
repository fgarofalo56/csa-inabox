/**
 * Shared, pure-Node ESM session minter for the CSA Loom verification harness.
 *
 * This is the SINGLE source of the cookie-mint algorithm for `.mjs` tooling
 * (the receipt driver, ad-hoc scripts). It is byte-for-byte identical to the
 * scheme in:
 *   - apps/fiab-console/lib/auth/session.ts       (the BFF encoder)
 *   - apps/fiab-console/e2e/auth/mint-session.ts  (the Playwright setup minter)
 *
 * It intentionally imports NOTHING from the TypeScript source tree (that pulls
 * in `next/headers`, which throws outside the Next.js runtime) and NOTHING from
 * outside Node built-ins, so it runs anywhere Node runs — a laptop over the
 * P2S VPN, the in-VNet gh-aca-runner, or the loom-uat Container App Job.
 *
 * Encoding (must match lib/auth/session.ts exactly):
 *   key  = HKDF-SHA-256(ikm=SESSION_SECRET, salt=32×0x00, info='loom-session-v1', len=32)
 *   body = AES-256-GCM encrypt(JSON.stringify({ claims, exp }))
 *   wire = base64url( iv(12) || authTag(16) || ciphertext )
 *
 * Security: SESSION_SECRET is read exclusively from process.env or passed in.
 * It must NEVER be hardcoded, logged, or committed.
 */

import crypto from 'node:crypto';

export const ALG = 'aes-256-gcm';
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const HKDF_INFO = 'loom-session-v1';
export const COOKIE_NAME = 'loom_session';

/** Derive the AES-256 key from SESSION_SECRET — identical to lib/auth/session.ts. */
export function deriveKey(sessionSecret) {
  const ab = crypto.hkdfSync(
    'sha256',
    Buffer.from(sessionSecret, 'utf-8'),
    Buffer.alloc(32), // salt: 32 zero bytes (matches server)
    Buffer.from(HKDF_INFO),
    32,
  );
  return Buffer.from(ab);
}

/**
 * Resolve SESSION_SECRET from an explicit arg or process.env, throwing a
 * precise, actionable error when it is absent (never a bare undefined deref).
 */
export function requireSessionSecret(explicit) {
  const secret = explicit || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      '[mint-cookie] SESSION_SECRET is required and was not set.\n' +
        '  Local (VPN): export SESSION_SECRET=$(az keyvault secret show ' +
        '--vault-name <loom-kv> --name session-secret --query value -o tsv)\n' +
        '  CI (in-VNet): the loom-ui-verify workflow fetches it from Key Vault via OIDC ' +
        'and masks it with ::add-mask:: before this step.',
    );
  }
  return secret;
}

/**
 * A placeholder object id: all-zeros, or all-zeros with a single non-zero final
 * hex digit. Observed in the wild as `…0000` (tests/*.mjs, demo-seed),
 * `…0001` (e2e-receipt, parity-autopilot) and `…000e` (cleanup-test-workspaces,
 * workspace-identity-enforce) — three mutually-invisible fake partitions.
 *
 * A real Entra oid of this shape does not occur; if one somehow did, the error
 * below names the value so the operator can see exactly what was rejected.
 */
const PLACEHOLDER_OID = /^0{8}-0{4}-0{4}-0{4}-0{11}[0-9a-f]$/i;

/**
 * Resolve the automation identity, throwing when it is absent or a placeholder.
 *
 * WHY THIS IS FAIL-CLOSED, symmetric with requireSessionSecret (#3804).
 *
 * A minted session performs REAL writes. `workspaces` is partitioned by
 * /tenantId == the creator's oid, so a placeholder oid does not merely mislabel
 * the run — it writes into a partition no principal can ever sign in to and
 * enumerate. Nothing fails at the time: the route returns 200 and the
 * provisioner reports `created`.
 *
 * On 2026-07-12 that left 24 `tut-app-*` workspaces owned by the zero GUID, and
 * 24 of 32 semantic models have rendered empty editors ever since (#3801). The
 * debris survived five weeks because `cleanup-test-workspaces.mjs` defaults to a
 * DIFFERENT placeholder (…000e) and `GET /api/workspaces` scopes on
 * `session.claims.oid` (app/api/workspaces/route.ts:22) — so the cleanup tool
 * enumerated an empty partition, found nothing, and exited 0.
 *
 * A KNOWN synthetic automation oid is a documented, tolerated cost with an
 * operator-side cleanup path (scripts/csa-loom/purge-test-workspaces.sh). A
 * placeholder is different in kind: its debris is attributable to nothing, so
 * recovery by owner is impossible in principle.
 *
 * @param {object} claims - the claims about to be baked into a session.
 * @returns {string} the validated oid.
 */
export function requireAutomationOid(claims) {
  const oid = claims && claims.oid;
  if (!oid) {
    throw new Error(
      '[mint-cookie] claims.oid is required and was not set.\n' +
        '  A minted session performs REAL writes and Cosmos partitions on the creator oid,\n' +
        '  so it must run as a real principal. Set UAT_OID or LOOM_AUTOMATION_OID to the\n' +
        '  automation identity for this estate. Refusing to mint without one (#3804).',
    );
  }
  if (PLACEHOLDER_OID.test(String(oid))) {
    throw new Error(
      `[mint-cookie] claims.oid is a placeholder (${oid}) and was refused.\n` +
        '  Writes under a placeholder land in a Cosmos partition no principal can sign in to\n' +
        '  and enumerate — invisible debris that reports success (#3801/#3804).\n' +
        '  Set UAT_OID or LOOM_AUTOMATION_OID to a real automation identity.',
    );
  }
  return String(oid);
}

/**
 * Mint a `loom_session` cookie value identical to the one the BFF writes.
 *
 * @param {object}  claims          - Identity claims baked into the session.
 * @param {string}  claims.oid      - Object id of the automation identity.
 * @param {string}  claims.name     - Display name.
 * @param {string}  claims.upn      - UPN / email.
 * @param {string} [claims.email]   - Optional email claim.
 * @param {number} [ttlSecs=28800]  - Cookie lifetime in seconds (default 8 h).
 * @param {string} [sessionSecret]  - Explicit secret; defaults to process.env.SESSION_SECRET.
 * @returns {string} base64url-encoded cookie value.
 */
export function mintLoomSessionCookie(claims, ttlSecs = 28_800, sessionSecret) {
  const secret = requireSessionSecret(sessionSecret);
  requireAutomationOid(claims);
  const key = deriveKey(secret);
  const payload = { claims, exp: Math.floor(Date.now() / 1000) + ttlSecs };
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plain = Buffer.from(JSON.stringify(payload), 'utf-8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

/**
 * Decode + verify a `loom_session` cookie value back into its payload.
 *
 * Used by the receipt driver's `--dry-run` self-test to prove the mint round
 * trips (decrypt succeeds + claims/exp survive) WITHOUT needing the live
 * console — a fast, offline guarantee that the crypto is correct before we
 * ever open a browser.
 *
 * @returns {{claims: object, exp: number}} the decrypted payload.
 */
export function decodeLoomSessionCookie(cookieValue, sessionSecret) {
  const secret = requireSessionSecret(sessionSecret);
  const key = deriveKey(secret);
  const wire = Buffer.from(cookieValue, 'base64url');
  const iv = wire.subarray(0, IV_LEN);
  const tag = wire.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = wire.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf-8'));
}

/**
 * Build a Playwright `storageState` object pre-loaded with a minted
 * `loom_session` cookie so browser sessions skip the MSAL flow entirely.
 *
 * @param {object}  opts
 * @param {string}  opts.baseUrl        - Console URL (e.g. https://csa-loom.limitlessdata.ai).
 * @param {object}  opts.claims         - Identity claims for the automation identity.
 * @param {number} [opts.ttlSecs=28800] - Cookie TTL in seconds.
 * @param {string} [opts.sessionSecret] - Explicit secret; defaults to env.
 */
export function buildStorageState(opts) {
  const { baseUrl, claims, ttlSecs = 28_800, sessionSecret } = opts;
  const host = new URL(baseUrl).hostname;
  const value = mintLoomSessionCookie(claims, ttlSecs, sessionSecret);
  const expires = Math.floor(Date.now() / 1000) + ttlSecs;
  return {
    cookies: [
      {
        name: COOKIE_NAME,
        value,
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
