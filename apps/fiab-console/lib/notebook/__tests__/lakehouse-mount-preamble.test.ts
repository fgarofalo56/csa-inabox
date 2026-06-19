/**
 * Tests for the notebook auto-mount preamble builder (issue #655). Pure
 * function, no network — verifies the `loom_lakehouses` dict is emitted with
 * real abfss paths, that names/paths are safely escaped, and that an empty
 * input emits nothing (so no empty cell is injected).
 */
import { describe, it, expect } from 'vitest';
import { buildLakehouseMountPreamble } from '../lakehouse-mount-preamble';

describe('buildLakehouseMountPreamble', () => {
  it('returns empty string when there are no sources', () => {
    expect(buildLakehouseMountPreamble([])).toBe('');
    expect(buildLakehouseMountPreamble([{ displayName: 'x', abfss: '' }])).toBe('');
    expect(buildLakehouseMountPreamble([{ displayName: '', abfss: 'abfss://a@b.dfs.core.windows.net/c' }])).toBe('');
  });

  it('emits a loom_lakehouses dict keyed by display name', () => {
    const out = buildLakehouseMountPreamble([
      { displayName: 'sales', abfss: 'abfss://gold@acct.dfs.core.windows.net/lakehouses/sales' },
      { displayName: 'inventory', abfss: 'abfss://silver@acct.dfs.core.windows.net/lakehouses/inventory' },
    ]);
    expect(out).toContain('loom_lakehouses = {');
    expect(out).toContain("'sales': 'abfss://gold@acct.dfs.core.windows.net/lakehouses/sales',");
    expect(out).toContain("'inventory': 'abfss://silver@acct.dfs.core.windows.net/lakehouses/inventory',");
    expect(out).toContain("spark.conf.set('loom.lakehouses.mounted'");
  });

  it('escapes single quotes and backslashes in names and paths', () => {
    const out = buildLakehouseMountPreamble([
      { displayName: "o'brien", abfss: "abfss://c@a.dfs.core.windows.net/has'quote" },
    ]);
    expect(out).toContain("'o\\'brien'");
    expect(out).toContain("has\\'quote");
  });

  it('drops only the falsy entries, keeps the valid ones', () => {
    const out = buildLakehouseMountPreamble([
      { displayName: 'ok', abfss: 'abfss://c@a.dfs.core.windows.net/r' },
      { displayName: 'bad', abfss: '' },
    ]);
    expect(out).toContain("'ok':");
    expect(out).not.toContain("'bad':");
  });
});
