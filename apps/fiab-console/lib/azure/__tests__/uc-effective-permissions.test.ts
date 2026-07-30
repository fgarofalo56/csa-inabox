/**
 * LU-4 — effective-permissions resolver (the inheritance walk).
 *
 * A permissions resolver that grants TOO MUCH is the worst possible outcome on
 * an access-review surface, so most of these specs are NEGATIVE: they assert a
 * principal does **not** hold something. The first version of this resolver
 * passed a green suite while reporting SELECT + MODIFY for every catalog owner
 * on every table beneath them, because the expectations were written from the
 * same wrong premise as the code. Each rule below is therefore pinned to
 * Microsoft Learn, not to the implementation.
 *
 *   1. Privilege inheritance is downward and resolved at READ time.
 *      — Learn, *Unity Catalog permissions model concepts § Privilege inheritance*
 *   2. Ownership does NOT inherit downward: "you're automatically granted all
 *      privileges on that object only … you do automatically get the `MANAGE`
 *      privilege on all new and existing child objects".  — same page
 *   3. `ALL PRIVILEGES` "*implies* all applicable privileges for a specific
 *      object type" and "does not include the `EXTERNAL USE SCHEMA`,
 *      `EXTERNAL USE LOCATION`, or `MANAGE` privileges".  — § ALL PRIVILEGES
 *   4. Usage privileges are prerequisites: "Having only the `SELECT` privilege
 *      on a table is not sufficient to read it if you lack `USE CATALOG` or
 *      `USE SCHEMA` on its parent objects."  — § Usage privileges
 *   5. Group membership is transitive, and a membership CYCLE must terminate.
 *   6. The OSS backend's vocabulary has no MANAGE / BROWSE / APPLY TAG, so the
 *      answer must never claim them there.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ucSecurableChain,
  expandPrincipalClosure,
  resolveEffectivePermissions,
  formatUcPrivilege,
  ucPrivilegesFor,
  expandAllPrivileges,
  normalizeUcPrivilege,
  isUcPrivilegeBlocked,
  isUcPrivilegeRevocableHere,
  UC_OWNER_IMPLIED_ON_DESCENDANT,
  UC_PRIVILEGES_BY_SECURABLE,
  type UcSecurableNode,
  type UcEffectiveAssignment,
} from '../uc-effective-permissions';

/** Privileges held by `principal`, as a plain sorted array. */
function privsOf(assignments: UcEffectiveAssignment[], principal: string): string[] {
  const a = assignments.find((x) => x.principal.toLowerCase() === principal.toLowerCase());
  return (a?.privileges || []).map((p) => p.privilege).sort();
}
function rowOf(assignments: UcEffectiveAssignment[], principal: string): UcEffectiveAssignment | undefined {
  return assignments.find((x) => x.principal.toLowerCase() === principal.toLowerCase());
}
/** A usage grant so prerequisites are satisfied and cannot mask the behaviour a
 *  test is actually about. */
function usageGrant(principal: string) {
  return { principal, privileges: ['USE_CATALOG', 'USE_SCHEMA'] };
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

  it('NEVER invents an ancestor from a partial name — 1-part OR 2-part', () => {
    // A caller that typed "orders" must not make the resolver read a catalog
    // literally named "orders" …
    expect(ucSecurableChain('TABLE', 'orders')).toEqual([{ type: 'TABLE', name: 'orders' }]);
    // … and "main.orders" (2 parts where 3 are required) must not either. This
    // is the case the first version got wrong: it produced a CATALOG `main` hop
    // and attributed that catalog's grants to a securable that does not exist.
    expect(ucSecurableChain('TABLE', 'main.orders')).toEqual([{ type: 'TABLE', name: 'main.orders' }]);
    expect(ucSecurableChain('VOLUME', 'main.files')).toEqual([{ type: 'VOLUME', name: 'main.files' }]);
    expect(ucSecurableChain('SCHEMA', 'sales')).toEqual([{ type: 'SCHEMA', name: 'sales' }]);
    // A 4-part name is not a UC object name either — no ancestors invented.
    expect(ucSecurableChain('TABLE', 'a.b.c.d')).toEqual([{ type: 'TABLE', name: 'a.b.c.d' }]);
  });
});

