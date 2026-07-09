/**
 * DeltaFlow analytics-ready CDC transform tests (FGC-15). Pure SAQL + spec
 * logic — asserts the normalized change-type/timestamp projection, the
 * auto-managed destination spec, op→change-type mapping, validation, and that
 * the shared compiler routes analytics-ready cdc-flatten through it.
 */
import { describe, it, expect } from 'vitest';
import {
  isAnalyticsReady,
  deltaflowSelectList,
  deltaflowDestinationSpec,
  changeTypeCaseExpr,
  mapChangeType,
  validateDeltaFlow,
  CHANGE_TYPE_COLUMN_DEFAULT,
  CHANGE_TS_COLUMN_DEFAULT,
  type DeltaFlowConfig,
} from '../deltaflow-transform';
import { cdcFlattenSelectList, type TransformNode } from '../asa-query-compiler';

const READY: DeltaFlowConfig = {
  cdcSchemaMode: 'analytics-ready',
  cdcColumns: ['OrderID', 'CustomerName', 'OrderTotal'],
  cdcKeyColumns: ['OrderID'],
  cdcDestinationTable: 'orders_analytics',
};

describe('mode detection', () => {
  it('raw by default, analytics-ready when set', () => {
    expect(isAnalyticsReady({})).toBe(false);
    expect(isAnalyticsReady({ cdcSchemaMode: 'raw-flatten' })).toBe(false);
    expect(isAnalyticsReady({ cdcSchemaMode: 'analytics-ready' })).toBe(true);
  });
});

describe('op → change type', () => {
  it('maps Debezium codes to analytics change types', () => {
    expect(mapChangeType('c')).toBe('Insert');
    expect(mapChangeType('r')).toBe('Snapshot');
    expect(mapChangeType('u')).toBe('Update');
    expect(mapChangeType('d')).toBe('Delete');
  });
  it('CASE expr covers all four codes', () => {
    const e = changeTypeCaseExpr('op');
    expect(e).toContain("WHEN 'c' THEN 'Insert'");
    expect(e).toContain("WHEN 'r' THEN 'Snapshot'");
    expect(e).toContain("WHEN 'u' THEN 'Update'");
    expect(e).toContain("WHEN 'd' THEN 'Delete'");
  });
});

describe('deltaflowSelectList', () => {
  it('COALESCEs each data column and emits normalized change columns', () => {
    const sql = deltaflowSelectList(READY);
    expect(sql).toContain('COALESCE(after.OrderID, before.OrderID) AS OrderID');
    expect(sql).toContain(`AS ${CHANGE_TYPE_COLUMN_DEFAULT}`);
    expect(sql).toContain(`AS ${CHANGE_TS_COLUMN_DEFAULT}`);
    expect(sql).toContain('DATEADD(millisecond');
  });
  it('honors custom change-type/timestamp column names + source metadata', () => {
    const sql = deltaflowSelectList({ ...READY, cdcChangeTypeColumn: 'chg', cdcChangeTsColumn: 'chg_at', cdcSourceField: 'source' });
    expect(sql).toContain('AS chg');
    expect(sql).toContain('AS chg_at');
    expect(sql).toContain('source.schema AS __schema');
    expect(sql).toContain('source.table AS __table');
  });
});

describe('deltaflowDestinationSpec', () => {
  it('describes the auto-managed destination', () => {
    const spec = deltaflowDestinationSpec(READY);
    expect(spec.table).toBe('orders_analytics');
    expect(spec.keyColumns).toEqual(['OrderID']);
    expect(spec.schemaEvolution).toBe(true);
    expect(spec.dataColumns).toEqual(['OrderID', 'CustomerName', 'OrderTotal']);
  });
  it('defaults table + schema evolution, respects opt-out', () => {
    expect(deltaflowDestinationSpec({}).table).toBe('cdc_analytics');
    expect(deltaflowDestinationSpec({ cdcSchemaEvolution: false }).schemaEvolution).toBe(false);
  });
});

describe('validation', () => {
  it('passes raw mode without checks', () => {
    expect(validateDeltaFlow({ cdcSchemaMode: 'raw-flatten' })).toBeNull();
  });
  it('requires ≥1 data column in analytics-ready mode', () => {
    expect(validateDeltaFlow({ cdcSchemaMode: 'analytics-ready', cdcColumns: [] })).toMatch(/data column/i);
  });
  it('requires key columns to be among the data columns', () => {
    expect(validateDeltaFlow({ cdcSchemaMode: 'analytics-ready', cdcColumns: ['a'], cdcKeyColumns: ['b'] })).toMatch(/must also be/i);
  });
  it('passes a well-formed analytics-ready node', () => {
    expect(validateDeltaFlow(READY)).toBeNull();
  });
});

describe('shared compiler routing', () => {
  it('cdcFlattenSelectList routes analytics-ready through DeltaFlow', () => {
    const node: TransformNode = { kind: 'cdc-flatten', name: 'x', ...READY };
    const sql = cdcFlattenSelectList(node);
    expect(sql).toContain(`AS ${CHANGE_TYPE_COLUMN_DEFAULT}`);
    // NOT the raw-mode __op column
    expect(sql).not.toContain('__op');
  });
  it('cdcFlattenSelectList keeps raw-mode projection when not analytics-ready', () => {
    const node: TransformNode = { kind: 'cdc-flatten', name: 'x', cdcColumns: ['id'], cdcOpField: 'op', cdcTsField: 'ts_ms' };
    const sql = cdcFlattenSelectList(node);
    expect(sql).toContain('__op');
    expect(sql).toContain('__changed_at');
  });
});
