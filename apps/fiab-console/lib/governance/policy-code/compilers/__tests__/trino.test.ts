/**
 * LU-7 — Trino engine-authorization compiler tests.
 *
 * These assert the SECURITY-MATERIAL properties, not just that strings are
 * produced:
 *
 *   1. Rule ORDER is the control. Trino evaluates `tables` first-match-wins and
 *      denies an unmatched table, so a deny must precede a grant and a
 *      row-filtered grant must precede a plain one.
 *   2. Adding one governed table must NEVER lock the rest of the estate (the
 *      global allow tail) — that would be a self-inflicted outage.
 *   3. A governed table must be deny-by-default for principals it did not
 *      grant (the per-table catch-all).
 *   4. Identifiers and literals reaching the engine are escaped, and principal
 *      selectors are ANCHORED regexes so `sales` cannot also match `sales_pii`.
 *   5. A group principal with no published group provider is WARNED about, not
 *      silently treated as enforced.
 */

import { describe, it, expect } from 'vitest';
import {
  compileTrino,
  buildTrinoRulesDocument,
  buildTrinoRego,
  buildTrinoGroupFile,
  parseTrinoObject,
  daxFilterToTrinoSql,
  regexLiteral,
  trinoIdent,
  trinoString,
  rulesVersion,
  trinoGroupPrincipals,
  type TrinoTableRule,
} from '../trino';
import { normalizePolicyCodeSet, validatePolicyCodeSet, POLICY_BACKENDS, BACKEND_LABELS } from '../../dsl';
import { compileAll } from '../../compile';

const GROUP_OID = '11111111-2222-3333-4444-555555555555';

function setOf(statements: any[]) {
  return normalizePolicyCodeSet({ apiVersion: 'loom.governance/v1', name: 'test', statements });
}

const READ_ANALYSTS = {
  id: 'analysts-read',
  principals: [{ kind: 'group', id: GROUP_OID, name: 'Data Analysts' }],
  resources: [{ backend: 'trino', object: 'iceberg.sales.orders' }],
  actions: ['read'],
};

const DENY_CONTRACTORS = {
  id: 'contractors-deny',
  principals: [{ kind: 'group', id: '99999999-0000-0000-0000-000000000000', name: 'Contractors' }],
  resources: [{ backend: 'trino', object: 'iceberg.sales.orders' }],
  actions: ['deny'],
};

const FILTERED_REGIONAL = {
  id: 'regional-rls',
  principals: [{ kind: 'user', id: 'u-1', name: 'alice@contoso.com' }],
  resources: [{ backend: 'trino', object: 'iceberg.sales.orders' }],
  actions: ['read'],
  condition: { rowFilter: '[Region] = USERPRINCIPALNAME()', maskColumns: ['ssn'] },
};

describe('trino compiler — DSL registration', () => {
  it('registers `trino` as a first-class policy backend with a label', () => {
    expect(POLICY_BACKENDS).toContain('trino');
    expect(BACKEND_LABELS.trino).toMatch(/Trino/i);
  });

  it('treats trino as a backend that ENFORCES row filters / column masks', () => {
    // Before LU-7 a filter targeting only trino warned "no backend enforces it".
    const v = validatePolicyCodeSet(setOf([FILTERED_REGIONAL]));
    expect(v.warnings.join(' ')).not.toMatch(/no resource targets a backend that enforces it/);
  });

  it('compileAll emits a trino artifact in the one-pass compile', () => {
    const res = compileAll(setOf([READ_ANALYSTS]));
    expect(res.compiledBackends).toContain('trino');
    expect(res.artifacts.find((a) => a.backend === 'trino')?.ops.length).toBe(1);
  });
});

describe('trino compiler — object parsing', () => {
  it('parses catalog.schema.table', () => {
    expect(parseTrinoObject('pg.public.customers', 'iceberg').ref).toEqual({
      catalog: 'pg', schema: 'public', table: 'customers',
    });
  });

  it('resolves a 2-part reference against the lake catalog, and SAYS SO', () => {
    const { ref, warning } = parseTrinoObject('sales.orders', 'iceberg');
    expect(ref).toEqual({ catalog: 'iceberg', schema: 'sales', table: 'orders' });
    expect(warning).toMatch(/2-part/);
  });

  it('REFUSES a 1-part reference rather than widening it to a wildcard', () => {
    const { ref, warning } = parseTrinoObject('orders', 'iceberg');
    expect(ref).toBeNull();
    expect(warning).toMatch(/never widened to a wildcard/);
  });
});

