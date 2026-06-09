/**
 * Contract tests for aas-client.ts — covers BOTH:
 *   1) the XMLA TMSL write client behind the Semantic Model "Automatic
 *      aggregations" surface (xmlaConfigGate / xmlaScope / buildAggTableTmsl /
 *      altMapToTmsl / buildSoapExecuteEnvelope / parseXmlaFault / executeAggTmsl),
 *      stubbing @azure/identity + global.fetch — no live AAS / Premium capacity;
 *   2) the pure TMSL builders for the Model view (relationships + hierarchies,
 *      from ../aas-tmsl) and the Loom-native report-renderer helpers (../aas-dax).
 * Per no-vaporware, the tests exercise the actual code path.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  xmlaConfigGate,
  xmlaScope,
  buildAggTableTmsl,
  altMapToTmsl,
  buildSoapExecuteEnvelope,
  parseXmlaFault,
  executeAggTmsl,
  AasError,
  type AltMap,
} from '../aas-client';
import {
  buildCreateOrReplaceRelationshipTmsl,
  buildDeleteRelationshipTmsl,
  buildAlterTableHierarchyTmsl,
  buildModelBimTmsl,
  type TmslRelationship,
} from '../aas-tmsl';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    const ct = out?._contentType || 'text/xml';
    return new Response(out?._body ?? '', { status, headers: { 'content-type': ct } });
  }) as any;
}
afterEach(() => { global.fetch = realFetch; });

const ENV = process.env.LOOM_POWERBI_XMLA_ENDPOINT;
const CLOUD = process.env.LOOM_CLOUD;
const AZCLOUD = process.env.AZURE_CLOUD;
beforeEach(() => {
  delete process.env.LOOM_POWERBI_XMLA_ENDPOINT;
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
});
afterEach(() => {
  if (ENV === undefined) delete process.env.LOOM_POWERBI_XMLA_ENDPOINT; else process.env.LOOM_POWERBI_XMLA_ENDPOINT = ENV;
  if (CLOUD === undefined) delete process.env.LOOM_CLOUD; else process.env.LOOM_CLOUD = CLOUD;
  if (AZCLOUD === undefined) delete process.env.AZURE_CLOUD; else process.env.AZURE_CLOUD = AZCLOUD;
});

describe('xmlaConfigGate', () => {
  it('returns null when LOOM_POWERBI_XMLA_ENDPOINT is set', () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://srv.asazure.windows.net/xmla';
    expect(xmlaConfigGate()).toBeNull();
  });
  it('returns a structured gate (with the env-var name) when unset', () => {
    const gate = xmlaConfigGate();
    expect(gate).not.toBeNull();
    expect(gate!.missing).toBe('LOOM_POWERBI_XMLA_ENDPOINT');
    expect(gate!.detail).toMatch(/asazure|XMLA/i);
  });
});

describe('xmlaScope', () => {
  it('uses the Commercial Analysis Services audience by default', () => {
    expect(xmlaScope()).toBe('https://analysis.windows.net/powerbi/api/.default');
  });
  it('uses the Gov Analysis Services audience in GCC-High', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    expect(xmlaScope()).toBe('https://analysis.usgovcloudapi.net/powerbi/api/.default');
  });
});

describe('altMapToTmsl', () => {
  it('emits baseTable + baseColumn for a column-level Sum mapping', () => {
    const m: AltMap = { aggColumn: 'SalesAmount', dataType: 'double', summarization: 'Sum', detailTable: 'FactSales', detailColumn: 'SalesAmount' };
    expect(altMapToTmsl(m)).toEqual({ summarization: 'Sum', baseTable: 'FactSales', baseColumn: 'SalesAmount' });
  });
  it('emits baseTable only for a Count-of-rows mapping (no detail column)', () => {
    const m: AltMap = { aggColumn: 'RowCount', dataType: 'int64', summarization: 'Count', detailTable: 'FactSales' };
    expect(altMapToTmsl(m)).toEqual({ summarization: 'Count', baseTable: 'FactSales' });
  });
});

describe('buildAggTableTmsl', () => {
  const params = {
    database: 'SalesModel',
    aggTableName: 'SalesAgg',
    partitionExpression: 'let Source = Sql.Database("s","db") in Source',
    altMaps: [
      { aggColumn: 'CustomerKey', dataType: 'int64', summarization: 'GroupBy', detailTable: 'FactSales', detailColumn: 'CustomerKey' },
      { aggColumn: 'SalesAmount', dataType: 'double', summarization: 'Sum', detailTable: 'FactSales', detailColumn: 'SalesAmount' },
    ] as AltMap[],
  };

  it('produces a createOrReplace table that is hidden and Import-mode', () => {
    const tmsl = JSON.parse(buildAggTableTmsl(params));
    expect(tmsl.createOrReplace.object).toEqual({ database: 'SalesModel', table: 'SalesAgg' });
    expect(tmsl.createOrReplace.table.isHidden).toBe(true);
    expect(tmsl.createOrReplace.table.partitions[0].mode).toBe('import');
    expect(tmsl.createOrReplace.table.partitions[0].source.type).toBe('m');
  });

  it('emits alternateOf with the correct summarization + references per column', () => {
    const tmsl = JSON.parse(buildAggTableTmsl(params));
    const cols = tmsl.createOrReplace.table.columns;
    const sum = cols.find((c: any) => c.name === 'SalesAmount');
    expect(sum.alternateOf).toEqual({ summarization: 'Sum', baseTable: 'FactSales', baseColumn: 'SalesAmount' });
    const grp = cols.find((c: any) => c.name === 'CustomerKey');
    expect(grp.alternateOf.summarization).toBe('GroupBy');
    expect(grp.alternateOf.baseColumn).toBe('CustomerKey');
  });
});

describe('buildSoapExecuteEnvelope', () => {
  it('wraps the TMSL in an Execute envelope with the Catalog', () => {
    const env = buildSoapExecuteEnvelope('SalesModel', '{"createOrReplace":{}}');
    expect(env).toContain('urn:schemas-microsoft-com:xml-analysis');
    expect(env).toContain('<Catalog>SalesModel</Catalog>');
    expect(env).toContain('<Statement>');
  });
});

describe('parseXmlaFault', () => {
  it('extracts a SOAP faultstring', () => {
    expect(parseXmlaFault('<Envelope><Body><Fault><faultstring>Table already exists</faultstring></Fault></Body></Envelope>'))
      .toBe('Table already exists');
  });
  it('returns null when there is no fault', () => {
    expect(parseXmlaFault('<return xmlns="urn:schemas-microsoft-com:xml-analysis"><root/></return>')).toBeNull();
  });
});

describe('executeAggTmsl', () => {
  it('POSTs the SOAP Execute to the configured endpoint with the SOAPAction header', async () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://srv.asazure.windows.net/xmla';
    let url = ''; let method = ''; let headers: any = {}; let body = '';
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET'; headers = init?.headers || {}; body = String(init?.body || '');
      return { _body: '<return><root/></return>' };
    });
    const r = await executeAggTmsl('SalesModel', '{"createOrReplace":{}}');
    expect(r).toEqual({ ok: true });
    expect(url).toBe('https://srv.asazure.windows.net/xmla');
    expect(method).toBe('POST');
    expect(String(headers['soapaction'])).toContain('Execute');
    expect(body).toContain('<Catalog>SalesModel</Catalog>');
  });

  it('throws AasError when the SOAP response embeds a faultstring (HTTP 200)', async () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://srv.asazure.windows.net/xmla';
    mockFetch(() => ({ _body: '<Envelope><Body><Fault><faultstring>Table already exists</faultstring></Fault></Body></Envelope>' }));
    await expect(executeAggTmsl('SalesModel', '{}')).rejects.toThrowError(/Table already exists/);
  });

  it('throws AasError on an HTTP error response', async () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://srv.asazure.windows.net/xmla';
    mockFetch(() => ({ _status: 401, _body: 'Unauthorized' }));
    await expect(executeAggTmsl('SalesModel', '{}')).rejects.toBeInstanceOf(AasError);
  });

  it('throws when no endpoint is configured', async () => {
    await expect(executeAggTmsl('SalesModel', '{}')).rejects.toThrowError(/LOOM_POWERBI_XMLA_ENDPOINT/);
  });
});

// ── Model view: pure TMSL builders (relationships + hierarchies) ────────────
// Assert the exact TMSL shapes written for relationships (incl. the
// isActive=false role-playing case used by USERELATIONSHIP), relationship
// deletes, and multi-level drill hierarchies, plus the full model.bim preview.
// No network — builders are pure.

const baseRel: TmslRelationship = {
  name: 'rel_ship',
  fromTable: 'FactSales', fromColumn: 'ShipDateKey',
  toTable: 'DimDate', toColumn: 'DateKey',
  fromCardinality: 'many', toCardinality: 'one',
  crossFilteringBehavior: 'oneDirection', isActive: false,
};

describe('buildCreateOrReplaceRelationshipTmsl', () => {
  it('emits a single-column relationship with isActive=false', () => {
    const obj = JSON.parse(buildCreateOrReplaceRelationshipTmsl('MyModel', baseRel));
    expect(obj.createOrReplace.object.database).toBe('MyModel');
    expect(obj.createOrReplace.object.relationship).toBe('rel_ship');
    const r = obj.createOrReplace.relationship;
    expect(r.fromTable).toBe('FactSales');
    expect(r.fromColumn).toBe('ShipDateKey');
    expect(r.toTable).toBe('DimDate');
    expect(r.toColumn).toBe('DateKey');
    expect(r.fromCardinality).toBe('many');
    expect(r.toCardinality).toBe('one');
    expect(r.crossFilteringBehavior).toBe('oneDirection');
    expect(r.isActive).toBe(false);
  });

  it('omits isActive when the relationship is active (TMSL default true)', () => {
    const obj = JSON.parse(buildCreateOrReplaceRelationshipTmsl('M', { ...baseRel, isActive: true }));
    expect('isActive' in obj.createOrReplace.relationship).toBe(false);
  });

  it('emits bothDirections for a both-direction cross filter', () => {
    const obj = JSON.parse(buildCreateOrReplaceRelationshipTmsl('M', { ...baseRel, crossFilteringBehavior: 'bothDirections' }));
    expect(obj.createOrReplace.relationship.crossFilteringBehavior).toBe('bothDirections');
  });
});

describe('buildDeleteRelationshipTmsl', () => {
  it('targets the named relationship in the database', () => {
    const obj = JSON.parse(buildDeleteRelationshipTmsl('MyModel', 'rel_ship'));
    expect(obj.delete.object.database).toBe('MyModel');
    expect(obj.delete.object.relationship).toBe('rel_ship');
  });
});

describe('buildAlterTableHierarchyTmsl', () => {
  it('serializes a 3-level hierarchy with correct ordinals + columns', () => {
    const obj = JSON.parse(buildAlterTableHierarchyTmsl('MyModel', 'DimDate', {
      name: 'Date',
      levels: [
        { ordinal: 0, name: 'Year', column: 'CalYear' },
        { ordinal: 1, name: 'Quarter', column: 'Quarter' },
        { ordinal: 2, name: 'Month', column: 'MonthNum' },
      ],
    }));
    expect(obj.alter.object.database).toBe('MyModel');
    expect(obj.alter.object.table).toBe('DimDate');
    const h = obj.alter.table.hierarchies[0];
    expect(h.name).toBe('Date');
    expect(h.levels).toHaveLength(3);
    expect(h.levels[0]).toMatchObject({ ordinal: 0, name: 'Year', column: 'CalYear' });
    expect(h.levels[2]).toMatchObject({ ordinal: 2, name: 'Month', column: 'MonthNum' });
  });

  it('sorts levels by ordinal even when supplied out of order', () => {
    const obj = JSON.parse(buildAlterTableHierarchyTmsl('M', 'T', {
      name: 'H',
      levels: [
        { ordinal: 2, name: 'C', column: 'c' },
        { ordinal: 0, name: 'A', column: 'a' },
        { ordinal: 1, name: 'B', column: 'b' },
      ],
    }));
    expect(obj.alter.table.hierarchies[0].levels.map((l: any) => l.column)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildModelBimTmsl', () => {
  it('produces a model.bim with tables, hierarchies, and an inactive relationship', () => {
    const tmsl = buildModelBimTmsl(
      'Sales Model',
      [
        { name: 'FactSales', columns: [{ name: 'ShipDateKey', dataType: 'int64' }, { name: 'Amount', dataType: 'double' }] },
        { name: 'DimDate', columns: [{ name: 'DateKey', dataType: 'int64' }, { name: 'CalYear', dataType: 'int64' }, { name: 'Quarter', dataType: 'string' }, { name: 'MonthNum', dataType: 'int64' }] },
      ],
      [baseRel],
      [{ name: 'Date Drill', table: 'DimDate', levels: [
        { ordinal: 0, name: 'Year', column: 'CalYear' },
        { ordinal: 1, name: 'Quarter', column: 'Quarter' },
        { ordinal: 2, name: 'Month', column: 'MonthNum' },
      ] }],
    );
    const obj = JSON.parse(tmsl);
    expect(obj.name).toBe('Sales Model');
    expect(obj.compatibilityLevel).toBe(1567);
    const dim = obj.model.tables.find((t: any) => t.name === 'DimDate');
    expect(dim.hierarchies[0].levels).toHaveLength(3);
    expect(dim.hierarchies[0].levels[2].column).toBe('MonthNum');
    const rel = obj.model.relationships[0];
    expect(rel.isActive).toBe(false);
    expect(rel.fromTable).toBe('FactSales');
    // FactSales carries no hierarchies → property omitted.
    const fact = obj.model.tables.find((t: any) => t.name === 'FactSales');
    expect('hierarchies' in fact).toBe(false);
  });
});

/*
 * aas-client — unit tests for the pure (no-network) helpers used by the
 * Loom-native report renderer: DAX synthesis, row flattening, and binding
 * resolution. The fetch-driven executeAasQuery is covered by the BFF route
 * + the live E2E receipt; these tests lock the deterministic logic.
 */

