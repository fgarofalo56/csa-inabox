/**
 * `GET /api/experience/warp/transforms` run targets: serverless SQL is offered
 * only as `synapse-serverless-sql-pool` ITEM targets. The visual-query route
 * authorizes the caller on the item and item-scopes the generated SQL, so an
 * ambient id that is not an item (the former `synapse-serverless`) would be
 * answered 404 for every caller, tenant admins included.
 *
 * What breaks each case is named in its label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeWorkspace: vi.fn(async () => null) }));
vi.mock('@/lib/azure/loom-search', () => ({ upsertLoomDoc: vi.fn(), docForItem: vi.fn() }));

const POOL_ITEM = { id: 'pool-1', displayName: 'Pool', itemType: 'synapse-serverless-sql-pool', workspaceId: 'ws-1' };
const WH_ITEM = { id: 'wh-1', displayName: 'Wh', itemType: 'warehouse', workspaceId: 'ws-1' };
const state = vi.hoisted(() => ({ workspaces: [] as Array<{ id: string }> }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: state.workspaces }) }) },
  }),
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          // The saved-transforms query filters on `c.itemType = @kind`; the target query on `IN (...)`.
          if (/c\.itemType = @kind/.test(spec.query)) return { resources: [] };
          return { resources: [POOL_ITEM, WH_ITEM] };
        },
      }),
    },
  }),
}));

import { GET } from '@/app/api/experience/warp/transforms/route';

async function targets(): Promise<Array<{ id: string; engine: string }>> {
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  return body.targets;
}

describe('Warp run targets: serverless SQL is offered as item targets only', () => {
  beforeEach(() => { state.workspaces = [{ id: 'ws-1' }]; });

  it('with workspaces, the only serverless target is the serverless SQL pool item (breaks if an ambient serverless id is offered)', async () => {
    const t = await targets();
    const serverless = t.filter((x) => x.engine === 'synapse-serverless-sql-pool').map((x) => x.id);
    expect(serverless).toEqual([POOL_ITEM.id]);
    // Positive half: item targets and the ambient dedicated engine are still offered.
    expect(t.map((x) => x.id)).toEqual([POOL_ITEM.id, WH_ITEM.id, 'synapse-dedicated']);
  });

  it('with no workspaces, no serverless target is offered (breaks if the ambient serverless id returns on this path)', async () => {
    state.workspaces = [];
    const t = await targets();
    expect(t.filter((x) => x.engine === 'synapse-serverless-sql-pool')).toEqual([]);
    expect(t.map((x) => x.id)).toEqual(['synapse-dedicated']);
  });
});
