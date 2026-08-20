/**
 * Playwright setup project — mints a loom_session cookie from SESSION_SECRET
 * and writes a Playwright storageState file so every `verify` project test
 * runs pre-authenticated with NO MSAL flow, NO MFA, NO user credentials.
 *
 * This file is a Playwright TEST FILE (uses `test` from @playwright/test) so
 * it can be referenced by the `mint` setup project and depended upon by the
 * `verify` project via `dependencies: ['mint']`.  Playwright 1.48+ auth-setup
 * pattern: https://playwright.dev/docs/auth#basic-shared-account-in-all-tests
 *
 * Required env vars:
 *   SESSION_SECRET      — the HKDF input key (pulled from KV in CI, never hardcoded)
 *   LOOM_URL            — console base URL (e.g. https://loom-console.b02.azurefd.net)
 *   LOOM_AUTOMATION_OID — object ID of the automation identity. REQUIRED as of
 *                         #3804: the suite writes for real and Cosmos partitions
 *                         on the creator oid, so there is no safe default.
 *                         (LOOM_AUTOMATION_TENANT_OID is accepted as an alias.)
 *
 * Optional env vars (automation identity claims):
 *   LOOM_AUTOMATION_UPN   — UPN / email for the minted session
 *   LOOM_AUTOMATION_NAME  — display name in the minted session
 *   LOOM_AUTOMATION_EMAIL — email claim (optional; falls back to UPN)
 */

import fs from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';
import { mintStorageState } from './mint-session';

/** Path where Playwright storageState is written (gitignored). */
export const STORAGE_STATE_PATH = path.resolve(
  __dirname,
  '..',
  '.auth',
  'loom-state.json',
);

setup('mint loom_session cookie', async () => {
  // ---- required vars -------------------------------------------------------
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error(
      '[global-setup] SESSION_SECRET is required.\n' +
      '  In CI: fetch it from the loom Key Vault (secret name: session-secret) ' +
      'using `az keyvault secret show` and mask it with ::add-mask:: before this step.\n' +
      '  Locally: export SESSION_SECRET=$(az keyvault secret show ' +
      '--vault-name <loom-kv> --name session-secret --query value -o tsv)',
    );
  }

  const loomUrl = process.env.LOOM_URL;
  if (!loomUrl) {
    throw new Error(
      '[global-setup] LOOM_URL is required (e.g. https://loom-console.b02.azurefd.net).',
    );
  }

  // ---- automation identity claims -----------------------------------------
  // No fallback oid. This setup mints the storageState the ENTIRE Playwright
  // suite runs under, and every write it makes is partitioned in Cosmos on the
  // creator oid. A sentinel here produced green specs whose writes landed in a
  // partition no principal could sign in and enumerate — the mechanism behind
  // the orphans in #3801. Fail closed instead (#3804); mintLoomSessionCookie
  // enforces the same rule at the chokepoint.
  const oid =
    process.env.LOOM_AUTOMATION_OID ||
    process.env.LOOM_AUTOMATION_TENANT_OID;

  if (!oid) {
    throw new Error(
      '[global-setup] LOOM_AUTOMATION_OID (or LOOM_AUTOMATION_TENANT_OID) is required.\n' +
      '  The suite mints a REAL session and performs REAL writes, so it must run as a\n' +
      '  real principal. Refusing to substitute a sentinel oid (#3804).\n' +
      '  In CI: set it to the automation identity for this estate.',
    );
  }

  const upn =
    process.env.LOOM_AUTOMATION_UPN ||
    'loom-verify@automation.local';

  const name =
    process.env.LOOM_AUTOMATION_NAME ||
    'Loom Verify [automation]';

  const email =
    process.env.LOOM_AUTOMATION_EMAIL ||
    process.env.LOOM_AUTOMATION_UPN;

  const claims = {
    oid,
    name,
    upn,
    ...(email ? { email } : {}),
  };

  // ---- mint storageState ---------------------------------------------------
  const storageState = mintStorageState({ baseUrl: loomUrl, claims });

  // ---- write to disk -------------------------------------------------------
  const dir = path.dirname(STORAGE_STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2));

  console.log(
    `[mint-setup] minted session for oid=${oid} upn=${upn}\n` +
    `             storageState → ${STORAGE_STATE_PATH}\n` +
    `             target       → ${loomUrl}`,
  );
});
