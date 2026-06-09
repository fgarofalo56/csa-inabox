/**
 * Composite + Dual storage mode — TMSL builder + cloud-matrix guards.
 *
 * buildCompositeTmsl() must emit a per-partition `mode` (import / directQuery /
 * dual) so a single tabular model can mix storage modes, auto-create a
 * model-level dataSource for DQ/Dual partitions, and reject Dual when targeting
 * standalone AAS. The cloud-matrix rows guard that the AAS data-plane suffix +
 * scope flip to the Government values on Gov/DoD boundaries.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildCompositeTmsl, AasError, TABLE_STORAGE_MODES } from '../aas-client';

describe('buildCompositeTmsl — per-partition storage mode', () => {
  it('import table → partition mode=import, source.type=none', () => {
    const tmsl = JSON.parse(buildCompositeTmsl('M', [{ name: 'Sales', mode: 'import', columns: [{ name: 'Amount', dataType: 'double' }] }]));
    const t = tmsl.model.tables[0];
    expect(t.partitions[0].mode).toBe('import');
    expect(t.partitions[0].source.type).toBe('none');
    // import tables don't emit a model-level dataSource
    expect(tmsl.model.dataSources).toBeUndefined();
  });

  it('directQuery table → mode=directQuery, source.type=query, dataSources entry', () => {
    const tmsl = JSON.parse(buildCompositeTmsl('M', [
      { name: 'FactSales', mode: 'directQuery', sourceQuery: 'SELECT 1 AS X', dataSourceName: 'SqlDs', columns: [] },
    ]));
    const p = tmsl.model.tables[0].partitions[0];
    expect(p.mode).toBe('directQuery');
    expect(p.source.type).toBe('query');
    expect(p.source.query).toBe('SELECT 1 AS X');
    expect(p.source.dataSource).toBe('SqlDs');
    expect(tmsl.model.dataSources).toHaveLength(1);
    expect(tmsl.model.dataSources[0].name).toBe('SqlDs');
  });

  it('dual table → mode=dual, source.type=query (Fabric engine)', () => {
    const tmsl = JSON.parse(buildCompositeTmsl('M', [
      { name: 'DimDate', mode: 'dual', sourceQuery: 'SELECT * FROM DimDate', dataSourceName: 'SqlDs', columns: [] },
    ]));
    expect(tmsl.model.tables[0].partitions[0].mode).toBe('dual');
    expect(tmsl.model.tables[0].partitions[0].source.type).toBe('query');
  });

  it('mixed model: import + DQ + dual emits correct modes + a single shared dataSource', () => {
    const tmsl = JSON.parse(buildCompositeTmsl('Composite', [
      { name: 'DimCustomer', mode: 'import', columns: [] },
      { name: 'FactSales', mode: 'directQuery', sourceQuery: 'SELECT * FROM FactSales', dataSourceName: 'SqlDs', columns: [] },
      { name: 'DimDate', mode: 'dual', sourceQuery: 'SELECT * FROM DimDate', dataSourceName: 'SqlDs', columns: [] },
    ], [
      { fromTable: 'FactSales', fromColumn: 'CustomerId', toTable: 'DimCustomer', toColumn: 'Id' },
      { fromTable: 'FactSales', fromColumn: 'DateId', toTable: 'DimDate', toColumn: 'Id' },
    ]));
    const modes = tmsl.model.tables.map((t: any) => t.partitions[0].mode);
    expect(modes).toEqual(['import', 'directQuery', 'dual']);
    // SqlDs referenced by both DQ and Dual → exactly one dataSources entry
    expect(tmsl.model.dataSources).toHaveLength(1);
    // cross-mode relationships resolve
    expect(tmsl.model.relationships).toHaveLength(2);
    expect(tmsl.model.relationships[0].crossFilteringBehavior).toBe('oneDirection');
    expect(tmsl.compatibilityLevel).toBe(1567);
  });

  it('auto-creates a default dataSource when DQ table omits dataSourceName', () => {
    const tmsl = JSON.parse(buildCompositeTmsl('M', [
      { name: 'F', mode: 'directQuery', sourceQuery: 'SELECT 1', columns: [] },
    ]));
    expect(tmsl.model.dataSources).toHaveLength(1);
    expect(tmsl.model.tables[0].partitions[0].source.dataSource).toBe(tmsl.model.dataSources[0].name);
  });

  it('throws when a DQ/Dual table has no sourceQuery', () => {
    expect(() => buildCompositeTmsl('M', [{ name: 'F', mode: 'directQuery', columns: [] }])).toThrow(AasError);
  });

  it('rejects Dual when targetEngine is aas-standalone', () => {
    expect(() =>
      buildCompositeTmsl('M', [{ name: 'D', mode: 'dual', sourceQuery: 'SELECT 1', columns: [] }], undefined, undefined, { targetEngine: 'aas-standalone' }),
    ).toThrow(/standalone Azure Analysis Services/);
  });

  it('throws on an invalid mode', () => {
    expect(() => buildCompositeTmsl('M', [{ name: 'X', mode: 'streaming' as any, columns: [] }])).toThrow(AasError);
  });

  it('throws on an empty table list', () => {
    expect(() => buildCompositeTmsl('M', [])).toThrow(AasError);
  });

  it('exports the three canonical storage modes', () => {
    expect([...TABLE_STORAGE_MODES]).toEqual(['import', 'directQuery', 'dual']);
  });
});

const SAVED = { ...process.env };
async function loadEndpoints(cloud?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_ARM_ENDPOINT;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  return import('../cloud-endpoints');
}
afterEach(() => { process.env = { ...SAVED }; });

describe('AAS data-plane cloud matrix', () => {
  it('Commercial → asazure.windows.net + Commercial scope', async () => {
    const m = await loadEndpoints('AzureCloud');
    expect(m.aasSuffix()).toBe('asazure.windows.net');
    expect(m.aasScope()).toBe('https://asazure.windows.net/.default');
    expect(m.aasRestBase('westus2', 'aasloom', 'LoomComposite')).toBe(
      'https://westus2.asazure.windows.net/servers/aasloom/models/LoomComposite',
    );
  });

  it('GCC-High (AzureUSGovernment) → asazure.usgovcloudapi.net + Gov scope', async () => {
    const m = await loadEndpoints('AzureUSGovernment');
    expect(m.aasSuffix()).toBe('asazure.usgovcloudapi.net');
    expect(m.aasScope()).toBe('https://asazure.usgovcloudapi.net/.default');
  });

  it('DoD (AzureDOD) → Gov AAS suffix', async () => {
    const m = await loadEndpoints('AzureDOD');
    expect(m.aasSuffix()).toBe('asazure.usgovcloudapi.net');
  });
});
