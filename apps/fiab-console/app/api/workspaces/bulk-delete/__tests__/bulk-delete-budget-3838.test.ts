/**
 * #3838 — AN UNFINISHED BATCH MUST HAND BACK ITS RECEIPT.
 *
 * `POST /api/workspaces/bulk-delete` accepts up to 500 ids (`MAX_BATCH`) and processes
 * them in a strictly SERIAL loop, and it declared no `maxDuration` while 69 other console
 * API routes do. That is a latency concern, not a security one — #3836's tenant boundary
 * is correct and nothing here touches it.
 *
 * The part that actually loses data-about-data is §3 of the issue: the batch is
 * NON-TRANSACTIONAL and the response is assembled only AFTER the loop completes. A
 * platform timeout mid-batch therefore left ids already deleted — items purged, workspace
 * docs gone, and with `cascade` the Azure backends torn down — while the caller received
 * no body at all. No `deleted` list, no `failed` list. The work was done and the receipt
 * was lost; the caller could not tell which ids had been processed without re-listing.
 *
 * These specs pin the fix at the level that matters: with the budget exhausted the route
 * still ANSWERS, the answer names every id it actually deleted, and every id it never
 * looked at is reported under its own code rather than being folded into `not_found` —
 * which would assert something about the workspace when the truth is only about the
 * request (deploy-integrity.md R7).
 *
 * WHAT IS NOT ASSERTED, and is not claimed anywhere in this change: the real wall time of
 * a 100–500 id purge on the live estate. No estate call was made. The budget is driven
 * here through `LOOM_BULK_DELETE_BUDGET_MS` precisely so that these tests measure the
 * BEHAVIOUR at the boundary without pretending to know where the boundary is.
 *
 * The harness mirrors `bulk-delete-tenant-boundary.test.ts` — the same fake Cosmos, the
 * same real POST handler — so the two suites agree about what the route is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

interface FakeItem { id: string; pk: string; doc: any }
function makeContainer(crossPartitionById = false) {
  const store = new Map<string, FakeItem>();
  return {
    _store: store,
    item(id: string, pk: string) {
      const key = `${pk}::${id}`;
      return {
        async read<T>() {
          const it = store.get(key);
          if (!it) { const e: any = new Error('not found'); e.code = 404; throw e; }
          return { resource: it.doc as T };
        },
        async delete() {
          if (!store.has(key)) { const e: any = new Error('nf'); e.code = 404; throw e; }
          store.delete(key);
        },
      };
    },
    items: {
      query(q: any) {
        return {
          async fetchAll() {
            if (crossPartitionById) {
              const idParam = q?.parameters?.find((p: any) => p.name === '@id')?.value;
              const rows = [...store.values()].map((v) => v.doc).filter((d) => !idParam || d.id === idParam);
              return { resources: rows };
            }
            return { resources: [] };
          },
        };
      },
    },
  };
}

const containers = {
  workspaces: makeContainer(true),
  items: makeContainer(false),
  workspaceRoles: makeContainer(false),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => containers.workspaces,
  itemsContainer: async () => containers.items,
  workspaceRolesContainer: async () => containers.workspaceRoles,
}));

vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(),
  deleteLoomDoc: vi.fn(),
  docForWorkspace: (w: any) => ({ id: `ws:${w.id}` }),
}));
vi.mock('@/lib/azure/lineage-gc', () => ({ cleanupWorkspaceMetadata: vi.fn() }));

const teardownMock = vi.fn(async () => [] as any[]);
vi.mock('@/lib/azure/resource-teardown', () => ({
  teardownWorkspaceBackends: (...a: any[]) => teardownMock(...(a as [])),
}));

vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: vi.fn(async () => null),
}));

const isTenantAdminMock = vi.fn(() => true);
vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: (...args: any[]) => isTenantAdminMock(...(args as [])),
}));

const HOME_TID = 'tid-contoso';
const OWNER = 'admin-oid';

function seedWorkspace(id: string) {
  const doc = {
    id, tenantId: OWNER, name: `ws-${id}`, createdBy: `${OWNER}@example.test`, tid: HOME_TID,
    createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
  };
  containers.workspaces._store.set(`${OWNER}::${id}`, { id, pk: OWNER, doc });
  return doc;
}

const stillExists = (id: string) => containers.workspaces._store.has(`${OWNER}::${id}`);

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/workspaces/bulk-delete/route');
  return POST({ json: async () => body } as any);
};

const IDS = ['ws-a', 'ws-b', 'ws-c', 'ws-d'];

beforeEach(() => {
  for (const c of Object.values(containers)) (c as any)._store.clear();
  getSessionMock.mockReturnValue({
    claims: { oid: OWNER, upn: 'admin@contoso.com', tid: HOME_TID },
    exp: Date.now() / 1000 + 3600,
  } as any);
  isTenantAdminMock.mockReturnValue(true);
  teardownMock.mockClear();
  teardownMock.mockResolvedValue([] as any[]);
  delete process.env.LOOM_BULK_DELETE_BUDGET_MS;
});

afterEach(() => {
  delete process.env.LOOM_BULK_DELETE_BUDGET_MS;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('#3838 — the batch budget', () => {
  it('EMBEDDED CONTROL: with the default budget the whole batch completes and ok is true', async () => {
    // Without this, every "it stopped early" assertion below is also satisfiable by a
    // route that stopped early ALWAYS — i.e. by a broken endpoint.
    for (const id of IDS) seedWorkspace(id);

    const r = await post({ ids: IDS });
    const j: any = await r.json();

    expect(j.ok).toBe(true);
    expect(j.deleted).toEqual(IDS);
    expect(j.failed).toEqual([]);
    expect(j.budgetExhausted).toBeUndefined();
    expect(j.notAttempted).toBeUndefined();
    for (const id of IDS) expect(stillExists(id)).toBe(false);
  });

  it('STOPS at the budget and still RETURNS the ids it actually deleted', async () => {
    // The receipt that used to be lost. A budget of 0 exhausts after the FIRST id — the
    // guard requires at least one completed outcome, so the route can never answer
    // "I did nothing" while claiming a budget it never spent.
    for (const id of IDS) seedWorkspace(id);
    process.env.LOOM_BULK_DELETE_BUDGET_MS = '0';

    const r = await post({ ids: IDS });
    const j: any = await r.json();

    expect(j.deleted).toEqual(['ws-a']);
    expect(j.budgetExhausted).toBe(true);
    expect(typeof j.elapsedMs).toBe('number');
    // The receipt matches reality: exactly the reported id is gone, the rest survive.
    expect(stillExists('ws-a')).toBe(false);
    for (const id of ['ws-b', 'ws-c', 'ws-d']) expect(stillExists(id)).toBe(true);
  });

  it('names every UN-ATTEMPTED id under its own code, never as not_found', async () => {
    // `not_found` asserts something about the WORKSPACE. These ids were never looked up,
    // so the only true statement is about the REQUEST. Conflating them would tell an
    // operator a workspace does not exist when it plainly does — the R7 failure this
    // repo has been burned by.
    for (const id of IDS) seedWorkspace(id);
    process.env.LOOM_BULK_DELETE_BUDGET_MS = '0';

    const r = await post({ ids: IDS });
    const j: any = await r.json();

    expect(j.notAttempted).toEqual(['ws-b', 'ws-c', 'ws-d']);
    const codes = j.failed.map((f: any) => f.error);
    expect(codes).toEqual(['not_attempted', 'not_attempted', 'not_attempted']);
    expect(codes).not.toContain('not_found');
    for (const f of j.failed) {
      expect(f.reason).toMatch(/never looked up/);
      expect(f.remediation).toMatch(/smaller batch/i);
    }
  });

  it('reports ok:false for an unfinished batch, so a partial purge cannot read as clean', async () => {
    for (const id of IDS) seedWorkspace(id);
    process.env.LOOM_BULK_DELETE_BUDGET_MS = '0';

    const r = await post({ ids: IDS });
    const j: any = await r.json();

    expect(r.status).toBe(200);
    expect(j.ok).toBe(false);
  });

  it('does NOT tear down Azure backends for an id it never attempted', async () => {
    // The destructive half. A budget stop must leave the un-attempted estate untouched,
    // which is asserted on the SPY rather than on the response body — a body-only
    // assertion would pass over a teardown that already happened.
    for (const id of IDS) seedWorkspace(id);
    process.env.LOOM_BULK_DELETE_BUDGET_MS = '0';

    await post({ ids: IDS, cascade: true });

    expect(teardownMock).toHaveBeenCalledTimes(1);
  });
});
