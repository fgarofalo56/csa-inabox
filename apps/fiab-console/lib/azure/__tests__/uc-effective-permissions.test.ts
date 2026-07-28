/**
 * LU-4 — effective-permissions resolver (the inheritance walk).
 *
 * These tests pin the three behaviours a resolver of this shape is usually
 * WRONG about, each stated as the bug it would catch:
 *
 *   1. Inheritance is resolved at READ time. A grant made on a catalog before a
 *      table existed must still apply to that table — a resolver that only reads
 *      the target's own ACL (or that materializes grants at write time) returns
 *      nothing here.
 *   2. Ownership implies the FULL applicable privilege set on the owned
 *      securable and everything beneath it — a resolver that only unions
 *      explicit privilege_assignments gives the owner of `main` no access to
 *      `main.sales.orders`.
 *   3. Group membership is transitive through nesting, and a membership CYCLE
 *      must terminate. A naive recursive expansion hangs (the cycle test would
 *      time out) or drops the deepest group's grants.
 *
 * Plus the filter that keeps the answer honest: a parent privilege only flows to
 * a child that accepts it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ucSecurableChain,
  expandPrincipalClosure,
  resolveEffectivePermissions,
  formatUcPrivilege,
  ucPrivilegesFor,
  normalizeUcPrivilege,
  type UcSecurableNode,
} from '../uc-effective-permissions';

/** Privileges held by `principal`, as a plain sorted array. */
function privsOf(assignments: { principal: string; privileges: { privilege: string }[] }[], principal: string): string[] {
  const a = assignments.find((x) => x.principal.toLowerCase() === principal.toLowerCase());
  return (a?.privileges || []).map((p) => p.privilege).sort();
}

describe('ucSecurableChain', () => {
  it('walks a table up through its schema to its catalog, target first', () => {
    expect(ucSecurableChain('TABLE', 'main.sales.orders')).toEqual([
      { type: 'TABLE', name: 'main.sales.orders' },
      { type: 'SCHEMA', name: 'main.sales' },
      { type: 'CATALOG', name: 'main' },
    ]);
  });

  it('walks a schema up to its catalog and a catalog to nothing', () => {
    expect(ucSecurableChain('SCHEMA', 'main.sales')).toEqual([
      { type: 'SCHEMA', name: 'main.sales' },
      { type: 'CATALOG', name: 'main' },
    ]);
    expect(ucSecurableChain('CATALOG', 'main')).toEqual([{ type: 'CATALOG', name: 'main' }]);
  });

  it('treats metastore-level securables as parentless (no bogus catalog hop)', () => {
    expect(ucSecurableChain('EXTERNAL_LOCATION', 'lake_root')).toEqual([{ type: 'EXTERNAL_LOCATION', name: 'lake_root' }]);
    expect(ucSecurableChain('STORAGE_CREDENTIAL', 'lake_mi')).toEqual([{ type: 'STORAGE_CREDENTIAL', name: 'lake_mi' }]);
    expect(ucSecurableChain('METASTORE', '')).toEqual([{ type: 'METASTORE', name: '' }]);
  });

  it('does not invent ancestors from a partial name', () => {
    // A caller that typed "orders" instead of "main.sales.orders" must not make
    // the resolver read grants on a catalog literally named "orders".
    expect(ucSecurableChain('TABLE', 'orders')).toEqual([{ type: 'TABLE', name: 'orders' }]);
  });
});

describe('resolveEffectivePermissions — inheritance', () => {
  it('applies a catalog grant to a table that did not exist when it was made', () => {
    // The table's own ACL is EMPTY — every privilege here comes from the parent.
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] },
    ];
    const out = resolveEffectivePermissions(chain);
    expect(privsOf(out, 'analysts')).toEqual(['SELECT']);
    expect(out[0].privileges[0]).toMatchObject({
      privilege: 'SELECT', inherited_from_type: 'CATALOG', inherited_from_name: 'main', source: 'GRANT',
    });
  });

  it('does NOT flow a parent privilege the child type cannot hold', () => {
    // CREATE_SCHEMA is meaningful on a catalog and meaningless on a table;
    // reporting it as effective on the table would be a false positive.
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['CREATE_SCHEMA', 'USE_CATALOG', 'SELECT'] }] },
    ];
    expect(privsOf(resolveEffectivePermissions(chain), 'analysts')).toEqual(['SELECT']);
  });

  it('reports the MOST direct provenance when the same privilege arrives twice', () => {
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] },
    ];
    const out = resolveEffectivePermissions(chain);
    expect(out[0].privileges).toHaveLength(1);
    expect(out[0].privileges[0].inherited_from_type).toBeUndefined();
  });

  it('normalizes the OSS space-spelled privileges into the same set as Databricks', () => {
    const chain: UcSecurableNode[] = [
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['USE SCHEMA', 'SELECT'] }] },
    ];
    expect(privsOf(resolveEffectivePermissions(chain), 'analysts')).toEqual(['SELECT', 'USE_SCHEMA']);
  });
});

