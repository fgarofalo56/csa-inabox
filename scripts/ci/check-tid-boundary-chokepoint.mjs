#!/usr/bin/env node
/**
 * GUARDRAIL: tid-boundary-chokepoint  (merge-blocker — issue #2703)
 * ---------------------------------------------------------------------------
 * RULE:
 *
 *   The cross-tenant boundary in `resolveWorkspaceAccessByOid` (step 4: the
 *   caller's Entra `tid` must match the workspace doc's `tid`) must be
 *   IMPOSSIBLE TO SKIP BY OMISSION. Concretely:
 *
 *     1. `resolveWorkspaceAccessByOid` and `listAccessibleWorkspaces` take a
 *        REQUIRED `WorkspaceAccessOpts` — no `= {}` default. A new call site
 *        that forgets the tenant must be a COMPILE ERROR.
 *     2. `WorkspaceAccessOpts` keeps both arms: `callerTid` (enforce) and the
 *        explicit `skipTidBoundary` + `skipTidBoundaryReason` opt-out.
 *     3. The boundary is evaluated from `effectiveCallerTid(...)` — explicit tid
 *        first, then the ambient request session for the SAME principal — and it
 *        runs BEFORE the ACL grant and the admin-open bypass, not after.
 *     4. `ambientCallerTid` only borrows a tid when the ambient session's `oid`
 *        equals the oid being resolved (no cross-principal attribution).
 *     5. Every call site passes the options argument.
 *     6. `skipTidBoundary` — the one way to switch the boundary off — is pinned
 *        to an allowlist here, WITH a reason, so a new bypass is a review.
 *     7. `listAllOwnedItems` (the Copilot `item_list` backing) still accepts a
 *        session, so it CAN enforce the boundary.
 *     8. (#3825) EVERY WORKSPACE AUTHORIZER DELEGATES THE ACCESS DECISION AND
 *        EVERY ALLOW IT MAKES IS THE DELEGATED VERDICT. The authorizer set is
 *        DERIVED from `lib/auth/**` rather than listed; an ALLOW is proved
 *        against the verdict by BOOLEAN IMPLICATION rather than by naming a
 *        token; and the two legitimate ALLOWs that precede a delegation are
 *        pinned by POSITION (their whole prologue text), not by their condition
 *        string. See section 8 for the mechanism and its measured limits.
 *     9. (round 5) THE DERIVATION ITSELF IS ASSERTED. Six named authorizers must
 *        still appear in the derived `checked:` set (section 8i,
 *        `REQUIRED_AUTHORIZERS`). Every finding of the round-5 review showed up
 *        first as that list quietly getting shorter while the guard printed OK,
 *        and no amount of checking matters over a population that silently
 *        shrank.
 *
 * WHY 8 EXISTS — THIS GUARD WAS MEASURED BLIND TO #3825, AND THAT IS RECORDED
 * RATHER THAN QUIETLY FIXED. Checks 1-7 verify that every call site SUPPLIES the
 * discriminant and that the comparison sits ahead of the ACL and admin steps.
 * None of them verifies that the BOUNDARY DECIDES. Proof, run against the tree
 * on 2026-08-20: with #3824's step-6 fix fully reverted to an unconditional
 * `if (opts.tenantAdmin) return { role:'Admin', canWrite:true }` — blob hash
 * moved 0398c3c -> 7ee89c1, and the #3823 spec went RED (5 of 17) — this guard
 * still printed "OK" and exited 0. A caller can therefore hand the resolver a
 * perfect `callerTid` and still be granted across tenants, and checks 1-7 see
 * nothing wrong, because from their point of view nothing IS wrong.
 *
 * #3825 was the same blindness one level up: `authorizeWorkspace` opened with
 * `if (isTenantAdmin(session)) return null;` — returning BEFORE any Cosmos read,
 * so it never called the resolver at all and there was no call site for this
 * guard to inspect. `resolveAdminWorkspace` did the same and then read the
 * workspace with an unfiltered cross-partition `SELECT *` (`loadWorkspaceAdmin`).
 *
 * WHY A GUARD AND NOT JUST TYPES:
 *   `tsc` enforces (1) and (5) today, and that is the primary mechanism — but a
 *   single `as any` at a call site, or someone re-adding `= {}` "to unbreak the
 *   build", silently restores the exact hole #2703 filed: a security control
 *   that does nothing when an optional input is absent, while still READING as
 *   enforced. Items (3), (4), (6) and (8) are not expressible in the type system
 *   at all. This turns each of those into a red build.
 *
 * ANTI-PATTERNS DELIBERATELY AVOIDED (learned from check-unity-audit-chokepoint's
 * three rewrites): comments and string literals are MASKED before any scan, so a
 * mention in a doc comment cannot satisfy a check; ordering assertions
 * brace-match the named function body rather than substring-testing the rest of
 * the file; and every exemption carries a reason and is reported when stale.
 *
 * ## PROVEN TO FAIL. Each of these was applied to the tree and the guard's exit
 * code recorded. A guard nobody has tried to defeat is a comment.
 *
 *   M1  `opts: WorkspaceAccessOpts = { callerTid: undefined }`      exit 1
 *   M2  `effectiveCallerTid` drops the `ambientCallerTid` fallback  exit 1
 *   M3  `ambientCallerTid` drops the `claims.oid !== oid` check     exit 1
 *   M4  `callerTid` made optional on the enforcing arm              exit 1
 *   M5  `listAllOwnedItems` loses its session parameter             exit 1
 *   M6  the tid comparison moved BELOW `resolveEffectiveRole`       exit 1
 *   M7  `await (resolveWorkspaceAccessByOid as any)(oid, ws)`       exit 1
 *   M8  an unpinned file passes `skipTidBoundary: true`             exit 1
 *   M10 `const f = resolveWorkspaceAccessByOid; f(oid, ws, …)`      exit 1
 *   M11 a plain 2-argument call (the original #2703 shape)          exit 1
 *   M9  NEGATIVE CONTROL — a comment mentioning skipTidBoundary     exit 0
 *   M12 (#3825) `authorizeWorkspace` re-adds the admin short-circuit exit 1
 *   M13 (#3825) `authorizeWorkspace` drops `tenantAdmin:` from opts  exit 1
 *   M14 (#3825) `resolveAdminWorkspace` restores `loadWorkspaceAdmin` exit 1
 *   M15 (#3825) `resolveAdminWorkspace` loses its isTenantAdmin gate exit 1
 *   M16 an itemType-scoped admin ALLOW in `authorizeItemWorkspace`   exit 1
 *   M17 the same, a different itemType and a `||` instead of `&&`    exit 1
 *   M18 an admin ALLOW conditioned on the METHOD, not the itemType   exit 1
 *   M19 an ALLOW that never names isTenantAdmin (an env-var oid)     exit 1
 *   M21 NEGATIVE CONTROL — the forbidden shape inside a comment      exit 0
 *
 * ROUND 3 (2026-08-21). M16-M19 hardened section 8 by SHAPE, and an independent
 * review then defeated the hardened version TEN more ways in one pass. Six of the
 * ten passed this guard; five passed the whole stack (guard + the 27-test #3825
 * spec + the 236-test wide suite) with a live cross-tenant ALLOW. Every one of
 * them reduces to the same structural defect: THE GUARD KEYED ON SHAPES IT COULD
 * NAME. Each is reproduced in this file's own terms below, and each now exits 1:
 *
 *   N1  `if (!denied || opts.itemType === 'lakehouse') return null;`   exit 1
 *       — round 2's 8e tested that the ALLOW's condition MENTIONED the delegated
 *         verdict. A disjunction mentions it and discards it. `resolverConsulted=1`
 *         was no help either: "consult, then throw the answer away" is invisible
 *         to a counter that only asks whether the chokepoint was entered.
 *   N2  an env-oid ALLOW ORed onto the real verdict test               exit 1
 *   N3  CONTROL — the flag bound to a local inside the authorizer      exit 1
 *   N4b the bypass hopped through a module-level helper, so the
 *       authorizer body never says `isTenantAdmin` at all              exit 1
 *   N5  a TERNARY ALLOW (`return <check> ? null : …`), invisible to a
 *       `/\breturn\s+null\b/` model of what an ALLOW looks like        exit 1
 *   N6a a NEW exported authorizer in this module, env-oid ALLOW        exit 1
 *   N6b CONTROL — same, naming isTenantAdmin                           exit 1
 *   N6c the same with `id` instead of `workspaceId` in the signature,
 *       which the old signature filter dropped on the floor            exit 1
 *   N7  the pinned pre-delegation ALLOW's CONDITION TEXT left intact
 *       and its INPUT forged one line above it                         exit 1
 *   N9  a SECOND `if (!workspaceId) return null;`, silently sharing
 *       the pinned `<fn>:<cond>` allowlist key                         exit 1
 *   N10 the literal #3825 defect in `authorizeWorkspaceList` — a third
 *       workspace authorizer the AUTHORIZERS table never named         exit 1
 *
 * AND TWO THIS FILE'S OWN AUTHOR INVENTED AGAINST THE ROUND-3 FIX, because a
 * guard that has only survived someone else's list has survived a list:
 *
 *   N11 a fail-OPEN `catch` around the delegation ("be resilient to a
 *       Cosmos blip") — the specs never make the delegate throw, so this
 *       one is the GUARD's alone to catch                              exit 1
 *   N12 a shadowing `const denied = null` in an inner block, with every
 *       ALLOW condition left byte-identical. It DEFEATED the round-3 fix
 *       as first written (guard exit 0, caught only by the new itemType
 *       sweep in the #3825 spec), because the implication test reasons
 *       about the verdict BY NAME and the name had been re-bound. The
 *       verdict binding must now be a single immutable `const`          exit 1
 *
 * ROUND 4 (2026-08-21). A second independent review returned five blockers, and
 * EVERY ONE OF THEM WAS A DEFECT IN THIS FILE rather than in the code it guards —
 * the shipped #3825 fix was sound and the live hole was closed, but the tripwire
 * over it was not watching. Each is reproduced here as a mutation with its
 * measured exit code BEFORE and AFTER the round-4 change. `R#a` is the control
 * that was already caught; `R#b` is the one that was not.
 *
 *   R1a `if (opts.allowReadRoles === undefined) return null;`
 *                                                     before 1   after 1
 *   R1b the SAME line, returning `access && null` — always falsy, so
 *       always ALLOW, and `allowReadRoles === undefined` is the DEFAULT:
 *       a total cross-tenant bypass of every write-scoped call site.
 *       `classifyValue` treated any value that MENTIONED the verdict as
 *       BEING the verdict, so 8d's implication test never ran on it
 *                                                     before 0   after 1
 *   R2  an in-gate `return access !== undefined;` — TRUE exactly when the
 *       delegate said no. 8e asked only whether the gate's region
 *       contained an ALLOW, using that same classifier, so its
 *       "narrowing gate" exemption was accidental rather than reasoned:
 *       `resolveAdminWorkspace` passed because the guard could not SEE
 *       the grant inside it. 8e now applies 8d's reachability test
 *                                                     before 0   after 1
 *   R3a an env-oid grant appended as `export async function`
 *                                                     before 1   after 1
 *   R3b the BYTE-IDENTICAL body as `export const f = async (…) => {…}`.
 *       The declaration-form filter ran BEFORE 8a's four independent
 *       triggers, so all four were dodged by a keyword
 *                                                     before 0   after 1
 *   R3c the same as a CONCISE arrow body (no `return` token at all)
 *                                                     before 0   after 1
 *   R3d the same behind a declared function TYPE (`const f: PickerFn =`),
 *       so the arrow declares no return type of its own
 *                                                     before 0   after 1
 *   R3e the same as `export const f = async function (…) {…}`
 *                                                     before 0   after 1
 *   R3f the same as an object-literal METHOD           before 0   after 1
 *   R3g the same as an anonymous `export default async function`
 *                                                     before 0   after 1
 *   R3h the 8h repo-wide variant: the admin-grants-alone shape in a
 *       workspace-scoped ARROW outside `lib/auth`      before 0   after 1
 *   R4  DELETING `item-access.ts`'s item-grant tid comparison outright.
 *       Its POST_DELEGATION_PINS reason said "removing that boundary … is
 *       a red build"; widening was caught, removing was not, because a
 *       non-single-return `if` block contributes nothing to a path
 *       condition and both pinned strings stayed byte-identical. That is
 *       an R7 violation inside the guard. The pin now carries a `region`
 *                                                     before 0   after 1
 *   R5  `ambientAccessOptsFor` returns `{ skipTidBoundary: true, … }`,
 *       switching the boundary off for the whole oid-only population
 *       (item-crud, pipeline-binding, cosmos-items). Section 6 exempted
 *       the entire chokepoint FILE, and the report then affirmatively
 *       printed `skipTidBoundary users: 0` over a live one. The exemption
 *       is now a RANGE — the type declaration and `effectiveCallerTid`
 *                                                     before 0   after 1
 *
 * AND TWO THIS FILE'S AUTHOR INVENTED AGAINST THE ROUND-4 FIX, because a fix that
 * has only survived the review's list has survived a list:
 *
 *   R6  the arrow declared UNEXPORTED and re-exported one line later by a
 *       separate `export { … }`, so the `export` keyword 8a keyed on never
 *       sits next to the declaration. It DEFEATED the round-4 fix as first
 *       written (guard exit 0 with a live env-oid grant); "exported" is now
 *       the union of both spellings   round-4-as-first-written 0   now 1
 *   R7' a post-delegation grant inside a `??` fallback,
 *       `return isTenantAdmin(s) ? (access ?? ({…})) : access;` — the
 *       fallback fires exactly when `access` is null, i.e. exactly when the
 *       delegate refused                              before 1   after 1
 *
 * The clean tree is exit 0 before and after, and M1/M3/M9/M11/M12/M14/M15/N1/N10/
 * N12/N21 keep the exit codes recorded above them.
 *
 * ROUND 5 (2026-08-21). A third independent review returned FOUR blockers and
 * three should-fixes, and — as in round 4 — every one was a defect in THIS FILE
 * rather than in the code it guards. THEY ALL HAD ONE SYMPTOM: the derived
 * `checked:` list quietly got SHORTER and the guard still printed OK. Nothing in
 * the guard noticed, which is why the most important thing this round adds is not
 * any of the four fixes but section 8i, a standing assertion that the six known
 * authorizers are still being checked. `S#a` is the control that was already
 * caught; `S#b` is the one that was not.
 *
 *   S1a an env-oid grant as the first line of `authorizeWorkspace`
 *                                                     before 1   after 1
 *   S1b THE SAME LINE, with one ORDINARY line above it:
 *       `if (/^https?:\/\//i.test(workspaceId)) return NextResponse.json(…);`
 *       — a line that already exists verbatim at `lib/azure/arm-client.ts:40`.
 *       `mask` had no regex-literal case, so `\/\/` read as a `//` COMMENT and
 *       the rest of the line was blanked, taking its `)` with it; round 4's
 *       `matchingClose` counts `(`, `[` and `{` in ONE counter, so it returned
 *       -1, `callableSpan` returned null and `authorizeWorkspace` VANISHED —
 *       "13 verdict-returning export(s) — 5 checked", the name simply absent
 *                                                     before 0   after 1
 *   S1c CONTROL — that regex line ALONE, no bypass    before 0   after 0
 *   S2  NOT A MUTATION, A FALSE DISCLOSURE: 8h claimed "17835 declarations
 *       before, 21050 after, with ZERO true drops". Re-measured by SET DIFF:
 *       17958/17943 before and 137 drops, not 2. Restated on 8h, with a
 *       committed tool that reproduces every number
 *                                                     (see scripts/ci/measure-tid-guard-decl-sets.mjs)
 *   S3a `export async function f(…): Promise<NextResponse | null>` with an
 *       env-oid grant                                 before 1   after 1
 *   S3b THE BYTE-IDENTICAL BODY with the return-type ANNOTATION DELETED. The
 *       derivation dropped any candidate whose `expandReturnType` failed
 *       `VERDICT_RETURN`, and an unannotated declaration yields `''` — dropped
 *       BEFORE all four independent triggers ran, exactly the mistake round 4
 *       fixed for the declaration FORM (R3b) left on the return TYPE
 *                                                     before 0   after 1
 *   S3c the same in `workspace-list-access.ts`, whose ALLOW is NON-null
 *                                                     before 0   after 1
 *   S4a `async function f(…) {…}` + `export default f;`
 *                                                     before 0   after 1
 *   S4b `const f = async (…) => {…}` + `export default f;` — the docblock said
 *       "exported is the union of BOTH spellings"; there were three
 *                                                     before 0   after 1
 *   S5a `export async function canListWorkspace(…): Promise<boolean>` with an
 *       env-oid `return true`, DELEGATING below it. A boolean verdict is an
 *       ordinary authorizer shape and was a TOTAL, undisclosed blind spot —
 *       the return type is now a TIER, never a filter
 *                                                     before 0   after 1
 *   S5b the same NOT delegating at all                before 0   after 1
 *   S6  `export const authorizeWorkspacePicker = withAudit(async (…) => {…})`
 *       — branch 2 required the arrow directly after `=`
 *                                                     before 0   after 1
 *   S7  the report printed an affirmative `skipTidBoundary users: 0` it could
 *       not establish. The count line now says what it counted. The SHAPE
 *       (`const K = 'skipTid' + 'Boundary'; { [K]: true }`) is still exit 0
 *       and still disclosed — see below            before 0   after 0 (disclosed)
 *   S8  NOT A MUTATION, A FALSE SENTENCE: 8h said "Inside `lib/auth/**`
 *       sections 8a-8e catch that variant structurally". S1b, S3b, S4a/b and
 *       S6 are ALL inside `lib/auth`, ALL re-derive admin from an env-var oid
 *       without the token, and ALL exited 0. Corrected on 8h.
 *
 * AND THE REGRESSION BATTERY THAT PROVES THE REST DID NOT MOVE. The 20-case
 * battery (5 expected-0, 15 expected-1) was run against the round-4 guard and the
 * round-5 guard on the same tree: round 4 scores 12/20, round 5 scores 20/20, and
 * the 12 round 4 already caught — CLEAN, M9, N21, S1c, S7, M11, M12, R1b, R2, N1,
 * N12, S1a — are unchanged. A fix that only moves the cases it was written for is
 * the one to distrust.
 *
 * STILL NOT COVERED, so it is not read as covered:
 *   - the opt-out named through a STRING (`const K = 'skipTid' + 'Boundary';
 *     return { [K]: true, … }`) is invisible to section 6, because string
 *     literals are masked before any scan — the same masking that makes M9/N21
 *     negative controls pass. MEASURED at exit 0. The count line no longer
 *     asserts otherwise. The specs are the backstop for that shape, not this file.
 *   - a TIER-2 authorizer (a readable, non-verdict return type — see 8a) that
 *     grants AFTER its delegation with a value that MENTIONS the verdict. 8d
 *     reasons about the verdict by name in the CONDITION, not in the value.
 *   - a wrapped arrow bound to a LOCAL rather than a module-level const, and the
 *     rest of the declaration-finder limits recorded on 8h.
 *
 * Usage: node scripts/ci/check-tid-boundary-chokepoint.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CONSOLE_ROOT = 'apps/fiab-console';
const ACCESS_FILE = `${CONSOLE_ROOT}/lib/auth/workspace-access.ts`;
const GUARD_FILE = `${CONSOLE_ROOT}/lib/auth/workspace-guard.ts`;
const ITEM_CRUD_FILE = `${CONSOLE_ROOT}/app/api/items/_lib/item-crud.ts`;
const AUTHZ_DIR = `${CONSOLE_ROOT}/lib/auth`;
const SCAN_DIRS = [`${CONSOLE_ROOT}/app`, `${CONSOLE_ROOT}/lib`];

/** Functions whose options argument carries the tenant boundary. */
const GUARDED_CALLS = [
  // name                          minimum argument count (oid, …, opts)
  ['resolveWorkspaceAccessByOid', 3],
  ['listAccessibleWorkspaces', 2],
];

