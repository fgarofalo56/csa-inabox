/**
 * Serverless DDL: values in nested dynamic SQL are escaped for each literal
 * level, and bracketed identifiers inside a literal double `]` first.
 *
 * Each test DECODES the statement the way the SQL parser would — the outer
 * `EXEC('…')` literal, then the literal or identifier inside it — and checks the
 * decoded value equals the input AND that the literal ends where it should
 * (what follows it is pinned). The fixtures carry a `'` (and a `]` for
 * identifiers), so:
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION:
 *   - a value inside `EXEC('… ''<v>'' …')` escaped for one level only: the inner
 *     literal ends at the fixture's quote, so the decoded value is cut short and
 *     the text after it is no longer `, CREDENTIAL …` / `, FORMAT …`.
 *   - a bracketed identifier inside a literal without `]` doubling (`[${name}]`):
 *     the decoded identifier ends at the fixture's `]`.
 *   - a name in a one-level position (`N'…'`, `SCHEMA_ID('…')`, `OBJECT_ID('…')`)
 *     not escaped: that literal ends at the fixture's quote.
 * The byte-identity pins show ordinary (sanitised) names produce exactly the
 * DDL the provisioners emitted before; they are regression guards, not the
 * witnesses for the escaping.
 */
import { describe, it, expect } from 'vitest';
import { deltaTableViewDdl, externalDataSourceDdl, shortcutFileViewDdl } from '../_serverless-ddl';
import { bracketAt, sqlLiteralAt } from '@/lib/sql/quoting';
import { bracketAfter, literalAfter, readBracket } from '@/lib/sql/__tests__/tsql-decode';

/** `[a].[b]` at the start of `s` → both parts, decoded, and where it ends. */
function twoPart(s: string) {
  const a = readBracket(s, 0);
  expect(s[a.end], `two-part name in ${s}`).toBe('.');
  const b = readBracket(s, a.end + 1);
  return { schema: a.value, leaf: b.value, end: b.end };
}

describe('quoting helpers', () => {
  it('sqlLiteralAt doubles each quote once per level; bracketAt doubles ] then each quote per level', () => {
    expect(sqlLiteralAt("o'k", 1)).toBe("o''k");
    expect(sqlLiteralAt("o'k", 2)).toBe("o''''k");
    expect(bracketAt("a]b'c", 1)).toBe("[a]]b''c]");
    expect(bracketAt("a]b'c", 2)).toBe("[a]]b''''c]");
    expect(() => sqlLiteralAt('x', 3 as any)).toThrow(/literal depth/);
  });
});

describe('externalDataSourceDdl (synapse-serverless-sql-pool.ts: workspace data source and per-root UC data sources)', () => {
  const NAME = "ds]o'k";
  const LOC = "abfss://c@acct.dfs.core.windows.net/o'k/x";

  it('decodes to the same name and location at every level', () => {
    const [l1, l2, l3] = externalDataSourceDdl(NAME, LOC).split('\n');

    const n = literalAfter(l1, 'name = N');
    expect(n.value).toBe(NAME);
    expect(l1.slice(n.end)).toBe(')');

    const drop = literalAfter(l2, 'EXEC(');
    expect(l2.slice(drop.end)).toBe(');');
    const dropId = bracketAfter(drop.value, 'DROP EXTERNAL DATA SOURCE ');
    expect(dropId.value).toBe(NAME);
    expect(drop.value.slice(dropId.end)).toBe('');

    const create = literalAfter(l3, 'EXEC(');
    expect(l3.slice(create.end)).toBe(');');
    expect(bracketAfter(create.value, 'CREATE EXTERNAL DATA SOURCE ').value).toBe(NAME);
    const loc = literalAfter(create.value, 'LOCATION = ');
    expect(loc.value).toBe(LOC);
    expect(create.value.slice(loc.end)).toBe(', CREDENTIAL = [WorkspaceIdentity])');
  });

  it('emits the previous DDL byte for byte for an ordinary name and location', () => {
    expect(externalDataSourceDdl('loom_ds_dbx_0_x', 'abfss://u@a.dfs.core.windows.net/')).toBe(
      "IF EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = N'loom_ds_dbx_0_x')\n" +
        "  EXEC('DROP EXTERNAL DATA SOURCE [loom_ds_dbx_0_x]');\n" +
        "EXEC('CREATE EXTERNAL DATA SOURCE [loom_ds_dbx_0_x] WITH (LOCATION = ''abfss://u@a.dfs.core.windows.net/'', CREDENTIAL = [WorkspaceIdentity])');",
    );
  });
});

