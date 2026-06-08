import { describe, it, expect } from 'vitest';
import {
  bracket,
  literal,
  TsqlBuildError,
  buildObjectGrant,
  buildColumnGrant,
  buildRlsPolicy,
  buildDdmMask,
  buildDdmDrop,
  buildDdmFunctionExpr,
  buildVerifyAs,
  buildWizardSql,
  splitSqlBatches,
} from '../tsql-builders';

describe('bracket', () => {
  it('quotes a plain identifier', () => {
    expect(bracket('Sales')).toBe('[Sales]');
  });
  it('doubles embedded close-brackets (injection-safe)', () => {
    expect(bracket('ev]il')).toBe('[ev]]il]');
  });
  it('rejects empty / oversized identifiers', () => {
    expect(() => bracket('')).toThrow(TsqlBuildError);
    expect(() => bracket('x'.repeat(129))).toThrow(TsqlBuildError);
  });
});

describe('literal', () => {
  it('escapes single quotes', () => {
    expect(literal("a'b")).toBe("N'a''b'");
  });
});

describe('buildObjectGrant', () => {
  it('builds a GRANT with multiple permissions', () => {
    const sql = buildObjectGrant({
      schema: 'dbo', objectName: 'Sales',
      permissions: ['SELECT', 'UPDATE'], principal: 'analyst@contoso.com',
    });
    expect(sql).toBe('GRANT SELECT, UPDATE ON OBJECT::[dbo].[Sales] TO [analyst@contoso.com];');
  });
  it('appends WITH GRANT OPTION only on GRANT', () => {
    expect(buildObjectGrant({ schema: 'dbo', objectName: 'T', permissions: ['SELECT'], principal: 'u', withGrantOption: true }))
      .toContain('WITH GRANT OPTION');
    expect(buildObjectGrant({ schema: 'dbo', objectName: 'T', permissions: ['SELECT'], principal: 'u', withGrantOption: true, action: 'DENY' }))
      .not.toContain('WITH GRANT OPTION');
  });
  it('rejects empty permissions and unknown verbs', () => {
    expect(() => buildObjectGrant({ schema: 'dbo', objectName: 'T', permissions: [], principal: 'u' })).toThrow(TsqlBuildError);
    expect(() => buildObjectGrant({ schema: 'dbo', objectName: 'T', permissions: ['DROP' as any], principal: 'u' })).toThrow(TsqlBuildError);
  });
});

describe('buildColumnGrant', () => {
  it('builds a column-scoped SELECT grant', () => {
    const sql = buildColumnGrant({ schema: 'dbo', tableName: 'Membership', columns: ['MemberID', 'FirstName'], principal: 'TestUser' });
    expect(sql).toBe('GRANT SELECT ON [dbo].[Membership]([MemberID], [FirstName]) TO [TestUser];');
  });
  it('supports DENY', () => {
    expect(buildColumnGrant({ schema: 'dbo', tableName: 'T', columns: ['SSN'], principal: 'u', action: 'DENY' }))
      .toBe('DENY SELECT ON [dbo].[T]([SSN]) TO [u];');
  });
  it('rejects empty column list', () => {
    expect(() => buildColumnGrant({ schema: 'dbo', tableName: 'T', columns: [], principal: 'u' })).toThrow(TsqlBuildError);
  });
});

describe('buildRlsPolicy', () => {
  it('emits schema-create, predicate fn and security policy across GO batches', () => {
    const sql = buildRlsPolicy({
      policyName: 'SalesRepFilter', targetSchema: 'dbo', targetTable: 'Sales',
      filterColumn: 'SalesRep', predicateSchema: 'Security', allowAdmin: true,
    });
    expect(sql).toContain("CREATE OR ALTER FUNCTION [Security].[fn_SalesRepFilter_predicate]");
    expect(sql).toContain('CREATE SECURITY POLICY [Security].[SalesRepFilter]');
    expect(sql).toContain('ADD FILTER PREDICATE [Security].[fn_SalesRepFilter_predicate]([SalesRep]) ON [dbo].[Sales]');
    expect(sql).toContain("OR USER_NAME() = 'dbo'");
    expect(sql).toContain('WITH (STATE = ON);');
    // RLS must split into exactly 3 executable batches (schema / fn / policy).
    expect(splitSqlBatches(sql)).toHaveLength(3);
  });
  it('omits the admin branch when allowAdmin is false', () => {
    const sql = buildRlsPolicy({ policyName: 'P', targetSchema: 'dbo', targetTable: 'T', filterColumn: 'Owner', predicateSchema: 'Security' });
    expect(sql).not.toContain("USER_NAME() = 'dbo'");
  });
  it('rejects an unsafe policy name', () => {
    expect(() => buildRlsPolicy({ policyName: 'a; DROP TABLE x;--', targetSchema: 'dbo', targetTable: 'T', filterColumn: 'c', predicateSchema: 'Security' }))
      .toThrow(TsqlBuildError);
  });
});

