/**
 * Unit tests for the shared low-code app-definition schema (audit-T145).
 * Pure module — no Fluent / Azure SDK — so it runs in the node vitest env.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_APP_DEF, APP_DEF_VERSION,
  normalizeAppDef, normalizeBinding, migrateWorkshopState,
  appDefFromRayfinBinding, summarizeAppDef,
  type AppDefinition,
} from '../app-definition';

describe('normalizeBinding', () => {
  it('coerces an ontology-entity binding and clamps top', () => {
    const b = normalizeBinding({ source: 'ontology-entity', entity: 'Order', top: 99999, columns: ['a', 1, ''] });
    expect(b).toEqual({ source: 'ontology-entity', entity: 'Order', columns: ['a'], top: 1000 });
  });
  it('drops an ontology-entity binding with no entity', () => {
    expect(normalizeBinding({ source: 'ontology-entity' })).toBeUndefined();
  });
  it('coerces an aas-model binding', () => {
    const b = normalizeBinding({ source: 'aas-model', model: 'Sales', measures: ['Revenue'], groupBy: ['Date|Year'], topN: 0 });
    expect(b).toEqual({ source: 'aas-model', model: 'Sales', measures: ['Revenue'], groupBy: ['Date|Year'], topN: 100 });
  });
  it('returns undefined for junk', () => {
    expect(normalizeBinding(null)).toBeUndefined();
    expect(normalizeBinding('nope')).toBeUndefined();
  });
});

describe('normalizeAppDef', () => {
  it('returns an empty def for non-objects', () => {
    expect(normalizeAppDef(undefined)).toEqual(EMPTY_APP_DEF);
    expect(normalizeAppDef(42)).toEqual({ version: APP_DEF_VERSION, pages: [], actions: [] });
  });
  it('keeps text components and drops invalid actions', () => {
    const def = normalizeAppDef({
      pages: [{ id: 'p1', name: 'Home', components: [
        { id: 'c1', kind: 'text', title: 'Intro', text: 'hello' },
        { id: 'c2', kind: 'table', title: 'Orders', binding: { source: 'ontology-entity', entity: 'Order' } },
        'garbage',
      ] }],
      actions: [{ id: 'a1', label: 'New order', kind: 'create', entity: 'Order' }, { label: 'bad' }],
    });
    expect(def.pages).toHaveLength(1);
    expect(def.pages[0].components).toHaveLength(2);
    expect(def.pages[0].components[0]).toMatchObject({ kind: 'text', text: 'hello' });
    expect(def.actions).toHaveLength(1);
    expect(def.actions[0]).toMatchObject({ kind: 'create', entity: 'Order' });
  });
});

describe('migrateWorkshopState', () => {
  it('prefers a present appDef', () => {
    const appDef: AppDefinition = { version: APP_DEF_VERSION, pages: [{ id: 'p', name: 'P', components: [] }], actions: [] };
    expect(migrateWorkshopState({ appDef }).pages).toHaveLength(1);
  });
  it('migrates legacy objectViews + actions to pages', () => {
    const def = migrateWorkshopState({
      objectViews: ['Order', 'Customer'],
      actions: [{ id: 'a', label: 'Approve', kind: 'update', entity: 'Order' }],
    });
    expect(def.pages).toHaveLength(2);
    expect(def.pages[0].name).toBe('Order');
    expect(def.pages[0].components[0]).toMatchObject({ kind: 'table', binding: { source: 'ontology-entity', entity: 'Order' } });
    expect(def.actions).toHaveLength(1);
    expect(def.actions[0].kind).toBe('update');
  });
  it('returns an empty def for empty state', () => {
    expect(migrateWorkshopState({})).toEqual(EMPTY_APP_DEF);
    expect(migrateWorkshopState(null)).toEqual(EMPTY_APP_DEF);
  });
});

describe('appDefFromRayfinBinding', () => {
  it('returns null when nothing is selected', () => {
    expect(appDefFromRayfinBinding({ model: 'Sales', measures: [], groupBy: [], topN: 100 })).toBeNull();
    expect(appDefFromRayfinBinding({ model: '', measures: ['x'], groupBy: [], topN: 100 })).toBeNull();
    expect(appDefFromRayfinBinding(null)).toBeNull();
  });
  it('builds a metric card for measures-only', () => {
    const def = appDefFromRayfinBinding({ model: 'Sales', measures: ['Revenue'], groupBy: [], topN: 100 }, 'demo');
    expect(def).not.toBeNull();
    expect(def!.pages[0].components[0].kind).toBe('metric');
    expect(def!.pages[0].components[0].binding).toMatchObject({ source: 'aas-model', model: 'Sales', measures: ['Revenue'] });
  });
  it('builds a table when grouped', () => {
    const def = appDefFromRayfinBinding({ model: 'Sales', measures: ['Revenue'], groupBy: ['Date|Year'], topN: 250 });
    expect(def!.pages[0].components[0].kind).toBe('table');
    expect(def!.pages[0].components[0].binding).toMatchObject({ groupBy: ['Date|Year'], topN: 250 });
  });
});

describe('summarizeAppDef', () => {
  it('counts pages, components, and actions', () => {
    const def: AppDefinition = {
      version: APP_DEF_VERSION,
      pages: [
        { id: 'p1', name: 'a', components: [{ id: 'c1', kind: 'text', title: 't', text: '' }] },
        { id: 'p2', name: 'b', components: [] },
      ],
      actions: [{ id: 'a1', label: 'x', kind: 'create', entity: 'Order' }],
    };
    expect(summarizeAppDef(def)).toEqual({ pages: 2, components: 1, actions: 1 });
  });
});