const SAVED = { ...process.env };

async function load(cloud?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_AAS_SERVER;
  delete process.env.LOOM_AAS_DATABASE;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  return import('../aas-dax');
}

afterEach(() => { process.env = { ...SAVED }; });

describe('buildDaxFromVisual', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('passes through an explicit EVALUATE expression', () => {
    expect(m.buildDaxFromVisual({ type: 'table', field: 'EVALUATE Sales' })).toBe('EVALUATE Sales');
    // case-insensitive
    expect(m.buildDaxFromVisual({ type: 'table', field: 'evaluate Sales' })).toBe('evaluate Sales');
  });

  it('wraps a measure/column in ROW for a card visual', () => {
    expect(m.buildDaxFromVisual({ type: 'card', field: '[Total Sales]' })).toBe('EVALUATE ROW("Value", [Total Sales])');
  });

  it('wraps a measure/column in TOPN(ROW) for a non-card visual', () => {
    expect(m.buildDaxFromVisual({ type: 'bar', field: 'Sales[Amount]' })).toBe('EVALUATE TOPN(100, ROW("Value", Sales[Amount]))');
  });

  it('TOPN-guards a bare table name', () => {
    expect(m.buildDaxFromVisual({ type: 'table', field: 'Customers' })).toBe('EVALUATE TOPN(100, Customers)');
  });

  it('returns null for an empty field', () => {
    expect(m.buildDaxFromVisual({ type: 'card', field: '' })).toBeNull();
    expect(m.buildDaxFromVisual({ type: 'card' })).toBeNull();
  });
});