describe('buildDdmFunctionExpr / buildDdmMask', () => {
  it('renders each mask kind', () => {
    expect(buildDdmFunctionExpr({ type: 'default' })).toBe('default()');
    expect(buildDdmFunctionExpr({ type: 'email' })).toBe('email()');
    expect(buildDdmFunctionExpr({ type: 'partial', prefix: 2, suffix: 0, padding: 'xxxx' })).toBe('partial(2,"xxxx",0)');
    expect(buildDdmFunctionExpr({ type: 'random', start: 1, end: 100 })).toBe('random(1,100)');
    expect(buildDdmFunctionExpr({ type: 'datetime', part: 'Y' })).toBe('datetime("Y")');
  });
  it('strips quotes from padding so it cannot break the literal', () => {
    expect(buildDdmFunctionExpr({ type: 'partial', prefix: 0, suffix: 4, padding: 'x"x\'x' })).toBe('partial(0,"xxx",4)');
  });
  it('builds the ALTER COLUMN ADD MASKED statement', () => {
    expect(buildDdmMask({ schema: 'Data', tableName: 'Membership', column: 'LastName', maskFn: { type: 'partial', prefix: 2, suffix: 0, padding: 'xxxx' } }))
      .toBe('ALTER TABLE [Data].[Membership]\nALTER COLUMN [LastName] ADD MASKED WITH (FUNCTION = \'partial(2,"xxxx",0)\');');
  });
  it('builds DROP MASKED', () => {
    expect(buildDdmDrop({ schema: 'dbo', tableName: 'T', column: 'SSN' }))
      .toBe('ALTER TABLE [dbo].[T]\nALTER COLUMN [SSN] DROP MASKED;');
  });
  it('rejects an inverted random range', () => {
    expect(() => buildDdmFunctionExpr({ type: 'random', start: 100, end: 1 })).toThrow(TsqlBuildError);
  });
});

describe('buildVerifyAs', () => {
  it('wraps a column SELECT in EXECUTE AS / REVERT', () => {
    const sql = buildVerifyAs({ principal: 'testmask', schema: 'dbo', table: 'SensitiveTable', column: 'SSN' });
    expect(sql).toBe("EXECUTE AS USER = N'testmask';\nSELECT TOP 20 [SSN] FROM [dbo].[SensitiveTable];\nREVERT;");
  });
  it('uses COUNT(*) for an RLS row test', () => {
    const sql = buildVerifyAs({ principal: 'analyst@contoso.com', schema: 'dbo', table: 'Sales' });
    expect(sql).toContain('SELECT COUNT(*) AS row_count FROM [dbo].[Sales];');
  });
});

describe('buildWizardSql dispatch', () => {
  it('routes each wizard kind', () => {
    expect(buildWizardSql('object-grant', { schema: 'dbo', objectName: 'T', permissions: ['SELECT'], principal: 'u' })).toContain('GRANT SELECT');
    expect(buildWizardSql('column-grant', { schema: 'dbo', tableName: 'T', columns: ['c'], principal: 'u' })).toContain('([c])');
    expect(buildWizardSql('ddm', { schema: 'dbo', tableName: 'T', column: 'c', maskFn: { type: 'email' } })).toContain("email()");
    expect(() => buildWizardSql('nope' as any, {})).toThrow(TsqlBuildError);
  });
});

describe('splitSqlBatches', () => {
  it('splits on standalone GO and drops empties', () => {
    expect(splitSqlBatches('SELECT 1\nGO\nSELECT 2\nGO\n')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('does not split on GO inside an identifier', () => {
    expect(splitSqlBatches('SELECT GOOSE FROM t')).toEqual(['SELECT GOOSE FROM t']);
  });
});
