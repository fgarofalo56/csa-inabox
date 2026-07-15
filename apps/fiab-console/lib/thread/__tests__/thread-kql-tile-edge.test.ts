/**
 * Registry test for the Query → Dashboard conversion Weave edge (operator
 * review 5.2): `create-dashboard-tile-from-query` (kql-database →
 * kql-dashboard). Pure — asserts the edge is registered on the KQL database,
 * targets the real BFF route, and its config fields are structured (pickers /
 * dropdowns; the only textarea is the KQL query itself — the ADX-native
 * escape hatch, same policy as the SQL-query fields on sibling edges).
 */
import { describe, it, expect } from 'vitest';
import { THREAD_ACTIONS, actionsFor } from '@/lib/thread/thread-actions';

function action(id: string) {
  const a = THREAD_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`ThreadAction '${id}' not registered`);
  return a;
}

describe('create-dashboard-tile-from-query Weave edge', () => {
  it('is registered on kql-database and targets the conversion route', () => {
    const a = action('create-dashboard-tile-from-query');
    expect(a.fromTypes).toEqual(['kql-database']);
    expect(a.group).toBe('Visualize');
    expect(a.route).toBe('/api/thread/kql-query-to-dashboard-tile');
    expect(actionsFor('kql-database').some((x) => x.id === 'create-dashboard-tile-from-query')).toBe(true);
  });

  it('offers a new-or-existing dashboard picker (allowCreate loom-item)', () => {
    const f = action('create-dashboard-tile-from-query').fields.find((x) => x.name === 'dashboardId');
    expect(f?.kind).toBe('loom-item');
    expect(f?.itemTypes).toEqual(['kql-dashboard']);
    expect(f?.allowCreate).toBe(true);
    expect(f?.required).toBe(true);
    const nameField = action('create-dashboard-tile-from-query').fields.find((x) => x.name === 'newDashboardName');
    expect(nameField?.showWhen).toEqual({ field: 'dashboardId', equals: '__new__' });
  });

  it('visual + size are structured selects matching the tile model', () => {
    const a = action('create-dashboard-tile-from-query');
    const viz = a.fields.find((x) => x.name === 'viz');
    expect(viz?.kind).toBe('select');
    expect(viz?.options?.map((o) => o.value)).toEqual(['table', 'timechart', 'column', 'bar', 'pie', 'stat']);
    const size = a.fields.find((x) => x.name === 'size');
    expect(size?.kind).toBe('select');
    expect(size?.options?.map((o) => o.value)).toEqual(['small', 'medium', 'wide', 'tall']);
  });

  it('the only freeform fields are the KQL query (escape hatch) + names/title', () => {
    for (const f of action('create-dashboard-tile-from-query').fields) {
      if (f.name === 'kql') {
        expect(f.kind).toBe('textarea');
      } else {
        expect(['select', 'loom-item', 'text'], f.name).toContain(f.kind);
      }
    }
  });
});
