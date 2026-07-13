/**
 * role-grant-client (brownfield Phase 2) — unit coverage for the network-free
 * logic: the DETERMINISTIC assignment GUID (stable + RFC-4122-shaped), and the
 * grantNavigatorRole outcome branches driven by a mocked ARM fetch —
 *   granted (201), already-exists (409 / RoleAssignmentExists), pending-grants
 *   (403 AuthorizationFailed → honest grantScript), and the no-principal gate.
 *
 * The live ARM PUT is integration-tested against real Azure per no-vaporware.md;
 * here we lock the deterministic-name contract and the status mapping the attach
 * hook + UI depend on. arm-credential + the principal resolver are mocked so no
 * @azure/identity token or Cosmos graph is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A crafted UAMI ARM token — grantNavigatorRole only needs a non-empty token.
vi.mock('../arm-credential', () => ({
  uamiArmCredential: () => ({
    getToken: async () => ({ token: 'fake-arm-token', expiresOnTimestamp: Date.now() + 3_600_000 }),
  }),
}));

// Console UAMI principal resolver — default returns a fixed principal; tests
// override to null to exercise the no-principal honest gate.
const resolveMock = vi.fn(async () => 'uami-principal-id' as string | null);
vi.mock('@/lib/clients/azure-connections-client', () => ({
  resolveUamiPrincipalId: () => resolveMock(),
}));

// cloud-endpoints is env-pure but pulls detectCloud — stub to a known base.
vi.mock('../cloud-endpoints', () => ({
  armBase: () => 'https://management.azure.com',
  armScope: () => 'https://management.azure.com/.default',
}));

async function load() {
  vi.resetModules();
  return import('../role-grant-client');
}

const ARM_ID =
  '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-x/providers/Microsoft.Kusto/clusters/adx1';

beforeEach(() => {
  resolveMock.mockResolvedValue('uami-principal-id');
});
afterEach(() => vi.restoreAllMocks());

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('deterministicAssignmentGuid', () => {
  it('is stable for the same inputs and RFC-4122-shaped', async () => {
    const { deterministicAssignmentGuid } = await load();
    const a = deterministicAssignmentGuid(ARM_ID, 'role-guid', 'principal');
    const b = deterministicAssignmentGuid(ARM_ID, 'role-guid', 'principal');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is case-insensitive on scope/role/principal (re-attach idempotency)', async () => {
    const { deterministicAssignmentGuid } = await load();
    expect(deterministicAssignmentGuid(ARM_ID.toUpperCase(), 'ROLE', 'PRIN'))
      .toBe(deterministicAssignmentGuid(ARM_ID.toLowerCase(), 'role', 'prin'));
  });

  it('differs when the scope, role, or principal differ', async () => {
    const { deterministicAssignmentGuid } = await load();
    const base = deterministicAssignmentGuid(ARM_ID, 'r', 'p');
    expect(deterministicAssignmentGuid(ARM_ID + '2', 'r', 'p')).not.toBe(base);
    expect(deterministicAssignmentGuid(ARM_ID, 'r2', 'p')).not.toBe(base);
    expect(deterministicAssignmentGuid(ARM_ID, 'r', 'p2')).not.toBe(base);
  });
});

describe('grantNavigatorRole', () => {
  it('granted: a 201 PUT maps to outcome "granted" and PUTs the deterministic name', async () => {
    const { grantNavigatorRole, deterministicAssignmentGuid } = await load();
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: '/ra/1' }));
    const r = await grantNavigatorRole({ armResourceId: ARM_ID, kind: 'adx' }, fetchImpl as unknown as typeof fetch);
    expect(r.outcome).toBe('granted');
    expect(r.roleName).toBe('Contributor'); // adx navigator role
    const guid = deterministicAssignmentGuid(ARM_ID, r.roleGuid, 'uami-principal-id');
    expect(r.assignmentGuid).toBe(guid);
    const calledUrl = (fetchImpl.mock.calls[0] as any[])[0] as string;
    expect(calledUrl).toContain(`/roleAssignments/${guid}?api-version=`);
    // Role definition is scoped to the resource's subscription.
    const putBody = JSON.parse(((fetchImpl.mock.calls[0] as any[])[1]).body);
    expect(putBody.properties.roleDefinitionId).toContain('/subscriptions/00000000-0000-0000-0000-000000000001/');
    expect(putBody.properties.principalType).toBe('ServicePrincipal');
  });

  it('already-exists: a 409 RoleAssignmentExists is treated as success (idempotent re-attach)', async () => {
    const { grantNavigatorRole } = await load();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: { code: 'RoleAssignmentExists', message: 'The role assignment already exists.' } }));
    const r = await grantNavigatorRole({ armResourceId: ARM_ID, kind: 'adx' }, fetchImpl as unknown as typeof fetch);
    expect(r.outcome).toBe('already-exists');
    expect(r.grantScript).toBeUndefined();
  });

  it('pending-grants: a 403 AuthorizationFailed emits an honest grantScript', async () => {
    const { grantNavigatorRole } = await load();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { code: 'AuthorizationFailed', message: 'does not have authorization' } }));
    const r = await grantNavigatorRole({ armResourceId: ARM_ID, kind: 'adx' }, fetchImpl as unknown as typeof fetch);
    expect(r.outcome).toBe('pending-grants');
    expect(r.grantScript).toContain('az role assignment create');
    expect(r.grantScript).toContain('--assignee-object-id uami-principal-id');
    expect(r.grantScript).toContain(ARM_ID);
  });

  it('no principal: honest gate with a placeholder grantScript, no fetch attempted', async () => {
    resolveMock.mockResolvedValue(null);
    const { grantNavigatorRole } = await load();
    const fetchImpl = vi.fn(async () => jsonResponse(201, {}));
    const r = await grantNavigatorRole({ armResourceId: ARM_ID, kind: 'adx' }, fetchImpl as unknown as typeof fetch);
    expect(r.outcome).toBe('pending-grants');
    expect(r.principalId).toBeNull();
    expect(r.grantScript).toContain('<console-uami-principal-id>');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skipped: an unknown/roleless kind attempts nothing', async () => {
    const { grantNavigatorRole } = await load();
    const fetchImpl = vi.fn(async () => jsonResponse(201, {}));
    const r = await grantNavigatorRole({ armResourceId: ARM_ID, kind: 'not-a-kind' as any }, fetchImpl as unknown as typeof fetch);
    expect(r.outcome).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
