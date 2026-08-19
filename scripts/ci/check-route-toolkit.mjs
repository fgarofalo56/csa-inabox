#!/usr/bin/env node
/**
 * GUARDRAIL: route-toolkit  (merge-blocker, RATCHETING — loom-next-level R3)
 * ---------------------------------------------------------------------------
 * RULE: BFF routes use the route toolkit (`lib/api/route-toolkit.ts` —
 *   withSession / withWorkspaceOwner / withTenantAdmin / withDlzAccess /
 *   withBackendGate) instead of hand-rolling the getSession() prologue. The
 *   toolkit runs the EXACT same checks with byte-compatible envelopes while
 *   killing the copy-paste drift that produced the cross-tenant holes
 *   check-route-guards.mjs exists for.
 *
 * DETECTION — a route.ts is "hand-rolled session" when it:
 *   1. exports a data surface (GET or a mutating verb — same regexes as
 *      check-route-guards.mjs), AND
 *   2. imports `getSession` from '@/lib/auth/session' (alias-aware — the
 *      hand-rolled marker; a `getSession` from another module, e.g. the
 *      copilot-orchestrator's, does NOT count), AND
 *   3. references NO toolkit wrapper (not migrated).
 *
 * RATCHET SEMANTICS (two-mode, stricter than a pure count):
 *   1. Global/per-key count — a NEW hand-rolled route (net-new file, or a
 *      de-migration of a toolkit route back to getSession) FAILS.
 *   2. Touched-file rule (the forbidding part) — a route in the baseline that
 *      this PR MODIFIES must be migrated while you're here:
 *        node scripts/codemods/migrate-route-toolkit.mjs --apply --family=<area>
 *      then regen:  node scripts/ci/check-route-toolkit.mjs --update-baseline
 *      Escape hatch for a prologue the codemod legitimately can't transform:
 *      add the path to TOUCH_EXEMPT below with a one-line reason.
 *
 * The baseline lives in scripts/ci/route-toolkit-baseline.json (own file, not
 * inline — ~1,3xx entries; deviation from the inline-allowlist pattern is
 * size-justified). It only shrinks; regen via --update-baseline.
 *
 * Built on the SHARED ratchet mechanic scripts/ci/_ratchet-count.mjs (R3) —
 * X1 / I5 / R17 / R19 / U11 / LIC0 consume the same helper.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runRatchet, gitTouchedFiles } from './_ratchet-count.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const BASELINE_FILE = path.join(__dirname, 'route-toolkit-baseline.json');

// Same data-surface regexes as check-route-guards.mjs.
const MUTATING_EXPORT_RE = /export\s+(?:async\s+function\s+(?:POST|PUT|PATCH|DELETE)\b|const\s+(?:POST|PUT|PATCH|DELETE)\s*=)/;
const GET_EXPORT_RE = /export\s+(?:async\s+function\s+GET\b|const\s+GET\s*=)/;
// The hand-rolled marker: an auth-session getSession import (alias-aware).
const AUTH_SESSION_IMPORT_RE = /import\s*(?:type\s*)?\{[^}]*\bgetSession\b[^}]*\}\s*from\s*['"]@\/lib\/auth\/session['"]/;
// Any toolkit wrapper reference = migrated (or composing) — out of the ratchet.
// C22 (#3088) adds `withCapability` (the non-discardable enforceCapability
// form) and `(?:<[^()]*>)?` so an explicit type argument — `withSession<{ id:
// string }>(…)`, which 104 routes use — is recognized as the CALL it is.
// Without the type-arg branch those routes matched only via their header
// COMMENTS ("Route-toolkit: withSession (R1/R3)"), which is #2977's mechanism
// exactly: a control passing on prose rather than code.
const TOOLKIT_RE = /\bwith(?:Session|WorkspaceOwner|BackendGate|TenantAdmin|DlzAccess|Capability)(?:<[^()]*>)?\s*\(/;

// ── Touched-file escape hatch ───────────────────────────────────────────────
// Paths (repo-relative) a PR may modify WITHOUT migrating, each with a one-line
// reason (e.g. a prologue the codemod legitimately can't transform yet). Keep
// this SHORT — prefer running the codemod.
const TOUCH_EXEMPT = new Map([
  // #3549/#3551 touched this route ONLY inside Phase-1 item creation, to backfill
  // the bundle definition onto a name-matched EXISTING item that has none. The
  // dedup path pushed `status:'existed'` and wrote nothing while still handing
  // `bundle.content` to the provisioner, so an item that pre-dated the bundle was
  // provisioned from content that never reached it — and, once provisioners began
  // verifying their own content, re-running the install was the one thing that
  // could not fix it. The auth prologue is UNTOUCHED.
  //
  // THE CODEMOD ITSELF REFUSES THIS FILE, which is what this escape hatch is for.
  // Re-run it and it says so verbatim — this reason is falsifiable in one command:
  //   node scripts/codemods/migrate-route-toolkit.mjs --file=app/api/apps/[id]/install/route.ts
  //   → app/api/apps/[id]/install/route.ts: SKIPPED (POST: body declares its own `params` (collision))
  ['apps/fiab-console/app/api/apps/[id]/install/route.ts',
   '#3549/#3551: Phase-1 content backfill only, auth prologue untouched; the codemod SKIPS this file (`params` collision)'],
  // FINISHLINE C7 (#3064) touched this route ONLY to stop the BFF silently
  // DROPPING four of the create-wizard's five fields — the old handler
  // destructured `{ name, description, capacity, domain }` and discarded
  // `contacts`, `licenseMode`, `storageAccountId` and `provisionBackingRg`,
  // which made the `provisionBackingRg` opt-in a dead no-op (the backing RG was
  // never provisioned on this path even though applyWorkspaceBindings already
  // accepted and implemented it). The auth prologue is UNTOUCHED: both handlers
  // keep getSession() → 401.
  //
  // THE CODEMOD DECLINES BOTH HANDLERS — `--family=workspaces` reports
  // "app/api/workspaces/route.ts: SKIPPED (GET: getSession() without the exact
  // 401 guard)" and the same for POST, because the 401 is returned through this
  // file's local `err()` helper (a thin apiError wrapper) rather than the
  // literal shape withSession replaces. Hand-migrating the prologue inside a
  // data-integrity fix would put real 401-regression risk on the workspace
  // create path for no security gain.
  //
  // COMPENSATING CONTROL (verified, not assumed): the 401 is pinned by
  // create-wizard-contract.test.ts:129 — `expect((await POST(req({name:'X'})))
  // .status).toBe(401)` — so a dropped auth prologue fails a merge-blocking
  // test. NOTE check-route-guards does NOT cover this: its remit is
  // AUTHORIZATION on routes that point-read/write by an id from the URL, and
  // this is a collection route (GET list / POST create) with no [id] segment.
  // Deleting the 401 line leaves route-guards green — measured — so the
  // contract test, not route-guards, is what watches this file.
  //
  // STILL TRUE after C22 (#3088), RE-MEASURED 2026-08-07 rather than assumed:
  // C22 made check-route-guards fail any route that calls a returned-value gate
  // and discards the answer, which DID newly pin the sibling env-config entry
  // below. It does not pin this one, because this route calls no such gate — it
  // authorizes by threading `session.claims.oid` as the Cosmos partition. Same
  // deletion, re-run: `[route-guards] gates whose answer is DISCARDED: 0 /
  // violations: 0`, exit 0. The contract test remains the only thing watching
  // this 401.
  ['apps/fiab-console/app/api/workspaces/route.ts', '#3064: BFF field-drop fix (provisionBackingRg was inert); codemod skips both handlers — 401 returned via local err() helper, not the literal guard shape; 401 pinned by create-wizard-contract.test.ts:129 (route-guards still does not cover it — re-measured under #3088)'],
  // #3753 touched this route for ONE line — `resolveWorkspaceRole(item.workspaceId,
  // session.claims.oid, session.claims.upn)` became `resolveWorkspaceRole(
  // item.workspaceId, session)`, because that helper's second parameter (named
  // `tenantId`, always filled with the caller's oid) WAS the defect and was
  // removed. The auth prologue is UNTOUCHED.
  //
  // THE CODEMOD DECLINES IT, measured not assumed: `--file=app/api/items/[type]/
  // [id]/access-mode/route.ts` reports "0 handlers across 0 files; 1 skipped —
  // PATCH: getSession() without the exact 401 guard". Same cause as the
  // workspaces entry above: the 401 is returned through this file's local
  // `err()` helper (a thin apiError wrapper), not the literal shape withSession
  // replaces. The other SEVEN route files #3753 touched WERE migrated by the
  // codemod in that PR (baseline 1068 -> 1061), so this is the residue of a
  // genuine codemod limitation, not an opt-out of the boy-scout rule.
  //
  // Hand-migrating the prologue would put 401-regression risk on an
  // authorization surface inside a PR whose whole subject is an authorization
  // defect — for no security gain, since the prologue is already correct.
  ['apps/fiab-console/app/api/items/[type]/[id]/access-mode/route.ts',
   "#3753: one-line change (resolveWorkspaceRole's caller-oid parameter removed — the defect itself); auth prologue untouched; codemod reports 'PATCH: getSession() without the exact 401 guard' because the 401 goes through the local err() helper. The other 7 routes this PR touched were migrated (1068 -> 1061)"],
  // FINISHLINE D15 (#3051) touched this route ONLY to carry the new first-class
  // 'opt-in' env status through the response payload (day-one scoring was
  // lying in BOTH directions: policy opt-ins scored unconfigured forever, and
  // derived-but-unset counted as configured). The auth prologue is UNTOUCHED.
  //
  // THE CODEMOD DECLINES BOTH HANDLERS — `--file=app/api/admin/env-config/
  // route.ts` reports "0 handlers across 0 files; 2 skipped", both
  // "getSession() without the exact 401 guard". That is because this route's
  // prologue is STRICTER than the one withSession replaces: it runs
  // `enforceCapability(session, CAP, 'Admin')` (lib/auth/feature-gate.ts),
  // which returns 401 when unauthenticated (:156), 403 when the caller lacks
  // the capability (:173), and FAILS CLOSED to 403 on a Cosmos error (:134) —
  // and PUT additionally runs a PDP check. Replacing a capability gate with a
  // bare signed-in check would be a security REGRESSION, not a migration.
  //
  // HONEST COVERAGE NOTE — SUPERSEDED 2026-08-07 by C22 (#3088). The note below
  // was accurate when written and is kept because the correction is the point:
  //
  //   "nothing currently pins this route's 401/403 in CI. check-route-guards
  //    does NOT cover it … deleting `if (gate) return gate;` leaves
  //    route-guards GREEN (measured)."
  //
  // That measurement was right, and it was the thread that led to C22. It is no
  // longer true: check-route-guards now fails any route that calls a
  // returned-value gate and discards the answer, and this route is one of the
  // 36 files it watches. RE-MEASURED 2026-08-07 — deleting `if (gate) return
  // gate;` from the GET handler makes check-route-guards exit 1 with
  //   apps/fiab-console/app/api/admin/env-config/route.ts
  //       :52 enforceCapability — result bound to `gate` but never returned/thrown
  // so the 403 IS pinned in CI now. What is still NOT pinned is the 401 shape
  // and the choice of capability id / required role — `lib/admin/__tests__/
  // env-config.test.ts` exercises the LIB, not the handler. A route-level
  // 401/403 contract test remains a worthwhile follow-up; it is no longer the
  // only thing standing between this route and a silent authorization loss.
  //
  // THE CODEMOD STILL DECLINES BOTH HANDLERS — `--file=app/api/admin/env-config/
  // route.ts` reports "0 handlers across 0 files; 2 skipped", both
  // "getSession() without the exact 401 guard", because this prologue is
  // STRICTER than the one withSession replaces: `enforceCapability(session, CAP,
  // 'Admin')` returns 401 unauthenticated, 403 without the capability, and
  // fails closed to 403 on a Cosmos error; PUT additionally runs a PDP check.
  // Replacing a capability gate with a bare signed-in check would be a security
  // REGRESSION. The clean migration target is now `withCapability(CAP, 'Admin',
  // …)` (lib/api/route-toolkit.ts), which composes withSession + the same
  // enforceCapability call into a form with no returned value to drop.
  ['apps/fiab-console/app/api/admin/env-config/route.ts', "#3051: opt-in status payload; codemod skips both handlers — prologue is enforceCapability(Admin) (401/403, fails closed), STRICTER than the withSession shape; 403 now PINNED by check-route-guards' gate-consumption check (#3088, re-measured) — route-level 401 contract test still a follow-up"],
  // GHSA-hf73-rp4q-66pf touched this route ONLY to make its stated posture true.
  // It claimed to return "the ports of A DISCOVERABLE data product" and resolved
  // "only upstream contract summaries", while running two unscoped
  // cross-partition lookups: it established no discoverability, no tenant, and no
  // workspace, and a port `ref` is an infrastructure ADDRESS (abfss:// path /
  // Synapse schema.table / ADX database). It now enforces the sentence it was
  // excused on. The auth prologue is UNTOUCHED — getSession() → 401, unchanged.
  //
  // THE CODEMOD DECLINES IT — `--file=app/api/data-products/[id]/ports/route.ts`
  // reports "SKIPPED (GET: getSession() without the exact 401 guard)", because the
  // 401 goes through `apiError('Unauthorized', 401, { code: 'unauthorized' })`
  // rather than the literal shape withSession replaces. Hand-migrating would
  // REWRITE that envelope to withSession's `apiUnauthorized()`
  // ({ok:false,error:'unauthenticated'}, no `code`) — a behaviour change to an
  // error contract, inside a security fix, for no security gain. The 15 sibling
  // routes in this same change that the codemod DID accept were all migrated.
  //
  // COMPENSATING CONTROL (verified, not assumed): the 401 is pinned by
  // `app/api/data-products/[id]/ports/__tests__/route.test.ts` — "401s with no
  // session, before any Cosmos read" — which also asserts the ACL resolver is
  // never reached, so a dropped prologue fails a merge-blocking test. The
  // AUTHORIZATION half is pinned separately in that file (draft/foreign-tenant
  // 404s, the non-distinguishing upstream echo). NOTE check-route-guards does not
  // pin the 401 here: its remit is authorization, and this route passes it on the
  // `authorizeWorkspace` call the fix added, not on the session check.
  ['apps/fiab-console/app/api/data-products/[id]/ports/route.ts', 'GHSA-hf73-rp4q-66pf: enforce the discoverability the route already claimed; auth prologue untouched; codemod skips it — 401 goes through apiError(...,{code}), not the literal guard shape, and migrating would rewrite that envelope for no security gain; 401 + authorization pinned by ports/__tests__/route.test.ts'],
  // #2622 touched this route ONLY to swap ten raw `executeStatement(...)` calls
  // for the AUDITED `ucSql(...)` wrapper, so the UC ABAC column-mask + row-filter
  // DDL it issues finally produces a Loom Unity audit row. Same arguments, same
  // returns, same error mapping; the auth prologue is untouched (getSession() →
  // 401, then a cloud-boundary gate).
  //
  // THE CODEMOD DECLINES BOTH HANDLERS —
  // `--file=app/api/items/[type]/[id]/security/route.ts` reports
  // "DRY-RUN: 0 handlers across 0 files; 2 skipped", both with
  // "route-ctx used beyond `await ctx.params` (unprovable)". Hand-migrating an
  // auth prologue the codemod cannot prove safe, inside an audit-coverage fix,
  // is unrelated churn with real 401 regression risk on a governance surface.
  ['apps/fiab-console/app/api/items/[type]/[id]/security/route.ts', '#2622: executeStatement→ucSql audit fix; codemod reports 0 handlers, 2 skipped (route-ctx unprovable)'],
  // #2635 touched these two ONLY to widen ONE audit-log Cosmos predicate from
  // `c.tenantId = @t` (with @t = claims.oid) to the shared oid-OR-tid scope in
  // lib/audit/audit-scope.ts — the same scope the /admin/audit-logs reader
  // already uses (#2608). One query per file. Neither route's auth prologue
  // changes: usage keeps getSession() → 401 + requireTenantAdmin() → 403,
  // insights keeps getSession() → 401.
  //
  // THE CODEMOD DECLINES BOTH — `--file=` reports "0 handlers" for each:
  // usage's prologue is getSession() followed by requireTenantAdmin(), and
  // insights exports a zero-argument `GET()` (no NextRequest), neither of which
  // is the exact getSession()+401 shape withSession replaces. Hand-migrating an
  // auth prologue inside a counter-scope fix is unrelated churn with real
  // 401/403 regression risk on two admin-visible dashboards.
  ['apps/fiab-console/app/api/admin/usage/route.ts', '#2635: one-predicate audit-scope fix; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/governance/insights/route.ts', '#2635: one-predicate audit-scope fix; zero-arg GET(), codemod reports 0 handlers'],
  // #2793 is the tail of that same class: this route's `sharedItems30d` KPI is
  // the last audit-log reader still binding `c.tenantId = @t` with @t = oid. The
  // change threads ONE array (auditScopeIdsForViewer(s)) into computePosture.
  // The auth prologue is untouched: getSession() → 401, isTenantAdmin() → 403.
  //
  // THE CODEMOD DECLINES — `--file=apps/fiab-console/app/api/governance/govern/posture/route.ts`
  // reports "DRY-RUN: 0 handlers across 0 files": the route exports a zero-arg
  // `GET()` (no NextRequest) whose prologue is getSession()+401 followed by a
  // hand-written isTenantAdmin() 403 carrying a bespoke code/reason/remediation
  // body, which is not the shape withSession/withTenantAdmin replaces.
  ['apps/fiab-console/app/api/governance/govern/posture/route.ts', '#2793: one-predicate audit-scope fix; zero-arg GET() + bespoke 403 body, codemod reports 0 handlers'],
  // #2657 round 2 touched these four ONLY to build one map with safeRecord()
  // instead of `{}`. The ontology pair is the point of the round: their
  // /^[A-Za-z_][\w]{0,62}$/ key filter reads as a strict identifier check and
  // accepts __proto__, constructor, prototype, toString and valueOf, because
  // `_` is `\w`. One declaration per file, no auth change.
  //
  // THE CODEMOD DECLINES ALL FOUR — `--file=` reports "0 handlers" for each.
  ['apps/fiab-console/app/api/items/ontology/[id]/objects/route.ts', '#2657r2: one-line safeRecord fix; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/items/ontology/[id]/links/route.ts', '#2657r2: one-line safeRecord fix; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/admin/mcp-servers/route.ts', '#2657r2: one-line safeRecord fix; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/eventhubs/data-explorer/route.ts', '#2657r2: one-line safeRecord fix; codemod reports 0 handlers'],
  // #2657 touched these three ONLY to build one map with safeRecord()
  // (Object.create(null)) instead of `{}`, so a request-derived key like
  // `__proto__` becomes an ordinary own property. One declaration per file,
  // no auth change.
  //
  // THE CODEMOD DECLINES ALL THREE — it reports "getSession() without the
  // exact 401 guard" for every handler in them. Running it repo-wide to reach
  // these three rewrites 516 handlers across 349 files, which is not a blast
  // radius a prototype-pollution fix gets to carry.
  ['apps/fiab-console/app/api/items/aip-logic/[id]/publish/route.ts', '#2657: one-line safeRecord fix; codemod skips (no exact-401 prologue)'],
  ['apps/fiab-console/app/api/items/report/[id]/data-source/route.ts', '#2657: one-line safeRecord fix; codemod skips (no exact-401 prologue)'],
  ['apps/fiab-console/app/api/workspaces/bulk-delete/route.ts', '#2657: one-line safeRecord fix; codemod skips (no exact-401 prologue)'],
  // FINISHLINE C3 (#3068) touched this route for PROSE ONLY. B-FN C3 replaced
  // the report-subscriptions Y1 Function with the loom-report-subscriptions
  // Container App Job and DELETED report-subscriptions-function.bicep, so this
  // file's doc comment and its user-facing `deliveryGate()` remediation string
  // both named a bicep module that no longer exists. The diff is two comment
  // lines and one string literal. No identifier, no control flow, no env-var
  // name changed (LOOM_REPORT_SUBSCRIPTIONS_FUNCTION deliberately keeps its
  // historical name — the BFF, the svc-report-subscriptions env-check and
  // post-deploy bootstrap all read it as a presence flag). The auth prologue is
  // UNTOUCHED: both handlers keep `const s = getSession(); if (!s) return unauth();`.
  //
  // THE CODEMOD DECLINES BOTH HANDLERS — `--file=app/api/items/report/[id]/subscriptions/route.ts`
  // reports verbatim "SKIPPED (GET: getSession() without the exact 401 guard)"
  // and "SKIPPED (POST: getSession() without the exact 401 guard)", i.e.
  // "APPLIED: 0 handlers across 0 files; 2 skipped" — the 401 is returned
  // through this file's local `unauth()` helper rather than the literal shape
  // withSession replaces. Running --apply left the working tree byte-identical.
  //
  // WHAT PINS THE AUTH — MEASURED, AND THE ANSWER IS "NOT CI":
  // check-route-guards does NOT go red. Mutation: both `if (!s) return unauth();`
  // lines deleted; check-route-guards re-run; result IDENTICAL to baseline —
  // "scanned 1426 session-based routes, violations: 0", exit 0. Restored after.
  // This route DOES have an [id] segment and IS in route-guards' scope
  // (app/api/items/<type>/[id]/**), and it is NOT allowlisted — it is green
  // because it genuinely satisfies what that guard measures, which is
  // AUTHORIZATION and not authentication: every Cosmos access is scoped
  // `c.createdBy = @o` with `@o = s.claims.oid`. Deleting the 401 does not
  // change that posture, so the guard cannot see it. No test imports this route
  // either. So: nothing in CI would catch a dropped 401 here.
  // Not a cross-tenant hole regardless — both handlers dereference
  // `s.claims.oid` (GET in the query parameters, POST in the row it builds
  // BEFORE `items.create`), so an absent session null-derefs and fails closed
  // rather than reading or writing another user's rows. That is an accident of
  // the code shape, not a control, and it is recorded here as an observation
  // rather than offered as coverage.
  ['apps/fiab-console/app/api/items/report/[id]/subscriptions/route.ts', '#3068: prose-only fix (doc comment + deliveryGate remediation string named the deleted report-subscriptions-function.bicep); auth prologue untouched; codemod reports 0 handlers, 2 skipped (401 via local unauth() helper); check-route-guards MEASURED green on a deleted-401 mutant, so nothing in CI pins it'],
  // #2772 touched this route ONLY to swap a broken secret-name regex
  // (/password|secret|key$/i — the anchor bound to the last alternative, so
  // sslKeyPem/privateKeyPem leaked to Cosmos in plaintext) for the tested
  // isSecretPropName helper. One expression, no auth change.
  //
  // THE CODEMOD DECLINES IT — `--file=` reports "0 handlers": the prologue is
  // getSession() followed by bespoke validation, not the exact getSession()+401
  // shape withSession replaces. Migrating an auth prologue inside a secret-leak
  // fix is unrelated churn on a route that writes Key Vault secrets.
  ['apps/fiab-console/app/api/realtime-hub/connect-source/route.ts', '#2772: one-expression secret-regex fix; codemod reports 0 handlers'],
  // #2768 touched these two ONLY to wrap request-derived values in logSafe()
  // (js/log-injection: a newline in ?model= / body.title forged a second log
  // record). One expression per file, no auth change.
  //
  // THE CODEMOD DECLINES BOTH — `--file=` reports "0 handlers": feedback calls
  // getSession() mid-handler for an OPTIONAL session (anonymous feedback is
  // allowed), and rayfin's guard is not the exact getSession()+401 shape
  // withSession replaces. Hand-migrating an auth prologue inside a logging-
  // sanitization PR is unrelated churn with real 401/403 regression risk.
  ['apps/fiab-console/app/api/feedback/route.ts', '#2768: logSafe() one-liner; optional-session prologue, codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/items/rayfin-app/model-objects/route.ts', '#2768: logSafe() one-liner; codemod reports 0 handlers'],
  // #2759 touched this route only to split the gate summary counts (opt-in and
  // cloud-unavailable are no longer counted as 'blocked'). It gates on
  // enforceCapability(session,'admin.env-config','Admin') — a capability check,
  // NOT the getSession()+401 shape withSession replaces — so the codemod reports
  // SKIPPED ("getSession() without the exact 401 guard") and there is nothing to
  // rewrite. Hand-migrating a capability-gated admin route inside a display-count
  // fix would be unrelated churn.
  ['apps/fiab-console/app/api/admin/gates/route.ts', '#2759: enforceCapability prologue, not withSession-shaped; counts-only change'],
  // #2744 gated the CREDENTIAL-BEARING ACTIONS on these two action-dispatch
  // routes (list-keys / regenerate-keys; topic keys + regenerate-key) behind
  // denyIfNoDlzAccess, because they return live SAS/access keys for SHARED,
  // env-pinned infrastructure to any signed-in caller.
  //
  // THE CODEMOD DECLINES BOTH: "no hand-rolled getSession() prologue" — they use
  // `if (!getSession()) return unauth();`, not the exact shape withSession
  // replaces.
  //
  // AND A WHOLE-HANDLER WRAPPER WOULD BE WRONG HERE, which is the substantive
  // point. `withDlzAccess` gates the ENTIRE handler; on these routes only SOME
  // actions are privileged. Applying it would 403 create-queue, create-topic,
  // list-rules and the Event Grid topic/subscription reads for every non-admin —
  // breaking both navigators for ordinary users to fix a key leak. The
  // authorization here is deliberately PER-ACTION and mixed, so the toolkit's
  // per-handler model does not fit until a per-action wrapper exists.
  // keys-authz.test.ts pins that split in both directions.
  ['apps/fiab-console/app/api/items/service-bus-namespace/route.ts', '#2744: per-ACTION credential gating; withDlzAccess wraps the whole handler and would 403 non-credential actions'],
  ['apps/fiab-console/app/api/items/event-grid-topic/route.ts', '#2744: per-ACTION credential gating; withDlzAccess wraps the whole handler and would 403 topic/subscription reads'],
  // #2656 touched this route only to swap a Math.random() suffix for the
  // crypto-backed randomSuffix() — the suffix flows into a Key Vault secret NAME
  // (CodeQL #513/#527/#531), so it is a two-line security fix.
  //
  // THE CODEMOD ITSELF DECLINES THIS HANDLER: it reports
  //   "POST: getSession() without the exact 401 guard"
  // (it migrates the GET in the same file fine). The POST hands `session` to
  // deployCatalogServer(session, body) as a value, and its prologue is not the
  // exact shape withSession replaces — so there is nothing for the codemod to
  // rewrite and a hand-migration is a real refactor, not a mechanical one.
  //
  // Doing that refactor here would put a rewrite of the MCP deploy path — which
  // creates Container Apps, writes Key Vault secrets, and wires ACA secretRefs —
  // next to a two-line randomness change, and make both harder to review. This
  // repo has already been burned by exactly that: a toolkit migration of
  // catalog/register turned an honest 501 into a 500 and was caught only by an
  // existing test.
  ['apps/fiab-console/app/api/admin/mcp-servers/deploy/route.ts', '#2656: codemod reports "POST: getSession() without the exact 401 guard" — migrate in a dedicated admin-family PR'],
  // The log-injection class closure wrapped request-derived values reaching
  // console.* in logSafe()/logSafeError() — ONE expression per site, no control
  // flow and no auth change. It is the same shape as #2768's exemptions above,
  // widened to the whole route surface so the class closes rather than another
  // 2-of-6 subset.
  //
  // THE CODEMOD DECLINES THESE. Sampled before claiming the exemption:
  //   --file=…/search/items/route.ts        -> "0 handlers across 0 files"
  //   --file=…/workspaces/[id]/route.ts     -> "0 handlers across 0 files"
  //   --file=…/onelake/catalog/route.ts     -> "0 handlers across 0 files"
  // Their prologues are not the exact getSession()+401 shape withSession
  // replaces, so there is nothing mechanical to rewrite. Hand-migrating 13 auth
  // prologues inside a logging-sanitization PR is unrelated churn carrying real
  // 401/403 regression risk — the precise trade-off the entries above record.
  ['apps/fiab-console/app/api/apps/supercharge/seed/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/items/rayfin-app/[id]/render/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/items/rayfin-app/preview/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/items/semantic-model/[id]/direct-lake/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/items/semantic-model/[id]/refresh/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/marketplace/sharing/providers/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/onelake/catalog/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/search/items/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/setup/wire-existing/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/synapse/notebooks/[name]/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/workspaces/[id]/items/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/workspaces/[id]/route.ts', 'log-injection: logSafe() one-liner; codemod reports 0 handlers'],
  ['apps/fiab-console/app/api/workspaces/[id]/task-flows/[flowId]/run/route.ts', 'log-injection: logSafe() one-liner + deleted a duplicate local sanitizer; codemod reports 0 handlers'],
  // N9 wired semantic-contract (VQR-first + refuse) evaluation into this streaming
  // data-agent chat hot-path; it returns a custom SSE stream + bespoke NextResponse
  // error envelopes, so withSession's try/catch→apiServerError wrapper would break
  // streaming — a legitimate codemod-resistant prologue. Migrate when the streaming
  // routes get a dedicated stream-safe toolkit wrapper.
  ['apps/fiab-console/app/api/items/data-agent/[id]/chat/route.ts', 'N9: streaming SSE agent route, custom envelopes — not withSession-migratable yet'],
  // #2652 touched this route to share the deploy-workflow allow-list with
  // /api/setup/workflow-run-status (a token-bearing SSRF fix). The codemod reports
  // SKIPPED — "no hand-rolled getSession() prologue" — because this route gates on
  // enforceCapability() rather than the getSession()+401 shape withSession
  // replaces, so there is nothing for it to rewrite. Migrating it by hand inside a
  // security PR would put a ~900-line refactor of the deploy path next to a
  // two-line allow-list change and make both harder to review.
  ['apps/fiab-console/app/api/setup/deploy/route.ts', '#2652: enforceCapability prologue, codemod-resistant — migrate in a dedicated setup-family PR'],
  // #2656 touched these three only to swap a Math.random() sessionId for the
  // crypto-backed randomId(). The codemod reports SKIPPED (streaming/SSE
  // handler) for each — same reason the data-agent chat route above is exempt:
  // withSession's try/catch→apiServerError wrapper would break the SSE stream.
  // Migrating them needs the stream-safe toolkit wrapper that entry is waiting
  // on, not a hand-roll inside a one-line randomness change.
  ['apps/fiab-console/app/api/copilot/dax/route.ts', '#2656: streaming SSE copilot route — not withSession-migratable yet (see data-agent chat)'],
  ['apps/fiab-console/app/api/copilot/notebook-assist/route.ts', '#2656: streaming SSE copilot route — not withSession-migratable yet'],
  ['apps/fiab-console/app/api/copilot/orchestrate/route.ts', '#2656: streaming SSE copilot route — not withSession-migratable yet'],
  // #2656 round 2 — the SAME sessionId defect in three more copilot routes
  // (`Math.random` keying the conversation store). Touched only for that swap.
  //
  // The codemod's OWN verdict, run per file, is the reason — not an assumption:
  //     items/azure-sql-database/[id]/copilot/route.ts: SKIPPED (POST: streaming/SSE handler)
  //     items/report/[id]/powerbi-copilot/route.ts:     SKIPPED (POST: streaming/SSE handler)
  //     items/report/copilot/route.ts:                  SKIPPED (POST: streaming/SSE handler)
  // i.e. identical to the three entries above — withSession's
  // try/catch -> apiServerError wrapper would break the SSE stream. An earlier
  // attempt deferred these rather than claim "codemod-resistant" without having
  // run it; the codemod is runnable now, so the claim is verified.
  ['apps/fiab-console/app/api/items/azure-sql-database/[id]/copilot/route.ts', '#2656: streaming SSE copilot route (codemod: SKIPPED streaming/SSE) — needs the stream-safe wrapper'],
  ['apps/fiab-console/app/api/items/report/[id]/powerbi-copilot/route.ts', '#2656: streaming SSE copilot route (codemod: SKIPPED streaming/SSE) — needs the stream-safe wrapper'],
  ['apps/fiab-console/app/api/items/report/copilot/route.ts', '#2656: streaming SSE copilot route (codemod: SKIPPED streaming/SSE) — needs the stream-safe wrapper'],
  // #2657 touched this route only to build the attribute bag through
  // safeRecordFrom (prototype-pollution fix). The codemod reports SKIPPED
  // ("getSession() without the exact 401 guard") because it returns its own
  // `err('Unauthorized', 401, 'unauthorized')` envelope rather than the literal
  // shape withSession replaces — nothing for the codemod to rewrite.
  // LU-5 touched this route only to add assertAllowedUcHost (#2607). The codemod
  // DOES apply here — and MEASURABLY breaks it: wrapping in withSession makes its
  // try/catch swallow the route's honest `PurviewNotConfiguredError -> 501` into a
  // generic 500, and register.test.ts catches that (expected 501, got 500). Proven
  // by applying the migration and watching the suite go red, then reverting.
  // Migrate when withSession learns to re-raise structured not-configured gates.
  ['apps/fiab-console/app/api/catalog/register/route.ts', 'LU-5/#2607: withSession swallows the 501 not-configured gate into a 500 (register.test.ts proves it)'],
  // #2677 touched 45 routes for a ONE-LINE quadratic-trim swap each (the
  // js/polynomial-redos sweep). 34 of them the codemod migrated cleanly and
  // they ARE migrated in this PR — verified by 2020 app/api tests staying green.
  // These 11 are codemod-RESISTANT: 9 use a bespoke `err(msg, 401, code)`
  // envelope rather than the literal getSession()+401 shape withSession
  // replaces, 1 has no getSession() prologue at all, and 1 aborts on
  // overlapping edits. Hand-migrating them would change shipped 401/404 bodies
  // inside a security sweep — the same trade already rejected for
  // catalog/register, where doing it made withSession swallow an honest 501
  // into a 500 and register.test.ts caught it.
  ['apps/fiab-console/app/api/apim/named-values/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/ctas/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/dataflow/profile/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/eventstream/[id]/activator/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/kql-dashboard/[id]/activator/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/lakehouse-shortcut/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/ontology-sdk/[id]/publish/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/report/[id]/native-query/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/report/[id]/profile/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/thread/materialize-to-kql/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/thread/promote-medallion/route.ts', '#2677: codemod-resistant prologue; one-line ReDoS trim swap only'],
  ['apps/fiab-console/app/api/items/[type]/[id]/business-metadata/route.ts', '#2657: bespoke err() 401 envelope, codemod-resistant — migrate with the items family'],
  // LU-5 S4 class sweep touched these two ONLY to route their Atlas typedef name
  // through lib/azure/purview-typedef-namespace (a 1-line namespace fix each).
  // `migrate-route-toolkit.mjs --file=<each>` reports SKIPPED — "getSession()
  // without the exact 401 guard": both use a bespoke `err(msg, 401, code)` helper
  // whose envelope (`{ok:false,error,code}`) differs from `apiUnauthorized()`, so
  // the codemod refuses and a hand-migration would change the 401/404 body of two
  // SHIPPED item routes. Not doing that inside a security fix. Migrate when the
  // items family gets its `err()` prologue taught to the codemod.
  ['apps/fiab-console/app/api/items/[type]/[id]/classifications/route.ts', 'LU-5 S4: codemod reports SKIPPED (bespoke err() 401 envelope); typedef-namespace fix only'],
  ['apps/fiab-console/app/api/items/[type]/[id]/sensitivity/route.ts', 'LU-5 S4: codemod reports SKIPPED (bespoke err() 401 envelope); typedef-namespace fix only'],
  // #2896 touched this route ONLY to wrap the slow runSelfAudit() in
  // getOrComputeCached (serve-stale) so /admin/readiness stops being an ~8s
  // spinner — the gate list, statuses, and probe set are unchanged.
  // `migrate-route-toolkit.mjs --file=app/api/admin/readiness/route.ts` reports
  // SKIPPED — "GET: getSession() without the exact 401 guard": the prologue is a
  // CAPABILITY gate (enforceCapability(session, 'admin.env-config', 'Admin')),
  // not the getSession()→401 shape withSession/withDlzAccess replace, and there
  // is no toolkit wrapper for capability gates yet. Hand-migrating an auth
  // prologue inside a load-latency fix is unrelated churn with real regression
  // risk on the admin readiness surface.
  ['apps/fiab-console/app/api/admin/readiness/route.ts', '#2896: load-latency cache only; codemod reports SKIPPED (enforceCapability gate, no getSession→401 shape)'],
  // #2929 (secondary) gave this reindex route a DUAL auth prologue: a signed-in
  // admin session OR the VNet-internal trust token (isValidInternalToken, the
  // same credential the copilot-evaluator uses on eval-probe), so
  // copilot-quality-evals.yml can trigger the loom-docs reindex before its run.
  // withSession is SEMANTICALLY INCOMPATIBLE here, not merely codemod-resistant:
  // it checks the session ONLY, so migrating would DROP the internal-token path
  // that is the entire point of the change. Migrate when the toolkit grows a
  // session-OR-internal-token wrapper (the eval-probe route hand-rolls the same
  // check for the same reason).
  ['apps/fiab-console/app/api/help-copilot/reindex/route.ts', '#2929: dual session-OR-internal-token auth; withSession checks the session only and would drop the token path (needed for the CI reindex trigger)'],
  // #2947 (the assertOwner sweep) touched these 44 routes to swap ONE line per
  // handler: the owner-only `assertOwner(workspaceId, oid)` authorization check
  // — which point-reads the CALLER's Cosmos partition and therefore answered
  // "did you CREATE this workspace" instead of "may you ACCESS it", 404ing every
  // tenant admin and shared-ACL member — for the canonical
  // `authorizeItemWorkspace` / `authorizeWorkspace` ladder, read/write scoped.
  //
  // THE AUTH PROLOGUE withSession REPLACES IS UNTOUCHED: every one of these
  // keeps its `const s = getSession(); if (!s) return apiError('unauthenticated',
  // 401)`. THE CODEMOD DECLINES ALL 44 — running
  //   node scripts/codemods/migrate-route-toolkit.mjs --file=<each>
  // over the list reports "DRY-RUN: 0 handlers across 0 files" for every file,
  // skipping each handler with "getSession() without the exact 401 guard" (they
  // return the apiError helper, not the literal NextResponse.json shape the
  // codemod matches). Hand-migrating 44 routes' handler signatures inside a
  // security fix is unrelated churn with real 401-regression risk across the
  // whole item-editor surface; the route-toolkit migration for this family is
  // tracked separately.
  ['apps/fiab-console/app/api/admin/workspaces/[id]/connections/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/admin/workspaces/[id]/spark/environment/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/admin/workspaces/[id]/spark/pools/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/experience/warp/transforms/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/activator/[id]/rules/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/activator/[id]/start/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/activator/[id]/stop/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/airflow-job/[id]/connection/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/airflow-job/[id]/dag-runs/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/airflow-job/[id]/dags/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/airflow-job/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/airflow-job/[id]/task-logs/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/[id]/approval-logicapp/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/[id]/evaluate/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/[id]/export/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/[id]/integration-runtimes/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/[id]/publish/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/[id]/triggers/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/[id]/validate/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/data-pipeline/practice-seed/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/databricks-notebook/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/dataflow/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/event-schema-set/[id]/check-compat/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/event-schema-set/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/event-schema-set/[id]/versions/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mirrored-database/[id]/monitor/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mirrored-database/[id]/open-mirror/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mirrored-database/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mirrored-database/[id]/sources/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mirrored-database/[id]/sql-endpoint/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mirrored-databricks/[id]/catalog/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mirrored-databricks/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mirrored-databricks/[id]/sql-endpoint/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mounted-adf/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/mounted-adf/[id]/run/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/notebook/[id]/execute-spark/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/notebook/[id]/jobs/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/notebook/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/notebook/[id]/run/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/notebook/[id]/runs/[runId]/log/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/notebook/[id]/runs/[runId]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/items/synapse-notebook/[id]/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  ['apps/fiab-console/app/api/workspaces/[id]/scm/route.ts', '#2947: one-line assertOwner→authorizeItemWorkspace authz swap; getSession→401 prologue untouched; codemod reports 0 handlers (no exact 401 guard)'],
  // #3090 (FINISHLINE L-DEPLOY) touched these two ONLY to correct a user-facing
  // remediation STRING inside an ALREADY-EXISTING 403 response body. The live
  // 2026-08-07 defect was that Loom told the operator to "Set
  // LOOM_TENANT_ADMIN_OID … on the loom-console container app" — a value the
  // DEPLOY must produce (auto-bind-by-default.md §5), not a user chore. The
  // diff on both files is a string literal plus two response fields (`code`,
  // `gateId`); NO auth logic is touched — the prologues (getSession →
  // isTenantAdmin / requireTenantAdmin) are byte-identical.
  //
  // The codemod CANNOT be run to check: scripts/codemods/migrate-route-toolkit.mjs
  // requires the `typescript` module, and this worktree has no node_modules
  // (installing at a worktree root corrupts the main checkout). Hand-migrating
  // two admin auth prologues inside a message-only fix is unrelated churn with
  // real 403-regression risk on tenant-wide surfaces, for zero security gain.
  //
  // COMPENSATING CONTROLS — stated honestly, they DIFFER between the two:
  //   admin/workspaces  VERIFIED. admin-routes.test.ts pins both
  //                     'GET 403 when the caller is not a tenant admin'
  //                     (asserting status 403 AND error==='forbidden', which
  //                     this change preserves) and 'GET 401 when
  //                     unauthenticated'. Deleting the prologue fails a
  //                     merge-blocking test.
  //   admin/dspm-ai     NONE. That route has NO __tests__ directory at all, so
  //                     nothing pins its 401/403 — this is a real gap, recorded
  //                     rather than papered over. It is unchanged by #3090
  //                     (the gap predates it) and is tracked as a follow-up:
  //                     add a route-level 401/403 contract test.
  ['apps/fiab-console/app/api/admin/workspaces/route.ts', '#3090: 403 remediation-string fix only (auto-bind §5); auth prologue byte-identical; 401 AND 403 both pinned by app/api/admin/__tests__/admin-routes.test.ts'],
  ['apps/fiab-console/app/api/admin/dspm-ai/route.ts', '#3090: 403 remediation-string fix only (auto-bind §5); auth prologue byte-identical; NO route-level auth test exists for this route (pre-existing gap, follow-up owed)'],
]);

/** All route files (repo-relative POSIX paths) under app/api. */
function listRouteFiles() {
  // NB: double quotes — single quotes are not quoting chars in cmd.exe.
  const out = execSync('git ls-files "app/api/**/route.ts"', { cwd: APP_ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((f) => `apps/fiab-console/${f}`);
}

/** Measure the current hand-rolled set → { repoRelPath: 1 }. */
export function scanHandRolled() {
  const current = {};
  for (const rel of listRouteFiles()) {
    const abs = path.join(REPO_ROOT, rel);
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!MUTATING_EXPORT_RE.test(src) && !GET_EXPORT_RE.test(src)) continue; // no data surface
    if (!AUTH_SESSION_IMPORT_RE.test(src)) continue; // not session-based (or session via toolkit only)
    if (TOOLKIT_RE.test(src)) continue; // migrated / composing the toolkit
    current[rel] = 1;
  }
  return current;
}

function main() {
  const current = scanHandRolled();
  const exit = runRatchet({
    name: 'route-toolkit',
    baselineFile: BASELINE_FILE,
    meta: {
      owner: 'loom-next-level WS-R (R3) — platform/code-health',
      why:
        'Hand-rolled getSession() prologues drift (cross-tenant-hole class); every route ' +
        'migrates to lib/api/route-toolkit.ts wrappers. Baseline = the grandfathered ' +
        'hand-rolled set; it only shrinks.',
      unblock:
        'migrate: node scripts/codemods/migrate-route-toolkit.mjs --apply --family=<area>  ' +
        'then: node scripts/ci/check-route-toolkit.mjs --update-baseline  ' +
        '(codemod-resistant prologue? add the path to TOUCH_EXEMPT in check-route-toolkit.mjs with a reason)',
    },
    current,
    touched: {
      files: gitTouchedFiles({ cwd: REPO_ROOT }),
      exempt: TOUCH_EXEMPT,
      message: (key) => {
        const family = key.match(/app\/api\/([^/]+)\//)?.[1] ?? '<area>';
        return (
          `you touched ${key}; migrate it to the route-toolkit while you're here ` +
          `(node scripts/codemods/migrate-route-toolkit.mjs --apply --family=${family})`
        );
      },
    },
  });
  process.exit(exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