describe('resolveEffectivePermissions — inheritance', () => {
  it('applies a catalog grant to a table that did not exist when it was made', () => {
    // The table's own ACL is EMPTY — every privilege here comes from the parent.
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['SELECT', 'USE_CATALOG', 'USE_SCHEMA'] }] },
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
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['CREATE_SCHEMA', 'USE_CATALOG', 'USE_SCHEMA', 'SELECT'] }] },
    ];
    expect(privsOf(resolveEffectivePermissions(chain), 'analysts')).toEqual(['SELECT']);
  });

  it('reports the MOST direct provenance when the same privilege arrives twice', () => {
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['SELECT', 'USE_CATALOG', 'USE_SCHEMA'] }] },
    ];
    const out = resolveEffectivePermissions(chain);
    expect(out[0].privileges).toHaveLength(1);
    expect(out[0].privileges[0].inherited_from_type).toBeUndefined();
  });

  it('normalizes the OSS space-spelled privileges into the same set as Databricks', () => {
    const chain: UcSecurableNode[] = [
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['USE SCHEMA', 'SELECT', 'USE CATALOG'] }] },
    ];
    expect(privsOf(resolveEffectivePermissions(chain), 'analysts')).toEqual(['SELECT', 'USE_SCHEMA']);
  });

  it('a metastore-level securable inherits nothing and has no usage prerequisites', () => {
    const chain: UcSecurableNode[] = [
      { type: 'EXTERNAL_LOCATION', name: 'lake_root', assignments: [{ principal: 'ops', privileges: ['READ_FILES'] }] },
    ];
    const out = resolveEffectivePermissions(chain);
    expect(privsOf(out, 'ops')).toEqual(['READ_FILES']);
    expect(rowOf(out, 'ops')?.usage ?? []).toEqual([]);
  });
});

// ============================================================
// The headline defect: ownership must NOT cascade
// ============================================================

describe('resolveEffectivePermissions — ownership does NOT inherit downward', () => {
  const catalogOwnerChain: UcSecurableNode[] = [
    { type: 'TABLE', name: 'main.sales.pii_customers', assignments: [] },
    { type: 'SCHEMA', name: 'main.sales', assignments: [] },
    { type: 'CATALOG', name: 'main', owner: 'dana@contoso.com', assignments: [] },
  ];

  it('gives the owner of an ANCESTOR only MANAGE on a descendant — never SELECT/MODIFY', () => {
    const out = resolveEffectivePermissions(catalogOwnerChain);
    // Learn: "Ownership doesn't inherit downward … you do automatically get the
    // MANAGE privilege on all new and existing child objects."
    expect(privsOf(out, 'dana@contoso.com')).toEqual([UC_OWNER_IMPLIED_ON_DESCENDANT]);
    // THE ATTACK: a catalog owner reported as able to read every PII table under
    // it, with no grant existing anywhere. These assertions fail loudly if
    // ownership is ever re-expanded to the target's full set.
    expect(privsOf(out, 'dana@contoso.com')).not.toContain('SELECT');
    expect(privsOf(out, 'dana@contoso.com')).not.toContain('MODIFY');
    expect(privsOf(out, 'dana@contoso.com')).not.toContain('APPLY_TAG');
  });

  it('a SCHEMA owner likewise gets only MANAGE on a table in that schema', () => {
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', owner: 'sales-leads', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [] },
    ]);
    expect(privsOf(out, 'sales-leads')).toEqual(['MANAGE']);
    expect(privsOf(out, 'sales-leads')).not.toContain('SELECT');
  });

  it('gives the owner of the TARGET the full applicable set (that part IS right)', () => {
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', owner: 'dana@contoso.com', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [] },
    ]);
    expect(privsOf(out, 'dana@contoso.com')).toEqual([...ucPrivilegesFor('TABLE')].sort());
    expect(out[0].privileges.every((p) => p.source === 'OWNERSHIP' && !p.inherited_from_type)).toBe(true);
  });

  it('marks the descendant MANAGE as inherited from the securable actually owned', () => {
    const out = resolveEffectivePermissions(catalogOwnerChain);
    expect(out[0].privileges[0]).toMatchObject({
      privilege: 'MANAGE', source: 'OWNERSHIP', inherited_from_type: 'CATALOG', inherited_from_name: 'main',
    });
    expect(isUcPrivilegeRevocableHere(out[0].privileges[0])).toBe(false);
  });

  it('does not fabricate an owner when the backend reports none', () => {
    expect(resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', owner: '', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [] },
    ])).toEqual([]);
  });

  it('on the OSS backend an ancestor owner gets NOTHING (that backend has no MANAGE)', () => {
    const out = resolveEffectivePermissions(catalogOwnerChain, { oss: true });
    // MANAGE is the only thing ancestor ownership confers, and the OSS Unity
    // Catalog server does not implement it — so claiming it would report a
    // privilege nothing there can enforce.
    expect(out).toEqual([]);
  });
});

// ============================================================
// ALL PRIVILEGES must expand, never vanish
// ============================================================