/**
 * Files permitted to use the `skipTidBoundary` opt-out, each with the reason a
 * reviewer can check against the file. EMPTY on purpose: no production call site
 * needs it today. Every caller either has the session (passes `callerTid`) or is
 * on-request (the resolver recovers the tid from the ambient session). Adding an
 * entry here is a security review, which is the point.
 */
const SKIP_ALLOWLIST = new Map([
  // ['lib/some/off-request-job.ts', 'reason a reviewer can verify against the file'],
]);

/** A mention of the tenant-admin flag. Declared here because the helpers use it. */
const ISADMIN = /\bisTenantAdmin\s*\(/;

/**
 * The functions an authorizer is permitted to DELEGATE its verdict to. This list
 * is the definition of "the decision has one implementation" — not a list of who
 * gets checked. WHO gets checked is derived (section 8, `deriveCandidates`).
 */
const CHOKEPOINTS = [
  'resolveWorkspaceAccessByOid',
  'authorizeWorkspace',
  'authorizeItemWorkspace',
  'resolveAdminWorkspace',
  'authorizeWorkspaceList',
];

/**
 * Return types that make an exported function a workspace/item AUTHORIZATION
 * VERDICT — i.e. something a route branches on to decide access. Deliberately
 * GENEROUS: a false positive costs one classified line in NON_AUTHORIZERS below,
 * a false negative costs a bypass nobody looks at (which is N6c, measured).
 */
const VERDICT_RETURN =
  /\bNextResponse\b|\bWorkspace[A-Za-z]*\b|\bItemAccess[A-Za-z]*\b|\bAccessRole\b|Resolution\b/;

/** A workspace/item identifier in a signature — the TIER-2 net only (see 8.0). */
const WORKSPACE_PARAM = /\bworkspace(Id|_id)?\b|\bitem(Id|Type|_id)?\b/i;

/**
 * THE DERIVED SET MUST STILL CONTAIN THESE. A standing assertion, and the single
 * most load-bearing thing in section 8.
 *
 * ROUND 5 EXISTS BECAUSE THE DERIVATION CAN GO BLIND WITHOUT SAYING SO. Every
 * finding in the round-5 review manifested the SAME way — the `checked:` list
 * quietly got shorter and the guard still printed OK:
 *
 *   - blocker 1: one ordinary line (`if (/^https?:\/\//i.test(workspaceId)) …`,
 *     which already exists verbatim at `lib/azure/arm-client.ts:40`) deleted
 *     `authorizeWorkspace` from the derivation. 6 checked -> 5, exit 0, with a
 *     live cross-tenant env-oid grant sitting in it.
 *   - blocker 3: deleting a return-type ANNOTATION dropped the candidate before
 *     any trigger ran.
 *   - blocker 4: `export default f;` was not read as an export at all.
 *
 * Each of those has now been fixed at its mechanism. This map is the check that
 * does not depend on having anticipated the mechanism: if any of these six stops
 * being CHECKED — whatever the reason, a masking bug, a parser regression, a
 * rename, a new keyword — the build goes RED and names it. A guard whose subject
 * can silently leave its own population is not watching
 * (`csa_loom_mutation_that_does_not_move_the_verdict`).
 *
 * REMOVING AN ENTRY IS A SECURITY REVIEW, not a maintenance chore: it asserts the
 * function genuinely no longer exists, not that the guard stopped seeing it.
 */
const REQUIRED_AUTHORIZERS = new Map([
  [
    'lib/auth/workspace-guard.ts:authorizeWorkspace',
    'the primary workspace authorizer — the function #3825 was filed against ' +
      '(`if (isTenantAdmin(session)) return null;` ahead of any Cosmos read).',
  ],
  [
    'lib/auth/workspace-guard.ts:authorizeItemWorkspace',
    "the item-scoped authorizer; it carries one of the two pinned pre-delegation " +
      'ALLOWs (PROLOGUE_PINS), which is unverifiable if it is not being checked.',
  ],
  [
    'lib/auth/workspace-guard.ts:requireWorkspace',
    'the one-call route guard most API handlers use; it delegates to ' +
      '`authorizeWorkspace` and is the shape a route-level bypass would be written in.',
  ],
  [
    'lib/auth/workspace-guard.ts:resolveAdminWorkspace',
    'the admin-plane resolver — the second #3825 defect (`loadWorkspaceAdmin`, an ' +
      'unfiltered cross-partition `SELECT *`). It carries the other PROLOGUE_PINS ' +
      'entry and the only isTenantAdmin narrowing gate 8e admits.',
  ],
  [
    'lib/auth/workspace-list-access.ts:authorizeWorkspaceList',
    'the LIST authorizer (N10) — a third workspace authorizer the round-2 table never ' +
      'named, which took the literal #3825 bypass at exit 0. It ALLOWs with a NON-NULL ' +
      'value, so it is also the module that proves both ALLOW conventions are modelled.',
  ],
  [
    'lib/auth/item-access.ts:resolveItemAccessByOid',
    'the item-access resolver, and the only holder of a POST_DELEGATION_PINS entry — ' +
      'the item-grant path whose own tid comparison R4 showed could be DELETED with the ' +
      'pin byte-identical.',
  ],
  [
    'lib/auth/workspace-role.ts:resolveWorkspaceRole',
    'the FOURTH copy of the tenant decision, consolidated onto the resolver by #3840. It ' +
      'was a NON_AUTHORIZERS entry — an exemption whose own reason called it "a finding, ' +
      'not a clearance" — and it carried a private truthiness-guarded comparison in front ' +
      'of a route ladder that grants on `isTenantAdmin` alone. It now delegates and holds ' +
      'the second POST_DELEGATION_PINS entry (its `workspace-permissions` ACL). If it ' +
      'stops being checked, that pin is unverifiable and the exemption is silently back.',
  ],
]);

/**
 * Derived candidates that are NOT authorizers, each with the reason a reviewer
 * can check against the file. A candidate absent from this map MUST delegate and
 * MUST justify every ALLOW against the delegated verdict — so a NEW function is
 * covered by DEFAULT and an exemption is a review. That polarity is the whole
 * point: the previous `AUTHORIZERS` table was opt-IN, and `authorizeWorkspaceList`
 * sat outside it taking the bare #3825 bypass at exit 0 (N10).
 */
const NON_AUTHORIZERS = new Map([
  [
    'lib/auth/workspace-access.ts:resolveWorkspaceAccessByOid',
    'THIS IS the chokepoint every authorizer delegates TO. Sections 1-4 govern it ' +
      '(required opts, both arms of the type, the tid comparison ahead of the ACL and ' +
      'the admin bypass); it cannot delegate to itself.',
  ],
  [
    'lib/auth/workspace-access.ts:readWorkspaceById',
    'a raw document read with no authorization decision in it — the resolver SUBJECTS ' +
      'its result to the tid comparison. Callers are checked by sections 5-6.',
  ],
  [
    'lib/auth/workspace-access.ts:listAccessibleWorkspaces',
    'a FILTERED LIST, not a per-workspace verdict. It takes the same required ' +
      '`WorkspaceAccessOpts` (section 1) and its call sites are checked by section 5.',
  ],
  [
    'lib/auth/workspace-access.ts:ambientAccessOptsFor',
    'builds the options an off-session caller passes DOWN; it decides nothing. Section ' +
      '3/4 govern how the tid inside those options is recovered.',
  ],
  [
    'lib/auth/workspace-denial.ts:workspaceDenialResponse',
    'RENDERS a refusal that the resolver already decided. Its `null` means "nothing to ' +
      'explain", not ALLOW — the caller falls through to its own 404. It reads only the ' +
      '`diag` out-channel and never touches a session, an oid or a tid.',
  ],
  [
    'lib/auth/feature-gate.ts:requireTenantAdmin',
    'the ORG-WIDE admin gate — no workspace and no item are in play, so there is no ' +
      'tenant to compare one against. This is the function section 8h has always named ' +
      'as the LEGITIMATE use of the isTenantAdmin-grants-alone shape. It is a candidate ' +
      'only because it lives in the module that DEFINES the flag.',
  ],
  [
    'lib/auth/feature-gate.ts:enforceCapability',
    'gates an org-wide CAPABILITY (`capabilityId` + a role tier), not a workspace or an ' +
      'item. Nothing it returns carries a workspace document, so there is no tenant ' +
      'boundary for it to skip.',
  ],

  // ── TIER 2 (round 5) — a readable, non-verdict return type. These became
  //    candidates when the return type stopped being a pre-trigger FILTER (see
  //    8a). None of them is a workspace authorizer; each reason is about THAT
  //    function, so an entry cannot quietly clear a sibling.
  [
    'lib/auth/feature-gate.ts:isTenantAdmin',
    'THE DEFINITION OF THE FLAG ITSELF — it compares the session against ' +
      '`LOOM_TENANT_ADMIN_GROUP_ID` / `LOOM_TENANT_ADMIN_OID` and returns that comparison. ' +
      'It takes no workspace and reads no document, so there is no tenant to compare one ' +
      'against. Sections 8e and 8h govern where its RESULT may be used; this entry says ' +
      'only that computing it is not an access decision about a workspace.',
  ],
  [
    'lib/auth/feature-gate.ts:checkCapability',
    'the org-wide CAPABILITY check (`capabilityId` + a required `FeatureRole`) that ' +
      '`enforceCapability` wraps. Same reasoning as that entry: its `GateResult` carries no ' +
      'workspace document, so it has no tenant boundary to skip.',
  ],
  [
    'lib/auth/feature-catalog.ts:capabilityIdForItemType',
    'a pure STRING MAPPING — `itemType` -> `editor.<itemType>`, validated against the static ' +
      'capability catalog. It takes no session and no workspace and reads nothing; it is a ' +
      'candidate only because `itemType` matches the tier-2 signature net.',
  ],
  [
    'lib/auth/domain-role.ts:isTenantAdminTier',
    'a one-line re-export of `isTenantAdmin(session)` into the DOMAIN tier vocabulary. Same ' +
      'reasoning as that entry, and it likewise takes no workspace.',
  ],
  [
    'lib/auth/domain-role.ts:resolveDomainTier',
    'resolves the caller\'s tier WITHIN ONE DOMAIN (tenant-admin / domain-admin / ' +
      'domain-contributor / null) from Entra group membership. A domain is not a workspace ' +
      'and carries no `tid` to compare — the workspace-level decision still runs afterwards ' +
      'through `resolveWorkspaceAccessByOid`. Its own boundary is the domain document.',
  ],
  [
    'lib/auth/domain-role.ts:canAssignWorkspaceToDomain',
    'decides whether the caller may ATTACH a workspace to a domain, given a tier and a ' +
      '`callerIsWorkspaceAdmin` flag its CALLER computed. It never resolves workspace access ' +
      'itself — the flag it consumes is the delegated verdict, produced upstream.',
  ],
  [
    'lib/auth/domain-role.ts:administeredDomainIds',
    'returns the DOMAIN ids the caller administers, for filtering domain pickers. It maps ' +
      'over domain documents via `resolveDomainTier`; no workspace document is read and none ' +
      'is returned.',
  ],
  [
    'lib/auth/domain-role.ts:canAccessDlzPanes',
    'gates the ORG-WIDE DLZ panes (scale / cost / monitor) on being a tenant admin or the ' +
      'admin of at least one domain. The subject is the DLZ surface, not a workspace, so ' +
      'there is no workspace tenant for it to compare.',
  ],
  [
    'lib/auth/pat.ts:isPatSession',
    'a one-line predicate on the session shape (`!!session?.pat`) — is this request a ' +
      'personal access token rather than a human sign-in. No workspace, no document, no ' +
      'access decision.',
  ],
  [
    'lib/auth/pat.ts:patCannotMint',
    'the token-minting refusal: a PAT may never create or revoke tokens. It calls ' +
      '`isPatSession` and nothing else; the subject is the TOKEN endpoint, not a workspace.',
  ],
  [
    'lib/auth/pat.ts:patCanAdmin',
    'whether a PAT session may reach an ADMIN surface — `scope === "admin"` AND its creator ' +
      'is still a tenant admin. Org-wide, like `requireTenantAdmin`: no workspace is in play, ' +
      'and the workspace decision still runs separately when one is.',
  ],
  [
    'lib/auth/workspace-access.ts:multiUserAclEnabled',
    'the ACL KILL SWITCH — it reads `LOOM_MULTIUSER_ACL` and returns a boolean. It takes no ' +
      'arguments at all, so it can decide nothing about any particular workspace. The ' +
      'resolver consults it INSIDE the chokepoint, after the tid comparison.',
  ],
  [
    'lib/auth/workspace-access.ts:roleCanWrite',
    'a pure lookup of `AccessRole` in the static `WRITE_ROLES` set — "does this role name ' +
      'mean write". It takes a role, not a session and not a workspace, so the access ' +
      'decision that PRODUCED the role has already happened in the resolver.',
  ],
  [
    'lib/auth/workspace-role.ts:canEditWorkspaceConfig',
    'a pure predicate on an already-resolved `WorkspaceRole` (`admin` or `contributor`). Like ' +
      '`roleCanWrite` it consumes a verdict rather than making one; it takes no session and ' +
      'reads no document. The other export of that file, `resolveWorkspaceRole`, is NOT ' +
      'exempt — it delegates (#3840) and is checked, and is named in REQUIRED_AUTHORIZERS.',
  ],
  [
    'lib/auth/item-access.ts:itemGrantConfersWrite',
    'a pure predicate on an item grant\'s `permissionTypes` array — does it contain "Edit". ' +
      'It takes no session, no oid and no tid, and the grant it inspects was produced by ' +
      '`resolveItemGrant` inside `resolveItemAccessByOid`, whose own tenant boundary is ' +
      'pinned in POST_DELEGATION_PINS.',
  ],
]);

/**
 * PRE-DELEGATION ALLOWS, pinned by POSITION rather than by condition text.
 *
 * The pinned value is the NORMALISED MASKED TEXT of the function's PROLOGUE —
 * everything from the opening brace through the end of the LAST ALLOW that
 * precedes the delegation. Pinning the whole prologue rather than the ALLOW's
 * condition string is the round-3 fix for two measured escapes:
 *
 *   N7 — the condition text `!workspaceId` was left byte-identical and its INPUT
 *        forged one line above it
 *        (`workspaceId = opts.itemType === 'x' ? '' : (await …) || '';`),
 *        producing a live cross-tenant ALLOW with `resolverConsulted = 0`;
 *   N9 — a SECOND `if (!workspaceId) return null;` elsewhere in the same
 *        function silently inherited the `<fn>:<cond>` allowlist key.
 *
 * A prologue pin answers both: N7 changes the pinned text, and N9 extends the
 * pinned region to the second ALLOW and so changes it too. The cost is stated
 * plainly — ANY edit inside these prologues fails this guard until re-pinned.
 * That is intended. These are the only two places in the console where an ALLOW
 * is permitted before the tenant decision has been made.
 */
const PROLOGUE_PINS = new Map([
  [
    'lib/auth/workspace-guard.ts:authorizeItemWorkspace',
    {
      text:
        "{ let workspaceId = (opts.workspaceId || '').trim(); if (!workspaceId) { " +
        "workspaceId = (await workspaceIdOfItem(opts.itemId, opts.itemType)) || ''; " +
        'if (!workspaceId) return null;',
      reason:
        'the route id names NO item of that type anywhere in the estate, so there is no ' +
        "other tenant's resource to authorize. The lookup is a cross-partition query, not " +
        'an owner-scoped one, so an item belonging to a DIFFERENT tenant is still found ' +
        'and still reaches the delegation below. The pin covers the two assignments that ' +
        'produce `workspaceId`, because the ALLOW is only sound while its input is the ' +
        'unforged result of that lookup (N7).',
    },
  ],
  [
    'lib/auth/workspace-guard.ts:resolveAdminWorkspace',
    {
      text:
        '{ const session = getSession(); if (!session) { return { resp: NextResponse.json({ ' +
        "ok: false, error: '                ' }, { status: 401 }) }; } const c = await " +
        'workspacesContainer(); try { const { resource } = await c.item(workspaceId, ' +
        'session.claims.oid).read<Workspace>(); if (resource && resource.tenantId === ' +
        "session.claims.oid) { return { session, ws: resource, via: '     ' };",
      reason:
        'the OWNER fast path: a partition point-read on the CALLER’s own partition, ' +
        'admitted only when the document that comes back records the caller as its ' +
        'creator. No other tenant’s document can be returned by that read, so there ' +
        'is no tenant to compare. The pin covers the read and the equality test, because ' +
        'the ALLOW is only sound while both are exactly this.',
    },
  ],
]);

/**
 * POST-DELEGATION ALLOWS that are not the delegated verdict, pinned by their
 * exact governing PATH CONDITION, their return text, AND — `region` — the whole
 * masked span between the delegation call and the ALLOW, with a reason. An
 * authorizer with a second, independent grant path (an item-level share, say) is
 * legitimate — but it must be enumerated here, and any change to the conditions
 * that lead to it, or to the checks that stand in front of it, re-opens the
 * review.
 *
 * `region` IS ROUND 4, and it exists because the pin below asserted a boundary it
 * did not check. Its reason read "removing that boundary … is a red build", and
 * WIDENING the conditions was indeed a red build — but REMOVING the tid
 * comparison outright was not: an `if` block whose consequent is more than a
 * single return contributes nothing to a path condition, so deleting
 * `item-access.ts` 175-178 left both `cond` and `ret` byte-identical and the
 * guard exited 0. A guard whose exemption states as fact something it never
 * established is the same defect `deploy-integrity.md` R7 names, one level up.
 *
 * The cost is the same one PROLOGUE_PINS accepts and states: ANY edit inside a
 * pinned region fails this guard until it is re-pinned. The guard prints the
 * observed region verbatim when it does not match, so re-pinning is a paste and
 * a re-review, never a guess.
 */
const POST_DELEGATION_PINS = new Map([
  [
    'lib/auth/item-access.ts:resolveItemAccessByOid',
    [
      {
        cond: '!(!item) && !(wsAccess) && !(!multiUserAclEnabled()) && !(!grant.matched)',
        ret: "{ item, role: grant.canWrite ? '                ' : '          ', via: '          ', canWrite: grant.canWrite, }",
        region:
          "; if (wsAccess) { return { item, role: wsAccess.role, via: wsAccess.via === ' ' ? ' ' : ' ', " +
          'canWrite: wsAccess.canWrite, }; } if (!multiUserAclEnabled()) return null; ' +
          'const grant = await resolveItemGrant(itemId, oid, groups); if (!grant.matched) return null; ' +
          'if (tid) { const wsDoc = await readWorkspaceById(item.workspaceId); ' +
          'if (wsDoc?.tid && wsDoc.tid !== tid) return null; } ' +
          "return { item, role: grant.canWrite ? ' ' : ' ', via: ' ', canWrite: grant.canWrite, };",
        reason:
          'the ITEM-LEVEL grant path (the F6 "Grant people access" share). It is reached ' +
          'only when the workspace resolver has already DENIED, so it cannot be the ' +
          'delegated verdict — it is a second grant with its own tenant boundary, the ' +
          '`wsDoc.tid !== tid` refusal immediately above it. WHAT IS ACTUALLY ENFORCED, so ' +
          'the reason and the check agree: `cond` fails if the conditions that lead here are ' +
          'widened, `ret` fails if the grant itself changes, and `region` — the span from the ' +
          'end of the delegation call to the end of this return — fails if the tid ' +
          'comparison, the kill switch, or the grant lookup between them is edited or ' +
          'DELETED. Removing that boundary is therefore a red build in fact, not only in ' +
          'this sentence.',
      },
    ],
  ],
  [
    'lib/auth/workspace-role.ts:resolveWorkspaceRole',
    [
      {
        cond:
          '!(access) && !(!doc) && !(!sameTenantConfirmed(session.claims.tid, ' +
          '(doc as { tid?: string }).tid)) && !(!role)',
        ret: '{ workspace: doc, role }',
        region:
          '; if (access) return { workspace: access.workspace, role: await ' +
          'explicitRole(access.workspace, workspaceId, session) }; const doc = await ' +
          'readWorkspaceById(workspaceId); if (!doc) return { workspace: null, role: null }; ' +
          'if (!sameTenantConfirmed(session.claims.tid, (doc as { tid?: string }).tid)) ' +
          'return { workspace: null, role: null }; const role = await explicitRole(doc, ' +
          'workspaceId, session); if (!role) return { workspace: null, role: null }; ' +
          'return { workspace: doc, role };',
        reason:
          'the `workspace-permissions` ACL (#3840). It is a SECOND container, invisible to ' +
          '`resolveWorkspaceAccessByOid` (which reads `workspace-roles`), actively written by ' +
          '`/api/workspaces/[id]/permissions`, and a member added there holds no ' +
          "`workspace-roles` row — so delegating and STOPPING would have 404'd every one of " +
          'them, which is #3751 from the other side. It is reached only after the resolver ' +
          'REFUSED, so it cannot be the delegated verdict; it is a second grant with its own ' +
          'tenant boundary. WHAT IS ACTUALLY ENFORCED, so the reason and the check agree: ' +
          '`cond` fails if the conditions leading here are widened, `ret` fails if the grant ' +
          'changes, and `region` — the span from the end of the delegation call to the end of ' +
          'this return — fails if the `sameTenantConfirmed` POSITIVE match, the document read, ' +
          'or the explicit-grant requirement between them is edited or DELETED. That boundary ' +
          "is STRICTER than the resolver's step 4: an absent `tid` on either side refuses " +
          'here rather than falling through, which is the whole of #3840.',
      },
    ],
  ],
]);

const failures = [];
const fail = (msg) => failures.push(msg);
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// ── source masking ──────────────────────────────────────────────────────────
/**
 * The keywords after which a `/` can only begin a REGEX LITERAL, never a
 * division.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case',
  'do', 'else', 'yield', 'await', 'throw',
]);

/**
 * The punctuation after which a `/` begins a REGEX LITERAL. This is an
 * ALLOWLIST, and it is deliberately tighter than the textbook heuristic, because
 * this codebase is 4103 files of TSX and the textbook version is wrong there.
 *
 * MEASURED, and the reason the allowlist exists: an earlier round-5 draft used
 * "anything that is not a value" — the usual rule — and `</div>` then read as a
 * regex opening after `<`, ran to the next `/` on the same line and blanked the
 * JSX between them. It DROPPED 188 declarations relative to round 4, i.e. it
 * introduced a bigger version of the very defect it was written to remove. `<`,
 * `>`, `{` and `}` are all excluded for that reason: `<Foo {...p} />` and
 * `</div></span>` are common and a division after any of them is not.
 *
 * The one exception is an ARROW: `=> /re/.test(x)` is ordinary, and `>` is only
 * admitted when the character before it is `=`.
 *
 * Excluding a case here costs a MISS (the regex body is left unmasked, which is
 * round 4's behaviour and no worse), never a false blanking. That asymmetry is
 * why the list errs tight.
 */
const REGEX_PRECEDING_PUNCT = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', ';', '+', '-', '*', '%', '^', '~'],
);

