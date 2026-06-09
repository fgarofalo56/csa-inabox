/**
 * Backend contract tests for the item-level Share functions in
 * azure-sql-client (per-database ARM role assignments). Stubs @azure/identity +
 * mssql + global.fetch — no live tenant. Asserts the REAL ARM REST surface
 * (Microsoft.Authorization/roleAssignments at the database scope) per
 * no-vaporware.md.
 *
 * Server is passed as a full ARM scope (starts with '/') so defaultServerScope
 * (which would otherwise list servers via ARM) is bypassed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('mssql', () => ({ default: { ConnectionPool: class {} } }));

import {
  SQL_DATABASE_ROLES,
  listDatabaseRoleAssignments,
  grantDatabaseRole,
  revokeDatabaseRoleAssignment,
  AzureSqlError,
} from '../azure-sql-client';

const realFetch = global.fetch;
let calls: Array<{ url: string; method: string; body?: any }> = [];
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  calls = [];
  global.fetch = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), method: (init?.method || 'GET'), body: init?.body ? JSON.parse(init.body) : undefined });
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    return new Response(out === undefined ? '' : JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  }) as any;
}

const SERVER_SCOPE = '/subscriptions/sub-1/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/srv01';

beforeEach(() => { process.env.LOOM_SUBSCRIPTION_ID = 'sub-1'; });
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

describe('SQL_DATABASE_ROLES', () => {
  it('exposes exactly the three constrained roles with the canonical GUIDs', () => {
    expect(SQL_DATABASE_ROLES['Reader']).toBe('acdd72a7-3385-48ef-bd42-f606fba81ae7');
    expect(SQL_DATABASE_ROLES['Contributor']).toBe('b24988ac-6180-42a0-ab88-20f7382dd24c');
    expect(SQL_DATABASE_ROLES['SQL DB Contributor']).toBe('9b7fa17d-e63e-47b0-bb0a-15c516ac86ec');
  });
});

describe('listDatabaseRoleAssignments', () => {
  it('GETs atScope() at the database scope and maps role names', async () => {
    mockFetch(() => ({
      value: [
        { id: '/ra/1', properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: '/x/acdd72a7-3385-48ef-bd42-f606fba81ae7' } },
        { id: '/ra/2', properties: { principalId: 'p2', principalType: 'Group', roleDefinitionId: '/x/deadbeef-0000-0000-0000-000000000000' } },
      ],
    }));
    const out = await listDatabaseRoleAssignments(SERVER_SCOPE, 'mydb');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain(`${SERVER_SCOPE}/databases/mydb/providers/Microsoft.Authorization/roleAssignments`);
    expect(calls[0].url).toContain('$filter=atScope()');
    expect(out[0].roleName).toBe('Reader');
    expect(out[1].roleName).toBeUndefined(); // unknown GUID → no friendly name
  });
});

describe('grantDatabaseRole', () => {
  it('PUTs a roleAssignment with the resolved role GUID and returns the ARM id', async () => {
    mockFetch((url) => ({ id: `${url.split('?')[0].replace('https://management.azure.com', '')}`, properties: { createdOn: '2026-06-08T00:00:00Z' } }));
    const res = await grantDatabaseRole(SERVER_SCOPE, 'mydb', 'principal-123', 'Reader', 'User');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body.properties.principalId).toBe('principal-123');
    expect(calls[0].body.properties.principalType).toBe('User');
    expect(calls[0].body.properties.roleDefinitionId).toContain('acdd72a7-3385-48ef-bd42-f606fba81ae7');
    expect(res.roleName).toBe('Reader');
    expect(res.id).toContain('/databases/mydb/providers/Microsoft.Authorization/roleAssignments/');
  });

  it('surfaces ARM 403 as AzureSqlError(403) — no fake success', async () => {
    mockFetch(() => ({ _status: 403, error: { message: "The client does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write'." } }));
    await expect(grantDatabaseRole(SERVER_SCOPE, 'mydb', 'p', 'Reader')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects when LOOM_SUBSCRIPTION_ID is unset', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    mockFetch(() => ({}));
    await expect(grantDatabaseRole(SERVER_SCOPE, 'mydb', 'p', 'Reader')).rejects.toBeInstanceOf(AzureSqlError);
  });
});

describe('revokeDatabaseRoleAssignment', () => {
  it('DELETEs the full ARM role-assignment id', async () => {
    mockFetch(() => ({}));
    await revokeDatabaseRoleAssignment('/subscriptions/sub-1/.../roleAssignments/abc');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/roleAssignments/abc?api-version=2022-04-01');
  });
});
