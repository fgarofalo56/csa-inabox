/**
 * Contract tests for the AI Search indexer field-mappings builder + execution-
 * history reader (lib/azure/search-indexer-shapes.ts, AIF-10). These lock the
 * exact wire shape the Field-mappings builder round-trips to PUT /indexers and
 * the normalization of GET /indexers/{n}/status, per no-vaporware.md (real REST
 * contract, no mocks).
 *
 * Grounded in Microsoft Learn:
 *   - Field mappings + mapping functions: https://learn.microsoft.com/azure/search/search-indexer-field-mappings
 *   - Get Indexer Status (executionHistory[]): https://learn.microsoft.com/rest/api/searchservice/get-indexer-status
 */
import { describe, it, expect } from 'vitest';
import {
  buildFieldMapping, buildFieldMappings, parseFieldMapping, parseIndexerMappings,
  parseExecutionHistory, runDuration, functionHasParameters, emptyFieldMappingRow,
  type FieldMappingRow,
} from '../search-indexer-shapes';

describe('field-mapping builder', () => {
  it('builds a direct mapping (no function)', () => {
    const row: FieldMappingRow = { sourceFieldName: 'src', targetFieldName: 'dst', functionName: '' };
    expect(buildFieldMapping(row)).toEqual({ sourceFieldName: 'src', targetFieldName: 'dst' });
  });

  it('drops incomplete rows (missing source or target)', () => {
    expect(buildFieldMapping({ sourceFieldName: '', targetFieldName: 'dst', functionName: '' })).toBeNull();
    expect(buildFieldMappings([
      { sourceFieldName: 'a', targetFieldName: 'b', functionName: '' },
      emptyFieldMappingRow(),
    ])).toHaveLength(1);
  });

  it('builds base64Encode with the UTF-8 flag only when set', () => {
    expect(buildFieldMapping({ sourceFieldName: 'a', targetFieldName: 'b', functionName: 'base64Encode' }))
      .toEqual({ sourceFieldName: 'a', targetFieldName: 'b', mappingFunction: { name: 'base64Encode' } });
    expect(buildFieldMapping({ sourceFieldName: 'a', targetFieldName: 'b', functionName: 'base64Encode', useHttpServerUtf8Encoding: true }))
      .toEqual({ sourceFieldName: 'a', targetFieldName: 'b', mappingFunction: { name: 'base64Encode', parameters: { useHttpServerUtf8Encoding: true } } });
  });

  it('builds extractTokenAtPosition with delimiter + position', () => {
    const wire = buildFieldMapping({ sourceFieldName: 'name', targetFieldName: 'first', functionName: 'extractTokenAtPosition', delimiter: ' ', position: 0 });
    expect(wire.mappingFunction).toEqual({ name: 'extractTokenAtPosition', parameters: { delimiter: ' ', position: 0 } });
  });

  it('round-trips a mapping through parse → build', () => {
    const wire = { sourceFieldName: 'a', targetFieldName: 'b', mappingFunction: { name: 'extractTokenAtPosition', parameters: { delimiter: ',', position: 2 } } };
    const row = parseFieldMapping(wire);
    expect(row).toMatchObject({ sourceFieldName: 'a', targetFieldName: 'b', functionName: 'extractTokenAtPosition', delimiter: ',', position: 2 });
    expect(buildFieldMapping(row)).toEqual(wire);
  });

  it('ignores an unknown mapping function on parse', () => {
    expect(parseFieldMapping({ sourceFieldName: 'a', targetFieldName: 'b', mappingFunction: { name: 'notReal' } }).functionName).toBe('');
  });

  it('parses an indexer definition into field + output mappings', () => {
    const idr = {
      fieldMappings: [{ sourceFieldName: 'metadata_title', targetFieldName: 'title' }],
      outputFieldMappings: [{ sourceFieldName: '/document/keyphrases', targetFieldName: 'keyPhrases' }],
    };
    const parsed = parseIndexerMappings(idr);
    expect(parsed.fieldMappings).toHaveLength(1);
    expect(parsed.outputFieldMappings[0].targetFieldName).toBe('keyPhrases');
  });

  it('functionHasParameters is true only for parameterized functions', () => {
    expect(functionHasParameters('extractTokenAtPosition')).toBe(true);
    expect(functionHasParameters('base64Encode')).toBe(true);
    expect(functionHasParameters('urlEncode')).toBe(false);
    expect(functionHasParameters('')).toBe(false);
  });
});

describe('execution-history reader', () => {
  const status = {
    status: 'running',
    lastResult: { status: 'success', startTime: '2026-07-01T00:00:00Z', endTime: '2026-07-01T00:00:05Z', itemsProcessed: 100, itemsFailed: 0, errors: [], warnings: [] },
    executionHistory: [
      {
        status: 'transientFailure', startTime: '2026-07-01T00:00:00Z', endTime: '2026-07-01T00:01:30Z',
        itemsProcessed: 90, itemsFailed: 10,
        errors: [{ key: 'doc7', name: 'DocumentExtraction', errorMessage: 'bad blob', details: 'x' }],
        warnings: [{ key: 'doc3', message: 'truncated' }],
      },
      { status: 'success', startTime: '2026-06-30T00:00:00Z', endTime: '2026-06-30T00:00:02Z', itemsProcessed: 5, itemsFailed: 0 },
    ],
  };

  it('normalizes overall status + per-run counts', () => {
    const parsed = parseExecutionHistory(status);
    expect(parsed.overallStatus).toBe('running');
    expect(parsed.lastResult?.itemsProcessed).toBe(100);
    expect(parsed.executionHistory).toHaveLength(2);
    expect(parsed.executionHistory[0].itemsFailed).toBe(10);
    expect(parsed.executionHistory[0].errors[0].errorMessage).toBe('bad blob');
    expect(parsed.executionHistory[0].warnings[0].message).toBe('truncated');
  });

  it('defaults missing arrays and counts', () => {
    const parsed = parseExecutionHistory({ executionHistory: [{ status: 'success' }] });
    expect(parsed.executionHistory[0].itemsProcessed).toBe(0);
    expect(parsed.executionHistory[0].errors).toEqual([]);
  });

  it('handles an empty status', () => {
    expect(parseExecutionHistory({}).executionHistory).toEqual([]);
    expect(parseExecutionHistory(null).executionHistory).toEqual([]);
  });

  it('formats run duration', () => {
    expect(runDuration({ startTime: '2026-07-01T00:00:00Z', endTime: '2026-07-01T00:00:05Z' })).toBe('5s');
    expect(runDuration({ startTime: '2026-07-01T00:00:00Z', endTime: '2026-07-01T00:01:30Z' })).toBe('1m 30s');
    expect(runDuration({ startTime: undefined })).toBe('—');
  });
});
