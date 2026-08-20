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
 * An Entra object id is a single GUID. Anything else is not one.
 *
 * Byte-identical to `GUID_RE` in scripts/ci/resolve-automation-oid.mjs, and the
 * drift guard in e2e/auth/__tests__/require-automation-oid.test.mjs pins it here
 * and in mint-session.ts. Until #3805 review this chokepoint validated NO shape
 * at all, so `"hello"`, `"1"`, `"<unset>"` and the literal string
 * `"LOOM_AUTOMATION_OID"` were all accepted and sealed — while the module beside
 * it rejected exactly those, on the same reasoning, in the same PR.
 */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Resolve the automation identity, throwing when it is absent, malformed, or a
 * placeholder.
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
 * recovery by owner is impossible in principle. A MALFORMED oid — `"hello"`,
 * `"<unset>"`, a comma-list — is the same kind of debris again: it names no
 * Entra object either, so it gets the same refusal (#3805 review).
 *
 * @param {object} claims - the claims about to be baked into a session.
 * @returns {string} the validated oid.
 */
export function requireAutomationOid(claims) {
  // NORMALIZE BEFORE TESTING, and hand the normalized value back (#3805 review).
  //
  // The first cut of this guard tested the RAW string, so every padded form of a
  // placeholder walked straight through it. Measured at this chokepoint:
  //
  //     "…0001"    -> refused        "…0001\r"  -> ACCEPTED
  //     "…0001 "   -> ACCEPTED       " …0001"   -> ACCEPTED
  //
  // That is not a theoretical input. `LOOM_AUTOMATION_OID` reaches this function
  // from a GitHub repo variable (GitHub does NOT trim variable values), from an
  // `az … -o tsv` / `gh … --json` read (both carry CR on this repo's own record),
  // and from a Git Bash `export` where a trailing space is invisible. Each of
  // those mints a session whose sealed claim is `"…0001 "` — a FOURTH distinct
  // unreachable Cosmos partition on top of the three the guard already names,
  // and one that also fails `oid === LOOM_TENANT_ADMIN_OID`, so the run silently
  // drops to non-admin and reports 403s as endpoint defects.
  //
  // `|| ''` rather than `?? ''` on purpose: `??` would let a falsy NON-null oid
  // (`0`, `false`) become the string "0"/"false" and pass the emptiness test that
  // the pre-normalization code failed closed on. Normalization must not widen
  // what is accepted.
  const oid = String((claims && claims.oid) || '')
    .replace(/\r/g, '')
    .trim();
  if (!oid) {
    throw new Error(
      '[mint-cookie] claims.oid is required and was not set.\n' +
        '  A minted session performs REAL writes and Cosmos partitions on the creator oid,\n' +
        '  so it must run as a real principal. Set UAT_OID or LOOM_AUTOMATION_OID to the\n' +
        '  automation identity for this estate. Refusing to mint without one (#3804).',
    );
  }
  if (oid.includes(',')) {
    throw new Error(
      `[mint-cookie] claims.oid is a comma-separated list (${oid}) and was refused.\n` +
        '  feature-gate.ts compares session.claims.oid === LOOM_TENANT_ADMIN_OID with strict\n' +
        '  equality, so "a,b" matches neither a nor b — the run mints, drops to non-admin, and\n' +
        '  reports the resulting 403s as endpoint defects.\n' +
        '  Set UAT_OID or LOOM_AUTOMATION_OID to a single object id.',
    );
  }
  if (!GUID_RE.test(oid)) {
    throw new Error(
      `[mint-cookie] claims.oid is not a GUID (${oid}) and was refused.\n` +
        '  It names no Entra object, so the session it would mint asserts an identity that\n' +
        '  cannot sign in — the same unreachable-partition debris a placeholder produces\n' +
        '  (#3801/#3804), reached by a different route.\n' +
        '  Set UAT_OID or LOOM_AUTOMATION_OID to a real automation identity.',
    );
  }
  if (PLACEHOLDER_OID.test(oid)) {
    throw new Error(
      `[mint-cookie] claims.oid is a placeholder (${oid}) and was refused.\n` +
        '  Writes under a placeholder land in a Cosmos partition no principal can sign in to\n' +
        '  and enumerate — invisible debris that reports success (#3801/#3804).\n' +
        '  Set UAT_OID or LOOM_AUTOMATION_OID to a real automation identity.',
    );
  }
  return oid;
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
  // SEAL THE VALIDATED VALUE, not the raw claim (#3805 review). Calling the
  // guard for its throw alone and then encrypting `claims` verbatim is a half
  // fix: the normalized string is what was checked, so the normalized string is
  // what must go into the cookie. Otherwise `"…-abc "` passes the guard and the
  // session still asserts an oid with a trailing space — which is a different
  // Cosmos partition key and a different `===` comparand than the one validated.
  const sealed = { ...claims, oid: requireAutomationOid(claims) };
  const key = deriveKey(secret);
  const payload = { claims: sealed, exp: Math.floor(Date.now() / 1000) + ttlSecs };
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
