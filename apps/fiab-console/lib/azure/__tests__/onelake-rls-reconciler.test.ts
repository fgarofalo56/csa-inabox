import { describe, it, expect, afterEach } from 'vitest';
import {
  buildSynapseRlsSteps,
  buildSynapseClsSteps,
  buildAdxRestrictQuery,
  extractAndParameterize,
  synapseSchemaStep,
  resolveReconcileEngine,
  reconcileRoleRlsCls,
} from '../onelake-rls-reconciler';
import type { OneLakeSecurityRole, SecurityRoleMember } from '../onelake-security-client';

// Pure-string assertions over the DDL builders — NO Azure SDK / network. The
// gate tests call the async reconcile with the engine env UNSET, which returns
// a gated receipt WITHOUT importing the Synapse/Kusto clients.

function sampleRole(over: Partial<OneLakeSecurityRole> = {}): OneLakeSecurityRole {
  const members: SecurityRoleMember[] = [{ objectId: '00000000-0000-0000-0000-000000000001', objectType: 'User', upn: 'analyst@contoso.com' }];
  return {
    id: 'item1:analysts',
    itemId: 'item1',
    itemType: 'lakehouse',
    container: 'gold',
    roleName: 'Analysts',
    permissions: ['Read'],
    paths: ['*'],
    members,
    createdBy: 'me',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('onelake-rls-reconciler / extractAndParameterize', () => {
  it('rewrites bracketed + bare columns to @params, keeps SESSION_CONTEXT verbatim', () => {
    const r = extractAndParameterize("[Region] = SESSION_CONTEXT(N'loom_user')");
    expect(r.columns).toEqual(['Region']);
    expect(r.rewritten).toBe("@Region = SESSION_CONTEXT(N'loom_user')");
    expect(r.rewritten).toContain('@Region');
    expect(r.rewritten).toContain("SESSION_CONTEXT(N'loom_user')");
  });

  it('does not treat function names or reserved words as columns', () => {
    const r = extractAndParameterize("OwnerEmail = CAST(SESSION_CONTEXT(N'loom_user') AS sysname)");
    expect(r.columns).toEqual(['OwnerEmail']);
    expect(r.rewritten).toContain('@OwnerEmail');
    expect(r.rewritten).toContain('CAST(');
    expect(r.rewritten).toContain('AS sysname');
  });
});

describe('onelake-rls-reconciler / buildSynapseRlsSteps', () => {
  const built = buildSynapseRlsSteps('Analysts', { table: 'dbo.Sales', predicate: "[Region] = SESSION_CONTEXT(N'loom_user')" });

  it('emits a CREATE SECURITY POLICY bound to the table via a FILTER PREDICATE', () => {
    const policy = built.steps.find((s) => s.kind === 'policy');
    expect(policy).toBeTruthy();
    expect(policy!.sql).toContain('CREATE SECURITY POLICY');
    expect(policy!.sql).toContain('ADD FILTER PREDICATE');
    expect(policy!.sql).toContain('ON [dbo].[Sales]');
    expect(policy!.sql).toContain('WITH (STATE = ON)');
    // binds the extracted column
    expect(policy!.sql).toMatch(/fn_rls_Analysts_Sales\]\(\[Region\]\)/);
  });

  it('emits a schemabinding TVF whose WHERE contains the predicate + db_owner bypass', () => {
    const fn = built.steps.find((s) => s.kind === 'function');
    expect(fn).toBeTruthy();
    expect(fn!.sql).toContain('RETURNS TABLE WITH SCHEMABINDING');
    expect(fn!.sql).toContain('@Region NVARCHAR(4000)');
    expect(fn!.sql).toContain("WHERE (@Region = SESSION_CONTEXT(N'loom_user'))");
    expect(fn!.sql).toContain("IS_MEMBER('db_owner') = 1");
  });

  it('is idempotent — DROP-IF-EXISTS for both the policy and the function precede CREATE', () => {
    const drops = built.steps.filter((s) => s.kind === 'drop').map((s) => s.sql);
    expect(drops.some((d) => /DROP SECURITY POLICY/.test(d) && /IF EXISTS/.test(d))).toBe(true);
    expect(drops.some((d) => /DROP FUNCTION/.test(d) && /OBJECT_ID/.test(d))).toBe(true);
    // order: drops come before the function + policy creates
    const firstCreate = built.steps.findIndex((s) => s.kind === 'function' || s.kind === 'policy');
    const lastDrop = built.steps.map((s) => s.kind).lastIndexOf('drop');
    expect(lastDrop).toBeLessThan(firstCreate);
  });

  it('matches the semantic-model schema step', () => {
    expect(synapseSchemaStep().sql).toContain("CREATE SCHEMA LoomSecurity");
    expect(synapseSchemaStep().sql).toContain('IF NOT EXISTS');
  });

  it('skips RLS (with a warning) when the predicate references no columns', () => {
    const b = buildSynapseRlsSteps('R', { table: 'dbo.T', predicate: "SESSION_CONTEXT(N'loom_user') = N'x'" });
    expect(b.steps).toHaveLength(0);
    expect(b.warnings[0]).toMatch(/references no columns/);
  });

  it('rejects an invalid/unsafe predicate (no DDL emitted, warning recorded)', () => {
    const b = buildSynapseRlsSteps('R', { table: 'dbo.T', predicate: 'DROP TABLE x' });
    expect(b.steps).toHaveLength(0);
    expect(b.columns).toHaveLength(0);
    expect(b.warnings[0]).toMatch(/rejected/);
  });
});

describe('onelake-rls-reconciler / buildSynapseClsSteps', () => {
  it('emits per-member REVOKE table SELECT + GRANT SELECT on the allowed columns', () => {
    const members: SecurityRoleMember[] = [{ objectId: 'x', objectType: 'User', upn: 'a@b.com' }];
    const b = buildSynapseClsSteps({ table: 'dbo.Sales', allowedColumns: ['Id', 'Region'] }, members);
    const grant = b.steps.find((s) => s.kind === 'grant');
    const revoke = b.steps.find((s) => s.kind === 'revoke');
    expect(grant!.sql).toBe('GRANT SELECT ON [dbo].[Sales]([Id], [Region]) TO [a@b.com];');
    expect(revoke!.sql).toBe('REVOKE SELECT ON [dbo].[Sales] FROM [a@b.com];');
  });

  it('warns (no steps) when no member has a UPN', () => {
    const members: SecurityRoleMember[] = [{ objectId: 'x', objectType: 'User' }];
    const b = buildSynapseClsSteps({ table: 'dbo.Sales', allowedColumns: ['Id'] }, members);
    expect(b.steps).toHaveLength(0);
    expect(b.warnings[0]).toMatch(/no members with a resolvable UPN/);
  });
});

describe('onelake-rls-reconciler / buildAdxRestrictQuery', () => {
  it('materializes RLS + CLS in one query (| where + | project)', () => {
    const q = buildAdxRestrictQuery('Sales', "Region == current_principal_details()['UserPrincipalName']", ['Id', 'Region']);
    expect(q).toContain('["Sales"]');
    expect(q).toContain('| where (');
    expect(q).toContain("| project ['Id'], ['Region']");
  });

  it('CLS-only emits just the project', () => {
    const q = buildAdxRestrictQuery('Sales', undefined, ['Id']);
    expect(q).toBe("[\"Sales\"] | project ['Id']");
  });
});

describe('onelake-rls-reconciler / resolveReconcileEngine', () => {
  it('routes eventhouse/kql items to ADX, everything else to Synapse', () => {
    expect(resolveReconcileEngine({ itemType: 'eventhouse' })).toBe('adx');
    expect(resolveReconcileEngine({ itemType: 'kql-database' })).toBe('adx');
    expect(resolveReconcileEngine({ itemType: 'lakehouse' })).toBe('synapse');
    expect(resolveReconcileEngine({}, { itemType: 'mirrored-database' })).toBe('synapse');
  });
});

describe('onelake-rls-reconciler / honest gate (no-vaporware)', () => {
  const saved = {
    ws: process.env.LOOM_SYNAPSE_WORKSPACE,
    pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
    adx: process.env.LOOM_KUSTO_CLUSTER_URI,
  };
  afterEach(() => {
    if (saved.ws === undefined) delete process.env.LOOM_SYNAPSE_WORKSPACE; else process.env.LOOM_SYNAPSE_WORKSPACE = saved.ws;
    if (saved.pool === undefined) delete process.env.LOOM_SYNAPSE_DEDICATED_POOL; else process.env.LOOM_SYNAPSE_DEDICATED_POOL = saved.pool;
    if (saved.adx === undefined) delete process.env.LOOM_KUSTO_CLUSTER_URI; else process.env.LOOM_KUSTO_CLUSTER_URI = saved.adx;
  });

  it('gates the Synapse path on the missing env var (no fake success, no crash)', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    delete process.env.LOOM_SYNAPSE_DEDICATED_POOL;
    const role = sampleRole({ rls: [{ table: 'dbo.Sales', predicate: "[Region] = SESSION_CONTEXT(N'loom_user')" }] });
    const receipt = await reconcileRoleRlsCls({ id: 'item1', itemType: 'lakehouse' }, role);
    expect(receipt.status).toBe('gated');
    expect(receipt.applied).toBe(0);
    expect(receipt.gate?.missing).toMatch(/LOOM_SYNAPSE/);
    expect(receipt.warnings.join(' ')).toMatch(/PDP/i);
  });

  it('gates the ADX path on the missing cluster env var', async () => {
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    const role = sampleRole({ itemType: 'lakehouse', cls: [{ table: 'Sales', allowedColumns: ['Id'] }] });
    const receipt = await reconcileRoleRlsCls({ id: 'eh1', itemType: 'eventhouse' }, role);
    expect(receipt.status).toBe('gated');
    expect(receipt.engine).toBe('adx');
    expect(receipt.gate?.missing).toBe('LOOM_KUSTO_CLUSTER_URI');
  });
});
