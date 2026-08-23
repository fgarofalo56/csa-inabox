#!/usr/bin/env node
/**
 * GUARDRAIL: route-guards  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE: a BFF route that reads or mutates another user's / tenant's data
 *   must authorize the CALLER against that data — not merely confirm the
 *   caller is signed in. `getSession()` alone answers "is someone logged
 *   in", NOT "is THIS user allowed to touch THIS resource". A route that
 *   point-reads / writes a resource by an id taken from the URL with only a
 *   `getSession()` 401 check is a cross-tenant hole: any signed-in user can
 *   pass any id.  (This is exactly the security-roles cross-tenant read that
 *   shipped and was fixed by threading `loadOwnedItem`.)
 *
 * ------------------------------------------------------------------------
 * WHAT THIS CHECKER ACTUALLY DETECTS — and what it does NOT.
 * (#3088 / FINISHLINE C22. The previous header OVERCLAIMED; that overclaim
 * was itself the bug, so this section is normative.)
 *
 * THREE INDEPENDENT CHECKS RUN HERE:
 *
 *   CHECK 1 — GATE CONSUMPTION (scripts/ci/_gate-consumption.mjs).
 *     Every call to a returned-value guard must have its answer CONSUMED in a
 *     decision position. This runs over EVERY route — allowlisted ones too —
 *     because "this route needs no per-resource authorization" never licenses
 *     "call a gate and throw its answer away".
 *
 *     This exists because CHECK 2 is, and can only be, a NAME search. On
 *     2026-08-07 `if (gate) return gate;` was deleted from `app/api/setup/
 *     deploy/route.ts` — the route that submits SUBSCRIPTION-SCOPED ARM
 *     deployments — leaving the `enforceCapability` call in place. Measured:
 *     this checker printed `violations: 0`; so did check-route-toolkit and
 *     check-credential-route-authz. Authorization was fully defeated and every
 *     merge-blocking control in the repo was green, because ENFORCEMENT is a
 *     returned value the caller can silently discard while the NAME stays.
 *
 *     Same class as #2977 below, where `assertOwner` survived only as a word
 *     in a COMMENT. That was fixed for one symbol; the class stayed live for
 *     `enforceCapability`, `requireTenantAdmin`, `denyIfNoDlzAccess`,
 *     `pdpCheck`, `authorizeItemWorkspace`, `authorizeWorkspace` and
 *     `requireWorkspace` — all seven share the `NextResponse | null` contract
 *     and all seven are covered now.
 *
 *   CHECK 2 — GUARD PRESENCE (GUARD_SIGNAL_RE, below), applied PER EXPORTED
 *     HANDLER on comment-, string- AND import-stripped source.
 *
 *     It was applied per FILE on comment/string-stripped source until C22 round 2
 *     (#3122), and both of those gaps were closed only after being MEASURED — a
 *     real route was really broken and this checker really stayed green:
 *
 *       (a) PER FILE, not per handler. `app/api/workspaces/route.ts` had its GET
 *           rewritten to take the listing tenant from `?tenantId=`, and then to
 *           drop the `getSession()` check and the owner-scoped listing outright.
 *           `violations: 0` both times — POST in the same file still mentioned
 *           `session.claims.oid`, and that satisfied the whole file. Every route
 *           pairing a list GET with a create POST was covered by its sibling.
 *
 *       (b) AN IMPORT IS NOT A USE. On `items/activator/[id]/route.ts` every
 *           `loadOwnedItem` / `updateOwnedItem` / `deleteOwnedItem` /
 *           `loadContentBackedItem` CALL was replaced with an unscoped
 *           equivalent and every `session.claims.oid` with a caller-supplied
 *           `?tenantId=`. The only guard-signal occurrences left in the file were
 *           two import lines. `violations: 0`. That is #2977 exactly, with
 *           `import` in place of a comment.
 *
 *     Both are now pinned by SENSITIVITY_PROBES, which re-breaks these routes in
 *     memory on every run and fails if the verdict does not change.
 *
 *   CHECK 3 — ALLOWLIST PREMISE (GHSA-hf73-rp4q-66pf, `falsifiedSharedBackend-
 *     Premise`). CHECK 2 honours the allowlist. It never asked whether the REASON
 *     an entry was written for is still — or was ever — true, so an entry added on
 *     a premise that did not apply stayed green indefinitely.
 *
 *     Measured: 20 routes across 8 item types sat in SHARED_BACKEND_ITEM_ROUTES,
 *     excused as "specific-per-item-TYPE route over a SHARED Azure backend … no
 *     per-tenant Cosmos ownership to scope", while consuming the route `[id]` and
 *     performing no item-level authorization. Severity ran from reading a
 *     product's run history to MINTING A POWER BI EMBED TOKEN for a dashboard the
 *     caller did not own.
 *
 *     The second clause of that reason is falsifiable INSIDE THIS TREE: if a
 *     SIBLING route under `items/<same type>/[id]/**` resolves the same `[id]`
 *     through an item-ownership resolver, then `[id]` names an ownable Loom item
 *     and ownership demonstrably IS scopeable. Two routes under one item type
 *     cannot both be right about what `[id]` means. So the premise is tested, not
 *     trusted — and the test RE-KEYS ITSELF: the moment any route under a type
 *     adopts an owner check, every allowlisted sibling of that type is re-judged.
 *
 *     Pinned by `assertPremiseTestIsSensitive`, which every run un-graduates a
 *     real fixed route back into the allowlist, strips its guard IN MEMORY, and
 *     fails unless CHECK 3 catches it — CHECK 2 stays green on that state, which
 *     is exactly why the class survived as long as it did.
 *
 * WHAT IS STILL NOT PROVEN HERE (stated so no one reads more into a green run
 * than it earns):
 *   - That the capability id / required role / workspace is the RIGHT one.
 *     Consumption proves a decision is acted on, not that the decision is
 *     correct. Reviews and per-route contract tests own that.
 *   - **A bare `claims.oid` / `claims.tid` proves the token is PRESENT in the
 *     handler, not that it AUTHORIZES anything.** It is satisfied just as well by
 *     an audit field. Measured, and the reason two shipped holes survived every
 *     CI gate: `items/dashboard/[id]` PUT passed on
 *     `sanitizeOverlay(id, body, session.claims.upn || session.claims.oid)` — the
 *     overlay's `savedBy` ATTRIBUTION — while overwriting any tenant's overlay by
 *     id; `databricks-notebook/[id]/versions` POST passed on `savedBy:
 *     session.claims.oid` for the same reason. Both are fixed (they now call
 *     `authorizeItemWorkspace`), but the SIGNAL remains weak by construction.
 *     Removing bare `claims.*` from GUARD_SIGNAL_RE was measured on 2026-08-08:
 *     it takes the tree from 0 violations to 205, i.e. ~205 routes hand-roll an
 *     owner-scoped Cosmos query rather than calling a named guard. Converting
 *     those to `withWorkspaceOwner` / `authorizeItemWorkspace` is a scoped
 *     program, not a checker tweak, and until it happens a green run does NOT
 *     mean every `claims.oid` in the tree is load-bearing.
 *   - Routes with NO session call at all are SKIPPED, not passed — see
 *     GETSESSION_RE. **Measured 2026-08-08: 119 route files with a data surface
 *     are outside the remit, not one.** (1640 data-surface files, 1521 scanned.)
 *     A previous revision of this header asserted "exactly ONE route in the tree
 *     is skipped … `app/api/embed/query/route.ts`" and invited the reader to
 *     treat a moving `scanned` as the alarm. That was wrong by 118, and it is
 *     recorded here rather than quietly corrected because a false invariant in a
 *     security control's own documentation is how the next reader gets misled.
 *     Of the 119, 39 carry a guard signal anyway (they route through a helper
 *     such as `guardAdxRequest` or `resolveAdminWorkspace`, which calls
 *     `getSession()` in ANOTHER module) and 80 carry none. Making the remit fail
 *     closed — in scope unless explicitly excused — is the right shape and is
 *     NOT done here; it needs those 80 triaged first.
 *     **2026-08-14 (GHSA-v2g8-gp3r-rg4r): the remit is now fail-closed for the
 *     NOW_GUARDED set only.** Measured while graduating that advisory's routes:
 *     replacing `guardAdxItemRequest(` with a non-guard call in
 *     `items/graph-model/[id]/materialize/route.ts` left `violations: 0`,
 *     because a route whose session lives in a HELPER matches the remit only
 *     through the helper's NAME — so deleting the call removed the route from
 *     the remit as well as from the guard, and NOW_GUARDED (whose stated purpose
 *     is "if a future edit drops the guard, the checker re-flags them") was
 *     inert for it. Graduated routes are therefore in remit unconditionally now.
 *     The broader 80-route triage is still NOT done.
 *   - **A wrapper `mustCall` used to be matched against the WHOLE MODULE.**
 *     Measured 2026-08-14: replacing `resolveItemDatabase(item)` with
 *     `defaultDatabase()` inside `guardAdxItemRequest` — i.e. handing every
 *     caller a database NOT resolved from the item, which is the entirety of
 *     GHSA-v2g8-gp3r-rg4r — left this checker GREEN, because a SIBLING function
 *     in the same file still called `resolveItemDatabase`. `mustCall` is now
 *     evaluated against the wrapper's OWN body (namedExportBody), and an
 *     unlocatable body fails closed.
 *   - **This checker still cannot see the GHSA-v2g8-gp3r-rg4r class in
 *     general.** That class is "a handler reaches a data-plane client with a
 *     RESOURCE COORDINATE taken from the request body rather than from a
 *     resolved item" — `body.database` into `.purge`, `body.sourceDatabase`
 *     into a cross-database `.set-or-append`. Nothing here follows a VALUE; the
 *     two checks are a name search and a consumption check. Detecting it needs
 *     intra-file taint plus a registry of which PARAMETER POSITIONS of which
 *     data-plane clients are coordinates rather than payloads (`kql` and `sql`
 *     are legitimately caller-authored; `database` and `table` are not). That
 *     registry does not exist and is a piece of work in its own right, so it is
 *     named here as a known gap rather than approximated with a grep that would
 *     read green for the same reason this one did.
 * ------------------------------------------------------------------------
 *
 * SCOPE (the directories where this hole class lives):
 *   - apps/fiab-console/app/api/items/[type]/[id]/**\/route.ts
 *       the GENERIC per-item handlers — they operate on ANY Cosmos-owned
 *       item by (type, id) and MUST scope to the owner/tenant.
 *   - apps/fiab-console/app/api/items/<type>/[id]/**\/route.ts
 *       the SPECIFIC-per-item-TYPE handlers (e.g. data-agent/[id],
 *       activator/[id], map/[id], kql-dashboard/[id]). These were previously
 *       treated as out-of-scope on the theory that a per-type route only ever
 *       touches a single SHARED Azure resource resolved by type. That theory
 *       was WRONG for the subset that read/mutate a per-tenant Cosmos item (or
 *       a per-item source descriptor / bound database) by the URL [id] — those
 *       are the exact cross-tenant holes that shipped on data-agent/[id]/
 *       source-schema, activator/[id]/adx-source, and adx/anomaly. They are now
 *       IN scope: a genuinely shared-by-type route must be ALLOWLISTED with a
 *       reason; an ownable one must thread loadOwnedItem / an admin gate.
 *   - apps/fiab-console/app/api/adx/**\/route.ts
 *       the ADX / KQL data-plane query routes — they run tenant data on the
 *       SHARED ADX cluster and MUST resolve the target database from an
 *       owner-checked item (guardAdxRequest / loadKustoItem) or gate on a
 *       tenant admin, never a free-form caller-supplied database.
 *   - apps/fiab-console/app/api/admin/**\/route.ts
 *       admin surfaces — must gate on a tenant-admin / capability check, not
 *       just a logged-in session.
 *
 * WHAT COUNTS AS AUTHORIZED (any one of these signals in the handler file):
 *   - a named owner/tenant/admin guard:
 *       loadOwnedItem, updateOwnedItem, deleteOwnedItem,
 *       authorizeWorkspace, requireWorkspace, requireTenantAdmin,
 *       isTenantAdmin, isTenantAdminTier, requireDomainRole, enforceCapability
 *   - the caller identity threaded into the data access:
 *       session.claims.oid / .tid / .tenantId  (owner-scoped Cosmos reads)
 *   - a domain / DLZ / policy gate:
 *       denyIfNoDlzAccess, pdpCheck, loadContentBackedItem
 *
 * A route is FLAGGED when it exports a mutating handler (POST/PUT/PATCH/
 * DELETE) OR a GET (returns data), calls getSession(), matches NONE of the
 * signals above, and is not in the ALLOWLIST below.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY:
 *   Only for routes that legitimately need no per-resource authorization —
 *   e.g. a handler that operates on a SHARED Azure backend resolved purely by
 *   item TYPE (no per-tenant Cosmos ownership to check), or a self/public
 *   endpoint. Add the repo-relative path to ALLOWLIST with a one-line reason.
 *   Prefer FIXING the route (thread `loadOwnedItem` / an admin gate) over
 *   allowlisting — allowlisting an ownable resource re-opens the hole.
 *   NOTE an allowlist entry does NOT exempt a route from CHECK 1, and the
 *   SHARED_BACKEND_ITEM_ROUTES class reason does not exempt it from CHECK 3:
 *   THE REASON YOU WRITE IS A CLAIM ABOUT THE CODE AND IT WILL BE RE-TESTED.
 *   If a sibling under the same item type already scopes that `[id]` by item,
 *   the class reason does not cover your route — fix it, or give it its own
 *   entry saying what the code actually does.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findDiscardedGateResults, stripCommentsAndStrings, RETURNED_VALUE_GATES } from './_gate-consumption.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

const API_ROOT = path.join(CONSOLE_ROOT, 'app', 'api');

/**
 * ── STRONG signals: tokens that ESTABLISH ownership of the route's own item ──
 *
 * Split out from the weak identity tokens below by GHSA-v2g8-gp3r-rg4r's
 * seventh pass, and the split is MEASURED rather than stylistic. See
 * {@link OWNERSHIP_SIGNAL_RE}.
 */
const STRONG_OWNERSHIP_SIGNALS = [
    'loadOwnedItem', 'updateOwnedItem', 'deleteOwnedItem',
    // #2977 — `assertOwner` USED TO BE LISTED HERE AND IS DELIBERATELY GONE.
    // PR #2973 DELETED the function (see lib/auth/workspace-guard.ts), so from
    // that merge on, every `assertOwner` in the tree was PROSE — the word inside
    // a migration comment. It kept matching, so 34 routes that had correctly
    // moved to `authorizeItemWorkspace` were passing this checker (and were
    // classified `owner-scoped` in the route inventory) on the strength of a
    // COMMENT MENTIONING A DELETED FUNCTION, not on any code. Rewriting one such
    // route's header comment — with the real guard untouched and STRENGTHENED —
    // flipped it to a violation, which is how this was found.
    //
    // Replaced by the real thing: `authorizeItemWorkspace` runs the canonical
    // owner → tenant-admin → shared-ACL ladder and resolves the workspace FROM
    // THE ITEM when the caller omits the param, so a route threading it is
    // authorized exactly as a hand-rolled loadOwnedItem route is. Do not re-add
    // `assertOwner`: a token that can only ever appear in prose is not a signal.
    'authorizeItemWorkspace',
    // #2988 — `authorizeNotebookItem(` is the databricks-notebook EXECUTION
    // family's guard wrapper. It is matched AS A CALL (trailing `\(`), never as
    // a bare word, so a `{@link authorizeNotebookItem}` in a comment cannot
    // satisfy it — the specific way `assertOwner` lied above. The wrapper itself
    // is verified structurally by `assertGuardWrappersAreReal()` below, so
    // hollowing it out fails this checker instead of silently disarming it.
    'authorizeNotebookItem(?:<[^()]*>)?\\s*\\(',
    // #2996/#2997 - the databricks-job and databricks-pipeline guard wrappers.
    // Matched AS CALLS (trailing open-paren) for the same reason
    // `authorizeNotebookItem` is: a {@link ...} in a comment must never satisfy a
    // guard signal, which is exactly how `assertOwner` lied. Both are verified
    // structurally by `assertGuardWrappersAreReal()` below, so hollowing either
    // one out fails this checker instead of silently disarming it.
    'authorizeDatabricksJobItem(?:<[^()]*>)?\\s*\\(',
    'authorizeDatabricksPipelineItem(?:<[^()]*>)?\\s*\\(',
    // GHSA-v8r7-c2p5-mjf2 — `withBoundSqlServer(` is the Azure SQL / PostgreSQL
    // item-route guard (`app/api/items/_lib/sql-server-scope.ts`). It composes on
    // `withWorkspaceOwner`, resolves the target server from the item's bound
    // connection, and admits that binding against `loomSubscriptionScope()`.
    // Matched AS A CALL, so a `{@link withBoundSqlServer}` in prose cannot
    // satisfy it — the way `assertOwner` lied.
    //
    // ADDED TO GETSESSION_RE AND generate-route-inventory's SESSION_RE/OWNER_RE
    // IN THE SAME CHANGE, deliberately. Measured on this advisory: with the six
    // routes hardened but the name unlisted, `scanned session-based routes` fell
    // from 1526 to 1520 — the guard moved into a wrapper and the routes silently
    // left the checker's REMIT, which is the same under-reporting the ADX pass
    // recorded and the `guard-adoption gap` this repo has been bitten by before.
    'withBoundSqlServer(?:<[^()]*>)?\\s*\\(',
    // ...and its LAYER-1-ONLY sibling, for the four routes in the same family
    // whose server is a caller PICK rather than the item's binding —
    // `[id]/create-db` (the database does not exist yet) and the two
    // `[id]/databases` discovery GETs plus `azure-sql-server`'s (they run so the
    // user can CHOOSE what to bind, and the unified editor calls one of them in
    // the same tick it sets the selection, racing its own bind effect). Those
    // routes carry Layer 1 here + Layer 3 via `admitPickedServer` at the call
    // site; forcing Layer 2 on them would 409 the legitimate flow, which is a
    // dead end and not a boundary (`auto-bind-by-default.md`).
    //
    // Matched AS A CALL, and its substance is pinned by
    // `assertGuardWrappersAreReal()` below, so hollowing it out fails this run
    // instead of silently disarming all four.
    //
    // ADDED TO GETSESSION_RE AND generate-route-inventory's SESSION_RE/OWNER_RE
    // IN THE SAME CHANGE — the FIFTH recorded reproduction of that lockstep
    // rule, and the numbers here are MEASURED, not reasoned. Simulating
    // "hardened but registered nowhere" (this token removed AND the four
    // NOW_GUARDED entries below removed) takes `scanned session-based routes`
    // from 1526 to 1523, with `violations: 0` throughout — three routes leaving
    // the checker's REMIT entirely, silently, on the change that fixed them.
    //
    // THREE, NOT FOUR, and the difference is the useful part: `[id]/firewall`
    // stays in remit because it adopted `withBoundSqlServer`, which was already
    // registered. Only the three `withOwnedSqlItem` routes vanish. A guard is
    // invisible to this file for exactly as long as its NAME is, which is why
    // the number is written down rather than described.
    //
    // NOTE the count does NOT move with this token alone removed: NOW_GUARDED is
    // fail-closed and holds a graduated route in remit regardless. That is the
    // protection working — and it is also why the honest measurement had to
    // remove both, rather than one and assume.
    'withOwnedSqlItem(?:<[^()]*>)?\\s*\\(',
    // ...and its OWNER-RESOLUTION half, used directly by the routes in that
    // family that cannot adopt the wrapper — `[id]/connect` (it WRITES the
    // binding the wrapper reads, so there is nothing to resolve yet), `[id]/query`
    // and `[id]/copilot` (they resolve their target through
    // `resolveOwnedSqlTarget` rather than the wrapper's ctx).
    //
    // LEGITIMATE AS A SIGNAL because its substance is asserted structurally a few
    // hundred lines below, in this same file: the `loadOwnedSqlItem` entry of
    // `assertGuardWrappersAreReal()` requires it to call
    // `loadOwnedItem(id, itemType, session.claims.oid, …)`. So this is not a name
    // standing in for a check — the check is pinned separately and the run fails
    // if it ever stops being the canonical owner/workspace-ACL read. Same basis
    // as `loadKustoItem` / `guardAdxRequest` below.
    //
    // ADDED IN LOCKSTEP with generate-route-inventory's OWNER_RE, per the rule
    // that file records THREE separate reproductions of. MEASURED here on the
    // fourth: replacing `withWorkspaceOwner('azure-sql-database', …)` on
    // `[id]/query` with `withSession` + `loadOwnedSqlItem` (so an item of any of
    // the six slugs that drive that URL stops 404ing) made this checker report
    // that route as `violations: 1` — "gated only by getSession()" — while the
    // route was being HARDENED, not weakened. That is the same under-reporting
    // the siblings above describe, reproduced by the fix itself.
    'loadOwnedSqlItem\\s*\\(',
    // #3572 — `authorizeStorageAccount(` bounds which storage account a caller
    // may drive the Console UAMI at: the deployment's own lake (any session),
    // DLZ authority (tenant/domain admin), or an account a lakehouse in the
    // caller's OWN tenant is bound to. Matched AS A CALL, so a `{@link ...}` in
    // a comment cannot satisfy it — the way `assertOwner` lied. Kept in lockstep
    // with OWNER_RE in generate-route-inventory.mjs.
    'authorizeStorageAccount(?:<[^()]*>)?\\s*\\(',
    // GHSA-v2g8-gp3r-rg4r — `guardAdxItemRequest(` is the item-route form of
    // `app/api/adx/_shared.ts::guardAdxRequest` (already a signal below), for the
    // `items/<type>/[id]/**` handlers whose item id arrives as a route param
    // rather than `?id=`. It runs getSession + the canonical
    // `authorizeItemWorkspace` ladder and resolves the ADX database FROM THE
    // ITEM. Matched AS A CALL, never as a bare word, so a `{@link …}` in a
    // comment cannot satisfy it — the specific way `assertOwner` lied above —
    // and its substance is verified by `assertGuardWrappersAreReal()` below, so
    // hollowing it out fails this checker instead of silently disarming every
    // consumer.
    'guardAdxItemRequest(?:<[^()]*>)?\\s*\\(',
    // GHSA-v2g8-gp3r-rg4r (round 3) — `guardSynapseItemRequest(` is the same
    // contract for the SHARED Synapse SQL estate (`warehouse`,
    // `synapse-*-sql-pool`) and for the `[type]/[id]/**` dispatchers that also
    // reach Databricks/Unity Catalog. Same substance bar: it runs getSession +
    // the canonical `authorizeItemWorkspace` ladder and resolves the database
    // FROM THE ITEM, and `assertGuardWrappersAreReal()` below pins that return
    // expression so hollowing it out fails this checker rather than silently
    // disarming every consumer. Matched AS A CALL, so a `{@link …}` cannot
    // satisfy it.
    'guardSynapseItemRequest(?:<[^()]*>)?\\s*\\(',
    // createOwnedItem / the recycle-bin + list helpers all resolve the caller's
    // workspace ownership (session.claims.oid partition) INSIDE the helper, so a
    // route that threads one of them is owner-scoped even without a literal
    // claims.oid in the handler.
    'createOwnedItem', 'softDeleteOwnedItem', 'restoreOwnedItem',
    'purgeRecycledItem', 'loadRecycledItem', 'listOwnedItems', 'listAllOwnedItems',
    'authorizeWorkspace', 'requireWorkspace', 'requireTenantAdmin',
    'isTenantAdmin', 'isTenantAdminTier', 'requireDomainRole', 'enforceCapability',
    // domain-tier / DLZ-pane / ops-admin gates: tenant-admin OR domain-admin
    // (canAccessDlzPanes / isAtLeastDomainAdmin) or a purpose-built ops-admin
    // role (callerIsOpsAdmin) — all real admin-tier authz, not a bare session.
    'canAccessDlzPanes', 'isAtLeastDomainAdmin', 'isAtLeastDomainContributor', 'callerIsOpsAdmin',
    'denyIfNoDlzAccess', 'pdpCheck', 'loadContentBackedItem',
    // ADX/KQL data-plane owner-checks: guardAdxRequest owner-checks the bound
    // kql-database item (session.claims.oid → loadKustoItem) + config gate;
    // loadKustoItem / resolveOwnedItemDatabase thread the caller tenant into
    // the item read the same way loadOwnedItem does.
    'guardAdxRequest', 'loadKustoItem', 'resolveOwnedItemDatabase',
    // WS-D1 route-toolkit: `withWorkspaceOwner(itemType, …)` runs the exact
    // loadOwnedItem owner/workspace-ACL check internally, so a route that adopts
    // it is authorized the same as a hand-rolled loadOwnedItem route. (withSession
    // and withBackendGate are NOT guard signals — session/gate are not authz.)
    'withWorkspaceOwner',
    // R1 route-toolkit wrappers: `withTenantAdmin(…)` runs the exact
    // requireTenantAdmin check and `withDlzAccess(pane, …)` runs the exact
    // denyIfNoDlzAccess check internally, so a route that adopts either is
    // authorized the same as its hand-rolled equivalent.
    'withTenantAdmin', 'withDlzAccess',
    // C22 (#3088): `withCapability(capabilityId, role, handler)` runs the exact
    // `enforceCapability` check and returns its 401/403 response unchanged. It
    // is the NON-DISCARDABLE form of the idiom this checker was blind to: with
    // the wrapper there is no returned value for a caller to drop, so the
    // handler cannot run unauthorized while the name stays in the file. Its
    // substance is verified by assertGuardWrappersAreReal() below.
    'withCapability',
    // Item-level ACL resolver (rel-T87): resolveItemAccessByOid chains owner →
    // workspace ACL → per-item grant under the tid boundary (lib/auth/item-access.ts),
    // so a route threading it is fully authorized (not a bare session).
    'resolveItemAccessByOid', 'resolveWorkspaceAccessByOid',
    // C22 round 2 (#3122): `tenantScopeId(session)` IS the caller's tenant —
    // `session.claims.tid || session.claims.oid` (lib/auth/session.ts), verified
    // structurally by assertGuardWrappersAreReal(). It is exactly as strong as
    // the `claims.tid` / `claims.oid` signals already accepted, and it is the
    // idiom the tenant-partitioned Cosmos stores use (marketplace, mesh,
    // assets/freshness). Its absence here was not a judgement that it is weak —
    // the file-level check never needed it, because some SIBLING handler always
    // carried a `claims.oid`. Moving to per-handler scoping exposed that gap, so
    // it is named now rather than allowlisting a dozen correctly-scoped routes.
    // Matched AS A CALL so `{@link tenantScopeId}` in prose cannot satisfy it.
];