describe('resolveEffectivePermissions — ownership', () => {
  it('gives the owner of a catalog the full privilege set on a table beneath it', () => {
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', owner: 'dana@contoso.com', assignments: [] },
    ];
    const out = resolveEffectivePermissions(chain);
    // TABLE's applicable set, not the catalog's — an owner holds what the
    // TARGET securable can express.
    expect(privsOf(out, 'dana@contoso.com')).toEqual([...ucPrivilegesFor('TABLE')].sort());
    expect(out[0].privileges[0]).toMatchObject({
      source: 'OWNERSHIP', inherited_from_type: 'CATALOG', inherited_from_name: 'main',
    });
  });

  it('marks ownership of the target itself as not inherited', () => {
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', owner: 'dana@contoso.com', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [] },
    ];
    const out = resolveEffectivePermissions(chain);
    expect(out[0].privileges.every((p) => p.source === 'OWNERSHIP' && !p.inherited_from_type)).toBe(true);
  });

  it('does not fabricate an owner when the backend reports none', () => {
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', owner: '', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [] },
    ];
    expect(resolveEffectivePermissions(chain)).toEqual([]);
  });
});

describe('expandPrincipalClosure — transitive groups', () => {
  const membership: Record<string, string[]> = {
    'ada@contoso.com': ['analysts'],
    analysts: ['data-readers'],
    'data-readers': ['everyone'],
  };
  const resolver = async (p: string) => membership[p] || [];

  it('follows nested groups all the way down', async () => {
    const { closure, groups } = await expandPrincipalClosure('ada@contoso.com', resolver);
    expect(closure).toEqual(['ada@contoso.com', 'analysts', 'data-readers', 'everyone']);
    expect(groups).toEqual(['analysts', 'data-readers', 'everyone']);
  });

  it('TERMINATES on a membership cycle instead of recursing forever', async () => {
    const cyclic: Record<string, string[]> = { a: ['b'], b: ['c'], c: ['a'] };
    const calls: string[] = [];
    const { closure, truncated } = await expandPrincipalClosure('a', async (p) => {
      calls.push(p);
      return cyclic[p] || [];
    });
    expect(closure).toEqual(['a', 'b', 'c']);
    expect(truncated).toBe(false);
    // Each principal expanded exactly once — the visited set is what breaks the
    // cycle; without it this array grows without bound and the test times out.
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('is case-insensitive about membership identity (no duplicate hops)', async () => {
    const { closure } = await expandPrincipalClosure('ada@contoso.com', async (p) =>
      p === 'ada@contoso.com' ? ['Analysts', 'ANALYSTS', 'analysts'] : []);
    expect(closure).toEqual(['ada@contoso.com', 'Analysts']);
  });

  it('flags truncation instead of silently returning a subset', async () => {
    // A chain deeper than maxDepth: the answer is incomplete and must say so.
    const deep = async (p: string) => [`g${Number(p.replace('g', '') || 0) + 1}`];
    const { truncated } = await expandPrincipalClosure('g0', deep, { maxDepth: 3 });
    expect(truncated).toBe(true);
  });

  it('reports a directory failure and still returns the principal itself', async () => {
    const onError = vi.fn();
    const { closure, groups } = await expandPrincipalClosure('ada@contoso.com', async () => {
      throw new Error('Graph 403');
    }, { onError });
    expect(closure).toEqual(['ada@contoso.com']);
    expect(groups).toEqual([]);
    expect(onError).toHaveBeenCalledWith('ada@contoso.com', expect.any(Error));
  });
});

describe('resolveEffectivePermissions — principal scoping through groups', () => {
  const chain: UcSecurableNode[] = [
    { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['MODIFY'] }] },
    { type: 'SCHEMA', name: 'main.sales', assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] },
    { type: 'CATALOG', name: 'main', owner: 'platform-admins', assignments: [{ principal: 'someone-else', privileges: ['SELECT', 'MODIFY'] }] },
  ];

  it('unions in privileges granted to a group the principal belongs to', () => {
    const out = resolveEffectivePermissions(chain, {
      principal: 'ada@contoso.com',
      principalClosure: ['ada@contoso.com', 'analysts'],
    });
    expect(out).toHaveLength(1);
    expect(out[0].principal).toBe('ada@contoso.com');
    expect(privsOf(out, 'ada@contoso.com')).toEqual(['MODIFY', 'SELECT']);
    const select = out[0].privileges.find((p) => p.privilege === 'SELECT')!;
    expect(select).toMatchObject({ via_principal: 'analysts', inherited_from_type: 'SCHEMA' });
    // The direct grant is NOT attributed to a group.
    expect(out[0].privileges.find((p) => p.privilege === 'MODIFY')!.via_principal).toBeUndefined();
  });

  it('excludes principals outside the closure', () => {
    const out = resolveEffectivePermissions(chain, {
      principal: 'ada@contoso.com',
      principalClosure: ['ada@contoso.com'],
    });
    // Without the analysts membership, only the direct grant survives — the
    // someone-else / platform-admins rows must never leak into the answer.
    expect(privsOf(out, 'ada@contoso.com')).toEqual(['MODIFY']);
  });

  it('honours ownership held by a GROUP the principal belongs to', () => {
    const out = resolveEffectivePermissions(chain, {
      principal: 'ada@contoso.com',
      principalClosure: ['ada@contoso.com', 'platform-admins'],
    });
    expect(privsOf(out, 'ada@contoso.com')).toEqual([...ucPrivilegesFor('TABLE')].sort());
    expect(out[0].privileges.find((p) => p.privilege === 'MANAGE')).toMatchObject({
      source: 'OWNERSHIP', via_principal: 'platform-admins', inherited_from_type: 'CATALOG',
    });
  });

  it('returns nothing (not everything) for a principal with no access', () => {
    expect(resolveEffectivePermissions(chain, { principal: 'nobody@contoso.com' })).toEqual([]);
  });
});

