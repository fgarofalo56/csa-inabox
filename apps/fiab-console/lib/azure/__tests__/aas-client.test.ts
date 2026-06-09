import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  parseAasConnectionString, buildXmlaExecute, parseXmlaRowset,
} from '../aas-xmla';

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

async function loadAas(cloud?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_CLOUD;
  delete process.env.LOOM_AAS_HOST_SUFFIX;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  return import('../aas-xmla');
}

describe('aas-client — parseAasConnectionString', () => {
  it('parses an asazure:// connection string', () => {
    const t = parseAasConnectionString('Data Source=asazure://eastus2.asazure.windows.net/myserver');
    expect(t).toEqual({ region: 'eastus2', server: 'myserver', database: '' });
  });
  it('reads Initial Catalog as the database', () => {
    const t = parseAasConnectionString('Data Source=asazure://usgovvirginia.asazure.usgovcloudapi.net/srv;Initial Catalog=AdventureWorks');
    expect(t).toEqual({ region: 'usgovvirginia', server: 'srv', database: 'AdventureWorks' });
  });
  it('uses the fallback database when no catalog present', () => {
    const t = parseAasConnectionString('Data Source=asazure://eastus2.asazure.windows.net/srv', 'FromDataSet');
    expect(t?.database).toBe('FromDataSet');
  });
  it('returns null for a non-AAS connection string', () => {
    expect(parseAasConnectionString('Server=tcp:loom-ondemand.sql.azuresynapse.net')).toBeNull();
    expect(parseAasConnectionString('')).toBeNull();
  });
});

describe('aas-client — buildXmlaExecute', () => {
  it('embeds the catalog + escaped statement in an XMLA Execute envelope', () => {
    const body = buildXmlaExecute('AdventureWorks', 'EVALUATE TOPN(1, Sales) WHERE x < 5');
    expect(body).toContain('<Catalog>AdventureWorks</Catalog>');
    expect(body).toContain('<Format>Tabular</Format>');
    expect(body).toContain('x &lt; 5');
    expect(body).toContain('urn:schemas-microsoft-com:xml-analysis');
  });
});

describe('aas-client — parseXmlaRowset', () => {
  it('projects an XMLA tabular rowset into columns + rows', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body><ExecuteResponse><return><root>
        <row><State>WA</State><Amount>10</Amount></row>
        <row><State>OR</State><Amount>20</Amount></row>
      </root></return></ExecuteResponse></soap:Body></soap:Envelope>`;
    const { columns, rows } = parseXmlaRowset(xml);
    expect(columns).toEqual(['State', 'Amount']);
    expect(rows).toEqual([['WA', '10'], ['OR', '20']]);
  });
  it('returns empty for a rowset with no rows', () => {
    expect(parseXmlaRowset('<root></root>')).toEqual({ columns: [], rows: [] });
  });
});

describe('aas-client — endpoint URLs are sovereign-cloud aware', () => {
  it('Commercial uses asazure.windows.net', async () => {
    const m = await loadAas('AzureCloud');
    const t = { region: 'eastus2', server: 'srv', database: 'db' };
    expect(m.aasEndpointUrl(t)).toBe('https://eastus2.asazure.windows.net/servers/srv/models/db');
    expect(m.aasTokenScope(t)).toBe('https://eastus2.asazure.windows.net/.default');
  });
  it('Gov uses asazure.usgovcloudapi.net', async () => {
    const m = await loadAas('AzureUSGovernment');
    const t = { region: 'usgovvirginia', server: 'srv', database: 'db' };
    expect(m.aasEndpointUrl(t)).toBe('https://usgovvirginia.asazure.usgovcloudapi.net/servers/srv/models/db');
    expect(m.aasTokenScope(t)).toBe('https://usgovvirginia.asazure.usgovcloudapi.net/.default');
  });
});