/**
 * ── WEAK signals: the caller's identity is PRESENT, but nothing established
 *    that it may reach THIS item ───────────────────────────────────────────
 *
 * These stay in {@link GUARD_SIGNAL_RE} — removing them there would re-flag
 * hundreds of correctly-scoped tenant-partitioned routes, which is a separate
 * triage and not a security fix. They are EXCLUDED from
 * {@link OWNERSHIP_SIGNAL_RE}.
 */
const WEAK_IDENTITY_SIGNALS = [
  'tenantScopeId\\s*\\(',
    // C22 round 2 (#3122): OPTIONAL CHAINING must match. `s?.claims?.oid` is the
    // idiom when the session may be null (api/iq/mcp resolveTenant), and the
    // literal-dot form `claims\.oid` silently missed it — a route could hold a
    // real, session-derived tenant boundary and still read as unguarded. That is
    // a false NEGATIVE for the checker's remit test and a false POSITIVE for its
    // violation list, depending on where the token sits; both are wrong.
    'claims\\??\\.\\s*oid', 'claims\\??\\.\\s*tid', 'claims\\??\\.\\s*tenantId',
];

const GUARD_SIGNAL_RE = new RegExp(
  [...STRONG_OWNERSHIP_SIGNALS, ...WEAK_IDENTITY_SIGNALS].join('|'),
);

/**
 * ── THE GRADUATED SET'S OWN SIGNAL — strong tokens only ─────────────────────
 *
 * MEASURED ON 2026-08-17, while graduating `databricks-sql-warehouse/[id]/query`
 * under GHSA-v2g8-gp3r-rg4r. Deleting that route's ENTIRE Layer 1 — the
 * `guardSynapseItemRequest` call and its refusal, byte delta -158 — left this
 * checker at `violations: 0`. The same deletion on its sibling `[id]/start`
 * (graduated by #3665, same `withSession<{id}>` shape) went RED immediately.
 *
 * The difference is the FinOps attribution receipt this route carries and that
 * one does not:
 *
 *     void recordQueryRun({ tenantId: tenantScopeId(session),
 *                           userOid: session.claims.oid, … });
 *
 * `tenantScopeId(` and `claims.oid` are both members of GUARD_SIGNAL_RE, so a
 * BILLING RECORD satisfied the ownership test and the handler reported no gap.
 *
 * THIS IS THE ADVISORY'S OWN FINDING, REPRODUCED INSIDE ITS OWN CHECKER. The
 * advisory records that `items/databricks-sql-warehouse/[id]/query` published
 * `owner-scoped` in the route inventory because "its only owner-shaped tokens
 * were `routeParams.id` and `session.claims.oid`, both inside the attribution
 * receipt", and states the general form: *presence read as enforcement*.
 * `_route-auth-scope.mjs` (#3625/#3643) was rewritten to stop doing that. This
 * file had not been, so the SAME route defeated the SAME way twice, one control
 * apart.
 *
 * WHY THE FIX IS SCOPED TO NOW_GUARDED RATHER THAN GLOBAL — and the number is
 * MEASURED HERE, not reasoned. Forcing `strong` on for every route yields
 *
 *     [route-guards] violations: 210
 *
 * i.e. 210 routes are currently judged on a weak identity token and nothing
 * else. Re-flagging all of them in a security fix is how a control gets widened
 * back open by whoever has to silence it. (A DIFFERENT measurement is sometimes
 * quoted alongside this one and they must not be conflated: the advisory's "271
 * of 773 owner-scoped rows rested on a `claims.*` token" is about the ROUTE
 * INVENTORY's published column, produced by `_route-auth-scope.mjs`, not about
 * this checker's population. 210 is this file's number.)
 *
 * NOW_GUARDED is different in kind: it is the set of routes this checker has
 * been TOLD carry a real per-item owner check, and its stated promise is that
 * "if a future edit drops the guard, the checker re-flags them". Accepting an
 * attribution token there makes that promise false. So the graduated set — and
 * only it — must show a STRONG signal. This STRICTLY TIGHTENS: every route
 * outside NOW_GUARDED keeps exactly the judgement it had, so the change creates
 * no new blind spot. What it does NOT do is fix the general case — those 210
 * remain, and "presence read as enforcement" is untouched for them.
 *
 * Same scoping precedent, and the same reasoning, as the fail-closed remit rule
 * further down: "deliberately scoped to the graduated set rather than to all
 * 119 — the broader remit change still needs those 80 triaged first".
 */
const OWNERSHIP_SIGNAL_RE = new RegExp(STRONG_OWNERSHIP_SIGNALS.join('|'));