/**
 * Does the `/` at `at` begin a REGEX LITERAL, or is it a division operator (or
 * JSX)? Decided from the last significant character BEFORE it, read out of the
 * ALREADY-MASKED prefix — so a `/` inside a comment or a string cannot be
 * mistaken for the preceding token.
 */
function startsRegexLiteral(out, at) {
  let k = at - 1;
  while (k >= 0 && /\s/.test(out[k])) k -= 1;
  if (k < 0) return true; // start of file
  const p = out[k];
  if (p === '>') {
    let j = k - 1;
    while (j >= 0 && /\s/.test(out[j])) j -= 1;
    return j >= 0 && out[j] === '='; // an arrow `=>`, never a JSX tag close
  }
  if (/[\w$]/.test(p)) {
    let s = k;
    while (s >= 0 && /[\w$]/.test(out[s])) s -= 1;
    const word = out.slice(s + 1, k + 1).join('');
    if (/^\d/.test(word)) return false; // a numeric literal -> division
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  return REGEX_PRECEDING_PUNCT.has(p);
}

/**
 * Blank out line comments, block comments, string/template literals AND THE BODY
 * OF REGEX LITERALS, preserving byte offsets (so index comparisons below stay
 * meaningful) and newlines (so line numbers stay right). A doc comment that says
 * "skipTidBoundary" must not look like a call site.
 *
 * REGEX LITERALS ARE ROUND 5, and they were a hole in every check downstream, not
 * a cosmetic one. `mask` had no regex case, so the `\/\/` inside
 *
 *     if (/^https?:\/\//i.test(workspaceId)) return NextResponse.json(…);
 *
 * — a line that already exists verbatim at `lib/azure/arm-client.ts:40` — read as
 * a `//` LINE COMMENT and the rest of the line was blanked, taking its closing
 * parens with it. MEASURED: adding an env-oid cross-tenant grant to
 * `authorizeWorkspace` exits 1; adding that ONE ORDINARY LINE above it exited 0,
 * and `authorizeWorkspace` was simply ABSENT from the derived `checked:` list.
 * The same mechanism accounts for 136 of the 137 declarations round 4's finder
 * change silently DROPPED while its net total went up (see 8h).
 *
 * A regex's DELIMITERS are kept and its interior blanked, exactly as for a string
 * — so `/[{]/`, `/'/` and `/\)/ ` can no longer unbalance a brace counter, open a
 * phantom string, or eat a closing paren.
 */
function mask(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      // Always a comment: an EMPTY regex literal is not legal JS (it is spelled
      // `/(?:)/`), so `//` can never open one.
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (two === '/*') {
      // Likewise always a comment: `*` is a quantifier with nothing to repeat.
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const q = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (src[i] === '/' && startsRegexLiteral(out, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = -1;
      for (; j < src.length; j += 1) {
        const c = src[j];
        if (c === '\\') { j += 1; continue; }
        if (c === '\n') break;               // unterminated -> not a regex after all
        if (inClass) { if (c === ']') inClass = false; continue; }
        if (c === '[') { inClass = true; continue; }
        if (c === '/') { closed = j; break; }
      }
      if (closed === -1) { i += 1; continue; } // division, or a syntax error
      blank(i + 1, closed);
      i = closed + 1;                          // the flags are ordinary word chars
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Brace-match a named function's body. Returns the masked body text, or null
 * when the function is absent (which the caller reports as a failure — a
 * renamed chokepoint must not silently pass).
 *
 * THE PARAMETER LIST IS SKIPPED EXPLICITLY, and that is load-bearing. This used
 * to take `indexOf('{', decl.index)` as the body brace, which is the FIRST brace
 * after the name — so a parameter carrying an inline object type
 * (`opts: { allowReadRoles?: boolean } = {}`, the exact signature of
 * `authorizeWorkspace`) made the "body" the type literal, one line long, and
 * every assertion over it either vacuous or wrong.
 */
function functionSpan(masked, name) {
  const decl = new RegExp(`function\\s+${name}\\s*[(<]`).exec(masked);
  if (!decl) return null;
  const paren = masked.indexOf('(', decl.index);
  if (paren === -1) return null;
  // 1) Balance the parameter list.
  let d = 0;
  let afterParams = -1;
  for (let i = paren; i < masked.length; i++) {
    if (masked[i] === '(') d += 1;
    else if (masked[i] === ')') {
      d -= 1;
      if (d === 0) { afterParams = i + 1; break; }
    }
  }
  if (afterParams === -1) return null;
  // 2) The body brace is the first `{` past the return-type annotation — i.e.
  //    the first one at angle-bracket depth ZERO, so `Promise<{ a: string }>`
  //    is not mistaken for it either.
  let ang = 0;
  let open = -1;
  for (let i = afterParams; i < masked.length; i++) {
    const c = masked[i];
    if (c === '<') ang += 1;
    else if (c === '>') { if (ang > 0) ang -= 1; }
    else if (c === '{' && ang === 0) { open = i; break; }
  }
  if (open === -1) return null;
  // 3) Balance the body.
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          declAt: decl.index,
          params: masked.slice(paren + 1, afterParams - 1),
          returnType: masked.slice(afterParams, open).replace(/^\s*:\s*/, '').trim(),
          bodyStart: open,
          bodyEnd: i + 1,
          body: masked.slice(open, i + 1),
        };
      }
    }
  }
  return null;
}

function functionBody(masked, name) {
  const s = functionSpan(masked, name);
  return s ? s.body : null;
}

/** The masked parameter list of a named function (between its outer parens). */
function signature(masked, name) {
  const s = functionSpan(masked, name);
  return s ? s.params : null;
}

/** Count TOP-LEVEL arguments of the call starting at `openParen`. */
function argCount(masked, openParen) {
  let depth = 0;
  let args = 0;
  let sawContent = false;
  for (let i = openParen; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return sawContent ? args + 1 : 0;
      continue;
    }
    if (depth === 1) {
      if (c === ',') { args += 1; continue; }
      if (!/\s/.test(c)) sawContent = true;
    }
  }
  return -1; // unbalanced
}

/** `[start, end)` of the balanced argument list of every `name(` call. */
function callArgSpans(masked, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = masked.indexOf('(', m.index);
    let depth = 0;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '(') depth += 1;
      else if (masked[i] === ')') {
        depth -= 1;
        if (depth === 0) { out.push([open, i + 1, m.index]); break; }
      }
    }
  }
  return out;
}

function callArgSpan(masked, name) {
  const all = callArgSpans(masked, name);
  return all.length > 0 ? [all[0][0], all[0][1]] : null;
}

/** Every index at which `re` matches, on already-masked source. */
function indicesOf(masked, re) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = g.exec(masked)) !== null) out.push(m.index);
  return out;
}

/**
 * `[start, end)` of a `type X = …;` declaration. Stops at the first semicolon at
 * brace depth ZERO — the members inside the union arms are semicolon-separated
 * too, so a naive indexOf(';') truncates the declaration after its first field
 * and makes the arm assertions below silently vacuous.
 */
function typeDeclarationSpan(masked, name) {
  const decl = new RegExp(`type\\s+${name}\\s*=`).exec(masked);
  if (!decl) return null;
  let depth = 0;
  for (let i = decl.index; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return [decl.index, i];
  }
  return [decl.index, masked.length];
}

/** The text of a `type X = …;` declaration. */
function typeDeclaration(masked, name) {
  const s = typeDeclarationSpan(masked, name);
  return s ? masked.slice(s[0], s[1]) : null;
}

/**
 * Ranges covered by `import …;` / `export … from '…';` statements, so a symbol
 * mentioned in an import list is not mistaken for a reference.
 */
