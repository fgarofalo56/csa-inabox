/**
 * #4039 — PATCH /api/items/mirrored-database/[id] refuses to PERSIST a source
 * type that contradicts its connection, and it judges the EFFECTIVE pair.
 *
 * WHY THIS SUITE EXISTS. The guard at route.ts:159-163 is three lines:
 *
 *     const effSourceType = String(body?.sourceType ?? state.sourceType ?? '');
 *     const effConnectionId = body?.connectionId !== undefined ? body.connectionId : state.connectionId;
 *     const mismatch = await mirrorBindingMismatch(s.claims.oid, effSourceType, effConnectionId);
 *     if (mismatch) return apiError(mismatch.message, 400);
 *
 * and until now NOTHING executed them. `git grep` found no test importing this
 * handler; `mirror-route-mismatch-guard.test.ts` names the file as a PATH
 * STRING and greps it, which cannot tell a correct fallback from an inverted
 * one. Both halves of the fallback are the entire point: a PATCH that changes
 * ONLY the source type, leaving the stored connection alone, produces exactly
 * the contradiction the incident was about — a Snowflake connection bound to a
 * mirror typed Azure SQL, then dialled over TDS against a hostname the BFF
 * constructed. Reading either field from the BODY alone re-opens it.
 *
 * THE MUTATIONS THIS WAS BUILT TO CATCH, each RUN against this suite rather
 * than predicted (see the PR body for the transcript):
 *
 *   M1  `effConnectionId` -> `body?.connectionId`
 *       (the stored connection stops being considered)
 *   M2  `effSourceType`   -> `String(body?.sourceType ?? '')`
 *       (the stored source type stops being considered)
 *   M3  delete the `if (mismatch) return apiError(...)` line
 *       (the refusal becomes a call whose result is discarded)
 *
 * WHAT IS DELIBERATELY NOT MOCKED: `apiError` and the response shaping run for
 * real, so the 400 and its body are the ones a browser would see.
 * `mirrorBindingMismatch` IS mocked — it is the collaborator whose ARGUMENTS
 * are the subject here; its own compatibility table is covered by
 * lib/azure/__tests__ and re-asserting it would only hide which side is wrong.
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
  description: 'd',
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

// Authorization is covered by mirrored-database-workspace-authz.test.ts. Here it
// is stubbed to ALLOW, so a failure in this suite can only be the binding guard.
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

const mirrorBindingMismatch = vi.fn();
vi.mock('@/lib/azure/connection-auth', () => ({
  mirrorBindingMismatch: (...a: any[]) => mirrorBindingMismatch(...a),
}));

import { PATCH } from '../route';

const CTX = { params: Promise.resolve({ id: ITEM }) } as any;
const patchReq = (body: any, qs = `?workspaceId=${WS}`) =>
  new NextRequest(`http://localhost/api/items/mirrored-database/${ITEM}${qs}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  replaced.length = 0;
  mirrorBindingMismatch.mockReset();
  mirrorBindingMismatch.mockResolvedValue(null);
});

describe('the EFFECTIVE pair is what gets judged', () => {
  it('a PATCH that changes ONLY the source type is judged against the STORED connection', async () => {
    await PATCH(patchReq({ sourceType: 'AzureSqlDatabase' }), CTX);

    expect(mirrorBindingMismatch).toHaveBeenCalledTimes(1);
    // The body supplied no connection, so the stored C1 is the one in play.
    // Reading `body?.connectionId` here would pass `undefined` and the guard
    // would judge a pair that does not exist.
    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'AzureSqlDatabase', 'C1');
  });

  it('a PATCH that changes ONLY the connection is judged against the STORED source type', async () => {
    await PATCH(patchReq({ connectionId: 'C2' }), CTX);

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'Snowflake', 'C2');
  });

  it('a PATCH that changes both passes both', async () => {
    await PATCH(patchReq({ sourceType: 'AzureSqlDatabase', connectionId: 'C2' }), CTX);

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'AzureSqlDatabase', 'C2');
  });

  it('an explicit null connection is passed as null, not silently restored from state', async () => {
    // `!== undefined` is deliberate: clearing the connection is a real edit, and
    // `??` would have quietly re-bound the stored one instead.
    await PATCH(patchReq({ connectionId: null }), CTX);

    expect(mirrorBindingMismatch).toHaveBeenCalledWith(CALLER, 'Snowflake', null);
  });
});

describe('a mismatch REFUSES the write', () => {
  it('returns 400 carrying the mismatch message and persists nothing', async () => {
    mirrorBindingMismatch.mockResolvedValue({
      message:
        'Source type does not match this connection — no request was sent to either system.',
    });

    const res = await PATCH(patchReq({ sourceType: 'AzureSqlDatabase' }), CTX);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/does not match this connection/);
    // THE PROBE THAT SURVIVES A STATUS-CODE-ONLY ASSERTION: the contradiction
    // must never reach Cosmos, whatever the handler returns.
    expect(replaced).toEqual([]);
  });

  it('CONTROL — no mismatch persists the edit and returns 200', async () => {
    const res = await PATCH(patchReq({ sourceType: 'AzureSqlDatabase', connectionId: 'C2' }), CTX);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.sourceType).toBe('AzureSqlDatabase');
    expect(replaced[0].state.connectionId).toBe('C2');
  });
});
