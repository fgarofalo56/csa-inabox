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

  it('emits the row filter and each column mask as SEPARATE, distinctly-keyed ops', () => {
    // Deliberately NOT folded into the grant op: a shared key would let
    // first-wins dedupe discard one statement's filter/mask entirely. The
    // document builder merges them back into one rule (Trino is
    // first-match-wins), which the merge tests below cover.
    const art = compileTrino(setOf([FILTERED_REGIONAL]));
    const byKind = (k: string) => art.ops.filter((o) => o.kind === k);
    expect(byKind('grant')).toHaveLength(1);
    expect(byKind('rls')).toHaveLength(1);
    expect(byKind('mask')).toHaveLength(1);

    const grant = JSON.parse(byKind('grant')[0].statement) as TrinoTableRule;
    expect(grant.privileges).toEqual(['SELECT']);
    // The UPN's `.` is regex-escaped, so `aliceXcontoso.com` cannot match.
    expect(grant.user).toBe('^alice@contoso\\.com$');
    expect(new RegExp(grant.user!).test('aliceXcontosoXcom')).toBe(false);

    expect((JSON.parse(byKind('rls')[0].statement) as TrinoTableRule).filter).toBe('"Region" = current_user');
    expect((JSON.parse(byKind('mask')[0].statement) as TrinoTableRule).columns).toEqual([{ name: 'ssn', mask: 'NULL' }]);
  });

  it('merges them onto ONE rule in the document, where Trino can enforce them', () => {
    const doc = buildTrinoRulesDocument(compileTrino(setOf([FILTERED_REGIONAL])), {});
    const rule = doc.tables.find((r) => r.user === '^alice@contoso\\.com$')!;
    expect(rule.privileges).toEqual(['SELECT']);
    expect(rule.filter).toBe('"Region" = current_user');
    expect(rule.columns).toEqual([{ name: 'ssn', mask: 'NULL' }]);
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

  it('emits an impersonation rule per policy-named user, never a wildcard', () => {
    // FILTERED_REGIONAL is the only user-principal statement in this set.
    expect(doc.impersonation).toEqual([
      { original_user: '^loom-console$', new_user: '^alice@contoso\\.com$', allow: true },
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

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION — dedupe must never destroy a narrower policy.
//
// `dedupeOps` is FIRST-WINS. The original compiler keyed every grant as
// `trino:${action}:${target}:${p.id}` — no statement id — and folded the row
// filter and the column masks INTO that same op. So two statements over the
// same (principal, table, action) collided, and if the UNCONDITIONAL one was
// authored first it silently discarded the filtered one's filter AND mask
// before the document was ever built. The user got unfiltered, unmasked SELECT.
// No attacker required; ordering-is-the-control was defeated upstream of
// ordering. Every sibling compiler already carried `stmt.id` in its key.
// ─────────────────────────────────────────────────────────────────────────────
describe('trino compiler — two statements over the same (principal, table, action)', () => {
  const OPEN_FIRST = {
    id: 'a-open',
    principals: [{ kind: 'user', id: 'u-1', name: 'alice@contoso.com' }],
    resources: [{ backend: 'trino', object: 'iceberg.sales.orders' }],
    actions: ['read'],
  };
  const NARROWED_SECOND = {
    id: 'b-narrowed',
    principals: [{ kind: 'user', id: 'u-1', name: 'alice@contoso.com' }],
    resources: [{ backend: 'trino', object: 'iceberg.sales.orders' }],
    actions: ['read'],
    condition: { rowFilter: '[Region] = USERPRINCIPALNAME()', maskColumns: ['ssn'] },
  };

  it('keeps BOTH statements as distinct ops (the key carries the statement id)', () => {
    const art = compileTrino(setOf([OPEN_FIRST, NARROWED_SECOND]), { trinoGroupProvider: true });
    const keys = art.ops.map((o) => o.key);
    expect(keys).toContain('trino:grant:read:iceberg.sales.orders:u-1:a-open');
    expect(keys).toContain('trino:grant:read:iceberg.sales.orders:u-1:b-narrowed');
    expect(keys).toContain('trino:rls:iceberg.sales.orders:u-1:b-narrowed');
    expect(keys).toContain('trino:mask:iceberg.sales.orders:ssn:u-1:b-narrowed');
    // No two ops may share a key, or dedupe would drop one of them.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the FILTER survives even when the unconditional grant is authored first', () => {
    const doc = buildTrinoRulesDocument(compileTrino(setOf([OPEN_FIRST, NARROWED_SECOND]), { trinoGroupProvider: true }), {});
    const rule = doc.tables.find((r) => r.user === '^alice@contoso\\.com$');
    expect(rule).toBeDefined();
    expect(rule!.filter).toBe('"Region" = current_user');
  });

  it('the MASK survives even when the unconditional grant is authored first', () => {
    const doc = buildTrinoRulesDocument(compileTrino(setOf([OPEN_FIRST, NARROWED_SECOND]), { trinoGroupProvider: true }), {});
    const rule = doc.tables.find((r) => r.user === '^alice@contoso\\.com$');
    expect(rule!.columns).toEqual([{ name: 'ssn', mask: 'NULL' }]);
  });

  it('holds in EITHER authoring order — the result must not depend on it', () => {
    for (const stmts of [[OPEN_FIRST, NARROWED_SECOND], [NARROWED_SECOND, OPEN_FIRST]]) {
      const doc = buildTrinoRulesDocument(compileTrino(setOf(stmts), { trinoGroupProvider: true }), {});
      const rule = doc.tables.find((r) => r.user === '^alice@contoso\\.com$');
      expect(rule!.filter).toBe('"Region" = current_user');
      expect(rule!.columns).toEqual([{ name: 'ssn', mask: 'NULL' }]);
    }
  });

  it('merges into ONE rule — a second rule for the same selector is unreachable', () => {
    // Trino is first-match-wins, so splitting the filter into its own rule
    // would mean it never applies. The merge is what makes it enforceable.
    const doc = buildTrinoRulesDocument(compileTrino(setOf([OPEN_FIRST, NARROWED_SECOND]), { trinoGroupProvider: true }), {});
    const forAlice = doc.tables.filter((r) => r.user === '^alice@contoso\\.com$');
    expect(forAlice).toHaveLength(1);
    expect(forAlice[0].privileges).toEqual(['SELECT']);
  });

  it('ANDs multiple row filters rather than keeping only the first', () => {
    const second = { ...NARROWED_SECOND, id: 'c-second-filter', condition: { rowFilter: '[Tier] = "gold"' } };
    const doc = buildTrinoRulesDocument(compileTrino(setOf([NARROWED_SECOND, second]), { trinoGroupProvider: true }), {});
    const rule = doc.tables.find((r) => r.user === '^alice@contoso\\.com$');
    expect(rule!.filter).toBe('("Region" = current_user) AND ("Tier" = \'gold\')');
  });

  it('unions masked columns from different statements', () => {
    const second = { ...NARROWED_SECOND, id: 'c-second-mask', condition: { maskColumns: ['dob'] } };
    const doc = buildTrinoRulesDocument(compileTrino(setOf([NARROWED_SECOND, second]), { trinoGroupProvider: true }), {});
    const rule = doc.tables.find((r) => r.user === '^alice@contoso\\.com$');
    expect(rule!.columns!.map((c) => c.name).sort()).toEqual(['dob', 'ssn']);
  });

  it('unions privileges when one statement grants read and another write', () => {
    const writer = { ...OPEN_FIRST, id: 'd-write', actions: ['write'] };
    const doc = buildTrinoRulesDocument(compileTrino(setOf([OPEN_FIRST, writer]), { trinoGroupProvider: true }), {});
    const rule = doc.tables.find((r) => r.user === '^alice@contoso\\.com$');
    expect(rule!.privileges.sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION — the enforcement receipt must be able to read "enforcing".
//
// The publisher (reconcile) has NO engine catalog list; the fetch path ALWAYS
// has one (the entrypoint sends at least `system,`). Hashing the whole document
// therefore made the two sides deterministically unequal forever: the status
// was permanently `stale`, reconcile could never report applied, and the detail
// string blamed an unreachable Console while the engine fetched successfully
// every 60s — a false cause, the deploy-integrity R7 class.
// ─────────────────────────────────────────────────────────────────────────────
describe('trino rules version — publisher and fetcher must agree', () => {
  const art = compileTrino(setOf([READ_ANALYSTS, FILTERED_REGIONAL]), { trinoGroupProvider: true });

  it('is IDENTICAL with and without an engine-supplied catalog list', () => {
    const publishSide = rulesVersion(buildTrinoRulesDocument(art, {}));
    const fetchSide = rulesVersion(buildTrinoRulesDocument(art, {
      catalogs: [{ name: 'system', allow: 'read-only' }, { name: 'memory', allow: 'all' }, { name: 'iceberg', allow: 'read-only' }],
    }));
    expect(fetchSide).toBe(publishSide);
  });

  it('is unchanged when the engine mounts or drops a catalog (not a policy change)', () => {
    const before = rulesVersion(buildTrinoRulesDocument(art, { catalogs: [{ name: 'system', allow: 'read-only' }] }));
    const after = rulesVersion(buildTrinoRulesDocument(art, {
      catalogs: [{ name: 'system', allow: 'read-only' }, { name: 'sales_pg', allow: 'read-only' }],
    }));
    expect(after).toBe(before);
  });

  it('DOES change when the policy changes (it still means something)', () => {
    const base = rulesVersion(buildTrinoRulesDocument(art, {}));
    const changed = rulesVersion(buildTrinoRulesDocument(
      compileTrino(setOf([READ_ANALYSTS, FILTERED_REGIONAL, DENY_CONTRACTORS]), { trinoGroupProvider: true }), {},
    ));
    expect(changed).not.toBe(base);
  });

  it('changes when a row filter is added — the control is inside the hash', () => {
    const without = rulesVersion(buildTrinoRulesDocument(compileTrino(setOf([READ_ANALYSTS]), { trinoGroupProvider: true }), {}));
    const withFilter = rulesVersion(buildTrinoRulesDocument(
      compileTrino(setOf([READ_ANALYSTS, FILTERED_REGIONAL]), { trinoGroupProvider: true }), {},
    ));
    expect(withFilter).not.toBe(without);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Impersonation — the grant is BOUNDED, and it exists only when needed.
// ─────────────────────────────────────────────────────────────────────────────
describe('trino impersonation rules', () => {
  it('names each policy user explicitly — never a `.*` wildcard', () => {
    const doc = buildTrinoRulesDocument(compileTrino(setOf([FILTERED_REGIONAL])), {});
    expect(doc.impersonation).toEqual([
      { original_user: '^loom-console$', new_user: '^alice@contoso\\.com$', allow: true },
    ]);
    expect(doc.impersonation.some((r) => r.new_user === '.*')).toBe(false);
  });

  it('emits NO impersonation grant when the policy names no user principals', () => {
    // Group-only policy: nothing needs to be impersonated, so the grant that
    // Trino otherwise denies by default is not created at all.
    const doc = buildTrinoRulesDocument(compileTrino(setOf([READ_ANALYSTS]), { trinoGroupProvider: true }), {});
    expect(doc.impersonation).toEqual([]);
  });

  it('an un-impersonated caller matches only the global tail (governed tables denied)', () => {
    // The security claim behind the grant: post-LU-7 the mapped session user is
    // DENIED every governed table, where pre-LU-7 (no `tables` section at all,
    // Trino default "access is granted") it had unrestricted SELECT on all of
    // them. The credential's reach shrinks.
    const doc = buildTrinoRulesDocument(compileTrino(setOf([FILTERED_REGIONAL])), {});
    const matchesLoomConsole = doc.tables.filter(
      (r) => !r.user && !r.group && !r.table,
    );
    expect(matchesLoomConsole).toHaveLength(1); // only the tail
    const governedCatchAll = doc.tables.find((r) => r.table === '^orders$' && !r.user && !r.group);
    expect(governedCatchAll!.privileges).toEqual([]); // denied before the tail
    expect(doc.tables.indexOf(governedCatchAll!)).toBeLessThan(doc.tables.indexOf(matchesLoomConsole[0]));
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

  // The module claims equivalence with the file-rules document. Dropping the
  // catalog floor would have made it strictly MORE permissive than the document
  // it claims to match, and dropping the impersonation restriction would have
  // let it authorize an identity the file document refuses.
  it('carries the CATALOG FLOOR when the engine catalog list is supplied', () => {
    const withCatalogs = buildTrinoRego(setOf([READ_ANALYSTS, FILTERED_REGIONAL]), {
      catalogs: [{ name: 'iceberg', allow: 'read-only' }, { name: 'memory', allow: 'all' }],
    });
    expect(withCatalogs).toContain('wired_catalogs := {');
    expect(withCatalogs).toContain('"iceberg"');
    expect(withCatalogs).toContain('catalog_ok := false if {');
    // Every table-path allow is gated on it.
    expect(withCatalogs.match(/catalog_ok/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it('SAYS SO when no catalog list was supplied, instead of silently omitting the floor', () => {
    const noCatalogs = buildTrinoRego(setOf([READ_ANALYSTS]));
    expect(noCatalogs).toContain('carries NO catalog floor');
    expect(noCatalogs).toContain('default catalog_ok := true');
  });

  it('restricts ImpersonateUser to the policy-named users, matching the file document', () => {
    const r = buildTrinoRego(setOf([FILTERED_REGIONAL]));
    expect(r).toContain('input.action.operation == "ImpersonateUser"');
    expect(r).toContain('impersonatable[input.action.resource.user.user]');
    expect(r).toContain('"alice@contoso.com"');
    expect(r).toContain('session_user := "loom-console"');
  });

  it('does not let a non-impersonation allow rule authorize ImpersonateUser', () => {
    const r = buildTrinoRego(setOf([FILTERED_REGIONAL]));
    expect(r).toContain('input.action.operation != "ImpersonateUser"');
  });
});
