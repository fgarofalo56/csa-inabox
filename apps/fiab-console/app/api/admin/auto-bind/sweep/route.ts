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
 *               limit?: number, cursor?: string }
 *   Response: { ok, dryRun, scanned, excludedByAccess, excludedByWriteAccess,
 *               byDisposition, rows[], truncated, truncatedBy?, nextCursor? }
 *   401 : no session.  403 : caller is not a tenant admin.
 *   400 : the supplied `cursor` could not be unsealed (tampered, malformed, or
 *         minted in another tenant) — fails closed, never a silent restart.
 *   404 : the supplied `workspaceId` is not in scope for this caller — it does
 *         not exist, or it is one they cannot see. NOT 403, and not a 200
 *         carrying a count: see `SweepScopeError`.
 *
 * Both gates come from the route toolkit (`withTenantAdmin` on POST,
 * `withSession` on GET) rather than a hand-rolled `getSession()` prologue —
 * byte-compatible envelopes, one implementation of the check. GET is
 * deliberately session-only, not admin-only: the UI needs `isAdmin:false` back
 * to decide whether to render the button at all, and a 403 there would tell it
 * nothing it could use.
 *
 * ADMIN IS NOT TENANT SCOPE. `withTenantAdmin` proves the caller administers A
 * tenant; it says nothing about WHOSE items the sweep may touch. So the session
 * is threaded into `sweepAutoBind`, which filters every row through
 * `resolveWorkspaceAccessByOid` with this caller's `tid`. Without it the scan is
 * cross-partition and therefore cross-tenant: `{}` from one tenant's admin would
 * report another tenant's item ids and display names, and `{"dryRun":false}`
 * would rewrite their ADF objects. Dropping `session` from the call below is a
 * COMPILE ERROR, not a silent regression — see `SweepOptions`.
 *
 * AND `workspaceId` IS CALLER-CHOSEN INPUT, not merely a filter. A scoped pass
 * used to return `excludedByAccess:5, rows:[]` for a workspace in another
 * tenant, which says it exists and how many sweepable items it holds,
 * narrowable per `itemTypes` — the count was the disclosure, so never naming
 * the rows did not help. `sweepAutoBind` now resolves the scope through the
 * same resolver BEFORE querying and throws `SweepScopeError`; the route's part
 * is answering 404 rather than 403, the same 404-not-403 `route-toolkit.ts:113`
 * uses "so an id can't be probed for existence across tenants".
 *
 * ADMIN IS NOT WRITE ACCESS EITHER. A live pass additionally requires
 * `canWrite` per workspace, because the tenant-admin bypass in the resolver
 * runs AFTER the ACL lookup — so an admin holding an explicit read-only grant
 * (`Viewer`) on someone's workspace resolves read-only, and that is their real
 * authority there. Those rows are reported as `excludedByWriteAccess` and are
 * still visible on a dry-run.
 *
 * DRY-RUN IS THE DEFAULT (`dryRun !== false`), matching admin/lineage/reconcile:
 * a pass that writes to Azure must be asked for in so many words.
 *
 * ## Re-run with `nextCursor` until `truncated` is false
 *
 * The deadline below is deliberately smaller than `maxDuration`, so a large
 * backlog returns a PARTIAL result rather than being killed by the host with
 * nothing to show. A truncated response carries `nextCursor`; send it back as
 * `cursor` and the next pass resumes strictly AFTER the last row this one
 * finished with.
 *
 * `nextCursor` IS OPAQUE — a sealed token, not an id, and the route must keep it
 * that way. The position it encodes is the last row of the RAW Cosmos page,
 * which on a page the access filter emptied is an item id from ANOTHER tenant;
 * the first cut of the cursor returned that verbatim, next to an
 * `excludedByAccess` count whose whole contract is "a COUNT only, naming them
 * would be the cross-tenant disclosure the filter exists to prevent". At
 * `limit:1` that made this endpoint a walkable oracle over every item id in the
 * container. `sweepAutoBind` now seals it; a token that fails to unseal is a 400
 * with an honest message, never a silent restart from the beginning.
 *
 * THE CURSOR IS WHAT MAKES THAT TRUE. Until #3808's review it was not: the scan
 * had no `ORDER BY` and no resume predicate, so every pass re-read the same
 * `TOP n` prefix. Measured over five items at `limit:2`, three live passes all
 * returned `id-1,id-2` — pass 1 `created`, passes 2 and 3 `already-healthy` —
 * and `id-3..id-5` were never reached. Each pass really was cheaper than the
 * last, which is what made the claim look right; cheaper is not further, and any
 * estate larger than the cap could never be fully swept while the operator was
 * being told to keep re-running.
 *
 * Idempotency is the OTHER half and was always real: a repaired item's record
 * carries `seeded:true`, which the sweep's first guard answers with zero
 * control-plane calls, so re-sweeping ground already covered is nearly free.
 *
 * That cheapening depends on a COSMOS WRITE, not on the in-memory merge
 * `autoBindOnOpen` also performs: the next request is a different process and
 * re-reads the document. `persistAutoBindPatch` swallows a failed write by
 * design, so each row now reports `persisted`, and a row with `persisted:false`
 * is the signal that convergence is NOT happening — without it a sweep that
 * re-seeds the same items forever looks identical to one that is working.
 *
 * ## Why an admin route and not the internal scheduler
 *
 * `/api/internal/*` requires `LOOM_INTERNAL_TOKEN`, and the Gov console has
 * never held one — a token-triggered repair would be Commercial-only, which
 * `cloud-parity.md` makes an incomplete feature rather than a phased one. A
 * cookie/MSAL admin gate works in every boundary today.
 *
 * ## NOTHING CALLS THIS YET — #3832
 *
 * `grep -rln "auto-bind/sweep"` returns this file, its spec, and two GENERATED
 * route maps. No admin surface renders a button for it, no workflow dispatches
 * it, and nothing schedules it, so the capability is reachable only by someone
 * who already knows the path. Scheduling it (an ACA Job, so no human has to
 * remember) is the natural follow-up and can call `sweepAutoBind()` directly
 * rather than coming back through HTTP — tracked in #3832, per
 * `no-vaporware.md`'s requirement that a deferred item carry a ticket rather
 * than a sentence. Until that lands, the repair this route performs is
 * available but unrun, and saying otherwise would be the vaporware claim the
 * rule exists to stop.
 */