// A route "exports a data surface" when it exports a mutating/GET handler as
// EITHER `export async function GET` (classic) OR `export const GET = …`
// (the WS-D1 route-toolkit idiom: `export const GET = withWorkspaceOwner(…)`).
const MUTATING_EXPORT_RE = /export\s+(?:async\s+function\s+(?:POST|PUT|PATCH|DELETE)\b|const\s+(?:POST|PUT|PATCH|DELETE)\s*=)/;
const GET_EXPORT_RE = /export\s+(?:async\s+function\s+GET\b|const\s+GET\s*=)/;
// A route is "session-based" (in this check's remit) when it calls getSession()
// directly OR routes through the WS-D1 toolkit wrappers (which call getSession
// internally). Including the wrappers keeps toolkit-adopted routes IN scope so
// the checker still verifies their guard rather than silently skipping them.
//
// C22 (#3088) — `(?:<[^()]*>)?` is NOT cosmetic. 104 routes call the wrappers
// with an explicit type argument (`withSession<{ id: string }>(…)`), which the
// bare `\s*\(` form does not match. They were nonetheless counted as
// session-based because their HEADER COMMENTS say "Route-toolkit: withSession
// (R1/R3)" — a space before the paren, so the comment matched where the code
// did not. That is #2977 again, verbatim: a control passing on prose. Now that
// matching runs on comment-stripped source the prose is gone, so the pattern
// has to match the real call.
const GETSESSION_RE = /getSession\s*\(|with(?:Session|WorkspaceOwner|BackendGate|TenantAdmin|DlzAccess|Capability|BoundSqlServer|OwnedSqlItem)(?:<[^()]*>)?\s*\(|authorize(?:NotebookItem|DatabricksJobItem|DatabricksPipelineItem)(?:<[^()]*>)?\s*\(/;

// ── Allowlist: routes that legitimately need no per-resource authorization.
// Repo-relative POSIX paths. Each MUST carry a reason.
const ALLOWLIST = new Map([
  // N3 Flight SQL connect payload: returns DEPLOYMENT-WIDE connection guidance
  // only — the Flight endpoint's exposure, the audited ticket-mint URL on the
  // caller's own origin, and static client snippets that reference the reader's
  // OWN env var. It reads no tenant data, names no internal host, and carries no
  // secret (snippetIsSecretFree re-checks every body). There is no per-tenant
  // resource to own-scope; the credential path itself is POST /api/flightsql/session,
  // which mints only for the authenticated caller and audits every issuance.
  ['apps/fiab-console/app/api/flightsql/connect/route.ts', 'deployment-wide connection guidance + secret-free snippets; no per-tenant resource to scope; the ticket-mint half is self-scoped and audited'],
  // N8 lab 3 — S3-compatible ADLS gateway connect info: deployment-wide config
  // read (the gateway endpoint from LOOM_S3_GATEWAY_URL + secret-free connect
  // snippets + the native abfss/IRC path). Reads no tenant data, names no secret
  // (the snippet tells the user to supply their own key), and has no per-tenant
  // resource to own-scope — a shared Azure backend resolved by env, like the
  // flightsql/connect guidance route above.
  ['apps/fiab-console/app/api/s3-gateway/info/route.ts', 'deployment-wide S3-gateway connect info + secret-free snippets; no per-tenant resource to scope'],
  // UDF execution endpoints READ half: returns `configuredUdfEndpoints()`, which
  // is a pure function of THREE env vars (LOOM_UDF_FUNCTION_BASE,
  // LOOM_UDF_ALLOWED_FUNCTION_BASES, LOOM_UDF_FUNCTION_KEY_SECRET) — the handler
  // takes no `[id]`, reads no request body, opens no Cosmos container and calls
  // no Azure data plane, so its response is byte-identical for every caller in
  // the deployment and there is no resource an owner check could be about.
  //
  // THE PREMISE, STATED SO IT CAN BE FALSIFIED: this is not a
  // SHARED_BACKEND_ITEM_ROUTES-style claim about what an `[id]` means — this
  // route has no `[id]` at all, so CHECK 3's sibling test cannot apply to it,
  // and the entry stops being true the moment the handler reads a param, a body
  // or an item. `keySecretName` is a Key Vault secret NAME (the same name-only
  // shape /api/keyvault/secret-names ships); the material is read server-side by
  // the invoke route with the Console UAMI and is never in this payload.
  //
  // WHAT DOES *NOT* PROVE THAT, MEASURED RATHER THAN ASSUMED: an earlier
  // revision of this comment cited check-credential-route-authz.mjs as "the
  // control on that, and it passes". It does pass — by NOT SCANNING THIS ROUTE.
  // That checker's population is routes calling a CREDENTIAL_SINKS function
  // (`listAccountKeys`, `regenerate*Key`, …) and it `continue`s before
  // `scanned += 1` on a zero-hit file. This route calls none, so its green is
  // silence, not evidence. Nor does it cover the invoke route, which reaches
  // Key Vault through `getKeyVaultSecretValue` — also not a listed sink. The
  // control that actually holds the no-material claim for THIS route is its own
  // suite (`endpoints/__tests__/route.test.ts`), which asserts the response
  // carries `keySecretName` as a name plus `acceptsPushedSource`, and nothing
  // else; the invoke route's material handling is held by
  // `invoke/__tests__/route.secret-egress.test.ts`.
  ['apps/fiab-console/app/api/items/user-data-function/endpoints/route.ts', 'deployment-wide approved-endpoint list derived purely from env; no [id], no body, no Cosmos, no data plane — no per-tenant resource to scope, and key-secret NAMES only, never material'],
  // RUM1 browser-telemetry ingest: WRITE-ONLY beacon sink (page-load timings /
  // Web Vitals / scrubbed errors → App Insights). There is NO per-tenant
  // resource to own-scope — the route reads nothing back and forwards
  // aggregate-only, PII-scrubbed envelopes with no user identifier. Session
  // gates abuse (plus per-oid rate limit + 64KB/30-item caps); the READ half
  // lives at /api/admin/rum behind withTenantAdmin.
  ['apps/fiab-console/app/api/telemetry/rum/route.ts', 'write-only PII-scrubbed telemetry sink; no per-tenant resource to scope; rate-limited + size-capped; admin read half is tenant-admin-gated'],
  // FLAG0 runtime kill-switch READ half: returns only { flagId: boolean } for
  // the flags in the typed RUNTIME_FLAGS registry — deployment-wide operational
  // state with NO per-tenant/per-owner resource to scope (like a feature-flag
  // CDN read). Session-gated read-only; the WRITE half lives under
  // /api/admin/runtime-flags/[id] behind requireTenantAdmin.
  ['apps/fiab-console/app/api/runtime-flags/route.ts', 'deployment-wide registered-flag booleans; read-only, no per-tenant resource; write path is admin-gated'],
  // Self-hosted map tile proxy (Gov OSS Azure-Maps replacement): fronts the
  // internal-ingress MapLibre tileserver, which serves a SHARED OSS basemap
  // (OpenMapTiles) identical for every tenant — there is no per-tenant resource
  // to own-scope. Session-gated (no anonymous tile scraping); the tileserver
  // host never leaks to the browser.
  ['apps/fiab-console/app/api/maps/tiles/[...path]/route.ts', 'shared OSS basemap tileserver proxy resolved by type; no per-tenant resource'],
  // Bulk access-request decision (access-governance W4, AG-14): delegates each
  // leg to POST /api/access-requests/[id]/decision, which enforces the real
  // per-request approver check (actorMayApprove over that request's approvalPlan
  // + isTenantAdmin). A blanket inline admin gate would be WRONG here — named
  // non-admin approvers are legitimately allowed per-request — so authorization
  // is correctly delegated per leg, not duplicated at the batch entry point.
  ['apps/fiab-console/app/api/access-requests/bulk-decision/route.ts', 'bulk wrapper: per-leg delegation to [id]/decision enforces the real per-request approver check; no batch-level owner scope applies'],
  // Feedback intake is deliberately session-OPTIONAL (rel-T15/B16): anonymous
  // auto-error reports are accepted but hard-throttled + deduped server-side;
  // bug/feature kinds require a session INSIDE the handler. No per-tenant
  // resource exists to own-scope — the write target is the product's GitHub
  // repo via a server-held token.
  ['apps/fiab-console/app/api/feedback/route.ts', 'session-optional by design (rel-T15): anonymous auto-error intake is rate-limited + deduped; bug/feature require session in-handler'],
  // WS-10.4 Living Marketplace product read: the unified `marketplace` catalog is
  // a TENANT-WIDE exchange (any tenant member browses it). getProduct scopes the
  // Cosmos point-read by tenantScopeId(session) as the partition key, so a caller
  // can only ever read their own tenant's products — there is no per-item owner to
  // scope (subscribe/certify DO carry their own checks). Same shared-by-tenant
  // class as the other allowlisted catalog reads.
  ['apps/fiab-console/app/api/marketplace/products/[id]/route.ts', 'tenant-wide marketplace catalog read; Cosmos PK = tenantScopeId(session) → no cross-tenant access, no per-item owner'],
  // Generic per-item handlers that operate on a SHARED Azure backend resolved
  // by item TYPE (warehouse/AOAI/etc.) — no per-tenant Cosmos ownership to
  // scope; gated by getSession + a type gate.
  //
  // GHSA-v8r7-c2p5-mjf2 — FIVE ENTRIES USED TO SIT IN THIS BLOCK AND ARE GONE.
  // Three were false and are now fixed; two were true once and had gone STALE.
  // They are recorded here rather than reworded, because the WORDING is the
  // recorded root cause of this whole advisory section: four of the five shared
  // the sentence "over a shared Azure backend resolved by item type", and a
  // reason that is accurate about a SIBLING BRANCH — or about a PREVIOUS
  // revision of the file — reads as verified.
  //
  //   [type]/[id]/security    "security-scan over a shared Azure backend
  //     resolved by item-type gate". FALSE. `resolveWarehouseId`'s own
  //     doc-comment says it "honours an explicit warehouseId", and `catalog`
  //     came off the query string / body. Both reached `ucSql` — `CREATE OR
  //     REPLACE FUNCTION`, `ALTER TABLE … SET MASK` / `SET ROW FILTER` and the
  //     DROPs — on Unity Catalog as the Console MI, with `[id]` never even
  //     destructured. Dropping a column mask is the highest-severity effect in
  //     this advisory's second sweep.
  //   [type]/[id]/alerts      "analytics alerts over a shared Azure backend
  //     resolved by item type". FALSE, and not even branch-true: the backend
  //     split is `isGovCloud()`, an ENVIRONMENT read, and the alert acted on is
  //     named by `?alertId=`. All four verbs took `_ctx` — the author's own
  //     signal the params were unread — so any session could list, create,
  //     modify and DELETE alert rules.
  //   [type]/[id]/monitoring  "read-only monitoring over a shared Azure backend
  //     resolved by item type". "read-only" is true; "resolved by item type" is
  //     true of the Synapse branch and FALSE of the Databricks branch, which
  //     REQUIRES a caller-supplied `?warehouseId=` and returned that warehouse's
  //     query history — other tenants' submitted `query_text`.
  //   [type]/[id]/optimize    STALE, not false. Both adopted
  //   [type]/[id]/statistics  `guardSynapseItemRequest` in GHSA-v2g8-gp3r-rg4r
  //     round 3 and were graduated into NOW_GUARDED then; these entries were the
  //     old reason left behind. NOW_GUARDED wins over the allowlist today, so
  //     they were INERT — but an inert stale entry is exactly the mask this
  //     file's own SQL block documents ("guard stripped + entry deleted →
  //     violations: 0"), and it re-arms silently if that precedence is ever
  //     edited. Deleted for the same reason the SQL entries were.
  //
  // All five are in NOW_GUARDED below, so dropping a guard RE-FLAGS instead of
  // falling back to a class reason nobody re-tested.
  ['apps/fiab-console/app/api/items/[type]/[id]/assist/route.ts', 'AOAI assist resolved by item type; no per-tenant Cosmos read'],
  ['apps/fiab-console/app/api/items/[type]/[id]/explain/route.ts', 'AOAI explain grounded on the caller-supplied live definition; no per-tenant Cosmos read'],
  // WS-2.3 AI/BI "Explain this metric" AI-authored viz: a stateless AOAI transform
  // that picks a chart encoding from the caller-supplied columns + sample rows; no
  // per-tenant Cosmos item read by id (same class as [type]/[id]/explain + the
  // ai-enrich sample probe). Session-gated; the chart is validated against the real
  // column list before it is returned.
  ['apps/fiab-console/app/api/analytics/visualize/route.ts', 'stateless AOAI chart-recommendation grounded purely on caller-supplied columns/sample rows; no per-tenant Cosmos read'],
  // GHSA-v8r7-c2p5-mjf2 — `[type]/[id]/{monitoring,optimize,security}` used to
  // sit here; see the block comment above this group. All three are in
  // NOW_GUARDED.
  // GHSA-v8r7-c2p5-mjf2 — `[type]/[id]/sql-security` USED TO SIT HERE, with the
  // reason "SQL security over a shared Azure backend resolved by item-type gate".
  // THE ENTRY IS DELETED RATHER THAN REWORDED, and that distinction is the point.
  //
  // The reason was TRUE OF TWO BRANCHES and false of the third. `resolveBackend`
  // is named as though the item TYPE selects the backend, and for the Synapse
  // branches it does — they read LOOM_SYNAPSE_WORKSPACE /
  // LOOM_SYNAPSE_DEDICATED_POOL from the environment and ignore `opts` entirely.
  // The `azure-sql-database` family took `server` and `database` straight off the
  // REQUEST (`searchParams` on GET, the body on POST) and handed them to
  // `azureSqlExecute` — TDS with an Entra token as the Console UAMI — so any
  // authenticated session read that database's full security catalog and
  // executed generated DDL/DCL there. `[id]` reached no ownership call on either
  // verb.
  //
  // That is why a REWORDED entry would have been the wrong fix: a reason
  // accurate about a sibling branch reads as verified, which is exactly how this
  // one survived a sweep that explicitly examined the family. The route now
  // carries Layer 1 (`loadOwnedSqlItem`) on both verbs plus Layer 2+3
  // (`resolveOwnedSqlTarget`) on the Azure SQL branch, so it passes CHECK 2 on a
  // real guard signal and needs no excuse at all.
  //
  // `[type]/[id]/statistics` used to sit on the line below with the reason
  // "read-only statistics over a shared Azure backend resolved by item type". It
  // was STALE, not false — see the block comment above this group.

  // ── GHSA-v8r7-c2p5-mjf2 — the three tabled routes that are OUT OF CLASS ──
  //
  // Recorded per-route rather than left under the class default, because the
  // advisory's own lesson is that an inherited reason is not evidence. Each was
  // re-derived from the handler and its client, not from the previous triage:
  // the question is not "does it authorize" (none of the three does more than
  // `getSession()`) but "does it carry a SERVER / DATABASE / ARM-id coordinate
  // that reaches the Console UAMI", which is the class this advisory records.
  // If any of them ever grows one, it re-enters the class and this reason is
  // wrong — which is exactly why the coordinate each one DOES take is named.
  //
  // maintenance-configs — takes `location` ONLY, and it reaches
  // `GET /providers/Microsoft.Maintenance/publicMaintenanceConfigurations`, a
  // TENANT-level read of MICROSOFT-PUBLISHED configurations. No subscription, no
  // resource group, no customer resource. `location` is URL-encoded into an
  // OData `$filter` VALUE and never into a path segment, so it cannot redirect
  // the request either.
  ['apps/fiab-console/app/api/items/azure-sql-database/[id]/maintenance-configs/route.ts', 'GHSA-v8r7-c2p5-mjf2 OUT OF CLASS: takes `location` only; reads tenant-level Microsoft-published publicMaintenanceConfigurations, location goes into an encoded $filter value not a path segment — no server/database/ARM-id coordinate'],
  // principal-search — a Microsoft Graph directory search (`q`, `kind`). No ARM,
  // no server, no database, no resource id; it cannot reach a database backend
  // at all. Out of THIS class. It does let any authenticated session run a
  // directory lookup as the app identity, which is a separate and much smaller
  // question (and adding an owner check would break the picker on an unsaved
  // `id === 'new'` item) — tracked in the advisory, not fixed here.
  ['apps/fiab-console/app/api/items/azure-sql-database/[id]/principal-search/route.ts', 'GHSA-v8r7-c2p5-mjf2 OUT OF CLASS: Microsoft Graph principal search over `q`/`kind`; no ARM call, no server/database/resource-id coordinate'],
  // query/cancel — takes `requestId` and looks it up in `liveRequests`, an
  // IN-PROCESS Map of live mssql `Request` objects on one replica. It sends a TDS
  // ATTENTION packet on an ALREADY-OPEN connection that `[id]/query` (itself
  // fully guarded) established; it opens nothing, names no server or database,
  // and returns no data. The id is a client-generated UUIDv4 that no route ever
  // discloses, so there is no cross-user reach to bound.
  ['apps/fiab-console/app/api/items/azure-sql-database/[id]/query/cancel/route.ts', 'GHSA-v8r7-c2p5-mjf2 OUT OF CLASS: takes `requestId` into an in-process live-request Map and sends TDS ATTENTION on a connection [id]/query already opened; no server/database/ARM-id coordinate, opens nothing, returns no data'],

  // Admin routes gated by getSession + org-scoped Cosmos queries (every read
  // binds the caller tenant) or reading deployment-wide config only.
  ['apps/fiab-console/app/api/admin/bootstrap-catalogs/route.ts', 'seeds deployment-wide catalogs; org-scoped, admin surface'],
  ['apps/fiab-console/app/api/admin/copilot-usage/route.ts', 'tenant-scoped usage read; org aggregate'],
  ['apps/fiab-console/app/api/admin/data-products-backend/route.ts', 'deployment-wide backend config read'],
  ['apps/fiab-console/app/api/admin/deploy-plan/cost-estimate/route.ts', 'stateless cost estimator; no per-tenant data'],
  ['apps/fiab-console/app/api/admin/domains/images/route.ts', 'org-scoped domain image read'],
  ['apps/fiab-console/app/api/admin/domains/purview-status/route.ts', 'deployment-wide Purview status read'],
  ['apps/fiab-console/app/api/admin/load-sample-data/route.ts', 'loads sample data into the deployment ADX; admin surface'],
  ['apps/fiab-console/app/api/admin/mcp-servers/bridge/route.ts', 'deployment-wide MCP bridge config'],
  ['apps/fiab-console/app/api/admin/mcp-servers/builtin/route.ts', 'static built-in MCP catalog read'],
  ['apps/fiab-console/app/api/admin/mcp-servers/route.ts', 'admin gate + SSRF egress guard owned by sibling PR #1599 (requireTenantAdmin on POST/PUT); excluded here to avoid a merge conflict — remove this entry once #1599 lands'],
  ['apps/fiab-console/app/api/admin/mcp-servers/test-connection/route.ts', 'stateless connectivity probe; admin gate + egress guard owned by sibling PR #1599; no per-tenant data'],
  ['apps/fiab-console/app/api/admin/tenant-settings/groups/route.ts', 'ambient-tenant group read (Graph); tenant is from the token'],
  // AI-enrichment "test on a sample" probe (SVC-1/SVC-8): stateless call over the
  // deployment's SHARED Azure Cognitive Services backend (doc-intel/vision/
  // language/translator/content-safety) resolved by the [service] segment. No
  // per-tenant Cosmos resource is read/written — auth = signed-in + Console-UAMI
  // RBAC, exactly like the content-safety BFF routes.
  ['apps/fiab-console/app/api/items/ai-enrich/[service]/preview/route.ts', 'stateless cognitive-services sample probe resolved by [service]; no per-tenant Cosmos data'],
  // External (cross-tenant) data sharing (FGC-30). Each route IS scoped to the
  // caller, but via tenantScopeId(session)/email-match rather than a signal the
  // heuristic recognizes: `received` lists ONLY shares whose targetEmail == the
  // caller's own email (self endpoint, no id from the URL); `[id]` GET/DELETE
  // load the share then reject unless share.tenantId === tenantScopeId(session);
  // `[id]/accept` rejects unless the caller's own email === share.targetEmail
  // (only the addressed guest may accept). No cross-tenant hole.
  ['apps/fiab-console/app/api/external-shares/received/route.ts', 'recipient self-endpoint: returns only shares addressed to the caller\'s own email'],
  ['apps/fiab-console/app/api/external-shares/[id]/route.ts', 'GET/DELETE verify share.tenantId === tenantScopeId(session) before returning/revoking'],
  ['apps/fiab-console/app/api/external-shares/[id]/accept/route.ts', 'accept verifies caller email === share.targetEmail (only the addressed guest may accept)'],
  // WS-9 Sovereign Agent Mesh registry (PK /tenantId, per-tenant config like
  // mcp-servers). Every store call keys on tenantScopeId(session) as the Cosmos
  // PARTITION key (getMeshAgent/listMeshAgents/upsert/delete/executeMeshTask all
  // take that tenantId), so a URL [id] from another tenant resolves to nothing —
  // no cross-tenant read/write. Scoped via tenantScopeId(session) rather than a
  // signal the heuristic recognizes (same class as external-shares above).
  ['apps/fiab-console/app/api/mesh/agents/[id]/route.ts', 'GET/PUT/DELETE key on tenantScopeId(session) (Cosmos PK /tenantId); a cross-tenant id resolves to nothing'],
  ['apps/fiab-console/app/api/mesh/run/route.ts', 'runs only agents from the caller\'s own tenant registry (listMeshAgents(tenantScopeId(session)))'],
  ['apps/fiab-console/app/api/mesh/catalog/route.ts', 'returns the static Tier-0 tool catalog + deployment egress profile; no per-tenant Cosmos read by id'],
  ['apps/fiab-console/app/api/mesh/a2a/[id]/card/route.ts', 'reads the agent by tenantScopeId(session) (Cosmos PK /tenantId) then publishes its A2A card; publishA2A-gated'],
  ['apps/fiab-console/app/api/mesh/a2a/delegate/route.ts', 'loads the target by tenantScopeId(session) (Cosmos PK /tenantId) + gates on publishA2A before delegating'],
  // Loom App Runtime (DBX-1) type-level config: returns the fixed runtime-template
  // catalog (static) + the deployment-wide Container Apps/ACR infra status. No
  // per-tenant Cosmos resource — auth = signed-in + deployment RBAC. The per-item
  // routes (loom-app-runtime/[id]/**) thread resolveItemAccessByOid and pass on
  // their own owner-check.
  ['apps/fiab-console/app/api/items/loom-app-runtime/config/route.ts', 'static runtime-template catalog + deployment-wide Loom Apps infra status; no per-tenant Cosmos data'],
  // DBX-6 metric-view default backend: compiles a client-supplied spec + runs
  // read-only SQL against the SHARED Synapse Dedicated pool resolved purely from
  // env config (LOOM_SYNAPSE_*) — same shared-backend class as the allowlisted
  // /api/warehouse navigator; no per-tenant Cosmos resource read by id.
  ['apps/fiab-console/app/api/semantic-model/metric-view/route.ts', 'compile + read-only run against the shared Synapse Dedicated pool resolved by env config; no per-tenant Cosmos read'],
  // Azure Maps static-raster PROXY: resolves the SHARED deployment Azure Maps
  // credential (AAD token / key) server-side and streams a clamped basemap PNG.
  // The rendered basemap is NOT item-scoped and no credential reaches the client
  // — auth = signed-in; there is no per-tenant resource to owner-check.
  ['apps/fiab-console/app/api/maps/static/route.ts', 'server-side Azure Maps static-basemap proxy over the shared deployment Maps account; params clamped, no credential to the client, no per-tenant Cosmos read'],

  // ── C22 round 2 (#3122) — surfaced by PER-HANDLER scoping ─────────────────
  // These are NOT new routes and NOT newly unguarded. Each was already
  // session-only; the file-level test simply never asked, because a SIBLING
  // handler in the same file carried a signal. Every reason below was checked
  // against the backing helper's source, not inferred from the route — the
  // failure mode this whole change exists to end is a control believed on the
  // strength of a name.
  //
  // Handler-scoped where the file is MIXED, so the guarded halves stay pinned.

  // AML environments: GET/POST list+register environment versions on the
  // deployment's SINGLE AML workspace (ARM by name via the Console UAMI) — the
  // `api/aml/` class-A navigator, allowlisted one directory up. PATCH is the
  // odd one out: `?action=attach` writes the chosen environment onto a per-tenant
  // NOTEBOOK item, which is why this file is in NOW_GUARDED. Only the shared-
  // backend halves are excused; PATCH must keep passing on its own owner-check.
  ['apps/fiab-console/app/api/aml/environments/route.ts', { handlers: ['GET', 'POST'], reason: 'list/register AML environment versions on the deployment-shared AML workspace (ARM by name); the per-tenant notebook attach lives in PATCH and is NOT excused here' }],

  // Freshness policies: `listAssetDocs(session)` / `getAssetDoc(session, key)`
  // (lib/assets/asset-store.ts) both take `tenantOf(session)` as the Cosmos
  // PARTITION KEY and as the `c.tenantId = @t` predicate — READ AND CONFIRMED at
  // asset-store.ts:41-51 and :68-78. An assetKey from another tenant resolves to
  // nothing. Same class as the (B) session-scoped stores allowlisted by prefix.
  ['apps/fiab-console/app/api/assets/freshness/route.ts', { handlers: ['GET'], reason: 'asset-store partitions every read by tenantOf(session) (verified lib/assets/asset-store.ts:41-78); a cross-tenant assetKey resolves to nothing' }],

  // Deployment-wide operational reads — no per-tenant resource exists to scope.
  ['apps/fiab-console/app/api/admin/mcp-servers/deploy/route.ts', { handlers: ['GET'], reason: 'reads deployment-wide MCP files/ACA config from env (readMcpFilesConfig); no per-tenant resource. The DEPLOY half is not excused' }],
  ['apps/fiab-console/app/api/spark/session-pool/route.ts', { handlers: ['GET'], reason: 'deployment-wide Spark session-pool status (getPoolStatus, in-process counters); no per-tenant resource' }],
  ['apps/fiab-console/app/api/items/[type]/[id]/ai-function/route.ts', { handlers: ['GET'], reason: 'returns the static AI-function NAME list + deployment capability/gate flags from env; ignores [id] entirely, reads no per-tenant data' }],
  ['apps/fiab-console/app/api/learn/notebook-import/route.ts', { handlers: ['GET'], reason: 'lists the deployment-wide Learn notebook-import CATALOG (static bundle content); the POST that installs into a workspace is not excused' }],
  ['apps/fiab-console/app/api/demo/deploy/route.ts', { handlers: ['GET'], reason: 'delegates to GET /api/workspaces WITH THE CALLER\'S OWN COOKIE and counts the result — authorization is performed by that route, which is owner-scoped; this handler adds no data access of its own' }],
  ['apps/fiab-console/app/api/iq/mcp/route.ts', { handlers: ['GET'], reason: 'static MCP server descriptor (protocol version, tool names, auth modes) — no session read, no per-tenant data. POST authorizes via resolveTenant(req) and is not excused' }],

  // Shared Azure backends resolved by ARM/data-plane name, same class as the
  // service-navigator prefixes above.
  ['apps/fiab-console/app/api/items/azure-sql-managed-instance/route.ts', { handlers: ['GET'], reason: 'lists SQL Managed Instances in the deployment subscription (ARM by name via Console UAMI); POST threads createOwnedItem and is not excused' }],
  ['apps/fiab-console/app/api/items/release-environment/[id]/swap/route.ts', { handlers: ['GET'], reason: 'lists App Service deployment SLOTS for a caller-named resourceGroup+site over the deployment subscription (ARM); [id] is unused, no per-tenant Cosmos read' }],
  ['apps/fiab-console/app/api/items/prompt-flow/[id]/route.ts', { handlers: ['PUT', 'DELETE'], reason: 'AI Foundry prompt-flow update/delete against the deployment Foundry project resolved by ?project= (data-plane by name) — the api/foundry/ class-A backend; no per-tenant Cosmos item' }],
  ['apps/fiab-console/app/api/dq/monitors/route.ts', { handlers: ['GET', 'DELETE'], reason: 'Databricks Lakehouse-Monitoring + Delta constraints for a caller-named table on the deployment-shared Databricks workspace — the api/databricks/ class-A backend; no per-tenant Cosmos item' }],

  // Self-endpoint: the caller can only ever mint a token FOR THEMSELVES.
  ['apps/fiab-console/app/api/developer/tokens/route.ts', { handlers: ['POST'], reason: 'self-endpoint: createPatToken binds the new token to the CALLER\'s own session; patCannotMint(session) additionally blocks token-authenticated callers from minting further tokens' }],
]);

// ── Specific-per-item-TYPE routes over a SHARED Azure backend ────────────────
// These operate on a single deployment-shared Azure resource resolved by item
// TYPE + the id in the URL (a live ARM/data-plane resource id: cluster, SQL
// warehouse, ADX cluster, ADF factory, Databricks workspace, Power BI/AAS,
// Dataverse, APIM, …). Auth = signed-in + the deployment's Console-UAMI RBAC —
// there is NO per-tenant Cosmos ownership to scope, so getSession() + a type
// gate is the intended authorization. They are IN the widened scan scope but
// legitimately need no per-resource owner-check. Newly ADDED here as part of
// widening the checker to items/<type>/[id]/** — pre-existing routes, not the
// ones fixed in this change (data-agent/[id]/source-schema, activator/[id]/
// adx-source, map/[id]/geocode, adx/anomaly now pass on their own real gates).
// A NEW route under one of these type dirs that reads/mutates a per-tenant
// Cosmos item by [id] must thread loadOwnedItem / an admin gate — do NOT extend
// this list to cover an ownable route.
const SHARED_BACKEND_ITEM_ROUTES = [
  'apps/fiab-console/app/api/items/adf-dataset/[id]/route.ts',
  'apps/fiab-console/app/api/items/adf-pipeline/[id]/connections/route.ts',
  'apps/fiab-console/app/api/items/adf-trigger/[id]/route.ts',
  'apps/fiab-console/app/api/items/adf-trigger/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/[id]/predict/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/[id]/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/[id]/train/route.ts',
  'apps/fiab-console/app/api/items/ai-foundry-project/[id]/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/dag-runs/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/dags/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/task-logs/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/operations/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/revisions/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/spec/route.ts',
  'apps/fiab-console/app/api/items/apim-api/[id]/test-call/route.ts',
  'apps/fiab-console/app/api/items/apim-policy/[id]/route.ts',
  'apps/fiab-console/app/api/items/apim-product/[id]/apis/route.ts',
  'apps/fiab-console/app/api/items/apim-product/[id]/route.ts',
  'apps/fiab-console/app/api/items/apim-product/[id]/subscriptions/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/maintenance-configs/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/principal-search/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/query/cancel/route.ts',
  'apps/fiab-console/app/api/items/compute/[id]/route.ts',
  'apps/fiab-console/app/api/items/compute/[id]/start/route.ts',
  'apps/fiab-console/app/api/items/compute/[id]/stop/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-action/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-agent/[id]/directline-token/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-agent/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-agent/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-analytics/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-channel/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-knowledge/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-topic/[id]/route.ts',
  'apps/fiab-console/app/api/items/copilot-template-library/[id]/route.ts',
  // NOTE: this one is GRADUATED — see NOW_GUARDED below. It is kept here only
  // because the class list is historical; the "no per-tenant Cosmos ownership to
  // scope" premise was never true for it (ID-addressed, and its own siblings
  // scope it), and it now runs withWorkspaceOwner.
  'apps/fiab-console/app/api/items/copy-job/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/cosmos-db/[id]/gremlin/route.ts',
  'apps/fiab-console/app/api/items/cosmos-db/[id]/metrics/route.ts',
  'apps/fiab-console/app/api/items/cosmos-gremlin-graph/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/pin/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/tile-embed-token/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/tile-query/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/approval-logicapp/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/connections/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/debug/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/evaluate/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/integration-runtimes/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/jobs/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/output/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/triggers/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/validate/route.ts',
  'apps/fiab-console/app/api/items/data-product-template/[id]/instantiate/route.ts',
  'apps/fiab-console/app/api/items/data-product-template/[id]/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/[id]/events/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/[id]/libraries/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/[id]/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/databricks-job/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/databricks-job/[id]/run-output/route.ts',
  'apps/fiab-console/app/api/items/databricks-job/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/command/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/context/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/databricks-pipeline/[id]/events/route.ts',
  'apps/fiab-console/app/api/items/databricks-pipeline/[id]/pipelines/route.ts',
  'apps/fiab-console/app/api/items/databricks-pipeline/[id]/spec/route.ts',
  'apps/fiab-console/app/api/items/databricks-pipeline/[id]/start/route.ts',
  'apps/fiab-console/app/api/items/databricks-pipeline/[id]/stop/route.ts',
  'apps/fiab-console/app/api/items/databricks-pipeline/[id]/updates/route.ts',
  //
  // ── GHSA-v2g8-gp3r-rg4r — THE WHOLE `databricks-sql-warehouse/[id]/*` FAMILY
  //    IS GONE FROM THIS LIST. Seventeen entries DELETED, never reworded,
  //    across #3665 (`state`, `start`, `edit`, `delete`, `clone`), the seventh
  //    pass (`query`) and the eighth (`cancel`, `connection`, `create`, `ctas`,
  //    `iqy`, `query-history`, `query-profile`, `schema`, `script-out`,
  //    `warehouses`). `ctas` and `model` carried a real guard already; `ctas`'s
  //    entry was INERT (NOW_GUARDED wins) and is deleted here rather than left
  //    to read as an excuse it never had. All of them are in NOW_GUARDED below.
  //
  // The class reason above this list — "operate on a single deployment-shared
  // Azure resource resolved by item TYPE + the id in the URL … there is NO
  // per-tenant Cosmos ownership to scope" — was FALSE of every one of them, on
  // BOTH halves of the sentence. None resolved anything "by the id in the URL":
  // all but `iqy` took `(req: NextRequest)` with NO `ctx` at all, so `[id]` was
  // never read, and `iqy` read it only to interpolate into a URL. And the
  // resource was not resolved by item type either — it came from a
  // caller-supplied `warehouseId`, `statementId`, `queryId` or creation spec on
  // the query string or the body.
  //
  // The wording is the recorded root cause of this whole advisory section, so
  // rewording preserves the failure: a reason that is accurate about a SIBLING
  // BRANCH, or about a route that genuinely has nothing to scope, reads as
  // verified when a reviewer skims the list. Deleted for the same reason the
  // `[type]/[id]` entries were deleted in #3648 / #3655.
  'apps/fiab-console/app/api/items/dataflow/[id]/refresh/route.ts',
  'apps/fiab-console/app/api/items/dataflow/[id]/route.ts',
  'apps/fiab-console/app/api/items/dataset/[id]/lineage/route.ts',
  'apps/fiab-console/app/api/items/dataset/[id]/preview/route.ts',
  'apps/fiab-console/app/api/items/dataset/[id]/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/business-rules/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/columns/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/keys/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/relationships/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/rows/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/[id]/views/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/check-compat/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/capacity/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/continuous-export/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/database/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/ingest/preview/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/ingest/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/journal/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/overview/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/policies/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/purge/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/route.ts',
  'apps/fiab-console/app/api/items/gql-graph/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/graph-model/[id]/materialize/route.ts',
  'apps/fiab-console/app/api/items/graph-model/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/graph-model/[id]/source-schema/route.ts',
  'apps/fiab-console/app/api/items/graphql-api/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/graphql-api/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/lakehouse/[id]/abfss/route.ts',
  'apps/fiab-console/app/api/items/lakehouse/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/logic-app/[id]/route.ts',
  'apps/fiab-console/app/api/items/logic-app/[id]/run/route.ts',
  // mapping-dataflow (U7) Debug mode — the ADF data-flow debug-session lifecycle
  // (session + per-transform preview) operates on the deployment-default ADF
  // factory resolved by flow name (= [id]) via the Console UAMI: the SAME
  // shared-Azure-backend class as /api/adf/dataflows/[name]/debug (prefix A). No
  // per-tenant Cosmos item is read; the ADF factory is a single shared resource.
  'apps/fiab-console/app/api/items/mapping-dataflow/[id]/debug/session/route.ts',
  'apps/fiab-console/app/api/items/mapping-dataflow/[id]/debug/preview/route.ts',
  'apps/fiab-console/app/api/items/mapping-dataflow/[id]/debug/schema/route.ts',
  'apps/fiab-console/app/api/items/mapping-dataflow/[id]/debug/stats/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/lifecycle/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/monitor/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/open-mirror/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/sql-endpoint/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/catalog/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/sql-endpoint/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/[id]/register/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/[id]/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/[id]/runs/[runId]/metrics/route.ts',
  'apps/fiab-console/app/api/items/mounted-adf/[id]/route.ts',
  'apps/fiab-console/app/api/items/mounted-adf/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/execute-spark/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/jobs/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/runs/[runId]/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/[id]/preview/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/[id]/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/[id]/definition/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/[id]/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/power-page/[id]/route.ts',
  'apps/fiab-console/app/api/items/prompt-flow/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/release-environment/[id]/arm/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/paginated-embed-token/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/datasource/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/direct-lake/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/ingest/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/measures/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh-policy/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh-schedule/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refreshes/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/take-over/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/clone/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/query-history/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/resume/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/script-out/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/synapse-notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/synapse-pipeline/[id]/connections/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/iqy/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/objects/route.ts',
  'apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/auto-pause/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/config/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/runs/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/scale/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/[id]/submit/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/geo/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/link/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/timeline/route.ts',
  'apps/fiab-console/app/api/items/user-data-function/[id]/invoke/route.ts',
  'apps/fiab-console/app/api/items/vector-store/[id]/index/route.ts',
  'apps/fiab-console/app/api/items/vector-store/[id]/search/route.ts',
  'apps/fiab-console/app/api/items/vector-store/[id]/sync/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/clone/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/copy-into/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/iqy/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/query-acceleration/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/restore-points/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/script-out/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/snapshots/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/time-travel/route.ts',
];
// ── Routes that USED to be allowlisted as "shared backend / no ownership to
// scope" but actually read/write a per-tenant Cosmos item by a caller-supplied
// (id, workspaceId) — the exact cross-tenant hole this checker exists for.
// They were fixed in the rel-T17 sweep to thread `assertOwner(workspaceId,
// oid)` (or an equivalent owner check), so they now carry a real guard signal
// and PASS on their own. They are listed here so they are EXCLUDED from every
// allowlist below — if a future edit drops the guard, the checker re-flags them
// instead of silently masking the regression.
const NOW_GUARDED = new Set([
  // data-pipeline (reads the per-tenant item to resolve its ADF backing)
  'apps/fiab-console/app/api/items/data-pipeline/[id]/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/approval-logicapp/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/debug/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/evaluate/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/integration-runtimes/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/jobs/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/output/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/triggers/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/[id]/validate/route.ts',
  // mirrored-database / mirrored-databricks
  'apps/fiab-console/app/api/items/mirrored-database/[id]/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/lifecycle/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/monitor/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/open-mirror/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/sql-endpoint/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/catalog/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/[id]/sql-endpoint/route.ts',
  // logic-app / mounted-adf / notebook family / dataflow / event-schema-set
  'apps/fiab-console/app/api/items/logic-app/[id]/route.ts',
  'apps/fiab-console/app/api/items/logic-app/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/mounted-adf/[id]/route.ts',
  'apps/fiab-console/app/api/items/mounted-adf/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/execute-spark/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/jobs/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/notebook/[id]/runs/[runId]/route.ts',
  'apps/fiab-console/app/api/items/synapse-notebook/[id]/route.ts',
  'apps/fiab-console/app/api/items/dataflow/[id]/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/check-compat/route.ts',
  'apps/fiab-console/app/api/items/event-schema-set/[id]/versions/route.ts',
  // semantic-model (per-tenant DQ source read/write), airflow-job, activator
  'apps/fiab-console/app/api/items/semantic-model/[id]/datasource/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/ingest/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/model/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/dag-runs/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/dags/route.ts',
  'apps/fiab-console/app/api/items/airflow-job/[id]/task-logs/route.ts',
  'apps/fiab-console/app/api/items/activator/[id]/rules/route.ts',
  'apps/fiab-console/app/api/items/activator/[id]/start/route.ts',
  'apps/fiab-console/app/api/items/activator/[id]/stop/route.ts',
  'apps/fiab-console/app/api/items/lakehouse-shortcut/route.ts',
  'apps/fiab-console/app/api/items/data-pipeline/practice-seed/route.ts',
  // copy-job run history — was allowlisted under SHARED_BACKEND_ITEM_ROUTES on a
  // premise that did not hold for it: the class is "per-item-TYPE route over a
  // shared backend with no per-tenant Cosmos ownership to scope", but this route
  // is addressed by item ID and its own siblings ([id]/run, [id]/watermark) scope
  // it by loading the item. It now runs withWorkspaceOwner, so it is listed here
  // rather than allowlisted — dropping the wrapper must re-flag, not stay masked.
  'apps/fiab-console/app/api/items/copy-job/[id]/runs/route.ts',
  // ── GHSA-hf73-rp4q-66pf ──────────────────────────────────────────────────
  // 20 routes across 8 item types, graduated for the SAME reason copy-job/[id]/
  // runs was: each is addressed by item ID, consumes that id, and had no
  // item-level authorization, while a SIBLING under the same item type resolves
  // that very id as an owned Loom item. The class reason ("no per-tenant Cosmos
  // ownership to scope") was therefore false for every one of them, and it is now
  // re-tested mechanically each run — see falsifiedSharedBackendPremise, which is
  // what produced this list rather than a hand sweep.
  //
  // MOST OF THESE THREAD `authorizeItemWorkspace`, NOT `withWorkspaceOwner`, and
  // that is deliberate: on the Power BI / Foundry families the `[id]` is
  // legitimately a RAW backend object id on the opt-in path (a Power BI dashboard
  // / report / dataset GUID, an AI Foundry flow id) with no Loom item behind it,
  // and `loadOwnedItem` renders "no item" as 404. Wrapping those would have
  // 404'd every caller on the opt-in path — a fix that breaks real users is not a
  // fix. `dashboard/[id]` had already made and documented exactly this call.
  // graphql-api is the exception and uses the stricter wrapper, because its
  // `[id]` is always a Cosmos item (the APIM apiId is minted FROM it).
  'apps/fiab-console/app/api/items/dashboard/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/pin/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/tile-embed-token/route.ts',
  'apps/fiab-console/app/api/items/dashboard/[id]/tile-query/route.ts',
  'apps/fiab-console/app/api/items/dataflow/[id]/refresh/route.ts',
  'apps/fiab-console/app/api/items/graphql-api/[id]/publish/route.ts',
  'apps/fiab-console/app/api/items/graphql-api/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/[id]/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/prompt-flow/[id]/run/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/export/route.ts',
  'apps/fiab-console/app/api/items/report/[id]/paginated-embed-token/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/direct-lake/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/embed-token/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/measures/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh-schedule/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refreshes/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/take-over/route.ts',
  // ── GHSA-v2g8-gp3r-rg4r ──────────────────────────────────────────────────
  // The ADX / shared-backend routes that took their TARGET from the request
  // body instead of from the item. They sat under SHARED_BACKEND_ITEM_ROUTES on
  // the recorded class reason "no per-tenant Cosmos ownership to scope", which
  // was true of them ONLY because the handler never looked:
  // `graph-model/[id]/materialize` did not even bind `session`,
  // `lakehouse/[id]/query` took `_ctx` and ignored it, and
  // `databricks-notebook/[id]/runs` did not accept `ctx` at all.
  //
  // NOTE FOR falsifiedSharedBackendPremise (the CHECK 3 immediately above this
  // list's sibling entries): these are OUTSIDE that control's population BY
  // CONSTRUCTION, because it requires the handler to consume `[id]` and these
  // did not. The strictly worse shape was the invisible one — which is why they
  // were found by review rather than by the sweep that produced the 20 above.
  //
  // Every one now runs a real item guard (`guardAdxItemRequest` /
  // `authorizeNotebookItem`) and resolves its database — or its run scope —
  // from the item, so they are listed here rather than allowlisted: dropping
  // the guard must re-flag, not stay masked by the old class reason.
  'apps/fiab-console/app/api/items/graph-model/[id]/materialize/route.ts',
  'apps/fiab-console/app/api/items/graph-model/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/purge/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/database/route.ts',
  'apps/fiab-console/app/api/items/lakehouse/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/[id]/runs/route.ts',
  // Second pass on the same advisory, after review found the fix had RELOCATED
  // the primitive rather than removed it. `gql-graph/[id]/query` is the sibling
  // of `graph-model/[id]/query` and carried the identical shape — `_ctx` taken
  // and ignored, `body.database` into `executeQuery`, caller KQL concatenated
  // raw. `eventhouse/[id]/ingest` is the WRITE half: `handleFile(_id, req)`
  // discarded the item id and took `database` from the form, and the JSON kinds
  // reached `.ingest into table (h'<caller url>')` and an ARM dataConnections
  // PUT on any database. Both now run the same item guard.
  'apps/fiab-console/app/api/items/gql-graph/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/ingest/route.ts',
  // THIRD pass on the same advisory. #3600 fixed eight routes; the advisory
  // stayed open because the MEASURED population is far larger, and these seven
  // were in the unaudited remainder. All were sitting in
  // SHARED_BACKEND_ITEM_ROUTES under the same false premise, and every one took
  // its coordinate from the request as the Console UAMI:
  //   eventhouse/[id]/policies          `.alter database policy retention` on any
  //     database in the body — a DATA-LIFETIME rewrite, so `softDeleteDays: 1`
  //     ages another tenant's data out with no `.purge` ever issued. The most
  //     destructive instance left in the advisory.
  //   eventhouse/[id]/continuous-export a STANDING export job: `database` +
  //     `sourceTable` named the source and `body.adlsAccount` WON over the
  //     configured account, so the destination was caller-chosen too. Plus
  //     `.create-or-alter external table` / `function` DDL in bind mode.
  //   eventhouse/[id]/journal           bound `params` and discarded it on
  //     purpose; with no `?database` it ran cluster-wide `.show journal`, whose
  //     `ChangeCommand` + `Principal` columns are a schema-and-identity map of
  //     every tenant on the cluster.
  //   graph-model/[id]/source-schema    the RECONNAISSANCE half of the primitive
  //     #3600 fixed the consumer of: `.show databases` enumerated every database
  //     on the cluster, then tables, then column schemas — exactly the
  //     sourceDatabase/sourceTable/sourceColumn inputs `[id]/materialize` takes.
  //   tapestry/[id]/{link,geo,timeline} the THIRD editor family over the same
  //     materialized Node_*/Edge_* tables as graph-model and gql-graph, with the
  //     identical `_ctx`-ignored / `body.database || defaultDatabase()` shape.
  //
  // Same reason as the two passes above for listing them here rather than
  // leaving them allowlisted: they now run `guardAdxItemRequest` and resolve the
  // database from the item, and dropping that must RE-FLAG rather than fall back
  // to a class reason that was only ever true because nobody looked.
  'apps/fiab-console/app/api/items/eventhouse/[id]/policies/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/continuous-export/route.ts',
  'apps/fiab-console/app/api/items/eventhouse/[id]/journal/route.ts',
  'apps/fiab-console/app/api/items/graph-model/[id]/source-schema/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/link/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/geo/route.ts',
  'apps/fiab-console/app/api/items/tapestry/[id]/timeline/route.ts',
  // Added in the same pass, not pre-existing: binding the three panes above left
  // the tapestry editor with a FREE-TEXT database field that would 403 on its own
  // documented use — the picker/consumer mismatch the graph-model source-schema
  // fix had just removed. `[id]/databases` returns exactly `workspaceAdxScope`,
  // the same set those panes admit, so it is graduated with them rather than
  // shipped as a new unguarded surface.
  'apps/fiab-console/app/api/items/tapestry/[id]/databases/route.ts',
  // ── GHSA-v2g8-gp3r-rg4r, THIRD pass — the tabled set ────────────────────────
  //
  // The advisory stayed open after #3600/#3614 on the routes those passes tabled
  // with per-route reasons. These fourteen are that set, and they sat under
  // SHARED_BACKEND_ITEM_ROUTES / ALLOWLIST on the SAME false premise: "a shared
  // Azure backend with no per-tenant Cosmos ownership to scope", which was true
  // of these handlers only because they never looked at `[id]`. Several did not
  // even accept `ctx`.
  //
  //   eventhouse/[id]                   `export async function GET()` — no ctx —
  //     running `.show databases details` CLUSTER-WIDE and returning every
  //     tenant's database name + size + retention + hot-cache + table count. The
  //     reconnaissance half of the retention-rewrite `[id]/policies` closes.
  //   warehouse/[id]/{clone,copy-into}  CTAS / COPY INTO writing a caller-named
  //     table in the ONE env-pinned Synapse dedicated pool.
  //   warehouse/[id]/query
  //   synapse-dedicated-sql-pool/[id]/{clone,query}
  //                                     arbitrary T-SQL plus a `body.database`
  //     that re-pointed the TDS connection at any database on the shared server.
  //   warehouse/[id]/{schema,script-out}
  //   synapse-dedicated-sql-pool/[id]/{schema,script-out}
  //                                     pool-wide enumeration and verbatim
  //     OBJECT_DEFINITION of any view/procedure/function on it.
  //   databricks-sql-warehouse/[id]/ctas
  //   [type]/[id]/{optimize,statistics} CREATE TABLE AS SELECT / OPTIMIZE /
  //     CREATE-UPDATE-DROP STATISTICS at a caller-named Unity Catalog or Synapse
  //     coordinate, as the Console identity.
  //   semantic-model/[id]/refresh-policy
  //                                     TMSL Alter + a Refresh that REBUILDS the
  //     partitions of a caller-named table in the ONE shared AAS database.
  //
  // Each now runs `guardSynapseItemRequest` (or `guardAdxItemRequest` for the
  // eventhouse GET) against the route item. Graduating them here rather than
  // leaving them allowlisted is the same commitment #3600/#3614 made: dropping
  // the guard must RE-FLAG, not fall back to a class reason nobody re-tested.
  //
  // READ THE LEDGER BEFORE READING THIS AS CLOSURE. On the shared Synapse pool,
  // Unity Catalog and AAS surfaces the DATA coordinate (`schema.table`,
  // `catalog.schema.table`, `tableName`) is still caller-named, because no
  // item→object ownership exists in the estate to bind it to. Graduation records
  // that Layer 1 is now enforced and watched — not that the class is closed.
  'apps/fiab-console/app/api/items/eventhouse/[id]/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/clone/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/copy-into/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/warehouse/[id]/script-out/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/clone/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/synapse-dedicated-sql-pool/[id]/script-out/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/ctas/route.ts',
  'apps/fiab-console/app/api/items/[type]/[id]/optimize/route.ts',
  'apps/fiab-console/app/api/items/[type]/[id]/statistics/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/[id]/refresh-policy/route.ts',
  // non-items routes fixed in the same sweep
  'apps/fiab-console/app/api/aml/environments/route.ts',
  'apps/fiab-console/app/api/notebook/[id]/assist/route.ts',
  'apps/fiab-console/app/api/experience/warp/transforms/route.ts',
  'apps/fiab-console/app/api/governance/scans/route.ts',
  'apps/fiab-console/app/api/governance/scans/register-existing/route.ts',
  // ── GHSA-v8r7-c2p5-mjf2 ──────────────────────────────────────────────────
  // The Azure SQL / PostgreSQL routes that took a full ARM resource id — or a
  // bare server name — from the REQUEST BODY and used it verbatim against ARM
  // or a database data plane as the Console UAMI. They sat in
  // SHARED_BACKEND_ITEM_ROUTES under "no per-tenant Cosmos ownership to scope",
  // a premise their own sibling `[id]/connect` had already falsified by
  // persisting exactly such a binding, which `[id]/query` has resolved its
  // target from since #2723.
  //
  // NOTE FOR falsifiedSharedBackendPremise (CHECK 3): these were OUTSIDE that
  // control's population BY CONSTRUCTION — it filters to handlers that CONSUME
  // `[id]`, and `[id]/scale` is `POST(req)` with no `ctx` parameter at all, so
  // the id was not merely ignored, it was not accepted. CHECK 3 reported zero on
  // this family and always had. That zero was evidence the case was outside the
  // population, not evidence of safety.
  //
  // Every one now runs `withBoundSqlServer`: owner check, target resolved from
  // the item's bound connection, and that binding admitted against
  // `loomSubscriptionScope()`. Listed here rather than left allowlisted so
  // dropping the guard RE-FLAGS instead of falling back to a class reason that
  // was only ever true because nobody looked.
  //
  // The REST of both families is untouched and still allowlisted — see the
  // advisory's triage table. This is a partial fix with an honest ledger.
  //
  // Their stale `SHARED_BACKEND_ITEM_ROUTES` entries were DELETED in the same
  // change rather than left to lose a race. NOW_GUARDED wins over the allowlist
  // today, so the entries were inert — but the stale entry IS the mask the 2x2
  // probe demonstrates (guard stripped + entry deleted → violations: 0), and it
  // re-arms silently if that block is ever edited. Two records of the same fact,
  // one of which is wrong, is the shape this checker exists to catch.
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/share/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/aad-admin/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/restore/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/replication/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/scale/route.ts',
  // Second pass on the same advisory. `[id]/query` and `[id]/copilot` were fixed
  // by #2723 and were cited as the PRECEDENT for the whole module, so they were
  // assumed done and were not in the advisory's 19. Review established they
  // carried Layer 1 + Layer 2 only: `resolveOwnedSqlTarget` returned the RAW
  // bound string, and `PATCH /api/items/[type]/[id]` writes that string
  // wholesale. Downstream they are worse than the ARM routes — `getPool`
  // composes `server.includes('.') ? server : <name>.<suffix>` and presents an
  // Entra ACCESS TOKEN to the result, so a bound external FQDN was arbitrary SQL
  // plus credential egress. Both now resolve through `admitBoundSqlTarget`.
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/copilot/route.ts',
  // ── GHSA-v8r7-c2p5-mjf2, THIRD PASS ──────────────────────────────────────
  // Six of the thirteen routes the first pass tabled. Same adoption: the target
  // comes from the `[id]` item's bound connection and that binding is admitted
  // against `sqlAuthorizedSubscriptions()`.
  //
  // `mirroring` is the one worth recording, because it was NEVER allowlisted and
  // still passed this checker for its whole life. It called `loadOwnedItem` — a
  // bare-word GUARD_SIGNAL_RE token — so CHECK 2 was satisfied. But that call sat
  // AFTER `enableMirroring(body.server, body.database)` had already run real DDL,
  // it only ran inside the `LOOM_BRONZE_URL` branch, and FAILING it returned
  // `ok: true` with a note. A guard signal that is present, runs late, runs
  // conditionally, and answers 200 on denial is indistinguishable from a real one
  // at the token level — which is the same lesson as `assertOwner`-in-prose, one
  // layer up: the token was real code, it just was not a boundary.
  //
  // The other five were allowlisted under the shared-backend class reason and
  // their stale entries are DELETED here rather than left to lose a race with
  // NOW_GUARDED, per the 2x2 probe's finding.
  //
  // The REMAINING SEVEN of the thirteen are still allowlisted and are triaged
  // per-route in the PR body — including `[id]/firewall`, which cannot adopt this
  // wrapper until `azure-sql-server` items carry a persisted binding (its editor
  // calls this route with an `azure-sql-server` id and never binds). A partial
  // fix with an honest ledger.
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/mirroring/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/search-management/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/get-data/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/performance/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/sql2025-features/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/firewall/route.ts',
  // ── GHSA-v8r7-c2p5-mjf2, FOURTH PASS ─────────────────────────────────────
  // Four of the seven the third pass tabled. Two adoptions, not one:
  //
  //  `[id]/firewall` (Azure SQL) takes the FULL wrapper — Layer 1 + 2 + 3, the
  //  exact shape its PostgreSQL twin took in #3623. Its tabling reason was real
  //  and is now VOID rather than waived: it was tabled because
  //  `AzureSqlServerEditor` drives it with an `azure-sql-server` item id and
  //  that editor persisted NO binding, so Layer 2 would have 409'd every
  //  legitimate click at a Connect tab it does not have. #3639 gave that editor
  //  `useSqlItemBinding` and it now awaits `ensureBound()` before all three
  //  calls. The blocker was removed by fixing the EDITOR, not by weakening the
  //  route.
  //
  //  The other three take `withOwnedSqlItem` + `admitPickedServer` — Layer 1 +
  //  Layer 3, no Layer 2 — because their server is the PARAMETER of the
  //  operation rather than the item's identity: `create-db` provisions a
  //  database that does not exist yet (so there is nothing bound to resolve),
  //  and the two `[id]/databases` GETs are the DISCOVERY calls that populate the
  //  picker, i.e. they run so the user can choose what to bind.
  //  `unified-sql-database-editor.pickServer` calls one in the same tick it sets
  //  the selection, racing its own bind-on-selection effect, so Layer 2 there
  //  would have failed intermittently on a legitimate flow. Layer 3 is the
  //  load-bearing layer for this whole family (see the module header), so what
  //  is skipped is the weaker of the two.
  //
  //  `azure-sql-server/[id]/databases` was NOT in the advisory's 19. It sat in
  //  SHARED_BACKEND_ITEM_ROUTES beside `create-db` and `firewall` and is the
  //  exact twin of the PostgreSQL one; it was found by enumerating this block
  //  mechanically rather than working the handed-over list. Its editor caller
  //  used to send the literal id `current`, with a comment noting the route
  //  reads only `?server=` — which was true, and was the defect.
  //
  //  THE REMAINING THREE — `maintenance-configs`, `principal-search` and
  //  `query/cancel` — stay allowlisted because they are OUT OF CLASS, verified
  //  independently rather than inherited. Each now carries a per-route reason
  //  in ALLOWLIST recording what coordinate it actually takes, so the next
  //  reader does not have to re-derive it. Their stale class-reason entries were
  //  left in place deliberately; the four above were DELETED from that list in
  //  this same change rather than left to lose a race with NOW_GUARDED.
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/firewall/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/create-db/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-server/[id]/databases/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/databases/route.ts',
  // ── GHSA-v8r7-c2p5-mjf2, FIFTH PASS — the `[type]/[id]/*` dispatchers ─────
  // The advisory's own closing sweep measured that exactly two ALLOWLIST entries
  // used the phrase "resolved by item-type gate" (`security`, `sql-security`)
  // and that broadening to the parent wording gave eighteen, of which four were
  // `items/[type]/[id]/*` siblings of those two. `optimize` and `statistics`
  // were already fixed and already here; these three were not.
  //
  //   [type]/[id]/security    UC column masks + row filters. `[id]` was never
  //     destructured; `catalog` + `warehouseId` came off the request into
  //     `ucSql` — CREATE OR REPLACE FUNCTION, ALTER TABLE … SET MASK / SET ROW
  //     FILTER, and the DROPs — as the Console MI. Dropping a mask or a row
  //     filter is removing the control itself, which makes this the most severe
  //     of the three.
  //   [type]/[id]/alerts      all four verbs took `_ctx`. `?alertId=` reached
  //     `trashDbxAlert` / `deleteScheduledQueryRule`. The only WRITE + DELETE
  //     entry in this sweep, and the hardest to notice after the fact: a deleted
  //     rule simply never fires again.
  //   [type]/[id]/monitoring  READ-ONLY — stated precisely, not softened: no
  //     DDL and no mutation. `?warehouseId=` was REQUIRED and reached
  //     `listQueryHistory`, disclosing other tenants' submitted `query_text`.
  //     The Synapse branch is env-bound and was never part of the finding.
  //
  // All three now run `guardSynapseItemRequest` against the route item — the
  // same backend-agnostic Layer-1 guard `optimize` and `statistics` adopted, not
  // a new mechanism. Write-scoped except where the handler genuinely only reads
  // (`monitoring` GET, `alerts` GET).
  //
  // Listed here rather than left allowlisted so that dropping a guard RE-FLAGS.
  // Their allowlist entries were DELETED in this same change — including the two
  // STALE ones for `optimize` and `statistics`, which had been left behind by
  // the round-3 graduation and were inert only because NOW_GUARDED wins today.
  //
  // READ THE LEDGER BEFORE READING THIS AS CLOSURE. `catalog`, `warehouseId` and
  // `alertId` are all still CALLER-NAMED: no item→catalog, item→warehouse or
  // item→alert binding exists in this tree to resolve them from. Every one is
  // bounded by construction to this deployment's own estate (`dbxFetch` →
  // LOOM_DATABRICKS_HOSTNAME; every Monitor call composed against
  // LOOM_ALERT_RG || LOOM_ADMIN_RG, which throws when neither is set), so
  // nothing cross-subscription survives — but within the estate Layer 1 is a
  // FLOOR, not a BOUND, exactly as recorded for the round-3 routes above.
  //
  // AND THE FLOOR IS SELF-SERVICE. `createOwnedItem` (`_lib/item-crud.ts:423`)
  // lets any session holder create a qualifying item in a workspace they own, so
  // graduating these three moves the reachable population from "any
  // authenticated session" to "any authenticated session, plus one POST". Worth
  // stating in the file that RECORDS the graduation, so nobody reads a
  // NOW_GUARDED entry as a bigger reduction than it is.
  //
  // A STATE-ANCHORED BINDING WOULD NOT CLOSE IT EITHER, and the repo already
  // knows why: `_lib/databricks-resource-binding.ts:12-27` records that `PATCH
  // /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from the request
  // body, so a binding read from item state is writable by the very caller it is
  // meant to bound. Closing this class needs a server-attested marker on the
  // resource (the `loom_item_id` tag that module already uses for jobs and DLT
  // pipelines) plus a brownfield adoption path — not a Layer 2.
  'apps/fiab-console/app/api/items/[type]/[id]/security/route.ts',
  'apps/fiab-console/app/api/items/[type]/[id]/alerts/route.ts',
  'apps/fiab-console/app/api/items/[type]/[id]/monitoring/route.ts',
  // ── GHSA-v2g8-gp3r-rg4r, SIXTH PASS — the SQL-warehouse LIFECYCLE verbs ────
  //
  // The advisory records `databricks-sql-warehouse/[id]/query` as unauthorized
  // and notes the family around it. Measuring that family is what produced this
  // pass, and TWO OF ITS PUBLISHED NUMBERS ARE CORRECTED HERE rather than
  // repeated, because both were produced by a FILE-LOCAL grep that cannot see a
  // guard reached through a helper:
  //
  //   published: 17 files, 1 guarded (`ctas`), 16 unguarded, 12 "same shape".
  //   measured here: 17 files, **2 guarded**, **15 unguarded**, **11 same shape**.
  //
  // The extra guarded member is `[id]/model`. It runs `readModelState(id,
  // ITEM_TYPE, session.claims.oid)` on all three verbs and 404s on
  // `!itemFound` — and `_lib/model-store.ts:182` shows that is `loadOwnedItem`,
  // the real owner/workspace-ACL check, under a LOCAL NAME. This is the exact
  // missed-sibling shape `_lib/synapse-item-scope.ts`'s own header already
  // records ("'no route in this family had an item guard' was my first claim and
  // it was WRONG"), and it recurred because the follow-up measurements reused the
  // same heuristic that produced the first answer. The advisory's earlier "11"
  // was therefore RIGHT and its retraction to 12 was the error.
  //
  // THIS PASS FIXES THE FIVE MUTATING/DESTRUCTIVE MEMBERS. All five had
  // `getSession()` as their entire authorization, took NO `ctx`, and acted on a
  // caller-supplied `warehouseId` from the query string or the body:
  //
  //   [id]/delete  THE HIGHEST-SEVERITY MEMBER, and irreversible.
  //     `deleteWarehouse` on Commercial/GCC; `deleteDedicatedSqlPool` on
  //     GCC-High/DoD, where an ARM pool delete destroys the DATABASE, not just
  //     compute. BOTH BOUNDARIES were affected — recorded explicitly because
  //     this family's other members are Databricks-only, so "Commercial-only"
  //     would be the natural and WRONG assumption (`cloud-parity.md`). The
  //     `force` flag only bypassed the RUNNING pre-check and was never an
  //     authorization control; the Gov branch had no pre-check at all.
  //   [id]/clone   `CREATE [OR REPLACE] TABLE <caller target> <TYPE> CLONE
  //     <caller source>` — the advisory's headline MATERIALIZE-THEN-READ shape
  //     on Unity Catalog, and a SHALLOW clone copies no data files, so
  //     exfiltrating a large victim table costs one metadata operation. Also
  //     destructive in one direction: `replace: true` OVERWRITES a caller-named
  //     table. It is `ctas`'s twin and now runs the same guard `ctas` does.
  //   [id]/state   GET reads warehouse metadata; POST calls `stopWarehouse` —
  //     it STOPS a caller-named warehouse, killing live compute and in-flight
  //     queries. This is the member the family was first noticed through, and
  //     describing the family through its GET is what made the population read
  //     as disclosure-only. It is not: it contains a mutation.
  //   [id]/start   `startWarehouse` — starts BILLED compute. Not destructive,
  //     but an unbounded spend primitive, and the other half of full lifecycle
  //     control over another tenant's warehouse.
  //   [id]/edit    `editWarehouse` — rewrites cluster_size / min+max clusters /
  //     auto_stop_mins / warehouse_type / serverless on a caller-named
  //     warehouse. Databricks applies an edit by RESTARTING it, so it is a cost
  //     change AND an availability event.
  //
  // All five now run `guardSynapseItemRequest` against the route item — the
  // same backend-agnostic Layer-1 guard the sibling `[id]/ctas` already used,
  // not a new mechanism — write-scoped except the `state` GET, which genuinely
  // only reads. On `delete` the guard sits ABOVE the `isGovCloud()` branch, so
  // ONE check covers both boundaries rather than two that can drift. On `clone`
  // the config gate moved BELOW the guard (matching `ctas`), so a caller who
  // cannot reach the item no longer learns the deployment's Databricks config
  // state. Authentication is the route-toolkit `withSession` wrapper placed
  // ABOVE the `id === 'new'` short-circuit, because a gate above the session
  // read makes an unauthenticated request answer 200 (measured on #3655).
  //
  // STILL UNGUARDED IN THIS FAMILY, named so the gap stays visible rather than
  // implied closed — the read-shaped remainder: `connection`, `iqy`, `query`,
  // `query-history`, `schema`, `script-out`, plus `cancel`, `create`,
  // `query-profile` and `warehouses`. `query` is separately recorded on the
  // advisory as unauthorized (caller-authored SQL on a caller-chosen warehouse;
  // `[id]` read only for the `recordQueryRun` FinOps receipt).
  //
  // READ THE LEDGER BEFORE READING THIS AS CLOSURE. `warehouseId` is still
  // CALLER-NAMED on all five: no item→warehouse binding exists in this tree to
  // resolve it from — `sql-warehouse-editor.tsx` picks it from a live
  // `listWarehouses()` and never persists it — and a state-anchored binding
  // cannot close it, because `_lib/databricks-resource-binding.ts:12-27` records
  // that `PATCH /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from
  // the request body, so the caller would write the value the bound reads.
  // Everything is bounded by construction to this deployment's own estate
  // (`dbxFetch` → LOOM_DATABRICKS_HOSTNAME; the ARM path composed against
  // LOOM_SUBSCRIPTION_ID / LOOM_SYNAPSE_WORKSPACE), so nothing
  // cross-subscription survives — but within the estate LAYER 1 IS A FLOOR, NOT
  // A BOUND, AND THE FLOOR IS SELF-SERVICE: `createOwnedItem`
  // (`_lib/item-crud.ts:423`) lets any session holder create a qualifying item
  // in a workspace they own, so this moves the reachable population from "any
  // authenticated session" to "any authenticated session, plus one POST". On
  // `delete` that residual is the sharpest in the set, because the effect is
  // irreversible.
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/start/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/edit/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/delete/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/clone/route.ts',
  // ── GHSA-v2g8-gp3r-rg4r, SEVENTH PASS — `[id]/query` ──────────────────────
  //
  // The advisory records this route as unauthorized TODAY, by name and
  // separately from the family sweep. Restating the shape, because it is the
  // reason both this checker and the published inventory called it clean:
  //
  //   `withSession` was the entire authorization. `warehouseId` came from the
  //   BODY. `[id]` WAS read — in exactly one place, `recordQueryRun`, the
  //   FinOps attribution receipt — and never reached an authorization call.
  //
  // So it ran CALLER-AUTHORED SQL on a CALLER-CHOSEN warehouse while carrying
  // two owner-shaped tokens (`routeParams.id`, `session.claims.oid`), both
  // inside the billing record. It published `owner-scoped` on `main` on the
  // strength of exactly that. This is the finding `_route-auth-scope.mjs`
  // (#3625/#3643) was rewritten to catch: PRESENCE READ AS ENFORCEMENT.
  //
  // IT IS NOT A READ AND IS NOT SCOPED AS ONE. `sql` is unrestricted — no
  // `^select` shape check of the kind the sibling `[id]/ctas` carries — so the
  // same handler runs SELECT, INSERT, CREATE TABLE, DROP and GRANT alike on
  // Unity Catalog, and `streaming-object-dialog.tsx:149` is a shipped
  // in-product caller that uses it for CREATE DDL. It is also the READ half of
  // the advisory's materialize-then-read pair with `[id]/clone`. Hence
  // `guardSynapseItemRequest` WRITE-scoped, with the split asserted in
  // `databricks-sql-warehouse/__tests__/ghsa-v2g8-warehouse-query.test.ts`
  // rather than assumed.
  //
  // STILL UNGUARDED IN THIS FAMILY, named so the gap stays visible rather than
  // implied closed: `cancel`, `connection`, `create`, `iqy`, `query-history`,
  // `query-profile`, `schema`, `script-out`, `warehouses`.
  //
  // READ THE LEDGER BEFORE READING THIS AS CLOSURE. `warehouseId`, `sql`,
  // `catalog` and `schema` all stay CALLER-SUPPLIED: no item→warehouse binding
  // exists in this tree to resolve them from, and a state-anchored one cannot
  // close it because `_lib/databricks-resource-binding.ts:12-27` records that
  // `PATCH /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from the
  // request body, so the caller would write the value the bound reads. LAYER 1
  // IS A FLOOR, NOT A BOUND, AND THE FLOOR IS SELF-SERVICE — `createOwnedItem`
  // (`_lib/item-crud.ts:423`) lets any session holder create a qualifying item,
  // moving the reachable population from "any authenticated session" to "any
  // authenticated session, plus one POST". The real bound is tracked in #3669
  // and is deliberately not improvised inside a security fix.
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query/route.ts',
  // ── GHSA-v2g8-gp3r-rg4r, EIGHTH PASS — THE REMAINDER OF THE FAMILY ────────
  //
  // With these nine the `databricks-sql-warehouse/[id]/*` family is CLOSED at
  // Layer 1: 17 route files, 17 guarded, 0 unguarded. The tally was re-derived
  // by FOLLOWING DELEGATION through `_route-auth-scope.mjs`'s import graph, not
  // by a file-local grep — that method is what produced three wrong counts on
  // this advisory, because it cannot see `[id]/model`, whose guard is
  // `readModelState` → `loadOwnedItem` (`_lib/model-store.ts:182`).
  //
  // EACH ROUTE WAS TREATED ON ITS OWN EVIDENCE. The advisory warns that `cancel`
  // takes a `statementId` and `create` a creation spec, so they are NOT the same
  // shape as the caller-supplied-`warehouseId` members; `query-profile` takes a
  // `queryId`. Read/write split, decided per route and ASSERTED in
  // `databricks-sql-warehouse/__tests__/ghsa-v2g8-warehouse-reads.test.ts`:
  //
  //   WRITE-scoped (no allowReadRoles)
  //     cancel   `cancelStatement(<caller statementId>)` ABORTS A RUNNING QUERY
  //              — someone else's. Paired with `query-history`, which hands out
  //              statement ids workspace-wide, that is targeted DoS.
  //     create   PROVISIONS INFRASTRUCTURE — `createWarehouse` on Commercial/GCC,
  //              an ARM `createDedicatedSqlPool` (a new DATABASE, at a
  //              caller-named DWU SKU) on GCC-High/DoD. An unbounded spend
  //              primitive. BOTH BOUNDARIES were affected, and the guard sits
  //              ABOVE the `isGovCloud()` branch so one check covers both —
  //              the same placement #3665 used on `delete` (`cloud-parity.md`).
  //              Its deploy target now comes from the AUTHORIZED ITEM's
  //              workspace rather than `?workspaceId=` / `body.workspace_id`.
  //
  //   READ-scoped (allowReadRoles: true) — each justified, not assumed
  //     schema        `SHOW CATALOGS/SCHEMAS/TABLES/VIEWS` + `DESCRIBE TABLE`.
  //                   The family's ENUMERATION primitive: it tells an attacker
  //                   which table to name for `clone`/`query`.
  //     script-out    `SHOW CREATE TABLE|FUNCTION` — full source disclosure of
  //                   any UC object. Its `drop` branch FORMATS a DROP string and
  //                   returns it WITHOUT EXECUTING, which is why "it emits DROP"
  //                   is the wrong reason to call it a write.
  //     query-history `warehouseId` is OPTIONAL, so omitting it returned recent
  //                   statements — `query_text` and `user_name` — across the
  //                   ENTIRE shared workspace. That residual SURVIVES Layer 1.
  //     query-profile caller-supplied `statement_id` → full SQL, user, metrics,
  //                   plan. Config gate MOVED BELOW the guard.
  //     connection    hostname / HTTP path / JDBC URL for a caller-named
  //                   warehouse — reconnaissance, plus an existence probe.
  //     iqy           makes NO data-plane call; it formats a file out of values
  //                   the caller already supplied. Guarded so the artefact and
  //                   the `[id]/query` it re-POSTs to stay consistent. Its
  //                   unsaved gate is 409, NOT 200, because `openInExcel`
  //                   branches on `r.ok` and would otherwise DOWNLOAD the gate
  //                   JSON as a corrupt .iqy.
  //
  //   warehouses    READ-scoped on a real id — AND SESSION-ONLY ON `id ===
  //                 'new'`, DELIBERATELY. Read that carve-out in the route
  //                 header before treating this family as fully closed. The
  //                 editor's mount effect calls it FIRST and unconditionally,
  //                 and `sql-warehouse-editor.tsx` has no `isNew` (measured,
  //                 `grep -c` = 0), so gating it would paint a red banner on a
  //                 freshly created item and leave every other control dead —
  //                 the dead end `auto-bind-by-default.md` forbids. The
  //                 pre-existing enumeration exposure at `.../new/warehouses` is
  //                 therefore UNCHANGED, not closed. AUTHENTICATION still
  //                 applies there: the carve-out is inside `withSession`.
  //
  // FLOOR, NOT BOUND, unchanged and not re-litigated per route: every
  // caller-supplied coordinate stays caller-supplied, because no item→warehouse
  // binding exists and a state-anchored one cannot work
  // (`_lib/databricks-resource-binding.ts:12-27` — `PATCH /api/cosmos-items/
  // [type]/[id]` replaces `state` WHOLESALE from the request body). With
  // `createOwnedItem` self-service (`_lib/item-crud.ts:423`) this moves the
  // reachable population from "any authenticated session" to "any authenticated
  // session, plus one POST". The real bound is #3669.
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/create/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/iqy/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query-history/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query-profile/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/script-out/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/warehouses/route.ts',
]);

// Paths that get their excuse from the CLASS reason below rather than from a
// hand-written per-route reason. Membership is decided by the reason ACTUALLY IN
// EFFECT at scan time (`hasSharedBackendClassReason`), NOT captured while the
// loop runs.
//
// WHY, measured in review of the PR that added CHECK 3: the failure message told
// you to give the route its own per-route reason, and there are TWO places to do
// that — the `new Map([…])` literal above, and the `for (const [p, reason] of
// [ … ])` block further down. Only the first worked. The second runs AFTER this
// loop, and it was written `if (!ALLOWLIST.has(p))`, so the class reason had
// already been stamped and the hand-written one was silently discarded: CHECK 3
// kept firing on a route whose reason someone had just written. A control about
// recorded reasons being re-tested, whose own remediation did not work.
//
// Two changes remove the ordering trap: membership is read from the reason in
// effect (here), and a hand-written reason now OVERRIDES the class default
// (at that later block). Either list exempts, which is what the message says.
const SHARED_BACKEND_LISTED = new Set(SHARED_BACKEND_ITEM_ROUTES);

/** The ONE reason string this loop stamps. Named so the premise probe can
 *  reproduce an un-graduated entry exactly, and so the later per-route block can
 *  tell "nobody wrote a reason" from "someone did". */
const SHARED_BACKEND_CLASS_REASON =
  'specific-per-item-TYPE route over a SHARED Azure backend resolved by item type (auth = signed-in + deployment RBAC); no per-tenant Cosmos ownership to scope';

/** True when `r` is excused by the CLASS reason and not by a reason someone
 *  wrote for it. Evaluated late, so every allowlist block has already run. */
function hasSharedBackendClassReason(r) {
  return SHARED_BACKEND_LISTED.has(r) && ALLOWLIST.get(r) === SHARED_BACKEND_CLASS_REASON;
}

for (const p of SHARED_BACKEND_ITEM_ROUTES) {
  if (NOW_GUARDED.has(p)) continue; // now carries a real owner-check — not allowlisted
  if (!ALLOWLIST.has(p)) {
    ALLOWLIST.set(p, SHARED_BACKEND_CLASS_REASON);
  }
}

// ── rel-T17: item-TYPE-level list/create + shared sub-collection routes surfaced
// by widening the scan to all of app/api. Each of these talks to a SHARED Azure
// backend (Power BI / AI Foundry / ADF / APIM / Databricks / Stream Analytics /
// Power Platform / ARM by name) — NOT a per-tenant Cosmos partition — so
// getSession()+deployment-RBAC is the intended authz (list/create that DO write
// per-tenant Cosmos go through createOwnedItem/listOwnedItems and pass on their
// own signal). NB: `?workspaceId=` on the Power BI routes (dashboard,
// paginated-report, semantic-model/build) is a Power BI workspace id, not a Loom
// Cosmos partition — an assertOwner check would be wrong there.
const SHARED_BACKEND_TYPE_ROUTES = [
  // N7b CDC control plane: pre-create source-table enumerator over the SHARED
  // source (SQL catalog / PostgreSQL information_schema) resolved by the coords
  // the caller supplies — the connector doesn't exist yet, so there is no
  // per-tenant Cosmos ownership to scope (same shape as mirrored-database/source-tables).
  'apps/fiab-console/app/api/cdc/connectors/source-tables/route.ts',
  'apps/fiab-console/app/api/items/adf-dataset/route.ts',
  'apps/fiab-console/app/api/items/adf-pipeline/route.ts',
  'apps/fiab-console/app/api/items/adf-trigger/route.ts',
  'apps/fiab-console/app/api/items/ai-builder-model/route.ts',
  'apps/fiab-console/app/api/items/ai-foundry-project/route.ts',
  'apps/fiab-console/app/api/items/ai-search-index/route.ts',
  'apps/fiab-console/app/api/items/apim-api/route.ts',
  'apps/fiab-console/app/api/items/apim-policy/route.ts',
  'apps/fiab-console/app/api/items/apim-product/route.ts',
  'apps/fiab-console/app/api/items/automl/jobs/route.ts',
  'apps/fiab-console/app/api/items/automl/jobs/[name]/route.ts',
  'apps/fiab-console/app/api/items/automl/options/route.ts',
  'apps/fiab-console/app/api/items/automl/submit/route.ts',
  'apps/fiab-console/app/api/items/compute/route.ts',
  'apps/fiab-console/app/api/items/content-safety/blocklists/items/route.ts',
  'apps/fiab-console/app/api/items/content-safety/blocklists/route.ts',
  'apps/fiab-console/app/api/items/content-safety/rai-policies/route.ts',
  'apps/fiab-console/app/api/items/content-safety/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-action/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-agent/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-channel/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-knowledge/route.ts',
  'apps/fiab-console/app/api/items/copilot-studio-topic/route.ts',
  'apps/fiab-console/app/api/items/copilot-template-library/route.ts',
  'apps/fiab-console/app/api/items/dashboard/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/options/route.ts',
  'apps/fiab-console/app/api/items/databricks-cluster/route.ts',
  'apps/fiab-console/app/api/items/databricks-job/route.ts',
  'apps/fiab-console/app/api/items/databricks-notebook/list/route.ts',
  'apps/fiab-console/app/api/items/dataflow/config/route.ts',
  'apps/fiab-console/app/api/items/dataflow/profile/route.ts',
  'apps/fiab-console/app/api/items/dataset/browse/route.ts',
  'apps/fiab-console/app/api/items/dataset/route.ts',
  'apps/fiab-console/app/api/items/dataverse-table/route.ts',
  'apps/fiab-console/app/api/items/evaluation/route.ts',
  'apps/fiab-console/app/api/items/event-grid-topic/route.ts',
  'apps/fiab-console/app/api/items/event-hubs-namespace/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/source-tables/route.ts',
  'apps/fiab-console/app/api/items/mirrored-database/verify/route.ts',
  'apps/fiab-console/app/api/items/mirrored-databricks/catalogs/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/route.ts',
  'apps/fiab-console/app/api/items/ml-experiment/submit/route.ts',
  'apps/fiab-console/app/api/items/ml-model/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/capabilities/route.ts',
  'apps/fiab-console/app/api/items/paginated-report/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/route.ts',
  'apps/fiab-console/app/api/items/power-app/route.ts',
  'apps/fiab-console/app/api/items/power-automate-flow/route.ts',
  'apps/fiab-console/app/api/items/power-page/route.ts',
  'apps/fiab-console/app/api/items/prompt-flow/route.ts',
  'apps/fiab-console/app/api/items/rayfin-app/model-objects/route.ts',
  'apps/fiab-console/app/api/items/rayfin-app/models/route.ts',
  'apps/fiab-console/app/api/items/rayfin-app/preview/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/aas-databases/route.ts',
  'apps/fiab-console/app/api/items/semantic-model/build/route.ts',
  'apps/fiab-console/app/api/items/service-bus-namespace/data-explorer/route.ts',
  'apps/fiab-console/app/api/items/service-bus-namespace/route.ts',
  'apps/fiab-console/app/api/items/sql-databases/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/inputs/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/metrics/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/outputs/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/query/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/state/route.ts',
  'apps/fiab-console/app/api/items/stream-analytics-job/[name]/test/route.ts',
  'apps/fiab-console/app/api/items/synapse-pipeline/list/route.ts',
  'apps/fiab-console/app/api/items/synapse-spark-pool/list/route.ts',
  'apps/fiab-console/app/api/items/tracing/route.ts',
  'apps/fiab-console/app/api/items/tracing/[traceId]/route.ts',
];
for (const p of SHARED_BACKEND_TYPE_ROUTES) {
  if (NOW_GUARDED.has(p)) continue;
  if (!ALLOWLIST.has(p)) {
    ALLOWLIST.set(
      p,
      'item-TYPE-level list/create or shared sub-collection over a SHARED Azure backend (PBI/Foundry/ADF/APIM/Databricks/ASA/Power Platform/ARM by name); no per-tenant Cosmos partition to scope',
    );
  }
}

// ── rel-T17: remaining non-items session-only-safe routes surfaced by the wider
// scan (per-route so each carries its own honest reason).
for (const [p, reason] of [
  ['apps/fiab-console/app/api/data-products/import/template/route.ts', 'imports a data product from a shared template definition; no per-tenant Cosmos read'],
  ['apps/fiab-console/app/api/data-products/[id]/policies/route.ts', 'consumer-discovery: returns the owner\'s Access-policy purposes for the Request-access dialog (documented cross-tenant read, read-only, non-sensitive)'],
  ['apps/fiab-console/app/api/data-products/[id]/preview/route.ts', 'consumer-discovery: read-only 25-row preview of a discoverable data product (documented, mirrors GET /api/data-products/[id])'],
  // GHSA-hf73-rp4q-66pf addendum. The previous reason for this entry —
  // "read-only input/output/management ports of A DISCOVERABLE data product …
  // resolves ONLY upstream contract summaries" — was not true of the code: the
  // route established nothing about discoverability (no lifecycle filter, no
  // tid, no workspace scope), and a port `ref` is an infrastructure ADDRESS
  // (abfss:// path / Synapse schema.table / ADX database), not a contract
  // summary. It now enforces the sentence it was excused on, so it passes on its
  // own `authorizeWorkspace` call and this entry is no longer load-bearing —
  // kept, with the corrected wording, so the next reader does not inherit the
  // old premise. The residual (a legacy workspace doc with no recorded `tid`
  // cannot be tenant-tested) is documented in the route, not hidden here.
  ['apps/fiab-console/app/api/data-products/[id]/ports/route.ts', 'consumer-discovery: ports are returned only to a caller authorized on the owning workspace, or for a published/deprecated product in the caller\'s own Entra tenant; the upstream `ref` resolution runs the same test and is non-distinguishing on failure'],
  ['apps/fiab-console/app/api/governance/classifications/system/route.ts', 'read-only deployment-wide system classification catalog (static)'],
  ['apps/fiab-console/app/api/governance/dlp/schemas/route.ts', 'read-only DLP schema listing over the shared warehouse'],
  ['apps/fiab-console/app/api/governance/purview/status/route.ts', 'read-only deployment-wide Purview status'],
  ['apps/fiab-console/app/api/governance/pdp-mode/route.ts', 'read-only deployment-wide PDP enforcement-mode indicator (non-sensitive LOOM_PDP_ENFORCE value)'],
  ['apps/fiab-console/app/api/marketplace/catalog/route.ts', 'read-only deployment-wide marketplace catalog listing'],
  ['apps/fiab-console/app/api/marketplace/gate/route.ts', 'marketplace entitlement gate check; deployment-wide'],
  ['apps/fiab-console/app/api/marketplace/subscriptions/route.ts', 'APIM subscription list/create over the deployment APIM gateway via Console UAMI (shared backend, same class as /api/apim)'],
  ['apps/fiab-console/app/api/marketplace/subscriptions/[sid]/route.ts', 'APIM subscription detail over the deployment APIM gateway via Console UAMI (shared backend)'],
  ['apps/fiab-console/app/api/marketplace/subscriptions/[sid]/keys/route.ts', 'APIM subscription keys over the deployment APIM gateway via Console UAMI (shared backend)'],
  ['apps/fiab-console/app/api/marketplace/subscriptions/[sid]/keys/regenerate/route.ts', 'APIM subscription key regenerate over the deployment APIM gateway via Console UAMI (shared backend)'],

  // ── #3607 — SPLITTING `app/api/setup/` ──────────────────────────────────
  //
  // The class prefix reads "A: first-run setup/scan over ARM (subscription/
  // topology discovery) via Console UAMI". Twelve routes depend on it for their
  // clean verdict, and it is TRUE of most of them. It is not true of these
  // three, which inherited it silently — and inheriting a reason that does not
  // describe you is the state CHECK 3B now catches (for the POST) and the state
  // #3572 fixed by narrowing `app/api/storage/`.
  //
  // Each gets a reason that is true of IT, so it is individually justified and
  // individually re-testable. None of this changes what the routes do or what
  // authorization they carry: they were already excused, by a sentence that was
  // wrong. The security posture is identical; the RECORD is now accurate.

  // Caught mechanically by CHECK 3B: the class reason says "scan", this is a
  // POST. Read: the verb carries a `{ boundary, targets[] }` body, and the
  // handler's only outbound call is the READ-ONLY ARM Compute usages GET
  // (`…/Microsoft.Compute/locations/{loc}/usages`) via the Console UAMI with
  // Reader. It mutates nothing.
  //
  // STATED, NOT SETTLED (R7): the target subscription ids come from the CALLER
  // and are read with the CONSOLE's identity, so a caller can learn whether a
  // subscription id exists and what its vCPU usage is. Whether that is an
  // acceptable oracle is an authorization question about the setup wizard, not
  // something this entry establishes — it is routed to the lane that owns
  // app/api/setup/**, and is recorded here rather than papered over.
  ['apps/fiab-console/app/api/setup/quota-preflight/route.ts', 'a POST that MUTATES NOTHING: the verb carries a { boundary, targets[] } list in the body and the handler only reads the ARM Compute usages API (Reader) via the Console UAMI. NOT covered by the class reason\'s "scan over ARM" wording, which describes a GET; the caller-supplied-subscription oracle question is recorded in check-route-guards.mjs and routed, not resolved here'],

  // The class reason says "over ARM … via Console UAMI". This route does not
  // touch ARM: it calls `https://api.github.com/repos/{owner}/{repo}/actions/
  // workflows/{file}/runs` with `LOOM_GITHUB_ACTIONS_TOKEN`. A reason naming
  // the wrong backend cannot be re-tested against the code, which is the whole
  // point of recording one.
  ['apps/fiab-console/app/api/setup/workflow-run-status/route.ts', 'read-only poll of the deployment repo\'s GitHub Actions run status via api.github.com with LOOM_GITHUB_ACTIONS_TOKEN — a deployment-wide CI status read, NOT an ARM call and NOT the Console UAMI, so the app/api/setup/ class reason does not describe it'],

  // Same: not ARM. A server-to-server proxy to the orchestrator over the
  // CAE-internal ingress with `Bearer LOOM_INTERNAL_TOKEN`.
  ['apps/fiab-console/app/api/setup/deploy-status/route.ts', 'read-only proxy to the deployment orchestrator over the CAE-internal ingress with Bearer LOOM_INTERNAL_TOKEN — deployment-wide status, NOT an ARM call via the Console UAMI, so the app/api/setup/ class reason does not describe it'],
]) {
  // A HAND-WRITTEN REASON OVERRIDES THE CLASS DEFAULT. This used to be
  // `if (!ALLOWLIST.has(p))`, which meant a reason written here for a route the
  // class loop above had already stamped was silently discarded — so CHECK 3
  // kept firing and its own remediation ("give the route its own per-route
  // reason") did not work from this list. Only the generic class reason is
  // overwritten; a reason from the `new Map([…])` literal still wins, because
  // that one was written for the route too and this list must not clobber it.
  const current = ALLOWLIST.get(p);
  if (current === undefined || current === SHARED_BACKEND_CLASS_REASON) ALLOWLIST.set(p, reason);
}

// ── Group-level allowlist: whole app/api sub-trees whose ENTIRE membership is
// session-only-safe by construction, so widening the scan to all of app/api
// doesn't require one line per route. Each prefix carries the CLASS reason it's
// safe. A route under a prefix is allowed UNLESS it's in NOW_GUARDED (a fixed
// per-tenant route that must keep passing on its own owner-check). The three
// safe classes:
//   (A) Shared Azure-backend "service navigators" — every handler operates on
//       the deployment's single Azure resource resolved by an ARM/data-plane
//       name via the Console UAMI's RBAC; there is NO per-tenant Cosmos
//       partition to cross, so getSession()+deployment-RBAC IS the intended
//       authz (same class as SHARED_BACKEND_ITEM_ROUTES, one dir up).
//   (B) Session-scoped Cosmos stores — the handler threads the session object
//       into a store helper that partitions every read/write by the caller's
//       oid; no id from the URL can escape the caller's partition.
//   (C) Global read-only metadata — deployment-wide catalog/config/static data
//       with no per-tenant rows (or an external catalog like Purview/Unity).
const ALLOWLIST_PREFIXES = [
  // (A) shared Azure-backend service navigators
  ['apps/fiab-console/app/api/adf/', 'A: ADF factory navigator over the deployment ADF via Console UAMI'],
  ['apps/fiab-console/app/api/ai-search/', 'A: Azure AI Search navigator over the deployment search service'],
  ['apps/fiab-console/app/api/aml/', 'A: Azure ML navigator over the deployment AML workspace (ARM/data-plane by name)'],
  ['apps/fiab-console/app/api/apim/', 'A: APIM navigator over the deployment APIM instance'],
  ['apps/fiab-console/app/api/azure/', 'A: generic Azure resource navigator (ARM by name)'],
  ['apps/fiab-console/app/api/business-events/', 'A: Event Grid/Event Hubs business-events over the deployment namespace'],
  ['apps/fiab-console/app/api/databricks/', 'A: Databricks navigator over the deployment workspace (REST by id)'],
  ['apps/fiab-console/app/api/deployment-pipelines/', 'A: Fabric/ARM deployment-pipelines over the deployment; resolved by pipeline id via Console UAMI'],
  ['apps/fiab-console/app/api/eventhubs/', 'A: Event Hubs navigator over the deployment namespace'],
  ['apps/fiab-console/app/api/fabric/', 'A: Fabric REST navigator (opt-in); resolved by workspace/item id via Console UAMI'],
  ['apps/fiab-console/app/api/foundry/', 'A: AI Foundry navigator over the deployment Foundry hub (ARM/data-plane by name)'],
  ['apps/fiab-console/app/api/lakehouse/', 'A: ADLS Gen2 lakehouse navigator over the deployment storage (container validated; single shared lake)'],
  ['apps/fiab-console/app/api/marketplace/sharing/', 'A: Delta Sharing / provider navigator over the deployment sharing backend'],
  ['apps/fiab-console/app/api/messaging/', 'A: Service Bus/messaging metrics over the deployment namespace'],
  ['apps/fiab-console/app/api/monitor/', 'A: Azure Monitor navigator over the deployment (Log Analytics/metrics/alerts by resource)'],
  ['apps/fiab-console/app/api/network/', 'A: networking navigator over the deployment (PE/VNet/VPN by resource)'],
  ['apps/fiab-console/app/api/onelake/', 'A: OneLake/ADLS navigator over the deployment storage'],
  ['apps/fiab-console/app/api/powerbi/', 'A: Power BI REST navigator (opt-in) via the Console service principal'],
  ['apps/fiab-console/app/api/powerplatform/', 'A: Power Platform navigator over the deployment environments via the PP management app'],
  ['apps/fiab-console/app/api/realtime-hub/', 'A: Real-Time hub navigator over the deployment Event Hubs/ADX'],
  ['apps/fiab-console/app/api/setup/', 'A: first-run setup/scan over ARM (subscription/topology discovery) via Console UAMI'],
  // NARROWED from `app/api/storage/` (#3572). The class reason below — "storage
  // ACCOUNTS navigator over the deployment subscription (ARM by name)" —
  // describes `storage/accounts/route.ts` and nothing else. When
  // `storage/[account]/containers/**` were added they inherited this exemption
  // and were never in remit, yet they are not an ARM-by-name navigator over the
  // deployment: they are a DATA-PLANE walk of an ARBITRARY account, taken off
  // the URL, executed as the Console UAMI. They shipped with authentication and
  // no authorization and this checker said `violations: 0` — not because it
  // judged them safe, but because it never looked. A class exemption whose
  // stated reason has stopped being true of its members is the same defect as a
  // guard keyed to the wrong pattern: the verdict does not change when the code
  // does. The `[account]` routes are now in remit and pass on their own signal
  // (`authorizeStorageAccount`, in GUARD_SIGNAL_RE).
  ['apps/fiab-console/app/api/storage/accounts/', 'A: storage-accounts navigator over the deployment subscription (ARM by name)'],
  ['apps/fiab-console/app/api/synapse/', 'A: Synapse artifacts navigator over the deployment workspace (data-plane by name)'],
  ['apps/fiab-console/app/api/warehouse/', 'A: Synapse SQL warehouse query navigator over the deployment pool'],
  ['apps/fiab-console/app/api/dab/', 'A: Data API Builder — create threads createOwnedItem; [id] routes publish to the shared DAB runtime + APIM by id (no per-tenant Cosmos read)'],
  ['apps/fiab-console/app/api/data-agent/', 'A: data-agent chat over the deployment AOAI + ADX'],
  ['apps/fiab-console/app/api/org-reports/', 'A: org-wide report renderer over deployment-scoped aggregates'],
  ['apps/fiab-console/app/api/loom/', 'A: Loom compute-target/capacity/SHIR/model-serving navigators resolve a SHARED Azure resource by ARM/env name via Console UAMI — no id from the URL, no per-tenant Cosmos read. NOTE model-serving/endpoints lists the deployment-wide serving-endpoint NAMES with no item-ownership precondition (the sibling app/api/items/model-serving-endpoint/[id] gates on resolveServingItem first); that widening is deliberate for a picker discovery call and is stated rather than inherited'],
  ['apps/fiab-console/app/api/notebook/', 'A: notebook Livy/LSP/session navigator over the shared Synapse/Databricks compute (per-tenant [id]/assist is in NOW_GUARDED)'],
  // (B) session-scoped Cosmos stores
  ['apps/fiab-console/app/api/connections/', 'B: connections-store partitions every read/write by session.claims.oid'],
  ['apps/fiab-console/app/api/thread/', 'B: thread-edges store scoped to the caller session'],
  // (C) global read-only metadata / external catalog
  ['apps/fiab-console/app/api/catalog/', 'C: federated catalog metadata over external Purview/Unity/Fabric (no per-tenant Cosmos rows)'],
  ['apps/fiab-console/app/api/copilot/', 'C: read-only Copilot tool-catalog metadata'],
  ['apps/fiab-console/app/api/cosmos/', 'C: Cosmos rerank utility over deployment config (no per-tenant item read by id)'],
  ['apps/fiab-console/app/api/help-copilot/', 'C: help index reindex over deployment-wide help content'],
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      walk(full, out);
    } else if (e.name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

function rel(f) {
  return path.relative(REPO_ROOT, f).split(path.sep).join('/');
}

// ─────────────────────────────────────────────────────────────────────────────
// C22 round 2 (#3122): SIGNALS MUST BE USES, AND THEY MUST BE IN THE HANDLER
// THAT NEEDS THEM. Both re-keys below were established by MUTATION — a route was
// really broken and the checker really stayed green — never by reading the code.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blank `import …;` STATEMENTS (length- and line-preserving, like the comment
 * stripper) so an imported NAME cannot satisfy a guard signal.
 *
 * MEASURED 2026-08-08 on `app/api/items/activator/[id]/route.ts`: every
 * `loadOwnedItem(id,'activator',session.claims.oid)` /`updateOwnedItem` /
 * `deleteOwnedItem` / `loadContentBackedItem` CALL was replaced with an unscoped
 * equivalent and every `session.claims.oid` with a caller-supplied
 * `?tenantId=`. The only occurrences of ANY guard signal left in the file were
 * the two import lines. This checker printed `violations: 0`.
 *
 * That is #2977 exactly — a control passing on a name that guards nothing —
 * with `import` in place of a comment. The comment case was closed by stripping
 * comments; a declaration is the same lie one syntax node over. Only a line-
 * leading `import` is blanked, so a dynamic `await import(...)` expression is
 * left as code.
 *
 * Cost of this re-key, measured before adopting it: ZERO routes in the tree
 * carry a signal only in an import today. It is a pure ratchet.
 */
export function stripImportStatements(code) {
  return code.replace(/(^|\n)([ \t]*)import\s[^;]*;/g, (m) =>
    m.replace(/[^\n]/g, ' '));
}

const HANDLER_NAMES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Offset just past the `)` matching the `(` at `open`. */
function closeParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return code.length;
}

/**
 * Body of a function whose parameter list opens at `parenOpen` — i.e. skip the
 * PARAMETERS and any return-type annotation, then take the block.
 *
 * Not a detail. `blockAt` alone takes the first `{` after the `(`, and in this
 * tree that `{` is routinely NOT the body:
 *   export async function DELETE(req: NextRequest, { params }: { params: … }) {
 *                                                  ^ destructured parameter
 *   export async function GET(_req: NextRequest, props: { params: Promise<…> }) {
 *                                                        ^ inline type literal
 * Taking either as the body yields a few tokens containing no guard, so
 * `admin/copilot/memory/[id]` (whose DELETE opens with `requireTenantAdmin`) and
 * ~390 siblings were reported as unguarded. Measured while building this: the
 * naive form produced 391 violations, of which the ones sampled were ALL false.
 * A checker that invents violations trains people to allowlist, which is how the
 * class this file exists for gets re-opened.
 */
function functionBody(code, parenOpen) {
  let i = closeParen(code, parenOpen);
  let angle = 0;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '=' && code[i + 1] === '>') { i++; continue; } // not a type close
    if (c === '<') angle++;
    else if (c === '>') { if (angle > 0) angle--; }
    else if (c === '{' && angle <= 0) {
      const block = blockAt(code, i);
      // A `{...}` in RETURN-TYPE position, not the body. TypeScript writes
      //   function resolveTenant(req): { tenantId: string; mode: 'x' } | null {
      // so the first top-level `{` after the parameters can belong to the TYPE.
      // Taking it as the body yielded a few tokens with no guard in them, which
      // is why `api/iq/mcp` POST read as unguarded while `resolveTenant` — the
      // function that resolves the caller's tenant from the session or a
      // validated bearer token — sat directly above it. Decide by what FOLLOWS
      // the block: a type is continued by `|`/`&`/`[`/`,` or is immediately
      // followed by the real body `{`.
      let j = i + block.length;
      while (j < code.length && /\s/.test(code[j])) j++;
      if ('{|&[,'.includes(code[j])) { i = i + block.length - 1; continue; }
      return block;
    } else if (c === ';' && angle <= 0) return ''; // overload signature, no body
  }
  return '';
}

