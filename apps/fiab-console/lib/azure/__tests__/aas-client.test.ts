/**
 * Contract tests for aas-client.ts — the XMLA TMSL write client behind the
 * Semantic Model "Automatic aggregations" surface.
 *
 *   - xmlaConfigGate     — honest infra-gate when LOOM_POWERBI_XMLA_ENDPOINT unset
 *   - xmlaScope          — sovereign-cloud AAD audience split
 *   - buildAggTableTmsl  — pure TMSL `createOrReplace` + `alternateOf` shaping
 *   - executeTmsl        — real SOAP Execute POST + XMLA fault surfacing
 *
 * Stubs @azure/identity + global.fetch — no live AAS / Premium capacity
 * required. Per no-vaporware, the tests exercise the actual code path.
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
  executeTmsl,
  AasError,
  type AltMap,
} from '../aas-client';

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

describe('executeTmsl', () => {
  it('POSTs the SOAP Execute to the configured endpoint with the SOAPAction header', async () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://srv.asazure.windows.net/xmla';
    let url = ''; let method = ''; let headers: any = {}; let body = '';
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET'; headers = init?.headers || {}; body = String(init?.body || '');
      return { _body: '<return><root/></return>' };
    });
    const r = await executeTmsl('SalesModel', '{"createOrReplace":{}}');
    expect(r).toEqual({ ok: true });
    expect(url).toBe('https://srv.asazure.windows.net/xmla');
    expect(method).toBe('POST');
    expect(String(headers['soapaction'])).toContain('Execute');
    expect(body).toContain('<Catalog>SalesModel</Catalog>');
  });

  it('throws AasError when the SOAP response embeds a faultstring (HTTP 200)', async () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://srv.asazure.windows.net/xmla';
    mockFetch(() => ({ _body: '<Envelope><Body><Fault><faultstring>Table already exists</faultstring></Fault></Body></Envelope>' }));
    await expect(executeTmsl('SalesModel', '{}')).rejects.toThrowError(/Table already exists/);
  });

  it('throws AasError on an HTTP error response', async () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://srv.asazure.windows.net/xmla';
    mockFetch(() => ({ _status: 401, _body: 'Unauthorized' }));
    await expect(executeTmsl('SalesModel', '{}')).rejects.toBeInstanceOf(AasError);
  });

  it('throws when no endpoint is configured', async () => {
    await expect(executeTmsl('SalesModel', '{}')).rejects.toThrowError(/LOOM_POWERBI_XMLA_ENDPOINT/);
  });
});
