/**
 * BFF — GET /api/admin/brain/graph
 *
 * THE ONLY read endpoint the Brain surface has, and deliberately so. It returns
 * ONE `BrainSnapshot` carrying the graph AND the findings AND the populations,
 * all derived from a single Azure Resource Graph pull. Splitting the graph and
 * the findings across two routes would let the canvas and the recommendations
 * drift apart between requests, and there would be no way to tell which half
 * was stale — see the doc-block in `../_lib/wire.ts`.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────
 * `withTenantAdmin` from `@/lib/api/route-toolkit`, never an inline check. That
 * wrapper exists because the hand-rolled idiom
 *
 *     const gate = requireTenantAdmin(session);
 *     if (gate) return gate;          // <- THE AUTHORIZATION IS THIS LINE
 *
 * puts the entire enforcement in the caller's `if`. `requireTenantAdmin`
 * returns `NextResponse | null`; a call whose result is discarded is a call
 * that authorizes nothing while still reading as a guard, and deleting that one
 * line once left three route guards in this repo still green.
 * `__tests__/ui/authz-mutation.test.ts` exercises the REAL wrapper (mocking
 * only `getSession` and `requireTenantAdmin` beneath it) and goes RED when the
 * line is removed — a test that mocked `withTenantAdmin` itself would survive
 * the mutation and prove nothing.
 *
 * ── WHY THIS ROUTE IS SAFE TO EXPOSE AT ALL ────────────────────────────────
 * It performs one ARG query — a read — and returns derived analysis. There is
 * no ARM verb reachable from this handler that can create, scale or delete
 * anything, and `RemediationProposal` pins `mutatesAzure: false` as a literal
 * type, so the proposals it ships cannot be actions.
 *
 * ── R7: FAILURES SAY WHAT THEY ESTABLISHED ─────────────────────────────────
 * A collection failure returns the ARG status and what had been read before it
 * failed, NOT an empty estate. An empty snapshot rendered as a clean one is the
 * exact shape of the 2026-08-05 incident, where a swallowed permission denial
 * became a confident false claim.
 */

import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiHonestError, apiOk, apiServerError } from '@/lib/api/respond';
import { ResourceGraphCollectionError } from '../_lib/arg-collect';
import { loadSnapshot } from '../_lib/snapshot';

/** Always fresh: a cached estate reachability verdict is a stale one. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const GET = withTenantAdmin(async (_req: NextRequest) => {
  try {
    const snapshot = await loadSnapshot({
      // Scopes ownership to THIS estate. Absent, any non-empty `loom-estate-id`
      // counts as owned — fine for an estate-wide report, insufficient for a
      // cleanup proposal, which is why `ownership.blind` is reported either way
      // and proposals are withheld when nothing is confirmed.
      ...(process.env.LOOM_ESTATE_ID ? { estateId: process.env.LOOM_ESTATE_ID } : {}),
    });
    return apiOk({ snapshot });
  } catch (e) {
    if (e instanceof ResourceGraphCollectionError) {
      // An HONEST gate: the message names the status and what was read before
      // the failure, so nobody reads a failed pull as an empty estate.
      return apiHonestError(
        e,
        e.status === 403 || e.status === 401 ? 403 : 503,
        `${e.message} (Azure Resource Graph status ${e.status}). ` +
          'The console identity needs Reader on the subscriptions to be reported. ' +
          'NO estate data is being shown, and no reachability verdict has been drawn.',
      );
    }
    return apiServerError(e);
  }
});
