/**
 * #4619 / #4621 — THE MUTATION ARMS for the server-derived-scope guard, AS DATA.
 *
 * Every arm below is a source edit that SHOULD break at least one spec. Running
 * them is what turns "25 specs pass" into "25 specs have kill power", which is
 * the distinction `.claude/rules/assertion-design.md` is about: a suite that
 * cannot fail is not evidence.
 *
 * WHY THIS FILE EXISTS AT ALL. The first six rounds of #4621 ran this matrix
 * from scratch tooling under `temp/`, and review's standing finding was that the
 * receipt could therefore be believed but not re-derived. It is landed here,
 * under the repo's existing `__tests__/mutation/{mutations,run-arms}.mjs`
 * convention, so the table in the PR body is reproducible from the tree by
 * anyone:
 *
 *     cd apps/fiab-console
 *     node app/api/items/_lib/__tests__/mutation/run-arms.mjs
 *     node app/api/items/_lib/__tests__/mutation/run-arms.mjs A16   # one arm
 *
 * That convention is stated precisely here, because a loose count is the class
 * of thing this PR keeps being blocked on: FIVE packages carried a
 * `__tests__/mutation/` directory before this one, four of them with exactly
 * this `{mutations,run-arms}.mjs` filename pair — `lib/foundry`'s runner is
 * named `run-sql-ref-guard-arms.mjs`. Derive it rather than trusting the
 * sentence, with a needle that has no `*` + `/` in it, because that sequence
 * would END this very comment — a bug the first draft of these lines shipped
 * and `node` caught on the next run:
 *
 *     git ls-files | grep -E 'mutation/run-arms\.mjs$'     # 5, with this one
 *
 * RUN IT IN A `git worktree`, not your lane tree. The runner restores every file
 * from an in-memory copy in a `finally` and re-checks the tree, but
 * `assertion-design.md` "done" #2 prefers a sandbox copy outright, and
 * `tools/drain/mutate_gates.py` refuses any run where the tracked tree changed.
 *
 * ── POPULATIONS ────────────────────────────────────────────────────────────
 * Most arms run against the whole guarded population, because the guard is
 * shared and a kill anywhere in it is a kill. TWO do not, and the reason is the
 * point of the arm rather than an optimisation: `A18` mutates `withSession`,
 * which EVERY toolkit route composes on, so over the wide population it would go
 * red for a hundred reasons that have nothing to do with the route under test.
 * Scoped to the versions suite, a kill is attributable to one assertion.
 *
 * `A18-control` is the positive control for that scoping: the SAME mutation
 * against the definition suite, which has always carried its own 401 arm. If
 * `A18-control` ever reports SURVIVED, the instrument has gone blind and `A18`'s
 * verdict means nothing — so it is declared as an arm rather than described in
 * prose.
 *
 * ── THE ANCHORS ────────────────────────────────────────────────────────────
 * Each `find` is asserted by the runner to match EXACTLY ONCE before anything is
 * written. That assertion is not ceremony: on 2026-09-24 an independent
 * reviewer's first sweep of this very PR reported 10/10 NOT-RUN because the
 * sandbox checked the files out CRLF while the anchors were LF. Without the
 * exactly-once check every arm would have been a silent no-op over a green tree
 * — indistinguishable from ten kills. The runner normalises to LF for matching
 * and restores the original endings on write, so both checkouts work.
 */

/**
 * Suite sets, with the floor each must clear before its arms are trusted.
 *
 * `minTests` guards the failure mode where the runner executes nothing: a green
 * run that collected ZERO tests scores every arm as CAUGHT, because every arm
 * "fails" when nothing runs. Measured at `1154812b`; RAISE these as the suites
 * grow, never lower them.
 */
export const POPULATIONS = {
  /** The guarded surface: every suite that exercises a writer, the helper, or a reader. */
  guarded: {
    suites: [
      'lib/workspace',
      'lib/versions',
      'app/api/items/_lib',
      'app/api/cosmos-items',
      'app/api/deployment-pipelines',
    ],
    minTests: 300,
  },
  /** Just the item-version suite — the only one that drives the restore POST. */
  versions: {
    suites: ['app/api/items/[type]/[id]/versions/__tests__/'],
    minTests: 8,
  },
  /** The definition suite, used ONLY as the positive control for A18. */
  definition: {
    suites: ['app/api/items/[type]/[id]/definition/__tests__/'],
    minTests: 8,
  },
};

const SCOPE = 'app/api/items/_lib/server-derived-scope.ts';
const ITEM_CRUD = 'app/api/items/_lib/item-crud.ts';
const GENERIC_PATCH = 'app/api/items/[type]/[id]/route.ts';
const COSMOS_PATCH = 'app/api/cosmos-items/[type]/[id]/route.ts';
const DEFINITION_PUT = 'app/api/items/[type]/[id]/definition/route.ts';
const RESTORE_POST = 'app/api/items/[type]/[id]/versions/[versionId]/restore/route.ts';
const BUNDLE_IO = 'lib/workspace/workspace-bundle-io.ts';
const PROMOTE = 'app/api/deployment-pipelines/loom/_lib/promote.ts';
const ADX_SCOPE = 'app/api/items/_lib/adx-item-scope.ts';
const ROUTE_TOOLKIT = 'lib/api/route-toolkit.ts';

