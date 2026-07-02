/**
 * pbids — pure PBIDS generator unit tests. Locks the grounded protocol strings
 * (tds / analysis-services / azure-data-explorer), the address shapes, the
 * DirectQuery/Import default, the AAS `asazure://` normalization, and the honest
 * throw when no endpoint is resolved. No network — runs in plain node.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPbids,
  serializePbids,
  protocolForKind,
  normalizeMode,
  normalizeAnalysisServicesServer,
  PbidsError,
} from '../pbids';

describe('protocolForKind', () => {
  it('maps SQL-family item kinds to tds', () => {
    for (const k of ['lakehouse', 'warehouse', 'sql-database', 'mirrored-database'] as const) {
      expect(protocolForKind(k)).toBe('tds');
    }
  });
  it('maps semantic-model to analysis-services', () => {
    expect(protocolForKind('semantic-model')).toBe('analysis-services');
  });
  it('maps kql-database / eventhouse to azure-data-explorer', () => {
    expect(protocolForKind('kql-database')).toBe('azure-data-explorer');
    expect(protocolForKind('eventhouse')).toBe('azure-data-explorer');
  });
});

describe('normalizeMode', () => {
  it('coerces caller mode strings, defaulting to undefined', () => {
    expect(normalizeMode('import')).toBe('Import');
    expect(normalizeMode('directQuery')).toBe('DirectQuery');
    expect(normalizeMode('direct-query')).toBe('DirectQuery');
    expect(normalizeMode('')).toBeUndefined();
    expect(normalizeMode(null)).toBeUndefined();
    expect(normalizeMode('garbage')).toBeUndefined();
  });
});

describe('normalizeAnalysisServicesServer', () => {
  it('prefixes a bare AAS address with asazure://', () => {
    expect(normalizeAnalysisServicesServer('westus2.asazure.windows.net/myserver'))
      .toBe('asazure://westus2.asazure.windows.net/myserver');
  });
  it('passes through an already-schemed asazure:// / powerbi:// URI', () => {
    expect(normalizeAnalysisServicesServer('asazure://westus2.asazure.windows.net/srv'))
      .toBe('asazure://westus2.asazure.windows.net/srv');
    expect(normalizeAnalysisServicesServer('powerbi://api.powerbi.com/v1.0/myorg/ws'))
      .toBe('powerbi://api.powerbi.com/v1.0/myorg/ws');
  });
  it('rewrites the XMLA-over-HTTP form to the asazure form', () => {
    expect(normalizeAnalysisServicesServer('https://westus2.asazure.windows.net/servers/myserver'))
      .toBe('asazure://westus2.asazure.windows.net/myserver');
  });
});

describe('buildPbids — tds (lakehouse / warehouse / sql)', () => {
  it('emits the grounded tds shape with DirectQuery default + options:{}', () => {
    const file = buildPbids({ kind: 'warehouse', server: 'ws.sql.azuresynapse.net', database: 'DW' });
    expect(file).toEqual({
      version: '0.1',
      connections: [
        {
          details: { protocol: 'tds', address: { server: 'ws.sql.azuresynapse.net', database: 'DW' } },
          options: {},
          mode: 'DirectQuery',
        },
      ],
    });
  });
  it('honors an explicit Import mode and omits an empty database', () => {
    const file = buildPbids({ kind: 'lakehouse', server: 'ws-ondemand.sql.azuresynapse.net', mode: 'Import' });
    const conn = file.connections[0];
    expect(conn.mode).toBe('Import');
    expect(conn.details.address).toEqual({ server: 'ws-ondemand.sql.azuresynapse.net' });
    expect('database' in conn.details.address).toBe(false);
  });
  it('throws a PbidsError naming `server` when no SQL endpoint is resolved', () => {
    expect(() => buildPbids({ kind: 'warehouse' })).toThrowError(PbidsError);
    try {
      buildPbids({ kind: 'lakehouse', server: '   ' });
    } catch (e) {
      expect((e as PbidsError).missing).toBe('server');
    }
  });
});

describe('buildPbids — analysis-services (semantic-model)', () => {
  it('emits the analysis-services shape with a normalized server + model, no mode', () => {
    const file = buildPbids({
      kind: 'semantic-model',
      xmlaServer: 'westus2.asazure.windows.net/myserver',
      database: 'SalesModel',
    });
    expect(file.connections[0].details).toEqual({
      protocol: 'analysis-services',
      address: { server: 'asazure://westus2.asazure.windows.net/myserver', database: 'SalesModel' },
    });
    // AS connect is a Live-style connection — mode is intentionally absent.
    expect(file.connections[0].mode).toBeUndefined();
  });
  it('throws naming `xmlaServer` when no XMLA endpoint is resolved', () => {
    try {
      buildPbids({ kind: 'semantic-model' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PbidsError);
      expect((e as PbidsError).missing).toBe('xmlaServer');
    }
  });
});

describe('buildPbids — azure-data-explorer (kql-database / eventhouse)', () => {
  it('emits the azure-data-explorer shape with cluster + database', () => {
    const file = buildPbids({
      kind: 'kql-database',
      cluster: 'https://adx-csa-loom-shared.eastus2.kusto.windows.net',
      database: 'loomdb-default',
    });
    expect(file.connections[0].details).toEqual({
      protocol: 'azure-data-explorer',
      address: { cluster: 'https://adx-csa-loom-shared.eastus2.kusto.windows.net', database: 'loomdb-default' },
    });
    expect(file.connections[0].mode).toBe('DirectQuery');
  });
  it('throws naming `cluster` when no ADX cluster is resolved', () => {
    try {
      buildPbids({ kind: 'eventhouse', database: 'db' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PbidsError).missing).toBe('cluster');
    }
  });
});

describe('serializePbids', () => {
  it('produces valid JSON round-trippable to the same object', () => {
    const file = buildPbids({ kind: 'warehouse', server: 'ws.sql.azuresynapse.net', database: 'DW' });
    const text = serializePbids(file);
    expect(JSON.parse(text)).toEqual(file);
    expect(text).toContain('"version": "0.1"');
  });
});