/** Text of the brace-delimited block that starts at the first `{` at/after
 *  `from`, including both braces. Operates on stripped code, so no brace can
 *  hide inside a comment, string, or regex literal. */
function blockAt(code, from) {
  const open = code.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return code.slice(open, i + 1); }
  }
  return code.slice(open);
}

/** Bodies of MODULE-SCOPE bindings declared in the file, by name. These are the
 *  legitimate ways a handler delegates its guard:
 *    - `async function loadItem(id, type, tenantId) { … }`   items/[type]/[id]
 *    - `const adminSweep = withTenantAdmin(async (req,{session}) => { … })`
 *      access-governance/reviews/sweep — POST hands off to it for human callers
 *  so both are folded into the handler's effective text. Module scope is
 *  approximated by "declared at column 0", which is what a nested binding never
 *  is in this formatted tree.
 *
 *  `initializerExpression` (not a function-shaped regex) is used for the const
 *  form deliberately: the delegation target is frequently the RESULT of a
 *  wrapper call, not a literal arrow. Requiring an arrow here reported the sweep
 *  route as unguarded while `withTenantAdmin` was three lines above it. */
function localFunctionBodies(code) {
  const out = new Map();
  const decl = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
  let m;
  while ((m = decl.exec(code))) out.set(m[1], functionBody(code, m.index + m[0].length - 1));
  const binding = /(?:^|\n)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=/g;
  while ((m = binding.exec(code))) {
    if (out.has(m[1])) continue;
    out.set(m[1], initializerExpression(code, m.index + m[0].length));
  }
  return out;
}