describe('resolveEffectivePermissions — ALL PRIVILEGES', () => {
  it('expands an inherited ALL PRIVILEGES instead of dropping it', () => {
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'admins', privileges: ['ALL PRIVILEGES'] }] },
    ];
    const out = resolveEffectivePermissions(chain);
    // THE BUG THIS CATCHES: filtering ALL_PRIVILEGES against the per-securable
    // table (which has no such entry) made the single most powerful grant in
    // Unity Catalog report as NOTHING.
    expect(privsOf(out, 'admins')).toEqual(['APPLY_TAG', 'MODIFY', 'SELECT']);
    expect(privsOf(out, 'admins')).not.toContain('ALL_PRIVILEGES');
    expect(out[0].privileges[0].implied_by).toBe('ALL_PRIVILEGES');
  });

  it('does NOT let ALL PRIVILEGES imply MANAGE (privilege-escalation guard)', () => {
    // Learn: "To avoid accidental privilege escalation, the ALL PRIVILEGES
    // privilege doesn't include the MANAGE privilege."
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'admins', privileges: ['ALL_PRIVILEGES'] }] },
    ]);
    expect(privsOf(out, 'admins')).not.toContain('MANAGE');
    expect(expandAllPrivileges('SCHEMA')).not.toContain('MANAGE');
    expect(expandAllPrivileges('SCHEMA')).not.toContain('EXTERNAL_USE_SCHEMA');
  });

  it('narrows an expanded ALL PRIVILEGES to what the OSS backend implements', () => {
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'admins', privileges: ['ALL PRIVILEGES'] }] },
    ], { oss: true });
    expect(privsOf(out, 'admins')).toEqual(['MODIFY', 'SELECT']);   // no APPLY_TAG on OSS
  });

  it('an ALL PRIVILEGES grant satisfies the usage prerequisites it expands to', () => {
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'admins', privileges: ['ALL PRIVILEGES'] }] },
    ]);
    expect(rowOf(out, 'admins')!.usage!.every((u) => u.status === 'held')).toBe(true);
    expect(rowOf(out, 'admins')!.privileges.every((p) => !isUcPrivilegeBlocked(p))).toBe(true);
  });
});

// ============================================================
// The OSS answer must not claim Databricks-only privileges
// ============================================================

