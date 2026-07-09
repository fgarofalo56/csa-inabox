/**
 * Mirrored Database Copilot builder config — pure logic tests (G1).
 *
 * add-table only for new tables, remove-table only for tables already in the
 * mirror set, and applyOps mutates state.tables deterministically.
 */
import { describe, it, expect } from 'vitest';
import { MIRRORED_DATABASE_BUILDER_CONFIG, type MirroredDbDoc } from '../copilot-personas-mirrored-database';

const cfg = MIRRORED_DATABASE_BUILDER_CONFIG as any;

function doc(): MirroredDbDoc {
  return { sourceType: 'AzureSqlDatabase', server: 'srv', database: 'db', tables: [{ schema: 'dbo', table: 'AuditLog' }] };
}

describe('mirrored-database builder — readDoc + grounding', () => {
  it('reads valid tables out of state and grounds on the real source', () => {
    const d = cfg.readDoc({ sourceType: 'AzureSqlDatabase', server: 'srv', database: 'db', tables: [{ schema: 'dbo', table: 'Orders' }, { bad: 1 }] });
    expect(d.tables).toEqual([{ schema: 'dbo', table: 'Orders' }]);
    expect(cfg.groundingText(d)).toContain('dbo.Orders');
  });
});

describe('mirrored-database builder — normalizeOps', () => {
  it('accepts add-table for a new table and drops duplicates', () => {
    expect(cfg.normalizeOps([{ kind: 'add-table', schema: 'dbo', table: 'Orders' }], doc())).toHaveLength(1);
    expect(cfg.normalizeOps([{ kind: 'add-table', schema: 'dbo', table: 'AuditLog' }], doc())).toHaveLength(0);
  });

  it('accepts remove-table only for an existing mirrored table', () => {
    expect(cfg.normalizeOps([{ kind: 'remove-table', schema: 'dbo', table: 'AuditLog' }], doc())).toHaveLength(1);
    expect(cfg.normalizeOps([{ kind: 'remove-table', schema: 'dbo', table: 'Ghost' }], doc())).toHaveLength(0);
  });

  it('dedupes repeated add ops in one plan', () => {
    const ops = cfg.normalizeOps([
      { kind: 'add-table', schema: 'dbo', table: 'Orders' },
      { kind: 'add-table', schema: 'dbo', table: 'Orders' },
    ], doc());
    expect(ops).toHaveLength(1);
  });
});

describe('mirrored-database builder — applyOps', () => {
  it('adds and removes tables', () => {
    const d = doc();
    const ops = cfg.normalizeOps([
      { kind: 'add-table', schema: 'dbo', table: 'Orders' },
      { kind: 'remove-table', schema: 'dbo', table: 'AuditLog' },
    ], d);
    const { patch, applied } = cfg.applyOps(d, ops);
    expect((patch.tables as any[]).map((t) => t.table)).toEqual(['Orders']);
    expect(applied).toHaveLength(2);
  });
});
