/**
 * I2 — workspace-grants matrix contract tests.
 *
 * Invariants (PRP ws-identity-cloudmatrix §I2):
 *  - The matrix covers every backend; unconfigured backends record an honest
 *    'skipped' (never a blind ARM write, never a throw).
 *  - ARM-RBAC grants use deterministic guid() names (idempotent PUT) and
 *    tolerate 409 RoleAssignmentExists as 'exists' — re-run = no-op.
 *  - Cosmos rides the DATA-PLANE sqlRoleAssignments API (account scope) — not
 *    an ARM role assignment.
 *  - Synapse / ADX grants are data-plane scripts executed through the real
 *    clients (mocked here), idempotent by construction.
 *  - evaluateWorkspaceGrant answers from LIVE state, caches per
 *    (workspaceId, backend), and never throws (errors → wouldAllow:null).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SHARED = { async getToken() { return { token: 'SHARED', expiresOnTimestamp: Date.now() + 3600_000 }; } };
vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential: () => SHARED }));

const { executeQuery, dedicatedTarget, executeMgmtCommand, discoverResourceCoordsByName } = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  dedicatedTarget: vi.fn(() => ({ server: 's', database: 'pool', cacheKey: 'k' })),
  executeMgmtCommand: vi.fn(),
  discoverResourceCoordsByName: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({ executeQuery, dedicatedTarget }));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeMgmtCommand,
  defaultDatabase: () => 'loomdb-default',
}));
vi.mock('@/lib/azure/resource-graph-coords', () => ({ discoverResourceCoordsByName }));

import {
  WORKSPACE_GRANTS, ensureWorkspaceGrants, evaluateWorkspaceGrant,
  workspaceLakeGrantScope, __clearWorkspaceGrantEvalCache,
  STORAGE_BLOB_DATA_CONTRIBUTOR, COSMOS_DATA_CONTRIBUTOR,
  EVENTHUBS_DATA_RECEIVER, EVENTHUBS_DATA_SENDER,
} from '../workspace-grants';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = handler(String(url), init);
    const body = out?._body ?? out;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: out?._status ?? 200 });
  }) as any;
}

const uami = { principalId: 'PID-1', clientId: '11111111-2222-3333-4444-555555555555', name: 'uami-ws-ws1' };

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-loom';
  process.env.LOOM_WS_IDENTITY_ARM_SPACING_MS = '0';
  process.env.LOOM_TENANT_ID = 'tenant-1';
  __clearWorkspaceGrantEvalCache();
  executeQuery.mockReset();
  executeMgmtCommand.mockReset();
  discoverResourceCoordsByName.mockReset();
});
afterEach(() => {
  global.fetch = realFetch;
  for (const k of [
    'LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_RG', 'LOOM_WS_IDENTITY_ARM_SPACING_MS', 'LOOM_TENANT_ID',
    'LOOM_BRONZE_URL', 'LOOM_ADLS_ACCOUNT', 'LOOM_COSMOS_ENDPOINT', 'LOOM_EVENTHUB_NAMESPACE',
    'LOOM_SYNAPSE_WORKSPACE', 'LOOM_SYNAPSE_DEDICATED_POOL', 'LOOM_KUSTO_CLUSTER_URI',
  ]) delete process.env[k];
  vi.restoreAllMocks();
});

describe('WORKSPACE_GRANTS matrix shape', () => {
  it('declares every I2 backend exactly once', () => {
    expect(WORKSPACE_GRANTS.map((g) => g.backend)).toEqual([
      'adls-lake', 'cosmos-data', 'synapse-sql', 'adx-database',
      'eventhubs-receiver', 'eventhubs-sender', 'key-vault', 'monitor',
    ]);
  });

  it('prefers data-plane grants where the backend supports them (I8 cap strategy)', () => {
    const kinds = Object.fromEntries(WORKSPACE_GRANTS.map((g) => [g.backend, g.kind]));
    expect(kinds['cosmos-data']).toBe('cosmos-data-rbac');
    expect(kinds['synapse-sql']).toBe('sql-data-plane');
    expect(kinds['adx-database']).toBe('kusto-data-plane');
  });
});

describe('workspaceLakeGrantScope', () => {
  it('scopes to the lake CONTAINER parsed from LOOM_BRONZE_URL', () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    expect(workspaceLakeGrantScope({})).toEqual({
      scope: '/subscriptions/sub-1/resourceGroups/rg-loom/providers/Microsoft.Storage/storageAccounts/lakeacct/blobServices/default/containers/bronze',
    });
  });
});

describe('ensureWorkspaceGrants — full matrix (I2)', () => {
  it('minimal deployment (lake only): grants ADLS, honest-skips the rest, fails nothing blindly', async () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    const puts: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'PUT') { puts.push(url); return { properties: {} }; }
      return {};
    });
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    const byBackend = Object.fromEntries(grants.map((g) => [g.backend, g]));
    expect(byBackend['adls-lake'].status).toBe('granted');
    expect(byBackend['adls-lake'].roleDefinitionId).toBe(STORAGE_BLOB_DATA_CONTRIBUTOR);
    expect(byBackend['cosmos-data'].status).toBe('skipped');
    expect(byBackend['synapse-sql'].status).toBe('skipped');
    expect(byBackend['adx-database'].status).toBe('skipped');
    expect(byBackend['eventhubs-receiver'].status).toBe('skipped');
    expect(byBackend['key-vault'].status).toBe('skipped'); // shared vault NEVER granted
    expect(byBackend['monitor'].status).toBe('skipped');
    expect(puts).toHaveLength(1); // exactly ONE ARM write for the lake grant
    expect(puts[0]).toContain('containers/bronze');
  });

  it('second run is a no-op: 409 RoleAssignmentExists records exists, no throw', async () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    mockFetch((_url, init) => (init?.method === 'PUT'
      ? { _status: 409, _body: { error: { code: 'RoleAssignmentExists', message: 'The role assignment already exists.' } } }
      : {}));
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    expect(grants.find((g) => g.backend === 'adls-lake')?.status).toBe('exists');
  });

  it('records an honest failed lake grant when no scope is resolvable (no blind writes)', async () => {
    const f = vi.fn(); global.fetch = f as any;
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    const lake = grants.find((g) => g.backend === 'adls-lake');
    expect(lake?.status).toBe('failed');
    expect(lake?.error).toContain('LOOM_BRONZE_URL');
    expect(f).not.toHaveBeenCalled();
  });

  it('Cosmos: DATA-PLANE sqlRoleAssignments PUT at account scope (RG-discovered)', async () => {
    process.env.LOOM_COSMOS_ENDPOINT = 'https://loomcosmos.documents.azure.com:443/';
    discoverResourceCoordsByName.mockResolvedValue({ subscriptionId: 'sub-c', resourceGroup: 'rg-c' });
    const puts: string[] = [];
    mockFetch((url, init) => { if (init?.method === 'PUT') { puts.push(url); return {}; } return {}; });
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    const cosmos = grants.find((g) => g.backend === 'cosmos-data');
    expect(cosmos?.status).toBe('granted');
    expect(cosmos?.kind).toBe('cosmos-data-rbac');
    const url = puts.find((u) => u.includes('/sqlRoleAssignments/'));
    expect(url).toContain('/subscriptions/sub-c/resourceGroups/rg-c/providers/Microsoft.DocumentDB/databaseAccounts/loomcosmos/sqlRoleAssignments/');
    expect(url).not.toContain('Microsoft.Authorization/roleAssignments'); // data-plane, not ARM RBAC
  });

  it('Event Hubs: Receiver + Sender at namespace scope with the built-in GUIDs', async () => {
    process.env.LOOM_EVENTHUB_NAMESPACE = 'ehns-loom';
    const bodies: any[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'PUT' && url.includes('Microsoft.EventHub')) { bodies.push(JSON.parse(String(init.body))); return { properties: {} }; }
      if (init?.method === 'PUT') return { properties: {} };
      return {};
    });
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    expect(grants.find((g) => g.backend === 'eventhubs-receiver')?.status).toBe('granted');
    expect(grants.find((g) => g.backend === 'eventhubs-sender')?.status).toBe('granted');
    const roles = bodies.map((b) => b.properties.roleDefinitionId as string);
    expect(roles.some((r) => r.endsWith(EVENTHUBS_DATA_RECEIVER))).toBe(true);
    expect(roles.some((r) => r.endsWith(EVENTHUBS_DATA_SENDER))).toBe(true);
  });

  it('Synapse: idempotent CREATE USER … FROM EXTERNAL PROVIDER + role adds via the real client', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'synws';
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool1';
    executeQuery.mockResolvedValue({ rows: [['1']] });
    mockFetch(() => ({}));
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    const syn = grants.find((g) => g.backend === 'synapse-sql');
    expect(syn?.status).toBe('granted');
    const sql = executeQuery.mock.calls[0][1] as string;
    expect(sql).toContain('CREATE USER [uami-ws-ws1] FROM EXTERNAL PROVIDER');
    expect(sql).toContain('IF NOT EXISTS'); // idempotent
    expect(sql).toContain("IS_ROLEMEMBER(N'db_datareader'");
  });

  it('ADX: .add database users aadapp principal via the real mgmt client', async () => {
    process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx.kusto.windows.net';
    executeMgmtCommand.mockResolvedValue({ rows: [] });
    mockFetch(() => ({}));
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    const adx = grants.find((g) => g.backend === 'adx-database');
    expect(adx?.status).toBe('granted');
    const cmd = executeMgmtCommand.mock.calls[0][1] as string;
    expect(cmd).toContain(".add database ['loomdb-default'] users");
    expect(cmd).toContain(`aadapp=${uami.clientId};tenant-1`);
  });

  it('a data-plane failure is recorded per-grant, other grants still apply (never throws)', async () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    process.env.LOOM_SYNAPSE_WORKSPACE = 'synws';
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool1';
    executeQuery.mockRejectedValue(new Error('login failed for the console identity'));
    mockFetch((_url, init) => (init?.method === 'PUT' ? { properties: {} } : {}));
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    expect(grants.find((g) => g.backend === 'adls-lake')?.status).toBe('granted');
    const syn = grants.find((g) => g.backend === 'synapse-sql');
    expect(syn?.status).toBe('failed');
    expect(syn?.error).toContain('login failed');
  });

  it('rejects an unsafe workspace id before any data-plane interpolation', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'synws';
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool1';
    mockFetch(() => ({}));
    const grants = await ensureWorkspaceGrants({ id: "ws1'; DROP TABLE x;--" }, uami);
    const syn = grants.find((g) => g.backend === 'synapse-sql');
    expect(syn?.status).toBe('failed');
    expect(syn?.error).toContain('safety shape');
    expect(executeQuery).not.toHaveBeenCalled();
  });
});

describe('evaluateWorkspaceGrant — the I3 "would it have had access?" resolver', () => {
  it('ARM backend: true when a covering assignment exists, false when absent', async () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    const scope = '/subscriptions/sub-1/resourceGroups/rg-loom/providers/Microsoft.Storage/storageAccounts/lakeacct/blobServices/default/containers/bronze';
    mockFetch(() => ({
      value: [{ properties: { principalId: 'PID-1', roleDefinitionId: `/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/${STORAGE_BLOB_DATA_CONTRIBUTOR}`, scope } }],
    }));
    const yes = await evaluateWorkspaceGrant({ id: 'ws1' }, uami, 'adls-lake');
    expect(yes.wouldAllow).toBe(true);
    expect(yes.source).toBe('arm');

    __clearWorkspaceGrantEvalCache();
    mockFetch(() => ({ value: [] }));
    const no = await evaluateWorkspaceGrant({ id: 'ws1' }, uami, 'adls-lake');
    expect(no.wouldAllow).toBe(false);
  });

  it('caches per (workspaceId, backend) — one live probe within the TTL', async () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    const f = vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200 }));
    global.fetch = f as any;
    await evaluateWorkspaceGrant({ id: 'ws1' }, uami, 'adls-lake');
    await evaluateWorkspaceGrant({ id: 'ws1' }, uami, 'adls-lake');
    expect(f).toHaveBeenCalledTimes(1);
    // A DIFFERENT workspace is a different cache key — never a neighbor's entry.
    await evaluateWorkspaceGrant({ id: 'ws2' }, uami, 'adls-lake');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('not-applicable backends resolve wouldAllow:null (never divergence-counted)', async () => {
    const out = await evaluateWorkspaceGrant({ id: 'ws1' }, uami, 'key-vault');
    expect(out.wouldAllow).toBeNull();
    expect(out.source).toBe('not-applicable');
  });

  it('never throws — a live-probe error resolves to wouldAllow:null source:error', async () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    global.fetch = vi.fn(async () => { throw new Error('ARM unreachable'); }) as any;
    const out = await evaluateWorkspaceGrant({ id: 'ws1' }, uami, 'adls-lake');
    expect(out.wouldAllow).toBeNull();
    expect(out.source).toBe('error');
    expect(out.reason).toContain('ARM unreachable');
  });
});
