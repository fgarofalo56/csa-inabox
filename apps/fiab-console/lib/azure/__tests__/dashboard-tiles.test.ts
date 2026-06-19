/**
 * Dashboard-tiles unit tests — the pure logic behind the Loom dashboard overlay
 * (pin / Q&A / streaming tiles) and the Azure Analysis Services DAX backend.
 *
 * Covers:
 *   - cloud-endpoints aasSuffix() / aasScope() split (Commercial vs Gov)
 *   - dashboard-overlay sanitize* whitelist (no free-form blobs; clamps spans)
 *   - aas-client buildAasXmlaUrl() URL construction + XMLA rowset parsing
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeOverlay, sanitizeTile, sanitizeLayout } from '../dashboard-overlay';
import { buildAasXmlaUrl, AasError, parseRowset } from '../aas-xmla';

const SAVED_CLOUD = process.env.AZURE_CLOUD;
afterEach(() => {
  if (SAVED_CLOUD === undefined) delete process.env.AZURE_CLOUD;
  else process.env.AZURE_CLOUD = SAVED_CLOUD;
});

describe('cloud-endpoints — AAS suffix/scope', () => {
  it('Commercial → asazure.windows.net', async () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    vi.resetModules();
    const m = await import('../cloud-endpoints');
    expect(m.aasSuffix()).toBe(['asazure', 'windows', 'net'].join('.'));
    expect(m.aasScope()).toBe(`https://*.${['asazure', 'windows', 'net'].join('.')}`);
  });

  it('Gov → asazure.usgovcloudapi.net', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    vi.resetModules();
    const m = await import('../cloud-endpoints');
    expect(m.aasSuffix()).toBe(['asazure', 'usgovcloudapi', 'net'].join('.'));
    expect(m.aasScope()).toContain('usgovcloudapi');
  });
});

describe('dashboard-overlay — sanitizeTile', () => {
  it('accepts a valid streaming tile and clamps spans + refresh', () => {
    const t = sanitizeTile({
      id: 'a', kind: 'streaming-adx', title: 'Live', query: 'T | take 1',
      database: 'db', viz: 'timechart', autoRefreshMs: 1000, w: 99, h: -3,
    });
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('streaming-adx');
    expect(t!.autoRefreshMs).toBe(5000); // clamped up to the 5s floor
    expect(t!.w).toBe(12);               // clamped to 12 cols
    expect(t!.h).toBe(1);                // clamped to >= 1
  });

  it('rejects an unknown kind', () => {
    expect(sanitizeTile({ id: 'x', kind: 'sql', title: 'X', query: 'select 1' })).toBeNull();
  });

  it('rejects a tile with no query', () => {
    expect(sanitizeTile({ id: 'x', kind: 'dax', title: 'X', query: '   ' })).toBeNull();
  });

  it('drops an unknown viz to undefined and mints an id when missing', () => {
    const t = sanitizeTile({ kind: 'dax', title: 'M', query: 'EVALUATE ROW("x",1)', viz: 'sankey' });
    expect(t).not.toBeNull();
    expect(t!.viz).toBeUndefined();
    expect(t!.id.length).toBeGreaterThan(0);
  });
});

describe('dashboard-overlay — sanitizeLayout / sanitizeOverlay', () => {
  it('keeps only well-formed layout entries and clamps', () => {
    const l = sanitizeLayout({ a: { col: 20, row: -1, w: 0, h: 99 }, b: { col: 2 }, c: 'nope' });
    expect(l.a).toEqual({ col: 11, row: 0, w: 1, h: 12 });
    expect(l.b).toBeUndefined();      // incomplete
    expect((l as any).c).toBeUndefined();
  });

  it('builds a full overlay doc, dropping invalid tiles', () => {
    const doc = sanitizeOverlay('item-1', {
      pbiWorkspaceId: 'ws', pbiDashboardId: 'dash',
      loomTiles: [
        { id: 't1', kind: 'kusto', title: 'A', query: 'T | take 1', database: 'db' },
        { id: 't2', kind: 'bogus', title: 'B', query: 'x' },
      ],
      layout: { t1: { col: 0, row: 0, w: 4, h: 2 } },
    }, 'user@example.com');
    expect(doc.id).toBe('item-1');
    expect(doc.itemId).toBe('item-1');
    expect(doc.loomTiles).toHaveLength(1);
    expect(doc.loomTiles[0].id).toBe('t1');
    expect(doc.layout.t1.w).toBe(4);
    expect(doc.updatedBy).toBe('user@example.com');
    expect(typeof doc.updatedAt).toBe('string');
  });
});

describe('aas-client — buildAasXmlaUrl', () => {
  it('builds the servers/<name> XMLA URL from <host>/<server>', () => {
    expect(buildAasXmlaUrl('westus2.asazure.windows.net/myserver'))
      .toBe('https://westus2.asazure.windows.net/servers/myserver');
  });

  it('strips an asazure:// or https:// scheme prefix', () => {
    expect(buildAasXmlaUrl('asazure://westus2.asazure.windows.net/srv'))
      .toBe('https://westus2.asazure.windows.net/servers/srv');
    expect(buildAasXmlaUrl('https://eastus.asazure.usgovcloudapi.net/g'))
      .toBe('https://eastus.asazure.usgovcloudapi.net/servers/g');
  });

  it('throws AasError when no server name is present', () => {
    expect(() => buildAasXmlaUrl('westus2.asazure.windows.net')).toThrow(AasError);
  });
});

describe('aas-client — parseRowset', () => {
  it('parses a tabular XMLA rowset, decoding column escapes + coercing numbers', () => {
    const xml =
      '<soap:Envelope><soap:Body><ExecuteResponse><return>' +
      '<root xmlns="urn:schemas-microsoft-com:xml-analysis:rowset">' +
      '<row><Sales_x005B_Region_x005D_>West</Sales_x005B_Region_x005D_><Total>1200</Total></row>' +
      '<row><Sales_x005B_Region_x005D_>East</Sales_x005B_Region_x005D_><Total>980</Total></row>' +
      '</root></return></ExecuteResponse></soap:Body></soap:Envelope>';
    const { columns, rows } = parseRowset(xml);
    expect(columns).toEqual(['Sales[Region]', 'Total']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['West', 1200]);
    expect(rows[1]).toEqual(['East', 980]);
  });

  it('surfaces an XMLA fault as an AasError', () => {
    const xml = '<soap:Envelope><soap:Body><soap:Fault><faultstring>Bad DAX syntax</faultstring></soap:Fault></soap:Body></soap:Envelope>';
    expect(() => parseRowset(xml)).toThrow(/Bad DAX syntax/);
  });
});
