/**
 * THE ONE data-product discovery decision (GHSA-hf73-rp4q-66pf addendum, #3580).
 *
 * WHY THIS FILE EXISTS. The addendum fix landed on `[id]/ports` — ONE route
 * performing an unscoped cross-partition `SELECT * FROM c WHERE c.id = @id AND
 * c.itemType = @t` on a data product. Its sibling `GET /api/data-products/[id]`
 * runs the SAME query, returns the SAME record — the whole `WorkspaceItem`,
 * `state.ports` included, i.e. the same `abfss://` container paths / Synapse
 * `schema.table` names / ADX database names the ports route was fixed for — and
 * its docblock still said, in as many words, "GET is NOT ownership gated". The
 * posture sentence was identical on both routes; the implementation existed on
 * one. THIS module fixes that second route.
 *
 * THE POPULATION IS NOT TWO — SAY SO PLAINLY. An earlier draft of this comment
 * called them "the two routes", which was wrong and is exactly the kind of
 * false scope claim R7 forbids. Measured at this head, in this worktree:
 *
 *     grep -rln --include=route.ts "FROM c WHERE c.id = @id AND c.itemType" app/api
 *     -> 23 route.ts files repo-wide, 9 of them under app/api/data-products/[id]/
 *
 * Of those 9, THREE carry any authorization symbol at all — counted with
 * `grep -cE "authorizeWorkspace|callerMayDiscover|resolveDiscoveryAccess|
 * resolveDataProductDataAccess|authorizeItemWorkspace"`:
 *
 *     14  [id]/ports/route.ts     — the addendum fix, its own private copy
 *      5  [id]/route.ts           — THIS module, the route being fixed here
 *      2  [id]/preview/route.ts   — resolveDataProductDataAccess (a DIFFERENT
 *                                   decision: approved data access, and it
 *                                   answers 403, see NOT_FOUND below)
 *      0  access-requests · analytics · certification · policies · sla-check ·
 *         subscribers
 *
 * So the six zero-hit routes run the same unscoped query with no
 * workspace/ownership token whatsoever and are NOT audited by this change.
 * Three of them (analytics, sla-check, certification) return derived values
 * rather than the raw item, which lowers the disclosure severity but does not
 * remove it. That is a disclosed gap and a follow-up, NOT a claim that the class
 * is closed: "the decision moves here, once" is 1-of-9, not 1-of-2.
 *
 * That is the shape this repo keeps re-finding: a fix keyed to a LAYER (one
 * route file) rather than to the DECISION, so the next caller of the same
 * decision inherits none of it. So the decision moves here, once.
 *
 * ── THE CONSOLIDATION IS HALF DONE, AND HERE IS EXACTLY WHY ─────────────────
 *
 * `GET /api/data-products/[id]` uses this module. `[id]/ports` STILL CARRIES ITS
 * OWN BYTE-IDENTICAL COPY, and that is a disclosed limitation, not an oversight.
 *
 * Lifting the four symbols out of `ports/route.ts` was written, and it turned
 * `scripts/ci/check-route-guards.mjs` RED:
 *
 *     [route-guards] FAIL — these routes are gated only by getSession() with no
 *     owner/tenant/admin authorization (potential cross-tenant access):
 *       - apps/fiab-console/app/api/data-products/[id]/ports/route.ts  [GET]
 *     violations: 1
 *
 * The route did not become less authorized — it delegated the SAME calls to this
 * file. What broke is that CHECK 2 is a NAME SEARCH over the route's own source
 * (`GUARD_SIGNAL_RE`), and moving `authorizeWorkspace` and `session.claims.tid`
 * out of the file removed the tokens it matches on. The ports route's own
 * docblock already records that measurement: its CHECK-2 signal is
 * `claims.tid`, a WEAK identity signal, and the real authorization it performs
 * was always invisible to that checker.
 *
 * There are two ways past that and only one of them is honest:
 *
 *   - Register `resolveDiscoveryAccess` in `GUARD_SIGNAL_RE` AND in
 *     `GUARD_WRAPPERS` with `mustCall: ['authorizeWorkspace\\s*\\(',
 *     'sameTenantConfirmed\\s*\\(']`, so the checker knows the symbol AND pins
 *     that it stays real. That is the correct fix. It edits
 *     `scripts/ci/check-route-guards.mjs`, which this change does not own.
 *   - Name an export so the substring `authorizeWorkspace` reappears in the
 *     route's text. That is writing a token to satisfy a scanner — the
 *     presence-vs-enforcement failure the checker itself documents — and it
 *     would install an UNPINNED wrapper in `GUARD_SIGNAL_RE`, the specific
 *     hazard `assertGuardWrappersAreReal()` exists to catch. Refused.
 *
 * So `ports/route.ts` is untouched and green, `[id]` is fixed, and the two
 * copies are a KNOWN duplication with a named next step rather than a silent
 * one. A change to the discovery rule must be made in BOTH files until the
 * checker learns the symbol.
 *
 * WHAT THIS MODULE DOES NOT CLAIM. It does not close the timing side-channel
 * (a refusal costs one Cosmos query more than a miss), and it is not a
 * substitute for the per-route decision about WHAT to return once a caller is
 * admitted — see `DiscoveryAccess` below, which deliberately distinguishes the
 * two admitted populations instead of collapsing them into one boolean.
 */
