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
 * TWO INDEPENDENT CHECKS RUN HERE:
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
 *   NOTE an allowlist entry does NOT exempt a route from CHECK 1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findDiscardedGateResults, stripCommentsAndStrings, RETURNED_VALUE_GATES } from './_gate-consumption.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

const API_ROOT = path.join(CONSOLE_ROOT, 'app', 'api');

const GUARD_SIGNAL_RE = new RegExp(
  [
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
    // #3572 — `authorizeStorageAccount(` bounds which storage account a caller
    // may drive the Console UAMI at: the deployment's own lake (any session),
    // DLZ authority (tenant/domain admin), or an account a lakehouse in the
    // caller's OWN tenant is bound to. Matched AS A CALL, so a `{@link ...}` in
    // a comment cannot satisfy it — the way `assertOwner` lied. Kept in lockstep
    // with OWNER_RE in generate-route-inventory.mjs.
    'authorizeStorageAccount(?:<[^()]*>)?\\s*\\(',
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
    'tenantScopeId\\s*\\(',
    // C22 round 2 (#3122): OPTIONAL CHAINING must match. `s?.claims?.oid` is the
    // idiom when the session may be null (api/iq/mcp resolveTenant), and the
    // literal-dot form `claims\.oid` silently missed it — a route could hold a
    // real, session-derived tenant boundary and still read as unguarded. That is
    // a false NEGATIVE for the checker's remit test and a false POSITIVE for its
    // violation list, depending on where the token sits; both are wrong.
    'claims\\??\\.\\s*oid', 'claims\\??\\.\\s*tid', 'claims\\??\\.\\s*tenantId',
  ].join('|'),
);


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
const GETSESSION_RE = /getSession\s*\(|with(?:Session|WorkspaceOwner|BackendGate|TenantAdmin|DlzAccess|Capability)(?:<[^()]*>)?\s*\(|authorize(?:NotebookItem|DatabricksJobItem|DatabricksPipelineItem)(?:<[^()]*>)?\s*\(/;

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
  ['apps/fiab-console/app/api/items/[type]/[id]/alerts/route.ts', 'analytics alerts over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/assist/route.ts', 'AOAI assist resolved by item type; no per-tenant Cosmos read'],
  ['apps/fiab-console/app/api/items/[type]/[id]/explain/route.ts', 'AOAI explain grounded on the caller-supplied live definition; no per-tenant Cosmos read'],
  // WS-2.3 AI/BI "Explain this metric" AI-authored viz: a stateless AOAI transform
  // that picks a chart encoding from the caller-supplied columns + sample rows; no
  // per-tenant Cosmos item read by id (same class as [type]/[id]/explain + the
  // ai-enrich sample probe). Session-gated; the chart is validated against the real
  // column list before it is returned.
  ['apps/fiab-console/app/api/analytics/visualize/route.ts', 'stateless AOAI chart-recommendation grounded purely on caller-supplied columns/sample rows; no per-tenant Cosmos read'],
  ['apps/fiab-console/app/api/items/[type]/[id]/monitoring/route.ts', 'read-only monitoring over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/optimize/route.ts', 'optimize action over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/security/route.ts', 'security-scan over a shared Azure backend resolved by item-type gate'],
  ['apps/fiab-console/app/api/items/[type]/[id]/sql-security/route.ts', 'SQL security over a shared Azure backend resolved by item-type gate'],
  ['apps/fiab-console/app/api/items/[type]/[id]/statistics/route.ts', 'read-only statistics over a shared Azure backend resolved by item type'],

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
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/aad-admin/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/create-db/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/firewall/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/get-data/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/maintenance-configs/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/performance/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/principal-search/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/query/cancel/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/replication/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/restore/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/scale/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/search-management/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/share/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-database/[id]/sql2025-features/route.ts',
  'apps/fiab-console/app/api/items/azure-sql-server/[id]/databases/route.ts',
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
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/cancel/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/clone/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/connection/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/create/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/ctas/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/delete/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/edit/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/iqy/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query-history/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/query-profile/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/schema/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/script-out/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/start/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/state/route.ts',
  'apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/warehouses/route.ts',
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
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/databases/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/firewall/route.ts',
  'apps/fiab-console/app/api/items/postgres-flexible-server/[id]/query/route.ts',
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
  // non-items routes fixed in the same sweep
  'apps/fiab-console/app/api/aml/environments/route.ts',
  'apps/fiab-console/app/api/notebook/[id]/assist/route.ts',
  'apps/fiab-console/app/api/experience/warp/transforms/route.ts',
  'apps/fiab-console/app/api/governance/scans/route.ts',
  'apps/fiab-console/app/api/governance/scans/register-existing/route.ts',
]);

for (const p of SHARED_BACKEND_ITEM_ROUTES) {
  if (NOW_GUARDED.has(p)) continue; // now carries a real owner-check — not allowlisted
  if (!ALLOWLIST.has(p)) {
    ALLOWLIST.set(
      p,
      'specific-per-item-TYPE route over a SHARED Azure backend resolved by item type (auth = signed-in + deployment RBAC); no per-tenant Cosmos ownership to scope',
    );
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
  ['apps/fiab-console/app/api/data-products/[id]/ports/route.ts', 'consumer-discovery: read-only input/output/management ports of a discoverable data product (DP-8; mirrors GET /api/data-products/[id], resolves only upstream contract summaries)'],
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
]) {
  if (!ALLOWLIST.has(p)) ALLOWLIST.set(p, reason);
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
  ['apps/fiab-console/app/api/loom/', 'A: Loom compute-target/capacity/SHIR navigators resolve a shared Azure resource by ARM name via Console UAMI'],
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
 * Which exported handlers in this file carry NO authorization signal of their
 * own? Returns [] when the file is authorized handler-by-handler.
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
function unguardedHandlers(code) {
  const localBodies = localFunctionBodies(code);
  const gaps = [];
  for (const h of HANDLER_NAMES) {
    const wrapped = new RegExp(`export\\s+const\\s+${h}\\s*(?::[^=\\n]*)?=`).exec(code);
    if (wrapped) {
      const expr = initializerExpression(code, wrapped.index + wrapped[0].length);
      if (!GUARD_SIGNAL_RE.test(effectiveHandlerText(expr, localBodies))) gaps.push(h);
      continue;
    }
    const classic = new RegExp(`export\\s+async\\s+function\\s+${h}\\s*(?:<[^>]*>)?\\s*\\(`).exec(code);
    if (!classic) continue;
    const body = functionBody(code, classic.index + classic[0].length - 1);
    if (!GUARD_SIGNAL_RE.test(effectiveHandlerText(body, localBodies))) gaps.push(h);
  }
  return gaps;
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
    for (const must of w.mustCall) {
      if (!new RegExp(must).test(src)) {
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
    if (!GETSESSION_RE.test(src)) continue; // not session-based; out of this check's remit
    scanned++;
    // Per HANDLER, not per file: a guard in a sibling handler does not authorize
    // this one (measured on app/api/workspaces/route.ts — see unguardedHandlers).
    const gaps = unguardedHandlers(src);
    if (gaps.length === 0) continue; // every handler carries its own authorization
    if (isAllowed(r, gaps)) { allowlistedHits++; continue; } // intentional shared/session/self route
    violations.push(`${r}  [${gaps.join(', ')}]`);
  }

  console.log(`[route-guards] scanned ${scanned} session-based routes across app/api`);
  console.log(`[route-guards] allowlisted intentional routes hit: ${allowlistedHits} (${ALLOWLIST.size} per-route + ${ALLOWLIST_PREFIXES.length} class prefixes)`);
  console.log(`[route-guards] returned-value gate calls checked for consumption: ${gateCalls} (${RETURNED_VALUE_GATES.join(', ')})`);
  console.log(`[route-guards] gates whose answer is DISCARDED: ${discarded.length}`);
  console.log(`[route-guards] violations: ${violations.length}`);

  let failed = false;

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
