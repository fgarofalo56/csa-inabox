import { describe, it, expect } from 'vitest';
import { isSecretEnvKey } from '../secret-env-key';

/**
 * isSecretEnvKey — the env-var secret detector.
 *
 * IT REPLACES TWO REGEXES THAT DISAGREED WITH EACH OTHER.
 *
 *   lib/admin/env-config.ts      …|_KEY$|_KEYS$|_PWD$|_WEBHOOK_URL$/i
 *   lib/components/shared/honest-gate.tsx
 *                                …|_KEY$|_KEYS$|_PWD$|TOKEN$/i
 *
 * so a Teams webhook URL was '***' in the support bundle and typed into a
 * PLAINTEXT input in the Fix-it wizard, and anything ending TOKEN was the exact
 * reverse. Both also carried the #2772 mixed-anchor parse trap: alternation
 * binds looser than `$`, so `SECRET`/`PASSWORD` matched anywhere while only the
 * trailing alternatives were anchored.
 *
 * The first block below is the leak: measured across the repo's 1203 env-var
 * names, these all returned FALSE from env-config's masker.
 */

describe('isSecretEnvKey — bearer tokens the env-config regex LEAKED', () => {
  it.each([
    'LOOM_INTERNAL_TOKEN', 'LOOM_SCIM_BEARER_TOKEN', 'LOOM_PURVIEW_TOKEN',
    'LOOM_FEEDBACK_GITHUB_TOKEN', 'LOOM_ICEBERG_CATALOG_TOKEN', 'LOOM_UNITY_TOKEN',
    'LOOM_GRAPH_TOKEN', 'LOOM_ARM_TOKEN', 'LOOM_TRINO_TOKEN',
  ])('treats %s as secret', (k) => {
    expect(isSecretEnvKey(k)).toBe(true);
    // Pin the regression against the exact regex that missed it.
    expect(/SECRET|PASSWORD|CONNECTION_STRING|CONNECTIONSTRING|_KEY$|_KEYS$|_PWD$|_WEBHOOK_URL$/i.test(k)).toBe(false);
  });
});

describe('isSecretEnvKey — the webhook URL honest-gate typed in cleartext', () => {
  it.each(['LOOM_ALERT_WEBHOOK_URL', 'LOOM_TEAMS_WEBHOOK_URL'])('treats %s as secret', (k) => {
    // An incoming-webhook URL embeds a bearer token in its path, so the URL IS
    // the credential.
    expect(isSecretEnvKey(k)).toBe(true);
    expect(/SECRET|PASSWORD|CONNECTION_STRING|CONNECTIONSTRING|_KEY$|_KEYS$|_PWD$|TOKEN$/i.test(k)).toBe(false);
  });
});

describe('isSecretEnvKey — everything BOTH old regexes caught (no regression)', () => {
  it.each([
    'SESSION_SECRET', 'LOOM_MSAL_CLIENT_SECRET', 'LOOM_PG_PASSWORD',
    'LOOM_COSMOS_CONNECTION_STRING', 'LOOM_ADX_API_KEY', 'LOOM_SEARCH_KEYS',
    'LOOM_SQL_PWD',
  ])('treats %s as secret', (k) => {
    expect(isSecretEnvKey(k)).toBe(true);
  });
});

describe('isSecretEnvKey — locators must NOT be masked', () => {
  // Masking these would replace a useful diagnostic with '***' in a support
  // bundle and put a plain value behind a password field.
  it.each([
    'LOOM_KEY_VAULT_NAME', 'LOOM_KEY_VAULT_URI', 'LOOM_COSMOS_ENDPOINT',
    'LOOM_SUBSCRIPTION_ID', 'LOOM_SYNAPSE_WORKSPACE', 'LOOM_NOTEBOOK_EXEC_BACKEND',
  ])('leaves %s alone', (k) => {
    expect(isSecretEnvKey(k)).toBe(false);
  });
});

describe('isSecretEnvKey — quantities and policies ABOUT a credential', () => {
  // The over-correction direction, and the reason QUANTITY_SUFFIX exists: a
  // suffix rule without it masks an integer and a duration.
  it.each([
    ['LOOM_COPILOT_MEMORY_RECALL_MAX_TOKENS', 'a token COUNT, not key material'],
    ['LOOM_SHARING_CREDENTIAL_VALIDITY_SECONDS', 'a duration'],
    ['LOOM_SECRET_EXPIRY_WARN_DAYS', 'a day count — the old regex masked it for nothing'],
  ])('leaves %s alone (%s)', (k) => {
    expect(isSecretEnvKey(k)).toBe(false);
  });
});

describe('isSecretEnvKey — edge cases', () => {
  it('is case-insensitive and separator-tolerant', () => {
    expect(isSecretEnvKey('loom_adx_api_key')).toBe(true);
    expect(isSecretEnvKey('LOOM-ADX-API-KEY')).toBe(true);
  });

  it('handles empty / junk input without throwing', () => {
    expect(isSecretEnvKey('')).toBe(false);
    expect(isSecretEnvKey('   ')).toBe(false);
    expect(isSecretEnvKey('___')).toBe(false);
  });

  it('does NOT inherit the mixed-anchor parse: a word before the end still counts', () => {
    // `/…|_KEY$/` said false here because _KEY is not at the end. The whole
    // point of the word rule is that position does not silently decide.
    expect(isSecretEnvKey('LOOM_SECRET_ROTATION_HOOK')).toBe(true);
  });
});
