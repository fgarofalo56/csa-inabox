/**
 * Unit tests for the pure UC table-format DDL builder (DBX-11). No network.
 */
import { describe, it, expect } from 'vitest';
import {
  TableFormatBuildError,
  UC_TABLE_FORMATS,
  buildCreateTableFormatDdl,
  tableFormatProperties,
  requiresDdlPath,
  type UcTableFormatColumn,
} from '@/lib/sql/uc-table-format-builders';

const COLS: UcTableFormatColumn[] = [
  { name: 'id', type: 'BIGINT', nullable: false },
  { name: 'amount', type: 'DECIMAL(10,2)', comment: 'order total' },
];

describe('requiresDdlPath', () => {
  it('plain Delta with no toggles → REST path', () => {
    expect(requiresDdlPath({ format: 'DELTA' })).toBe(false);
  });
  it('UniForm / Iceberg / any toggle → DDL path', () => {
    expect(requiresDdlPath({ format: 'DELTA_UNIFORM' })).toBe(true);
    expect(requiresDdlPath({ format: 'ICEBERG' })).toBe(true);
    expect(requiresDdlPath({ format: 'DELTA', deletionVectors: true })).toBe(true);
    expect(requiresDdlPath({ format: 'DELTA', rowLineage: true })).toBe(true);
  });
});

describe('tableFormatProperties', () => {
  it('DELTA with no toggles → no properties', () => {
    expect(tableFormatProperties({ format: 'DELTA' })).toEqual({});
  });
  it('UniForm sets the universalFormat + column mapping + iceberg-compat props', () => {
    const p = tableFormatProperties({ format: 'DELTA_UNIFORM' });
    expect(p['delta.universalFormat.enabledFormats']).toBe('iceberg');
    expect(p['delta.columnMapping.mode']).toBe('name');
    expect(p['delta.enableIcebergCompatV2']).toBe('true');
  });
  it('toggles add deletion-vector + row-tracking props', () => {
    const p = tableFormatProperties({ format: 'DELTA', deletionVectors: true, rowLineage: true });
    expect(p['delta.enableDeletionVectors']).toBe('true');
    expect(p['delta.enableRowTracking']).toBe('true');
  });
});

describe('buildCreateTableFormatDdl', () => {
  it('DELTA_UNIFORM → USING DELTA + TBLPROPERTIES', () => {
    const sql = buildCreateTableFormatDdl({ catalog: 'main', schema: 'sales', name: 'orders', columns: COLS, format: 'DELTA_UNIFORM' });
    expect(sql).toContain('CREATE TABLE `main`.`sales`.`orders` (');
    expect(sql).toContain('`id` BIGINT NOT NULL');
    expect(sql).toContain("`amount` DECIMAL(10,2) COMMENT 'order total'");
    expect(sql).toContain('USING DELTA');
    expect(sql).toContain("'delta.universalFormat.enabledFormats' = 'iceberg'");
    expect(sql.trim().endsWith(';')).toBe(true);
  });

  it('ICEBERG → USING ICEBERG', () => {
    const sql = buildCreateTableFormatDdl({ catalog: 'main', schema: 'sales', name: 'orders', columns: COLS, format: 'ICEBERG' });
    expect(sql).toContain('USING ICEBERG');
    expect(sql).not.toContain('universalFormat');
  });

  it('deletion vectors + row lineage on Delta', () => {
    const sql = buildCreateTableFormatDdl({ catalog: 'c', schema: 's', name: 't', columns: COLS, format: 'DELTA', deletionVectors: true, rowLineage: true });
    expect(sql).toContain("'delta.enableDeletionVectors' = 'true'");
    expect(sql).toContain("'delta.enableRowTracking' = 'true'");
  });

  it('IF NOT EXISTS + comment', () => {
    const sql = buildCreateTableFormatDdl({ catalog: 'c', schema: 's', name: 't', columns: COLS, format: 'DELTA_UNIFORM', ifNotExists: true, comment: 'my table' });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
    expect(sql).toContain("COMMENT 'my table'");
  });

  it('rejects Iceberg + deletion vectors (Delta-only feature)', () => {
    expect(() => buildCreateTableFormatDdl({ catalog: 'c', schema: 's', name: 't', columns: COLS, format: 'ICEBERG', deletionVectors: true })).toThrow(TableFormatBuildError);
  });

  it('rejects a bad column type', () => {
    expect(() => buildCreateTableFormatDdl({ catalog: 'c', schema: 's', name: 't', columns: [{ name: 'x', type: 'STRING; DROP TABLE y' }], format: 'ICEBERG' })).toThrow(TableFormatBuildError);
  });

  it('rejects a bad identifier', () => {
    expect(() => buildCreateTableFormatDdl({ catalog: 'c', schema: 's', name: 'bad name', columns: COLS, format: 'DELTA_UNIFORM' })).toThrow(TableFormatBuildError);
  });

  it('rejects an empty column list', () => {
    expect(() => buildCreateTableFormatDdl({ catalog: 'c', schema: 's', name: 't', columns: [], format: 'ICEBERG' })).toThrow(/at least one column/);
  });

  it('exposes the three formats', () => {
    expect(UC_TABLE_FORMATS).toEqual(['DELTA', 'DELTA_UNIFORM', 'ICEBERG']);
  });
});
