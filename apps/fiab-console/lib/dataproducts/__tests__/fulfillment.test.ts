import { describe, it, expect } from 'vitest';
import { resolveGrantTargets, rollUpFulfillment } from '../fulfillment';

describe('resolveGrantTargets', () => {
  it('maps structured output ports to the right RBAC scopes', () => {
    const t = resolveGrantTargets({
      ports: {
        input: [{ name: 'up', direction: 'input', kind: 'data-product', ref: 'dp-1' }],
        output: [
          { name: 'lake', direction: 'output', kind: 'adls', ref: 'curated' },
          { name: 'sql', direction: 'output', kind: 'sql-endpoint', ref: 'salesdb' },
          { name: 'adx', direction: 'output', kind: 'adx', ref: 'events' },
          { name: 'api', direction: 'output', kind: 'rest', ref: 'https://x' }, // no RBAC target
        ],
        management: [],
      },
    });
    expect(t).toEqual([
      { scopeType: 'adls-container', scopeRef: 'curated', permission: 'read', source: "output port 'lake'" },
      { scopeType: 'warehouse', scopeRef: 'salesdb', permission: 'read', source: "output port 'sql'" },
      { scopeType: 'kql-database', scopeRef: 'events', permission: 'read', source: "output port 'adx'" },
    ]);
  });

  it('treats an abfss ref as an adls-path', () => {
    const t = resolveGrantTargets({ ports: { output: [{ name: 'p', direction: 'output', kind: 'delta', ref: 'abfss://c@a.dfs.core.windows.net/x' }] } });
    expect(t[0].scopeType).toBe('adls-path');
  });

  it('accepts the legacy flat ports array', () => {
    const t = resolveGrantTargets({ ports: [{ name: 'lake', direction: 'output', kind: 'adls', ref: 'curated' }] });
    expect(t).toHaveLength(1);
    expect(t[0].scopeType).toBe('adls-container');
  });

  it('falls back to ADLS-qualified data assets when no output ports resolve', () => {
    const t = resolveGrantTargets({ dataAssets: [{ name: 'sales', qualifiedName: 'abfss://c@a.dfs.core.windows.net/sales' }] });
    expect(t).toHaveLength(1);
    expect(t[0].scopeType).toBe('adls-path');
  });

  it('returns [] when nothing is resolvable (→ honest-gate)', () => {
    expect(resolveGrantTargets({})).toEqual([]);
    expect(resolveGrantTargets({ ports: { output: [{ name: 'x', direction: 'output', kind: 'rest', ref: 'https://x' }] } })).toEqual([]);
  });

  it('de-duplicates identical scope targets', () => {
    const t = resolveGrantTargets({ ports: { output: [
      { name: 'a', direction: 'output', kind: 'adls', ref: 'curated' },
      { name: 'b', direction: 'output', kind: 'adls', ref: 'curated' },
    ] } });
    expect(t).toHaveLength(1);
  });
});

describe('rollUpFulfillment', () => {
  it('all active → provisioned', () => {
    expect(rollUpFulfillment([{ status: 'active' }, { status: 'active' }])).toBe('provisioned');
  });
  it('any pending → partial; any error → failed; empty → none', () => {
    expect(rollUpFulfillment([{ status: 'active' }, { status: 'pending' }])).toBe('partial');
    expect(rollUpFulfillment([{ status: 'active' }, { status: 'error' }])).toBe('failed');
    expect(rollUpFulfillment([])).toBe('none');
  });
});