describe('flattenAasRows', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('strips the [Table].[Column] prefix', () => {
    const rows = m.flattenAasRows({
      results: [{ tables: [{ rows: [{ '[Sales].[Amount]': 10, '[Sales].[Region]': 'East' }] }] }],
    });
    expect(rows).toEqual([{ Amount: 10, Region: 'East' }]);
  });

  it('strips a bare [Column] prefix', () => {
    const rows = m.flattenAasRows({ results: [{ tables: [{ rows: [{ '[Value]': 42 }] }] }] });
    expect(rows).toEqual([{ Value: 42 }]);
  });

  it('returns [] for an empty / shapeless result', () => {
    expect(m.flattenAasRows({ results: [] })).toEqual([]);
    expect(m.flattenAasRows({ results: [{ tables: [] }] })).toEqual([]);
  });
});

describe('resolveAasBinding', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('resolves from per-item state', () => {
    expect(m.resolveAasBinding('asazure://eastus2.asazure.windows.net/my-server', 'AdventureWorks')).toEqual({
      region: 'eastus2', serverName: 'my-server', database: 'AdventureWorks',
    });
  });

  it('falls back to env defaults', async () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus2.asazure.windows.net/env-server';
    process.env.LOOM_AAS_DATABASE = 'EnvModel';
    const m2 = await import('../aas-dax');
    expect(m2.resolveAasBinding(undefined, undefined)).toEqual({
      region: 'eastus2', serverName: 'env-server', database: 'EnvModel',
    });
  });

  it('returns null when nothing is bound', () => {
    expect(m.resolveAasBinding(undefined, undefined)).toBeNull();
    expect(m.resolveAasBinding('asazure://eastus2.asazure.windows.net/my-server', undefined)).toBeNull();
    expect(m.resolveAasBinding('not-a-server', 'Model')).toBeNull();
  });
});

