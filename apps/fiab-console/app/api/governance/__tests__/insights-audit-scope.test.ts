/**
 * BFF contract tests for GET /api/governance/insights — the `auditEvents30d`
 * KPI's audit-log scope (#2635).
 *
 * The Cosmos `audit-log` container partitions on `/itemId` and its writers
 * record `tenantId` as `tenantScopeId(session)` = tid ?? oid, so the route's
 * `c.tenantId = @t` (with `@t = claims.oid`) predicate missed every tid-scoped
 * row. Unlike its two admin siblings this surface is session-only — any
 * authenticated user reaches it, and every other number it returns is scoped to
 * the caller's own workspaces. The widened tenant scope is therefore applied
 * ONLY for tenant admins; a non-admin's count stays deliberately actor-scoped.
 * Both halves of that rule are pinned below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeAuditContainerDouble, twoScopeFixture } from '@/lib/audit/__tests__/audit-container-double';

const SESSION_OID = 'insights-oid';
const SESSION_TID = 'insights-entra-tid';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: SESSION_OID, tid: SESSION_TID, upn: 'user@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

function makeSimpleContainer(rows: () => any[]) {
  const calls: Array<{ query: string; options?: any }> = [];
  return {
    calls,
    items: {
      query(q: any, opts?: any) {
        calls.push({ query: q?.query, options: opts });
        return { async fetchAll() { return { resources: rows() }; } };
      },
    },
    item() {
      return { async read() { const e: any = new Error('not found'); e.code = 404; throw e; } };
    },
  };
}

let auditDouble = makeAuditContainerDouble(twoScopeFixture({ oid: SESSION_OID, tid: SESSION_TID }));
const workspaces = makeSimpleContainer(() => [{ id: 'ws1' }]);
const items = makeSimpleContainer(() => [
  { id: 'i1', workspaceId: 'ws1', itemType: 'lakehouse', displayName: 'Finance', state: {} },
]);
const tenantSettings = makeSimpleContainer(() => []);

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => workspaces,
  itemsContainer: async () => items,
  auditLogContainer: async () => auditDouble,
  tenantSettingsContainer: async () => tenantSettings,
}));

async function callGet() {
  const { GET } = await import('@/app/api/governance/insights/route');
  return GET();
}

beforeEach(() => {
  auditDouble = makeAuditContainerDouble(twoScopeFixture({ oid: SESSION_OID, tid: SESSION_TID }));
  getSessionMock.mockReturnValue({ claims: { oid: SESSION_OID, tid: SESSION_TID, upn: 'user@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
  process.env.LOOM_TENANT_ADMIN_OID = SESSION_OID; // tenant admin by default
  workspaces.calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.LOOM_TENANT_ADMIN_OID;
});

describe('/api/governance/insights — auditEvents30d scope (#2635)', () => {
  it('401s an unauthenticated caller', async () => {
    getSessionMock.mockReturnValue(null);
    expect((await callGet()).status).toBe(401);
  });

  it('counts BOTH the oid-scoped and the tid-scoped row for a tenant admin', async () => {
    const j = await (await callGet()).json();
    expect(j.ok).toBe(true);
    expect(j.kpis.auditEvents30d).toBe(2);
  });

  it('binds oid AND tid as the tenant scope for a tenant admin', async () => {
    await callGet();
    const tenants = auditDouble.calls[0]?.parameters.find((p) => p.name === '@tenants');
    expect(tenants?.value).toEqual([SESSION_OID, SESSION_TID]);
  });

  it('reads the audit-log cross-partition (it partitions on /itemId)', async () => {
    await callGet();
    expect(auditDouble.calls[0]?.options?.partitionKey).toBeUndefined();
  });

  it('keeps a NON-admin viewer actor-scoped — no org-wide activity volume', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID; // ordinary tenant member
    const j = await (await callGet()).json();
    const tenants = auditDouble.calls[0]?.parameters.find((p) => p.name === '@tenants');
    expect(tenants?.value).toEqual([SESSION_OID]);
    expect(j.kpis.auditEvents30d).toBe(1);
  });

  it('still works on a bootstrap session with no tid', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: SESSION_OID, upn: 'user@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
    const j = await (await callGet()).json();
    expect(j.kpis.auditEvents30d).toBe(1);
  });

  it('keeps the workspaces read pinned to its /tenantId partition', async () => {
    await callGet();
    expect(workspaces.calls[0]?.options?.partitionKey).toBe(SESSION_OID);
  });
});