describe('formatUcPrivilege', () => {
  it('renders plain, inherited, owned and via-group provenance distinctly', () => {
    expect(formatUcPrivilege('USE CATALOG')).toBe('USE_CATALOG');
    expect(formatUcPrivilege({ privilege: 'SELECT' })).toBe('SELECT');
    expect(formatUcPrivilege({ privilege: 'SELECT', inherited_from_type: 'CATALOG', inherited_from_name: 'main' }))
      .toBe('SELECT (inherited from CATALOG main)');
    expect(formatUcPrivilege({ privilege: 'MANAGE', source: 'OWNERSHIP' })).toBe('MANAGE (owner)');
    expect(formatUcPrivilege({ privilege: 'MANAGE', source: 'OWNERSHIP', inherited_from_type: 'SCHEMA', inherited_from_name: 'main.sales' }))
      .toBe('MANAGE (inherited: owner of SCHEMA main.sales)');
    expect(formatUcPrivilege({ privilege: 'SELECT', inherited_from_type: 'SCHEMA', inherited_from_name: 'main.sales', via_principal: 'analysts' }))
      .toBe('SELECT (inherited from SCHEMA main.sales, via analysts)');
  });

  it('keeps the word "inherited" in every non-local provenance', () => {
    // The grants pane keys off this substring to tint the badge and to exclude
    // the row from "Revoke all" — you cannot revoke a parent's grant here.
    for (const p of [
      { privilege: 'SELECT', inherited_from_type: 'CATALOG' as const, inherited_from_name: 'main' },
      { privilege: 'MANAGE', source: 'OWNERSHIP' as const, inherited_from_type: 'CATALOG' as const, inherited_from_name: 'main' },
    ]) {
      expect(formatUcPrivilege(p)).toContain('inherited');
    }
  });
});

describe('privilege helpers', () => {
  it('hides the Databricks-only privileges on the OSS backend only', () => {
    expect(ucPrivilegesFor('TABLE')).toContain('MANAGE');
    expect(ucPrivilegesFor('TABLE', { oss: true })).not.toContain('MANAGE');
    expect(ucPrivilegesFor('TABLE', { oss: true })).toEqual(['SELECT', 'MODIFY']);
  });

  it('returns [] for an unknown securable rather than throwing', () => {
    expect(ucPrivilegesFor('PIPELINE')).toEqual([]);
  });

  it('normalizes spelling from both servers', () => {
    expect(normalizeUcPrivilege('use  catalog')).toBe('USE_CATALOG');
    expect(normalizeUcPrivilege(' select ')).toBe('SELECT');
  });
});