describe('resolveEffectivePermissions — backend vocabulary', () => {
  const chain: UcSecurableNode[] = [
    { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
    { type: 'SCHEMA', name: 'main.sales', assignments: [] },
    { type: 'CATALOG', name: 'main', assignments: [{ principal: 'ops', privileges: ['MANAGE', 'BROWSE', 'APPLY_TAG', 'SELECT', 'USE_CATALOG', 'USE_SCHEMA'] }] },
  ];

  it('never reports MANAGE / BROWSE / APPLY TAG on the OSS backend', () => {
    const out = resolveEffectivePermissions(chain, { oss: true });
    // The Grants pane refuses to GRANT these on OSS (ucPrivilegesFor narrows
    // them out); the effective answer must not claim someone already holds them.
    expect(privsOf(out, 'ops')).toEqual(['SELECT']);
    for (const forbidden of ['MANAGE', 'BROWSE', 'APPLY_TAG']) {
      expect(privsOf(out, 'ops')).not.toContain(forbidden);
    }
  });

  it('DOES report them on the Databricks backend, where they exist', () => {
    expect(privsOf(resolveEffectivePermissions(chain), 'ops')).toEqual(['APPLY_TAG', 'MANAGE', 'SELECT']);
  });

  it('every privilege it can ever report is offerable on that backend — INCLUDING one granted ON the target', () => {
    // Structural guard: the effective answer and the grant checkbox grid read
    // the SAME narrowed vocabulary, so they cannot disagree.
    //
    // ROUND-3 STRENGTHENING. The previous version of this spec only put grants
    // on the CATALOG ancestor plus two owners, so it could not see the leak it
    // was supposed to guard: `resolveEffectivePermissions` narrowed by backend
    // everywhere EXCEPT the distance-0 branch (`if (distance > 0 && !applicable
    // .has(privilege))`), and a grant recorded DIRECTLY on the target was
    // emitted verbatim. On OSS that meant the pane could report MANAGE / BROWSE
    // / APPLY_TAG — the very privileges it refuses to GRANT there and the server
    // cannot enforce. Every privilege Loom models anywhere, plus an unmodelled
    // spelling, is now granted at EVERY distance including 0.
    const everything = [
      ...new Set(Object.values(UC_PRIVILEGES_BY_SECURABLE).flat()),
      'ALL PRIVILEGES', 'DROP DATABASE',
    ];
    for (const oss of [true, false]) {
      const offerable = new Set(ucPrivilegesFor('TABLE', { oss }));
      const out = resolveEffectivePermissions([
        { type: 'TABLE', name: 'main.sales.orders', owner: 'dana', assignments: [{ principal: 'ops', privileges: everything }] },
        { type: 'SCHEMA', name: 'main.sales', assignments: [{ principal: 'ops', privileges: everything }] },
        { type: 'CATALOG', name: 'main', owner: 'platform', assignments: [{ principal: 'ops', privileges: everything }] },
      ], { oss });
      expect(out.length).toBeGreaterThan(0);
      for (const row of out) {
        expect(row.privileges.length).toBeGreaterThan(0);
        for (const p of row.privileges) expect(offerable.has(p.privilege)).toBe(true);
      }
    }
  });

  it('NARROWS a grant recorded DIRECTLY on the target — no distance-0 exemption', () => {
    // The failure mode in prose: the OSS server itself hands back a row saying
    // `ops` holds MANAGE on this table. Loom must not repeat it — that backend
    // has no MANAGE to enforce, and the pane will not offer to grant it either.
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ops', privileges: ['MANAGE', 'BROWSE', 'APPLY_TAG', 'SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [usageGrant('ops')] },
    ], { oss: true });
    expect(privsOf(out, 'ops')).toEqual(['SELECT']);
    for (const forbidden of ['MANAGE', 'BROWSE', 'APPLY_TAG']) {
      expect(privsOf(out, 'ops')).not.toContain(forbidden);
    }
  });

  it('drops an UNMODELLED spelling granted directly on the target instead of passing it through', () => {
    // `DROP DATABASE` is not a Unity Catalog privilege Loom models at any type.
    // It used to be reported as an effective `DROP_DATABASE` with no warning.
    const seen: Array<[string, string]> = [];
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ops', privileges: ['DROP DATABASE', 'SELECT'] }] },
    ], { onNotApplicable: (p, _from, reason) => seen.push([p, reason]) });
    expect(privsOf(out, 'ops')).toEqual(['SELECT']);
    expect(privsOf(out, 'ops')).not.toContain('DROP_DATABASE');
    expect(seen).toEqual([['DROP_DATABASE', 'not-applicable']]);
  });

  it('tells "this backend cannot enforce it" apart from "this type cannot hold it"', () => {
    // Two very different operator messages: one is expected narrowing, the other
    // means the catalog holds a grant nothing will honour.
    const seen: Array<[string, string]> = [];
    resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ops', privileges: ['MANAGE', 'BROWSE'] }] },
    ], { oss: true, onNotApplicable: (p, _f, reason) => seen.push([p, reason]) });
    expect(seen).toEqual([
      ['MANAGE', 'backend-unsupported'],   // modelled at TABLE, absent from OSS
      ['BROWSE', 'not-applicable'],        // never applicable at TABLE at all
    ]);
  });
});

// ============================================================
// Usage prerequisites
// ============================================================

