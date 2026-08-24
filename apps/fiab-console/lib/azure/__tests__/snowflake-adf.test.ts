/**
 * snowflake-adf — direct unit coverage.
 *
 * ## Why this file exists
 *
 * An independent review mutation-tested the Snowflake work and found three
 * escapes, all in `snowflake-adf.ts`, all with the same root cause: the module
 * had NO test file of its own and was reached only through mocks in
 * `mirror-adf-copy.test.ts`. Anything that module got wrong that the engine did
 * not re-assert was invisible.
 *
 *   M5  the SQL identifier-injection guard could be neutralised, suite green.
 *   M7  the account-identifier normalisation could be removed, suite green.
 *   M10 the honest "not CDC" note could be replaced with a CDC claim, green.
 *
 * M5 is a security guard. A guard that can be deleted with the suite still
 * green is not a guard, so it is tested here with hostile input rather than
 * only through a happy path.
 */
import { describe, it, expect } from 'vitest';
import {
  assertSnowflakeIdentifier,
  snowflakeTablesQuery,
  snowflakeSchemaCountQuery,
  normalizeSnowflakeAccount,
  parseSnowflakeTableRows,
  parseSchemaCount,
  buildSnowflakeLinkedService,
  snowflakeLinkedServiceName,
  adfSafeName,
} from '../snowflake-adf';

