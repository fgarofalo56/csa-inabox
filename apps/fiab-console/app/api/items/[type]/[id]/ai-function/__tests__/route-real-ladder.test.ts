/**
 * POST /api/items/[type]/[id]/ai-function — the item scope, with the
 * authorization ladder run for real.
 *
 * `route.test.ts` (the sibling) mocks `@/lib/auth/workspace-guard`, so the
 * refusal it observes is the mock's own Response. This file mocks nothing of
 * the ladder: `guardSynapseItemRequest`, `authorizeItemWorkspace`,
 * `authorizeWorkspace`, `resolveWorkspaceAccessByOid`, the tenant boundary
 * (`lib/auth/tenant-boundary`), the denial mapper and `isTenantAdmin` are all
 * REAL. Only the data they read is mocked: the Cosmos containers, the ACL role
 * lookup (`resolveEffectiveRole`) and the session — plus the Databricks client,
 * whose `executeStatement` is the "statement sent" counter every case reads.
 *
 * The `workspaces` mock honours Cosmos partition semantics (as the prior-art
 * `items/[type]/[id]/__tests__/workspace-authz.test.ts` does): the container is
 * partitioned on `/tenantId`, which holds the creator's oid, so a point read
 * with any other partition key finds nothing. A mock that returned the doc for
 * any key would grant the owner fast path to every caller.
 *
 * WHAT BREAKS THESE TESTS (each run on a sandbox copy and seen RED; the arm
 * table is in the PR body):
 *   - the route ignoring the guard (`if (guard.res) return guard.res;` removed
 *     and the session taken from elsewhere): all five refusal cases fail;
 *   - `allowReadRoles: true` dropped from the route's guard call: the ACL
 *     Viewer grant fails (Viewer is not a write role);
 *   - the route's `notFound` text changed (e.g. to "workspace not found"):
 *     all five refusal bodies fail the deep-equal against the pinned text;
 *   - the guard's fail-closed lookup removed: the unknown-id and wrong-`[type]`
 *     cases fail;
 *   - the ladder's tenant-boundary step disabled: the other-tenant case fails;
 *   - the `LOOM_MULTIUSER_ACL=off` kill switch ignored: the flag-off Viewer
 *     case fails.
 * The owner and Viewer grants are the positive controls: a route that refused
 * everyone would pass all four refusal cases and fail those two.
 *
 * WHAT THIS DOES NOT ESTABLISH (deploy-integrity.md R7): a Node/vitest run
 * against mocked containers on the Commercial code path (`isGovCloud` false).
 * It is not a live estate receipt and says nothing about a Gov boundary.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const OWNER = 'oid-workspace-creator';
const VIEWER = 'oid-viewer';
const STRANGER = 'oid-stranger';
const TID = 'entra-tenant-1';
const OTHER_TID = 'entra-tenant-2';

/** ws-1: created by OWNER in TID. ws-2: another tenant's workspace. */
const WORKSPACES = [
  { id: 'ws-1', tenantId: OWNER, tid: TID, name: 'Analytics' },
  { id: 'ws-2', tenantId: 'oid-other-tenant-creator', tid: OTHER_TID, name: 'Elsewhere' },
];
const ITEMS = [
  { id: 'nb-1', itemType: 'notebook', workspaceId: 'ws-1', displayName: 'Mine', state: {} },
  { id: 'nb-2', itemType: 'notebook', workspaceId: 'ws-2', displayName: 'Theirs', state: {} },
];

/** The text the route passes as `notFound`, copied from route.ts on purpose:
 * a change to the route's wording must fail here, not be followed. */
const REFUSAL = {
  ok: false,
  error:
    'This item is not available to you. Either it does not exist, or you have no role in its ' +
    'workspace. Ask a workspace owner to share it with you.',
};

const world = { aclRole: null as string | null };

vi.mock('@/lib/azure/cosmos-client', () => {
  const param = (spec: any, name: string) =>
    (spec?.parameters || []).find((p: any) => p.name === name)?.value;
  return {
    workspacesContainer: async () => ({
      item: (id: string, pk: string) => ({
        read: async () => ({ resource: WORKSPACES.find((w) => w.id === id && w.tenantId === pk) }),
      }),
      items: {
        query: (spec: any) => ({
          fetchAll: async () => ({ resources: WORKSPACES.filter((w) => w.id === param(spec, '@id')) }),
        }),
      },
    }),
    // Serves both `SELECT c.workspaceId …` (workspaceIdOfItem) and `SELECT * …`
    // (loadSynapseItemRaw): both filter on @id AND @t.
    itemsContainer: async () => ({
      items: {
        query: (spec: any) => ({
          fetchAll: async () => ({
            resources: ITEMS.filter((i) => i.id === param(spec, '@id') && i.itemType === param(spec, '@t')),
          }),
        }),
      },
    }),
    workspaceRolesContainer: async () => ({
      items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
    }),
  };
});

vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: vi.fn(async () => world.aclRole),
}));

const currentSession = { value: null as any };
vi.mock('@/lib/auth/session', () => ({ getSession: () => currentSession.value }));

vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal() as any),
  isGovCloud: () => false,
}));