describe('trino compiler — escaping and anchoring', () => {
  it('anchors principal + table selectors so a prefix cannot match a sibling', () => {
    const rx = regexLiteral('sales');
    expect(rx).toBe('^sales$');
    expect(new RegExp(rx).test('sales_pii')).toBe(false);
    expect(new RegExp(rx).test('sales')).toBe(true);
  });

  it('escapes regex metacharacters in an object name', () => {
    const rx = regexLiteral('a.b*c');
    expect(new RegExp(rx).test('axbxc')).toBe(false);
    expect(new RegExp(rx).test('a.b*c')).toBe(true);
  });

  it('escapes Trino identifiers and string literals', () => {
    expect(trinoIdent('we"ird')).toBe('"we""ird"');
    expect(trinoString("O'Brien")).toBe("'O''Brien'");
  });

  it('translates a DAX row filter to a Trino predicate using current_user', () => {
    const tr = daxFilterToTrinoSql('[Region] = USERPRINCIPALNAME()');
    expect(tr.sql).toBe('"Region" = current_user');
    expect(tr.columns).toEqual(['Region']);
  });
});

describe('trino compiler — ops', () => {
  it('emits a read grant rule with SELECT only', () => {
    const art = compileTrino(setOf([READ_ANALYSTS]), { trinoGroupProvider: true });
    expect(art.applicable).toBe(true);
    const rule = JSON.parse(art.ops[0].statement) as TrinoTableRule;
    expect(rule.privileges).toEqual(['SELECT']);
    expect(rule.group).toBe('^Data_Analysts$');
    expect(rule.catalog).toBe('^iceberg$');
    expect(rule.table).toBe('^orders$');
  });

  it('emits an explicit deny as a ZERO-privilege rule', () => {
    const art = compileTrino(setOf([DENY_CONTRACTORS]), { trinoGroupProvider: true });
    const rule = JSON.parse(art.ops[0].statement) as TrinoTableRule;
    expect(rule.privileges).toEqual([]);
    expect(art.ops[0].kind).toBe('deny');
  });

  it('emits the row filter AND the column mask on the grant rule', () => {
    const art = compileTrino(setOf([FILTERED_REGIONAL]));
    const rule = JSON.parse(art.ops[0].statement) as TrinoTableRule;
    expect(rule.filter).toBe('"Region" = current_user');
    expect(rule.columns).toEqual([{ name: 'ssn', mask: 'NULL' }]);
    // The UPN's `.` is regex-escaped, so `aliceXcontoso.com` cannot match.
    expect(rule.user).toBe('^alice@contoso\\.com$');
    expect(new RegExp(rule.user!).test('aliceXcontosoXcom')).toBe(false);
  });

  it('WARNS (does not silently claim enforcement) for a group with no group provider', () => {
    const art = compileTrino(setOf([READ_ANALYSTS]), { trinoGroupProvider: false });
    expect(art.warnings.join(' ')).toMatch(/no Trino group provider is published/);
  });

  it('does not warn about groups once the group provider is published', () => {
    const art = compileTrino(setOf([READ_ANALYSTS]), { trinoGroupProvider: true });
    expect(art.warnings.join(' ')).not.toMatch(/group provider/);
  });

  it('ignores resources for other backends', () => {
    const art = compileTrino(setOf([{
      id: 's', principals: [{ kind: 'user', id: 'u', name: 'a@b.c' }],
      resources: [{ backend: 'synapse', object: 'dbo.t' }], actions: ['read'],
    }]));
    expect(art.applicable).toBe(false);
    expect(art.ops).toEqual([]);
  });
});