/** A handler's body PLUS the bodies of every module-local binding it references,
 *  transitively. A guard threaded through a local helper still counts; a guard
 *  sitting in a SIBLING handler does not.
 *
 *  References are matched as `\bNAME\b`, not `\bNAME\s*\(`, because the alias
 *  export is a real idiom here — `export const POST = save;` (kql-queryset/[id])
 *  and `export const PUT = persist;` (rayfin-app/[id]) name the delegate without
 *  calling it, and requiring a call reported both as unguarded while `save` did
 *  the owner check. Erring toward pulling MORE text is the safe direction for a
 *  merge blocker: it can only cost sensitivity, never invent a violation — and
 *  the sensitivity it costs is pinned by the mutation self-tests below, which
 *  fail if any of them stops being detected. */
function effectiveHandlerText(body, localBodies) {
  let text = body;
  const pulled = new Set();
  for (let pass = 0; pass < 6; pass++) {
    let grew = false;
    for (const [name, fnBody] of localBodies) {
      if (pulled.has(name) || !fnBody) continue;
      if (new RegExp(`\\b${name}\\b`).test(text)) {
        pulled.add(name); text += '\n' + fnBody; grew = true;
      }
    }
    if (!grew) break;
  }
  return text;
}

/** The full initializer expression of `export const H = …`, up to the `;` that
 *  ends the STATEMENT — i.e. the first `;` at paren/brace/bracket depth 0. A
 *  naive `[^;]*` stops at the first semicolon INSIDE the arrow body, which
 *  truncated `export const GET = withSession(async (req,{session}) => { … })`
 *  after its first statement and reported 100+ correctly-guarded toolkit routes
 *  as violations while I was building this. A checker that invents violations is
 *  as useless as one that misses them. */
