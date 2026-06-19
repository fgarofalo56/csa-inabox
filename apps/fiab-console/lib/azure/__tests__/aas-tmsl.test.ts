/**
 * aas-tmsl — unit tests for the network-free core of the Azure Analysis
 * Services XMLA client: server-base parsing, SOAP envelope escaping, fault
 * extraction, tabular row parsing, TMSL measure command shape, and the honest
 * 501 infra-gates (requireXmlaUrl / resolveDatabase).
 *
 * These live in aas-tmsl (no `@azure/identity` import) so they are fully
 * testable. The actual XMLA POST + credential surface (aas-client.ts) is
 * exercised against a real server in the deployed env — no mocks here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isAasConfigured,
  aasDefaultDatabase,
  requireXmlaUrl,
  resolveDatabase,
  xmlaUrl,
  buildSoapEnvelope,
  extractFault,
  parseXmlaRows,
  buildMeasureUpsertTmsl,
  buildMeasureEvalQuery,
} from '../aas-tmsl';

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.LOOM_AAS_SERVER;
  delete process.env.LOOM_AAS_DATABASE;
  delete process.env.LOOM_AAS_XMLA_URL;
  delete process.env.AZURE_CLOUD;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe('aas-tmsl — configuration gate', () => {
  it('isAasConfigured() is false when LOOM_AAS_SERVER is unset', () => {
    expect(isAasConfigured()).toBe(false);
    expect(aasDefaultDatabase()).toBe('');
  });

  it('isAasConfigured() is true once LOOM_AAS_SERVER is set', () => {
    process.env.LOOM_AAS_SERVER = 'asazure://westus.asazure.windows.net/myserver';
    process.env.LOOM_AAS_DATABASE = 'AdventureWorks';
    expect(isAasConfigured()).toBe(true);
    expect(aasDefaultDatabase()).toBe('AdventureWorks');
    expect(xmlaUrl()).toBe('https://westus.asazure.windows.net/servers/myserver');
  });

  it('LOOM_AAS_XMLA_URL overrides the POST target', () => {
    process.env.LOOM_AAS_SERVER = 'asazure://westus.asazure.windows.net/myserver';
    process.env.LOOM_AAS_XMLA_URL = 'https://gateway.example/xmla/';
    expect(xmlaUrl()).toBe('https://gateway.example/xmla');
  });

  it('requireXmlaUrl() throws AasError(501) when server unconfigured', () => {
    expect(() => requireXmlaUrl()).toThrowError(expect.objectContaining({ name: 'AasError', status: 501 }));
  });

  it('resolveDatabase() throws AasError(501) with no db arg and no env', () => {
    expect(() => resolveDatabase()).toThrowError(expect.objectContaining({ name: 'AasError', status: 501 }));
  });

  it('resolveDatabase() prefers the arg, falls back to LOOM_AAS_DATABASE', () => {
    process.env.LOOM_AAS_DATABASE = 'EnvDB';
    expect(resolveDatabase('ArgDB')).toBe('ArgDB');
    expect(resolveDatabase()).toBe('EnvDB');
  });
});

describe('aas-tmsl — SOAP envelope', () => {
  it('escapes &, <, > in DAX so the envelope stays valid XML', () => {
    const env = buildSoapEnvelope('DB1', 'EVALUATE FILTER(Sales, Sales[Amount] > 5 && Sales[Qty] < 10 & TRUE)');
    expect(env).toContain('&gt; 5 &amp;&amp; ');
    expect(env).toContain('&lt; 10 &amp; TRUE');
    // raw unescaped operators must NOT leak into the XML body
    expect(env).not.toContain('> 5 &&');
    expect(env).toContain('<Catalog>DB1</Catalog>');
    expect(env).toContain('<Format>Tabular</Format>');
  });
});

describe('aas-tmsl — fault + row parsing', () => {
  it('extractFault() reads <faultstring> with and without namespace prefix', () => {
    expect(extractFault('<soap:Fault><soap:faultstring>Boom happened</soap:faultstring></soap:Fault>')).toBe('Boom happened');
    expect(extractFault('<Fault><faultstring>Plain fault</faultstring></Fault>')).toBe('Plain fault');
  });

  it('extractFault() reads AS engine <Error Description="..."/>', () => {
    expect(extractFault('<root><Error ErrorCode="3" Description="The table Foo does not exist."/></root>'))
      .toBe('The table Foo does not exist.');
  });

  it('extractFault() returns null for a clean response', () => {
    expect(extractFault('<return><root/></return>')).toBeNull();
  });

  it('parseXmlaRows() extracts named columns from <row> elements', () => {
    expect(parseXmlaRows('<root><row><value>1234.5</value></row></root>')).toEqual([{ value: '1234.5' }]);
  });

  it('parseXmlaRows() handles multiple rows + columns', () => {
    const xml = '<root>' +
      '<row><Region>East</Region><Total>10</Total></row>' +
      '<row><Region>West</Region><Total>20</Total></row>' +
      '</root>';
    expect(parseXmlaRows(xml)).toEqual([
      { Region: 'East', Total: '10' },
      { Region: 'West', Total: '20' },
    ]);
  });
});

describe('aas-tmsl — TMSL measure command + eval query', () => {
  it('buildMeasureUpsertTmsl() emits createOrReplace scoped to the measure with format + folder', () => {
    const cmd: any = buildMeasureUpsertTmsl({
      database: 'AdventureWorks',
      tableName: 'Sales',
      measureName: 'TotalSales',
      expression: 'SUM(Sales[Amount])',
      formatString: '$#,0.00;($#,0.00);$#,0.00',
      displayFolder: 'Finance\\KPIs',
    });
    expect(cmd.createOrReplace.object).toEqual({ database: 'AdventureWorks', table: 'Sales', measure: 'TotalSales' });
    expect(cmd.createOrReplace.measure).toEqual({
      name: 'TotalSales',
      expression: 'SUM(Sales[Amount])',
      formatString: '$#,0.00;($#,0.00);$#,0.00',
      displayFolder: 'Finance\\KPIs',
    });
  });

  it('buildMeasureUpsertTmsl() omits optional props when absent', () => {
    const cmd: any = buildMeasureUpsertTmsl({ database: 'DB', tableName: 'T', measureName: 'M', expression: '1' });
    expect(cmd.createOrReplace.measure).toEqual({ name: 'M', expression: '1' });
    expect(cmd.createOrReplace.measure.formatString).toBeUndefined();
    expect(cmd.createOrReplace.measure.displayFolder).toBeUndefined();
  });

  it('buildMeasureEvalQuery() quotes the table and brackets the measure', () => {
    expect(buildMeasureEvalQuery('Sales', 'TotalSales')).toBe(`EVALUATE ROW("value", 'Sales'[TotalSales])`);
    // single quotes in a table name are doubled (DAX escaping)
    expect(buildMeasureEvalQuery("O'Brien", 'M')).toBe(`EVALUATE ROW("value", 'O''Brien'[M])`);
  });
});