describe('trino rules document — ordering IS the control', () => {
  const art = compileTrino(setOf([READ_ANALYSTS, DENY_CONTRACTORS, FILTERED_REGIONAL]), { trinoGroupProvider: true });
  const doc = buildTrinoRulesDocument(art, {
    catalogs: [{ name: 'iceberg', allow: 'read-only' }, { name: 'memory', allow: 'all' }],
  });
  const idx = (pred: (r: TrinoTableRule) => boolean) => doc.tables.findIndex(pred);

  it('puts the explicit DENY before any grant on the same table', () => {
    const denyAt = idx((r) => r.privileges.length === 0 && r.group === '^Contractors$');
    const grantAt = idx((r) => r.group === '^Data_Analysts$');
    expect(denyAt).toBeGreaterThanOrEqual(0);
    expect(grantAt).toBeGreaterThanOrEqual(0);
    expect(denyAt).toBeLessThan(grantAt);
  });

  it('puts the row-filtered/masked grant before the unrestricted grant', () => {
    const filteredAt = idx((r) => Boolean(r.filter));
    const plainAt = idx((r) => r.group === '^Data_Analysts$' && !r.filter);
    expect(filteredAt).toBeLessThan(plainAt);
  });

  it('makes a GOVERNED table deny-by-default for anyone not granted', () => {
    // The per-table catch-all must exist and must sit AFTER the grants.
    const catchAllAt = idx(
      (r) => r.privileges.length === 0 && r.table === '^orders$' && !r.group && !r.user,
    );
    const grantAt = idx((r) => r.group === '^Data_Analysts$');
    expect(catchAllAt).toBeGreaterThan(grantAt);
  });

  it('does NOT lock the rest of the estate — an ungoverned table keeps working', () => {
    const tail = doc.tables[doc.tables.length - 1];
    expect(tail.privileges).toContain('SELECT');
    expect(tail.catalog).toBeUndefined();
    expect(tail.table).toBeUndefined();
  });

  it('preserves the engine catalog floor and denies any un-wired catalog', () => {
    expect(doc.catalogs.find((c) => c.catalog === '^iceberg$')?.allow).toBe('read-only');
    expect(doc.catalogs[doc.catalogs.length - 1]).toEqual({ catalog: '.*', allow: 'none' });
  });

  it('emits the impersonation rule that lets the BFF present the real principal', () => {
    expect(doc.impersonation).toEqual([
      { original_user: '^loom-console$', new_user: '.*', allow: true },
    ]);
  });

  it('honours a non-default mapped session user in the impersonation rule', () => {
    const d = buildTrinoRulesDocument(art, { trinoSessionUser: 'svc-loom' });
    expect(d.impersonation[0].original_user).toBe('^svc-loom$');
  });

  it('produces a stable content version that changes with the document', () => {
    const a = rulesVersion(doc);
    expect(a).toBe(rulesVersion(buildTrinoRulesDocument(art, {
      catalogs: [{ name: 'iceberg', allow: 'read-only' }, { name: 'memory', allow: 'all' }],
    })));
    const other = buildTrinoRulesDocument(compileTrino(setOf([READ_ANALYSTS]), { trinoGroupProvider: true }), {});
    expect(rulesVersion(other)).not.toBe(a);
  });

  it('an EMPTY policy set still yields a usable, non-locking document', () => {
    const empty = buildTrinoRulesDocument(compileTrino(setOf([])), {
      catalogs: [{ name: 'iceberg', allow: 'read-only' }],
    });
    // Only the global allow tail — nothing is governed, so nothing is denied.
    expect(empty.tables).toHaveLength(1);
    expect(empty.tables[0].privileges).toContain('SELECT');
  });
});

describe('trino group file', () => {
  it('renders groupname:member,member for trino group principals', () => {
    const set = setOf([READ_ANALYSTS]);
    expect(trinoGroupPrincipals(set).map((p) => p.id)).toEqual([GROUP_OID]);
    const file = buildTrinoGroupFile(set, { [GROUP_OID]: ['a@contoso.com', 'b@contoso.com'] });
    expect(file).toBe('Data_Analysts:a@contoso.com,b@contoso.com\n');
  });

  it('emits an EMPTY group (matches nobody) rather than omitting an unresolved group', () => {
    const file = buildTrinoGroupFile(setOf([READ_ANALYSTS]), {});
    expect(file).toBe('Data_Analysts:\n');
  });

  it('ignores group principals that do not target the trino backend', () => {
    const file = buildTrinoGroupFile(setOf([{
      id: 's', principals: [{ kind: 'group', id: GROUP_OID, name: 'G' }],
      resources: [{ backend: 'adx', object: 'db/t' }], actions: ['read'],
    }]), { [GROUP_OID]: ['a@b.c'] });
    expect(file).toBe('');
  });
});

describe('trino OPA rego', () => {
  const rego = buildTrinoRego(setOf([READ_ANALYSTS, DENY_CONTRACTORS, FILTERED_REGIONAL]));

  it('declares the package + deny-by-default the OPA authorizer expects', () => {
    expect(rego).toContain('package trino');
    expect(rego).toContain('default allow := false');
  });

  it('reads the caller from the documented Trino OPA input contract', () => {
    expect(rego).toContain('input.context.identity.user');
    expect(rego).toContain('input.context.identity, "groups"');
    expect(rego).toContain('input.action.resource.table');
  });

  it('lists the governed tables and leaves ungoverned tables allowed', () => {
    expect(rego).toContain('"iceberg.sales.orders"');
    expect(rego).toContain('not governed[table_fqn]');
  });

  it('emits rowFilters and columnMask in the shapes Trino expects', () => {
    expect(rego).toContain('rowFilters contains {"expression": r.expression}');
    expect(rego).toContain('columnMask := {"expression": "NULL"}');
    // The predicate is embedded as a rego STRING, so its Trino double-quoted
    // identifier is JSON-escaped — that escaping is what keeps a column name
    // containing a quote from breaking out of the literal.
    expect(rego).toContain('"expression": "\\"Region\\" = current_user"');
  });

  it('carries the deny so a denied principal cannot be allowed by another grant', () => {
    expect(rego).toContain('not denied_for_caller(table_fqn)');
    expect(rego).toContain('"deny": true');
  });

  it('is deterministic for the same input', () => {
    expect(buildTrinoRego(setOf([READ_ANALYSTS]))).toBe(buildTrinoRego(setOf([READ_ANALYSTS])));
  });
});
