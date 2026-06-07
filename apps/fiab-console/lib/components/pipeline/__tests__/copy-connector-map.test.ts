import { describe, it, expect } from 'vitest';
import {
  resolveConnector, categoryOfCopyType, CONNECTOR_MAP,
} from '../copy/copy-connector-map';
import { findByKey } from '../activity-catalog';

// ----------------------------------------------------------------------------
// Copy activity connector map — the dataset.type → Copy source/sink type table
// that the Source/Sink tabs use to keep `typeProperties.source.type` /
// `sink.type` valid when a dataset is picked. Pure data, no DOM.
// ----------------------------------------------------------------------------

describe('copy-connector-map', () => {
  it('maps common dataset types to the right Copy source/sink type', () => {
    expect(resolveConnector('AzureBlob')).toMatchObject({ source: 'BlobSource', sink: 'BlobSink', category: 'fileBased' });
    expect(resolveConnector('AzureSqlTable')).toMatchObject({ source: 'AzureSqlSource', sink: 'AzureSqlSink', category: 'sqlBased' });
    expect(resolveConnector('AzureSqlDWTable')).toMatchObject({ source: 'SqlDWSource', sink: 'SqlDWSink', category: 'sqlBased' });
    expect(resolveConnector('CosmosDbSqlApiCollection')).toMatchObject({ source: 'CosmosDbSqlApiSource', category: 'other' });
  });

  it('falls back to a category by heuristic for unknown dataset types', () => {
    expect(resolveConnector('SomeNewParquetThing').category).toBe('fileBased');
    expect(resolveConnector('VendorSqlWarehouse').category).toBe('sqlBased');
    expect(resolveConnector('WeirdConnector').category).toBe('other');
    expect(resolveConnector(undefined).category).toBe('other');
  });

  it('does not invent a source/sink type for unknown connectors (preserve existing)', () => {
    const r = resolveConnector('TotallyUnknown');
    expect(r.source).toBeUndefined();
    expect(r.sink).toBeUndefined();
  });

  it('classifies an existing Copy source/sink type back into its family', () => {
    expect(categoryOfCopyType('BlobSource')).toBe('fileBased');
    expect(categoryOfCopyType('AzureSqlSink')).toBe('sqlBased');
    expect(categoryOfCopyType('SqlDWSource')).toBe('sqlBased');
    expect(categoryOfCopyType('RestSource')).toBe('other');
    expect(categoryOfCopyType(undefined)).toBe('other');
  });

  it('every CONNECTOR_MAP entry has a valid category', () => {
    for (const [k, v] of Object.entries(CONNECTOR_MAP)) {
      expect(['fileBased', 'sqlBased', 'other'], `${k}`).toContain(v.category);
      if (v.source) expect(typeof v.source).toBe('string');
      if (v.sink) expect(typeof v.sink).toBe('string');
    }
  });
});

describe('Copy catalog default still carries source + sink', () => {
  it('build() stamps a source/sink and the no-Fabric Azure defaults', () => {
    const copy = findByKey('Copy')!.build('Copy1');
    expect(copy.typeProperties).toHaveProperty('source');
    expect(copy.typeProperties).toHaveProperty('sink');
    expect((copy.typeProperties as any).enableStaging).toBe(false);
    // inputs/outputs start empty so the Source/Sink dataset pickers drive them.
    expect(copy.inputs).toEqual([]);
    expect(copy.outputs).toEqual([]);
  });
});