// ===========================================================================
// PR #984 — Column metadata editor (TMSL Alter/Create) + XMLA SOAP transport.
// Uses the integrated aas-client exports: aasXmlaConfig, aasColumnEditorGate,
// buildAlterColumnTmsl, buildCreateCalcColumnTmsl, buildCreateCalcTableTmsl,
// buildExecuteEnvelope, buildDiscoverEnvelope, parseExecuteResponse,
// parseRowset, and command (the column-editor XMLA Execute).
// ===========================================================================
import {
  aasXmlaConfig,
  aasColumnEditorGate,
  buildAlterColumnTmsl,
  buildCreateCalcColumnTmsl,
  buildCreateCalcTableTmsl,
  buildExecuteEnvelope,
  buildDiscoverEnvelope,
  parseExecuteResponse,
  parseRowset,
  command as executeXmlaCommand,
} from '../aas-client';

const COL_ENV_KEYS = ['LOOM_AAS_SERVER_URL', 'LOOM_AAS_DATABASE', 'LOOM_POWERBI_XMLA_ENDPOINT', 'AZURE_CLOUD', 'LOOM_CLOUD'];
function clearColEnv() { for (const k of COL_ENV_KEYS) delete process.env[k]; }

describe('PR #984 buildAlterColumnTmsl', () => {
  beforeEach(() => { clearColEnv(); });
  afterEach(() => { clearColEnv(); });
  it('emits an Alter with the full column object (all read-write props)', () => {
    const t = buildAlterColumnTmsl('loomdb', 'Sales', {
      name: 'Amount', dataType: 'double', dataCategory: 'WebUrl', summarizeBy: 'sum',
      formatString: '#,0.00', displayFolder: 'Finance', sortByColumn: 'OrderDate', isHidden: false,
    });
    expect(t.alter.object).toEqual({ database: 'loomdb', table: 'Sales', column: 'Amount' });
    expect(t.alter.column.name).toBe('Amount');
    expect(t.alter.column.dataCategory).toBe('WebUrl');
    expect(t.alter.column.summarizeBy).toBe('sum');
    expect(t.alter.column.formatString).toBe('#,0.00');
    expect(t.alter.column.displayFolder).toBe('Finance');
    expect(t.alter.column.sortByColumn).toBe('OrderDate');
    expect(t.alter.column.isHidden).toBe(false);
  });
  it('drops undefined/empty props but keeps isHidden=true', () => {
    const t = buildAlterColumnTmsl('db', 'T', { name: 'C', dataType: 'string', isHidden: true });
    expect(t.alter.column).toEqual({ name: 'C', dataType: 'string', isHidden: true });
  });
});