describe('deltaTableViewDdl (lakehouse.ts: per-table Delta view)', () => {
  const SCHEMA = "s]o'k";
  const LEAF = "l'e]f";
  const URL = "https://acct.dfs.core.windows.net/c/o'k/t";

  it('decodes to the same schema, view name and URL at every level', () => {
    const [l1, l2, l3] = deltaTableViewDdl(SCHEMA, LEAF, URL).split('\n');

    const sid = literalAfter(l1, 'SCHEMA_ID(');
    expect(sid.value).toBe(SCHEMA);
    expect(l1.slice(sid.end).startsWith(') IS NULL EXEC(')).toBe(true);
    const cs = literalAfter(l1, 'EXEC(');
    expect(l1.slice(cs.end)).toBe(');');
    const csId = bracketAfter(cs.value, 'CREATE SCHEMA ');
    expect(csId.value).toBe(SCHEMA);
    expect(cs.value.slice(csId.end)).toBe('');

    const oid = literalAfter(l2, 'OBJECT_ID(');
    expect(l2.slice(oid.end).startsWith(",'V') IS NOT NULL DROP VIEW ")).toBe(true);
    const inObjectId = twoPart(oid.value);
    expect([inObjectId.schema, inObjectId.leaf, oid.value.slice(inObjectId.end)]).toEqual([SCHEMA, LEAF, '']);
    const dropped = twoPart(l2.slice(l2.indexOf('DROP VIEW ') + 'DROP VIEW '.length));
    expect([dropped.schema, dropped.leaf]).toEqual([SCHEMA, LEAF]);

    const cv = literalAfter(l3, 'EXEC(');
    expect(l3.slice(cv.end)).toBe(');');
    const created = twoPart(cv.value.slice('CREATE VIEW '.length));
    expect([created.schema, created.leaf]).toEqual([SCHEMA, LEAF]);
    const bulk = literalAfter(cv.value, 'BULK ');
    expect(bulk.value).toBe(URL);
    expect(cv.value.slice(bulk.end)).toBe(", FORMAT = 'DELTA') AS r");
  });

  it('emits the previous DDL byte for byte for sanitised names', () => {
    expect(deltaTableViewDdl('2024_q1', 'orders', 'https://acct.dfs.core.windows.net/bronze/t/orders')).toBe(
      "IF SCHEMA_ID('2024_q1') IS NULL EXEC('CREATE SCHEMA [2024_q1]');\n" +
        "IF OBJECT_ID('[2024_q1].[orders]','V') IS NOT NULL DROP VIEW [2024_q1].[orders];\n" +
        "EXEC('CREATE VIEW [2024_q1].[orders] AS SELECT * FROM OPENROWSET(BULK ''https://acct.dfs.core.windows.net/bronze/t/orders'', FORMAT = ''DELTA'') AS r');",
    );
  });
});

describe('shortcutFileViewDdl (lakehouse.ts: shortcut dataset view)', () => {
  const OBJ = 'lakehouse.shortcut_orders';
  const URL = "https://acct.dfs.core.windows.net/landing/Files/_shortcuts/orders/it's.csv";

  it.each([
    ['csv', ", FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE) AS r"],
    ['json', ", FORMAT = 'CSV', FIELDTERMINATOR = '0x0b', FIELDQUOTE = '0x0b') AS r"],
  ] as const)('%s: decodes to the same URL and format options inside EXEC', (fmt, tail) => {
    const [, l2, l3] = shortcutFileViewDdl(OBJ, URL, fmt).split('\n');
    const oid = literalAfter(l2, 'OBJECT_ID(');
    expect(oid.value).toBe(OBJ);

    const cv = literalAfter(l3, 'EXEC(');
    expect(l3.slice(cv.end)).toBe(');');
    expect(cv.value.startsWith(`CREATE VIEW ${OBJ} AS SELECT * FROM OPENROWSET(BULK `)).toBe(true);
    const bulk = literalAfter(cv.value, 'BULK ');
    expect(bulk.value).toBe(URL);
    expect(cv.value.slice(bulk.end)).toBe(tail);
  });

  it('emits the previous DDL byte for byte for a URL without quotes', () => {
    expect(shortcutFileViewDdl(OBJ, 'https://acct.dfs.core.windows.net/landing/f.csv', 'csv')).toBe(
      "IF SCHEMA_ID('lakehouse') IS NULL EXEC('CREATE SCHEMA lakehouse');\n" +
        `IF OBJECT_ID('${OBJ}','V') IS NOT NULL DROP VIEW ${OBJ};\n` +
        `EXEC('CREATE VIEW ${OBJ} AS SELECT * FROM OPENROWSET(BULK ''https://acct.dfs.core.windows.net/landing/f.csv'', ` +
        "FORMAT = ''CSV'', PARSER_VERSION = ''2.0'', HEADER_ROW = TRUE) AS r');",
    );
  });
});
