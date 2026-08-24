/**
 * BFF — GET /api/admin/brain/synapses
 *
 * The SYNAPSE layers that do not come from the estate: the RISK lane
 * (`lib/brain/security/**`, nine detectors over a graph of the source) and the
 * EDGE HISTORY lane (W9, #3935). The prune and hot-path lanes are computed on the
 * client from the estate snapshot `/api/admin/brain/graph` already returns —
 * re-fetching the estate here would be a second Resource Graph pull seconds apart
 * from the first, which is precisely what `../_lib/wire.ts` argues against.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────
 * `withTenantAdmin` from `@/lib/api/route-toolkit`, never an inline check. The
 * wrapper matters because the hand-rolled idiom puts the ENTIRE enforcement in
 * the caller's `if`:
 *
 *     const gate = requireTenantAdmin(session);
 *     if (gate) return gate;          // <- THE AUTHORIZATION IS THIS LINE
 *
 * `requireTenantAdmin` returns `NextResponse | null`, so a call whose result is
 * discarded authorizes nothing while still reading as a guard. Deleting that one
 * line on 2026-08-07 defeated authorization on a subscription-scoped ARM deploy
 * path with three merge-blocking controls still printing green.
 *
 * `lib/brain/__tests__/ui/synapse-authz-mutation.test.ts` exercises THIS route
 * through the REAL wrapper — mocking only `getSession` and `requireTenantAdmin`
 * beneath it — and the PR records the measured RCs with that line deleted. A test
 * that mocked `withTenantAdmin` itself would re-implement the guard inside the
 * mock, survive the mutation, and prove nothing.
 *
 * ── WHY THIS ROUTE IS SAFE TO EXPOSE ───────────────────────────────────────
 * It performs no network call at all. The security sweep is pure analysis over
 * data, every remediation it can produce is `DraftedRemediation` — a string, with
 * no callable member and `requiresHumanApproval: true` pinned as a literal — and
 * `assertAllInert` rejects a non-inert one at runtime inside the sweep before it
 * could reach this handler.
 *
 * ── R7 ─────────────────────────────────────────────────────────────────────
 * A sweep that throws is reported as a FAILED sweep, never as a clean one. The
 * detectors throw deliberately on an incoherent population (a detector that
 * judged a node it never enumerated), and swallowing that into `findings: []`
 * would convert a broken detector into a reassuring green — the exact shape this
 * whole surface exists to make impossible.
 */

import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiHonestError, apiOk } from '@/lib/api/respond';
import { buildRiskLayer } from '../_lib/risk-layer';
import { loadEdgeHistory } from '../_lib/edge-history';
import { loadSecurityGraph } from '../_lib/security-source';

/** Always fresh: a cached risk verdict is a stale one. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const GET = withTenantAdmin(async (_req: NextRequest) => {
  try {
    const risk = buildRiskLayer(loadSecurityGraph());
    const history = loadEdgeHistory();
    return apiOk({ risk, history });
  } catch (e) {
    return apiHonestError(
      e,
      500,
      'The security sweep did not complete, so NO risk verdict has been drawn for this estate. ' +
        'A detector throws on an incoherent population — one that judged a subject it never ' +
        'enumerated — and that is a defect in the detector, not a clean result. No partial ' +
        'findings are being shown.',
    );
  }
});