describe('resolveEffectivePermissions — USE CATALOG / USE SCHEMA prerequisites', () => {
  it('marks SELECT as BLOCKED when USE CATALOG is missing', () => {
    // Learn: "Even if a table owner grants SELECT on a table to another user,
    // that user cannot access the table unless they also have USE CATALOG on the
    // parent catalog." An access-review pane that says "can read" here is lying.
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [{ principal: 'ada@contoso.com', privileges: ['USE_SCHEMA'] }] },
      { type: 'CATALOG', name: 'main', assignments: [] },
    ]);
    const select = rowOf(out, 'ada@contoso.com')!.privileges[0];
    expect(select.privilege).toBe('SELECT');
    expect(isUcPrivilegeBlocked(select)).toBe(true);
    expect(select.blocked_by).toEqual(['USE_CATALOG on CATALOG main']);
    expect(rowOf(out, 'ada@contoso.com')!.usage).toEqual([
      { privilege: 'USE_CATALOG', securable_type: 'CATALOG', securable_name: 'main', status: 'missing' },
      { privilege: 'USE_SCHEMA', securable_type: 'SCHEMA', securable_name: 'main.sales', status: 'held', source: 'GRANT', via_principal: 'ada@contoso.com' },
    ]);
  });

  it('does NOT mark it blocked once both usage privileges are held', () => {
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [usageGrant('ada@contoso.com')] },
    ]);
    const select = rowOf(out, 'ada@contoso.com')!.privileges.find((p) => p.privilege === 'SELECT')!;
    expect(isUcPrivilegeBlocked(select)).toBe(false);
    expect(rowOf(out, 'ada@contoso.com')!.usage!.every((u) => u.status === 'held')).toBe(true);
  });

  it('accepts USE SCHEMA inherited from the catalog (it is a container privilege)', () => {
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'ada@contoso.com', privileges: ['USE CATALOG', 'USE SCHEMA'] }] },
    ]);
    const usage = rowOf(out, 'ada@contoso.com')!.usage!;
    expect(usage.find((u) => u.privilege === 'USE_SCHEMA')!.status).toBe('held');
  });

  it('does NOT accept USE CATALOG "inherited" from a schema grant (wrong direction)', () => {
    // USE_CATALOG is not applicable at SCHEMA; a grant there cannot satisfy the
    // catalog-level prerequisite. Accepting it would under-report the block.
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [{ principal: 'ada@contoso.com', privileges: ['USE_CATALOG', 'USE_SCHEMA'] }] },
      { type: 'CATALOG', name: 'main', assignments: [] },
    ]);
    expect(rowOf(out, 'ada@contoso.com')!.usage!.find((u) => u.privilege === 'USE_CATALOG')!.status).toBe('missing');
  });

  it('exempts owners — "Requires usage privileges: Owner → No"', () => {
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', owner: 'dana@contoso.com', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', owner: 'dana@contoso.com', assignments: [] },
    ]);
    expect(rowOf(out, 'dana@contoso.com')!.privileges.every((p) => !isUcPrivilegeBlocked(p))).toBe(true);
    expect(rowOf(out, 'dana@contoso.com')!.usage!.every((u) => u.status === 'held' && u.source === 'OWNERSHIP')).toBe(true);
  });

  it('reports UNKNOWN, not missing, when the anchoring node could not be read', () => {
    // A truthful "I could not check" — asserting `missing` off an unreadable
    // parent would be a false negative on an authorization view.
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [{ principal: 'ada@contoso.com', privileges: ['USE_SCHEMA'] }] },
      { type: 'CATALOG', name: 'main', assignments: [], unreadable: true },
    ]);
    const usage = rowOf(out, 'ada@contoso.com')!.usage!;
    expect(usage.find((u) => u.privilege === 'USE_CATALOG')!.status).toBe('unknown');
    expect(isUcPrivilegeBlocked(rowOf(out, 'ada@contoso.com')!.privileges[0])).toBe(false);
  });

  it('reports UNKNOWN when the name was too partial to identify the parents', () => {
    const chain: UcSecurableNode[] = ucSecurableChain('TABLE', 'orders')
      .map((r) => ({ ...r, assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] }));
    const usage = rowOf(resolveEffectivePermissions(chain), 'ada@contoso.com')!.usage!;
    expect(usage.map((u) => u.status)).toEqual(['unknown', 'unknown']);
  });

  it('never blocks the usage privileges themselves (they ARE the remediation)', () => {
    const out = resolveEffectivePermissions([
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT', 'USE_SCHEMA'] }] },
    ]);
    const row = rowOf(out, 'ada@contoso.com')!;
    expect(row.usage).toEqual([{ privilege: 'USE_CATALOG', securable_type: 'CATALOG', securable_name: 'main', status: 'missing' }]);
    expect(row.privileges.find((p) => p.privilege === 'SELECT')!.blocked_by).toEqual(['USE_CATALOG on CATALOG main']);
    expect(row.privileges.find((p) => p.privilege === 'USE_SCHEMA')!.blocked_by).toBeUndefined();
  });
});

// ============================================================
// ROUND-3: the usage checker must not assert a negative it never verified.
//
// `evaluateUsage` is called with `identities = closure ?? new Set([row label])`.
// In the two states the pane is in MOST often — the unfiltered Grants view (no
// closure exists for anybody) and the filtered view with Microsoft Graph
// unavailable (the "closure" collapses to `[principal]`) — that set is NOT the
// set of names the principal answers to. Reporting `missing` off it produced a
// red "SELECT (BLOCKED — needs USE_CATALOG on CATALOG main)" for a principal who
// could in fact read the table, because a GROUP held the usage grant.
// ============================================================

