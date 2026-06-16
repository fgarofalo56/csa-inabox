/**
 * Unit tests for validateDbtProjectGraph (audit B10).
 *
 * Pins the contract that a malformed graph yields precise field-level errors —
 * so the dbt-job run route can answer 400 instead of crashing codegen with an
 * unguarded TypeError ("Cannot read properties of undefined (reading 'length')")
 * → raw 502.
 */
import { describe, it, expect } from 'vitest';
import {
  validateDbtProjectGraph,
  emptyProjectGraph,
  type DbtProjectGraph,
} from '../dbt-project-model';

function validGraph(): DbtProjectGraph {
  return {
    projectName: 'p',
    profileName: 'p',
    sources: [{ name: 'raw', schema: 'dbo', table: 'orders' }],
    models: [{ name: 'stg_orders', layer: 'bronze', materialized: 'view', sql: 'select 1' }],
    target: { adapter: 'databricks', catalog: 'main', schema: 'analytics' },
  };
}

describe('validateDbtProjectGraph', () => {
  it('accepts a well-formed graph', () => {
    expect(validateDbtProjectGraph(validGraph())).toEqual([]);
  });

  it('flags a missing sources[] array (the B10 crash trigger)', () => {
    const g: any = validGraph();
    delete g.sources;
    const errors = validateDbtProjectGraph(g);
    expect(errors.some((e) => e.field === 'sources')).toBe(true);
  });

  it('flags a model with no layer', () => {
    const g: any = validGraph();
    delete g.models[0].layer;
    const errors = validateDbtProjectGraph(g);
    expect(errors.some((e) => e.field === 'models[0].layer')).toBe(true);
  });

  it('flags an invalid layer value', () => {
    const g: any = validGraph();
    g.models[0].layer = 'platinum';
    const errors = validateDbtProjectGraph(g);
    expect(errors.some((e) => e.field === 'models[0].layer' && /invalid/.test(e.message))).toBe(true);
  });

  it('flags a missing target adapter', () => {
    const g: any = validGraph();
    delete g.target.adapter;
    expect(validateDbtProjectGraph(g).some((e) => e.field === 'target.adapter')).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateDbtProjectGraph(null).length).toBeGreaterThan(0);
    expect(validateDbtProjectGraph(undefined).length).toBeGreaterThan(0);
  });

  it('flags an empty model list', () => {
    const g = emptyProjectGraph();
    expect(validateDbtProjectGraph(g).some((e) => e.field === 'models')).toBe(true);
  });
});