import { type SessionPayload } from '@/lib/auth/session';
import { authorizeWorkspace } from '@/lib/auth/workspace-guard';
import { sameTenantConfirmed } from '@/lib/auth/tenant-boundary';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { resolveLifecycleState, type LifecycleState } from '@/lib/dataproducts/lifecycle';

/** The ONE not-found wording, used for "no such product" AND for "you may not
 *  discover this one". Distinguishing them is what made this an existence
 *  oracle; 404-not-403 is the same choice `authorizeItemWorkspace` makes.
 *
 *  QUALIFIED CLAIM, AND IT IS ROUTE-LOCAL. The two refusals are byte-identical
 *  in CONTENT, not in TIMING: "no such product" returns after one Cosmos query;
 *  "exists but not discoverable" returns after that plus `authorizeWorkspace`
 *  plus a `workspaceTid` query. A timing side-channel therefore remains. It is
 *  low value to an attacker who already holds the Cosmos GUID (neither route is
 *  an enumeration surface — that is why the finding is P2), but "the oracle is
 *  closed" would be an overclaim, so it is stated instead.
 *
 *  AND the oracle is closed ON THIS ROUTE ONLY. `POST [id]/preview` still
 *  answers `403 {code:'access_required'}` for a product that EXISTS but is not
 *  readable by the caller, versus `404` for a miss (`preview/route.ts:68,83`) —
 *  a status-code oracle over the same id space, one path over. That is
 *  pre-existing and untouched here; it is named so this constant's promise is
 *  not read as a property of the data-product API. */
export const NOT_FOUND = 'Data product not found';

/**
 * Lifecycle states a NON-MEMBER may discover.
 *
 * `deprecated` is in the set deliberately, not by omission: DP-9 propagates
 * breaking changes to DOWNSTREAM consumers, and a consumer resolving a
 * dependency they no longer own must still see that it was deprecated — dropping
 * it here would break the deprecation notice that is the whole point of that
 * feature. `retired` and the pre-publish rungs (`draft` / `validated` /
 * `certified`) are not discoverable.
 *
 * Resolved through `resolveLifecycleState`, NOT through raw `state.publishStatus`
 * — DP-1 exists because that is one of three never-synced legacy fields, and a
 * gate reading it directly would call a ribbon-published product Draft.
 */
export const DISCOVERABLE: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'published',
  'deprecated',
]);

/**
 * The Entra tenant (`tid` claim) a workspace belongs to, or null when the doc
 * does not record one. Distinct from `Workspace.tenantId`, which stores the
 * CREATOR's Entra `oid` (see lib/types/workspace.ts) — comparing THAT to a
 * caller's `tid` would compare two different things and always deny.
 */
export async function workspaceTid(workspaceId: string | undefined): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const ws = await workspacesContainer();
    const { resources } = await ws.items
      .query<{ tid?: string }>({
        query: 'SELECT c.tid FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: workspaceId }],
      })
      .fetchAll();
    return resources[0]?.tid ?? null;
  } catch {
    // #3843 — THIS DOES NOT LAND ON A PERMISSIVE BRANCH. It still collapses "no
    // tid recorded" (legacy doc) into "lookup FAILED", and that conflation is
    // still worth a tri-state — tid | null-not-recorded | error-deny — but
    // `resolveDiscoveryAccess` asks `sameTenantConfirmed`, for which BOTH values
    // are a refusal. A Cosmos outage therefore fails closed here rather than
    // making the tenant test pass. The sibling case lives INSIDE
    // `authorizeItemWorkspace` (`lib/auth/workspace-guard.ts`) — the
    // `workspaceId = (await workspaceIdOfItem(...)) || ''` assignment, which puts
    // an item row with a BLANK workspaceId on the permissive branch. It is
    // unrelated to this file and still tracked.
    //
    // Named by SYMBOL rather than by line, because a line number in a comment
    // rots silently and a function name does not.
    return null;
  }
}