function initializerExpression(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth <= 0) return code.slice(from, i);
  }
  return code.slice(from);
}

/**
 * Effective text of each EXPORTED handler in the file, keyed by verb — the
 * handler's own body PLUS every module-local binding it references. Split out of
 * `unguardedHandlers` so the allowlist premise re-test below can ask a SECOND
 * question of the SAME text ("does this handler consume the route id?") rather
 * than re-deriving the handler boundaries with a looser regex and disagreeing
 * with the guard verdict about what a handler even is.
 *
 * WHY PER HANDLER — MEASURED 2026-08-08 on `app/api/workspaces/route.ts`, a
 * COLLECTION route. Two separate mutations, each a real cross-tenant hole:
 *   (M1)  the listing tenant taken from `?tenantId=` instead of the session;
 *   (M1b) the whole `getSession()` check plus the owner-scoped listing DELETED
 *         from GET, leaving it fully unauthenticated.
 * In BOTH runs this checker printed `violations: 0`, because `POST` in the same
 * file still mentioned `session.claims.oid` and the signal test was applied to
 * the FILE. A file-level test cannot see a handler-level hole; every route that
 * pairs a list GET with a create POST was covered by its sibling.
 *
 * `export const GET = withWorkspaceOwner(...)` is decided on its initializer:
 * the wrapper IS the control flow (there is no returned value to drop), which is
 * why the route-toolkit form is the preferred fix and not merely an equivalent
 * one. `withSession` is deliberately NOT a guard signal, so a `withSession`
 * handler is still judged on what its body does.
 */
function handlerTexts(code) {
  const localBodies = localFunctionBodies(code);
  const out = new Map();
  for (const h of HANDLER_NAMES) {
    const wrapped = new RegExp(`export\\s+const\\s+${h}\\s*(?::[^=\\n]*)?=`).exec(code);
    if (wrapped) {
      const expr = initializerExpression(code, wrapped.index + wrapped[0].length);
      out.set(h, effectiveHandlerText(expr, localBodies));
      continue;
    }
    const classic = new RegExp(`export\\s+async\\s+function\\s+${h}\\s*(?:<[^>]*>)?\\s*\\(`).exec(code);
    if (!classic) continue;
    const body = functionBody(code, classic.index + classic[0].length - 1);
    out.set(h, effectiveHandlerText(body, localBodies));
  }
  return out;
}

/**
 * Which exported handlers in this file carry NO authorization signal of their
 * own? Returns [] when the file is authorized handler-by-handler.
 *
 * `strong` selects {@link OWNERSHIP_SIGNAL_RE} instead of {@link GUARD_SIGNAL_RE}
 * — i.e. an attribution token like `claims.oid` no longer counts. Callers pass
 * it for routes in NOW_GUARDED; see OWNERSHIP_SIGNAL_RE for the measurement that
 * forced the distinction.
 *
 * `weakExempt` names handlers that fall BACK to the weak test within an
 * otherwise-strong file. It is a downgrade to WEAK, never to NOTHING — see
 * {@link STRONG_SIGNAL_EXEMPT}.
 */
function unguardedHandlers(code, strong = false, weakExempt = null) {
  const gaps = [];
  for (const [h, text] of handlerTexts(code)) {
    const re = strong && !(weakExempt && weakExempt.includes(h)) ? OWNERSHIP_SIGNAL_RE : GUARD_SIGNAL_RE;
    if (!re.test(text)) gaps.push(h);
  }
  return gaps;
}

/**
 * ── HANDLERS THAT FALL BACK TO THE **WEAK** TEST, NEVER TO NO TEST ──────────
 *
 * A graduated route is judged on {@link OWNERSHIP_SIGNAL_RE}. A handler here is
 * judged on {@link GUARD_SIGNAL_RE} instead — it must still show a
 * session-derived token, it merely may not be an item-ownership resolver.
 *
 * WHY THIS EXISTS RATHER THAN AN `ALLOWLIST` ENTRY, and the reason is a defect
 * this file caught in review of its own fix. The first version of the
 * strong-signal rule routed `warp/transforms` GET through `ALLOWLIST` with a
 * prose reason. `isAllowed` excuses a handler UNCONDITIONALLY, so that entry did
 * not weaken the check by a tier — it REMOVED it. Measured both directions:
 * de-scoping that GET (swapping `tenantWorkspaceIds(session.claims.oid)` for a
 * CALLER-CONTROLLED tenantId — a real cross-tenant hole, +39 B) is caught by the
 * merge-base checker (`violations: 1`, naming it) and was NOT caught by the
 * allowlisted version (`violations: 0`). The weak token was the only thing
 * pinning that handler, and the "fix" deleted it.
 *
 * That is precisely the failure this advisory is about — a static prose claim
 * standing in for a live test — reproduced inside the change that was meant to
 * close it. The entry's reason even cited line numbers, which is exactly the
 * kind of assertion that reads as verified and is never re-run.
 *
 * So: a two-tier downgrade with a live floor. `warp/transforms` GET keeps its
 * weak test, and the mutation above stays RED.
 *
 * PER HANDLER, never per file: `warp/transforms` POST is NOT listed and does not
 * need to be — it runs `authorizeWorkspace` (`:198`), a strong signal.
 */
const STRONG_SIGNAL_EXEMPT = new Map([
  // GET scopes every Cosmos read to workspaces the CALLER owns:
  // `tenantWorkspaceIds(session.claims.oid)` (:95) → `SELECT c.id FROM c WHERE
  // c.tenantId = @t` with `partitionKey` (:79-88), then every later query is
  // constrained to `c.workspaceId IN (…)` (:107, :133). That is `claims.oid` as
  // a PARTITION PREDICATE — role 2 in `_route-auth-scope.mjs`'s taxonomy — not
  // role 3, the attribution field that fooled this checker on
  // `databricks-sql-warehouse/[id]/query`. Weak, but real, and still tested.
  ['apps/fiab-console/app/api/experience/warp/transforms/route.ts', ['GET']],
]);

/**
 * ── THE ALLOWLIST'S OWN PREMISE, RE-TESTED EVERY RUN (GHSA-hf73-rp4q-66pf) ──
 *
 * This checker verifies THAT an id-addressed route is authorized. Until now it
 * honoured `SHARED_BACKEND_ITEM_ROUTES` **without ever re-testing the reason the
 * entry was written for**, so an entry added on a premise that never applied —
 * or that stopped applying after a refactor — stayed green indefinitely. That is
 * this repo's most-repeated failure class: a guard whose POPULATION excludes the
 * thing it should be watching.
 *
 * The recorded class reason is:
 *
 *   "specific-per-item-TYPE route over a SHARED Azure backend … no per-tenant
 *    Cosmos ownership to scope"
 *
 * Its second clause — **there is no per-tenant Cosmos ownership to scope** — is
 * falsifiable WITHIN THIS TREE, with no judgement call: if a SIBLING route under
 * `items/<same type>/[id]/**` resolves that same `[id]` through an item-ownership
 * resolver, then `[id]` names an ownable Loom item and ownership demonstrably IS
 * scopeable. Two routes under one item type cannot both be right about what
 * `[id]` means. So the premise is TESTED, not trusted.
 *
 * That is the exact signature the advisory was derived from, and it is why the
 * test is keyed to the sibling rather than to the id:
 *
 *   - "the path contains `[id]`" was the FIRST sweep's signature and reported 44.
 *     Wrong by 19: the 14-route `azure-sql-database` family exports `POST(req)`
 *     and never reads `ctx.params`.
 *   - "the handler CONSUMES the route id" is closer and reports 87 — but it still
 *     over-reaches, because for `apim-api/[id]`, `adf-trigger/[id]`,
 *     `compute/[id]`, `dataverse-table/[id]` and their kin the `[id]` IS the
 *     Azure object's own name on the deployment-shared backend (an APIM API id,
 *     an ADF trigger name, an ARM VM name). Those are id-addressed AND genuinely
 *     have no Cosmos item behind them, so the class reason still holds; flagging
 *     them would assert something the code does not establish (deploy-integrity
 *     R7) and would train the next reader to widen the allowlist to make a noisy
 *     control shut up — which is how this class re-opens.
 *   - "a SIBLING under the same item type resolves this `[id]` as an owned item"
 *     is a contradiction inside the repo, not a heuristic about naming.
 *
 * SELF-INVALIDATING — WITHIN CHECK 2'S POPULATION, WHICH IS NOT EVERY ROUTE. The
 * moment ANY route under an item type adopts an owner check on `[id]`, every
 * allowlisted sibling of that type is re-tested against the new evidence and
 * fails. An entry cannot outlive the premise it was written on, which is the
 * property the 20 routes exploited for as long as they did.
 *
 * THE LIMIT, stated because a control that overstates its own reach is precisely
 * what this file exists to prevent — and because the change that added CHECK 3
 * documented this same weakness on `dashboard/[id]/tile-query` and would
 * otherwise contradict itself. CHECK 3 is consulted only for handlers CHECK 2
 * already flagged, i.e. only when `gaps.length > 0`. A handler that satisfies
 * GUARD_SIGNAL_RE is therefore invisible to CHECK 3 as well, inheriting CHECK 2's
 * presence-vs-enforcement weakness (see "WHAT IS STILL NOT PROVEN HERE": a bare
 * `claims.oid` used as an AUDIT FIELD satisfies the signal).
 *
 * MEASURED in review, not reasoned: restore `semantic-model/[id]/take-over` to
 * fully unauthorized and add `console.info(String(session.claims.oid));` — this
 * file prints `contradicted: 0`, `violations: 0` and exits 0, on a route that
 * transfers Power BI dataset ownership. Closing it means dropping bare `claims.*`
 * from GUARD_SIGNAL_RE, which takes the tree from 0 to ~205 violations: a scoped
 * program, not a checker tweak, and NOT done here.
 *
 * Tested only where the entry is LOAD-BEARING — the handler genuinely carries no
 * guard and the allowlist is the sole reason it passes. A listed route that has
 * since adopted a real guard never consults its entry.
 */
const ITEM_OWNERSHIP_RESOLVER_RE = new RegExp(
  [
    'loadOwnedItem', 'updateOwnedItem', 'deleteOwnedItem', 'softDeleteOwnedItem',
    'loadContentBackedItem', 'withWorkspaceOwner', 'authorizeItemWorkspace',
    'resolveItemAccessByOid',
    'authorizeNotebookItem', 'authorizeDatabricksJobItem', 'authorizeDatabricksPipelineItem',
    // GHSA-v8r7-c2p5-mjf2 — the Azure SQL / PostgreSQL item-route guard. Listed
    // here so `azure-sql-database` and `postgres-flexible-server` count as types
    // whose `[id]` IS resolvable as an owned item: that is what makes CHECK 3
    // falsify the "no per-tenant Cosmos ownership to scope" premise for any
    // SIBLING in those families that is still body-addressed.
    'withBoundSqlServer',
    // ...and its Layer-1-only sibling. Same purpose here: a type whose `[id]` is
    // resolved as an OWNED item by ANY of its routes cannot also claim "no
    // per-tenant Cosmos ownership to scope" for a body-addressed sibling.
    'withOwnedSqlItem',
  ].map((n) => `${n}(?:<[^()]*>)?\\s*\\(`).join('|'),
);

const ITEM_TYPE_DIR_RE = /^apps\/fiab-console\/app\/api\/items\/([^/]+)\/\[id\]\//;

/** Item types with at least one `[id]` route that resolves `[id]` as an OWNED
 *  Loom item — i.e. types for which "no per-tenant Cosmos ownership to scope" is
 *  provably false. Built once from the tree, never hand-maintained. */
function itemTypesWithOwnedIdSiblings(files) {
  const scoped = new Set();
  for (const f of files) {
    const m = ITEM_TYPE_DIR_RE.exec(rel(f));
    if (!m) continue;
    if (scoped.has(m[1])) continue;
    const src = stripImportStatements(stripCommentsAndStrings(fs.readFileSync(f, 'utf8')));
    if (ITEM_OWNERSHIP_RESOLVER_RE.test(src)) scoped.add(m[1]);
  }
  return scoped;
}