describe('PR #984 buildCreateCalcColumnTmsl', () => {
  it('sets type=calculated and carries the DAX expression under the table', () => {
    const t = buildCreateCalcColumnTmsl('loomdb', 'Sales', {
      name: 'Margin', dataType: 'double', expression: '[Revenue] - [Cost]', displayFolder: 'Finance',
    });
    expect(t.create.parentObject).toEqual({ database: 'loomdb', table: 'Sales' });
    expect(t.create.column.type).toBe('calculated');
    expect(t.create.column.name).toBe('Margin');
    expect(t.create.column.expression).toBe('[Revenue] - [Cost]');
    expect(t.create.column.displayFolder).toBe('Finance');
  });
});

describe('PR #984 buildCreateCalcTableTmsl', () => {
  it('creates a table with a calculated partition source', () => {
    const t = buildCreateCalcTableTmsl('loomdb', 'DimDate', 'CALENDAR(DATE(2020,1,1),DATE(2025,12,31))');
    expect(t.create.parentObject).toEqual({ database: 'loomdb' });
    expect((t.create.table as any).name).toBe('DimDate');
    const part = (t.create.table as any).partitions[0];
    expect(part.source.type).toBe('calculated');
    expect(part.source.expression).toContain('CALENDAR');
  });
});

describe('PR #984 buildExecuteEnvelope', () => {
  it('wraps TMSL JSON in SOAP Execute/Command/Statement with the catalog', () => {
    const xml = buildExecuteEnvelope('{"alter":{}}', 'loomdb');
    expect(xml).toContain('urn:schemas-microsoft-com:xml-analysis');
    expect(xml).toContain('<Statement>{"alter":{}}</Statement>');
    expect(xml).toContain('<Catalog>loomdb</Catalog>');
  });
  it('XML-escapes < > & in DAX-bearing TMSL', () => {
    const xml = buildExecuteEnvelope('{"e":"a < b && c > d"}', 'db');
    expect(xml).toContain('a &lt; b &amp;&amp; c &gt; d');
    expect(xml).not.toContain('a < b');
  });
});