const executeStatement = vi.fn(async (..._a: unknown[]) => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: () => null,
  getWarehouse: async () => ({ state: 'RUNNING' }),
  executeStatement: (...a: unknown[]) => executeStatement(...a),
}));

vi.mock('@/lib/azure/copilot-config-store', () => ({ loadTenantCopilotConfig: async () => null }));

import { POST } from '../route';

async function postAs(oid: string, type: string, id: string, tid: string = TID) {
  currentSession.value = { claims: { oid, tid, groups: [] as string[], upn: `${oid}@x`, name: oid } };
  const req = new NextRequest(`https://x/api/items/${type}/${id}/ai-function`, {
    method: 'POST',
    body: JSON.stringify({ fn: 'classify', column: 'txt', table: 'main.s.t', warehouseId: 'wh1', options: { labels: ['good'] } }),
  });
  const res = await POST(req, { params: Promise.resolve({ type, id }) });
  return { status: res.status, body: await res.json(), sent: executeStatement.mock.calls.length };
}

const savedEnv = {
  acl: process.env.LOOM_MULTIUSER_ACL,
  adminOid: process.env.LOOM_TENANT_ADMIN_OID,
  adminGroup: process.env.LOOM_TENANT_ADMIN_GROUP_ID,
};

beforeEach(() => {
  world.aclRole = null;
  currentSession.value = null;
  executeStatement.mockClear();
  // No caller here is a tenant admin; the admin-open step must not grant.
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  delete process.env.LOOM_MULTIUSER_ACL;
});

afterEach(() => {
  for (const [k, v] of [
    ['LOOM_MULTIUSER_ACL', savedEnv.acl],
    ['LOOM_TENANT_ADMIN_OID', savedEnv.adminOid],
    ['LOOM_TENANT_ADMIN_GROUP_ID', savedEnv.adminGroup],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('ai-function POST through the real ladder: grants', () => {
  it('the workspace owner reaches the warehouse (owner fast path)', async () => {
    const r = await postAs(OWNER, 'notebook', 'nb-1');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.engine).toBe('databricks');
    expect(r.sent).toBe(1);
  });

  it('an ACL Viewer reaches the warehouse: read roles are admitted', async () => {
    // Breaks if the route drops `allowReadRoles: true`: Viewer is not in
    // WRITE_ROLES, so the ladder refuses it.
    world.aclRole = 'Viewer';
    const r = await postAs(VIEWER, 'notebook', 'nb-1');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.sent).toBe(1);
  });
});

describe('ai-function POST through the real ladder: refusals are one indistinguishable 404', () => {
  it('a same-tenant caller with no role on the workspace', async () => {
    // Breaks if the route ignores the guard (it proceeds past the refusal), or
    // if its notFound wording changes (the body no longer deep-equals REFUSAL).
    const r = await postAs(STRANGER, 'notebook', 'nb-1');
    expect(r.status).toBe(404);
    expect(r.body).toEqual(REFUSAL);
    expect(r.sent).toBe(0);
  });

  it('an id that names no item', async () => {
    // The ladder allows here (no item, so no workspace to gate); this is the
    // guard's own fail-closed lookup. Breaks if that lookup is removed.
    const r = await postAs(OWNER, 'notebook', 'nb-missing');
    expect(r.status).toBe(404);
    expect(r.body).toEqual(REFUSAL);
    expect(r.sent).toBe(0);
  });

  it('a real id under the wrong [type]', async () => {
    // nb-1 exists as a notebook. Breaks if [type] stops reaching the lookup.
    const r = await postAs(OWNER, 'databricks-sql-warehouse', 'nb-1');
    expect(r.status).toBe(404);
    expect(r.body).toEqual(REFUSAL);
    expect(r.sent).toBe(0);
  });

  it("another tenant's workspace, even with an ACL row", async () => {
    // The role lookup WOULD grant Viewer; only the tenant boundary (step 4)
    // refuses. Breaks if the ladder stops comparing the caller's tid with the
    // workspace's, or if the route ignores the guard.
    world.aclRole = 'Viewer';
    const r = await postAs(VIEWER, 'notebook', 'nb-2');
    expect(r.status).toBe(404);
    expect(r.body).toEqual(REFUSAL);
    expect(r.sent).toBe(0);
  });
});

describe('ai-function POST with LOOM_MULTIUSER_ACL=off (owner-only)', () => {
  it('the owner is still granted', async () => {
    process.env.LOOM_MULTIUSER_ACL = 'off';
    const r = await postAs(OWNER, 'notebook', 'nb-1');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.sent).toBe(1);
  });

  it('an ACL Viewer is refused: the ACL step does not run', async () => {
    // Same caller and role row that is granted above with the flag on, so the
    // flag is the only difference. Breaks if the kill switch stops applying.
    process.env.LOOM_MULTIUSER_ACL = 'off';
    world.aclRole = 'Viewer';
    const r = await postAs(VIEWER, 'notebook', 'nb-1');
    expect(r.status).toBe(404);
    expect(r.body).toEqual(REFUSAL);
    expect(r.sent).toBe(0);
  });
});