const ROUTE_PARAM_USE_RE = /\bparams\b/;

function falsifiedSharedBackendPremise(r, src, gaps, scopedTypes) {
  if (!hasSharedBackendClassReason(r)) return [];
  const m = ITEM_TYPE_DIR_RE.exec(r);
  if (!m || !scopedTypes.has(m[1])) return [];
  const texts = handlerTexts(src);
  // The handler must actually CONSUME the id for the contradiction to bite: a
  // sibling proving the type is ownable says nothing about a handler that never
  // touches `[id]` (e.g. `release-environment/[id]/swap`, which ignores it).
  return gaps.filter((h) => ROUTE_PARAM_USE_RE.test(texts.get(h) || ''));
}

// ── CHECK 3B — the PREFIX premise (#3607) ────────────────────────────────────
//
// THE GAP CHECK 3 LEFT OPEN. `falsifiedSharedBackendPremise` above returns `[]`
// before doing any work unless the route matches `ITEM_TYPE_DIR_RE`. So the
// mechanical premise re-test — the whole answer to GHSA-hf73-rp4q-66pf, "an
// allowlist entry is a claim about the code, so test it rather than trust it" —
// covered PER-ROUTE item entries and left CLASS PREFIXES entirely untested.
//
// That is the exact shape of the GHSA-fj7j-qq8g-hqj8 incident: the vulnerable
// route sat under a blanket class prefix and this checker reported
// `violations: 0` throughout. A class prefix is a BROADER claim than a
// per-route reason — it asserts something about every route under it, including
// routes written years after the reason was — so it needed MORE re-testing, and
// got none.
//
// WHAT IS MECHANICALLY ESTABLISHABLE, and what is not (R7 — this file does not
// assert what it cannot show). A reason is prose; most of it cannot be checked
// against code. But a reason that claims a READ-ONLY or DISCOVERY posture makes
// a falsifiable claim about the HTTP verbs underneath it, and that one can be
// tested exactly: if a load-bearing route under the prefix exposes an unguarded
// MUTATING handler, the prefix's stated reason is not true of it. Nothing here
// claims the route is exploitable — it claims the RECORDED REASON does not
// describe it, which is the thing an allowlist entry is supposed to do.
//
// The remedy is never to widen the prefix. It is either to narrow the prefix,
// or to give the route its own per-route reason that IS true of it — the same
// remedy CHECK 3 already prescribes, and the same one #3572 applied when
// `app/api/storage/` was narrowed to `app/api/storage/accounts/`.

const MUTATING_HANDLERS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A prefix reason that claims a read-only / discovery posture.
 *
 * DELIBERATELY NARROW, and narrowed once already against a measurement. The
 * first cut also matched `metadata` and searched the WHOLE reason string, and it
 * returned 8 findings — but three of them were `app/api/loom/`, whose reason
 * says "discovery" only inside a trailing NOTE about ONE sub-route
 * (model-serving/endpoints), and four were `app/api/catalog/`, whose "federated
 * catalog metadata" describes the DATA rather than claiming the prefix is
 * read-only. Neither is a contradiction, and a checker that reports one it
 * cannot substantiate is how a checker gets switched off (R7).
 *
 * So: only the reason's LEADING CLAUSE is the class claim — everything before
 * the first em-dash, parenthetical aside or `NOTE`, which is where these entries
 * state their posture — and `metadata` is not in the vocabulary. `navigator` is
 * not either: a navigator over a shared Azure backend legitimately creates and
 * updates objects in that backend.
 */
const READ_ONLY_CLAIM_RE = /\bread-only\b|\bscan\b|\bdiscovery\b/i;

/** The part of a reason that states the class claim, before any aside. */
function reasonClaim(reason) {
  return String(reason).split(/—|\bNOTE\b/)[0];
}

/** The ALLOWLIST_PREFIXES entry excusing `r`, or null. */
function matchingPrefix(r) {
  for (const entry of ALLOWLIST_PREFIXES) if (r.startsWith(entry[0])) return entry;
  return null;
}

/**
 * @returns {{prefix:string, reason:string, verbs:string[]}|null} — non-null when
 * the prefix's recorded reason claims a read-only/discovery posture and the
 * route is load-bearing on it with an unguarded mutating handler.
 */
function falsifiedPrefixPremise(r, gaps) {
  // A hand-written per-route reason overrides the class default — the route has
  // then been individually justified and the class claim is not what excuses it.
  if (ALLOWLIST.has(r)) return null;
  const entry = matchingPrefix(r);
  if (!entry) return null;
  const [prefix, reason] = entry;
  if (!READ_ONLY_CLAIM_RE.test(reasonClaim(reason))) return null;
  const verbs = gaps.filter((h) => MUTATING_HANDLERS.has(h));
  if (!verbs.length) return null;
  return { prefix, reason, verbs };
}



/** How many returned-value gate CALLS a file makes (comment/string-stripped, so
 *  a name in prose is not counted). Printed so a run that silently stops seeing
 *  gates — the "measures nothing" failure mode — is visible as the number
 *  collapsing, not as a quiet green. */
function countGateCalls(raw) {
  const code = stripCommentsAndStrings(raw);
  let n = 0;
  for (const g of RETURNED_VALUE_GATES) {
    n += (code.match(new RegExp(`\\b${g}(?:<[^()]*>)?\\s*\\(`, 'g')) || []).length;
  }
  return n;
}

/** A flagged route is intentionally session-only when it's on the per-route
 *  ALLOWLIST, OR under an ALLOWLIST_PREFIXES class — but a NOW_GUARDED route
 *  (a fixed per-tenant hole) is NEVER allowlisted, so if its owner-check ever
 *  regresses the checker re-flags it.
 *
 *  C22 round 2 (#3122): an entry may be a plain reason STRING (the whole file is
 *  session-only-safe) or `{ handlers: [...], reason }` (only those handlers are).
 *  The per-handler form exists because per-handler scoping surfaced files that
 *  are legitimately MIXED — `aml/environments` list/create run against the
 *  deployment-shared AML workspace while its PATCH attaches an environment to a
 *  per-tenant notebook item. Under the old file-level test one guard covered
 *  both; allowlisting the whole file to re-green the shared half would have
 *  un-pinned the guarded half, which is how a checker gets quietly widened. */
function isAllowed(r, gaps) {
  if (NOW_GUARDED.has(r)) {
    const entry = ALLOWLIST.get(r);
    // A NOW_GUARDED route may still carry a per-HANDLER excuse (its shared-backend
    // half); it may never be excused wholesale.
    if (entry && typeof entry === 'object' && Array.isArray(entry.handlers)) {
      return gaps.every((h) => entry.handlers.includes(h));
    }
    return false;
  }
  const entry = ALLOWLIST.get(r);
  if (typeof entry === 'string') return true;
  if (entry && Array.isArray(entry.handlers)) return gaps.every((h) => entry.handlers.includes(h));
  for (const [prefix] of ALLOWLIST_PREFIXES) if (r.startsWith(prefix)) return true;
  return false;
}

/**
 * #2988 — a guard SIGNAL is only trustworthy if the thing it names still guards.
 *
 * `assertOwner` taught this the hard way: it stayed in the signal lists after
 * PR #2973 deleted the function, so 34 routes passed a merge-blocking check on
 * the strength of a COMMENT. Wrapper signals are the same hazard one level up —
 * a route delegating to `authorizeNotebookItem` is only authorized if that
 * wrapper still resolves a session and still runs the canonical ladder.
 *
 * This asserts the wrapper's SUBSTANCE, not its name: the module must exist, and
 * it must call `getSession(` and `authorizeItemWorkspace(`. Hollow the wrapper
 * out — or delete the module — and this fails LOUDLY, instead of every consumer
 * route silently sliding out of the checker's remit (which is exactly what the
 * bare `getSession(` remit test did before this: a route with no literal
 * `getSession` was SKIPPED, so moving the guard into a helper made the route
 * invisible to the guard AND flipped it to `public` in the route inventory).
 */
const GUARD_WRAPPERS = [
  {
    name: 'authorizeNotebookItem',
    file: path.join(
      CONSOLE_ROOT, 'app', 'api', 'items', 'databricks-notebook', '_lib', 'notebook-exec-scope.ts',
    ),
    mustCall: ['getSession\\s*\\(', 'authorizeItemWorkspace\\s*\\('],
  },
  {
    name: 'authorizeDatabricksJobItem',
    file: path.join(
      CONSOLE_ROOT, 'app', 'api', 'items', 'databricks-job', '_lib', 'job-scope.ts',
    ),
    mustCall: ['getSession\\s*\\(', 'authorizeItemWorkspace\\s*\\('],
  },
  {
    name: 'authorizeDatabricksPipelineItem',
    file: path.join(
      CONSOLE_ROOT, 'app', 'api', 'items', 'databricks-pipeline', '_lib', 'pipeline-scope.ts',
    ),
    mustCall: ['getSession\\s*\\(', 'authorizeItemWorkspace\\s*\\('],
  },
  {
    // GHSA-v2g8-gp3r-rg4r — the ADX item-route guard. Same hazard, same bar: a
    // route delegating to it is authorized only while it still resolves a
    // session AND runs the canonical ladder AND resolves the database from the
    // item.
    //
    // THE LAST REGEX IS NOT A CALL CHECK, AND THAT IS THE POINT. `mustCall` is
    // a PRESENCE test, so `resolveItemDatabase\s*\(` alone is satisfied by this,
    // which reintroduces the whole advisory:
    //     const bound = resolveItemDatabase(item);
    //     const requested = typeof (opts as any).database === 'string' ? … : '';
    //     return { ctx: { session, item, database: requested || bound } };
    // Every caller then gets a caller-supplied database while the checker stays
    // green. Pinning the RETURN EXPRESSION — `database: resolveItemDatabase(item)`
    // and nothing else — is what makes the assertion about behaviour rather than
    // vocabulary. A future refactor that legitimately renames the binding must
    // update this line, which is the intended cost.
    name: 'guardAdxItemRequest',
    file: path.join(CONSOLE_ROOT, 'app', 'api', 'items', '_lib', 'adx-item-scope.ts'),
    mustCall: [
      'getSession\\s*\\(',
      'authorizeItemWorkspace\\s*\\(',
      'database:\\s*resolveItemDatabase\\s*\\(\\s*item\\s*\\)',
    ],
  },
  {
    // GHSA-v2g8-gp3r-rg4r round 3 — the Synapse sibling. Held to the IDENTICAL
    // bar, including the pinned RETURN EXPRESSION, for the reason spelled out
    // above: `mustCall` is a presence test, so asserting only that
    // `resolveItemSynapseDatabase` appears somewhere in the wrapper would be
    // satisfied by a body that computes it and then prefers a caller-supplied
    // value. Pinning `database: resolveItemSynapseDatabase(item)` makes the
    // assertion about behaviour rather than vocabulary.
    name: 'guardSynapseItemRequest',
    file: path.join(CONSOLE_ROOT, 'app', 'api', 'items', '_lib', 'synapse-item-scope.ts'),
    mustCall: [
      'getSession\\s*\\(',
      'authorizeItemWorkspace\\s*\\(',
      'database:\\s*resolveItemSynapseDatabase\\s*\\(\\s*item\\s*\\)',
    ],
  },
  {
    // GHSA-v8r7-c2p5-mjf2 — the Azure SQL / PostgreSQL item-route guard. Six
    // routes delegate their ENTIRE authorization to it, so hollowing it out must
    // fail HERE rather than silently disarming all six while they keep matching
    // GUARD_SIGNAL_RE.
    //
    // THE LAST TWO REGEXES ARE PINNED TO EXPRESSIONS, NOT NAMES, for the reason
    // the sibling above records. `mustCall` is a PRESENCE test, so
    // `admitGovernedServer\s*\(` alone is satisfied by a wrapper that admits the
    // binding, ignores the answer, and hands the handler the RAW value:
    //     const admitted = admitGovernedServer(bound.server, opts.provider);
    //     return handler(req, { …, server: bound.server as ScopedSqlServer });
    // — which reinstates the whole advisory with the checker green. Pinning
    // `server: admitted.server` asserts that what reaches the handler is the
    // ADMITTED value; pinning `loadOwnedSqlItem` asserts Layer 1 is still there.
    //
    // THIS BLOCK EARNED ITS KEEP: the second-pass refactor (multi-item-type
    // resolution, so a `postgres-flexible-server` item stops 404ing) replaced
    // `withWorkspaceOwner` with `withSession` + `loadOwnedSqlItem`, and this
    // check FAILED the run rather than letting the pin rot into a name that no
    // longer describes the code.
    name: 'withBoundSqlServer',
    file: path.join(CONSOLE_ROOT, 'app', 'api', 'items', '_lib', 'sql-server-scope.ts'),
    exportKind: 'function',
    mustCall: [
      'withSession\\s*(?:<[^()]*>)?\\s*\\(',
      'loadOwnedSqlItem\\s*\\(',
      'admitGovernedServer\\s*\\(\\s*bound\\.server\\s*,',
      'server:\\s*admitted\\.server',
    ],
  },
  {
    // The owner-resolution half of the wrapper above, asserted separately
    // because `withBoundSqlServer` now delegates Layer 1 to it: if this stops
    // running the canonical `loadOwnedItem` check — or stops threading the
    // caller's own oid — every route in the family is unauthorized while the
    // wrapper still looks intact.
    name: 'loadOwnedSqlItem',
    file: path.join(CONSOLE_ROOT, 'app', 'api', 'items', '_lib', 'sql-server-scope.ts'),
    exportKind: 'async-function',
    mustCall: ['loadOwnedItem\\s*\\(\\s*id\\s*,\\s*itemType\\s*,\\s*session\\.claims\\.oid\\s*,'],
  },
  {
    // GHSA-v8r7-c2p5-mjf2, FOURTH PASS — the LAYER-1-ONLY wrapper for the four
    // routes whose server is a caller PICK. Four routes delegate their ENTIRE
    // ownership check to it, so hollowing it out must fail HERE rather than
    // silently disarming all four while they keep matching GUARD_SIGNAL_RE.
    //
    // PINNED TO AN EXPRESSION, NOT A NAME, for the reason its sibling records:
    // `mustCall` is a PRESENCE test, so `loadOwnedSqlItem\s*\(` alone is
    // satisfied by a wrapper that resolves the item, ignores the answer and
    // calls the handler anyway:
    //     const item = await loadOwnedSqlItem(id, sctx.session, itemTypes, …);
    //     return handler(req, { …, item: item ?? ({} as WorkspaceItem) });
    // — which reinstates the whole class with this checker green. Pinning
    // `if (!item) return apiNotFound()` asserts the answer is ACTED ON, which is
    // the same "gates whose answer is DISCARDED" failure this file counts
    // elsewhere. `withSession` pins that a session is required at all.
    name: 'withOwnedSqlItem',
    file: path.join(CONSOLE_ROOT, 'app', 'api', 'items', '_lib', 'sql-server-scope.ts'),
    exportKind: 'function',
    mustCall: [
      'withSession\\s*(?:<[^()]*>)?\\s*\\(',
      'loadOwnedSqlItem\\s*\\(',
      'if\\s*\\(\\s*!item\\s*\\)\\s*return\\s+apiNotFound\\s*\\(',
    ],
  },
  // C22 (#3088) — the route-toolkit wrappers are guard signals too, and they
  // are the SAME hazard one level up: a route adopting `withTenantAdmin` is
  // authorized only while that wrapper still runs its gate. Hollow any of them
  // out and every consumer route silently loses its authorization while still
  // matching GUARD_SIGNAL_RE. They are declared with `export function`, not
  // `export async function`, so the export shape is checked accordingly.
  {
    name: 'withTenantAdmin',
    file: path.join(CONSOLE_ROOT, 'lib', 'api', 'route-toolkit.ts'),
    exportKind: 'function',
    mustCall: ['requireTenantAdmin\\s*\\('],
  },
  {
    name: 'withDlzAccess',
    file: path.join(CONSOLE_ROOT, 'lib', 'api', 'route-toolkit.ts'),
    exportKind: 'function',
    mustCall: ['denyIfNoDlzAccess\\s*\\('],
  },
  {
    name: 'withCapability',
    file: path.join(CONSOLE_ROOT, 'lib', 'api', 'route-toolkit.ts'),
    exportKind: 'function',
    mustCall: ['enforceCapability\\s*\\('],
  },
  {
    name: 'withWorkspaceOwner',
    file: path.join(CONSOLE_ROOT, 'lib', 'api', 'route-toolkit.ts'),
    exportKind: 'function',
    mustCall: ['loadOwnedItem\\s*\\('],
  },
  // C22 round 2 (#3122) — `tenantScopeId` is a guard signal, so it is held to the
  // same standard: it must still DERIVE the tenant from the session. If it ever
  // starts reading a request/parameter instead, every route scoped by it silently
  // loses its tenant boundary while continuing to match GUARD_SIGNAL_RE. The
  // `mustCall` regexes here assert its body reads `claims.tid`/`claims.oid`.
  {
    name: 'tenantScopeId',
    file: path.join(CONSOLE_ROOT, 'lib', 'auth', 'session.ts'),
    exportKind: 'function',
    mustCall: ['claims\\.tid', 'claims\\.oid'],
  },
];

/**
 * The SOURCE OF THE NAMED EXPORTED FUNCTION ONLY — brace-matched from its
 * keyword — or null when it cannot be located.
 *
 * WHY THIS EXISTS. `mustCall` used to be matched against the WHOLE MODULE, which
 * is the "presence, not enforcement" blind spot this repo has been bitten by
 * before. MEASURED on 2026-08-14: replacing `resolveItemDatabase(item)` with
 * `defaultDatabase()` inside `guardAdxItemRequest` — i.e. handing every caller a
 * database NOT resolved from the item, which is the whole of
 * GHSA-v2g8-gp3r-rg4r — left this checker GREEN, because `workspaceAdxScope` in
 * the SAME FILE still called `resolveItemDatabase`. A sibling function satisfied
 * an assertion about the wrapper, exactly as a comment once satisfied an
 * assertion about `assertOwner`.
 *
 * Input is already comment/string-stripped, so a brace inside a string or a
 * comment cannot unbalance the scan.
 */
function namedExportBody(src, name) {
  // ALL declarations, not the first: `withWorkspaceOwner` is declared as two
  // TypeScript OVERLOAD SIGNATURES followed by the implementation, and an
  // overload has no body (functionBody returns '' on the `;`). Taking the first
  // match failed closed on a wrapper that is perfectly intact.
  const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`, 'g');
  for (let decl = re.exec(src); decl; decl = re.exec(src)) {
    const paren = src.indexOf('(', decl.index);
    if (paren < 0) continue;
    // Delegate to the existing brace scanner: it already skips a `{…}` sitting
    // in TYPESCRIPT RETURN-TYPE position and returns '' for an overload.
    const body = functionBody(src, paren);
    if (body) return body;
  }
  return null;
}

function assertGuardWrappersAreReal() {
  const bad = [];
  for (const w of GUARD_WRAPPERS) {
    if (!fs.existsSync(w.file)) {
      bad.push(`${w.name}: module missing (${rel(w.file)}) — routes delegating to it are unguarded`);
      continue;
    }
    // Comment/string-stripped: a wrapper whose gate call survives only in its
    // own doc comment is exactly the #2977 lie, one level up.
    const src = stripCommentsAndStrings(fs.readFileSync(w.file, 'utf8'));
    const exportRe = w.exportKind === 'function'
      ? new RegExp(`export\\s+function\\s+${w.name}\\b`)
      : new RegExp(`export\\s+async\\s+function\\s+${w.name}\\b`);
    if (!exportRe.test(src)) {
      bad.push(`${w.name}: not exported from ${rel(w.file)}`);
      continue;
    }
    // Scoped to the wrapper's OWN body — see functionBody() for the measurement
    // that made this necessary. An unlocatable body fails closed rather than
    // silently falling back to the whole module.
    const body = namedExportBody(src, w.name);
    if (body === null) {
      bad.push(
        `${w.name}: its body could not be located in ${rel(w.file)} — ` +
        'the mustCall assertions below cannot be evaluated, so this fails closed.',
      );
      continue;
    }
    for (const must of w.mustCall) {
      if (!new RegExp(must).test(body)) {
        bad.push(`${w.name}: no longer calls /${must}/ — the wrapper no longer authorizes`);
      }
    }
  }
  // A wrapper's OWN gate result must be consumed — a wrapper that calls its gate
  // and drops the answer is the C22 defect hiding behind a signal this checker
  // treats as structural. Scanned ONCE PER FILE and reported against the file,
  // not against each wrapper declared in it: attributing an `enforceCapability`
  // discard to `withTenantAdmin` (which does not call it) would be an error
  // message asserting something the code never established — deploy-integrity
  // R7, the same class as the "the tag does not exist" incident.
  for (const file of [...new Set(GUARD_WRAPPERS.map((w) => w.file))]) {
    if (!fs.existsSync(file)) continue;
    for (const d of findDiscardedGateResults(fs.readFileSync(file, 'utf8'))) {
      bad.push(
        `${rel(file)}:${d.line} — ${d.gate} is called and ${d.reason}. ` +
        'A wrapper that runs its check and ignores the answer authorizes nothing, ' +
        'while every route that adopts it still matches GUARD_SIGNAL_RE.',
      );
    }
  }
  if (bad.length) {
    console.error('\n[route-guards] FAIL — a guard WRAPPER named in GUARD_SIGNAL_RE is not real:');
    for (const b of bad) console.error(`  - ${b}`);
    console.error('\nEvery route that delegates to it is therefore unguarded while still');
    console.error('matching the signal. Restore the wrapper or remove it from GUARD_SIGNAL_RE.');
    process.exit(1);
  }
}

/**
 * SENSITIVITY PROBES — the checker proves, every run, that its verdict CHANGES
 * when a route stops enforcing.
 *
 * THE RULE THIS ENCODES: *if a guard's verdict doesn't change when you break the
 * route, it isn't watching it.* Every defect in this family was found by
 * mutation and none was visible by reading: #2977 (a deleted `assertOwner`
 * surviving as a COMMENT), #3088 (`if (gate) return gate;` deleted while the
 * `enforceCapability` CALL stayed), and the two closed here — a guard signal
 * surviving only as an IMPORT, and a signal in a SIBLING handler standing in for
 * the handler that actually needed one. In all four cases the checker printed
 * `violations: 0` against genuinely broken code.
 *
 * So sensitivity is no longer left to a reviewer to re-establish by hand: each
 * probe takes a REAL route, applies a REAL break IN MEMORY (nothing is written
 * to disk), and asserts the broken handler shows up in the verdict. Weaken any
 * of the re-keys above and these fail, loudly, before a single route is scanned.
 *
 * A probe whose anchor no longer matches is a FAILURE, never a skip. A silently
 * skipped self-test is the same lie one level up: it would let a refactor disarm
 * the proof while the run stayed green.
 */
const SENSITIVITY_PROBES = [
  {
    name: 'COLLECTION route — GET loses its owner scope while POST keeps `claims.oid`',
    file: 'apps/fiab-console/app/api/workspaces/route.ts',
    edits: [
      ["  const session = getSession();\n"
        + "  if (!session) return err('Unauthorized', 401, 'unauthorized');\n"
        + "  const tenantId = session.claims.oid;",
        "  const tenantId = req.nextUrl?.searchParams.get('tenantId') || '';"],
      ['await listAccessibleWorkspaces(tenantId, { callerTid: session.claims.tid })',
        'await listAccessibleWorkspaces(tenantId, {})'],
    ],
    expect: 'GET',
  },
  {
    name: 'SINGLE-ITEM route — PUT loses its owner check while GET/DELETE keep theirs',
    file: 'apps/fiab-console/app/api/items/dashboard/[id]/route.ts',
    edits: [
      ["  const denied = await denyUnlessAuthorized(session, id, req.nextUrl.searchParams.get('workspaceId'));\n"
        + "  if (denied) return denied;\n"
        + "  const body = await req.json().catch(() => null);",
        "  const body = await req.json().catch(() => null);"],
      // The `savedBy` attribution is removed TOO, and that is not padding — it is
      // the honesty boundary of this probe. With the attribution left in, PUT
      // still contains the token `session.claims.oid` and this checker still
      // passes it, because a bare `claims.oid` cannot be told apart from an
      // authorization use by name alone. See "WHAT IS STILL NOT PROVEN HERE".
      ['sanitizeOverlay(id, body, session.claims.upn || session.claims.oid)',
        'sanitizeOverlay(id, body, String(body?.savedBy || ""))'],
    ],
    expect: 'PUT',
  },
  {
    name: 'SINGLE-ITEM route — every guard CALL replaced, the IMPORT left behind',
    file: 'apps/fiab-console/app/api/items/activator/[id]/route.ts',
    edits: [
      ["await loadOwnedItem(id, 'activator', session.claims.oid)",
        "await loadAnyItemUnscoped(id, 'activator', callerTenant(req))"],
      ["await deleteOwnedItem(id, 'activator', session.claims.oid)",
        "await deleteAnyItemUnscoped(id, 'activator', callerTenant(req))"],
      ["await loadContentBackedItem(id, 'activator', tenantId)",
        "await loadAnyContentUnscoped(id, 'activator', tenantId)"],
      ["await loomActivator(id, session.claims.oid, workspaceId)",
        "await loomActivator(id, callerTenant(req), workspaceId)"],
    ],
    expect: 'GET',
  },
  {
    name: 'COLLECTION route — the workspace membership check is deleted, its import retained',
    file: 'apps/fiab-console/app/api/items/activator/route.ts',
    edits: [
      ["  const denied = await authorizeWorkspace(session, workspaceId, { allowReadRoles: true });\n"
        + "  if (denied) return denied;", ''],
    ],
    expect: 'GET',
  },
];

function assertCheckerIsSensitive() {
  const bad = [];
  for (const probe of SENSITIVITY_PROBES) {
    const full = path.join(REPO_ROOT, probe.file);
    if (!fs.existsSync(full)) {
      bad.push(`${probe.name}: probe target ${probe.file} no longer exists`);
      continue;
    }
    let src = fs.readFileSync(full, 'utf8');
    let missing = null;
    for (const [rawFrom, rawTo] of probe.edits) {
      let from = rawFrom; let to = rawTo;
      if (!src.includes(from)) {
        // The tree is CRLF; anchors here are authored with \n.
        const crlf = from.replace(/\n/g, '\r\n');
        if (!src.includes(crlf)) { missing = from.split('\n')[0].trim(); break; }
        from = crlf; to = to.replace(/\n/g, '\r\n');
      }
      src = src.split(from).join(to);
    }
    if (missing) {
      bad.push(
        `${probe.name}: the code this probe breaks has changed — anchor not found: \`${missing}\`. `
        + 'Re-point the probe at the current guard; do NOT delete it. Without a probe the '
        + 'checker has no evidence its verdict still changes when this route stops enforcing.',
      );
      continue;
    }
    const gaps = unguardedHandlers(stripImportStatements(stripCommentsAndStrings(src)));
    if (!gaps.includes(probe.expect)) {
      bad.push(
        `${probe.name}: ${probe.expect} was broken in ${probe.file} and the checker STILL PASSED it `
        + `(flagged: ${gaps.length ? gaps.join(', ') : 'nothing'}).`,
      );
    }
  }
  if (bad.length) {
    console.error('\n[route-guards] FAIL — the checker cannot demonstrate it detects a broken route:');
    for (const b of bad) console.error(`  - ${b}`);
    console.error('\nEvery defect in this family passed a green checker. A guard that cannot show');
    console.error('its own sensitivity is indistinguishable from one that measures nothing, so');
    console.error('this is a hard failure, not a warning.');
    process.exit(1);
  }
  console.log(`[route-guards] sensitivity probes passed: ${SENSITIVITY_PROBES.length} (each breaks a real route in memory and must be caught)`);
}