// ── M5: the injection guard ────────────────────────────────────────────────
describe('assertSnowflakeIdentifier — the injection guard', () => {
  it('accepts legal Snowflake identifiers', () => {
    for (const ok of ['SALES_DB', 'db1', '_private', 'A$B', 'MixedCase_9']) {
      expect(assertSnowflakeIdentifier(ok)).toBe(ok);
    }
  });

  it('REJECTS every shape that could escape the FROM clause', () => {
    const hostile = [
      'SALES; DROP TABLE USERS',        // statement separator
      'SALES.PUBLIC',                    // qualifies past the database
      '"quoted"',                        // quoted identifier
      'SALES--comment',                  // comment
      'SALES/*x*/',                      // block comment
      'SALES DB',                        // space
      "SALES' OR '1'='1",                // quote break-out
      'SALES)',                          // paren
      '1DB',                             // must not start with a digit
      '',                                // empty
      '   ',                             // whitespace only
      'SALES\nUNION SELECT 1',           // newline
    ];
    for (const bad of hostile) {
      expect(() => assertSnowflakeIdentifier(bad), `should have rejected ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('is actually REACHED by both query builders', () => {
    // The guard existing is not the same as the guard being on the path.
    expect(() => snowflakeTablesQuery('SALES; DROP TABLE T')).toThrow(/not a valid Snowflake database identifier/);
    expect(() => snowflakeSchemaCountQuery('SALES; DROP TABLE T')).toThrow(/not a valid Snowflake database identifier/);
  });

  it('never emits a query containing an unvalidated identifier', () => {
    const q = snowflakeTablesQuery('SALES_DB');
    expect(q).toContain('SALES_DB.INFORMATION_SCHEMA.TABLES');
    expect(q).not.toMatch(/;\s*\w/);
  });
});

// ── The enumeration queries ────────────────────────────────────────────────
describe('snowflakeTablesQuery', () => {
  it('asks for IS_ICEBERG by default — the column the toggle depends on', () => {
    expect(snowflakeTablesQuery('DB')).toContain('IS_ICEBERG');
  });
  it('omits IS_ICEBERG on the fallback for editions that lack it', () => {
    expect(snowflakeTablesQuery('DB', false)).not.toContain('IS_ICEBERG');
  });
  it('excludes INFORMATION_SCHEMA itself from the results', () => {
    expect(snowflakeTablesQuery('DB')).toContain("TABLE_SCHEMA <> 'INFORMATION_SCHEMA'");
  });
});

describe('snowflakeSchemaCountQuery — the visibility probe', () => {
  it('counts schemas the role can see, excluding INFORMATION_SCHEMA', () => {
    const q = snowflakeSchemaCountQuery('SALES_DB');
    expect(q).toContain('SALES_DB.INFORMATION_SCHEMA.SCHEMATA');
    expect(q).toContain('VISIBLE_SCHEMAS');
    expect(q).toContain("SCHEMA_NAME <> 'INFORMATION_SCHEMA'");
  });
});

// ── M7: account-identifier normalisation ───────────────────────────────────
describe('normalizeSnowflakeAccount', () => {
  it('turns the pasted sign-in URL into the org-account form ADF wants', () => {
    // The failure this prevents is opaque: ADF rejects a URL with an unhelpful
    // error, and operators paste the URL almost every time.
    for (const raw of [
      'https://myorg-acct123.snowflakecomputing.com',
      'https://myorg-acct123.snowflakecomputing.com/',
      'http://myorg-acct123.snowflakecomputing.com',
      'myorg-acct123.snowflakecomputing.com',
      'https://myorg-acct123.snowflakecomputing.com/console/login',
      '  myorg-acct123  ',
    ]) {
      expect(normalizeSnowflakeAccount(raw), `for ${raw}`).toBe('myorg-acct123');
    }
  });

  it('leaves an already-correct identifier untouched', () => {
    expect(normalizeSnowflakeAccount('myorg-acct123')).toBe('myorg-acct123');
  });

  it('handles null/undefined without throwing', () => {
    expect(normalizeSnowflakeAccount(undefined)).toBe('');
    expect(normalizeSnowflakeAccount(null)).toBe('');
  });

  it('is REACHED by the linked-service builder', () => {
    const props = buildSnowflakeLinkedService(
      {
        name: 'c', host: 'https://myorg-acct123.snowflakecomputing.com',
        database: 'DB', warehouse: 'WH', username: 'U', authMethod: 'sql-password',
      },
      null,
    );
    expect((props.typeProperties as Record<string, unknown>).accountIdentifier).toBe('myorg-acct123');
  });
});

// ── Row parsing ────────────────────────────────────────────────────────────
describe('parseSnowflakeTableRows', () => {
  it('reads schema/table/IS_ICEBERG case-insensitively', () => {
    const rows = [
      { TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ORDERS', IS_ICEBERG: 'NO' },
      { table_schema: 'PUBLIC', table_name: 'ICE', is_iceberg: 'YES' },
    ];
    expect(parseSnowflakeTableRows(rows)).toEqual([
      { schema: 'PUBLIC', table: 'ORDERS', isIceberg: false },
      { schema: 'PUBLIC', table: 'ICE', isIceberg: true },
    ]);
  });

  it('treats a missing IS_ICEBERG as NOT Iceberg rather than throwing', () => {
    expect(parseSnowflakeTableRows([{ TABLE_SCHEMA: 'S', TABLE_NAME: 'T' }]))
      .toEqual([{ schema: 'S', table: 'T', isIceberg: false }]);
  });

  it('drops malformed rows instead of inventing tables', () => {
    expect(parseSnowflakeTableRows([null, 'x', {}, { TABLE_SCHEMA: 'S' }])).toEqual([]);
    expect(parseSnowflakeTableRows('not an array')).toEqual([]);
    expect(parseSnowflakeTableRows(undefined)).toEqual([]);
  });
});

describe('parseSchemaCount', () => {
  it('reads VISIBLE_SCHEMAS case-insensitively', () => {
    expect(parseSchemaCount({ VISIBLE_SCHEMAS: 3 })).toBe(3);
    expect(parseSchemaCount({ visible_schemas: '0' })).toBe(0);
  });
  it('returns null — never 0 — when the probe could not be read', () => {
    // Conflating "unknown" with "zero" would report a grants problem that was
    // never established (deploy-integrity.md R7).
    expect(parseSchemaCount(undefined)).toBeNull();
    expect(parseSchemaCount({})).toBeNull();
    expect(parseSchemaCount({ VISIBLE_SCHEMAS: 'abc' })).toBeNull();
  });
});

// ── Linked-service shape ───────────────────────────────────────────────────
describe('buildSnowflakeLinkedService', () => {
  const base = {
    name: 'demo snowflake', host: 'myorg-acct123', database: 'DB',
    warehouse: 'WH', role: 'RO', username: 'U',
  };

  it('emits the SnowflakeV2 shape the ADF connector documents', () => {
    const p = buildSnowflakeLinkedService({ ...base, authMethod: 'sql-password' }, null);
    expect(p.type).toBe('SnowflakeV2');
    const tp = p.typeProperties as Record<string, unknown>;
    expect(tp).toMatchObject({
      accountIdentifier: 'myorg-acct123', database: 'DB', warehouse: 'WH',
      role: 'RO', user: 'U', authenticationType: 'Basic',
    });
  });

  it('maps key-pair auth onto privateKey, never password', () => {
    const cred = { type: 'AzureKeyVaultSecret' as const, store: { referenceName: 'kv', type: 'LinkedServiceReference' as const }, secretName: 's' };
    const tp = buildSnowflakeLinkedService({ ...base, authMethod: 'key-pair' }, cred).typeProperties as Record<string, unknown>;
    expect(tp.authenticationType).toBe('KeyPair');
    expect(tp.privateKey).toEqual(cred);
    expect(tp.password).toBeUndefined();
  });

  it('omits an empty role rather than sending a blank one', () => {
    const tp = buildSnowflakeLinkedService({ ...base, role: '  ', authMethod: 'sql-password' }, null).typeProperties as Record<string, unknown>;
    expect(tp.role).toBeUndefined();
  });

  it('carries no secret VALUE when the credential is a Key Vault reference', () => {
    const cred = { type: 'AzureKeyVaultSecret' as const, store: { referenceName: 'kv', type: 'LinkedServiceReference' as const }, secretName: 'loom-conn-x' };
    const json = JSON.stringify(buildSnowflakeLinkedService({ ...base, authMethod: 'sql-password' }, cred));
    expect(json).toContain('loom-conn-x');
    expect(json).not.toContain('SecureString');
  });
});

describe('snowflakeLinkedServiceName / adfSafeName', () => {
  it('names the backing object after the Loom connection (auto-bind §2)', () => {
    expect(snowflakeLinkedServiceName({ id: '1234abcd-ef', name: 'demo snowflake' }))
      .toBe('demo_snowflake_1234abcd');
  });

  it('produces an ADF-legal name from hostile input', () => {
    const n = adfSafeName('9 bad/name!!');
    expect(n).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });

  it('matches mirror-adf-shared.adfSafeName byte-for-byte', async () => {
    // The two are deliberate duplicates (importing the engine here would be a
    // cycle). A test is what stops them drifting.
    const { adfSafeName: shared } = await import('../mirror-adf-shared');
    for (const s of ['9 bad/name!!', 'Already_Fine', '__leading', '', 'a'.repeat(200)]) {
      expect(adfSafeName(s), `for ${JSON.stringify(s)}`).toBe(shared(s));
    }
  });
});

// ── M10: the honesty of the sync-mode note ─────────────────────────────────
describe('the ADF Copy backend does not claim CDC it does not have', () => {
  it('the wizard note for Snowflake states full refresh, never row-level CDC', async () => {
    const { SOURCE_SYNC_NOTE } = await import('@/lib/editors/components/mirror-source-wizard');
    const note = SOURCE_SYNC_NOTE.Snowflake;
    expect(note, 'the Snowflake sync note went missing').toBeTruthy();
    // It must say what actually happens...
    expect(note).toMatch(/full refresh|delete-then-copy/i);
    // ...and must NOT claim change capture the connector cannot do. M10
    // replaced this note with a CDC claim and nothing went red.
    expect(note).not.toMatch(/\bchange data capture\b/i);
    expect(note).not.toMatch(/changed rows since last sync/i);
  });

  it('Snowflake sync-mode LABELS promise a full reload, not changed rows', async () => {
    // The label and the note render on the same screen, and `incremental` is
    // the DEFAULT — a label promising CDC while the note says full refresh put
    // a contradiction in front of the operator, with the misleading half
    // pre-selected.
    const { syncModeOptions } = await import('@/lib/editors/components/mirror-source-wizard');
    const labels = syncModeOptions('Snowflake').map((o) => o.name).join(' | ');
    expect(labels).not.toMatch(/changed rows since last sync/i);
    expect(labels).toMatch(/full reload/i);
  });

  it('but the SQL family keeps its changed-rows label, which IS true there', async () => {
    // The fix must not flatten every source into the weakest claim: SQL Change
    // Tracking genuinely does ship only changed rows.
    const { syncModeOptions } = await import('@/lib/editors/components/mirror-source-wizard');
    const labels = syncModeOptions('AzureSqlDatabase').map((o) => o.name).join(' | ');
    expect(labels).toMatch(/changed rows since last sync/i);
  });

  it('offers the same three mode ids for every source', async () => {
    const { syncModeOptions } = await import('@/lib/editors/components/mirror-source-wizard');
    for (const src of ['Snowflake', 'AzureSqlDatabase', 'CosmosDb']) {
      expect(syncModeOptions(src).map((o) => o.id).sort())
        .toEqual(['continuous', 'incremental', 'snapshot']);
    }
  });
});

