/**
 * GET /api/items?type=<itemType>[&workspaceId=<id>][&pageSize=<n>]
 *
 * Legacy single-type list endpoint, BOUNDED (#3728).
 *
 * Callers:
 *  - lib/editors/phase3-editors.tsx:1085 — KQL Queryset "Pin to dashboard"
 *    dialog loads kql-dashboard items.
 *  - lib/editors/phase3-editors.tsx:1125 — KQL Queryset "Set alert" dialog
 *    loads activator items.
 *
 * Both callers do `j?.items || j?.value` so we return `{ ok, items }`.
 *
 * Previously returned 404 HTML, which the editors silently parsed as an
 * empty array — meaning "Pin to dashboard" and "Set alert" dropdowns
 * were ALWAYS empty regardless of whether real items existed in Cosmos.
 *
 * For multi-type queries the established endpoint is
 * /api/items/by-type?type=A&type=B (or ?types=A,B). This route is a thin
 * shim for the single-type form.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * #3728 — THIS ROUTE 504'd AT THE EDGE, AND THAT 504 IS AN HTML PAGE.
 *
 * Measured live on Commercial (signed in, 2026-08-18, head a1155022):
 *
 *   type=lakehouse      504   30079ms      type=notebook        200   9734ms
 *   type=warehouse      504   30083ms      type=data-pipeline   200   2634ms
 *   type=bogus-type-xyz 200     102ms      type=report          200   2401ms
 *
 * A NONEXISTENT type answers in 102ms, so the base Cosmos path is fast and the
 * cost is strictly per-item. The docstring used to say, accurately, that this
 * route "returns every item of the requested type" — there was no pagination at
 * all, and `?type=notebook&limit=1` came back with 582 items because `limit` was
 * not a parameter this route implemented.
 *
 * The failure is worse than slow. Past the 30s Front Door limit the caller gets
 * an HTML gateway-error page, and per this route's own history above a caller
 * doing `j?.items || []` swallows that as an empty list. That is the trap: not
 * an error the user sees, a dropdown that is silently, confidently wrong.
 *
 * So the walk is bounded on BOTH axes (see `listOwnedItemsBounded`), the bound
 * is DISCLOSED in the body rather than applied silently, and the route answers
 * structured JSON in every branch — including the one where it ran out of time.
 * `notebook` at 9.7s was already most of the way to the same cliff, which is why
 * the budget is not lakehouse-specific.
 *
 * NOT CLAIMED: Commercial only. Gov was not measured, here or in #3728, and the
 * item counts that produce these latencies are estate-specific.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from 'next/server';
import { listOwnedItemsBounded } from './_lib/item-crud';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Under the 30s Front Door limit the measured 504 came from, with room for the
 * response to serialise. The point is that the caller receives THIS route's JSON
 * rather than the edge's HTML.
 */
export const maxDuration = 25;

/** Default result bound. Both shipped callers are pickers; neither has ever needed more. */
const DEFAULT_PAGE_SIZE = 200;
/** Hard ceiling a caller may ask for — `/api/items/by-type` is the endpoint for bulk. */
const MAX_PAGE_SIZE = 1000;
/**
 * Server-side wall-clock budget for the walk. Set below `maxDuration` so the route always
 * gets to write a body: a count bound alone cannot promise a latency, because the per-item
 * cost is a workspace-visibility resolution whose worst case is not a function of the row
 * count.
 */
const WALK_BUDGET_MS = 18_000;

export const GET = withSession(async (req: NextRequest, { session }) => {
  const type = req.nextUrl.searchParams.get('type');
  if (!type) {
    return NextResponse.json(
      {
        ok: false,
        error: 'type query parameter is required',
        hint: 'For multi-type queries use /api/items/by-type?type=A&type=B',
      },
      { status: 400 },
    );
  }
  // Optional workspace scope: when the picker passes `workspaceId`, list ONLY
  // that workspace's items (authorized once, partition-scoped) so a picker in
  // Workspace A never shows a sibling workspace's items.
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim() || undefined;

  // `pageSize` is the name `/api/items/by-type` already uses; `limit` is accepted because
  // #3728 measured a caller sending it and being silently ignored, which is precisely the
  // "the parameter looked honoured" failure this fix exists to remove.
  const raw = req.nextUrl.searchParams.get('pageSize') ?? req.nextUrl.searchParams.get('limit');
  const asked = raw === null ? DEFAULT_PAGE_SIZE : Number(raw);
  if (!Number.isFinite(asked) || asked <= 0) {
    return NextResponse.json(
      { ok: false, error: `pageSize must be a positive integer (got ${JSON.stringify(raw)})`, code: 'bad_page_size' },
      { status: 400 },
    );
  }
  const pageSize = Math.min(Math.floor(asked), MAX_PAGE_SIZE);

  try {
    const { items, truncated, scanned } = await listOwnedItemsBounded(type, session.claims.oid, {
      workspaceId,
      session,
      limit: pageSize,
      budgetMs: WALK_BUDGET_MS,
    });
    return NextResponse.json({
      ok: true,
      items,
      pageSize,
      // Disclosed, never silent. A picker that quietly omits half the estate is the same
      // class of lie as the empty array this route's history records.
      truncated: truncated !== false,
      ...(truncated === 'limit'
        ? {
            truncatedBy: 'pageSize',
            hint: `Showing the first ${pageSize} item(s) of type "${type}". Raise pageSize (max ${MAX_PAGE_SIZE}) or use /api/items/by-type for the full set.`,
          }
        : {}),
      ...(truncated === 'budget'
        ? {
            truncatedBy: 'timeBudget',
            scanned,
            hint: `Stopped after ${WALK_BUDGET_MS}ms having scanned ${scanned} row(s) of type "${type}", so this list is INCOMPLETE — it is not "there are no more". Narrow with workspaceId, or use /api/items/by-type.`,
          }
        : {}),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'cosmos_error', code: 'cosmos_error' },
      { status: 500 },
    );
  }
});