/** The three-line `carry` used verbatim by the two generic PATCH routes. */
const PATCH_CARRY = `    const carriedState = nextState && typeof nextState === 'object'
      ? carryServerDerivedScope(nextState as Record<string, unknown>, item.state)
      : nextState;`;

/** The key list, mutated whole so an arm cannot half-apply. */
const KEY_LIST = `export const SERVER_DERIVED_SCOPE_KEYS: readonly string[] = [
  'provisioning',
  'storageAccount',
];`;

/** The carry's rebase branch — three arms target it, each differently. */
const CARRY_BRANCH = `    if (hasOwnStateKey(currentState, key)) out[key] = currentState[key];
    else delete out[key];`;

export const MUTATIONS = [
  // ── the CARRY, at each writer that has to hold it itself ──────────────────
  {
    id: 'A1',
    population: 'guarded',
    expect: 'caught',
    why: 'the generic item PATCH builds and writes its own document, so the helper-level carry never reaches it',
    edits: [{ file: GENERIC_PATCH, find: PATCH_CARRY, replace: '    const carriedState = nextState;' }],
  },
  {
    id: 'A2',
    population: 'guarded',
    expect: 'caught',
    why: 'same shape as A1 at the cosmos-items twin',
    edits: [{ file: COSMOS_PATCH, find: PATCH_CARRY, replace: '    const carriedState = nextState;' }],
  },
  {
    id: 'A3',
    population: 'guarded',
    expect: 'caught',
    why: 'the shared save chokepoint behind every per-type editor',
    edits: [{
      file: ITEM_CRUD,
      find: `  const patchedState = patch.state && typeof patch.state === 'object'
    ? carryServerDerivedScope(patch.state as Record<string, unknown>, current.state)
    : patch.state;`,
      replace: '  const patchedState = patch.state;',
    }],
  },
  // ── the ASSERT, and the depth-blind widening ──────────────────────────────
  {
    id: 'A4',
    population: 'guarded',
    expect: 'caught',
    why: 'reverts the cosmos-items PATCH to the NARROW scope assert, dropping the #3611 depth-blind keys and the __proto__ refusal',
    edits: [
      {
        file: COSMOS_PATCH,
        find: '  assertNoServerOwnedStateChange, carryServerDerivedScope, ServerOwnedStateError,',
        replace: '  assertNoServerDerivedScopeChange, carryServerDerivedScope, ServerOwnedStateError,',
      },
      {
        file: COSMOS_PATCH,
        find: '      assertNoServerOwnedStateChange(nextState, item.state);',
        replace: '      assertNoServerDerivedScopeChange(nextState, item.state);',
      },
    ],
  },
  {
    id: 'A5',
    population: 'guarded',
    expect: 'caught',
    why: 'the ADX receipt branch never engages — the PRE-FLIP behaviour, where a client-writable declared field outranked the server receipt',
    edits: [{
      file: ADX_SCOPE,
      find: "  if (prov && (prov.status === 'created' || prov.status === 'exists')) {",
      replace: "  if (prov && (prov.status === '__mutant_A5_never__')) {",
    }],
  },
  {
    id: 'A6',
    population: 'guarded',
    expect: 'caught',
    why: 'removes the assert from the generic item PATCH, leaving the carry to silently substitute what should be a 400',
    edits: [{
      file: GENERIC_PATCH,
      find: `    try {
      assertNoServerOwnedStateChange(nextState, item.state);
    } catch (e: any) {`,
      replace: `    try {
      /* MUTANT A6 — assert removed */
    } catch (e: any) {`,
    }],
  },
  // ── the KEY LIST and the two helpers ──────────────────────────────────────
  {
    id: 'A7',
    population: 'guarded',
    expect: 'caught',
    why: "drops 'provisioning' from the guarded key list",
    edits: [{
      file: SCOPE,
      find: KEY_LIST,
      replace: `export const SERVER_DERIVED_SCOPE_KEYS: readonly string[] = [
  'storageAccount',
];`,
    }],
  },
  {
    id: 'A8',
    population: 'guarded',
    expect: 'caught',
    why: "drops 'storageAccount' — the T3 grant coordinate `api/storage/_lib/authorize.ts` reads",
    edits: [{
      file: SCOPE,
      find: KEY_LIST,
      replace: `export const SERVER_DERIVED_SCOPE_KEYS: readonly string[] = [
  'provisioning',
];`,
    }],
  },
  {
    id: 'A9',
    population: 'guarded',
    expect: 'caught',
    why: 'the carry copies the SOURCE value through instead of rebasing onto the target — the promote.ts hazard, and a silent substitution everywhere else',
    edits: [{
      file: SCOPE,
      find: CARRY_BRANCH,
      replace: `    if (hasOwnStateKey(nextState, key)) out[key] = (nextState as Record<string, unknown>)[key];
    else delete out[key];`,
    }],
  },
  {
    id: 'A10',
    population: 'guarded',
    expect: 'caught',
    why: 'the carry drops its else/delete branch, so a key the TARGET does not carry survives from the source',
    edits: [{
      file: SCOPE,
      find: CARRY_BRANCH,
      replace: '    if (hasOwnStateKey(currentState, key)) out[key] = currentState[key];',
    }],
  },
  {
    id: 'A11',
    population: 'guarded',
    expect: 'caught',
    why: 'rejects on PRESENCE instead of on CHANGE — which would 400 the near-universal `{ ...item.state, oneField }` save behind every editor',
    edits: [{
      file: SCOPE,
      find: '    if (hasOwnStateKey(currentState, key) && stableStringify(currentState[key]) === incoming) continue;',
      replace: '    /* MUTANT A11 — the unchanged-round-trip escape is removed */',
    }],
  },
  {
    id: 'A12',
    population: 'guarded',
    expect: 'caught',
    why: 'JSON.stringify instead of stableStringify, so KEY ORDER reads as a value change and a reordered round trip becomes a 400',
    edits: [
      {
        file: SCOPE,
        find: '    const incoming = stableStringify(nextState[key]);',
        replace: '    const incoming = JSON.stringify(nextState[key]);',
      },
      {
        file: SCOPE,
        find: 'stableStringify(currentState[key]) === incoming',
        replace: 'JSON.stringify(currentState[key]) === incoming',
      },
    ],
  },
  // ── the cross-item copy ───────────────────────────────────────────────────
  {
    id: 'A13',
    population: 'guarded',
    expect: 'caught',
    why: "promote.ts reverts to the raw SOURCE state, writing the source's receipt over the target's own",
    edits: [{
      file: PROMOTE,
      find: '      state: carryServerDerivedScope(promotedState, targetState),',
      replace: '      state: promotedState,',
    }],
  },
  // ── the three writers a key-name grep could not see ───────────────────────
  {
    id: 'A14',
    population: 'guarded',
    expect: 'caught',
    why: 'WRITER 5 — the definition PUT, which is PAT-reachable as `updateItemDefinition`: removes the CARRY, so an omission deletes the key',
    edits: [{
      file: DEFINITION_PUT,
      find: `  const carriedState = carryServerDerivedScope(
    applied.state as Record<string, unknown>,
    current.state,
  );`,
      replace: '  const carriedState = applied.state as Record<string, unknown>;',
    }],
  },
  {
    id: 'A15',
    population: 'guarded',
    expect: 'caught',
    why: 'WRITER 5 — removes the ASSERT from the definition PUT, so a GET/PUT round trip can CHANGE the key',
    edits: [{
      file: DEFINITION_PUT,
      find: `  try {
    assertNoServerDerivedScopeChange(applied.state, current.state);
  } catch (e: any) {`,
      replace: `  try {
    /* MUTANT A15 — assert removed */
  } catch (e: any) {`,
    }],
  },
  {
    id: 'A16',
    population: 'guarded',
    expect: 'caught',
    why: 'WRITER 6 — the version-restore POST, the laundering path: a version recorded through the unguarded PATCH could be restored past the guard',
    edits: [{
      file: RESTORE_POST,
      find: `    const restoredState = carryServerDerivedScope(
      (version.content?.state ?? live.state ?? {}) as Record<string, unknown>,
      live.state,
    );`,
      replace: '    const restoredState = (version.content?.state ?? live.state ?? {}) as Record<string, unknown>;',
    }],
  },
  {
    id: 'A17',
    population: 'guarded',
    expect: 'caught',
    why: "WRITER 7 — the bundle import OVERWRITE arm, which DELETED the target's receipt on every import, because `workspace-export.ts:186` strips it from every bundle by design",
    edits: [{
      file: BUNDLE_IO,
      find: `      const overwriteState = carryServerDerivedScope(
        (planned.overwrite.state ?? {}) as Record<string, unknown>,
        existing.state,
      );`,
      replace: '      const overwriteState = (planned.overwrite.state ?? {}) as Record<string, unknown>;',
    }],
  },
  // ── the 401 the route-toolkit migration inherited ─────────────────────────
  {
    id: 'A18',
    population: 'versions',
    expect: 'caught',
    why: "the migrated restore route's 401. SURVIVED before #4621 round 7 added the arm — the versions suite's only 401 test drove the sibling GET, a different module, so nothing in the tree witnessed this route's contract while the commit message asserted it",
    edits: [{
      file: ROUTE_TOOLKIT,
      find: '    if (!session) return apiUnauthorized();',
      replace: '    if (!session) { /* MUTANT A18 — unauthorized branch disabled */ }',
    }],
  },
  {
    id: 'A18-control',
    population: 'definition',
    expect: 'caught',
    why: 'POSITIVE CONTROL for A18: the same mutation against a suite that has always carried a 401 arm. If this ever SURVIVES, the instrument cannot see a 401 break and A18 proves nothing',
    edits: [{
      file: ROUTE_TOOLKIT,
      find: '    if (!session) return apiUnauthorized();',
      replace: '    if (!session) { /* MUTANT A18 — unauthorized branch disabled */ }',
    }],
  },
];