describe('resolveEffectivePermissions — usage prerequisites when membership is UNKNOWN', () => {
  /** SELECT granted to ada on the table; the usage grants held by a GROUP. */
  const groupHoldsUsage: UcSecurableNode[] = [
    { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
    { type: 'SCHEMA', name: 'main.sales', assignments: [] },
    { type: 'CATALOG', name: 'main', assignments: [{ principal: 'analysts', privileges: ['USE_CATALOG', 'USE_SCHEMA'] }] },
  ];

  it('UNFILTERED: says UNKNOWN, not missing, when a group could hold the prerequisite', () => {
    const ada = rowOf(resolveEffectivePermissions(groupHoldsUsage), 'ada@contoso.com')!;
    expect(ada.usage!.map((u) => `${u.privilege}:${u.status}`))
      .toEqual(['USE_CATALOG:unknown', 'USE_SCHEMA:unknown']);
    // …and therefore SELECT must NOT be reported blocked.
    const select = ada.privileges.find((p) => p.privilege === 'SELECT')!;
    expect(select.blocked_by).toBeUndefined();
    expect(isUcPrivilegeBlocked(select)).toBe(false);
  });

  it('UNFILTERED: still says MISSING when NOBODY holds it — that negative IS verified', () => {
    // No membership can supply a grant that does not exist anywhere on the
    // chain, so the block is a fact and must still be reported. (Downgrading
    // everything to `unknown` would make the whole check useless.)
    const nobodyHoldsUsage: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [{ principal: 'ada@contoso.com', privileges: ['USE_SCHEMA'] }] },
      // A grant exists here, but not of the privilege under test.
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'auditors', privileges: ['BROWSE'] }] },
    ];
    const ada = rowOf(resolveEffectivePermissions(nobodyHoldsUsage), 'ada@contoso.com')!;
    expect(ada.usage!.find((u) => u.privilege === 'USE_CATALOG')!.status).toBe('missing');
    expect(ada.privileges.find((p) => p.privilege === 'SELECT')!.blocked_by)
      .toEqual(['USE_CATALOG on CATALOG main']);
  });

  it('UNFILTERED: an OWNER that is not this principal also makes the answer UNKNOWN', () => {
    // The owner may itself be a group ada belongs to; owners are usage-exempt,
    // so ownership is a live route to the prerequisite.
    const ownedElsewhere: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', owner: 'platform-admins', assignments: [] },
    ];
    const ada = rowOf(resolveEffectivePermissions(ownedElsewhere), 'ada@contoso.com')!;
    expect(ada.usage!.every((u) => u.status === 'unknown')).toBe(true);
    expect(isUcPrivilegeBlocked(ada.privileges[0])).toBe(false);
  });

  it('FILTERED with Graph DOWN (closureResolved:false): UNKNOWN, not a fabricated block', () => {
    // The live adapter reports `closure_resolved:false` and the empty state was
    // already taught to soften its claim; the usage checker must agree with it
    // instead of simultaneously stating the privilege is categorically missing.
    const ada = rowOf(resolveEffectivePermissions(groupHoldsUsage, {
      principal: 'ada@contoso.com',
      principalClosure: ['ada@contoso.com'],   // Graph never answered
      closureResolved: false,
    }), 'ada@contoso.com')!;
    expect(ada.usage!.every((u) => u.status === 'unknown')).toBe(true);
    expect(ada.privileges.find((p) => p.privilege === 'SELECT')!.blocked_by).toBeUndefined();
  });

  it('FILTERED with the closure RESOLVED and the holder OUTSIDE it: MISSING is stated', () => {
    // Now the negative is verified — every name ada answers to is enumerated and
    // none of them is `analysts`. This is the assertion that proves the fix is
    // not just "always answer unknown".
    const ada = rowOf(resolveEffectivePermissions(groupHoldsUsage, {
      principal: 'ada@contoso.com',
      principalClosure: ['ada@contoso.com', 'archivists'],
      closureResolved: true,
    }), 'ada@contoso.com')!;
    expect(ada.usage!.find((u) => u.privilege === 'USE_CATALOG')!.status).toBe('missing');
    expect(ada.privileges.find((p) => p.privilege === 'SELECT')!.blocked_by)
      .toEqual(['USE_CATALOG on CATALOG main', 'USE_SCHEMA on SCHEMA main.sales']);
  });

  it('FILTERED with the closure RESOLVED and the holder INSIDE it: HELD via that group', () => {
    const ada = rowOf(resolveEffectivePermissions(groupHoldsUsage, {
      principal: 'ada@contoso.com',
      principalClosure: ['ada@contoso.com', 'analysts'],
      closureResolved: true,
    }), 'ada@contoso.com')!;
    expect(ada.usage!.every((u) => u.status === 'held')).toBe(true);
    expect(ada.usage!.find((u) => u.privilege === 'USE_CATALOG')!.via_principal).toBe('analysts');
    expect(ada.privileges.find((p) => p.privilege === 'SELECT')!.blocked_by).toBeUndefined();
  });

  it('a MANAGE usage grant the OSS backend cannot enforce never counts as held', () => {
    // Same unconditional-narrowing rule inside the prerequisite probe: a grant
    // this backend does not implement is not a route to anything.
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT'] }] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [{ principal: 'ada@contoso.com', privileges: ['MANAGE'] }] },
    ], { oss: true, principal: 'ada@contoso.com', principalClosure: ['ada@contoso.com'], closureResolved: true });
    const ada = rowOf(out, 'ada@contoso.com')!;
    expect(privsOf(out, 'ada@contoso.com')).not.toContain('MANAGE');
    expect(ada.usage!.find((u) => u.privilege === 'USE_CATALOG')!.status).toBe('missing');
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

  it('terminates on a SELF-cycle and on a cycle back to the root', async () => {
    const calls: string[] = [];
    const { closure } = await expandPrincipalClosure('a', async (p) => {
      calls.push(p);
      return p === 'a' ? ['a', 'b'] : ['a'];    // a ∈ a, a ∈ b, b ∈ a
    });
    expect(closure).toEqual(['a', 'b']);
    expect(calls).toEqual(['a', 'b']);
  });

  it('a CYCLE does not smuggle extra principals\' privileges into the answer', async () => {
    // The security half of the cycle case: terminating is not enough — the
    // closure must still be exactly {a, b}, not everything the walk touched.
    const { closure } = await expandPrincipalClosure('a', async (p) => (p === 'a' ? ['b'] : ['a']));
    const chain: UcSecurableNode[] = [
      { type: 'TABLE', name: 'main.sales.orders', assignments: [
        { principal: 'b', privileges: ['SELECT'] },
        { principal: 'c', privileges: ['MODIFY'] },
      ] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [usageGrant('a')] },
    ];
    const out = resolveEffectivePermissions(chain, { principal: 'a', principalClosure: closure });
    expect(privsOf(out, 'a')).toEqual(['SELECT']);        // via b
    expect(privsOf(out, 'a')).not.toContain('MODIFY');    // c is NOT in the closure
  });

  it('is case-insensitive about membership identity (no duplicate hops)', async () => {
    const { closure } = await expandPrincipalClosure('ada@contoso.com', async (p) =>
      p === 'ada@contoso.com' ? ['Analysts', 'ANALYSTS', 'analysts'] : []);
    expect(closure).toEqual(['ada@contoso.com', 'Analysts']);
  });

  it('flags truncation instead of silently returning a subset', async () => {
    const deep = async (p: string) => [`g${Number(p.replace('g', '') || 0) + 1}`];
    const { truncated } = await expandPrincipalClosure('g0', deep, { maxDepth: 3 });
    expect(truncated).toBe(true);
  });

  it('stops on the wall clock and says so (a slow directory cannot pin the BFF)', async () => {
    let t = 0;
    const { truncated, closure } = await expandPrincipalClosure('g0', async (p) => {
      t += 5_000;                                       // each level "takes" 5s
      return [`${p}-child`];
    }, { deadlineMs: 8_000, now: () => t });
    expect(truncated).toBe(true);
    expect(closure.length).toBeLessThan(5);
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
    { type: 'CATALOG', name: 'main', owner: 'platform-admins', assignments: [
      { principal: 'someone-else', privileges: ['SELECT', 'MODIFY'] },
      usageGrant('ada@contoso.com'),
    ] },
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
    expect(isUcPrivilegeRevocableHere(select)).toBe(false);
    // The direct grant is NOT attributed to a group, and IS revocable here.
    const modify = out[0].privileges.find((p) => p.privilege === 'MODIFY')!;
    expect(modify.via_principal).toBeUndefined();
    expect(isUcPrivilegeRevocableHere(modify)).toBe(true);
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

  it('a group in the closure does NOT drag in another group\'s grants', () => {
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [
        { principal: 'analysts', privileges: ['SELECT'] },
        { principal: 'engineers', privileges: ['MODIFY'] },
        { principal: 'analysts-archive', privileges: ['APPLY_TAG'] },   // prefix collision
      ] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', assignments: [usageGrant('analysts')] },
    ], { principal: 'ada@contoso.com', principalClosure: ['ada@contoso.com', 'analysts'] });
    expect(privsOf(out, 'ada@contoso.com')).toEqual(['SELECT']);
    expect(privsOf(out, 'ada@contoso.com')).not.toContain('MODIFY');
    expect(privsOf(out, 'ada@contoso.com')).not.toContain('APPLY_TAG');
  });

  it('honours ownership held by a GROUP the principal belongs to — but only MANAGE', () => {
    const out = resolveEffectivePermissions(chain, {
      principal: 'ada@contoso.com',
      principalClosure: ['ada@contoso.com', 'platform-admins'],
    });
    // platform-admins owns the CATALOG, so on this TABLE that is MANAGE only.
    expect(privsOf(out, 'ada@contoso.com')).toEqual(['MANAGE', 'MODIFY']);
    expect(out[0].privileges.find((p) => p.privilege === 'MANAGE')).toMatchObject({
      source: 'OWNERSHIP', via_principal: 'platform-admins', inherited_from_type: 'CATALOG',
    });
    expect(privsOf(out, 'ada@contoso.com')).not.toContain('SELECT');
  });

  it('returns nothing (not everything) for a principal with no access', () => {
    expect(resolveEffectivePermissions(chain, { principal: 'nobody@contoso.com' })).toEqual([]);
  });

  it('a principal outside every group sees NONE of another principal\'s privileges', () => {
    const out = resolveEffectivePermissions(chain, {
      principal: 'mallory@contoso.com',
      principalClosure: ['mallory@contoso.com'],
    });
    expect(out).toEqual([]);
  });
});

