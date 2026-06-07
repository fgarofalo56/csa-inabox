import { describe, it, expect } from 'vitest';
import { deltaTypeLabel, parseDeltaSchema, formatSchemaLine } from '../delta-schema-parse';

describe('deltaTypeLabel', () => {
  it('passes primitive type strings through', () => {
    expect(deltaTypeLabel('string')).toBe('string');
    expect(deltaTypeLabel('timestamp')).toBe('timestamp');
    expect(deltaTypeLabel('double')).toBe('double');
  });

  it('renders array element type', () => {
    expect(deltaTypeLabel({ type: 'array', elementType: 'long', containsNull: true })).toBe('array<long>');
  });

  it('renders map key/value types', () => {
    expect(deltaTypeLabel({ type: 'map', keyType: 'string', valueType: 'integer' })).toBe('map<string,integer>');
  });

  it('labels nested struct and unknowns', () => {
    expect(deltaTypeLabel({ type: 'struct', fields: [] })).toBe('struct');
    expect(deltaTypeLabel(null)).toBe('unknown');
    expect(deltaTypeLabel(42)).toBe('unknown');
  });
});

describe('parseDeltaSchema', () => {
  it('extracts ordered name:type fields from a _delta_log/0.json payload', () => {
    const schemaString = JSON.stringify({
      type: 'struct',
      fields: [
        { name: 'device_id', type: 'string', nullable: false, metadata: {} },
        { name: 'ts', type: 'timestamp', nullable: true, metadata: {} },
        { name: 'value', type: 'double', nullable: true, metadata: {} },
      ],
    });
    // Real Delta log: newline-delimited actions; metaData is one of several lines.
    const log = [
      JSON.stringify({ commitInfo: { operation: 'WRITE' } }),
      JSON.stringify({ protocol: { minReaderVersion: 1, minWriterVersion: 2 } }),
      JSON.stringify({ metaData: { id: 'abc', format: { provider: 'parquet' }, schemaString, partitionColumns: [] } }),
      JSON.stringify({ add: { path: 'part-0001.parquet', size: 123 } }),
    ].join('\n');

    const fields = parseDeltaSchema(log);
    expect(fields).toEqual([
      { name: 'device_id', type: 'string' },
      { name: 'ts', type: 'timestamp' },
      { name: 'value', type: 'double' },
    ]);
  });

  it('returns [] for a log with no metaData', () => {
    const log = JSON.stringify({ add: { path: 'x.parquet' } });
    expect(parseDeltaSchema(log)).toEqual([]);
  });

  it('survives malformed lines without throwing', () => {
    const log = 'not json\n' + JSON.stringify({ metaData: { schemaString: '{bad json' } });
    expect(parseDeltaSchema(log)).toEqual([]);
  });
});

describe('formatSchemaLine', () => {
  it('formats a compact schema line', () => {
    const line = formatSchemaLine(
      { schema: 'bronze', name: 'sensor_readings' },
      [{ name: 'device_id', type: 'string' }, { name: 'value', type: 'double' }],
    );
    expect(line).toBe('bronze.sensor_readings: [device_id:string, value:double]');
  });

  it('marks empty schema honestly', () => {
    expect(formatSchemaLine({ schema: 'gold', name: 'agg' }, [])).toBe('gold.agg: (schema unavailable)');
  });
});