describe('PR #984 buildDiscoverEnvelope', () => {
  it('builds a TMSCHEMA Discover with restrictions + catalog', () => {
    const xml = buildDiscoverEnvelope('TMSCHEMA_COLUMNS', { TableID: '5' }, 'loomdb');
    expect(xml).toContain('<RequestType>TMSCHEMA_COLUMNS</RequestType>');
    expect(xml).toContain('<TableID>5</TableID>');
    expect(xml).toContain('<Catalog>loomdb</Catalog>');
  });
});

describe('PR #984 parseExecuteResponse', () => {
  it('succeeds (void) on an empty SOAP return', () => {
    expect(() => parseExecuteResponse('<Envelope><Body><ExecuteResponse><return><root/></return></ExecuteResponse></Body></Envelope>')).not.toThrow();
  });
  it('throws AasError on a SOAP faultstring', () => {
    expect(() => parseExecuteResponse('<Envelope><Body><Fault><faultstring>Column not found</faultstring></Fault></Body></Envelope>'))
      .toThrow(AasError);
  });
  it('throws AasError on an XMLA Error Description', () => {
    expect(() => parseExecuteResponse('<root><Messages><Error ErrorCode="3" Description="bad DAX"/></Messages></root>'))
      .toThrow(/bad DAX/);
  });
});

describe('PR #984 parseRowset', () => {
  it('parses <row> blocks, stripping namespace prefixes and unescaping values', () => {
    const xml = `<return><root xmlns="urn:schemas-microsoft-com:xml-analysis:rowset">
      <row><xsd:TableID>3</xsd:TableID><ExplicitName>Amount</ExplicitName><FormatString>#,0 &amp; more</FormatString></row>
      <row><TableID>3</TableID><ExplicitName>OrderDate</ExplicitName></row>
    </root></return>`;
    const rows = parseRowset(xml);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ TableID: '3', ExplicitName: 'Amount', FormatString: '#,0 & more' });
    expect(rows[1].ExplicitName).toBe('OrderDate');
  });
  it('throws AasError when the rowset is actually a fault', () => {
    expect(() => parseRowset('<Envelope><Body><Fault><faultstring>db not found</faultstring></Fault></Body></Envelope>')).toThrow(AasError);
  });
});

