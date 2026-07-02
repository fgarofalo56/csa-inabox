import { describe, it, expect } from 'vitest';
import {
  copySourceFor, copySinkFor, copyFormatSettingsFor, familyForConnector,
  copyCoverageForAllConnectors, connectorSupportsSink,
  COPY_SOURCE_SETTINGS, COPY_SINK_SETTINGS, COPY_SETTINGS_SPEC,
  COPY_GENERIC_BY_FAMILY, DIU_VALUES, STAGING_LINKED_SERVICE_TYPES,
} from '@/lib/pipeline/copy-activity-catalog';
import { CONNECTORS } from '@/lib/pipeline/connector-catalog';

// ----------------------------------------------------------------------------
// copy-activity-catalog — the data-driven Copy source/sink + settings inventory
// that drives the Copy editor's Source/Sink/Settings tabs. Pure data, no DOM.
// ----------------------------------------------------------------------------

describe('copy-activity-catalog', () => {
  it('maps SQL connectors to the right source/sink Copy types', () => {
    expect(copySourceFor('AzureSqlDatabase').typeName).toBe('AzureSqlSource');
    expect(copySinkFor('AzureSqlDatabase').typeName).toBe('AzureSqlSink');
    expect(copySourceFor('AzureSqlDW').typeName).toBe('SqlDWSource');
    expect(copySinkFor('AzureSqlDW').typeName).toBe('SqlDWSink');
  });

  it('exposes the per-store source fields verbatim from Learn', () => {
    const sqlSrc = copySourceFor('AzureSqlDatabase');
    const keys = sqlSrc.fields.map((f) => f.key);
    expect(keys).toContain('sqlReaderQuery');
    expect(keys).toContain('sqlReaderStoredProcedureName');
    expect(keys).toContain('partitionOption');
    expect(keys).toContain('isolationLevel');

    const sqlSink = copySinkFor('AzureSqlDatabase');
    const sinkKeys = sqlSink.fields.map((f) => f.key);
    expect(sinkKeys).toContain('writeBehavior');
    expect(sinkKeys).toContain('preCopyScript');
    expect(sinkKeys).toContain('sqlWriterStoredProcedureName');
    expect(sinkKeys).toContain('tableOption');
  });

  it('gives file connectors store read/write settings', () => {
    const src = copySourceFor('AzureBlobFS');
    expect(src.family).toBe('file');
    const ss = (src.storeSettings || []).map((f) => f.key);
    expect(ss).toContain('recursive');
    expect(ss).toContain('wildcardFolderPath');
    expect(ss).toContain('modifiedDatetimeStart');
    expect(ss).toContain('partitionRootPath');

    const sink = copySinkFor('AzureBlobFS');
    const ws = (sink.storeSettings || []).map((f) => f.key);
    expect(ws).toContain('copyBehavior');
  });

  it('gives REST source pagination + interval, and a sink', () => {
    const src = copySourceFor('RestService');
    const keys = src.fields.map((f) => f.key);
    expect(src.typeName).toBe('RestSource');
    expect(keys).toContain('paginationRules');
    expect(keys).toContain('requestInterval');
    expect(copySinkFor('RestService').typeName).toBe('RestSink');
  });

  it('gives NoSQL Cosmos source query and sink writeBehavior', () => {
    const src = copySourceFor('CosmosDb');
    expect(src.typeName).toBe('CosmosDbSqlApiSource');
    expect(src.fields.map((f) => f.key)).toContain('query');
    const sink = copySinkFor('CosmosDb');
    expect(sink.typeName).toBe('CosmosDbSqlApiSink');
    expect(sink.fields.map((f) => f.key)).toContain('writeBehavior');
  });

  it('falls back to a family generic for unknown connectors (never blank)', () => {
    // Unknown but file-shaped name → file generic.
    expect(copySourceFor('SomeVendorBlobThing').family).toBe('file');
    // Unknown but rest-shaped → rest generic.
    expect(copySourceFor('VendorGraphqlApi').family).toBe('rest');
    // Unknown but nosql-shaped → nosql generic.
    expect(copySourceFor('VendorMongoStore').family).toBe('nosql');
    // Truly unknown → tabular default.
    expect(copySourceFor('Whatever').family).toBe('tabular');
    expect(copySourceFor(undefined).typeName).toBeTruthy();
  });

  it('infers a family for every catalog connector category', () => {
    expect(familyForConnector('AzureBlobFS')).toBe('file');
    expect(familyForConnector('AzureSqlDatabase')).toBe('tabular');
    expect(familyForConnector('CosmosDb')).toBe('nosql');
    expect(familyForConnector('RestService')).toBe('rest');
    expect(familyForConnector('Oracle')).toBe('tabular');
  });

  it('every catalog connector resolves to a usable source (and a sink iff supportsSink)', () => {
    const coverage = copyCoverageForAllConnectors();
    expect(coverage.length).toBe(CONNECTORS.length);
    for (const row of coverage) {
      // Source is always present and non-empty.
      expect(row.source, `source for ${row.type}`).toBeTruthy();
      const def = CONNECTORS.find((c) => c.type === row.type)!;
      if (def.supportsSink) {
        expect(row.sink, `sink for ${row.type}`).toBeTruthy();
        expect(connectorSupportsSink(row.type)).toBe(true);
      } else {
        expect(row.sink).toBeNull();
      }
    }
  });

  it('source-only stores are absent from the dedicated sink map', () => {
    // AmazonS3 / AmazonRedshift / Ftp / HttpServer / OData are source-only.
    expect(COPY_SINK_SETTINGS['AmazonS3']).toBeUndefined();
    expect(COPY_SINK_SETTINGS['AmazonRedshift']).toBeUndefined();
    expect(COPY_SOURCE_SETTINGS['AmazonS3']).toBeDefined();
  });

  it('exposes format read/write settings keyed by dataset format', () => {
    const dt = copyFormatSettingsFor('DelimitedText')!;
    expect(dt.readType).toBe('DelimitedTextReadSettings');
    expect(dt.writeType).toBe('DelimitedTextWriteSettings');
    expect(dt.readFields.map((f) => f.key)).toContain('skipLineCount');
    expect(dt.writeFields.map((f) => f.key)).toContain('fileExtension');
    expect(copyFormatSettingsFor('Parquet')!.writeType).toBe('ParquetWriteSettings');
    expect(copyFormatSettingsFor(undefined)).toBeUndefined();
    expect(copyFormatSettingsFor('NotAFormat')).toBeUndefined();
  });

  it('publishes a reusable activity-level Settings spec with the expected sections', () => {
    const titles = COPY_SETTINGS_SPEC.map((s) => s.title);
    expect(titles).toEqual(
      expect.arrayContaining(['Performance', 'Staging', 'Fault tolerance', 'Logging', 'Preserve', 'Data consistency']),
    );
    const allKeys = COPY_SETTINGS_SPEC.flatMap((s) => s.fields.map((f) => f.key));
    expect(allKeys).toContain('dataIntegrationUnits');
    expect(allKeys).toContain('parallelCopies');
    expect(allKeys).toContain('enableStaging');
    expect(allKeys).toContain('enableSkipIncompatibleRow');
    expect(allKeys).toContain('enableCopyActivityLog');
    expect(allKeys).toContain('preserve.ACL');
    expect(allKeys).toContain('maxConcurrentConnections');

    // DIU includes Auto ('') and the documented power-of-two ladder up to 256.
    expect(DIU_VALUES[0]).toBe('');
    expect(DIU_VALUES).toContain('256');
    // Staging accepts only Blob / ADLS.
    expect(STAGING_LINKED_SERVICE_TYPES.has('AzureBlobFS')).toBe(true);
    expect(STAGING_LINKED_SERVICE_TYPES.has('AzureSqlDatabase')).toBe(false);
  });

  it('keeps the four family generics non-empty and self-consistent', () => {
    for (const fam of ['file', 'tabular', 'nosql', 'rest'] as const) {
      const g = COPY_GENERIC_BY_FAMILY[fam];
      expect(g.source, `${fam} generic source`).toBeDefined();
      expect(g.source!.family).toBe(fam);
    }
  });
});
