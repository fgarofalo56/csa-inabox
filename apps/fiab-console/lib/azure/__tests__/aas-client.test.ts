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
