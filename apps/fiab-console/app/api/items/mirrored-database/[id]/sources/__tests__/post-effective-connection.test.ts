/**
 * #4039 — POST /api/items/mirrored-database/[id]/sources refuses to PERSIST a
 * source type that contradicts its connection, judged against the EFFECTIVE
 * connection.
 *
 * WHY THIS SUITE EXISTS. sources/route.ts:124-127 is the sibling of the PATCH
 * guard and carries the same fallback:
 *
 *     const effectiveConnectionId = connectionId !== undefined ? connectionId : state.connectionId;
 *     const mismatch = await mirrorBindingMismatch(s.claims.oid, sourceType, effectiveConnectionId);
 *     if (mismatch) return apiError(mismatch.message, 400);
 *
 * Nothing executed it. `mirror-route-mismatch-guard.test.ts` names this file as
 * a path string and greps its text, which cannot distinguish
 * `connectionId !== undefined ? connectionId : state.connectionId` from a bare
 * `connectionId` — and the bare form is the whole defect: the wizard's "change
 * the source type on an existing mirror" flow posts NO connectionId, so the
 * guard would judge `(sourceType, undefined)`, find nothing to contradict, and
 * write the mismatched binding it exists to refuse.
 *
 * Note the asymmetry with the PATCH handler, which is real and deliberate:
 * `sourceType` here is REQUIRED (`knownSource()` 400s without it), so only the
 * connection has a stored fallback. `knownSource` runs for real — mocking the
 * source-type table would leave a suite that passes with the whole family list
 * deleted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const CALLER = 'oid-caller';
const WS = 'ws-1';
const ITEM = 'md-1';

/** The STORED binding: a Snowflake mirror on connection C1. */
const STORED = {
  id: ITEM,
  workspaceId: WS,
  itemType: 'mirrored-database',
  displayName: 'Sales mirror',
  state: { sourceType: 'Snowflake', server: 'fakeorg-fakeacct999', database: 'SALES_DB', connectionId: 'C1' },
  createdBy: 'u',
  createdAt: 't0',
  updatedAt: 't1',
};

/** Every document handed to Cosmos `replace()` — i.e. every PERSIST. */
const replaced: any[] = [];

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ user: 'u', claims: { oid: CALLER, tid: 'tid-1', upn: 'u@example.test' } }),
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: async () => null,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    item: () => ({
      read: async () => ({ resource: JSON.parse(JSON.stringify(STORED)) }),
      replace: async (doc: any) => {
        replaced.push(doc);
        return { resource: doc };
      },
    }),
  }),
}));

// The Key Vault-backed secret probe is not the subject; it only decides the
// `hasSecret` flag on the response.
vi.mock('@/lib/azure/connections-store', () => ({
  loadConnection: async () => ({ id: 'C1', secretRef: 'kv://fake' }),
}));

const mirrorBindingMismatch = vi.fn();
vi.mock('@/lib/azure/connection-auth', () => ({
  mirrorBindingMismatch: (...a: any[]) => mirrorBindingMismatch(...a),
}));

import { POST } from '../route';

const CTX = { params: Promise.resolve({ id: ITEM }) } as any;
const postReq = (body: any, qs = `?workspaceId=${WS}`) =>
  new NextRequest(`http://localhost/api/items/mirrored-database/${ITEM}/sources${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  replaced.length = 0;
  mirrorBindingMismatch.mockReset();
  mirrorBindingMismatch.mockResolvedValue(null);
});

describe('the EFFECTIVE connection is what gets judged', () => {
  it('a POST with NO connectionId is judged against the STORED connection', async () => {
    await POST(postReq({ sourceType: 'AzureSqlDatabase', server: 'srv.database.windows.net', database: 'appdb' }), CTX);

    expect(mirrorBindingMismatch).toHaveBeenCalledTimes(1);
    // Reading the body's `connectionId` alone would pass `undefined` here, and
    // the guard would find nothing to contradict — the exact hole this asserts.
    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'AzureSqlDatabase', 'C1');
  });

  it('a POST that supplies a connection is judged against THAT one', async () => {
    await POST(
      postReq({ sourceType: 'AzureSqlDatabase', server: 's', database: 'appdb', connectionId: 'C2' }),
      CTX,
    );

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'AzureSqlDatabase', 'C2');
  });
});

describe('a mismatch REFUSES the write', () => {
  it('returns 400 carrying the mismatch message and persists nothing', async () => {
    mirrorBindingMismatch.mockResolvedValue({
      message: 'Source type does not match this connection — no request was sent to either system.',
    });

    const res = await POST(
      postReq({ sourceType: 'AzureSqlDatabase', server: 'srv.database.windows.net', database: 'appdb' }),
      CTX,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/does not match this connection/);
    expect(replaced).toEqual([]);
  });

  it('CONTROL — no mismatch persists the binding and returns 200', async () => {
    const res = await POST(
      postReq({ sourceType: 'AzureSqlDatabase', server: 'srv.database.windows.net', database: 'appdb' }),
      CTX,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.sourceType).toBe('AzureSqlDatabase');
    // The stored connection survives a body that did not mention it.
    expect(replaced[0].state.connectionId).toBe('C1');
  });

  it('the guard runs BEFORE the write, not after it', async () => {
    // Ordering is the difference between refusing a contradiction and recording
    // one and then complaining. A `replace()` that happened first would leave
    // the mismatched binding in Cosmos whatever the response said.
    mirrorBindingMismatch.mockImplementation(async () => {
      expect(replaced).toEqual([]);
      return { message: 'Source type does not match this connection.' };
    });

    await POST(postReq({ sourceType: 'AzureSqlDatabase', server: 's', database: 'appdb' }), CTX);
    expect(mirrorBindingMismatch).toHaveBeenCalledTimes(1);
    expect(replaced).toEqual([]);
  });
});