function importRanges(masked) {
  const ranges = [];
  const re = /\b(?:import|export)\s+[^;()]*?;/g;
  let m;
  while ((m = re.exec(masked)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
      walk(p, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      acc.push(p.replaceAll('\\', '/'));
    }
  }
  return acc;
}

// ── 1..4: the chokepoint module itself ──────────────────────────────────────
const accessSrc = readFileSync(ACCESS_FILE, 'utf8');
const access = mask(accessSrc);

if (!/export\s+type\s+WorkspaceAccessOpts\s*=/.test(access)) {
  fail(`${ACCESS_FILE}: WorkspaceAccessOpts is gone — the options type IS the compiler enforcement.`);
} else {
  const arms = typeDeclaration(access, 'WorkspaceAccessOpts') ?? '';
  if (!/callerTid\s*:\s*string\s*\|\s*undefined/.test(arms)) {
    fail(`${ACCESS_FILE}: WorkspaceAccessOpts lost its REQUIRED \`callerTid\` arm.`);
  }
  if (/callerTid\s*\?\s*:/.test(arms.split('|')[1] ?? arms)) {
    fail(`${ACCESS_FILE}: \`callerTid\` became OPTIONAL on the enforcing arm — omitting it is then legal again, which is #2703.`);
  }
  if (!/skipTidBoundary\s*:\s*true/.test(arms) || !/skipTidBoundaryReason\s*:\s*string/.test(arms)) {
    fail(`${ACCESS_FILE}: the opt-out arm must be \`skipTidBoundary: true\` WITH \`skipTidBoundaryReason: string\` — a bypass has to state its reason.`);
  }
}

for (const fn of ['resolveWorkspaceAccessByOid', 'listAccessibleWorkspaces']) {
  const sig = signature(access, fn);
  if (sig === null) { fail(`${ACCESS_FILE}: ${fn} not found — the guard is pointed at the wrong symbol.`); continue; }
  if (!/opts\s*:\s*WorkspaceAccessOpts/.test(sig)) {
    fail(`${ACCESS_FILE}: ${fn} must take \`opts: WorkspaceAccessOpts\`.`);
  }
  if (/opts\s*:\s*WorkspaceAccessOpts\s*=/.test(sig)) {
    fail(`${ACCESS_FILE}: ${fn} gave \`opts\` a DEFAULT. That restores #2703 exactly: omitting the argument silently switches the tenant boundary off.`);
  }
}

const resolverBody = functionBody(access, 'resolveWorkspaceAccessByOid');
if (!resolverBody) {
  fail(`${ACCESS_FILE}: could not read the body of resolveWorkspaceAccessByOid.`);
} else {
  const tidAt = resolverBody.indexOf('effectiveCallerTid(');
  const compareAt = resolverBody.search(/wsDoc\.tid\s*!==\s*callerTid/);
  const aclAt = resolverBody.indexOf('resolveEffectiveRole(');
  const adminAt = resolverBody.indexOf('opts.tenantAdmin');
  if (tidAt === -1 || compareAt === -1) {
    fail(`${ACCESS_FILE}: resolveWorkspaceAccessByOid no longer compares the workspace tid against effectiveCallerTid() — the boundary is gone.`);
  } else {
    if (aclAt !== -1 && compareAt > aclAt) {
      fail(`${ACCESS_FILE}: the tid boundary runs AFTER the ACL grant — a cross-tenant caller would already hold a role by then.`);
    }
    if (adminAt !== -1 && compareAt > adminAt) {
      fail(`${ACCESS_FILE}: the tid boundary runs AFTER the admin-open bypass.`);
    }
  }
}

const effBody = functionBody(access, 'effectiveCallerTid');
if (!effBody) {
  fail(`${ACCESS_FILE}: effectiveCallerTid is gone — nothing resolves the caller tenant.`);
} else if (!/opts\.callerTid\s*\?\?\s*\(?\s*await\s+ambientCallerTid\(/.test(effBody)) {
  fail(`${ACCESS_FILE}: effectiveCallerTid must fall back to ambientCallerTid() when the call site had no tid. Without it every session-less helper skips the boundary again (#2703).`);
}

const ambientBody = functionBody(access, 'ambientCallerTid');
if (!ambientBody) {
  fail(`${ACCESS_FILE}: ambientCallerTid is gone.`);
} else if (!/claims\.oid\s*!==\s*oid/.test(ambientBody)) {
  fail(`${ACCESS_FILE}: ambientCallerTid must only borrow the request session's tid when its oid MATCHES the principal being resolved — otherwise it attributes one user's tenant to another.`);
}

// ── 5..6: call sites ────────────────────────────────────────────────────────
/**
 * WHERE `skipTidBoundary` MAY BE NAMED INSIDE THE CHOKEPOINT MODULE ITSELF: the
 * type that DECLARES the opt-out, and the one function that READS it. Nowhere
 * else in that file — the module also BUILDS options for other callers.
 *
 * ROUND 4 — SECTION 6 USED TO EXEMPT THE WHOLE FILE (`file !== ACCESS_FILE`), and
 * then the report affirmatively said there were none. Measured: making
 * `ambientAccessOptsFor` return `{ skipTidBoundary: true, … }` produced
 *
 *     guarded call sites: 27  (skipTidBoundary users: 0, allowlisted: 0)
 *     OK — the tenant boundary is required at every call site.        exit 0
 *
 * with a live opt-out in the file. That helper is not a private detail: it builds
 * the options for the WHOLE oid-only population — `app/api/items/_lib/item-crud.ts`,
 * `lib/azure/pipeline-binding.ts`, `app/api/cosmos-items/[type]/route.ts` — so one
 * line there switches the cross-tenant boundary off for every one of them, and
 * the guard printed a zero over it. A count that reads 0 with a live instance is
 * worse than no count: it is the guard asserting something it never checked (R7).
 */
function accessFileExemptRanges(masked) {
  const ranges = [];
  const t = typeDeclarationSpan(masked, 'WorkspaceAccessOpts');
  if (t) ranges.push(t);
  const f = functionSpan(masked, 'effectiveCallerTid');
  if (f) ranges.push([f.declAt, f.bodyEnd]);
  return ranges;
}

const ACCESS_FILE_POSIX = ACCESS_FILE.replaceAll('\\', '/');
const files = SCAN_DIRS.flatMap((d) => walk(d));
let callSites = 0;
const skipUsers = [];
const used = new Set();

for (const file of files) {
  const rel = file.slice(CONSOLE_ROOT.length + 1);
  const src = readFileSync(file, 'utf8');
  if (!GUARDED_CALLS.some(([n]) => src.includes(n)) && !src.includes('skipTidBoundary')) continue;
  const masked = mask(src);
  const imports = importRanges(masked);
  const inImport = (_s, idx) => imports.some(([a, b]) => idx >= a && idx < b);

  for (const [name, minArgs] of GUARDED_CALLS) {
    // EVERY mention of the identifier is classified. An earlier version matched
    // only `name(` and was demonstrated to pass
    // `await (resolveWorkspaceAccessByOid as any)(oid, ws)` — a real bypass that
    // drops the options argument while type-checking.
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let m;
    while ((m = re.exec(masked)) !== null) {
      if (inImport(masked, m.index)) continue;
      const after = masked.slice(m.index + name.length);
      const callAt = /^\s*\(/.test(after) ? masked.indexOf('(', m.index + name.length) : -1;
      const before = masked.slice(Math.max(0, m.index - 40), m.index);
      const isDeclaration = /\bfunction\s*$/.test(before);
      const line = masked.slice(0, m.index).split('\n').length;

      if (callAt === -1) {
        fail(`${rel}:${line}: ${name} is referenced INDIRECTLY (cast, alias or re-export). The guard cannot prove the tenant-boundary options argument is passed — call it directly.`);
        continue;
      }
      if (isDeclaration) continue;
      const n = argCount(masked, callAt);
      if (n === -1) continue;
      callSites += 1;
      if (n < minArgs) {
        fail(`${rel}:${line}: ${name}() called with ${n} argument(s) — the tenant-boundary options argument is missing.`);
      }
    }
  }

  // Every MENTION of the opt-out is located, and only the two places in the
  // chokepoint module that must name it — the type declaration and the reader —
  // are exempt. The exemption is a RANGE, not a filename.
  const exempt = file === ACCESS_FILE_POSIX ? accessFileExemptRanges(masked) : [];
  const skipHits = indicesOf(masked, /\bskipTidBoundary\b/).filter(
    (i) => !exempt.some(([a, b]) => i >= a && i < b),
  );
  if (skipHits.length > 0) {
    skipUsers.push(rel);
    if (SKIP_ALLOWLIST.has(rel)) used.add(rel);
    else {
      const line = masked.slice(0, skipHits[0]).split('\n').length;
      fail(
        `${rel}:${line}: uses skipTidBoundary — the ONLY way to switch the cross-tenant ` +
          'boundary off. Add it to SKIP_ALLOWLIST in this guard WITH the reason, or pass ' +
          '`callerTid` instead.' +
          (file === ACCESS_FILE_POSIX
            ? ' Inside the chokepoint module only the `WorkspaceAccessOpts` declaration and ' +
              '`effectiveCallerTid` may name it; everything else in this file — including the ' +
              'helpers that BUILD options for other callers — is a call site like any other.'
            : ''),
      );
    }
  }
}

// ── 7: listAllOwnedItems can enforce it ─────────────────────────────────────
const crud = mask(readFileSync(ITEM_CRUD_FILE, 'utf8'));
const listAllSig = signature(crud, 'listAllOwnedItems');
if (listAllSig === null) {
  fail(`${ITEM_CRUD_FILE}: listAllOwnedItems not found.`);
} else if (!/session\s*\?\s*:\s*SessionPayload/.test(listAllSig)) {
  fail(`${ITEM_CRUD_FILE}: listAllOwnedItems must accept a session (#2703) — it backs the Copilot item_list tool and without one it can never enforce the tenant boundary.`);
}

// ════════════════════════════════════════════════════════════════════════════
// 8: EVERY WORKSPACE AUTHORIZER DELEGATES, AND EVERY ALLOW IS THE DELEGATED
//    VERDICT (#3825)
// ════════════════════════════════════════════════════════════════════════════
//
// 8.0 — WHY THIS IS SHAPED THE WAY IT IS.
//
// Round 2 of this section named two authorizers in a table, matched the bypass
// by STRUCTURE rather than by literal, and required an ALLOW's condition to
// MENTION the delegated verdict. An independent review then defeated it ten
// ways in a single pass, and all ten reduce to one sentence: THE GUARD KEYED ON
// SHAPES IT COULD NAME. So the three naming decisions are gone:
//
//   * WHO is checked is DERIVED, not listed (8a). `authorizeWorkspaceList` was a
//     workspace authorizer named in `workspace-guard.ts`'s own docblock, absent
//     from the table, and it took the literal #3825 bypass at exit 0 (N10). Two
//     new authorizers added INSIDE the named module escaped the same way (N6a),
//     and one of them escaped a second time because the signature filter wanted
//     the token `workspace` and the parameter was called `id` (N6c).
//
//   * WHAT COUNTS AS AN ALLOW is derived from the function's own return type,
//     and covers ternaries. `/\breturn\s+null\b/` did not see
//     `return <env-oid check> ? null : …` (N5), and it models only ONE of the
//     two conventions in this codebase — `workspace-guard.ts` ALLOWs with `null`
//     while `workspace-list-access.ts` ALLOWs with a non-null value, so the
//     `return null` model found nothing to look at in the latter (N10).
//
//   * WHETHER AN ALLOW FOLLOWS FROM THE VERDICT is decided by BOOLEAN
//     IMPLICATION, not by a substring search. "The condition mentions the
//     binding" is satisfied vacuously by a disjunction:
//     `if (!denied || opts.itemType === 'lakehouse') return null;` mentions
//     `denied` and discards it (N1), as does an env-oid disjunct (N2) and a
//     one-hop helper call (N4b). The test now asks the only question that
//     matters: CAN THIS ALLOW FIRE WHILE THE DELEGATE SAID NO? If yes, it fails.
//
// KNOWN LIMITS, stated rather than implied:
//   - `return` statements are attributed to the nearest enclosing NAMED function,
//     so a `return` inside a nested arrow function (a `.map` callback) is read as
//     the outer function's. That direction is STRICT (a false positive), never
//     permissive.
//   - the guard-clause negation that builds a path condition only credits
//     `if (C) return …;` whose consequent is a SINGLE unconditional return, and
//     only at the function body's top level. Crediting less makes a path
//     condition WEAKER and the check STRICTER — again the safe direction.
//   - the derivation is scoped to `lib/auth/**`. A workspace authorizer written
//     somewhere else entirely is covered only by 8h's repo-wide shape scan, whose
//     own limits are recorded on it.
//   - ROUND 4: the derivation used to see `export function` DECLARATIONS only, so
//     all four triggers above were dodged by writing the authorizer as
//     `export const f = async (…) => {…}` — measured at exit 0 with the
//     byte-identical `export async function` at exit 1. The declaration finder now
//     covers arrows (block and concise bodies), `= function`, methods, an
//     anonymous default export, and an arrow whose return type is declared on the
//     const rather than the arrow. The residual shapes it still does not span are
//     recorded on 8h, which shares the finder.

/**
 * The span of a CALLABLE whose head begins at `headAt` — the `function` keyword,
 * or the parameter list of an arrow. Handles `async`, generics, the return-type
 * annotation, a block body and an expression body. `declAt` is where the
 * DECLARATION starts, so a reported line number points at the export.
 *
 * Returns the same shape `functionSpan` does, plus `exprBody`: the text of a
 * concise arrow body (`=> expr`), which has no `return` token for
 * `returnStatements` to find. Callers enumerate a callable's returns through
 * {@link bodyReturns} so that form is not silently empty.
 */
function callableSpan(masked, declAt, headAt, allowArrow) {
  let i = headAt;
  const skipWs = () => { while (i < masked.length && /\s/.test(masked[i])) i += 1; };
  const word = (w) => masked.startsWith(w, i) && !/[\w$]/.test(masked[i + w.length] ?? '');
  skipWs();
  if (word('async')) { i += 5; skipWs(); }
  let sawFunctionKeyword = false;
  if (word('function')) {
    sawFunctionKeyword = true;
    i += 8;
    skipWs();
    if (masked[i] === '*') { i += 1; skipWs(); }
    const nm = /^[A-Za-z_$][\w$]*/.exec(masked.slice(i));
    if (nm) { i += nm[0].length; skipWs(); }
  }
  if (masked[i] === '<') {           // generic parameter list
    let ang = 0;
    for (; i < masked.length; i += 1) {
      if (masked[i] === '<') ang += 1;
      else if (masked[i] === '>') { ang -= 1; if (ang === 0) { i += 1; break; } }
    }
    skipWs();
  }
  if (masked[i] !== '(') return null;
  const paren = i;
  let d = 0;
  let afterParams = -1;
  for (let k = paren; k < masked.length; k += 1) {
    if (masked[k] === '(') d += 1;
    else if (masked[k] === ')') { d -= 1; if (d === 0) { afterParams = k + 1; break; } }
  }
  if (afterParams === -1) return null;
  const params = masked.slice(paren + 1, afterParams - 1);

  // WHAT FOLLOWS THE PARAMETER LIST DECIDES THE FORM — a `=>` (arrow) or a `{`
  // (a `function` declaration/expression, or a METHOD, which carries no keyword
  // at all). Keying on the `function` KEYWORD instead was measured wrong: an
  // object-literal method has none, so it fell into the arrow branch, found no
  // `=>`, and returned null.
  //
  // `=>` IS ONLY CONSIDERED WHERE AN ARROW IS SYNTACTICALLY POSSIBLE — i.e. after
  // a `const NAME =` and not after the `function` keyword. Also measured: with
  // `=>` accepted everywhere, a RETURN TYPE that is itself a function type ate
  // the parse. `function install(): () => void {` and
  // `export function createConcurrencyLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {`
  // both took the arrow branch, so their real bodies were never spanned — 17
  // declarations the head finder saw would have been dropped, which is exactly
  // the regression this whole section is meant to remove.
  //
  // A `;`, `,` or an unbalanced `)` first means this is NOT a callable
  // declaration — a TypeScript overload signature, or an ordinary CALL that
  // merely looks like a method head. That bound is what makes the method pattern
  // safe to match at all: without it the scan runs on and adopts the next
  // unrelated block as the "body".
  const arrowOk = allowArrow && !sawFunctionKeyword;
  let ang = 0;
  let pd = 0;
  let arrowAt = -1;
  let open = -1;
  for (let k = afterParams; k < masked.length; k += 1) {
    const c = masked[k];
    if (arrowOk && c === '=' && masked[k + 1] === '>' && ang === 0 && pd === 0) { arrowAt = k; break; }
    if (c === '{' && ang === 0 && pd === 0) { open = k; break; }
    if (c === '(' || c === '[' || c === '{') pd += 1;
    else if (c === ')' || c === ']' || c === '}') { if (pd === 0) return null; pd -= 1; }
    else if (c === '<') ang += 1;
    else if (c === '>') { if (ang > 0) ang -= 1; }
    else if ((c === ';' || c === ',') && ang === 0 && pd === 0) return null;
  }

  if (arrowAt === -1) {
    if (open === -1) return null;
    const end = matchingClose(masked, open);
    if (end === -1) return null;
    return {
      declAt,
      params,
      returnType: masked.slice(afterParams, open).replace(/^\s*:\s*/, '').trim(),
      bodyStart: open,
      bodyEnd: end + 1,
      body: masked.slice(open, end + 1),
      exprBody: null,
    };
  }

  const returnType = masked.slice(afterParams, arrowAt).replace(/^\s*:\s*/, '').trim();
  let k = arrowAt + 2;
  while (k < masked.length && /\s/.test(masked[k])) k += 1;
  if (masked[k] === '{') {
    const end = matchingClose(masked, k);
    if (end === -1) return null;
    return {
      declAt, params, returnType,
      bodyStart: k, bodyEnd: end + 1, body: masked.slice(k, end + 1), exprBody: null,
    };
  }
  // Concise body — everything up to the `;` (or the closing bracket of whatever
  // encloses the declaration) at depth zero.
  let d2 = 0;
  let end = masked.length;
  for (let x = k; x < masked.length; x += 1) {
    const c = masked[x];
    if (c === '(' || c === '[' || c === '{') d2 += 1;
    else if (c === ')' || c === ']' || c === '}') { if (d2 === 0) { end = x; break; } d2 -= 1; }
    else if (c === ';' && d2 === 0) { end = x; break; }
  }
  return {
    declAt, params, returnType,
    bodyStart: k, bodyEnd: end, body: masked.slice(k, end), exprBody: masked.slice(k, end).trim(),
  };
}

/**
 * The return type of an arrow whose annotation lives on the CONST rather than on
 * the arrow itself — `const f: PickerFn = async (…) => {…}` declares no return
 * type at the arrow, so reading only the arrow yields `''`, `VERDICT_RETURN`
 * fails on the empty string, and the candidate is dropped before any of 8a's
 * triggers run. MEASURED: that exact shape exited 0 with a live env-oid grant in
 * it. Resolves a bare alias to its declaration and takes the part after the
 * function type's `=>`; falls back to the whole annotation, which
 * `VERDICT_RETURN` then reads generously — the direction this guard prefers.
 */
function returnTypeFromAnnotation(masked, annotation) {
  const t = expandReturnType(masked, (annotation || '').trim());
  const arrow = /=>\s*([\s\S]+)$/.exec(t);
  return (arrow ? arrow[1] : t).trim();
}

/** Keywords that can appear in an `export default <expr>` and are not names. */
const DEFAULT_EXPORT_NON_NAMES = new Set([
  'async', 'function', 'await', 'new', 'typeof', 'void', 'as', 'satisfies',
  'class', 'extends', 'null', 'undefined', 'true', 'false', 'this', 'super',
]);

/**
 * The LOCAL names a module exports SOMEWHERE OTHER THAN ON THE DECLARATION — a
 * separate `export { … }` list, or an `export default <expr>;` that names them.
 *
 * Keying on the adjacent keyword alone was measured to miss
 * `const f = async (…) => {…}; export { f };` — the declaration and its export
 * are simply in two places, and section 8a then never derived it as a candidate.
 * Found by this file's own author against the round-4 fix, because a fix that has
 * only survived the review's list has survived a list. Both the local name and an
 * `as` alias are recorded; a name that matches no local declaration (a re-export
 * `export { x } from './y'`) simply never matches one.
 *
 * ROUND 5 — `export default <ident>;` IS A THIRD SPELLING, and the round-4
 * docblock's claim that "exported is the union of BOTH spellings" was therefore
 * an R7 defect in this file: it stated a completeness the code did not have.
 * MEASURED, the same env-oid grant in `lib/auth`:
 *
 *     export async function f(…)                            exit 1
 *     export const f = async (…) => {…}                (R3b) exit 1
 *     const f = …; export { f };                       (R6)  exit 1
 *     async function f(…) {…}      + export default f;       exit 0
 *     const f = async (…) => {…}   + export default f;       exit 0
 *
 * — including inside `workspace-guard.ts` itself. EVERY identifier named in the
 * default-export expression is recorded, not only a bare one, so
 * `export default withAudit(f);` and `export default { GET, POST };` also count.
 * That is deliberately generous: a name recorded here only ever ADDS a candidate,
 * and only if it also matches a local callable declaration.
 */
function exportedNames(masked) {
  const names = new Set();
  const re = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const local = /^(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(t);
      if (local) names.add(local[1]);
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(t);
      if (alias) names.add(alias[1]);
    }
  }
  // `export default <expr>;` — every identifier in the exported expression. A
  // `default` that carries its own declaration (`export default function f(){}`,
  // `export default async (…) => {}`) is NOT this shape: branch 1 / branch 2 of
  // `callableDeclarations` already see the `export` keyword sitting on it, and
  // the keyword scan below stops the head-word from being recorded as a name.
  const dRe = /export\s+default\s+/g;
  while ((m = dRe.exec(masked)) !== null) {
    let d = 0;
    let end = masked.length;
    for (let i = m.index + m[0].length; i < masked.length; i += 1) {
      const c = masked[i];
      if (c === '(' || c === '[' || c === '{') d += 1;
      else if (c === ')' || c === ']' || c === '}') { if (d === 0) { end = i; break; } d -= 1; }
      else if (c === ';' && d === 0) { end = i; break; }
    }
    const expr = masked.slice(m.index + m[0].length, end);
    if (/^\s*(?:async\s+)?function\b/.test(expr) || /=>/.test(expr)) continue; // its own declaration
    for (const id of expr.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (!DEFAULT_EXPORT_NON_NAMES.has(id)) names.add(id);
    }
  }
  return names;
}

/**
 * Tokens that look like a method head (`name(`) but open a STATEMENT. Without
 * this the method pattern below would read `if (…) { … }` as a function called
 * `if`. Every one of these is a keyword that can be followed by `(`.
 */
const NOT_A_METHOD_NAME = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'void',
  'delete', 'await', 'yield', 'new', 'do', 'else', 'case', 'throw', 'in', 'of',
  'function', 'const', 'let', 'var', 'class', 'interface', 'type', 'enum',
  'import', 'export', 'default', 'extends', 'implements', 'as', 'is', 'satisfies',
]);

/**
 * The FIRST callable nested inside an initializer that is not itself a callable —
 * i.e. the arrow in `const f = withAudit(async (…) => {…})`.
 *
 * ROUND 5. Branch 2 of {@link callableDeclarations} required the head to sit
 * directly after the `=`, and an independent review measured the cost:
 * `export const authorizeWorkspacePicker = withAudit(async (…) => {…})` carrying
 * an env-oid cross-tenant grant exited 0, undisclosed. A wrapper is an ordinary
 * way to write a route authorizer (audit, rate-limit, telemetry), so "it was not
 * directly after the `=`" is exactly the kind of shape-naming this section keeps
 * being defeated by.
 *
 * SCOPED TO MODULE-LEVEL DECLARATIONS, and that bound is measured rather than
 * stylistic. Applied at every brace depth it turned `const rows = useMemo(() =>
 * …, [])` and every `.map(x => …)` bound to a local into a "declaration" named
 * after the local: the census went 21933 -> 34357 rows, and 79 keys that round 4
 * had went missing (13 more than the module-level version drops) because `push`
 * dedupes by body position and the enclosing const claimed it first. That is the
 * same total-up / coverage-down shape this round exists to remove, so it was
 * rejected. An authorizer is a module-level export; a `useMemo` inside a
 * component is not. Bounded to depth 0 the census is 22653 rows / 22310 unique.
 *
 * WHAT THE BOUNDED VERSION COSTS AGAINST ROUND 4, in full: 66 keys, and every one
 * is a round-4 artefact rather than a loss. 56 of them are literally named
 * `async` — round 4's METHOD pattern matched the `async` in
 * `export const POST = withWorkspaceOwner(TYPE, async (req) => {…})` as an
 * identifier and recorded the arrow under that name; branch 2b now claims the
 * same body first under the REAL exported name, so
 * `app/api/transform/[id]/run/route.ts :: async` is now `:: POST`. That is 56
 * exported route handlers going from mis-named to named. The other 10 are the
 * regex-masking false positives listed on 8h.
 *
 * Heads are tried only where one can syntactically begin — after a `(` or a `,`
 * of a CALL (the `,` matters: `withWorkspaceOwner(TYPE, async (…) => {…})` is the
 * live shape in this repo) — and only inside this initializer, bounded by the `;`
 * at depth zero and by {@link WRAPPED_HEAD_BUDGET} attempts so a pathological
 * line cannot make this quadratic. Returns null when nothing parses, which leaves
 * the declaration exactly where round 4 left it.
 *
 * STILL OPEN, so it is not read as closed: a wrapped arrow bound to a LOCAL
 * inside another function, and a wrapper whose callable argument sits past the
 * budget.
 */
const WRAPPED_HEAD_BUDGET = 24;
function wrappedCallable(masked, declAt, from) {
  let d = 0;
  let end = masked.length;
  for (let i = from; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') { if (d === 0) { end = i; break; } d -= 1; }
    else if (c === ';' && d === 0) { end = i; break; }
  }
  let tried = 0;
  for (let i = from; i < end && tried < WRAPPED_HEAD_BUDGET; i += 1) {
    if (masked[i] !== '(' && masked[i] !== ',') continue;
    let k = i + 1;
    while (k < end && /\s/.test(masked[k])) k += 1;
    if (k >= end) break;
    tried += 1;
    const span = callableSpan(masked, declAt, k, true);
    if (span && span.bodyEnd <= end + 1) return span;
  }
  return null;
}

/**
 * Every function-valued DECLARATION in a module: `function f`, `const f = () =>`,
 * `const f = async function`, an object-literal / class METHOD, an anonymous
 * `export default function`, and the `let` / `var` forms — with its parameter
 * list, return-type annotation and body span. `exportedOnly` restricts it to the
 * `export`ed ones (a method reached through an exported object counts, because
 * the object is the export).
 *
 * THE DECLARATION FORM USED TO BE THE FILTER, AND THAT WAS A HOLE — measured, not
 * anticipated. This read `/export\s+(?:async\s+)?function\s+/`, so an
 * `export const authorizeWorkspacePicker = async (…) => { …env-oid grant… }`
 * appended to `workspace-list-access.ts` exited 0 while the BYTE-IDENTICAL body
 * written as `export async function` exited 1. Because the declaration-form
 * filter ran FIRST, none of section 8a's four "independent triggers" — module,
 * admin-flag, signature — ever got the chance to fire: the candidate was dropped
 * before they were consulted, so all four were dodged by a keyword. SIX more
 * spellings of the same body were then measured at exit 0 on the same tree: a
 * concise arrow body, an arrow behind a declared function type,
 * `= async function (…)`, an object-literal method, an anonymous
 * `export default function`, and the 8h repo-wide variant of all of them.
 */
function callableDeclarations(masked, exportedOnly) {
  const out = [];
  const seen = new Set();
  // "Exported" is the union of ALL THREE spellings — the keyword on the
  // declaration, a separate `export { … }` list, and an `export default <expr>;`
  // that names the local — so a declaration cannot escape 8a by moving its export
  // one line down. Round 4's version of this comment said "BOTH spellings"; there
  // were three, and `export default f;` was measured at exit 0 with a live
  // env-oid grant, in `lib/auth` and in `workspace-guard.ts` itself.
  const listed = exportedOnly ? exportedNames(masked) : null;
  const isExported = (kw, name) => !exportedOnly || Boolean(kw) || listed.has(name);
  const push = (name, span, declaredType) => {
    if (!span || seen.has(span.bodyStart)) return;
    seen.add(span.bodyStart);
    if (!span.returnType && declaredType) {
      span.returnType = returnTypeFromAnnotation(masked, declaredType);
    }
    out.push({ name, ...span });
  };
  // 1) `function NAME(` / `async function NAME(`, and the anonymous
  //    `export default (async )?function(`. Never an arrow.
  const fnRe = /(^|[^\w$.])(export\s+(?:default\s+)?)?(?:async\s+)?function\s*(\*\s*)?([A-Za-z_$][\w$]*)?\s*[(<]/g;
  let m;
  while ((m = fnRe.exec(masked)) !== null) {
    if (!m[4] && !/default/.test(m[2] ?? '')) continue; // an anonymous fn expression; branch 2 owns it
    const name = m[4] ?? 'default';
    if (!isExported(m[2], name)) continue;
    const declAt = m.index + m[1].length;
    push(name, callableSpan(masked, declAt, declAt + (m[2] ? m[2].length : 0), false), null);
  }
  // 2) `const NAME = (…) =>` / `const NAME: T = async function` and the let/var
  //    forms — the ONE place an arrow is syntactically possible. The optional type
  //    annotation is captured (not merely skipped) so a declared handler type can
  //    supply the return type the arrow omits, and the `=>` alternative inside it
  //    lets an INLINE function type annotation (`const f: (a: X) => Y = …`) reach
  //    its `=` rather than stopping at the arrow's. The `=` is required not to be
  //    an arrow's own (`=(?!>)`), and the annotation is length-bounded and
  //    newline-free so a pathological line cannot make this backtrack.
  const cRe =
    /(^|[^\w$.])(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::((?:[^=;\n]|=>){0,200}))?=(?!>)\s*/g;
  // Brace depth at each match, maintained by a single forward scan — the matches
  // arrive in increasing index order, so this stays O(module length). Depth is
  // what bounds the wrapper branch below to MODULE-LEVEL declarations.
  let scanAt = 0;
  let braceDepth = 0;
  while ((m = cRe.exec(masked)) !== null) {
    if (!isExported(m[2], m[3])) continue;
    const declAt = m.index + m[1].length;
    for (; scanAt < declAt; scanAt += 1) {
      if (masked[scanAt] === '{') braceDepth += 1;
      else if (masked[scanAt] === '}') braceDepth -= 1;
    }
    const headAt = m.index + m[0].length;
    const direct = callableSpan(masked, declAt, headAt, true);
    // 2b) ROUND 5 — `const NAME = wrap(async (…) => {…})`, an arrow handed to a
    //     WRAPPER / HOF. This branch required the callable head to sit DIRECTLY
    //     after the `=`, so `export const authorizeWorkspacePicker =
    //     withAudit(async (…) => {…})` with a live env-oid grant in it exited 0 —
    //     the same "the declaration FORM was the filter" defect round 4 removed
    //     one spelling at a time. Only reached when the direct parse FAILED and
    //     only at module level (see {@link wrappedCallable} for why), so nothing
    //     that already parsed changes shape.
    push(m[3], direct ?? (braceDepth === 0 ? wrappedCallable(masked, declAt, headAt) : null), m[4] ?? null);
  }
  // 3) Object-literal and class METHODS — `async authorize(…): T { … }`. Only
  //    heads that open a line or follow `{` / `,` / `;` / `}` are considered, the
  //    JS statement keywords are excluded by name, and `callableSpan` refuses
  //    anything whose parameter list is not followed by a body brace before the
  //    next `;` / `)` / `,` — which is what keeps an ordinary CALL out. Never an
  //    arrow. `exportedOnly` is not applied: a method's reachability is its
  //    object's, and treating an un-exported-looking method as a candidate is the
  //    strict direction.
  const mRe =
    /(^|[\n{,;}])(\s*)((?:(?:public|private|protected|static|readonly|get|set)\s+)*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?=[(<])/g;
  while ((m = mRe.exec(masked)) !== null) {
    if (NOT_A_METHOD_NAME.has(m[4])) continue;
    const declAt = m.index + m[1].length;
    push(m[4], callableSpan(masked, declAt, m.index + m[0].length, false), null);
  }
  out.sort((a, b) => a.declAt - b.declAt);
  return out;
}

/** Every exported function-valued declaration in a module, with its return type. */
function exportedFunctions(masked) {
  return callableDeclarations(masked, true);
}

/** Every function-valued declaration (exported or not), for the module-wide scans. */
function declaredFunctions(masked) {
  return callableDeclarations(masked, false);
}

/**
 * The `return` statements of a CALLABLE. A concise arrow body (`=> expr`) has no
 * `return` token, so `returnStatements` over it finds nothing and every ALLOW in
 * it would read as absent; it is presented here as the single implicit return it
 * is. Use this wherever a FUNCTION's returns are enumerated; `returnStatements`
 * stays the primitive for a raw block of statements.
 */
function bodyReturns(fn) {
  if (fn.exprBody) return [{ index: 0, end: fn.exprBody.length, expr: fn.exprBody }];
  return returnStatements(fn.body);
}

/** `Promise<X>` -> `X`; a bare local type alias -> its declaration text. */
function expandReturnType(masked, retType) {
  let t = (retType || '').trim();
  const p = /^Promise\s*<([\s\S]*)>$/.exec(t);
  if (p) t = p[1].trim();
  if (/^[A-Za-z_$][\w$]*$/.test(t)) {
    const decl = typeDeclaration(masked, t);
    if (decl) return decl;
  }
  return t;
}

// ── boolean condition model ────────────────────────────────────────────────
/**
 * The index of the bracket that closes the one at `from`, counting ONLY that
 * bracket's own kind.
 *
 * ROUND 5 — THIS USED TO COUNT `(`, `[` AND `{` IN ONE COUNTER, and that made a
 * single unbalanced paren delete a whole function from the derivation. `mask`
 * had no regex-literal case, so `/^https?:\/\//` read as a `//` comment and the
 * rest of that line was blanked, taking its `)` with it; the one counter then hit
 * -1, `matchingClose` returned -1, `callableSpan` returned null, and
 * `authorizeWorkspace` VANISHED from section 8 with the guard still printing OK.
 * `functionSpan` (step 3) has always balanced BRACES ONLY and was unaffected by
 * the same line — the proven-correct behaviour this now matches.
 *
 * Counting per kind is also strictly more robust than mixed counting in general:
 * mixed counting is only ever correct when brackets nest perfectly, which is
 * exactly the property mangled source does not have.
 */
const CLOSER_OF = { '(': ')', '[': ']', '{': '}' };
function matchingClose(s, from) {
  const open = s[from];
  const close = CLOSER_OF[open];
  if (!close) return -1;
  let d = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === open) d += 1;
    else if (c === close) { d -= 1; if (d === 0) return i; }
  }
  return -1;
}

/** Split `t` on a 2-char operator at bracket depth ZERO. */
function splitTop(t, op) {
  const parts = [];
  let d = 0;
  let last = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') d -= 1;
    else if (d === 0 && t.startsWith(op, i)) { parts.push(t.slice(last, i)); i += op.length - 1; last = i + 1; }
  }
  parts.push(t.slice(last));
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** True when `t` carries a ternary at bracket depth zero (we refuse to model it). */
function hasTopTernary(t) {
  let d = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') d -= 1;
    else if (d === 0 && c === '?' && t[i + 1] !== '?' && t[i + 1] !== '.' && t[i - 1] !== '?') return true;
  }
  return false;
}

