/**
 * Vitest — upsertTableDescriptions (bulk AI auto-description persistence).
 *
 * Pure-function coverage for the merge logic that the bulk describe-bulk route
 * relies on: replace-by-table, per-column merge, blank-skip, and preservation
 * of an existing description when an incoming one is blank.
 */
import { describe, it, expect } from 'vitest';
import {
  upsertTableDescriptions,
  type SmModelState,
  type SmTableDescription,
} from '../semantic-model-store';

function emptyState(tableDescriptions: SmTableDescription[] = []): SmModelState {
  return { relationships: [], hierarchies: [], tableDescriptions };
}

describe('upsertTableDescriptions', () => {
  it('adds a new table description with columns', () => {
    const next = upsertTableDescriptions(emptyState(), [
      { table: 'Sales', description: 'Sales fact table', columns: [{ name: 'Amount', description: 'Order amount' }], updatedAt: 'x' },
    ]);
    expect(next.tableDescriptions).toHaveLength(1);
    expect(next.tableDescriptions[0].table).toBe('Sales');
    expect(next.tableDescriptions[0].description).toBe('Sales fact table');
    expect(next.tableDescriptions[0].columns).toEqual([{ name: 'Amount', description: 'Order amount' }]);
  });

  it('replaces the table description but merges columns by name', () => {
    const start = emptyState([
      { table: 'Sales', description: 'old', columns: [{ name: 'Amount', description: 'a' }], updatedAt: 'x' },
    ]);
    const next = upsertTableDescriptions(start, [
      { table: 'Sales', description: 'new', columns: [{ name: 'Qty', description: 'quantity' }], updatedAt: 'y' },
    ]);
    expect(next.tableDescriptions).toHaveLength(1);
    expect(next.tableDescriptions[0].description).toBe('new');
    const cols = next.tableDescriptions[0].columns!.map((c) => c.name).sort();
    expect(cols).toEqual(['Amount', 'Qty']);
  });

  it('keeps the existing description when the incoming one is blank', () => {
    const start = emptyState([{ table: 'Dim', description: 'keep me', columns: [], updatedAt: 'x' }]);
    const next = upsertTableDescriptions(start, [{ table: 'Dim', description: '   ', columns: [], updatedAt: 'y' }]);
    expect(next.tableDescriptions[0].description).toBe('keep me');
  });

  it('skips blank table names and blank column descriptions', () => {
    const next = upsertTableDescriptions(emptyState(), [
      { table: '  ', description: 'ignored', columns: [], updatedAt: 'x' },
      { table: 'T', description: 'd', columns: [{ name: 'C1', description: '' }, { name: 'C2', description: 'ok' }], updatedAt: 'x' },
    ]);
    expect(next.tableDescriptions).toHaveLength(1);
    expect(next.tableDescriptions[0].table).toBe('T');
    expect(next.tableDescriptions[0].columns).toEqual([{ name: 'C2', description: 'ok' }]);
  });

  it('does not mutate the input state', () => {
    const start = emptyState([{ table: 'A', description: 'a', columns: [], updatedAt: 'x' }]);
    const snapshot = JSON.stringify(start);
    upsertTableDescriptions(start, [{ table: 'B', description: 'b', columns: [], updatedAt: 'y' }]);
    expect(JSON.stringify(start)).toBe(snapshot);
  });
});
