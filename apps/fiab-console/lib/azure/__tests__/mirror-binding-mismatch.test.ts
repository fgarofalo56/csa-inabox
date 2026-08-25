/**
 * BEHAVIOURAL test for the shared `mirrorBindingMismatch()` helper.
 *
 * WHY THIS EXISTS, in its own words. The route population spec
 * (`mirror-route-mismatch-guard.test.ts`) asserts every mirrored-database route
 * CALLS this helper. That is presence, not enforcement: a mutation that makes
 * the helper return `null` for a real connection defeats all five routes at
 * once while the population spec stays green, because every call site is still
 * there. That exact mutation (M11) was run and was NOT caught until this file
 * existed — the "guard signals presence, not enforcement" trap.
 *
 * So this pins the helper's ANSWER, not its existence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ loadConnection: vi.fn() }));
vi.mock('../connections-store', () => ({ loadConnection: h.loadConnection }));
// Key Vault is never reached on this path; stub so the module graph stays light.
vi.mock('../kv-secrets-client', () => ({ getKeyVaultSecretValue: vi.fn() }));

import { mirrorBindingMismatch, resolveConnectionType, withSourceAuth } from '../connection-auth';
import { isMirrorConnectionCompatible } from '../mirror-source-compat';

const SNOWFLAKE_CONN = {
  id: 'conn-snow', name: 'snowflake-prod', type: 'snowflake',
  authMethod: 'key-pair', secretRef: 'kv-snow',
};
const SQL_CONN = {
  id: 'conn-sql', name: 'azure-sql-prod', type: 'azure-sql',
  authMethod: 'sql-password', secretRef: 'kv-sql', username: 'loom_reader',
};

beforeEach(() => { h.loadConnection.mockReset(); });

describe('mirrorBindingMismatch — the answer, not the call site', () => {
  it('REFUSES the incident pair: Snowflake connection under an Azure SQL mirror', async () => {
    h.loadConnection.mockResolvedValue(SNOWFLAKE_CONN);
    const mm = await mirrorBindingMismatch('tenant-1', 'AzureSqlDatabase', 'conn-snow');
    expect(mm, 'the shared helper no longer refuses the pair that caused the incident').not.toBeNull();
    expect(mm!.candidates).toEqual(['Snowflake']);
    expect(mm!.message).toMatch(/Azure SQL Database/);
    expect(mm!.message).toMatch(/Snowflake/);
    // The connection's own name is quoted so the operator knows which one.
    expect(mm!.message).toContain('"snowflake-prod"');
    // …and never a hostname the platform constructed. SUBSTRING, not regex:
    // an unanchored host regex is a CodeQL js/regex/missing-regexp-anchor high,
    // and anchoring one would weaken "appears nowhere" to "is not exactly this".
    // Both clouds' SQL suffixes — the one azure-sql-client appends is
    // cloud-dependent, so Commercial-only would miss a Gov leak.
    for (const host of ['database.windows.net', 'database.usgovcloudapi.net']) {
      expect(mm!.message, `refusal leaked the constructed host ${host}`).not.toContain(host);
    }
    for (const bad of [/getaddrinfo/i, /ENOTFOUND/i, /\b1433\b/]) {
      expect(mm!.message).not.toMatch(bad);
    }
  });

  it('ALLOWS a matching pair', async () => {
    h.loadConnection.mockResolvedValue(SQL_CONN);
    expect(await mirrorBindingMismatch('tenant-1', 'AzureSqlDatabase', 'conn-sql')).toBeNull();
  });

  it('EMBEDDED CONTROL: it really did consult the store', async () => {
    // Without this, a helper that short-circuits before the lookup would satisfy
    // the "ALLOWS a matching pair" case vacuously.
    h.loadConnection.mockResolvedValue(SQL_CONN);
    await mirrorBindingMismatch('tenant-1', 'AzureSqlDatabase', 'conn-sql');
    expect(h.loadConnection).toHaveBeenCalledWith('tenant-1', 'conn-sql');
  });

  it('makes NO claim when no connection is bound — and does not hit the store', async () => {
    expect(await mirrorBindingMismatch('tenant-1', 'AzureSqlDatabase', undefined)).toBeNull();
    expect(h.loadConnection).not.toHaveBeenCalled();
  });

  it('makes NO claim when the connection was deleted (unknown is not a negative)', async () => {
    h.loadConnection.mockResolvedValue(null);
    expect(await mirrorBindingMismatch('tenant-1', 'AzureSqlDatabase', 'conn-gone')).toBeNull();
  });

  it('refuses the sibling traps too — BigQuery and Oracle connections under a SQL mirror', async () => {
    for (const [type, candidate] of [['bigquery', 'GoogleBigQuery'], ['oracle', 'Oracle']] as const) {
      h.loadConnection.mockResolvedValue({ ...SNOWFLAKE_CONN, type, name: `${type}-conn` });
      const mm = await mirrorBindingMismatch('tenant-1', 'AzureSqlDatabase', 'c');
      expect(mm, `a ${type} connection was accepted under an Azure SQL mirror`).not.toBeNull();
      expect(mm!.candidates).toContain(candidate);
    }
  });
});

describe('resolveConnectionType', () => {
  it('returns the non-secret type and never a secret', async () => {
    h.loadConnection.mockResolvedValue(SNOWFLAKE_CONN);
    expect(await resolveConnectionType('tenant-1', 'conn-snow')).toBe('snowflake');
  });

  it('returns undefined with no id, without touching the store', async () => {
    expect(await resolveConnectionType('tenant-1', undefined)).toBeUndefined();
    expect(h.loadConnection).not.toHaveBeenCalled();
  });
});

/**
 * R9 — `withSourceAuth` is the OTHER shared helper, and the one the two Start
 * routes plus the CDC connector route all delegate to. Deleting its `connType`
 * stamp neuters the engine guard on ALL THREE at once.
 *
 * It was previously asserted only by a presence regex in the route population
 * spec, whose test name claimed it "stamps the connection type" while checking
 * merely that the call existed. The single pre-existing unit test called it with
 * NO `connectionId` — the one shape where `connType` is never computed. So the
 * mutation escaped. This pins the ANSWER, on the computed path.
 */