/**
 * Parse a masked condition into a boolean tree over ATOMS. Anything the parser
 * cannot model becomes `{ opaque }`, which is treated as FREE — i.e. it can be
 * true, which makes the ALLOW look reachable and the check STRICTER.
 */
function boolTree(text) {
  let t = (text || '').trim();
  while (t.startsWith('(') && matchingClose(t, 0) === t.length - 1) t = t.slice(1, -1).trim();
  if (!t) return { opaque: '' };
  const or = splitTop(t, '||');
  if (or.length > 1) return { or: or.map(boolTree) };
  const and = splitTop(t, '&&');
  if (and.length > 1) return { and: and.map(boolTree) };
  if (t[0] === '!' && t[1] !== '=') return { not: boolTree(t.slice(1)) };
  if (hasTopTernary(t)) return { opaque: t };
  return { atom: t };
}

/**
 * The truth value an atom takes WHEN THE DELEGATE DENIED, or null when the guard
 * cannot say (which is treated as free, i.e. the ALLOW stays reachable and the
 * check fails). `denyPin` is the truthiness of the BINDING itself under a denial:
 * `true` for an authorizer whose delegate returns a REFUSAL object (`denied`),
 * `false` for one whose delegate returns an ACCESS object (`access`).
 *
 * This is B1's "compare against a closed set". Everything outside the set is a
 * free atom and therefore a failure that needs a human — never a silent pass.
 */
function verdictAtomTruth(atom, binding, denyPin) {
  const b = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const t = atom.trim();
  if (new RegExp(`^${b}$`).test(t)) return denyPin;
  if (new RegExp(`^${b}\\s*(?:===|==)\\s*(?:null|undefined)$`).test(t)) return !denyPin;
  if (new RegExp(`^(?:null|undefined)\\s*(?:===|==)\\s*${b}$`).test(t)) return !denyPin;
  if (new RegExp(`^${b}\\s*(?:!==|!=)\\s*(?:null|undefined)$`).test(t)) return denyPin;
  if (new RegExp(`^(?:null|undefined)\\s*(?:!==|!=)\\s*${b}$`).test(t)) return denyPin;
  if (new RegExp(`^${b}\\s*\\??\\.[\\w$.?]+$`).test(t)) return denyPin;
  return null; // an unmodelled use of the verdict — free, so the ALLOW fails
}

