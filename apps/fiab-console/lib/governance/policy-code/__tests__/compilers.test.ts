import { describe, it, expect } from 'vitest';
import { compileAll } from '../compile';
import { compileSynapse } from '../compilers/synapse';
import { compileUnityCatalog } from '../compilers/unity-catalog';
import { compileAdx } from '../compilers/adx';
import { compilePurview } from '../compilers/purview';
import { compileApiScope, toApiScopeEntries } from '../compilers/api-scope';
import { samplePolicyCodeSet } from '../samples';
import { POLICY_CODE_API_VERSION, type PolicyCodeSet } from '../dsl';

const finance: PolicyCodeSet = {
  apiVersion: POLICY_CODE_API_VERSION,
  name: 't',
  statements: [
    {
      id: 'fin',
      principals: [{ kind: 'group', id: 'grp-1', name: 'Finance' }],
      resources: [
        { backend: 'synapse', object: 'dbo.FactSales' },
        { backend: 'unity-catalog', object: 'main.sales.fact' },
        { backend: 'adx', object: 'Telemetry/Sales' },
      ],
      actions: ['read'],
      condition: { rowFilter: '[Region] = USERPRINCIPALNAME()', maskColumns: ['Email'] },
    },
  ],
};

describe('per-backend compilers', () => {
  it('synapse: emits GRANT SELECT, a column DENY (mask), and a SECURITY POLICY (RLS)', () => {
    const a = compileSynapse(finance);
    expect(a.applicable).toBe(true);
    const kinds = a.ops.map((o) => o.kind);
    expect(kinds).toContain('grant');
    expect(kinds).toContain('mask');
    expect(kinds).toContain('rls');
    const grant = a.ops.find((o) => o.kind === 'grant')!;
    expect(grant.statement).toMatch(/GRANT SELECT ON \[dbo\]\.\[FactSales\] TO/);
    expect(grant.undo).toMatch(/^REVOKE SELECT/);
    const rls = a.ops.find((o) => o.kind === 'rls')!;
    expect(rls.statement).toContain('CREATE SECURITY POLICY');
    expect(rls.statement).toContain('FILTER PREDICATE');
    expect(rls.undo).toContain('DROP SECURITY POLICY');
  });

  it('unity-catalog (databricks): GRANT + ROW FILTER + COLUMN MASK', () => {
    const a = compileUnityCatalog(finance, { ucVariant: 'databricks' });
    const kinds = a.ops.map((o) => o.kind);
    expect(kinds).toContain('grant');
    expect(kinds).toContain('rls');
    expect(kinds).toContain('mask');
    const grant = a.ops.find((o) => o.kind === 'grant')!;
    expect(grant.statement).toMatch(/GRANT SELECT ON TABLE `main`\.`sales`\.`fact` TO/);
    expect(grant.rest?.add).toEqual(['SELECT']);
    expect(a.ops.find((o) => o.kind === 'rls')!.statement).toContain('SET ROW FILTER');
  });

  it('unity-catalog (oss): grants only — RLS/mask become a warning (no Databricks capacity)', () => {
    const a = compileUnityCatalog(finance, { ucVariant: 'oss' });
    const kinds = a.ops.map((o) => o.kind);
    expect(kinds).toContain('grant');
    expect(kinds).not.toContain('rls');
    expect(kinds).not.toContain('mask');
    expect(a.warnings.join(' ')).toMatch(/OSS Unity Catalog/);
    // The grant still carries a REST payload so the OSS path can apply it.
    expect(a.ops[0].rest?.securableName).toBe('main.sales.fact');
  });

  it('adx: .add database principal + row_level_security', () => {
    const a = compileAdx(finance, { tenantId: 'tid-9' });
    const principal = a.ops.find((o) => o.kind === 'principal')!;
    expect(principal.statement).toMatch(/\.add database Telemetry viewers \('aadgroup=grp-1;tid-9'\)/);
    expect(principal.undo).toMatch(/^\.drop database/);
    const rls = a.ops.find((o) => o.kind === 'rls')!;
    expect(rls.statement).toContain('policy row_level_security enable');
    expect(rls.statement).toContain('current_principal_is_member_of');
  });

  it('purview: a marking compiles to a classification op', () => {
    const set: PolicyCodeSet = {
      apiVersion: POLICY_CODE_API_VERSION,
      name: 't',
      statements: [
        {
          id: 'm',
          principals: [{ kind: 'group', id: 'g' }],
          resources: [{ backend: 'purview', object: 'https://asset/x' }],
          actions: ['read'],
          condition: { marking: 'Confidential' },
        },
      ],
    };
    const a = compilePurview(set);
    expect(a.ops).toHaveLength(1);
    expect(a.ops[0].kind).toBe('classification');
    expect(a.ops[0].statement).toContain('Confidential');
  });

  it('api-scope: route → scope entries', () => {
    const set: PolicyCodeSet = {
      apiVersion: POLICY_CODE_API_VERSION,
      name: 't',
      statements: [
        {
          id: 'sc',
          principals: [{ kind: 'group', id: 'g1' }],
          resources: [{ backend: 'api-scope', object: '/api/items/warehouse/*' }],
          actions: ['read'],
        },
      ],
    };
    const a = compileApiScope(set);
    expect(a.ops[0].kind).toBe('scope');
    const entries = toApiScopeEntries(a);
    expect(entries).toEqual([{ route: '/api/items/warehouse/*', action: 'read', principalId: 'g1', principalKind: 'group' }]);
  });
});

describe('one-pass compileAll (WS-10.2 acceptance)', () => {
  it('the SAMPLE set compiles to ≥ 4 backends in one pass', () => {
    const res = compileAll(samplePolicyCodeSet());
    expect(res.compiledBackends.length).toBeGreaterThanOrEqual(4);
    expect(res.compiledBackends).toEqual(expect.arrayContaining(['synapse', 'unity-catalog', 'adx', 'purview', 'api-scope']));
    expect(res.totalOps).toBeGreaterThan(0);
    // every artifact is present (5 backends), applicable ones have ops.
    expect(res.artifacts).toHaveLength(5);
  });

  it('the finance set compiles to synapse + unity-catalog + adx in one pass', () => {
    const res = compileAll(finance, { ucVariant: 'databricks' });
    expect(res.compiledBackends).toEqual(expect.arrayContaining(['synapse', 'unity-catalog', 'adx']));
  });
});