describe('PR #984 aasXmlaConfig', () => {
  beforeEach(() => { clearColEnv(); });
  afterEach(() => { clearColEnv(); });
  it('parses asazure:// into the XMLA HTTP URL + server-host scope', () => {
    process.env.LOOM_AAS_SERVER_URL = 'asazure://eastus2.asazure.windows.net/myserver';
    process.env.LOOM_AAS_DATABASE = 'loomdb';
    const cfg = aasXmlaConfig();
    expect(cfg?.backend).toBe('analysis-services');
    expect(cfg?.xmlaUrl).toBe('https://eastus2.asazure.windows.net/servers/myserver/models/loomdb/xmla');
    expect(cfg?.scope).toBe('https://eastus2.asazure.windows.net/.default');
    expect(cfg?.database).toBe('loomdb');
  });
  it('uses the Power BI XMLA endpoint when only that is set', () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'powerbi://api.powerbi.com/v1.0/myorg/Sales';
    process.env.LOOM_AAS_DATABASE = 'SalesModel';
    const cfg = aasXmlaConfig();
    expect(cfg?.backend).toBe('powerbi');
    expect(cfg?.xmlaUrl).toBe('https://api.powerbi.com/v1.0/myorg/Sales');
    expect(cfg?.scope).toBe('https://analysis.windows.net/powerbi/api/.default');
  });
  it('returns null when nothing is configured', () => {
    expect(aasXmlaConfig()).toBeNull();
  });
});

describe('PR #984 cloud matrix — aasColumnEditorGate', () => {
  beforeEach(() => { clearColEnv(); });
  afterEach(() => { clearColEnv(); });
  it('returns null when AAS is configured in Commercial', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    process.env.LOOM_AAS_SERVER_URL = 'asazure://eastus2.asazure.windows.net/srv';
    expect(aasColumnEditorGate()).toBeNull();
  });
  it('gates with an env-var detail in Commercial when nothing is set', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    const g = aasColumnEditorGate();
    expect(g).not.toBeNull();
    expect(g!.missing).toContain('LOOM_AAS_SERVER_URL');
  });
  it('does NOT gate in Gov when a Power BI Premium XMLA endpoint is provided', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://api.powerbigov.us/v1.0/myorg/M';
    expect(aasColumnEditorGate()).toBeNull();
  });
});

describe('PR #984 command (XMLA transport)', () => {
  const _realFetch = global.fetch;
  beforeEach(() => { clearColEnv(); global.fetch = _realFetch; });
  afterEach(() => { clearColEnv(); global.fetch = _realFetch; vi.restoreAllMocks(); });
  it('POSTs the serialized TMSL to the XMLA URL and returns the tmsl receipt', async () => {
    process.env.LOOM_AAS_SERVER_URL = 'asazure://eastus2.asazure.windows.net/srv';
    process.env.LOOM_AAS_DATABASE = 'loomdb';
    let captured: { url: string; body: string } | null = null;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      captured = { url: String(url), body: String(init?.body || '') };
      return new Response('<Envelope><Body><ExecuteResponse><return><root/></return></ExecuteResponse></Body></Envelope>', { status: 200 });
    }) as any;
    const out = await executeXmlaCommand(buildAlterColumnTmsl('loomdb', 'Sales', { name: 'Amount', dataType: 'double', dataCategory: 'WebUrl' }));
    expect(captured!.url).toBe('https://eastus2.asazure.windows.net/servers/srv/models/loomdb/xmla');
    expect(captured!.body).toContain('<Statement>{"alter":');
    expect(captured!.body).toContain('"dataCategory":"WebUrl"');
    expect(out.tmsl).toContain('"dataCategory":"WebUrl"');
  });
  it('throws AasError carrying the XMLA fault on a 200 fault response', async () => {
    process.env.LOOM_AAS_SERVER_URL = 'asazure://eastus2.asazure.windows.net/srv';
    global.fetch = vi.fn(async () => new Response('<Envelope><Body><Fault><faultstring>Column \'Bad\' does not exist</faultstring></Fault></Body></Envelope>', { status: 200 })) as any;
    await expect(executeXmlaCommand(buildAlterColumnTmsl('loomdb', 'Sales', { name: 'Bad', dataType: 'double' }))).rejects.toThrow(/does not exist/);
  });
  it('throws a 412 when no XMLA backend is configured', async () => {
    await expect(executeXmlaCommand(buildAlterColumnTmsl('db', 'T', { name: 'C', dataType: 'string' }))).rejects.toMatchObject({ status: 412 });
  });
});