/** `{ t, f }` — can this node be true / be false, under the DENY pinning? */
function canBe(node, binding, denyPin) {
  if (node.opaque !== undefined) return { t: true, f: true };
  if (node.atom !== undefined) {
    const names = new RegExp(`\\b${binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(node.atom);
    if (!names) return { t: true, f: true };
    const v = verdictAtomTruth(node.atom, binding, denyPin);
    if (v === null) return { t: true, f: true };
    return { t: v, f: !v };
  }
  if (node.not) { const c = canBe(node.not, binding, denyPin); return { t: c.f, f: c.t }; }
  if (node.and) {
    const cs = node.and.map((x) => canBe(x, binding, denyPin));
    return { t: cs.every((c) => c.t), f: cs.some((c) => c.f) };
  }
  if (node.or) {
    const cs = node.or.map((x) => canBe(x, binding, denyPin));
    return { t: cs.some((c) => c.t), f: cs.every((c) => c.f) };
  }
  return { t: true, f: true };
}

// ── control flow inside a function body ────────────────────────────────────
/** Every `{ … }` region in the body, innermost last for a given index. */
function braceRegions(body) {
  const stack = [];
  const out = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') stack.push(i);
    else if (body[i] === '}') { const o = stack.pop(); if (o !== undefined) out.push([o, i]); }
  }
  return out;
}

function innermostBlock(regions, idx) {
  let best = null;
  for (const [o, c] of regions) {
    if (idx > o && idx < c) {
      if (best === null || o > best[0]) best = [o, c];
    }
  }
  return best;
}

/**
 * Every `if (C) <consequent>` in the body: the condition text, the consequent's
 * `[start, end)`, and whether the consequent is a SINGLE unconditional return.
 */
function ifRegions(body) {
  const out = [];
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const open = body.indexOf('(', m.index);
    const close = matchingClose(body, open);
    if (close === -1) continue;
    const cond = body.slice(open + 1, close);
    let i = close + 1;
    while (i < body.length && /\s/.test(body[i])) i += 1;
    let start = i;
    let end;
    let single;
    if (body[i] === '{') {
      end = matchingClose(body, i) + 1;
      const inner = body.slice(i + 1, end - 1).trim();
      single = /^return\b/.test(inner) && splitTop(inner, ';').length <= 1;
    } else {
      // a single statement, up to the next `;` at depth 0
      let d = 0;
      end = body.length;
      for (let k = i; k < body.length; k++) {
        const c = body[k];
        if (c === '(' || c === '[' || c === '{') d += 1;
        else if (c === ')' || c === ']' || c === '}') d -= 1;
        else if (c === ';' && d === 0) { end = k + 1; break; }
      }
      single = /^return\b/.test(body.slice(i, end).trim());
    }
    out.push({ condAt: m.index, cond, start, end, single });
  }
  return out;
}

/** Every `return <expr>;` in a body. */
function returnStatements(body) {
  const out = [];
  const re = /\breturn\b/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let d = 0;
    let end = body.length;
    for (let i = m.index + 6; i < body.length; i++) {
      const c = body[i];
      if (c === '(' || c === '[' || c === '{') d += 1;
      else if (c === ')' || c === ']' || c === '}') { if (d === 0) { end = i; break; } d -= 1; }
      else if (c === ';' && d === 0) { end = i; break; }
    }
    out.push({ index: m.index, end, expr: body.slice(m.index + 6, end).trim() });
  }
  return out;
}

/**
 * The PATH CONDITION of a return: every enclosing `if` condition, AND the
 * NEGATION of every preceding single-return guard clause in the same block.
 * Returned as a boolean tree plus its normalised text (for pinning).
 */
function pathCondition(body, ifs, regions, at) {
  const parts = [];
  for (const r of ifs) {
    if (at >= r.start && at < r.end) parts.push(`(${norm(r.cond)})`);
  }
  const myBlock = innermostBlock(regions, at);
  for (const r of ifs) {
    if (r.end > at) continue;
    if (!r.single) continue;
    const rBlock = innermostBlock(regions, r.condAt);
    const same =
      (myBlock === null && rBlock === null) ||
      (myBlock !== null && rBlock !== null && myBlock[0] === rBlock[0]);
    if (!same) continue;
    parts.push(`!(${norm(r.cond)})`);
  }
  const text = parts.join(' && ');
  return { text, tree: text ? boolTree(text) : { opaque: '' } };
}

/**
 * Split a returned expression into the VALUES it can evaluate to, each with the
 * extra condition that selects it. Handles ternaries (N5) and `??` / `||`
 * fallbacks. A `return null` model would see none of this.
 */
function valueBranches(expr) {
  const t = expr.trim();
  if (!t) return [{ value: '', cond: null }];
  // top-level ternary
  let d = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') d -= 1;
    else if (d === 0 && c === '?' && t[i + 1] !== '?' && t[i + 1] !== '.' && t[i - 1] !== '?') {
      // find the matching ':' at depth 0, skipping nested ternaries
      let dd = 0;
      let depth = 0;
      for (let k = i + 1; k < t.length; k++) {
        const cc = t[k];
        if (cc === '(' || cc === '[' || cc === '{') depth += 1;
        else if (cc === ')' || cc === ']' || cc === '}') depth -= 1;
        else if (depth === 0 && cc === '?' && t[k + 1] !== '?' && t[k + 1] !== '.') dd += 1;
        else if (depth === 0 && cc === ':' && t[k - 1] !== '?') {
          if (dd === 0) {
            const test = t.slice(0, i).trim();
            const a = valueBranches(t.slice(i + 1, k));
            const b = valueBranches(t.slice(k + 1));
            return [
              ...a.map((x) => ({ value: x.value, cond: x.cond ? `(${test}) && (${x.cond})` : test })),
              ...b.map((x) => ({ value: x.value, cond: x.cond ? `!(${test}) && (${x.cond})` : `!(${test})` })),
            ];
          }
          dd -= 1;
        }
      }
      break;
    }
  }
  for (const op of ['??', '||']) {
    const parts = splitTop(t, op);
    if (parts.length > 1) return parts.flatMap((p) => valueBranches(p));
  }
  // strip a trailing `as T` cast so the value shape is visible
  return [{ value: t.replace(/\s+as\s+[\w$<>\[\]|&. ]+$/, '').trim(), cond: null }];
}

/**
 * ALLOW / DENY / VERDICT for one returned value.
 *
 * THE VERDICT TEST IS IDENTITY, NOT MENTION, and that is the round-4 fix. This
 * used to read `new RegExp(`\\b${binding}\\b`).test(t)` — "the returned
 * expression NAMES the verdict, so it IS the verdict" — which is the same
 * vacuous-satisfaction defect round 3 removed from the ALLOW CONDITIONS (N1: a
 * disjunction mentions the verdict and discards it) left behind in the ALLOW
 * VALUES. An independent review measured the A/B pair, identical but for the
 * returned expression, inserted after the delegation in `authorizeWorkspace`:
 *
 *     if (opts.allowReadRoles === undefined) return null;            exit 1
 *     if (opts.allowReadRoles === undefined) return access && null;  exit 0
 *
 * `access && null` is `null` when the delegate GRANTED and `access` — i.e.
 * `null`/`undefined` — when it REFUSED. It is therefore always falsy, always an
 * ALLOW, and since `allowReadRoles === undefined` is the DEFAULT it is a total
 * cross-tenant bypass of every write-scoped call site. Classifying it 'verdict'
 * made the loop `continue`, so 8d's implication test never ran on it at all.
 *
 * Only the bare binding — `return access;` — is the verdict. Anything BUILT from
 * it is a value this guard has to reason about, not a value it may assume.
 * `x.member` (`return access.workspace`) is deliberately NOT the verdict either:
 * it is an ALLOW whose reachability 8d then proves against the path condition,
 * which is where that proof belongs.
 *
 * `allowIsNull` IS THREE-VALUED, and the third value is round 5. This console
 * carries BOTH ALLOW conventions — `workspace-guard.ts` ALLOWs with `null` while
 * `workspace-list-access.ts` ALLOWs with a non-null value — and which one a
 * function uses is read off its declared return type. When there is no return
 * type to read (see {@link allowIsNullFor}) the guard does not know, so it must
 * not pick: `null` counts as an ALLOW as well, which is the strict direction.
 * Defaulting the unknown case to `false` would have re-opened blocker 3 one level
 * down — the unannotated authorizer would be DERIVED and then its `return null`
 * bypass classified 'deny', so nothing would look at it.
 */
function classifyValue(value, binding, delegate, allowIsNull) {
  const t = value.trim();
  if (!t) return 'deny';
  if (binding && t === binding) return 'verdict';
  if (delegate && new RegExp(`^(?:await\\s+)?${delegate}\\s*\\(`).test(t)) return 'verdict';
  if (/\b(?:NextResponse|workspaceDenialResponse)\b/.test(t)) return 'deny';
  if (/^\{/.test(t) && /(?:^\{|[,{])\s*resp\s*[:,}]/.test(t)) return 'deny';
  // AN OBJECT LITERAL WHOSE EVERY PROPERTY IS THE LITERAL `null` IS A REFUSAL
  // under any convention in this codebase — it carries no document, no role and
  // no session, so nothing downstream can be admitted by it. Added for #3840:
  // `resolveWorkspaceRole` refuses with `{ workspace: null, role: null }`
  // rather than with a bare `null`, and without this every one of its refusals
  // classified 'allow' and 8d accused them of being cross-tenant grants. The
  // rule is deliberately narrow — ONE unmatched property value and it is an
  // ALLOW again — so it cannot clear a grant that carries anything at all.
  if (isAllNullObjectLiteral(t)) return 'deny';
  // A literal `false` is a REFUSAL under every convention in this codebase, and
  // saying so is what makes the TIER-2 (boolean-verdict) population checkable
  // without a false accusation on `if (!access) return false;`.
  if (/^false$/.test(t)) return 'deny';
  if (/^(?:null|undefined)$/.test(t)) return allowIsNull === false ? 'deny' : 'allow';
  return 'allow';
}

/**
 * Is `t` an object literal every one of whose top-level property values is the
 * literal `null`? (`{ workspace: null, role: null }`.)
 *
 * Deliberately TOTAL and deliberately NARROW: every property is parsed, and a
 * single value that is not exactly `null` — a spread, a shorthand, a computed
 * key, a nested object, a call — makes the whole literal an ALLOW again. A
 * refusal that carries nothing cannot admit anyone; anything that carries
 * SOMETHING has to be proved against the delegated verdict like any other grant.
 */
function isAllNullObjectLiteral(t) {
  if (!/^\{[\s\S]*\}$/.test(t)) return false;
  const inner = t.slice(1, -1).trim();
  if (!inner) return false; // `{}` — not a shape this codebase returns; judge it
  for (const part of splitTop(inner, ',')) {
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*null$/.exec(part.trim());
    if (!m) return false;
  }
  return true;
}

/**
 * Which value means ALLOW for a callable whose EXPANDED return type is `t`:
 * `true` (a `NextResponse | null` refusal-carrier, so `null` is the grant),
 * `false` (an access object, so `null` is the refusal), or `null` — UNKNOWN,
 * because there is no annotation to read. See {@link classifyValue} for what the
 * unknown case costs and why it is the safe direction.
 */
function allowIsNullFor(t) {
  if (!(t || '').trim()) return null;
  return /\bNextResponse\b/.test(t);
}

// ── 8a: derive the authorizer set ──────────────────────────────────────────
const authzFiles = walk(AUTHZ_DIR);
const moduleCache = new Map();
const readMasked = (f) => {
  if (!moduleCache.has(f)) moduleCache.set(f, mask(readFileSync(f, 'utf8')));
  return moduleCache.get(f);
};

/**
 * A WORKSPACE-AUTHORIZATION module: its path says workspace, or it calls one of
 * the chokepoints. This is the set section 8e polices mention-by-mention.
 */
function isWorkspaceAuthzModule(rel, masked) {
  if (/workspace/i.test(rel)) return true;
  if (CHOKEPOINTS.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(masked))) return true;
  return false;
}

/**
 * The candidate set — FOUR independent triggers, so a new authorizer has to dodge
 * all four: it must not live in a `workspace*` module, must not call a
 * chokepoint, must not mention the tenant-admin flag while taking a session, and
 * must not name a workspace/item id in its signature. Each trigger alone would
 * have caught N6a/N6c/N10; the point of four is that none of them is the one
 * thing an author has to remember.
 *
 * ROUND 5 — THE RETURN TYPE IS NO LONGER A PRE-TRIGGER FILTER AT ALL. It used to
 * read `if (!VERDICT_RETURN.test(expanded)) continue;`, which ran BEFORE all four
 * triggers, so the candidate was dropped on a property the author picks freely —
 * structurally the identical mistake round 4 removed for the declaration FORM
 * (R3b). It was measured twice, from both sides of the test:
 *
 *   - NO ANNOTATION AT ALL yields `''`, which fails the test. Byte-identical
 *     env-oid bodies in `workspace-guard.ts`:
 *         export async function authorizeWorkspaceQuick(…): Promise<NextResponse|null>  exit 1
 *         the same with `: Promise<NextResponse | null>` DELETED                        exit 0
 *     and the same pair in `workspace-list-access.ts`. Not an exotic spelling:
 *     `.eslintrc.json` extends only `next/core-web-vitals` and sets neither
 *     `explicit-module-boundary-types` nor `explicit-function-return-type`, and
 *     this console carries 2999 unannotated exported function declarations
 *     against 7719 annotated.
 *   - A NON-VERDICT ANNOTATION does the same:
 *     `export async function canListWorkspace(…): Promise<boolean>` with an
 *     env-oid `return true` exited 0, and a boolean verdict is an ordinary
 *     authorizer shape, not an exotic one.
 *
 * SO THE RETURN TYPE NOW SELECTS A TIER, NEVER A DROP:
 *
 *   tier 1 `verdict`  — the annotation matches VERDICT_RETURN, or there is no
 *                       readable annotation. Fully checked: delegation, prologue
 *                       pins (8b), verdict-binding soundness (8c) and the ALLOW
 *                       implication test (8d).
 *   tier 2 `other`    — a readable annotation that is not a verdict type, most
 *                       often `boolean`. Checked for DELEGATION, for PROLOGUE
 *                       ALLOWs and for binding soundness — which is where every
 *                       measured bypass in rounds 3-5 actually sat — but 8d's
 *                       post-delegation implication test is applied only to the
 *                       ALLOWs whose value never MENTIONS the delegated verdict.
 *                       STATED AS A LIMIT, not as coverage: for a boolean
 *                       authorizer the returned expression IS the verdict in
 *                       another form (`return access !== null`), and this guard's
 *                       condition model reasons about the verdict by name in the
 *                       CONDITION, not in the value. Judging those would either
 *                       accuse correct code or, if the value were folded into the
 *                       path condition, re-open R1b (`return access && null`).
 *                       So the residual is named: a tier-2 authorizer that grants
 *                       AFTER the delegation with a value that mentions the
 *                       verdict is NOT proved here. The specs are the backstop.
 *
 * COST, measured rather than assumed (`temp/probe-triggers.mjs` shape): on this
 * tree the change adds 15 candidates in `lib/auth`, all tier 2, every one of them
 * classified in NON_AUTHORIZERS below with a reason checkable against its file.
 * The three unannotated exports (`pat.ts::parseToken`, `pat.ts::parseAuthHeader`,
 * `pdp/authorize.ts::constructor`) fire no trigger and so add nothing.
 */
const candidates = [];
for (const file of authzFiles) {
  const rel = file.slice(CONSOLE_ROOT.length + 1);
  const masked = readMasked(file);
  const inAuthzModule = isWorkspaceAuthzModule(rel, masked);
  const namesAdminFlag = ISADMIN.test(masked);
  for (const fn of exportedFunctions(masked)) {
    const expanded = expandReturnType(masked, fn.returnType);
    const readable = expanded.trim().length > 0;
    const tier = !readable || VERDICT_RETURN.test(expanded) ? 'verdict' : 'other';
    const trigger =
      (inAuthzModule && 'module') ||
      (namesAdminFlag && /\bSessionPayload\b/.test(fn.params) && 'admin-flag') ||
      (WORKSPACE_PARAM.test(fn.params) && 'signature') ||
      null;
    if (!trigger) continue;
    const label = readable ? (tier === 'verdict' ? trigger : `${trigger}:other-return`) : `${trigger}:no-return-type`;
    candidates.push({ file, rel, masked, fn, expanded, tier, trigger: label });
  }
}

const chokepointReturn = new Map();
for (const file of authzFiles) {
  const masked = readMasked(file);
  for (const name of CHOKEPOINTS) {
    if (chokepointReturn.has(name)) continue;
    const span = functionSpan(masked, name);
    if (span && new RegExp(`function\\s+${name}\\s*[(<]`).test(masked)) {
      chokepointReturn.set(name, expandReturnType(masked, span.returnType));
    }
  }
}

/**
 * The truthiness of a delegation's RESULT when the delegate DENIED — derived
 * from the delegate's own declared return type, never assumed. A delegate whose
 * refusal is a `NextResponse` denies with a TRUTHY value; one whose grant is an
 * access object denies with `null`.
 */
function denyPinFor(delegate) {
  const t = chokepointReturn.get(delegate);
  if (!t) return { pin: null, why: `the declared return type of ${delegate} could not be read` };
  if (!/\|\s*null\b|\bnull\s*\|/.test(t)) {
    return { pin: null, why: `${delegate} does not return \`X | null\`, so its verdict has no modelled truthiness` };
  }
  return { pin: /\bNextResponse\b/.test(t), why: null };
}

const usedNonAuthorizers = new Set();
const usedProloguePins = new Set();
const usedPostPins = new Set();
const authorizerNames = [];
const checkedKeys = new Set();

for (const c of candidates) {
  const key = `${c.rel}:${c.fn.name}`;
  if (NON_AUTHORIZERS.has(key)) { usedNonAuthorizers.add(key); continue; }
  authorizerNames.push(`${c.fn.name}[${c.trigger}]`);
  checkedKeys.add(key);

  const body = c.fn.body;
  const allowIsNull = allowIsNullFor(c.expanded);

  // Which chokepoint does it delegate to? (Never itself.)
  let delegate = null;
  let span = null;
  for (const name of CHOKEPOINTS) {
    if (name === c.fn.name) continue;
    const spans = callArgSpans(body, name);
    if (spans.length > 0 && (span === null || spans[0][2] < span[2])) {
      delegate = name;
      span = spans[0];
    }
  }
  if (!delegate) {
    fail(
      `${c.rel}: ${c.fn.name}() returns a workspace/item authorization verdict ` +
        `(\`${norm(c.fn.returnType).slice(0, 60)}\`) but delegates to NONE of ` +
        `${CHOKEPOINTS.join(' / ')}. It is therefore deciding workspace access on its ` +
        'own, which is #3825. Either route the decision through ' +
        'resolveWorkspaceAccessByOid, or classify it in NON_AUTHORIZERS in this guard ' +
        'WITH the reason a reviewer can check against the file.',
    );
    continue;
  }
  if (delegate === 'resolveWorkspaceAccessByOid' && !/tenantAdmin\s*:/.test(body.slice(span[0], span[1]))) {
    fail(
      `${c.rel}: ${c.fn.name} does not pass \`tenantAdmin\` to the resolver. ` +
        'The repaired boundary (step 6) then never runs for an admin, so the admin-open ' +
        'path is either dead or decided somewhere else.',
    );
  }

  const { pin: denyPin, why } = denyPinFor(delegate);
  if (denyPin === null) {
    fail(`${c.rel}: ${c.fn.name} delegates to ${delegate}, but ${why} — this guard cannot prove its ALLOWs follow from the verdict.`);
    continue;
  }

  // The identifier the verdict is bound to, if it is bound at all.
  const bindM = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${delegate}\\s*\\(`,
  ).exec(body);
  const binding = bindM ? bindM[1] : null;

  const ifs = ifRegions(body);
  const regions = braceRegions(body);
  const returns = bodyReturns(c.fn);

  const prologueAllows = [];
  const postAllows = [];
  for (const r of returns) {
    for (const br of valueBranches(r.expr)) {
      const kind = classifyValue(br.value, binding, delegate, allowIsNull);
      if (kind !== 'allow') continue;
      const pc = pathCondition(body, ifs, regions, r.index);
      const condText = br.cond ? (pc.text ? `${pc.text} && (${norm(br.cond)})` : norm(br.cond)) : pc.text;
      const rec = { r, br, condText, tree: condText ? boolTree(condText) : { opaque: '' } };
      // A concise arrow body is ONE expression that necessarily contains the
      // delegation, so its implicit return is post-delegation however the
      // indices fall — calling it a prologue ALLOW would be an untrue message.
      if (!c.fn.exprBody && r.index < span[2]) prologueAllows.push(rec);
      else postAllows.push(rec);
    }
  }

  // 8b — PRE-DELEGATION ALLOWs are pinned by POSITION: the whole prologue text,
  //      from the opening brace through the LAST of them.
  if (prologueAllows.length > 0) {
    const last = prologueAllows[prologueAllows.length - 1];
    const observed = norm(body.slice(0, last.r.end + 1));
    const pin = PROLOGUE_PINS.get(key);
    if (!pin) {
      fail(
        `${c.rel}: ${c.fn.name} ALLOWs BEFORE it delegates to ${delegate}() — ` +
          `${prologueAllows.length} such return(s). An ALLOW decided before the tenant ` +
          'decision is #3825 exactly. If it is genuinely sound, pin its PROLOGUE in ' +
          `PROLOGUE_PINS in this guard under \`${key}\` with the reason. Observed ` +
          `prologue:\n        ${observed}`,
      );
    } else {
      usedProloguePins.add(key);
      if (norm(pin.text) !== observed) {
        fail(
          `${c.rel}: ${c.fn.name}'s pinned PRE-DELEGATION prologue CHANGED. The pin covers ` +
            'everything from the opening brace through the last ALLOW that precedes the ' +
            'delegation, because pinning only the ALLOW’s condition text let its INPUT ' +
            'be forged one line above it while the condition stayed byte-identical (N7), ' +
            'and let a SECOND copy of the same condition inherit the exemption (N9).' +
            `\n        pinned:   ${norm(pin.text)}` +
            `\n        observed: ${observed}`,
        );
      }
    }
  }

  // 8c — THE VERDICT BINDING MUST BE A SINGLE IMMUTABLE `const`.
  //
  // Everything below reasons about the ALLOW conditions by NAME: an atom that
  // mentions `denied` is treated as the delegated verdict. That inference is only
  // sound while the name means one thing for the whole body. Found by the author
  // of this round while trying to defeat the check above (N12): with the ALLOW
  // conditions left completely alone,
  //
  //     if (opts.itemType === 'lakehouse') { const denied = null; if (!denied) return null; }
  //
  // SHADOWS the verdict — the path condition `(opts.itemType === 'x') && (!denied)`
  // is unsatisfiable under the DENY pinning, so the implication test PASSED it,
  // and it was a live cross-tenant ALLOW (the itemType sweep in the #3825 spec is
  // what caught it). A re-ASSIGNMENT (`denied = null`) is the same defect one
  // keyword away. Both are now refused outright rather than reasoned about.
  //
  // Checked AFTER the prologue pin, not before, so that an unsound binding does
  // not suppress that verdict and make its staleness report assert something the
  // guard never established (R7).
  let bindingSound = true;
  if (binding !== null) {
    const b = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const decls = body.match(new RegExp(`(?:const|let|var)\\s+${b}\\b`, 'g')) ?? [];
    const isConst = new RegExp(`const\\s+${b}\\s*(?::[^=]*)?=\\s*(?:await\\s+)?${delegate}\\s*\\(`).test(body);
    const assigns = [];
    const aRe = new RegExp(`\\b${b}\\s*=(?!=)`, 'g');
    let am;
    while ((am = aRe.exec(body)) !== null) {
      const before = body.slice(Math.max(0, am.index - 12), am.index);
      if (!/\b(?:const|let|var)\s+$/.test(before)) assigns.push(am.index);
    }
    if (!isConst || decls.length !== 1 || assigns.length > 0) {
      bindingSound = false;
      fail(
        `${c.rel}: ${c.fn.name}'s delegated verdict \`${binding}\` is not a single immutable ` +
          `\`const\` (declarations: ${decls.length}, re-assignments: ${assigns.length}, ` +
          `bound with const: ${isConst}). Every ALLOW below is judged by whether its condition ` +
          `reads \`${binding}\` — which is only meaningful while that name refers to ONE value. ` +
          'A shadowing re-declaration in an inner block, or a re-assignment, makes a condition ' +
          'that LOOKS like it reads the verdict read something else entirely (N12). Keep the ' +
          `\`const ${binding} = await ${delegate}(…)\` shape and derive anything else from it ` +
          'under a different name.',
      );
    }
  }

  // 8d — every POST-DELEGATION ALLOW must be UNREACHABLE when the delegate said
  //      no. This is the check that does not care what the bypass calls itself.
  const pins = POST_DELEGATION_PINS.get(key) ?? [];
  for (const a of bindingSound ? postAllows : []) {
    // TIER 2 (a readable, non-verdict return type — see 8a): the returned VALUE
    // is the verdict in another form, e.g. `return access !== null` for a
    // `Promise<boolean>` authorizer. This guard reasons about the verdict by name
    // in the CONDITION, not in the value, so judging those would either accuse
    // correct code or — if the value were folded into the path condition —
    // re-open R1b, where `return access && null` is always falsy and therefore
    // always an ALLOW. A tier-2 ALLOW whose value NEVER MENTIONS the verdict is
    // still judged, because such a grant cannot follow from a verdict it does not
    // read. The rest is a stated limit, not coverage.
    if (
      c.tier === 'other' &&
      binding !== null &&
      new RegExp(`\\b${binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(a.br.value)
    ) {
      continue;
    }
    if (binding === null) {
      fail(
        `${c.rel}: ${c.fn.name} ALLOWs after calling ${delegate}() without binding its ` +
          'result, so this guard cannot tell an ALLOW that reflects the delegated verdict ' +
          `from one that overrides it. Keep the \`const x = await ${delegate}(…)\` shape.`,
      );
      break;
    }
    const reach = canBe(a.tree, binding, denyPin);
    if (reach.t === false) continue; // provably impossible while the delegate denied
    const hit = pins.find((p) => norm(p.cond) === a.condText && norm(p.ret) === norm(a.br.value));
    if (hit) {
      usedPostPins.add(`${key}|${norm(hit.cond)}`);
      // 8d-R4 — THE PIN MUST COVER THE BOUNDARY ITS REASON CLAIMS TO PIN. A
      // `cond` + `ret` pair is a pin on what the grant SAYS, not on the checks
      // that stand between the delegation and it. Measured: deleting the
      // item-grant path's whole tid comparison
      //
      //     if (tid) { const wsDoc = await readWorkspaceById(item.workspaceId);
      //                if (wsDoc?.tid && wsDoc.tid !== tid) return null; }
      //
      // left both pinned strings BYTE-IDENTICAL and the guard exited 0 — because
      // a non-single-return `if` block contributes nothing to a path condition.
      // The pin's own reason said "removing that boundary … is a red build",
      // which the guard did not establish: an R7 violation inside the guard.
      // `region` closes it the way PROLOGUE_PINS does, by POSITION: the whole
      // masked span from the end of the delegation call through the end of this
      // ALLOW. Same trade, stated plainly — ANY edit in that span fails this
      // guard until it is re-pinned, which is the point.
      const observedRegion = norm(body.slice(span[1], a.r.end + 1));
      if (!hit.region) {
        fail(
          `POST_DELEGATION_PINS entry \`${key}\` (cond \`${norm(hit.cond)}\`) carries no ` +
            '`region`, so it pins only what the grant RETURNS and nothing about the checks ' +
            'between the delegation and it. Add the region below verbatim:' +
            `\n        region: ${observedRegion}`,
        );
      } else if (norm(hit.region) !== observedRegion) {
        fail(
          `${c.rel}: ${c.fn.name}'s pinned POST-DELEGATION region CHANGED. The pin covers ` +
            'everything from the end of the delegation call through the end of the pinned ' +
            'ALLOW, because pinning only the condition and the returned value let the tenant ' +
            'boundary BETWEEN them be deleted outright with both strings byte-identical.' +
            `\n        pinned:   ${norm(hit.region)}` +
            `\n        observed: ${observedRegion}`,
        );
      }
      continue;
    }
    const line = body.slice(0, a.r.index).split('\n').length;
    fail(
      `${c.rel}: ${c.fn.name} (body line ${line}) can ALLOW while ${delegate}() DENIED.` +
        `\n        path condition: ${a.condText || '(none — unconditional)'}` +
        `\n        returns:        ${norm(a.br.value).slice(0, 120)}` +
        `\n        The ALLOW must be IMPLIED by the delegated verdict \`${binding}\` — the ` +
        'condition has to be false whenever the delegate refused. A disjunction that ' +
        'MENTIONS the verdict does not qualify (N1/N2/N4b), and neither does a use of it ' +
        'this guard cannot model (only `x`, `!x`, `x === null`, `x == null`, ' +
        '`x !== null` and `x.member` are modelled). If this ALLOW is a genuine second ' +
        `grant path, pin it in POST_DELEGATION_PINS under \`${key}\` with the reason.`,
    );
  }
}

