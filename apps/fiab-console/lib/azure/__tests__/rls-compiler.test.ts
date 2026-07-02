import { describe, it, expect } from 'vitest';
import {
  translateDax,
  daxFilterToTSql,
  daxFilterToDatabricksSql,
  compileSynapse,
  RLS_SCHEMA,
  DEFAULT_IDENTITY_TSQL,
  type SecurityRoleDef,
} from '../rls-compiler';

// Pure-string compiler — NO Azure / network. sqlString(x)=N'x', sqlBracket(x)=[x];
// translateDax collapses whitespace via .replace(/\s+/g,' ').trim().

describe('rls-compiler / daxFilterToTSql', () => {
  it('1. column = string literal lowers to a @param + N-prefixed literal', () => {
    const r = daxFilterToTSql('[Region]="West"');
    expect(r.sql).toContain('@Region');
    expect(r.sql).toContain("N'West'");
    expect(r.columns).toEqual(['Region']);
    expect(r.warnings).toHaveLength(0);
  });

  it('2. USERPRINCIPALNAME() lowers to the default identity expression', () => {
    const r = daxFilterToTSql('[Email]=USERPRINCIPALNAME()');
    expect(r.sql).toContain("SESSION_CONTEXT(N'loom_user')");
    expect(r.columns).toEqual(['Email']);
  });

  it('3. operators &&/<> lower to AND / <>', () => {
    const conj = daxFilterToTSql('[A]="x" && [B]="y"');
    expect(conj.sql).toContain(' AND ');
    const ne = daxFilterToTSql('[A]<>"x"');
    expect(ne.sql).toContain(' <> ');
    expect(ne.columns).toEqual(['A']);
  });

  it('4. unsupported function falls to falseLit and is warned', () => {
    const r = daxFilterToTSql('[A]=BADFUNC()');
    expect(r.sql).toContain('(1=0)');
    expect(r.warnings[0]).toMatch(/unsupported function BADFUNC\(\)/);
  });
});

describe('rls-compiler / daxFilterToDatabricksSql', () => {
  it('5. column = literal lowers to backticked col + spark string; identity → current_user()', () => {
    const r = daxFilterToDatabricksSql('[Region]="West"');
    expect(r.sql).toContain('`Region`');
    expect(r.sql).toContain("'West'");
    const id = daxFilterToDatabricksSql('[E]=USERNAME()');
    expect(id.sql).toContain('current_user()');
  });
});

describe('rls-compiler / compileSynapse', () => {
  it('6. emits schema + schemabinding TVF + SECURITY POLICY for a filtered table', () => {
    const roles: SecurityRoleDef[] = [
      {
        name: 'Sales',
        members: ['u@x'],
        tablePermissions: [
          { table: 'dbo.Orders', filterExpression: '[Region]="West"', metadataPermission: 'read' },
        ],
        updatedAt: '',
      },
    ];
    const artifact = compileSynapse(roles, DEFAULT_IDENTITY_TSQL);
    expect(artifact.engine).toBe('synapse');

    const schemaStep = artifact.steps.find((s) => s.kind === 'schema');
    expect(schemaStep).toBeDefined();
    expect(schemaStep!.sql).toContain(RLS_SCHEMA);

    const fnStep = artifact.steps.find((s) => s.kind === 'function');
    expect(fnStep).toBeDefined();
    expect(fnStep!.sql).toContain('CREATE FUNCTION');
    expect(fnStep!.sql).toContain('RETURNS TABLE WITH SCHEMABINDING');
    expect(fnStep!.sql).toContain('@Region');

    const polStep = artifact.steps.find((s) => s.kind === 'policy');
    expect(polStep).toBeDefined();
    expect(polStep!.sql).toContain('CREATE SECURITY POLICY');
    expect(polStep!.sql).toContain('ADD FILTER PREDICATE');
    expect(polStep!.sql).toContain('ON [dbo].[Orders]');
  });
});

// translateDax sanity — guards that the shared engine is exported and importable.
describe('rls-compiler / translateDax', () => {
  it('exports the low-level translator', () => {
    expect(typeof translateDax).toBe('function');
  });
});