/**
 * WHICH population a caller belongs to. A boolean would be enough for the ports
 * route (it returns the same body to both) and is NOT enough for
 * `GET /api/data-products/[id]`, which returns the owner-shaped payload —
 * raw `WorkspaceItem` (with `state.ports`), the edit-dialog `doc`, and the
 * destructive-delete preconditions — and must not hand that to a caller admitted
 * only by the published-in-my-tenant rule.
 *
 *   'member'       — authorized on the OWNING WORKSPACE at any role (owner,
 *                    shared-ACL member, tenant admin). Sees drafts. Sees
 *                    everything the route has.
 *   'discoverable' — NOT a member; the product is published/deprecated AND
 *                    positively confirmed to be in the caller's own Entra
 *                    tenant. Purview-Unified-Catalog catalog reader.
 *   'denied'       — everyone else. 404, not 403.
 */
export type DiscoveryAccess = 'member' | 'discoverable' | 'denied';

/**
 * May this caller discover this product, and as what?
 *
 *   1. Authorized on the OWNING WORKSPACE at any role. `authorizeWorkspace` →
 *      `resolveWorkspaceAccessByOid` runs the #2703 tid boundary from
 *      `session.claims.tid` inside this path, so it needs no separate tenant
 *      test. Draft products are visible here, to the people building them.
 *   2. Otherwise the product must ACTUALLY BE discoverable (published or
 *      deprecated) AND be POSITIVELY CONFIRMED to be in the caller's own Entra
 *      tenant.
 *
 * #3843 — STEP 2 USED TO BE A TRUTHINESS-GUARDED COMPARISON, AND THAT WAS THE
 * ONLY TENANT BOUNDARY LEFT ON THIS PATH. It read
 *
 *     if (ownerTid && session.claims.tid && ownerTid !== session.claims.tid) return false;
 *
 * which decides NOTHING whenever either side is absent and then falls through to
 * `return true`. Step 1 does not cover for it: by the time step 2 runs,
 * `authorizeWorkspace` has already REFUSED, so this line was the last thing
 * standing between an arbitrary caller and the payload.
 *
 * BOTH absences are live, documented, supported states:
 *   - the RECORD side — a workspace doc created before rel-T11 carries no `tid`
 *     (`lib/types/workspace.ts`); and
 *   - the CALLER side — `UserClaims.tid` is optional by design (`lib/auth/msal.ts`,
 *     `lib/auth/session.ts`), and `lib/auth/pat.ts` mints personal access tokens
 *     with no `createdByTid`. With `session.claims.tid` absent the old condition
 *     was false for EVERY published product in EVERY tenant.
 * A third path reached the same permissive branch: `workspaceTid` collapses a
 * Cosmos failure into `null` (see there), so an outage also produced a
 * fall-through.
 *
 * It now uses `sameTenantConfirmed` — the one implementation of this comparison
 * (`lib/auth/tenant-boundary.ts`) — which is a POSITIVE match: an absent tid on
 * either side, and a failed lookup, all refuse.
 *
 * THE TRADE, STATED PLAINLY. A published product in a LEGACY workspace whose
 * `tid` was never stamped is not discoverable by non-members. That is a real
 * narrowing and it is the same one every other consolidated site takes; the
 * remediation is `scripts/csa-loom/backfill-workspace-tid.mjs`, which stamps the
 * tenant onto legacy records. Members, owners and tenant admins of the owning
 * workspace are unaffected — they are admitted by step 1 and never reach step 2.
 */
export async function resolveDiscoveryAccess(
  session: SessionPayload,
  item: WorkspaceItem,
): Promise<DiscoveryAccess> {
  const denied = await authorizeWorkspace(session, item.workspaceId, { allowReadRoles: true });
  if (!denied) return 'member';
  if (!DISCOVERABLE.has(resolveLifecycleState(item.state as Record<string, unknown>))) return 'denied';
  const ownerTid = await workspaceTid(item.workspaceId);
  if (!sameTenantConfirmed(session.claims.tid, ownerTid)) return 'denied';
  return 'discoverable';
}

/*
 * `callerMayDiscover` USED TO BE HERE, AND IS DELETED RATHER THAN KEPT.
 *
 * It was a boolean wrapper over `resolveDiscoveryAccess`, exported, with ZERO
 * callers — measured: `grep -rn callerMayDiscover` finds only `ports/route.ts`'s
 * own module-private copy (`:227`, called at `:254` and `:280`) and its spec.
 * The rationale for keeping it was "so the two forms live together when the
 * consolidation lands", which is a second copy of a SECURITY decision with no
 * caller and no test pinning it: nothing would have gone red if a future edit
 * relaxed it, and the next reader would have found two similar-looking discovery
 * functions and had to work out which one enforces. When `ports/route.ts` can
 * finally delegate (see the file header — it needs `resolveDiscoveryAccess`
 * registered in `check-route-guards.mjs`'s `GUARD_SIGNAL_RE` + `GUARD_WRAPPERS`),
 * it will call `resolveDiscoveryAccess(...) !== 'denied'` directly, which is the
 * whole body this deleted function had.
 */
