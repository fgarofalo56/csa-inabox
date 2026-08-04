import { describe, it, expect } from 'vitest';
import { iconIdForItemType, DEFAULT_ITEM_ICON } from '../src/tree/icons';

describe('iconIdForItemType', () => {
  it('maps well-known types to specific codicons', () => {
    expect(iconIdForItemType('notebook')).toBe('notebook');
    expect(iconIdForItemType('lakehouse')).toBe('database');
    expect(iconIdForItemType('warehouse')).toBe('server');
    expect(iconIdForItemType('report')).toBe('graph');
    expect(iconIdForItemType('dashboard')).toBe('dashboard');
    expect(iconIdForItemType('data-pipeline')).toBe('run-all');
    expect(iconIdForItemType('kql-database')).toBe('database');
    expect(iconIdForItemType('spark-job-definition')).toBe('flame');
    expect(iconIdForItemType('user-data-function')).toBe('symbol-method');
  });

  it('is case-insensitive', () => {
    expect(iconIdForItemType('Notebook')).toBe('notebook');
    expect(iconIdForItemType('LAKEHOUSE')).toBe('database');
  });

  it('falls back to heuristics for unlisted but suggestive types', () => {
    expect(iconIdForItemType('custom-notebook-thing')).toBe('notebook');
    expect(iconIdForItemType('some-pipeline')).toBe('run-all');
    expect(iconIdForItemType('my-sql-thing')).toBe('database');
  });

  it('returns the default for empty / unknown types', () => {
    expect(iconIdForItemType('')).toBe(DEFAULT_ITEM_ICON);
    expect(iconIdForItemType('zzz-unmatched-xyz')).toBe(DEFAULT_ITEM_ICON);
  });

  it('is total — always returns a non-empty codicon id', () => {
    const sample = [
      'activator', 'adf-dataset', 'ai-foundry-project', 'copy-job', 'eventhouse',
      'geo-map', 'graphql-api', 'health-check', 'ml-model', 'ontology',
      'power-app', 'semantic-model', 'stream-analytics-job', 'variable-library',
      'this-is-not-a-real-type',
    ];
    for (const t of sample) {
      const id = iconIdForItemType(t);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
