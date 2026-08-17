/**
 * #3549 siblings — the ADX and lakehouse seeds.
 *
 * `adf-pipeline` was the headline (36 of 41 pipelines empty), but the SAME
 * two-stage shape exists for every backing whose install-time provisioner
 * config-gates before authoring: the item keeps its `state.content`, the
 * open-time `create()` makes an empty object, and the item binds to it.
 *
 *   eventhouse / kql-database   create() → ARM createDatabase, then STOPS.
 *                               A bundle declaring tables + sample rows landed
 *                               as an empty database — and because it IS a real
 *                               database, queries returned "no results" rather
 *                               than an error, so nothing surfaced it.
 *   lakehouse                   create() → ONE directory, the root. A bundle
 *                               declaring folders + seeded Delta tables opened
 *                               onto an empty tree.
 *
 * These also pin the two EXTRACTIONS this change made. `applyKqlBundle` and
 * `seedLakehouseAdls` were lifted out of the install provisioners so both paths
 * share one implementation; the quirk-fix assertions below (the `.alter-merge`
 * caching rewrite, the `$table` placeholder, the DDL column parser) are the
 * evidence the lift was faithful rather than a lossy paraphrase.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) Drop `seedFromContent` from `adxDatabaseAutoBind` → RED:
 *        "adxDatabaseAutoBind registers a seed hook"
 *      and the registry-coverage test in `auto-bind-seed.test.ts`.
 *   b) Remove the `normalizePolicyCommand` call in `applyKqlBundle` → RED:
 *        "rewrites .alter-merge caching to .alter (SYN0002)"
 *   c) Make `columnsFromDdl` split on every comma → RED:
 *        "parses DDL columns without splitting inside DECIMAL(18,2)"
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fake ADX. Records commands; models "rows exist after an ingest" so the
// seeder's VERIFY step (which is why `.set-or-append` exists) is exercised.
// ---------------------------------------------------------------------------
const adx = {
  commands: [] as string[],
  ingests: [] as Array<{ table: string; rows: any[][] }>,
  rowCounts: new Map<string, number>(),
  failOn: null as RegExp | null,
};

vi.mock('@/lib/azure/kusto-client', () => {
  class KustoError extends Error {
    status: number;
    constructor(message: string, status = 500) { super(message); this.status = status; }
  }
  return {
    KustoError,
    executeMgmtCommand: vi.fn(async (_db: string, cmd: string) => {
      if (adx.failOn?.test(cmd)) throw new KustoError(`rejected: ${cmd.slice(0, 40)}`, 400);
      adx.commands.push(cmd);
      return { rows: [] };
    }),
    executeQuery: vi.fn(async (_db: string, q: string) => {
      const m = q.match(/\["([^"]+)"\] \| count/);
      return { rows: [[m ? (adx.rowCounts.get(m[1]) ?? 0) : 0]] };
    }),
    ingestInline: vi.fn(async (_db: string, table: string, rows: any[][]) => {
      adx.ingests.push({ table, rows });
      adx.rowCounts.set(table, rows.length);
    }),
    createDatabase: vi.fn(async () => ({ provisioningState: 'Succeeded' })),
  };
});

// ---------------------------------------------------------------------------
// Fake ADLS Gen2.
// ---------------------------------------------------------------------------
const adls = {
  dirs: [] as string[],
  files: [] as Array<{ path: string; text: string }>,
  throwOn: null as RegExp | null,
  throwStatus: 403,
};

vi.mock('@/lib/azure/adls-client', () => ({
  createDirectory: vi.fn(async (_c: string, path: string) => {
    if (adls.throwOn?.test(path)) throw Object.assign(new Error('denied'), { statusCode: adls.throwStatus });
    adls.dirs.push(path);
  }),
  uploadFile: vi.fn(async (_c: string, path: string, bytes: Buffer) => {
    if (adls.throwOn?.test(path)) throw Object.assign(new Error('denied'), { statusCode: adls.throwStatus });
    adls.files.push({ path, text: bytes.toString('utf-8') });
  }),
  configuredContainerNames: vi.fn(() => ['landing', 'bronze']),
}));

import { applyKqlBundle, normalizePolicyCommand, resolveFunctionPlaceholders } from '@/lib/install/provisioners/_seed-kql-bundle';
import { seedLakehouseAdls, columnsFromDdl, buildCsv } from '@/lib/install/provisioners/_seed-lakehouse-adls';
import { adxDatabaseAutoBind, lakehouseAutoBind } from '@/lib/azure/auto-bind-providers';
import type { AutoBindContext } from '@/lib/azure/auto-bind';

const KQL_CONTENT = {
  kind: 'kql-database',
  tables: [
    {
      name: 'RawTelemetry',
      columns: [{ name: 'ts', type: 'datetime' }, { name: 'deviceId', type: 'string' }, { name: 'value', type: 'real' }],
      sample: [['2026-08-15T00:00:00Z', 'dev-1', 42.5], ['2026-08-15T00:01:00Z', 'dev-2', 17.25]],
    },
    { name: 'Alerts', columns: [{ name: 'ts', type: 'datetime' }, { name: 'msg', type: 'string' }] },
  ],
  functions: [{ name: 'RecentAlerts', body: '.create-or-alter function RecentAlerts() { Alerts | where ts > ago(1d) }' }],
  ingestionPolicies: [{ table: 'RawTelemetry', policy: '.alter-merge table RawTelemetry policy caching hot = 7d' }],
};

const LAKEHOUSE_CONTENT = {
  kind: 'lakehouse',
  folders: [{ path: 'Files/raw' }, { path: 'Files/curated' }],
  deltaTables: [
    {
      name: 'orders',
      ddl: 'CREATE TABLE orders ( order_id BIGINT, amount DECIMAL(18,2), placed_at TIMESTAMP )',
      sampleRows: [[1, '10.50', '2026-08-15'], [2, '99.99', '2026-08-16']],
    },
    { name: 'customers', ddl: 'CREATE TABLE customers ( id BIGINT, name STRING )' },
  ],
};

function ctxWith(itemType: string, content: unknown): AutoBindContext {
  return { itemId: 'i-1', itemType, displayName: 'Bundle Item', workspaceId: 'ws-1', state: { content } };
}

beforeEach(() => {
  adx.commands = []; adx.ingests = []; adx.rowCounts = new Map(); adx.failOn = null;
  adls.dirs = []; adls.files = []; adls.throwOn = null; adls.throwStatus = 403;
});

// ===========================================================================
describe('eventhouse / kql-database — the empty-database sibling', () => {
  it('adxDatabaseAutoBind registers a seed hook', () => {
    expect(typeof adxDatabaseAutoBind.seedFromContent).toBe('function');
  });

  it('creates the bundle\'s tables in the database create() just made', async () => {
    const r = await adxDatabaseAutoBind.seedFromContent!('Real_Time_Ops', {}, ctxWith('kql-database', KQL_CONTENT));

    expect(r.seeded).toBe(true);
    expect(adx.commands).toContain('.create table RawTelemetry (ts:datetime, deviceId:string, value:real)');
    expect(adx.commands).toContain('.create table Alerts (ts:datetime, msg:string)');
  });

  it('ingests the sample rows, so the database is not silently empty', async () => {
    await adxDatabaseAutoBind.seedFromContent!('Real_Time_Ops', {}, ctxWith('kql-database', KQL_CONTENT));
    expect(adx.ingests).toHaveLength(1);
    expect(adx.ingests[0]).toMatchObject({ table: 'RawTelemetry' });
    expect(adx.ingests[0].rows).toHaveLength(2);
  });

  it('creates the bundle\'s functions and policies', async () => {
    await adxDatabaseAutoBind.seedFromContent!('Real_Time_Ops', {}, ctxWith('kql-database', KQL_CONTENT));
    expect(adx.commands.some((c) => c.includes('.create-or-alter function RecentAlerts'))).toBe(true);
    expect(adx.commands.some((c) => /policy caching/.test(c))).toBe(true);
  });

  it('seeds nothing for a blank eventhouse, without erroring', async () => {
    const r = await adxDatabaseAutoBind.seedFromContent!('Blank', {}, ctxWith('kql-database', undefined));
    expect(r).toEqual({ seeded: false });
    expect(adx.commands).toEqual([]);
  });

  it('reports seeded:false when every table-create is rejected', async () => {
    adx.failOn = /^\.create table/;
    const r = await adxDatabaseAutoBind.seedFromContent!('Real_Time_Ops', {}, ctxWith('kql-database', KQL_CONTENT));
    expect(r.seeded).toBe(false);
    expect(r.error).toMatch(/table-create/);
  });
});

describe('applyKqlBundle — the extracted quirk-fixes survived the lift', () => {
  it('rewrites .alter-merge caching to .alter (SYN0002)', async () => {
    // There is no `-merge` variant of the caching policy command; the raw
    // bundle form is rejected by the engine.
    await applyKqlBundle('db', KQL_CONTENT, []);
    const policyCmd = adx.commands.find((c) => /policy caching/.test(c));
    expect(policyCmd).toBe('.alter table RawTelemetry policy caching hot = 7d');
    expect(policyCmd).not.toMatch(/alter-merge/);
  });

  it('leaves .alter-merge alone for policies that DO have a merge form', () => {
    const retention = '.alter-merge table T policy retention softdelete = 30d';
    expect(normalizePolicyCommand(retention)).toBe(retention);
  });

  it('resolves the $table templating placeholder to union withsource= (SEM0100)', () => {
    const body = 'union A, B | project ts, source_table = $table';
    const fixed = resolveFunctionPlaceholders(body);
    expect(fixed).toContain('union withsource=source_table');
    expect(fixed).not.toContain('$table');
    // Output schema preserved: the column is still projected.
    expect(fixed).toContain('source_table');
  });

  it('is a no-op for a well-formed function body', () => {
    const body = 'union A, B | project ts';
    expect(resolveFunctionPlaceholders(body)).toBe(body);
  });

  it('counts an update-policy failure as CRITICAL but caching as tuning', async () => {
    adx.failOn = /policy/;
    const content = {
      kind: 'kql-database',
      tables: [],
      ingestionPolicies: [
        { table: 'T', policy: '.alter table T policy update @\'[]\'' },
        { table: 'T', policy: '.alter table T policy caching hot = 1d' },
      ],
    };
    const r = await applyKqlBundle('db', content, []);
    expect(r.policyFailures).toBe(2);
    expect(r.criticalPolicyFailures).toBe(1);
  });
});

// ===========================================================================
describe('lakehouse — the empty-tree sibling', () => {
  it('lakehouseAutoBind registers a seed hook', () => {
    expect(typeof lakehouseAutoBind.seedFromContent).toBe('function');
  });

  it('creates the bundle\'s folders under the root create() just made', async () => {
    const r = await lakehouseAutoBind.seedFromContent!(
      'lakehouses/sales', { container: 'landing' }, ctxWith('lakehouse', LAKEHOUSE_CONTENT),
    );

    expect(r.seeded).toBe(true);
    expect(adls.dirs).toContain('lakehouses/sales/Files/raw');
    expect(adls.dirs).toContain('lakehouses/sales/Files/curated');
  });

  it('writes a real seed CSV per table that has sample rows', async () => {
    await lakehouseAutoBind.seedFromContent!(
      'lakehouses/sales', { container: 'landing' }, ctxWith('lakehouse', LAKEHOUSE_CONTENT),
    );

    expect(adls.dirs).toContain('lakehouses/sales/Tables/orders');
    const csv = adls.files.find((f) => f.path.endsWith('orders.csv'));
    expect(csv).toBeDefined();
    // Header from the DDL, then the rows.
    expect(csv!.text.split('\n')[0]).toBe('order_id,amount,placed_at');
    expect(csv!.text).toContain('1,10.50,2026-08-15');
  });

  it('still creates a browsable folder for a table with no sample rows', async () => {
    await lakehouseAutoBind.seedFromContent!(
      'lakehouses/sales', { container: 'landing' }, ctxWith('lakehouse', LAKEHOUSE_CONTENT),
    );
    expect(adls.dirs).toContain('lakehouses/sales/Tables/customers');
    expect(adls.files.some((f) => f.path.includes('customers'))).toBe(false);
  });

  it('reports the exact RBAC grant when ADLS refuses the write', async () => {
    adls.throwOn = /Files\/raw/;
    const r = await lakehouseAutoBind.seedFromContent!(
      'lakehouses/sales', { container: 'landing' }, ctxWith('lakehouse', LAKEHOUSE_CONTENT),
    );
    expect(r.seeded).toBe(false);
    expect(r.error).toMatch(/Storage Blob Data Contributor/);
  });

  it('seeds nothing for a blank lakehouse', async () => {
    const r = await lakehouseAutoBind.seedFromContent!('lakehouses/x', { container: 'landing' }, ctxWith('lakehouse', undefined));
    expect(r).toEqual({ seeded: false });
    expect(adls.dirs).toEqual([]);
  });
});

describe('seedLakehouseAdls — the extracted DDL/CSV helpers survived the lift', () => {
  it('parses DDL columns without splitting inside DECIMAL(18,2)', () => {
    expect(columnsFromDdl('CREATE TABLE t ( a BIGINT, b DECIMAL(18,2), c STRING )'))
      .toEqual(['a', 'b', 'c']);
  });

  it('skips table-level constraint clauses so they are not phantom columns', () => {
    expect(columnsFromDdl('CREATE TABLE t ( id BIGINT, name STRING, PRIMARY KEY (id) )'))
      .toEqual(['id', 'name']);
  });

  it('CSV-escapes values containing commas and quotes', () => {
    const csv = buildCsv(['a', 'b'], [['x,y', 'he said "hi"']]);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"he said ""hi"""');
  });

  it('namespaces tables under their schema when schemasEnabled', async () => {
    await seedLakehouseAdls('landing' as never, 'lakehouses/sales', {
      kind: 'lakehouse',
      schemasEnabled: true,
      deltaTables: [{ name: 'orders', schema: 'sales', ddl: 'CREATE TABLE orders ( id BIGINT )', sampleRows: [[1]] }],
    }, []);
    expect(adls.dirs).toContain('lakehouses/sales/Tables/sales/orders');
  });

  it('invokes the per-table hook only for tables that were actually seeded', async () => {
    const seen: string[] = [];
    await seedLakehouseAdls('landing' as never, 'root', LAKEHOUSE_CONTENT, [], async (t) => { seen.push(t.name); });
    // `customers` has no sampleRows, so no view should be registered over it.
    expect(seen).toEqual(['orders']);
  });
});
