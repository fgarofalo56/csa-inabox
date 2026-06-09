/**
 * Backend contract tests for aas-client (Azure Analysis Services / Power BI
 * Premium XMLA). Pure builder + parser functions are exercised directly; the
 * XMLA HTTP transport is verified against a stubbed global.fetch. No live
 * tenant — @azure/identity is mocked. Asserts the REAL TMSL JSON shapes the
 * engine accepts (Alter / Create) per no-vaporware.md, and the cloud-matrix
 * availability gate (AAS is Commercial/GCC only) per no-fabric-dependency.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  buildAlterColumnTmsl,
  buildCreateCalcColumnTmsl,
  buildCreateCalcTableTmsl,
  buildExecuteEnvelope,
  buildDiscoverEnvelope,
  parseExecuteResponse,
  parseRowset,
  aasXmlaConfig,
  aasConfigGate,
  command,
  AasError,
} from '../aas-client';

const realFetch = global.fetch;
const ENV_KEYS = ['LOOM_AAS_SERVER_URL', 'LOOM_AAS_DATABASE', 'LOOM_POWERBI_XMLA_ENDPOINT', 'AZURE_CLOUD', 'LOOM_CLOUD'];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }

beforeEach(() => { clearEnv(); });
afterEach(() => { clearEnv(); global.fetch = realFetch; vi.restoreAllMocks(); });

describe('buildAlterColumnTmsl', () => {
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
    // isHidden:false must be preserved (not dropped as falsy).
    expect(t.alter.column.isHidden).toBe(false);
  });
  it('drops undefined/empty props but keeps isHidden=true', () => {
    const t = buildAlterColumnTmsl('db', 'T', { name: 'C', dataType: 'string', isHidden: true });
    expect(t.alter.column).toEqual({ name: 'C', dataType: 'string', isHidden: true });
  });
});

describe('buildCreateCalcColumnTmsl', () => {
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

describe('buildCreateCalcTableTmsl', () => {
  it('creates a table with a calculated partition source', () => {
    const t = buildCreateCalcTableTmsl('loomdb', 'DimDate', 'CALENDAR(DATE(2020,1,1),DATE(2025,12,31))');
    expect(t.create.parentObject).toEqual({ database: 'loomdb' });
    expect((t.create.table as any).name).toBe('DimDate');
    const part = (t.create.table as any).partitions[0];
    expect(part.source.type).toBe('calculated');
    expect(part.source.expression).toContain('CALENDAR');
  });
});

describe('buildExecuteEnvelope', () => {
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

describe('buildDiscoverEnvelope', () => {
  it('builds a TMSCHEMA Discover with restrictions + catalog', () => {
    const xml = buildDiscoverEnvelope('TMSCHEMA_COLUMNS', { TableID: '5' }, 'loomdb');
    expect(xml).toContain('<RequestType>TMSCHEMA_COLUMNS</RequestType>');
    expect(xml).toContain('<TableID>5</TableID>');
    expect(xml).toContain('<Catalog>loomdb</Catalog>');
  });
});

describe('parseExecuteResponse', () => {
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

describe('parseRowset', () => {
  it('parses <row> blocks, stripping namespace prefixes and unescaping values', () => {
    const xml = `<return><root xmlns="urn:schemas-microsoft-com:xml-analysis:rowset">
      <row><TableID>3</TableID><ExplicitName>Amount</ExplicitName><FormatString>#,0 &amp; more</FormatString></row>
      <row><TableID>3</TableID><ExplicitName>OrderDate</ExplicitName></row>
    </root></return>`;
    const rows = parseRowset(xml);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ TableID: '3', ExplicitName: 'Amount', FormatString: '#,0 & more' });
    expect(rows[1].ExplicitName).toBe('OrderDate');
  });
  it('throws AasError when the rowset is actually a fault', () => {
    expect(() => parseRowset('<Envelope><Body><Fault><faultstring>db not found</faultstring></Fault></Body></Envelope>')).toThrow(AasError);
  });
});

describe('aasXmlaConfig', () => {
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

describe('cloud matrix — aasConfigGate', () => {
  it('returns null when AAS is configured in Commercial', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    process.env.LOOM_AAS_SERVER_URL = 'asazure://eastus2.asazure.windows.net/srv';
    expect(aasConfigGate()).toBeNull();
  });
  it('gates with an env-var detail in Commercial when nothing is set', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    const g = aasConfigGate();
    expect(g).not.toBeNull();
    expect(g!.missing).toContain('LOOM_AAS_SERVER_URL');
  });
  it('gates with a Gov-availability detail in GCC-High', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    const g = aasConfigGate();
    expect(g).not.toBeNull();
    expect(g!.detail).toMatch(/not available|Government|Premium XMLA/i);
  });
  it('does NOT gate in Gov when a Power BI Premium XMLA endpoint is provided', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'https://api.powerbigov.us/v1.0/myorg/M';
    expect(aasConfigGate()).toBeNull();
  });
});

describe('command (XMLA transport)', () => {
  it('POSTs the serialized TMSL to the XMLA URL and returns the tmsl receipt', async () => {
    process.env.LOOM_AAS_SERVER_URL = 'asazure://eastus2.asazure.windows.net/srv';
    process.env.LOOM_AAS_DATABASE = 'loomdb';
    let captured: { url: string; body: string } | null = null;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      captured = { url: String(url), body: String(init?.body || '') };
      return new Response('<Envelope><Body><ExecuteResponse><return><root/></return></ExecuteResponse></Body></Envelope>', { status: 200 });
    }) as any;
    const out = await command(buildAlterColumnTmsl('loomdb', 'Sales', { name: 'Amount', dataType: 'double', dataCategory: 'WebUrl' }));
    expect(captured!.url).toBe('https://eastus2.asazure.windows.net/servers/srv/models/loomdb/xmla');
    // JSON quotes don't need XML escaping inside element text — the TMSL JSON
    // is embedded verbatim within <Statement>.
    expect(captured!.body).toContain('<Statement>{"alter":');
    expect(captured!.body).toContain('"dataCategory":"WebUrl"');
    expect(out.tmsl).toContain('"dataCategory":"WebUrl"');
  });
  it('throws AasError carrying the XMLA fault on a 200 fault response', async () => {
    process.env.LOOM_AAS_SERVER_URL = 'asazure://eastus2.asazure.windows.net/srv';
    global.fetch = vi.fn(async () => new Response('<Envelope><Body><Fault><faultstring>Column \'Bad\' does not exist</faultstring></Fault></Body></Envelope>', { status: 200 })) as any;
    await expect(command(buildAlterColumnTmsl('loomdb', 'Sales', { name: 'Bad', dataType: 'double' }))).rejects.toThrow(/does not exist/);
  });
  it('throws a 412 when no XMLA backend is configured', async () => {
    await expect(command(buildAlterColumnTmsl('db', 'T', { name: 'C', dataType: 'string' }))).rejects.toMatchObject({ status: 412 });
  });
});