import { NextRequest } from 'next/server';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { SweepCursorError, SweepScopeError, sweepAutoBind, sweepableItemTypes } from '@/lib/azure/auto-bind-sweep';
import { apiHonestError, apiOk, apiServerError } from '@/lib/api/respond';
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

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  const body = await req.json().catch(() => ({}));
  // Default DRY-RUN: writing to Azure must be explicitly requested.
  const dryRun = body?.dryRun !== false;
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
  const itemTypes = Array.isArray(body?.itemTypes)
    ? body.itemTypes.filter((t: unknown): t is string => typeof t === 'string')
    : undefined;
  const limit = Number.isFinite(body?.limit) ? Number(body.limit) : undefined;
  // The resume token from a previous truncated pass. Validated as a non-empty
  // string only: it is an opaque sealed blob, and `sweepAutoBind` authenticates
  // it (AES-256-GCM + a tenant match) before its plaintext reaches the
  // parameterized `c.id > @cursor` predicate. So this is a shape check, not the
  // trust boundary — that lives in `unsealSweepCursor`.
  const cursor = typeof body?.cursor === 'string' && body.cursor ? body.cursor : undefined;

  try {
    const result = await sweepAutoBind({
      // The caller. Every row is filtered against THIS session's workspace
      // access before it is reported or written to — see the module docblock.
      session,
      dryRun,
      workspaceId,
      itemTypes,
      limit,
      cursor,
      deadlineMs: SWEEP_DEADLINE_MS,
    });
    return apiOk({ ...result });
  } catch (e) {
    // An unusable resume token is the CALLER's input, not a server fault, so it
    // answers 400 with the sweep's own honest message rather than the generic
    // 500. It must NOT degrade to a fresh pass: silently restarting would turn
    // a tampered cursor into a full re-scan — and in live mode a full re-write —
    // that the operator never asked for.
    if (e instanceof SweepCursorError) return apiHonestError(e, 400);
    // A scope the caller cannot reach answers NOT-FOUND, never 403 and never a
    // 200 carrying `excludedByAccess`. Both of those confirm the workspace
    // exists; the count does it more quietly and was the shape that shipped.
    // Same 404-not-403 rule as `route-toolkit.ts:113`, "so an id can't be probed
    // for existence across tenants". The message is a constant, so it cannot
    // vary by cause and reopen the probe through the error path.
    if (e instanceof SweepScopeError) return apiHonestError(e, 404);
    return apiServerError(e);
  }
});