// 8e — the tenant-admin flag may be COMPUTED and PASSED DOWN; it may not be
//      turned into a value that leaves the delegation. Scanned over the WHOLE
//      masked module, not just the authorizer bodies: the round-3 review moved
//      the bypass one hop into a module-level helper returning a boolean, and a
//      scan of `functionBody(guard, <named authorizer>)` saw nothing (N4b).
for (const file of authzFiles) {
  const rel = file.slice(CONSOLE_ROOT.length + 1);
  const masked = readMasked(file);
  if (!ISADMIN.test(masked)) continue;
  if (!isWorkspaceAuthzModule(rel, masked)) continue;
  const spans = CHOKEPOINTS.flatMap((n) => callArgSpans(masked, n));
  const fns = declaredFunctions(masked);
  const ifs = ifRegions(masked);

  for (const at of indicesOf(masked, ISADMIN)) {
    if (spans.some(([a, b]) => at >= a && at < b)) continue; // passed DOWN — fine
    // …or handed to the resolver through an options object, which is the same
    // thing one indirection later: `{ … tenantAdmin: isTenantAdmin(s) }`.
    if (/\btenantAdmin\s*:\s*$/.test(masked.slice(Math.max(0, at - 40), at))) continue;

    const owner = fns
      .filter((f) => at > f.bodyStart && at < f.bodyEnd)
      .sort((a, b) => b.bodyStart - a.bodyStart)[0];
    const line = masked.slice(0, at).split('\n').length;

    // A NARROWING GATE is allowed: the mention sits in an `if` condition, and
    // every ALLOW inside the region that `if` governs is IMPLIED BY THE DELEGATED
    // VERDICT — i.e. provably impossible while the delegate refused. That is
    // `resolveAdminWorkspace`'s "who may reach the admin plane" test, which must
    // stay (without it a shared-ACL member reaches /git, /cmk, /identity, …).
    //
    // ROUND 4 — THIS EXEMPTION USED TO BE ACCIDENTAL RATHER THAN REASONED, and
    // that is recorded rather than quietly fixed. It asked only whether the
    // governed region contained an ALLOW at all, using the same `classifyValue`
    // that treated any value MENTIONING the verdict as BEING the verdict. So
    // `resolveAdminWorkspace`'s gate passed not because its grant follows from
    // the delegation but because the guard could not SEE the grant: the region's
    // one ALLOW returns `{ session, ws: access.workspace, … }`, which names
    // `access` and was classified 'verdict'. With that classifier repaired the
    // presence test alone turns the clean tree RED at the real, sound gate —
    // measured, `workspace-guard.ts:465` — while still admitting any grant whose
    // VALUE mentions the binding and discards it, e.g. an in-gate
    // `return access !== undefined;`, which is TRUE exactly when the resolver
    // said no. The presence test therefore had both error directions at once.
    //
    // The reachability test is 8d's, applied to the governed region: same
    // `pathCondition` + `canBe`, same deny-pinning derived from the delegate's own
    // return type. An ALLOW the guard cannot tie to the verdict — no binding, no
    // modelled deny-truthiness, or a condition it cannot model — counts as a
    // grant, which is the strict direction.
    const gate = ifs.find((r) => {
      const open = masked.indexOf('(', r.condAt);
      return at > open && at < open + r.cond.length + 1;
    });
    if (gate && owner) {
      const allowIsNull = allowIsNullFor(expandReturnType(masked, owner.returnType));
      let delegate = null;
      let bind = null;
      for (const n of CHOKEPOINTS) {
        if (n === owner.name) continue;
        if (callArgSpans(owner.body, n).length > 0) { delegate = n; break; }
      }
      if (delegate) {
        const bm = new RegExp(
          `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${delegate}\\s*\\(`,
        ).exec(owner.body);
        bind = bm ? bm[1] : null;
      }
      const gDenyPin = delegate ? denyPinFor(delegate).pin : null;
      const governed = masked.slice(gate.start, gate.end);
      const gIfs = ifRegions(governed);
      const gRegions = braceRegions(governed);
      const grants = returnStatements(governed).some((r) =>
        valueBranches(r.expr).some((br) => {
          if (classifyValue(br.value, bind, delegate, allowIsNull) !== 'allow') return false;
          if (bind === null || gDenyPin === null) return true; // nothing to imply it FROM
          const pc = pathCondition(governed, gIfs, gRegions, r.index);
          const cond = br.cond
            ? (pc.text ? `${pc.text} && (${norm(br.cond)})` : norm(br.cond))
            : pc.text;
          return canBe(cond ? boolTree(cond) : { opaque: '' }, bind, gDenyPin).t;
        }),
      );
      if (!grants) continue; // a narrowing gate, never a grant of its own
    }

    fail(
      `${rel}:${line}: isTenantAdmin is consulted OUTSIDE every delegation argument, in ` +
        `${owner ? `${owner.name}()` : 'module scope'}. The flag may be COMPUTED and PASSED ` +
        'DOWN (`tenantAdmin: isTenantAdmin(session)`) or used as a NARROWING GATE — an `if` ' +
        'every ALLOW inside which is IMPLIED by the delegated verdict, i.e. impossible while ' +
        'the delegate refused. Anything else turns the admin flag back into an access ' +
        'decision taken above the tenant boundary, which is #3825. A helper that returns it ' +
        'as a boolean counts (N4b): inline the call into the delegation argument instead. ' +
        'Mentioning the verdict in the granted VALUE does not make the grant follow from it ' +
        '(`return access !== undefined` is true exactly when the delegate said no).',
    );
  }
}

// 8f. The unfiltered cross-partition loader must not be reachable from an
//     authorization decision in this module. `loadWorkspaceAdmin` is a bare
//     `SELECT * FROM c WHERE c.id = @id`; returning its result past the boundary
//     is what made `resolveAdminWorkspace` cross-tenant.
const guardSrc = readFileSync(GUARD_FILE, 'utf8');
const guard = mask(guardSrc);
if (/\bloadWorkspaceAdmin\b/.test(guard)) {
  fail(
    `${GUARD_FILE}: references loadWorkspaceAdmin — an unfiltered cross-partition workspace ` +
      'read inside the module that authorizes workspace access (#3825). Resolve through ' +
      'resolveWorkspaceAccessByOid so the document is filtered by the tenant boundary.',
  );
}

// 8g. `resolveAdminWorkspace` — the isTenantAdmin GATE stays (without it a
//     shared-ACL member reaches the admin plane), and it must sit IN FRONT of
//     the resolver, never conclude the decision after it.
const rawBody = functionBody(guard, 'resolveAdminWorkspace');
if (!rawBody) {
  fail(`${GUARD_FILE}: resolveAdminWorkspace not found — the guard is pointed at the wrong symbol.`);
} else {
  const span = callArgSpan(rawBody, 'resolveWorkspaceAccessByOid');
  const gates = indicesOf(rawBody, ISADMIN);
  if (!span) {
    fail(
      `${GUARD_FILE}: resolveAdminWorkspace does not call resolveWorkspaceAccessByOid — it is ` +
        'resolving a workspace document for a tenant admin without the tenant boundary (#3825).',
    );
  } else {
    for (const at of gates) {
      if (at > span[0]) {
        fail(
          `${GUARD_FILE}: resolveAdminWorkspace consults isTenantAdmin AFTER the resolver. ` +
            'The flag may gate who reaches the admin plane; it must not be what answers ' +
            'whether this workspace is theirs.',
        );
      }
    }
  }
  if (gates.length === 0) {
    fail(
      `${GUARD_FILE}: resolveAdminWorkspace lost its isTenantAdmin gate. Every non-null ` +
        'resolver verdict is accepted inside that gate, so removing it newly admits a ' +
        'shared-ACL member to /git, /cmk, /identity, /networking and /storage-metrics.',
    );
  }
}

