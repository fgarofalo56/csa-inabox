/**
 * transform-menu — the categorized Eventstream "Transform events" menu model
 * and its operator-mapping resolver (Fabric parity). Every entry must map to a
 * REAL backing action (an operator kind or the SQL tab); unknown ids gate.
 */
import { describe, it, expect } from 'vitest';
import {
  TRANSFORM_MENU, resolveTransformMenuItem, flattenTransformMenu,
} from '../transform-menu';

describe('TRANSFORM_MENU', () => {
  it('has the Custom code + Predefined operations sections in Fabric order', () => {
    expect(TRANSFORM_MENU.map((c) => c.category)).toEqual(['Custom code', 'Predefined operations']);
  });
  it('surfaces SQL code under Custom code with a badge', () => {
    const sql = TRANSFORM_MENU[0].items[0];
    expect(sql.id).toBe('sql');
    expect(sql.badge).toBeTruthy();
  });
  it('lists the seven predefined operators', () => {
    const ids = TRANSFORM_MENU[1].items.map((i) => i.id);
    expect(ids).toEqual(['filter', 'manage-fields', 'aggregate', 'join', 'group-by', 'union', 'expand']);
  });
});

describe('resolveTransformMenuItem', () => {
  it('routes SQL to the code-first tab', () => {
    expect(resolveTransformMenuItem('sql')).toEqual({ kind: 'sql-tab' });
  });
  it('maps every predefined item to its operator kind', () => {
    for (const it of TRANSFORM_MENU[1].items) {
      expect(resolveTransformMenuItem(it.id)).toEqual({ kind: 'operator', op: it.id });
    }
  });
  it('maps the CDC transform kind even though it is not on the menu', () => {
    expect(resolveTransformMenuItem('cdc-flatten')).toEqual({ kind: 'operator', op: 'cdc-flatten' });
  });
  it('gates an unknown id instead of faking a no-op', () => {
    const r = resolveTransformMenuItem('bogus');
    expect(r.kind).toBe('gate');
    if (r.kind === 'gate') expect(r.reason).toContain('bogus');
  });
});

describe('flattenTransformMenu', () => {
  it('returns every item across categories', () => {
    expect(flattenTransformMenu()).toHaveLength(8);
  });
  it('every flattened item resolves to a non-gate target', () => {
    for (const it of flattenTransformMenu()) {
      expect(resolveTransformMenuItem(it.id).kind).not.toBe('gate');
    }
  });
});