describe('withSourceAuth stamps the connection TYPE, not just the credential', () => {
  it('SQL family: stamps connType from the bound connection', async () => {
    h.loadConnection.mockResolvedValue(SNOWFLAKE_CONN);
    const { src } = await withSourceAuth('tenant-1', { sourceType: 'AzureSqlDatabase' }, 'conn-snow');
    expect(src.connType, 'the connType stamp is gone — the engine guard is blind').toBe('snowflake');
    // The whole point of the stamp: the engine can now see the contradiction.
    expect(isMirrorConnectionCompatible(src.sourceType, src.connType)).toBe(false);
  });

  it('PostgreSQL family: stamps connType too (the pg branch is a separate return)', async () => {
    h.loadConnection.mockResolvedValue(SNOWFLAKE_CONN);
    const { src } = await withSourceAuth('tenant-1', { sourceType: 'AzurePostgreSql' }, 'conn-snow');
    expect(src.connType, 'the pg branch drops the stamp').toBe('snowflake');
    expect(isMirrorConnectionCompatible(src.sourceType, src.connType)).toBe(false);
  });

  it('EMBEDDED CONTROL: a MATCHING connection stamps the type and is compatible', async () => {
    // Without this, a stamp hard-coded to a mismatching constant would satisfy
    // the assertions above.
    h.loadConnection.mockResolvedValue(SQL_CONN);
    const { src } = await withSourceAuth('tenant-1', { sourceType: 'AzureSqlDatabase' }, 'conn-sql');
    expect(src.connType).toBe('azure-sql');
    expect(isMirrorConnectionCompatible(src.sourceType, src.connType)).toBe(true);
  });

  it('leaves connType undefined when nothing is bound — the UAMI path is untouched', async () => {
    const { src, descriptor } = await withSourceAuth('tenant-1', { sourceType: 'AzureSqlDatabase' });
    expect(src.connType).toBeUndefined();
    expect(descriptor.identity).toBe('uami');
    expect(h.loadConnection).not.toHaveBeenCalled();
  });

  it('leaves connType undefined when the connection was deleted (unknown, not a negative)', async () => {
    h.loadConnection.mockResolvedValue(null);
    const { src } = await withSourceAuth('tenant-1', { sourceType: 'AzureSqlDatabase' }, 'conn-gone');
    expect(src.connType).toBeUndefined();
    expect(isMirrorConnectionCompatible(src.sourceType, src.connType)).toBe(true);
  });
});