/**
 * SENSITIVITY PROBE FOR CHECK 3 — the premise re-test must itself be shown to
 * bite, every run, for the same reason every other control here is.
 *
 * The probe reproduces the EXACT regression the advisory describes, in memory:
 * take a route that has been fixed and graduated, put it back into
 * `SHARED_BACKEND_ITEM_ROUTES` (i.e. undo the graduation), and strip its guard.
 * That is the shape 20 routes were in. CHECK 2 goes GREEN on it — the allowlist
 * entry excuses the handler, which is precisely why this class survived — so if
 * CHECK 3 does not fire, nothing in this file does.
 *
 * A probe whose anchors no longer match is a FAILURE, never a skip: without it
 * the premise re-test could be weakened to a no-op while the run stayed green,
 * which is the failure mode the whole advisory is about.
 */
const PREMISE_PROBE = {
  route: 'apps/fiab-console/app/api/items/dashboard/[id]/tile-embed-token/route.ts',
  handler: 'POST',
  /** Cut from the guard CALL to the end of the short-circuit that consumes it —
   *  removing both leaves a syntactically valid, session-only, id-addressed
   *  handler. Stripping only one would leave a parse error, and a probe that
   *  fails on a syntax error proves nothing (the lesson from PR #3529). */
  from: '  const denied = await authorizeItemWorkspace(session, {',
  to: '  if (denied) return denied;',
};

/**
 * SENSITIVITY PROBE FOR CHECK 3B (#3607) — same contract as the CHECK 3 probe
 * above, and for the same reason: CHECK 3B now reports 0, and a zero from a
 * check that has stopped checking is worth nothing.
 *
 * It reproduces the PRE-#3607 state in memory: take a route that is genuinely
 * under a read-only-claiming class prefix and genuinely exposes an unguarded
 * mutating handler, remove the per-route reason that was written for it, and
 * assert BOTH halves of the finding —
 *
 *   1. `isAllowed` still returns TRUE (the prefix excuses it), so CHECK 2 stays
 *      GREEN on it. If CHECK 2 caught it, the probe would not be reproducing
 *      the shape that made this class survive.
 *   2. `falsifiedPrefixPremise` FIRES on the mutating verb.
 *
 * An anchor that no longer matches is a FAILURE, never a skip. If
 * `quota-preflight` is ever graduated to a real guard, or the `app/api/setup/`
 * reason stops claiming a scan/discovery posture, this probe must be re-pointed
 * at another prefix/route pair that still reproduces the shape — not deleted.
 */
const PREFIX_PREMISE_PROBE = {
  route: 'apps/fiab-console/app/api/setup/quota-preflight/route.ts',
  prefix: 'apps/fiab-console/app/api/setup/',
  handler: 'POST',
};

function assertPrefixPremiseTestIsSensitive() {
  const bad = [];
  const p = PREFIX_PREMISE_PROBE;
  const full = path.join(REPO_ROOT, p.route);
  const entry = ALLOWLIST_PREFIXES.find((e) => e[0] === p.prefix);
  if (!fs.existsSync(full)) {
    bad.push(`prefix-premise probe: target ${p.route} no longer exists. Re-point it; do NOT delete it.`);
  } else if (!entry) {
    bad.push(
      `prefix-premise probe: the class prefix ${p.prefix} is gone from ALLOWLIST_PREFIXES, so the probe `
      + 'can no longer reproduce an inherited class reason. Re-point it at another prefix.',
    );
  } else if (!READ_ONLY_CLAIM_RE.test(reasonClaim(entry[1]))) {
    bad.push(
      `prefix-premise probe: ${p.prefix}'s reason no longer claims a read-only/scan/discovery posture, `
      + 'so CHECK 3B cannot be exercised through it. Re-point the probe at a prefix that does.',
    );
  } else {
    const src = stripImportStatements(stripCommentsAndStrings(fs.readFileSync(full, 'utf8')));
    const gaps = unguardedHandlers(src, NOW_GUARDED.has(p.route), STRONG_SIGNAL_EXEMPT.get(p.route));
    if (!gaps.includes(p.handler)) {
      bad.push(
        `prefix-premise probe: ${p.handler} in ${p.route} is no longer an unguarded handler `
        + `(flagged: ${gaps.length ? gaps.join(', ') : 'nothing'}), so CHECK 3B has nothing to fire on here. `
        + 'If the route grew a real guard that is good news — re-point the probe at another mutating '
        + 'route under a read-only-claiming prefix.',
      );
    } else {
      // Remove the per-route reason written for it in #3607, putting it back
      // under the bare class prefix — the state every one of these routes was in.
      const priorEntry = ALLOWLIST.get(p.route);
      ALLOWLIST.delete(p.route);
      const allowed = isAllowed(p.route, gaps);
      const falsified = falsifiedPrefixPremise(p.route, gaps);
      if (priorEntry === undefined) ALLOWLIST.delete(p.route);
      else ALLOWLIST.set(p.route, priorEntry);

      if (!allowed) {
        bad.push(
          'prefix-premise probe: with its per-route reason removed the route was NOT excused by the '
          + 'class prefix, so this probe no longer reproduces the shape CHECK 3B exists for '
          + '(CHECK 2 would have caught it anyway).',
        );
      } else if (!falsified || !falsified.verbs.includes(p.handler)) {
        bad.push(
          `prefix-premise probe: ${p.route} inherited a class reason claiming a scan/discovery posture, `
          + `exposes an unguarded ${p.handler}, the prefix excused it, and CHECK 3B STILL PASSED it. `
          + 'That is the exact state every class prefix was in before #3607 — including the one the '
          + 'GHSA-fj7j-qq8g-hqj8 route sat under while this file reported violations: 0.',
        );
      }
    }
  }
  if (bad.length) {
    console.error('\n[route-guards] FAIL — CHECK 3B cannot demonstrate that it fires:');
    for (const b of bad) console.error(`  - ${b}`);
    process.exit(1);
  }
  console.log('[route-guards] prefix-premise probe passed: a mutating route under a read-only class prefix is caught by CHECK 3B (CHECK 2 stays green on it)');
}

function assertPremiseTestIsSensitive(scopedTypes) {
  const bad = [];
  const full = path.join(REPO_ROOT, PREMISE_PROBE.route);
  if (!fs.existsSync(full)) {
    bad.push(`premise probe: target ${PREMISE_PROBE.route} no longer exists`);
  } else if (!SHARED_BACKEND_ITEM_ROUTES.includes(PREMISE_PROBE.route)) {
    bad.push(
      `premise probe: ${PREMISE_PROBE.route} is no longer listed in SHARED_BACKEND_ITEM_ROUTES, `
      + 'so the probe can no longer simulate an un-graduated entry. Re-point it at another '
      + 'graduated route; do NOT delete it.',
    );
  } else {
    let src = fs.readFileSync(full, 'utf8');
    const at = src.indexOf(PREMISE_PROBE.from);
    const stop = at < 0 ? -1 : src.indexOf(PREMISE_PROBE.to, at);
    if (at < 0 || stop < 0) {
      bad.push(
        'premise probe: the guard this probe strips has changed — anchor not found: '
        + `\`${(at < 0 ? PREMISE_PROBE.from : PREMISE_PROBE.to).trim()}\`. `
        + 'Re-point the probe; without it CHECK 3 has no evidence its verdict still changes.',
      );
    } else {
      src = src.slice(0, at) + src.slice(stop + PREMISE_PROBE.to.length);
      const stripped = stripImportStatements(stripCommentsAndStrings(src));
      const gaps = unguardedHandlers(stripped);
      if (!gaps.includes(PREMISE_PROBE.handler)) {
        bad.push(
          `premise probe: ${PREMISE_PROBE.handler} was stripped of its guard and CHECK 2 did not `
          + 'even see the gap, so CHECK 3 cannot be exercised. The probe is not measuring anything.',
        );
      } else {
        // The un-graduated state: the route is back on the class allowlist only,
        // exactly as if the NOW_GUARDED entry had never been added. Stamping the
        // CLASS reason is what puts it in the class — `hasSharedBackendClassReason`
        // reads the reason in effect, so there is no separate set to maintain.
        const wasGraduated = NOW_GUARDED.delete(PREMISE_PROBE.route);
        const priorEntry = ALLOWLIST.get(PREMISE_PROBE.route);
        ALLOWLIST.set(PREMISE_PROBE.route, SHARED_BACKEND_CLASS_REASON);
        const allowed = isAllowed(PREMISE_PROBE.route, gaps);
        const falsified = falsifiedSharedBackendPremise(PREMISE_PROBE.route, stripped, gaps, scopedTypes);
        if (wasGraduated) NOW_GUARDED.add(PREMISE_PROBE.route);
        if (priorEntry === undefined) ALLOWLIST.delete(PREMISE_PROBE.route);
        else ALLOWLIST.set(PREMISE_PROBE.route, priorEntry);
        if (!allowed) {
          bad.push(
            'premise probe: the un-graduated route was NOT excused by the allowlist, so this probe '
            + 'no longer reproduces the advisory shape (CHECK 2 would have caught it anyway).',
          );
        } else if (!falsified.includes(PREMISE_PROBE.handler)) {
          bad.push(
            `premise probe: ${PREMISE_PROBE.route} was un-graduated AND stripped of its guard, the `
            + 'allowlist excused it, and CHECK 3 STILL PASSED it. That is the exact state 20 routes '
            + 'shipped in.',
          );
        }
      }
    }
  }
  if (bad.length) {
    console.error('\n[route-guards] FAIL — the allowlist PREMISE re-test cannot demonstrate it bites:');
    for (const b of bad) console.error(`  - ${b}`);
    console.error('\nAn allowlist that is never re-tested is how GHSA-hf73-rp4q-66pf survived. A');
    console.error('premise test that cannot show its own sensitivity is the same thing again.');
    process.exit(1);
  }
  console.log('[route-guards] allowlist-premise probe passed: an un-graduated, unguarded route is caught by CHECK 3 (CHECK 2 stays green on it)');
}

function main() {
  assertGuardWrappersAreReal();
  assertCheckerIsSensitive();
  // Widened (rel-T17): scan EVERY route under app/api, not just items/admin/adx.
  // The class-based ALLOWLIST_PREFIXES keep the legit session-only groups green.
  const files = walk(API_ROOT);
  const seen = new Set();
  const uniqueFiles = files.filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
  const violations = [];
  // CHECK 1 — a gate whose answer is discarded. Collected over EVERY route,
  // including allowlisted ones: "no per-resource authorization is needed here"
  // never licenses "call a gate and ignore what it said".
  const discarded = [];
  // CHECK 3 — an allowlist entry whose PREMISE is false (GHSA-hf73-rp4q-66pf).
  const falsePremises = [];
  const falsePrefixPremises = [];
  // Item types whose `[id]` is PROVABLY an ownable Loom item, because some route
  // under that type already resolves it as one. Derived from the tree so the
  // premise test re-keys itself the moment a sibling adopts an owner check.
  const scopedTypes = itemTypesWithOwnedIdSiblings(uniqueFiles);
  assertPremiseTestIsSensitive(scopedTypes);
  assertPrefixPremiseTestIsSensitive();
  let scanned = 0;
  let allowlistedHits = 0;
  let gateCalls = 0;

  for (const f of uniqueFiles) {
    const raw = fs.readFileSync(f, 'utf8');
    const r = rel(f);

    const dropped = findDiscardedGateResults(raw);
    if (dropped.length) discarded.push({ route: r, hits: dropped });
    gateCalls += countGateCalls(raw);

    // CHECK 2 — presence. Matching runs on comment/string-STRIPPED source so a
    // guard name surviving in prose (the #2977 mechanism) satisfies nothing, and
    // on IMPORT-stripped source so a merely-imported name satisfies nothing
    // either (the same lie one syntax node over — measured, see
    // stripImportStatements).
    const src = stripImportStatements(stripCommentsAndStrings(raw));
    const hasMutating = MUTATING_EXPORT_RE.test(src);
    const hasGet = GET_EXPORT_RE.test(src);
    if (!hasMutating && !hasGet) continue; // no data surface to guard
    // REMIT. A route with no session-shaped token is normally skipped (see the
    // header: 119 such files, 80 of them untriaged). That skip has a hole this
    // checker's own NOW_GUARDED set depends on NOT having: a route whose session
    // lives entirely inside a HELPER matches the remit only through the helper's
    // NAME, so deleting the helper call removes the route from the remit as well
    // as from the guard — and the checker stays green on a route it was
    // explicitly told had been fixed.
    //
    // MEASURED on 2026-08-14 while graduating the GHSA-v2g8-gp3r-rg4r routes:
    // replacing `guardAdxItemRequest(` with a non-guard call in
    // `items/graph-model/[id]/materialize/route.ts` — the route with NO literal
    // `getSession` — left `violations: 0`. NOW_GUARDED was inert for it.
    //
    // So NOW_GUARDED is now FAIL-CLOSED: a route this checker has recorded as
    // fixed is in remit unconditionally. That is deliberately scoped to the
    // graduated set rather than to all 119 — the broader remit change still
    // needs those 80 triaged first — but it makes the promise NOW_GUARDED
    // already claims ("if a future edit drops the guard, the checker re-flags
    // them") actually true.
    if (!GETSESSION_RE.test(src) && !NOW_GUARDED.has(r)) continue; // out of this check's remit
    scanned++;
    // Per HANDLER, not per file: a guard in a sibling handler does not authorize
    // this one (measured on app/api/workspaces/route.ts — see unguardedHandlers).
    //
    // A GRADUATED route is judged on STRONG signals only. GHSA-v2g8-gp3r-rg4r
    // measured that `[id]/query`'s FinOps receipt (`tenantScopeId(session)`,
    // `session.claims.oid`) satisfied the weak half of GUARD_SIGNAL_RE, so
    // deleting its entire Layer 1 left this checker green — a billing record
    // standing in for an ownership check. See OWNERSHIP_SIGNAL_RE.
    //
    // STRONG_SIGNAL_EXEMPT downgrades a named handler to the WEAK test, never
    // to no test — see that map for the review finding that forced the
    // distinction.
    const gaps = unguardedHandlers(src, NOW_GUARDED.has(r), STRONG_SIGNAL_EXEMPT.get(r));
    if (gaps.length === 0) continue; // every handler carries its own authorization
    if (isAllowed(r, gaps)) {
      allowlistedHits++;
      // CHECK 3 — the entry is load-bearing HERE (nothing else makes this
      // handler pass), so its premise is re-tested rather than trusted.
      const falsified = falsifiedSharedBackendPremise(r, src, gaps, scopedTypes);
      if (falsified.length) falsePremises.push(`${r}  [${falsified.join(', ')}]`);
      // CHECK 3B (#3607) — the same treatment for a CLASS PREFIX, which until
      // now was the one kind of allowlist entry never premise-tested at all.
      const pf = falsifiedPrefixPremise(r, gaps);
      if (pf) falsePrefixPremises.push({ route: r, ...pf });
      continue; // intentional shared/session/self route
    }
    violations.push(`${r}  [${gaps.join(', ')}]`);
  }

  console.log(`[route-guards] scanned ${scanned} session-based routes across app/api`);
  console.log(`[route-guards] allowlisted intentional routes hit: ${allowlistedHits} (${ALLOWLIST.size} per-route + ${ALLOWLIST_PREFIXES.length} class prefixes)`);
  console.log(`[route-guards] returned-value gate calls checked for consumption: ${gateCalls} (${RETURNED_VALUE_GATES.join(', ')})`);
  console.log(`[route-guards] gates whose answer is DISCARDED: ${discarded.length}`);
  console.log(`[route-guards] shared-backend allowlist entries whose OWNERSHIP premise is CONTRADICTED by a sibling: ${falsePremises.length}`);
  console.log(`[route-guards] CLASS-PREFIX entries whose read-only/discovery premise is CONTRADICTED by a mutating handler: ${falsePrefixPremises.length}`);
  console.log(`[route-guards] violations: ${violations.length}`);

  let failed = false;

  if (falsePrefixPremises.length) {
    failed = true;
    console.error('\n[route-guards] FAIL — these routes are excused ONLY by a CLASS PREFIX whose recorded');
    console.error('reason claims a read-only / scan / discovery posture, and they expose an UNGUARDED');
    console.error('MUTATING handler. A class prefix asserts something about every route beneath it,');
    console.error('including routes written long after the reason was — so it is a BROADER claim than a');
    console.error('per-route reason and needs more re-testing, not less. Until #3607 it got none:');
    console.error('CHECK 3 returned early on anything outside `items/<type>/[id]/`, which is exactly how');
    console.error('the GHSA-fj7j-qq8g-hqj8 route sat under a blanket prefix while this file reported');
    console.error('`violations: 0`.');
    for (const p of falsePrefixPremises) {
      console.error(`  - ${p.route}  [${p.verbs.join(', ')}]`);
      console.error(`      prefix: ${p.prefix}`);
      console.error(`      reason: ${p.reason.slice(0, 150)}`);
    }
    console.error('\nThis does NOT claim the route is exploitable. It claims the RECORDED REASON does not');
    console.error('describe it, which is the one job an allowlist entry has.');
    console.error('\nFix, in order of preference:');
    console.error('  1. NARROW the prefix so the mutating route is no longer covered by it, and let the');
    console.error('     route pass on its own guard (what #3572 did to `app/api/storage/`); or');
    console.error('  2. give the route its OWN per-route reason in the ALLOWLIST map that is TRUE of a');
    console.error('     mutating handler — then it is individually justified and individually re-testable; or');
    console.error('  3. thread a real authorization check and move it to NOW_GUARDED.');
    console.error('  Do NOT widen the class reason to cover the mutation. A reason that has been stretched');
    console.error('  to fit its members has stopped being a claim about the code.');
  }

  if (falsePremises.length) {
    failed = true;
    console.error('\n[route-guards] FAIL — these routes are excused by SHARED_BACKEND_ITEM_ROUTES,');
    console.error('whose recorded reason ends "…no per-tenant Cosmos ownership to scope". A SIBLING');
    console.error('route under the SAME item type resolves the SAME [id] through an item-ownership');
    console.error('resolver, so that premise is false: ownership IS scopeable here, and these');
    console.error('handlers consume the id without scoping it.');
    for (const p of falsePremises) console.error(`  - ${p}`);
    console.error('\nAn allowlist entry is a claim about the code. This one is tested rather than');
    console.error('trusted (GHSA-hf73-rp4q-66pf), and the test re-keys itself: the moment any route');
    console.error('under an item type scopes [id] by item, every allowlisted sibling of that type is');
    console.error('re-judged against it.');
    console.error('\nFix: thread the owner check and GRADUATE the path —');
    console.error("  export const GET = withWorkspaceOwner('<itemType>', { allowReadRoles: true }, …)");
    console.error("  export const POST = withWorkspaceOwner('<itemType>', …)   // mutations: no read roles");
    console.error('then MOVE the path out of SHARED_BACKEND_ITEM_ROUTES into NOW_GUARDED, so a');
    console.error('future edit that drops the wrapper is re-flagged instead of silently masked.');
    console.error('If the [id] here genuinely names an Azure object rather than the Loom item,');
    console.error('give the route its OWN per-route reason saying so — the class reason does not');
    console.error('cover it once a sibling has proved the type ownable. A hand-written reason in');
    console.error('EITHER allowlist block works: the per-route `new Map([…])` literal near the top,');
    console.error('or the `for (const [p, reason] of [ … ])` block lower down. (Only the first used');
    console.error('to work — the second runs AFTER the class loop and was skipped by an');
    console.error('`if (!ALLOWLIST.has(p))`. A hand-written reason now overrides the class default.)');
  }

  if (discarded.length) {
    failed = true;
    console.error('\n[route-guards] FAIL — these routes CALL an authorization gate and then');
    console.error('THROW ITS ANSWER AWAY. The call runs, the name is present, and the caller');
    console.error('is never rejected — the exact shape that left /api/setup/deploy (subscription-');
    console.error('scoped ARM deployments) open with every CI guard green on 2026-08-07.');
    for (const d of discarded) {
      console.error(`  - ${d.route}`);
      for (const h of d.hits) console.error(`      :${h.line} ${h.gate} — ${h.reason}`);
    }
    console.error('\nFix: short-circuit on the result —');
    console.error('  const gate = await enforceCapability(session, cap, role);');
    console.error('  if (gate) return gate;');
    console.error('or adopt the NON-DISCARDABLE wrapper, which removes the returned value');
    console.error('a caller can drop:');
    console.error("  export const POST = withCapability(cap, 'Admin', async (req, { session }) => { … });");
    console.error('(withCapability / withTenantAdmin / withDlzAccess — lib/api/route-toolkit.ts)');
  }

  if (violations.length) {
    failed = true;
    console.error('\n[route-guards] FAIL — these routes are gated only by getSession() with no');
    console.error('owner/tenant/admin authorization (potential cross-tenant access):');
    for (const v of violations) console.error(`  - ${v}`);
    console.error('\nFix: thread `loadOwnedItem(id, type, session.claims.oid)` (item routes) or an');
    console.error('admin gate (`requireTenantAdmin` / `isTenantAdmin` / `enforceCapability`) so the');
    console.error('caller is authorized against the specific resource. If the route legitimately');
    console.error('needs no per-resource check (shared Azure backend resolved by type, or a self/');
    console.error('public endpoint), add it to ALLOWLIST in scripts/ci/check-route-guards.mjs with a reason.');
  }

  if (failed) process.exit(1);
  console.log('[route-guards] OK — every session-based item/admin route is authorized or allowlisted,');
  console.log('[route-guards] and every authorization gate that is called has its answer acted on.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
