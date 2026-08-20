/**
 * POST /api/admin/auto-bind/sweep — admin-only bulk repair of empty backing objects.
 *
 * The durable counterpart to `autoBindOnOpen`. Create-time binding is
 * best-effort (it races an 8s deadline and never throws, so a slow control
 * plane cannot fail an item create), and the per-open repair only fires when a
 * human happens to open the item — and only for the two item types it is wired
 * into. Neither sweeps the backlog those two facts produce: #3549's 36-of-41
 * pipelines that exist in ADF, report `ok:true`, and hold zero activities.
 *
 * `auto-bind-by-default.md` §3 requires the binding to be SELF-HEALING and §5
 * forbids leaving the user a remediation the platform could have performed. A
 * repair that only runs on open satisfies neither for an item nobody opens.
 *
 * Contract:
 *   Request : { dryRun?: boolean, workspaceId?: string, itemTypes?: string[],
 *               limit?: number }
 *   Response: { ok, dryRun, scanned, byDisposition, rows[], truncated,
 *               truncatedBy? }
 *   401 : no session.  403 : caller is not a tenant admin.
 *
 * Both gates come from the route toolkit (`withTenantAdmin` on POST,
 * `withSession` on GET) rather than a hand-rolled `getSession()` prologue —
 * byte-compatible envelopes, one implementation of the check. GET is
 * deliberately session-only, not admin-only: the UI needs `isAdmin:false` back
 * to decide whether to render the button at all, and a 403 there would tell it
 * nothing it could use.
 *
 * DRY-RUN IS THE DEFAULT (`dryRun !== false`), matching admin/lineage/reconcile:
 * a pass that writes to Azure must be asked for in so many words.
 *
 * ## Re-run until `truncated` is false
 *
 * The deadline below is deliberately smaller than `maxDuration`, so a large
 * backlog returns a PARTIAL result rather than being killed by the host with
 * nothing to show. That is safe because the sweep is idempotent AND each pass
 * strictly cheapens the next: a repaired item's record carries `seeded:true`,
 * which the sweep's first guard answers with zero control-plane calls. So
 * repeated calls converge — they do not re-do work.
 *
 * ## Why an admin route and not the internal scheduler
 *
 * `/api/internal/*` requires `LOOM_INTERNAL_TOKEN`, and the Gov console has
 * never held one — a token-triggered repair would be Commercial-only, which
 * `cloud-parity.md` makes an incomplete feature rather than a phased one. A
 * cookie/MSAL admin gate works in every boundary today. Scheduling this (an ACA
 * Job, so no human has to remember) is the natural follow-up, and it can call
 * the same `sweepAutoBind()` directly rather than this route.
 */
import { NextRequest } from 'next/server';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { sweepAutoBind, sweepableItemTypes } from '@/lib/azure/auto-bind-sweep';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { withSession, withTenantAdmin } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Leaves ~20s of the route's budget to serialize and return a partial result. */
const SWEEP_DEADLINE_MS = 100_000;

/**
 * GET — lightweight probe for the admin UI: is the caller an admin, and which
 * item types would a sweep cover. Session-only, no network, safe for non-admins.
 */
export const GET = withSession(async (_req, { session: s }) => {
  return apiOk({ isAdmin: isTenantAdmin(s), itemTypes: sweepableItemTypes() });
});

export const POST = withTenantAdmin(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  // Default DRY-RUN: writing to Azure must be explicitly requested.
  const dryRun = body?.dryRun !== false;
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
  const itemTypes = Array.isArray(body?.itemTypes)
    ? body.itemTypes.filter((t: unknown): t is string => typeof t === 'string')
    : undefined;
  const limit = Number.isFinite(body?.limit) ? Number(body.limit) : undefined;

  try {
    const result = await sweepAutoBind({
      dryRun,
      workspaceId,
      itemTypes,
      limit,
      deadlineMs: SWEEP_DEADLINE_MS,
    });
    return apiOk({ ...result });
  } catch (e) {
    return apiServerError(e);
  }
});
