/**
 * The Databricks Unity Catalog arms of createTablesShortcut run their DDL on a
 * Databricks SQL Warehouse, so the LOCATION '…' literal follows the Spark SQL
 * rule: backslash escapes (`\\`, `\'`), not T-SQL quote doubling.
 *
 * Each test reads the LOCATION literal back with the Spark SQL rule and checks
 * that (a) it decodes to the intended value and (b) the statement ends exactly
 * at the literal's closing quote.
 *
 * WHAT BREAKS THEM: going back to escapeSqlLiteral at either site. For a value
 * ending in a backslash, the doubled form `'…o''neil\'` never closes under the
 * Spark rule, so the reader runs off the end (or closes early), the decoded
 * value differs, and the exact-text assertion fails.
 *
 * Backends are mocked; these assert the statement text we send, not live Azure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../shortcut-credentials', () => ({
  getKeyVaultSecret: vi.fn(),
  keyVaultConfigGate: vi.fn(() => null),
  ensureUcAwsStorageCredential: vi.fn(async () => ({ name: 'cred' })),
  ensureUcGcpStorageCredential: vi.fn(async () => ({ name: 'cred' })),
  ensureUcExternalLocation: vi.fn(async () => ({ name: 'loc' })),
  deleteUcExternalLocation: vi.fn(async () => {}),
  deleteUcStorageCredential: vi.fn(async () => {}),
}));
vi.mock('../adls-client', () => ({ listPaths: vi.fn(async () => []) }));
vi.mock('../lakehouse-shortcuts', () => ({ listShortcutSecretBindings: vi.fn(async () => []) }));
vi.mock('../kv-secrets-client', () => ({
  getShortcutSecretOwnerRecord: vi.fn(async () => ({ exists: false })),
  getShortcutSecretValue: vi.fn(),
}));
vi.mock('../synapse-sql-client', () => ({
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'master', cacheKey: 'k' })),
  executeQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
}));
vi.mock('../databricks-client', () => ({
  listWarehouses: vi.fn(async () => [{ id: 'wh1', name: 'wh', state: 'RUNNING' }]),
  executeStatement: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
  databricksConfigGate: vi.fn(() => null),
  writeUcVolumesFile: vi.fn(async () => {}),
  deleteUcVolumesFile: vi.fn(async () => {}),
}));

import { createTablesShortcut } from '../shortcut-engines';
import { executeStatement } from '../databricks-client';

/** Read the Spark SQL literal whose opening quote is at `open` (backslash escapes). */
function readSparkLiteral(s: string, open: number): { value: string; end: number } {
  expect(s[open]).toBe("'");
  let out = '';
  for (let i = open + 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) break;
      out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
      i++;
      continue;
    }
    if (ch === "'") return { value: out, end: i + 1 };
    out += ch;
  }
  throw new Error('unterminated Spark SQL literal');
}

/** The DDL sent to the warehouse, and the decoded LOCATION literal in it. */
function locationOf(): { ddl: string; value: string; rest: string } {
  const calls = (executeStatement as any).mock.calls as any[][];
  expect(calls.length).toBe(1);
  expect(calls[0][0]).toBe('wh1');
  const ddl = calls[0][1] as string;
  const at = ddl.indexOf("LOCATION '");
  expect(at, `LOCATION literal in ${ddl}`).toBeGreaterThanOrEqual(0);
  const lit = readSparkLiteral(ddl, at + 'LOCATION '.length);
  return { ddl, value: lit.value, rest: ddl.slice(lit.end) };
}

const baseEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...baseEnv };
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
  delete process.env.LOOM_DELTA_SHARING_VOLUME;
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-x.azuredatabricks.net';
});

describe('createTablesShortcut (Databricks UC): LOCATION literal follows the Spark SQL rule', () => {
  it('abfss LOCATION with a quote and a trailing backslash', async () => {
    const uri = "abfss://c@acct.dfs.core.windows.net/dir/o'neil\\";
    const res = await createTablesShortcut({ lakehouseId: 'lh1', name: 'uc1', abfssUri: uri, format: 'delta' });
    expect((res as any).engine).toBe('databricks');
    const { ddl, value, rest } = locationOf();
    // Exact text: backslash doubled first, then the quote backslash-escaped.
    // Under the old doubling this reads `…/dir/o''neil\';`.
    expect(ddl).toContain("USING DELTA LOCATION 'abfss://c@acct.dfs.core.windows.net/dir/o\\'neil\\\\';");
    expect(value).toBe(uri);
    expect(rest).toBe(';');
  });

  it('external object URI (S3) LOCATION with a quote and a trailing backslash', async () => {
    const objectUri = "s3://bucket/o'k\\";
    await createTablesShortcut({
      lakehouseId: 'lh1', name: 'uc2', abfssUri: '', format: 'parquet',
      external: { objectUri, ucExternalLocation: 'loc' },
    });
    const { ddl, value, rest } = locationOf();
    expect(ddl).toContain("USING PARQUET LOCATION 's3://bucket/o\\'k\\\\';");
    expect(value).toBe(objectUri);
    expect(rest).toBe(';');
  });

  it('carries a control character in the LOCATION: NUL as \\0, U+001B raw', async () => {
    // Breaks if the site stops using the Spark helper (escapeSqlLiteral sends
    // the NUL raw), or if the helper goes back to refusing control characters
    // (the statement is then never sent and locationOf() fails on the count).
    await createTablesShortcut({
      lakehouseId: 'lh1', name: 'uc3', abfssUri: 'abfss://c@acct.dfs.core.windows.net/a\u0000b\u001b', format: 'delta',
    });
    const { ddl, rest } = locationOf();
    expect(ddl).toContain("USING DELTA LOCATION 'abfss://c@acct.dfs.core.windows.net/a\\0b\u001b';");
    expect(ddl).not.toContain('\u0000');
    expect(rest).toBe(';');
  });
});

describe('createTablesShortcut (Delta Sharing): LOCATION literal follows the Spark SQL rule', () => {
  it('credential path + share coordinates with a quote and a trailing backslash', async () => {
    await createTablesShortcut({
      lakehouseId: 'lh1', name: 'ds1', abfssUri: '',
      external: {
        objectUri: '',
        lakehouseId: 'lh1',
        deltaSharing: {
          profile: { endpoint: 'https://share.example.net/delta-sharing/', bearerToken: 'tok' },
          share: "sh'a", schema: 's', table: 't\\',
        },
      },
    });
    const { ddl, value, rest } = locationOf();
    const credPath = '/Volumes/loom/loom_shortcuts/loom_shortcut_files/loom_lh1_ds1.share';
    // Under the old doubling this reads `…#sh''a.s.t\';`.
    expect(ddl).toContain(`USING deltaSharing LOCATION '${credPath}#sh\\'a.s.t\\\\';`);
    expect(value).toBe(`${credPath}#sh'a.s.t\\`);
    expect(rest).toBe(';');
  });
});
