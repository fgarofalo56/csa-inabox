/**
 * #4039 R8 — POST /sources judges the EFFECTIVE connection.
 *
 * `app/api/items/mirrored-database/[id]/sources/route.ts` sets the mirror's
 * source binding. Its body carries `connectionId?`, so a caller can change the
 * SOURCE TYPE while leaving the connection alone — and that is precisely the
 * shape that produces a contradiction:
 *
 *     const effectiveConnectionId = connectionId !== undefined ? connectionId : state.connectionId;
 *     const mismatch = await mirrorBindingMismatch(s.claims.oid, sourceType, effectiveConnectionId);
 *
 * With the fallback removed, a body that omits `connectionId` hands `undefined`
 * to `mirrorBindingMismatch`, which returns `null` for a missing connection by
 * design — so the guard would answer "no mismatch" about a pair it never looked
 * at, and the contradiction would be persisted. That is the failure this suite
 * exists to make impossible to reintroduce silently.
 *
 * WHY IT EXISTS. The guard was correct and UNWITNESSED: no test imported this
 * handler. Deleting the fallback left every mirroring test in the tree green.
 *
 * THE MUTATIONS THIS IS BUILT TO CATCH (each RUN — see the PR):
 *   R8a  `effectiveConnectionId` -> `connectionId`
 *   R8b  delete the `if (mismatch) return apiError(...)` block
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const CALLER = 'oid-caller';
const WS = 'ws-1';
const MIRROR = 'md-1';

/** The mirror as STORED: bound to connection C1. */
const STORED = {
  id: MIRROR,
  workspaceId: WS,
  itemType: 'mirrored-database',
  displayName: 'Sales mirror',
  state: { sourceType: 'Snowflake', server: 'fakeorg-fakeacct999', database: 'SALES_DB', connectionId: 'C1' },
  createdBy: 'u',
  createdAt: 't0',
  updatedAt: 't1',
};

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const getSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSession(),
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: async () => null,
}));

const replaced: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    item: () => ({
      read: async () => ({ resource: STORED }),
      replace: async (doc: any) => { replaced.push(doc); return { resource: doc }; },
    }),
  }),
}));

// The route reads the connection again after a successful write, only to report
// `hasSecret`. Not the subject; stubbed so the write path completes.
vi.mock('@/lib/azure/connections-store', () => ({
  loadConnection: async () => ({ id: 'C1', name: 'snowflake-prod', type: 'snowflake', hasSecret: true }),
}));

const mirrorBindingMismatch = vi.fn();
vi.mock('@/lib/azure/connection-auth', () => ({
  mirrorBindingMismatch: (...a: any[]) => mirrorBindingMismatch(...a),
}));

import { POST } from '../route';

const CTX = { params: Promise.resolve({ id: MIRROR }) } as any;

function post(body: Record<string, unknown>) {
  return new NextRequest(
    `http://localhost/api/items/mirrored-database/${MIRROR}/sources?workspaceId=${WS}`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  replaced.length = 0;
  mirrorBindingMismatch.mockReset();
  mirrorBindingMismatch.mockResolvedValue(null);
  getSession.mockReturnValue({ claims: { oid: CALLER, tid: 'tid-1' } });
});

describe('a body with NO connectionId is judged against the stored one', () => {
  it('hands the STORED connection to the binding guard and refuses on a mismatch', async () => {
    mirrorBindingMismatch.mockResolvedValue({
      message: 'Source type does not match this connection (snowflake).',
    });

    const res = await POST(
      post({ sourceType: 'AzureSqlDatabase', server: 'srv.database.windows.net', database: 'appdb' }),
      CTX,
    );

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'AzureSqlDatabase', 'C1');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Source type does not match this connection (snowflake).',
    });
    expect(replaced).toEqual([]);
  });

  it('a body that DOES carry a connectionId is judged against that one', async () => {
    await POST(
      post({ sourceType: 'AzureSqlDatabase', server: 'srv', database: 'appdb', connectionId: 'C2' }),
      CTX,
    );
    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'AzureSqlDatabase', 'C2');
  });
});

describe('POSITIVE CONTROL — an agreeing pair is written', () => {
  it('persists the binding when the guard returns null', async () => {
    const res = await POST(
      post({ sourceType: 'Snowflake', server: 'fakeorg-fakeacct999', database: 'SALES_DB' }),
      CTX,
    );

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'Snowflake', 'C1');
    expect(res.status).toBe(200);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.sourceType).toBe('Snowflake');
    expect(replaced[0].state.connectionId).toBe('C1');
  });
});
