/**
 * Unit tests for the Databricks account-plane Unity Catalog client
 * (lib/azure/unity-catalog-account-client.ts).
 *
 * These exercise pure, side-effect-free logic only — error classification and
 * env-driven configuration gating. They never hit accounts.azuredatabricks.net
 * (no token is acquired), so they're safe to run in CI per no-vaporware.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnityCatalogAccountError,
  UnityCatalogAccountNotConfiguredError,
  isAccountApiConfigured,
} from '../unity-catalog-account-client';

describe('UnityCatalogAccountError.accountAdmin classification', () => {
  it('flags a 403 whose message names account admin', () => {
    const e = new UnityCatalogAccountError('User is not an account admin for Account abc', 403);
    expect(e.accountAdmin).toBe(true);
    expect(e.status).toBe(403);
  });

  it('flags the hyphenated phrasing too', () => {
    const e = new UnityCatalogAccountError('caller must be an account-admin', 403);
    expect(e.accountAdmin).toBe(true);
  });

  it('does NOT flag a non-403 even if it mentions admin', () => {
    const e = new UnityCatalogAccountError('account admin required', 401);
    expect(e.accountAdmin).toBe(false);
  });

  it('does NOT flag a generic 403', () => {
    const e = new UnityCatalogAccountError('forbidden', 403);
    expect(e.accountAdmin).toBe(false);
  });
});

describe('isAccountApiConfigured', () => {
  const prev = process.env.LOOM_DATABRICKS_ACCOUNT_ID;
  beforeEach(() => { delete process.env.LOOM_DATABRICKS_ACCOUNT_ID; });
  afterEach(() => {
    if (prev === undefined) delete process.env.LOOM_DATABRICKS_ACCOUNT_ID;
    else process.env.LOOM_DATABRICKS_ACCOUNT_ID = prev;
  });

  it('is false when the account id env var is unset', () => {
    expect(isAccountApiConfigured()).toBe(false);
  });

  it('is true once the account id env var is set', () => {
    process.env.LOOM_DATABRICKS_ACCOUNT_ID = '11111111-2222-3333-4444-555555555555';
    expect(isAccountApiConfigured()).toBe(true);
  });
});

describe('UnityCatalogAccountNotConfiguredError', () => {
  it('carries a structured hint naming the env var + bicep module', () => {
    const e = new UnityCatalogAccountNotConfiguredError({
      missingEnvVar: 'LOOM_DATABRICKS_ACCOUNT_ID',
      bicepModule: 'm',
      bicepStatus: 's',
      followUp: 'f',
    });
    expect(e.hint.missingEnvVar).toBe('LOOM_DATABRICKS_ACCOUNT_ID');
    expect(e).toBeInstanceOf(Error);
  });
});