describe('formatUcPrivilege / structured provenance helpers', () => {
  it('renders plain, inherited, owned, expanded and blocked provenance distinctly', () => {
    expect(formatUcPrivilege('USE CATALOG')).toBe('USE_CATALOG');
    expect(formatUcPrivilege({ privilege: 'SELECT' })).toBe('SELECT');
    expect(formatUcPrivilege({ privilege: 'SELECT', inherited_from_type: 'CATALOG', inherited_from_name: 'main' }))
      .toBe('SELECT (inherited from CATALOG main)');
    expect(formatUcPrivilege({ privilege: 'MANAGE', source: 'OWNERSHIP' })).toBe('MANAGE (owner)');
    expect(formatUcPrivilege({ privilege: 'MANAGE', source: 'OWNERSHIP', inherited_from_type: 'SCHEMA', inherited_from_name: 'main.sales' }))
      .toBe('MANAGE (inherited: owner of SCHEMA main.sales)');
    expect(formatUcPrivilege({ privilege: 'SELECT', inherited_from_type: 'SCHEMA', inherited_from_name: 'main.sales', via_principal: 'analysts' }))
      .toBe('SELECT (inherited from SCHEMA main.sales, via analysts)');
    expect(formatUcPrivilege({ privilege: 'SELECT', implied_by: 'ALL_PRIVILEGES' }))
      .toBe('SELECT (from ALL PRIVILEGES)');
    expect(formatUcPrivilege({ privilege: 'SELECT', blocked_by: ['USE_CATALOG on CATALOG main'] }))
      .toBe('SELECT (BLOCKED — needs USE_CATALOG on CATALOG main)');
  });

  it('decides revocability from the STRUCTURE, not from the display text', () => {
    // The old regex classified `SELECT (via analysts)` as revocable here, which
    // would have issued the REVOKE against the queried principal rather than the
    // group that actually holds the grant. And a securable literally named
    // `owner` used to mis-tint.
    expect(isUcPrivilegeRevocableHere({ privilege: 'SELECT' })).toBe(true);
    expect(isUcPrivilegeRevocableHere({ privilege: 'SELECT', via_principal: 'analysts' })).toBe(false);
    expect(isUcPrivilegeRevocableHere({ privilege: 'SELECT', inherited_from_type: 'CATALOG', inherited_from_name: 'owner' })).toBe(false);
    expect(isUcPrivilegeRevocableHere({ privilege: 'MANAGE', source: 'OWNERSHIP' })).toBe(false);
    // …and the display string for that securable no longer decides anything.
    expect(formatUcPrivilege({ privilege: 'SELECT', inherited_from_type: 'CATALOG', inherited_from_name: 'owner' }))
      .toBe('SELECT (inherited from CATALOG owner)');
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
    expect(expandAllPrivileges('PIPELINE')).toEqual([]);
  });

  it('normalizes spelling from both servers', () => {
    expect(normalizeUcPrivilege('use  catalog')).toBe('USE_CATALOG');
    expect(normalizeUcPrivilege(' select ')).toBe('SELECT');
    expect(normalizeUcPrivilege('ALL PRIVILEGES')).toBe('ALL_PRIVILEGES');
  });
});

describe('client-safety of the pure model', () => {
  it('has no VALUE import (it is imported by a client component)', () => {
    // `app/catalog/unity/page.tsx` is 'use client' and imports this module. The
    // single edge to unity-catalog-client MUST stay `import type` — a value
    // import would pull @azure/identity + AcaManagedIdentityCredential into the
    // browser bundle. This spec is the guard; there is no CI rule for it.
    const src = readFileSync(join(__dirname, '..', 'uc-effective-permissions.ts'), 'utf8');
    const imports = src.match(/^import[^\n]*from\s+'[^']+';/gm) || [];
    expect(imports.length).toBeGreaterThan(0);
    for (const imp of imports) expect(imp.startsWith('import type')).toBe(true);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/process\.env/);
  });
});
