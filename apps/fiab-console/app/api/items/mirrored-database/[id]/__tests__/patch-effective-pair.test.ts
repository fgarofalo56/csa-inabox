/**
 * #4039 R7 — PATCH judges the EFFECTIVE (sourceType, connectionId) PAIR.
 *
 * `app/api/items/mirrored-database/[id]/route.ts` refuses to persist a binding
 * whose source type contradicts its connection, and it does that against the
 * pair the mirror would END UP with, not the pair the body happened to carry:
 *
 *     const effSourceType  = String(body?.sourceType ?? state.sourceType ?? '');
 *     const effConnectionId = body?.connectionId !== undefined ? body.connectionId : state.connectionId;
 *     const mismatch = await mirrorBindingMismatch(s.claims.oid, effSourceType, effConnectionId);
 *
 * That fallback is the whole guard. Editing ONLY the source type on a mirror
 * that already holds a Snowflake connection produces exactly the contradiction
 * the mirror-source incident was about — a Snowflake connection read over TDS
 * against a hostname the BFF constructed — and the body alone cannot see it.
 *
 * WHY THIS SUITE EXISTS. The guard was correct and UNWITNESSED: no test imported
 * this handler at all. `mirror-route-mismatch-guard.test.ts` names the file as a
 * PATH STRING, which asserts that a line of source exists, not that a request is
 * refused. Deleting either `?? state.…` fallback left every mirroring test in
 * the tree green.
 *
 * THE MUTATIONS THIS IS BUILT TO CATCH (each RUN, not predicted — see the PR):
 *   R7a  `effConnectionId` -> `body?.connectionId`
 *          the stored connection stops being considered; a source-type-only
 *          edit is never checked.
 *   R7b  `effSourceType`   -> `String(body?.sourceType ?? '')`
 *          the stored source type stops being considered; a connection-only
 *          edit is never checked.
 *   R7c  delete the `if (mismatch) return apiError(...)` block
 *          the contradiction is persisted.
 *
 * WHAT IS DELIBERATELY MOCKED. `mirrorBindingMismatch` is a Key Vault /
 * connection-store read; this suite is about the ARGUMENTS it is handed and what
 * the route does with its answer, which is the part that was untested. The
 * mismatch rules themselves are covered by mirror-source-compat's own suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const CALLER = 'oid-caller';
const WS = 'ws-1';
const MIRROR = 'md-1';

/** The mirror as STORED: Snowflake, bound to connection C1. */
const STORED = {
  id: MIRROR,
  workspaceId: WS,
  itemType: 'mirrored-database',
  displayName: 'Sales mirror',
  description: 'd',
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

// Authorization is NOT the subject here — it has its own suite
// (mirrored-database-workspace-authz.test.ts). Allowed, so every refusal below
// is the binding guard and nothing else.
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: async () => null,
}));

/** Every document handed to Cosmos `replace()` — i.e. every PERSISTED write. */
const replaced: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    item: () => ({
      read: async () => ({ resource: STORED }),
      replace: async (doc: any) => { replaced.push(doc); return { resource: doc }; },
    }),
  }),
}));

const mirrorBindingMismatch = vi.fn();
vi.mock('@/lib/azure/connection-auth', () => ({
  mirrorBindingMismatch: (...a: any[]) => mirrorBindingMismatch(...a),
}));

import { PATCH } from '../route';

const CTX = { params: Promise.resolve({ id: MIRROR }) } as any;

function patch(body: Record<string, unknown>) {
  return new NextRequest(
    `http://localhost/api/items/mirrored-database/${MIRROR}?workspaceId=${WS}`,
    { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  replaced.length = 0;
  mirrorBindingMismatch.mockReset();
  mirrorBindingMismatch.mockResolvedValue(null);
  getSession.mockReturnValue({ claims: { oid: CALLER, tid: 'tid-1' } });
});

describe('the EFFECTIVE pair, not the body', () => {
  it('a sourceType-only edit is judged against the STORED connection', async () => {
    mirrorBindingMismatch.mockResolvedValue({
      message: 'Source type does not match this connection (snowflake).',
    });

    const res = await PATCH(patch({ sourceType: 'AzureSqlDatabase' }), CTX);

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'AzureSqlDatabase', 'C1');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Source type does not match this connection (snowflake).',
    });
    // And nothing was persisted — the refusal is a refusal, not a warning.
    expect(replaced).toEqual([]);
  });

  it('a connectionId-only edit is judged against the STORED source type', async () => {
    mirrorBindingMismatch.mockResolvedValue({ message: 'Source type does not match this connection.' });

    const res = await PATCH(patch({ connectionId: 'C2' }), CTX);

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'Snowflake', 'C2');
    expect(res.status).toBe(400);
    expect(replaced).toEqual([]);
  });

  it('an edit that touches NEITHER field is still judged, on the stored pair', async () => {
    // A rename must not be a way to slip past the guard on a mirror that is
    // already contradictory.
    await PATCH(patch({ displayName: 'renamed' }), CTX);
    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'Snowflake', 'C1');
  });

  it('clearing the connection explicitly (null) is passed through, not replaced by the stored one', async () => {
    // `!== undefined` rather than `??`: an explicit null MEANS "unbind", and
    // silently substituting the stored connection would judge a pair the caller
    // did not ask for.
    await PATCH(patch({ connectionId: null }), CTX);
    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'Snowflake', null);
  });
});

describe('POSITIVE CONTROL — an agreeing pair is written', () => {
  it('persists when mirrorBindingMismatch returns null', async () => {
    const res = await PATCH(patch({ sourceType: 'Snowflake', connectionId: 'C1' }), CTX);

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'Snowflake', 'C1');
    expect(res.status).toBe(200);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.sourceType).toBe('Snowflake');
    expect(replaced[0].state.connectionId).toBe('C1');
  });
});
