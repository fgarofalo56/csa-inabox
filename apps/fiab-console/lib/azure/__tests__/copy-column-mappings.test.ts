/**
 * L3 — copy-column-mappings parser unit tests (loom-next-level WS-L).
 * Golden ADF/Synapse Copy-activity JSON → expected canonical column mappings.
 */
import { describe, it, expect } from 'vitest';
import { readCopyColumnMappings } from '../copy-column-mappings';

describe('readCopyColumnMappings', () => {
  it('parses an explicit TabularTranslator mappings[] as declared, with a cast transform', () => {
    const def = {
      name: 'pl_sql_to_lake',
      properties: {
        activities: [
          {
            name: 'CopyCustomers',
            type: 'Copy',
            inputs: [{ referenceName: 'ds_sql_customers', type: 'DatasetReference' }],
            outputs: [{ referenceName: 'ds_lake_customers', type: 'DatasetReference' }],
            typeProperties: {
              translator: {
                type: 'TabularTranslator',
                mappings: [
                  { source: { name: 'Id', type: 'Int32' }, sink: { name: 'CustomerId', type: 'Int64' } },
                  { source: { name: 'Name', type: 'String' }, sink: { name: 'FullName', type: 'String' } },
                ],
              },
            },
          },
        ],
      },
    };
    const [lin] = readCopyColumnMappings(def);
    expect(lin.activityName).toBe('CopyCustomers');
    expect(lin.sourceDataset).toBe('ds_sql_customers');
    expect(lin.sinkDataset).toBe('ds_lake_customers');
    expect(lin.mappingKind).toBe('declared');
    expect(lin.columnMappings).toEqual([
      { fromColumn: 'Id', toColumn: 'CustomerId', confidence: 'declared', transform: 'CAST(Int32→Int64)' },
      { fromColumn: 'Name', toColumn: 'FullName', confidence: 'declared' },
    ]);
  });

  it('parses the legacy columnMappings string as declared', () => {
    const def = {
      properties: {
        activities: [
          {
            name: 'CopyLegacy',
            type: 'Copy',
            inputs: [{ referenceName: 'ds_src' }],
            outputs: [{ referenceName: 'ds_sink' }],
            typeProperties: {
              translator: {
                type: 'TabularTranslator',
                columnMappings: 'UserId: MyUserId, Group: MyGroup, Name: MyName',
              },
            },
          },
        ],
      },
    };
    const [lin] = readCopyColumnMappings(def);
    expect(lin.mappingKind).toBe('declared');
    expect(lin.columnMappings).toEqual([
      { fromColumn: 'UserId', toColumn: 'MyUserId', confidence: 'declared' },
      { fromColumn: 'Group', toColumn: 'MyGroup', confidence: 'declared' },
      { fromColumn: 'Name', toColumn: 'MyName', confidence: 'declared' },
    ]);
  });

  it('parses the legacy schemaMapping object as declared', () => {
    const def = {
      properties: {
        activities: [
          {
            name: 'CopySchemaMap',
            type: 'Copy',
            inputs: [{ referenceName: 'ds_a' }],
            outputs: [{ referenceName: 'ds_b' }],
            typeProperties: { translator: { type: 'TabularTranslator', schemaMapping: { colA: 'ColumnA', colB: 'ColumnB' } } },
          },
        ],
      },
    };
    const [lin] = readCopyColumnMappings(def);
    expect(lin.mappingKind).toBe('declared');
    expect(lin.columnMappings).toEqual([
      { fromColumn: 'colA', toColumn: 'ColumnA', confidence: 'declared' },
      { fromColumn: 'colB', toColumn: 'ColumnB', confidence: 'declared' },
    ]);
  });

  it('auto-maps by name (derived) for a no-translator Copy when dataset structures are supplied', () => {
    const def = {
      properties: {
        activities: [
          {
            name: 'CopyAuto',
            type: 'Copy',
            inputs: [{ referenceName: 'ds_src' }],
            outputs: [{ referenceName: 'ds_dst' }],
            typeProperties: { source: {}, sink: {} }, // NO translator → default by-name mapping
          },
        ],
      },
    };
    const structures = { ds_src: ['id', 'amount', 'extra_src'], ds_dst: ['ID', 'Amount', 'only_dst'] };
    const [lin] = readCopyColumnMappings(def, structures);
    expect(lin.mappingKind).toBe('derived');
    // case-insensitive name match; unmatched source/sink columns dropped.
    expect(lin.columnMappings).toEqual([
      { fromColumn: 'id', toColumn: 'ID', confidence: 'derived' },
      { fromColumn: 'amount', toColumn: 'Amount', confidence: 'derived' },
    ]);
  });

  it('yields a table-grain-only result (none) for a no-translator Copy with no structures', () => {
    const def = {
      properties: {
        activities: [
          {
            name: 'CopyBare',
            type: 'Copy',
            inputs: [{ referenceName: 'ds_src' }],
            outputs: [{ referenceName: 'ds_dst' }],
            typeProperties: { source: {}, sink: {} },
          },
        ],
      },
    };
    const [lin] = readCopyColumnMappings(def);
    expect(lin.mappingKind).toBe('none');
    expect(lin.columnMappings).toEqual([]);
    // The item→item (dataset→dataset) edge is still resolvable.
    expect(lin.sourceDataset).toBe('ds_src');
    expect(lin.sinkDataset).toBe('ds_dst');
  });

  it('treats a parameterized (expression) translator as table-grain only', () => {
    const def = {
      properties: {
        activities: [
          {
            name: 'CopyParam',
            type: 'Copy',
            inputs: [{ referenceName: 'ds_src' }],
            outputs: [{ referenceName: 'ds_dst' }],
            typeProperties: { translator: { value: "@pipeline().parameters.mapping", type: 'Expression' } },
          },
        ],
      },
    };
    const [lin] = readCopyColumnMappings(def);
    expect(lin.mappingKind).toBe('none');
    expect(lin.columnMappings).toEqual([]);
  });

  it('ignores non-Copy activities and supports the Synapse activities[] shape', () => {
    const def = {
      activities: [
        { name: 'RunNotebook', type: 'SynapseNotebook', typeProperties: {} },
        {
          name: 'CopyTop',
          type: 'Copy',
          inputs: [{ referenceName: 'ds_x' }],
          outputs: [{ referenceName: 'ds_y' }],
          typeProperties: { translator: { type: 'TabularTranslator', mappings: [{ source: { name: 'a' }, sink: { name: 'b' } }] } },
        },
      ],
    };
    const res = readCopyColumnMappings(def);
    expect(res).toHaveLength(1);
    expect(res[0].activityName).toBe('CopyTop');
    expect(res[0].columnMappings).toEqual([{ fromColumn: 'a', toColumn: 'b', confidence: 'declared' }]);
  });

  it('skips ordinal-only pairs that cannot be resolved to a source name, returns none', () => {
    const def = {
      properties: {
        activities: [
          {
            name: 'CopyOrdinal',
            type: 'Copy',
            inputs: [{ referenceName: 'ds_src' }],
            outputs: [{ referenceName: 'ds_dst' }],
            typeProperties: {
              translator: {
                type: 'TabularTranslator',
                mappings: [{ source: { ordinal: 1 }, sink: { name: 'ColA' } }],
              },
            },
          },
        ],
      },
    };
    // ordinal source (#1) IS a usable id → declared with the ordinal token.
    const [lin] = readCopyColumnMappings(def);
    expect(lin.mappingKind).toBe('declared');
    expect(lin.columnMappings).toEqual([{ fromColumn: '#1', toColumn: 'ColA', confidence: 'declared' }]);
  });

  it('returns [] for an empty / malformed pipeline def', () => {
    expect(readCopyColumnMappings(undefined)).toEqual([]);
    expect(readCopyColumnMappings({})).toEqual([]);
    expect(readCopyColumnMappings({ properties: {} })).toEqual([]);
  });
});
