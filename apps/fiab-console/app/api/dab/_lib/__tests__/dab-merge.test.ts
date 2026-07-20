/**
 * Unit tests for the pure DAB config-merge + collision logic (task #19).
 */
import { describe, it, expect } from 'vitest';
import { mergeDabConfigs, type DabItemConfig } from '../dab-merge';
import type { DabConfig } from '../dab-config-model';

function cfg(entityNames: string[], withSource = true): DabConfig {
  return {
    sourceRef: withSource ? { kind: 'mssql', database: 'loompool' } : { kind: 'mssql' },
    runtime: {
      rest: { enabled: true, path: '/api', requestBodyStrict: true },
      graphql: { enabled: true, path: '/graphql', allowIntrospection: true },
      host: { mode: 'development', corsOrigins: [], corsAllowCredentials: false, authProvider: 'Simulator' },
      cache: { enabled: false, ttlSeconds: 5 },
      pagination: { defaultPageSize: 100, maxPageSize: 100000 },
    },
    entities: entityNames.map((name) => ({
      name,
      source: { object: `gold.${name.toLowerCase()}`, type: 'table' as const },
      rest: { enabled: true },
      graphql: { enabled: true },
      permissions: [{ role: 'anonymous', actions: [{ action: 'read' as const }] }],
    })),
  };
}

describe('mergeDabConfigs', () => {
  it('merges entities from multiple items', () => {
    const inputs: DabItemConfig[] = [
      { itemId: 'a', config: cfg(['Order', 'Customer']) },
      { itemId: 'b', config: cfg(['Product']) },
    ];
    const r = mergeDabConfigs(inputs);
    expect(r.entitiesApplied).toEqual(['Order', 'Customer', 'Product']);
    expect(r.config.entities).toHaveLength(3);
    expect(r.collisions).toHaveLength(0);
    expect(r.sourceItemIds).toEqual(['a', 'b']);
  });

  it('processes items in a stable order by itemId (deterministic)', () => {
    const r1 = mergeDabConfigs([{ itemId: 'z', config: cfg(['Z']) }, { itemId: 'a', config: cfg(['A']) }]);
    const r2 = mergeDabConfigs([{ itemId: 'a', config: cfg(['A']) }, { itemId: 'z', config: cfg(['Z']) }]);
    expect(r1.entitiesApplied).toEqual(['A', 'Z']);
    expect(r2.entitiesApplied).toEqual(r1.entitiesApplied);
  });

  it('skips (never silently drops) a duplicate entity name; first-by-itemId wins', () => {
    const inputs: DabItemConfig[] = [
      { itemId: 'b', config: cfg(['Order']) },
      { itemId: 'a', config: cfg(['Order']) }, // sorts first → wins
    ];
    const r = mergeDabConfigs(inputs);
    expect(r.entitiesApplied).toEqual(['Order']);
    expect(r.config.entities).toHaveLength(1);
    expect(r.collisions).toEqual([{ name: 'Order', keptFrom: 'a', skippedFrom: 'b' }]);
  });

  it('takes sourceRef/runtime from the first sorted item that has a sourceRef', () => {
    const r = mergeDabConfigs([
      { itemId: 'a', config: cfg(['A'], false) },  // no database on sourceRef
      { itemId: 'b', config: cfg(['B'], true) },
    ]);
    // 'a' sorts first and DOES carry a sourceRef (kind only) → its runtime is the base.
    expect(r.config.sourceRef.kind).toBe('mssql');
    expect(r.config.entities.map((e) => e.name)).toEqual(['A', 'B']);
  });

  it('returns a healthy empty config for no inputs', () => {
    const r = mergeDabConfigs([]);
    expect(r.entitiesApplied).toEqual([]);
    expect(r.config.entities).toEqual([]);
    expect(r.config.runtime).toBeTruthy();
  });

  it('ignores items with null config and blank entity names', () => {
    const r = mergeDabConfigs([
      { itemId: 'a', config: null },
      { itemId: 'b', config: cfg(['', 'Real']) },
    ]);
    expect(r.entitiesApplied).toEqual(['Real']);
  });
});