// 8h. Repo-wide shape scan — the net for the NEXT module, outside `lib/auth`.
//     No workspace-scoped function anywhere in the console may grant purely on
//     the admin flag. The scope test is PER FUNCTION, on its signature — not per
//     file. `requireTenantAdmin` (feature-gate.ts) is the legitimate use of this
//     shape: an org-wide surface with no workspace in play, so nothing to
//     compare a tenant against. `assertItemAccess`
//     (items/[type]/[id]/security-roles/route.ts) takes `(session, itemId,
//     itemType)` and is likewise out of THIS guard's subject — it is an
//     item-scoped sibling of the same class, reported separately rather than
//     smuggled into a tenant-boundary guard behind an excuse.
//
//     KNOWN LIMITS, stated rather than implied:
//       - ROUND 4 CORRECTED A DISCLOSURE THAT NO LONGER DESCRIBES A LIMIT. This
//         used to read "this walks `function NAME(…)` declarations only; the same
//         shape inside an arrow-function const is not seen" — true when written,
//         and the measured cost of it was that `export const f = async (…) => {…}`
//         exited 0 with the byte-identical `export async function` at exit 1. The
//         finder now covers `function` declarations, `const`/`let`/`var` arrows
//         (block AND concise bodies), `= async function`, object-literal and class
//         METHODS, an anonymous `export default function`, and (round 5) a
//         declaration exported by a later `export default <ident>;`.
//
//         ROUND 5 RETRACTS THE NUMBERS ROUND 4 PUT HERE. That sentence read
//         "17835 declarations before, 21050 after, with ZERO true drops". The
//         "after" reproduces; NOTHING ELSE IN IT DOES. Re-measured by running each
//         version's OWN `declaredFunctions` over its OWN `files` population and
//         diffing the SETS keyed `(file, name)` — never the net totals, which is
//         the whole mistake. REPRODUCE IT:
//
//             node scripts/ci/measure-tid-guard-decl-sets.mjs \
//                  8c3c4222 821de681 WORKTREE
//
//             8c3c4222 (round 3)  files 4103  rows 17958  unique 17943
//             821de681 (round 4)  files 4103  rows 21050  unique 20693
//             WORKTREE (round 5)  files 4103  rows 22653  unique 22310
//             IN round3 AND NOT IN round4: 137   (round 4 claimed 2, "zero true")
//             IN round3 AND NOT IN round5:   1
//             IN round4 AND NOT IN round5:  66
//
//         So the "before" was 17958 rows / 17943 unique, not 17835, and 137
//         declarations went MISSING while the net total went UP by 3092. Real
//         losses included `lib/azure/arm-client.ts :: armUrl`,
//         `lib/api/query-cache-headers.ts :: etagMatches`,
//         `app/api/storage/_lib/validate.ts :: isSafePrefix` and
//         `app/api/items/dbt-job/[id]/run/route.ts :: POST`. That is the shape
//         `csa_loom_route_toolkit_ratchet_perkey_is_the_teeth` exists to flag: a
//         total that moves the reassuring way over coverage that moved the other
//         way. An exemption or a disclosure that states as fact something it never
//         established is the R7 defect one level up, inside the guard.
//
//         WHAT IS TRUE NOW, each line reproducible from the command above:
//           * 136 of those 137 are recovered (137 - 1). They were all ONE
//             mechanism, the missing regex-literal case in `mask`.
//           * exactly ONE round3 declaration is still not found:
//             `lib/editors/phase3/eventhouse-editor.tsx :: wrapping`, which is the
//             words "stored function wrapping <code>external_table()</code>" in
//             JSX PROSE. Refusing it is correct.
//           * the 66 round4 -> round5 drops are NOT losses, and each is named so
//             the claim is checkable. 56 of them are literally called `async`:
//             round 4's method pattern read the `async` in
//             `export const POST = withWorkspaceOwner(TYPE, async (req) => {…})`
//             as an identifier, and branch 2b now claims that body under the REAL
//             exported name — `app/api/transform/[id]/run/route.ts :: async`
//             became `:: POST`, 56 route handlers over. The other 10 are round-4
//             FALSE POSITIVES of the regex mechanism read from the other side: a
//             `const x = (…).replace(/^https?:\/\//, '')`-shaped VARIABLE whose
//             mangled line looked like a callable head — `COUNT_BIG`, `MAX`
//             (dataflow/profile/route.ts), `account` x2 (lakehouse-shortcut,
//             spark-environment libraries), `dir` (git-integration-client),
//             `webhookReceivers` (monitor-client), `isSqlDb`
//             (pe-subresource-groups), `NVARCHAR` (rls-compiler), `host`
//             (shortcut-client), `ON` (unity-catalog compiler). None is a
//             function; four are SQL text inside a template literal.
//
//         What is STILL outside the finder, stated as a limit and not as zero: a
//         callable reached only through a computed property
//         (`obj['authorize'] = …`), a type annotation that spans a newline, a
//         wrapped arrow bound to a LOCAL inside another function (the MODULE-LEVEL
//         one is now seen — see `wrappedCallable`), and a `{ a: string }` object
//         RETURN TYPE, whose brace is taken for the body brace — the last of these
//         makes the "body" a type literal and the assertions over it vacuous, so
//         it is a blind spot, not a false accusation.
//       - IT KEYS ON THE `isTenantAdmin(` TOKEN, so a bypass that re-derives the
//         admin verdict without naming it — measured example
//         `if (session.claims.oid === process.env.LOOM_TENANT_ADMIN_OID) return null;`
//         — is INVISIBLE here.
//
//         ROUND 5 CORRECTS THE SENTENCE THAT FOLLOWED. It read "Inside
//         `lib/auth/**` sections 8a-8e catch that variant structurally", full stop,
//         and that was not true as written: blockers 1, 3 and 4 of the round-5
//         review, and should-fix 6, were ALL inside `lib/auth`, ALL re-derived the
//         admin verdict from an env-var oid without the token, and ALL exited 0.
//         What is true, and was verified by measuring it: 8e catches the
//         `isTenantAdmin`-NAMING variant regardless of return type (exit 1), and
//         8a-8e catch the env-oid variant ONLY WHEN THE DERIVATION ACTUALLY SEES
//         THE FUNCTION — which is precisely what those blockers broke and what
//         section 8i now turns into a red build. Everywhere ELSE in the repo THE
//         SPECS ARE THE BACKSTOP, not this scan. Do not read a green 8h as "no
//         bypass"; read it as "no bypass of the shapes 8h can see".
//       - the signature filter is what let N6c through inside `lib/auth`; that
//         file set no longer depends on it (8a derives by module, not by
//         parameter name). Out here the filter stays, and this limit with it:
//         MEASURED on this tree, 15 functions carry the admin-flag-grants-alone
//         shape and 14 of them are NOT workspace-scoped by signature, so 8h never
//         opens them. The 15th is `resolveAdminWorkspace`, which 8a-8e own. A
//         route-level authorizer that calls its parameter `id` is therefore
//         outside 8h, exactly as N6c was outside the old section 8. (The count was
//         14 in round 4 and moved to 15 because an UNANNOTATED `return null` is no
//         longer assumed to be a refusal — see `allowIsNullFor`.)
const ADMIN_GRANT_SCOPE = /\bworkspace(Id|_id)?\b/i;
let adminShapeFunctions = 0;
let adminShapeWorkspaceScoped = 0;
for (const file of files) {
  const rel = file.slice(CONSOLE_ROOT.length + 1);
  const src = readFileSync(file, 'utf8');
  if (!ISADMIN.test(src)) continue;
  const masked = mask(src);
  for (const fn of declaredFunctions(masked)) {
    // Does THIS function grant on the admin flag? (Not "does this file".)
    const grants = bodyReturns(fn).some((r) => {
      const ifs = ifRegions(fn.body);
      const regions = braceRegions(fn.body);
      const pc = pathCondition(fn.body, ifs, regions, r.index);
      if (!ISADMIN.test(pc.text)) return false;
      const allowIsNull = allowIsNullFor(expandReturnType(masked, fn.returnType));
      return valueBranches(r.expr).some(
        (br) => classifyValue(br.value, null, null, allowIsNull) === 'allow',
      );
    });
    if (!grants) continue;
    adminShapeFunctions += 1;
    if (!ADMIN_GRANT_SCOPE.test(fn.params)) continue; // not a workspace-scoped decision
    adminShapeWorkspaceScoped += 1;
    // `lib/auth/**` is covered PRECISELY by 8a-8e, which model the delegated
    // verdict; 8h's coarse model cannot and would report a false positive.
    // MEASURED, not assumed: with this skip removed the ONLY lib/auth hit is
    // `resolveAdminWorkspace`, whose isTenantAdmin gate governs a region every
    // ALLOW of which is the delegated verdict (8d proves that; 8g proves the gate
    // sits ahead of the resolver). Removing the skip therefore buys nothing and
    // costs one wrong accusation.
    if (rel.startsWith('lib/auth/')) continue;
    const line = masked.slice(0, fn.declAt).split('\n').length;
    fail(
      `${rel}:${line}: ${fn.name}() grants access on isTenantAdmin ALONE in a ` +
        'workspace-scoped function (#3825). A tenant admin must still be shown to be in ' +
        "the workspace's tenant — route the decision through resolveWorkspaceAccessByOid.",
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 10: NO PRIVATE COPY OF THE TENANT COMPARISON (#3843 / #3840 / #3834)
// ════════════════════════════════════════════════════════════════════════════
//
// WHY THIS SECTION EXISTS, MEASURED. Sections 1-9 verify that every call site
// SUPPLIES the tenant discriminant (1-7) and that every AUTHORIZER DELEGATES its
// verdict (8). Neither of them looks for the thing that actually keeps shipping:
// a SECOND COPY of the comparison, written somewhere that is not an authorizer
// and therefore is not in section 8's population at all.
//
// Proof, run against this tree on 2026-08-21 with the whole of sections 1-9
// intact — a new file `apps/fiab-console/lib/__tid-mutation-scratch.ts`:
//
//     export function scratchTenantCheck(a: { tid?: string }, b: { tid?: string }) {
//       if (a.tid && b.tid && a.tid !== b.tid) return false;
//       return true;
//     }
//
//     node scripts/ci/check-tid-boundary-chokepoint.mjs   ->  exit 0
//
// The guard printed "OK — the tenant boundary is required at every call site."
// over a live new copy of the decision. That silence is the finding this section
// removes: three of the four copies #3823/#3825/#3840/#3843 were filed against
// were introduced exactly that way, and none of them was ever an authorizer by
// section 8's definition (`items/by-type/route.ts` is a ROUTE; `workspace-role.ts`
// was classified a NON_AUTHORIZER by an exemption whose own text called it "a
// finding, not a clearance").
//
// WHAT IT KEYS ON. An equality/inequality operator one of whose operands is a
// TENANT id. "Tenant id" is TIERED, and the tiers are not a style choice — they
// are what the measured population forced:
//
//   STRONG  a MEMBER expression ending in `.tid` / `.<x>Tid` (`wsDoc.tid`,
//           `s.claims.tid`, `doc.tid`), or a bare identifier ending in a
//           CAPITAL-T `Tid` (`callerTid`, `docTid`, `ownerTid`, `wsTid`).
//           Counts on its own — one of these on either side is a hit.
//   WEAK    a bare lowercase `tid`. Counts ONLY opposite a STRONG operand.
//
// WHY THE WEAK TIER IS NOT STRONG. `tid` is an overloaded local in this console
// and the census proves it: `lib/editors/ai-red-team-editor.tsx:143` compares a
// TECHNIQUE id (`cur.filter((t) => t !== tid)`) and
// `lib/editors/copilot-studio-editors.tsx:853` a TOPIC id
// (`if (selectedId === tid)`). Neither is a tenancy decision and neither ever
// could be — they are client components. Pinning them would put two permanent
// non-security entries in a security allowlist and turn an unrelated UI edit into
// a red tenant-boundary build, which is how a check gets weakened later. The weak
// tier drops both while keeping every real comparison the census found, including
// `item-access.ts`'s `wsDoc.tid !== tid`, whose OTHER side is strong.
//
// `tenantId` IS DELIBERATELY NOT A TENANT ID HERE: in the `workspaces` container
// that field holds the CREATOR'S ENTRA OID, not a tenant, and
// `resource.tenantId === session.claims.oid` is the legitimate owner point-read
// that appears throughout the console. Keying on it would bury this check in
// false accusations, which is how a guard stops being read.
//
// EVERY HIT MUST BE PINNED, WITH A REASON, and the pin is the EXPRESSION TEXT —
// so adding a second comparison to an already-pinned file is a red build too, not
// just adding one to a new file. A pinned expression that no longer appears is
// also a red build (the stale-exemption rule the rest of this file uses): the
// comparison was deleted or the scanner stopped seeing it, and those need
// different responses.
//
// KNOWN LIMITS, stated rather than implied:
//   - THE WEAK TIER LEAVES ONE NAMABLE EVASION, and it is named rather than
//     rounded off: `if (docTenant !== tid)` — a bare lowercase `tid` opposite an
//     operand whose name says nothing about tenancy — is NOT caught. Inside
//     `lib/auth/**` section 8 is the structural backstop (an authorizer must
//     delegate whatever it calls its variables); outside it, the specs are.
//   - it is SYNTACTIC in general. A comparison spelled `[a.tid, b.tid].every(…)`,
//     one that goes through two locals named after neither
//     (`const a = doc.tid, b = s.claims.tid; if (a !== b)`), or one performed in a
//     Cosmos WHERE clause inside a template literal (string literals are MASKED
//     before any scan, which is what makes the M9/N21 negative controls pass) is
//     invisible here.
//   - it scans `apps/fiab-console/{app,lib}` only — the same `files` population
//     sections 5-6 and 8h use. `walk()` skips `__tests__` and `*.test.ts`, so a
//     spec may write the shape freely, which is what lets the specs assert on it.
const TID_OPERAND = /([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*$/;
const TID_OPERAND_AFTER = /^\s*([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)/;

/**
 * `'strong'` | `'weak'` | `null` — see the tier note above. `tenantId` is neither
 * (it is a creator oid in this codebase's `workspaces` container).
 */
function tenantOperandTier(path) {
  const segs = (path || '').split('.').map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return null;
  const last = segs[segs.length - 1];
  const isTidish = /^tid$/i.test(last) || /[a-z0-9_$]Tid$/.test(last);
  if (!isTidish) return null;
  if (segs.length > 1) return 'strong';        // a member expression: `x.tid`
  if (/[a-z0-9_$]Tid$/.test(last)) return 'strong'; // `callerTid`, `ownerTid`
  return 'weak';                                // a bare, overloaded `tid`
}

/**
 * Files permitted to compare two tenant ids, each with the reason a reviewer can
 * check against the file, and each pinned to the EXACT expressions it may carry.
 *
 * THE POINT OF THIS LIST IS THAT IT IS SHORT. "The tenant decision has one
 * implementation" is the whole of #3825; every entry here is a place that
 * genuinely holds two tids and no access resolution, and every one of them is
 * reachable from the canonical resolver rather than instead of it.
 */
const TID_COMPARISON_PINS = new Map([
  [
    'lib/auth/tenant-boundary.ts',
    {
      reason:
        'THE ONE IMPLEMENTATION. `classifyTenantMatch` is the comparison every other site ' +
        'delegates to; `normalizeTid` is its input guard. It takes two strings — no session, ' +
        'no oid, no document, no workspace id — precisely so it cannot become a place that ' +
        'decides access. Deleting these is deleting the boundary itself.',
      exprs: ['callerNormTid === null', 'resourceNormTid === null', 'callerNormTid === resourceNormTid'],
    },
  ],
  [
    'lib/auth/workspace-access.ts',
    {
      reason:
        'THE CANONICAL RESOLVER. Step 4 (the shared ACL boundary) and step 6 (the admin-open ' +
        'bypass, which #3823 tightened to require a POSITIVE match) plus the same step-4 ' +
        'filter applied per document by `listAccessibleWorkspaces`. Sections 1-4 of this ' +
        'guard govern these three lines directly — their ORDER relative to the ACL and admin ' +
        'steps is asserted there — so they are pinned here as the SET that may exist, not as ' +
        'an exemption from checking.',
      exprs: [
        'wsDoc.tid !== callerTid',
        'wsDoc.tid === callerTid',
        'doc.tid !== callerTid',
      ],
    },
  ],
  [
    'lib/auth/item-access.ts',
    {
      reason:
        'the ITEM-LEVEL grant path (the F6 "Grant people access" share) — a second grant ' +
        'reached only after the workspace resolver has DENIED, so it carries its own tenant ' +
        'boundary. It is ALSO pinned by POSITION in POST_DELEGATION_PINS above (`region`), ' +
        'which is what makes DELETING it a red build; this entry is what makes ADDING a ' +
        'second comparison to that file one.',
      exprs: ['wsDoc.tid !== tid'],
    },
  ],
  [
    'app/api/data-products/[id]/ports/route.ts',
    {
      reason:
        'A FINDING, RECORDED — NOT A CLEARANCE, and not a file this change owns. ' +
        '`callerMayDiscover` carries the truthiness-guarded shape verbatim ' +
        '(`if (ownerTid && session.claims.tid && ownerTid !== session.claims.tid) return false`), ' +
        'i.e. a FIFTH private copy of the decision #3823/#3825/#3840/#3843 were each filed ' +
        'against. What makes it different from those four, and the only reason it is pinned ' +
        'rather than fixed here: the file DISCLOSES the fall-through in its own docblock ' +
        '("KNOWN RESIDUAL, stated rather than implied away"), and it gates DISCOVERY of an ' +
        'already-published data product for a caller the workspace guard has already refused ' +
        '— a catalog read, not a grant of access to anything. The pin exists so the ' +
        'expression cannot change, or multiply, without this being re-read; consolidating it ' +
        'onto `sameTenantConfirmed` is the follow-up (#3843 family), and it needs the owner ' +
        'of that route to decide whether hiding legacy in-tenant products is acceptable.',
      exprs: ['ownerTid !== session.claims.tid'],
    },
  ],
]);

const tidPinsUsed = new Set();
const tidComparisonCensus = [];
for (const file of files) {
  const rel = file.slice(CONSOLE_ROOT.length + 1);
  const src = readFileSync(file, 'utf8');
  if (!/\btid\b|Tid\b/.test(src)) continue;
  const masked = mask(src);
  const eq = /!==|===|!=|==/g;
  let m;
  while ((m = eq.exec(masked)) !== null) {
    const before = masked.slice(Math.max(0, m.index - 120), m.index);
    const after = masked.slice(m.index + m[0].length, m.index + m[0].length + 120);
    const l = TID_OPERAND.exec(before);
    const r = TID_OPERAND_AFTER.exec(after);
    const left = l ? norm(l[1]) : '';
    const right = r ? norm(r[1]) : '';
    const lt = tenantOperandTier(left);
    const rt = tenantOperandTier(right);
    // A hit needs at least one STRONG operand; a bare lowercase `tid` counts
    // only opposite one (see the tier note above — measured against the two
    // editor false positives, a technique id and a topic id).
    if (lt !== 'strong' && rt !== 'strong') continue;
    const expr = norm(`${left} ${m[0]} ${right}`);
    const line = masked.slice(0, m.index).split('\n').length;
    tidComparisonCensus.push({ rel, line, expr });

    const pin = TID_COMPARISON_PINS.get(rel);
    if (!pin) {
      fail(
        `${rel}:${line}: a PRIVATE copy of the cross-tenant comparison — \`${expr}\`. The ` +
          'tenant decision has ONE implementation (`resolveWorkspaceAccessByOid`) and ONE ' +
          'comparison primitive (`sameTenantConfirmed` / `classifyTenantMatch`, ' +
          '`lib/auth/tenant-boundary.ts`). Call one of those. Every private copy that has ' +
          'shipped was the truthiness-guarded shape `a.tid && b.tid && a.tid !== b.tid`, ' +
          'which decides NOTHING when either side is absent and falls through to the grant ' +
          'below it — that is #3823, #3825, #3840 and #3843, four times over. If this site ' +
          'genuinely holds two tids and no access resolution, add it to TID_COMPARISON_PINS ' +
          'in this guard WITH the reason and the exact expression.',
      );
      continue;
    }
    tidPinsUsed.add(`${rel}|${expr}`);
    if (!pin.exprs.some((e) => norm(e) === expr)) {
      fail(
        `${rel}:${line}: a NEW tenant comparison — \`${expr}\` — in a file whose pinned set ` +
          `is [${pin.exprs.map((e) => `\`${norm(e)}\``).join(', ')}]. The pin is per ` +
          'EXPRESSION, not per file, so a second copy inside an already-pinned module is a ' +
          'review like any other. Pinned reason: ' +
          pin.reason,
      );
    }
  }
}
for (const [rel, pin] of TID_COMPARISON_PINS) {
  for (const e of pin.exprs) {
    if (!tidPinsUsed.has(`${rel}|${norm(e)}`)) {
      fail(
        `TID_COMPARISON_PINS entry \`${rel}\` pins \`${norm(e)}\`, which no longer appears. ` +
          'Either the comparison was REMOVED — in which case removing the boundary is the ' +
          'change to re-review, not the pin — or this scanner stopped seeing it, which is ' +
          'the failure mode the pin exists to catch. Do not delete the entry to make the ' +
          'build green.',
      );
    }
  }
}

// ── 8i: THE DERIVED SET STILL CONTAINS THE KNOWN AUTHORIZERS ────────────────
//
// Not "did the derivation find things", but "did it find THESE". A count is no
// help here: blocker 1 moved the total from 14 to 13 and the checked set from 6
// to 5, and nothing anywhere said which one left. This names it.
//
// Ordered BEFORE the stale-exemption reports so that when the derivation does go
// blind, the first line of the failure is the authorizer that vanished rather
// than the pins that consequently matched nothing.
const missingRequired = [...REQUIRED_AUTHORIZERS.keys()].filter((k) => !checkedKeys.has(k));
for (const k of missingRequired) {
  const derived = candidates.some((c) => `${c.rel}:${c.fn.name}` === k);
  fail(
    `REQUIRED AUTHORIZER \`${k}\` IS NOT BEING CHECKED. ${REQUIRED_AUTHORIZERS.get(k)}` +
      `\n        derived as a candidate: ${derived ? 'YES — but then classified a NON_AUTHORIZER' : 'NO — section 8a never saw it'}` +
      `\n        checked this run:       ${[...checkedKeys].sort().join(', ') || '(none)'}` +
      '\n        This is the failure mode section 8 is most vulnerable to and least likely ' +
      'to announce: the derivation goes blind and the guard still prints OK over a live ' +
      'bypass. If the function was genuinely renamed or removed, update REQUIRED_AUTHORIZERS ' +
      'in this guard as part of that change and say so in the PR. If it still exists, the ' +
      'DERIVATION is broken — fix that, do not delete the entry.',
  );
}

// ── stale exemptions ────────────────────────────────────────────────────────
for (const k of [...NON_AUTHORIZERS.keys()].filter((x) => !usedNonAuthorizers.has(x))) {
  fail(
    `NON_AUTHORIZERS entry \`${k}\` matches no derived candidate. The function was renamed, ` +
      'removed, or its return type changed so it is no longer seen as a verdict — re-review ' +
      'it rather than leaving an exemption that would clear a DIFFERENT function later.',
  );
}
for (const k of [...PROLOGUE_PINS.keys()].filter((x) => !usedProloguePins.has(x))) {
  fail(
    `PROLOGUE_PINS entry \`${k}\` matches no pre-delegation ALLOW. Either the ALLOW is gone ` +
      '(remove the pin) or the guard no longer sees it (which is the failure mode this pin ' +
      'exists to prevent) — re-review before deleting.',
  );
}
for (const [k, arr] of POST_DELEGATION_PINS) {
  for (const p of arr) {
    if (!usedPostPins.has(`${k}|${norm(p.cond)}`)) {
      fail(
        `POST_DELEGATION_PINS entry \`${k}\` (cond \`${norm(p.cond)}\`) matched no ALLOW. The ` +
          'conditions that lead to that grant changed — re-review it rather than leaving a ' +
          'stale exemption.',
      );
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────
// EVERY COUNT BELOW IS QUALIFIED BY WHAT PRODUCED IT. Round 4 printed
// `skipTidBoundary users: 0` over a live `{ skipTidBoundary: true }` in
// `ambientAccessOptsFor` (R5) — a bare zero the guard had not established. The
// range exemption fixed THAT instance; the affirmative PHRASING was still wrong,
// because a key reached through a computed string
// (`const K = 'skipTid' + 'Boundary'; return { [K]: true }`) is invisible to a
// scan that runs on MASKED source, and masking string literals is what makes the
// M9/N21 negative controls pass. MEASURED: that spelling exits 0 today with the
// count line reading zero. So the line now says what it counted — literal
// mentions — and never asserts the absence of the thing it cannot see. The specs
// are the backstop for the computed-key shape, not this file.
console.log(`[tid-boundary-chokepoint] guarded call sites: ${callSites}  ` +
            `(files naming skipTidBoundary LITERALLY: ${skipUsers.length}, allowlisted: ${used.size}` +
            '; a computed-string key is NOT counted — see the note above this line)');
const tier1 = candidates.filter((c) => c.tier === 'verdict').length;
console.log(`[tid-boundary-chokepoint] authorizers DERIVED from ${AUTHZ_DIR}: ` +
            `${candidates.length} candidate export(s) (${tier1} verdict-typed or unannotated, ` +
            `${candidates.length - tier1} other-typed — the return type selects a TIER, it no ` +
            `longer filters) — ${authorizerNames.length} checked for delegation + ALLOW ` +
            `implication, ${usedNonAuthorizers.size} classified ` +
            `non-authorizer(s); pins in use: ${usedProloguePins.size} prologue, ` +
            `${usedPostPins.size} post-delegation (#3825)`);
console.log(`[tid-boundary-chokepoint]   checked: ${authorizerNames.join(', ')}`);
console.log(`[tid-boundary-chokepoint] repo-wide admin-shape scan: ${adminShapeFunctions} ` +
            `function(s) whose OWN body grants on an isTenantAdmin-bearing condition, of ` +
            `which ${adminShapeWorkspaceScoped} are workspace-scoped by signature (#3825)`);
// QUALIFIED BY WHAT PRODUCED IT, like every other count here. This is a SYNTACTIC
// scan over masked source keyed on OPERAND NAMES, so it counts the comparisons it
// can see and asserts nothing about the ones it cannot — the weak-tier evasion and
// the two-anonymous-locals shape are named as limits on section 10, not rounded to
// zero here.
console.log(`[tid-boundary-chokepoint] tenant comparisons found by NAME outside the ` +
            `chokepoint: ${tidComparisonCensus.length} in ` +
            `${new Set(tidComparisonCensus.map((h) => h.rel)).size} file(s), all pinned ` +
            `(#3843) — ${tidComparisonCensus.map((h) => `${h.rel}:${h.line}`).join(', ') || 'none'}`);

const stale = [...SKIP_ALLOWLIST.keys()].filter((k) => !used.has(k));
if (stale.length > 0) {
  console.log(`[tid-boundary-chokepoint] NOTE — ${stale.length} allowlist entr(ies) match no file that uses skipTidBoundary. Harmless today; remove when confirmed obsolete:`);
  for (const k of stale) console.log(`    ${k}`);
}

if (failures.length > 0) {
  console.error('\n[tid-boundary-chokepoint] FAIL — the cross-tenant tid boundary can be skipped again (#2703).\n');
  for (const f of failures) console.error(`    ${f}`);
  console.error('\n  The boundary must be a decision every caller makes, not an option they can');
  console.error('  omit. Pass `{ callerTid: session?.claims.tid }` (undefined is fine — the');
  console.error('  resolver recovers it from the request session for the same principal), or');
  console.error('  declare `{ skipTidBoundary: true, skipTidBoundaryReason: "…" }` and pin it.\n');
  process.exit(1);
}

console.log('[tid-boundary-chokepoint] OK — the tenant boundary is required at every call site.');
