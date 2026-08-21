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
 * STILL NOT COVERED, so it is not read as covered: the opt-out named through a
 * STRING (`const K = 'skipTidBoundary'; return { [K]: true, … }`) is invisible to
 * section 6, because string literals are masked before any scan — the same
 * masking that makes M9/N21 negative controls pass. The specs are the backstop
 * for that shape, not this file.
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
    'lib/auth/workspace-role.ts:resolveWorkspaceRole',
    'a SECOND, older implementation of the workspace-role lookup (`findWorkspace`, same ' +
      'file) carrying its OWN tid comparison rather than delegating. It is out of this ' +
      "guard's model, and that is a finding, not a clearance: it is the fourth copy of " +
      'the decision that #3823/#3825 were both caused by. Consolidating it onto ' +
      '`resolveWorkspaceAccessByOid` is tracked separately; until then its boundary is ' +
      'lines 88-93 of that file and its own specs.',
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
]);

const failures = [];
const fail = (msg) => failures.push(msg);
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// ── source masking ──────────────────────────────────────────────────────────
/**
 * Blank out line comments, block comments and string/template literals,
 * preserving byte offsets (so index comparisons below stay meaningful) and
 * newlines (so line numbers stay right). A doc comment that says
 * "skipTidBoundary" must not look like a call site.
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
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (two === '/*') {
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

/**
 * The LOCAL names a module exports through a separate `export { … }` list, as
 * opposed to an `export` keyword sitting on the declaration.
 *
 * Keying on the adjacent keyword alone was measured to miss
 * `const f = async (…) => {…}; export { f };` — the declaration and its export
 * are simply in two places, and section 8a then never derived it as a candidate.
 * Found by this file's own author against the round-4 fix, because a fix that has
 * only survived the review's list has survived a list. Both the local name and an
 * `as` alias are recorded; a name that matches no local declaration (a re-export
 * `export { x } from './y'`) simply never matches one.
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
  // "Exported" is the union of BOTH spellings — the keyword on the declaration
  // and a separate `export { … }` list — so a declaration cannot escape 8a by
  // moving its export one line down.
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
  while ((m = cRe.exec(masked)) !== null) {
    if (!isExported(m[2], m[3])) continue;
    const declAt = m.index + m[1].length;
    push(m[3], callableSpan(masked, declAt, m.index + m[0].length, true), m[4] ?? null);
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
function matchingClose(s, from) {
  let d = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') { d -= 1; if (d === 0) return i; }
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
 */
function classifyValue(value, binding, delegate, allowIsNull) {
  const t = value.trim();
  if (!t) return 'deny';
  if (binding && t === binding) return 'verdict';
  if (delegate && new RegExp(`^(?:await\\s+)?${delegate}\\s*\\(`).test(t)) return 'verdict';
  if (/\b(?:NextResponse|workspaceDenialResponse)\b/.test(t)) return 'deny';
  if (/^\{/.test(t) && /(?:^\{|[,{])\s*resp\s*[:,}]/.test(t)) return 'deny';
  if (/^(?:null|undefined)$/.test(t)) return allowIsNull ? 'allow' : 'deny';
  return 'allow';
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
 */
const candidates = [];
for (const file of authzFiles) {
  const rel = file.slice(CONSOLE_ROOT.length + 1);
  const masked = readMasked(file);
  const inAuthzModule = isWorkspaceAuthzModule(rel, masked);
  const namesAdminFlag = ISADMIN.test(masked);
  for (const fn of exportedFunctions(masked)) {
    const expanded = expandReturnType(masked, fn.returnType);
    if (!VERDICT_RETURN.test(expanded)) continue;
    const trigger =
      (inAuthzModule && 'module') ||
      (namesAdminFlag && /\bSessionPayload\b/.test(fn.params) && 'admin-flag') ||
      (WORKSPACE_PARAM.test(fn.params) && 'signature') ||
      null;
    if (!trigger) continue;
    candidates.push({ file, rel, masked, fn, expanded, trigger });
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

for (const c of candidates) {
  const key = `${c.rel}:${c.fn.name}`;
  if (NON_AUTHORIZERS.has(key)) { usedNonAuthorizers.add(key); continue; }
  authorizerNames.push(`${c.fn.name}[${c.trigger}]`);

  const body = c.fn.body;
  const allowIsNull = /\bNextResponse\b/.test(c.expanded);

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
      const allowIsNull = /\bNextResponse\b/.test(expandReturnType(masked, owner.returnType));
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
//         METHODS, and an anonymous `export default function`. Measured over this
//         tree: 17835 declarations before, 21050 after, with ZERO true drops (the
//         two apparent ones are a head-finder mis-span it now gets right and a
//         `function wrapping <code>` in JSX PROSE it now correctly refuses).
//         What is STILL outside it: a callable reached only through a computed
//         property (`obj['authorize'] = …`), a type annotation that spans a
//         newline, and a `{ a: string }` object RETURN TYPE, whose brace is taken
//         for the body brace — the last of these makes the "body" a type literal
//         and the assertions over it vacuous, so it is a blind spot, not a false
//         accusation.
//       - it keys on the `isTenantAdmin(` TOKEN, so a bypass that re-derives the
//         admin verdict without naming it — measured example
//         `if (session.claims.oid === process.env.LOOM_TENANT_ADMIN_OID) return null;`
//         — is INVISIBLE here. Inside `lib/auth/**` sections 8a-8e catch that
//         variant structurally. Everywhere ELSE in the repo THE SPECS ARE THE
//         BACKSTOP, not this scan. Do not read a green 8h as "no bypass"; read it
//         as "no bypass of the shapes 8h can see".
//       - the signature filter is what let N6c through inside `lib/auth`; that
//         file set no longer depends on it (8a derives by module, not by
//         parameter name). Out here the filter stays, and this limit with it:
//         MEASURED on this tree, 14 named functions carry the
//         admin-flag-grants-alone shape and 13 of them are NOT workspace-scoped
//         by signature, so 8h never opens them. The 14th is
//         `resolveAdminWorkspace`, which 8a-8e own. A route-level authorizer that
//         calls its parameter `id` is therefore outside 8h, exactly as N6c was
//         outside the old section 8.
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
      const allowIsNull = /\bNextResponse\b/.test(expandReturnType(masked, fn.returnType));
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
console.log(`[tid-boundary-chokepoint] guarded call sites: ${callSites}  ` +
            `(skipTidBoundary users: ${skipUsers.length}, allowlisted: ${used.size})`);
console.log(`[tid-boundary-chokepoint] authorizers DERIVED from ${AUTHZ_DIR}: ` +
            `${candidates.length} verdict-returning export(s) — ${authorizerNames.length} checked ` +
            `for delegation + ALLOW implication, ${usedNonAuthorizers.size} classified ` +
            `non-authorizer(s); pins in use: ${usedProloguePins.size} prologue, ` +
            `${usedPostPins.size} post-delegation (#3825)`);
console.log(`[tid-boundary-chokepoint]   checked: ${authorizerNames.join(', ')}`);
console.log(`[tid-boundary-chokepoint] repo-wide admin-shape scan: ${adminShapeFunctions} ` +
            `function(s) whose OWN body grants on an isTenantAdmin-bearing condition, of ` +
            `which ${adminShapeWorkspaceScoped} are workspace-scoped by signature (#3825)`);

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
