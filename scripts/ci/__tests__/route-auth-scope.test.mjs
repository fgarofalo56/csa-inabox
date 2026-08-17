/**
 * CONTROLS ON THE ROUTE AUTH CLASSIFIER (#3625)
 * ===========================================================================
 * `scripts/ci/_route-auth-scope.mjs` decides the `owner-scoped` column of
 * `docs/fiab/route-inventory.md`. The column it replaced was a 30-name regex
 * containing the bare token `claims.oid`, and **271 of 773 published
 * `owner-scoped` rows rested on that token and nothing else** — a log field, a
 * FinOps attribution field, or a Cosmos partition key reported as an
 * authorization check.
 *
 * This suite has three jobs, in order of how much they matter:
 *
 * 1. **The classifier's own controls run** (`selfTest()`), including the
 *    negative ones. A control set that only models the SAFE pattern passes on
 *    the tree that produced the defect — #3468's lesson, one guard over.
 *
 * 2. **The derivation's INPUTS are alive.** #3639's self-control: a parser that
 *    silently matched nothing would let every assertion below pass against any
 *    tree. So the graph size, the resolver population and the route population
 *    all have floors, and known-true / known-false members are named.
 *
 * 3. **The four routes #3625 names classify correctly ON THE REAL TREE**, and —
 *    the part that distinguishes a fix from a coincidence — `warehouse/[id]/
 *    query` stays `owner-scoped` when its `recordQueryRun` LOG LINE is deleted,
 *    and stops being `owner-scoped` when its GUARD is deleted. Mutation, not
 *    assertion.
 *
 * Run: node --test scripts/ci/__tests__/route-auth-scope.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildGraph,
  deriveResolvers,
  deriveSessionFns,
  assertSeedsExist,
  classifyRouteOwnership,
  analyzeSynthetic,
  parseDeclarations,
  findBodyStart,
  hasInlineOwnerCheck,
  maskSource,
  keyOf,
  selfTest,
  CONTROLS,
  ROOT_AUTHORIZERS,
  SESSION_ROOTS,
  AUTH_SHAPED_EXEMPT,
  CONSOLE_ROOT,
} from '../_route-auth-scope.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// One graph for the whole suite — building it walks 4,000+ files.
let cached = null;
function tree() {
  if (!cached) {
    const graph = buildGraph({ repoRoot: REPO_ROOT });
    const resolvers = deriveResolvers(graph);
    const sessionFns = deriveSessionFns(graph);
    const routes = graph.files.filter(
      (f) => f.startsWith(`${CONSOLE_ROOT}/app/api/`) && f.endsWith('/route.ts'),
    );
    cached = { graph, resolvers, sessionFns, routes };
  }
  return cached;
}

const classify = (rel) => {
  const { graph, resolvers, sessionFns } = tree();
  return classifyRouteOwnership(graph, resolvers, `${CONSOLE_ROOT}/app/api/${rel}`, sessionFns);
};

// ───────────────────────────────────────────────────────────────────────────
// 1. THE CLASSIFIER'S OWN CONTROLS
// ───────────────────────────────────────────────────────────────────────────

test('every embedded control passes', () => {
  assert.deepEqual(selfTest(), []);
});

test('the control set contains BOTH directions, and the negative half is not token', () => {
  const positive = CONTROLS.filter((c) => c.expect.owner).length;
  const negative = CONTROLS.filter((c) => !c.expect.owner).length;
  assert.ok(positive >= 5, `only ${positive} must-flag controls`);
  assert.ok(negative >= 5, `only ${negative} must-NOT-flag controls`);
  // The incident itself must be in the set. A control set that does not contain
  // the incident cannot prove the classifier would have caught it.
  assert.ok(CONTROLS.some((c) => /INCIDENT #3625/.test(c.name)));
});

test('MUTATION — breaking the classifier fails a control (the controls have teeth)', () => {
  // Feed the incident control's source through the analyzer with the LOG FIELD
  // swapped for a real guard call: the verdict must FLIP. If it does not, the
  // classifier is not reading the code at all.
  const incident = CONTROLS.find((c) => /INCIDENT #3625/.test(c.name));
  const route = Object.keys(incident.files)[0];
  const src = incident.files[route];
  assert.equal(analyzeSynthetic(incident.files).owner, false);

  const guarded = src
    .replace(
      "import { recordQueryRun } from '@/lib/finops/query-run';",
      "import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';",
    )
    .replace(
      "  void recordQueryRun({ userOid: session.claims.oid, itemId: id, itemType: 'warehouse' });",
      "  const item = await loadOwnedItem(id, 'warehouse', session.claims.oid, {});\n  if (!item) return notFound();",
    );
  assert.equal(analyzeSynthetic({ [route]: guarded }).owner, true);
});

/**
 * FALSIFICATION — break the ANALYZER itself, four ways, and require each break
 * to turn a control red.
 *
 * A control set is only evidence if it fails when the thing it watches is
 * broken. This repo has repeatedly shipped the opposite: five controls in
 * `check-external-origin-urls` all modelled the SAFE pattern and passed on a
 * tree carrying a live defect (#3468); `check-copilot-evals` measured nothing
 * for months. Two of the four mutations below were GREEN on the first draft of
 * this file — the prose control did not import the symbol it quoted (so the name
 * resolved to nothing and comment-stripping was irrelevant to it), and the
 * structural-wrapper control was not refusal-carrying (so the exemption it was
 * meant to exercise never ran). Both were fixed by strengthening the CONTROL,
 * not by weakening the mutation.
 *
 * Runs against a patched COPY in a temp dir — the real file is never touched,
 * so a SIGKILL mid-test cannot leave the checkout mutated.
 */
test('FALSIFICATION — four breaks of the analyzer, each must turn a control red', async () => {
  const analyzerPath = path.join(REPO_ROOT, 'scripts/ci/_route-auth-scope.mjs');
  // NORMALISED TO LF BEFORE PATCHING. Three of the four mutants below match a
  // single-line needle and are indifferent; the structural-wrapper one spans two
  // lines, and a `\n` needle cannot match a file checked out CRLF. On Windows
  // that mutation silently failed to apply, so this control was RED for every
  // Windows contributor and green on Linux CI — a control whose verdict depended
  // on `core.autocrlf` rather than on the analyzer.
  //
  // It failed LOUDLY (`did not apply — it proves nothing`) rather than passing
  // vacuously, which is the assert-on-apply design working exactly as intended:
  // the harness refused to claim a mutation it had not actually made. Same fix
  // `reconcile-policy.test.mjs` already uses via its `readNorm()` reader.
  const original = fs.readFileSync(analyzerPath, 'utf8').replace(/\r\n/g, '\n');

  const MUTANTS = [
    {
      id: 'the bare `claims.oid` token counts as an owner signal again (#3625 restored)',
      patch: (s) =>
        s.replace(
          "  let owner = why.some((w) => w.includes('→'));",
          "  let owner = why.some((w) => w.includes('→')) || /claims\\s*\\??\\.\\s*(?:oid|tid|tenantId)/.test(mod.code);",
        ),
    },
    {
      id: 'comments are no longer stripped (a name in a comment authorizes again, #2977)',
      patch: (s) => s.replace('return { code: stripCommentsAndStrings(raw)', 'return { code: String(raw)'),
    },
    {
      id: 'the structural-wrapper exemption is removed',
      patch: (s) =>
        s.replace(
          '  for (const verb of HTTP_METHODS) {\n    const span = mod.decls.get(verb);',
          '  for (const verb of []) {\n    const span = mod.decls.get(verb);',
        ),
    },
    {
      id: 'unknowns stop being reported (fall back to the reassuring answer)',
      patch: (s) =>
        s.replace(
          '  return { owner, session, sessionVia, why, unknowns: owner ? [] : unknowns };',
          '  return { owner, session, sessionVia, why, unknowns: [] };',
        ),
    },
  ];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-auth-falsify-'));
  try {
    // `_gate-consumption.mjs` travels with it so the relative import resolves.
    fs.copyFileSync(
      path.join(REPO_ROOT, 'scripts/ci/_gate-consumption.mjs'),
      path.join(dir, '_gate-consumption.mjs'),
    );
    for (const [i, m] of MUTANTS.entries()) {
      const patched = m.patch(original);
      assert.notEqual(patched, original, `mutation "${m.id}" did not apply — it proves nothing`);
      const file = path.join(dir, `mutant-${i}.mjs`);
      fs.writeFileSync(file, patched);
      const mod = await import(pathToFileURL(file).href);
      const failures = mod.selfTest();
      assert.ok(
        failures.length > 0,
        `MUTATION SURVIVED: "${m.id}" — every control still passed, so the control set cannot see this break`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE DERIVATION'S INPUTS ARE ALIVE (#3639's self-control)
// ───────────────────────────────────────────────────────────────────────────

test('the seeds NAME REAL FUNCTIONS — the #2977 control', () => {
  assert.deepEqual(assertSeedsExist(tree().graph), []);
  assert.ok(ROOT_AUTHORIZERS.length >= 1);
  assert.ok(SESSION_ROOTS.length >= 1);
});

test('a seed that no longer exists FAILS rather than deriving a tiny set', () => {
  const graph = buildGraph({
    repoRoot: '/synthetic',
    files: ['apps/fiab-console/lib/auth/session.ts'],
    readFile: () => 'export function getSession() { return null; }',
  });
  const bad = assertSeedsExist(graph);
  assert.ok(bad.length >= 1, 'a missing seed module must be reported');
  assert.ok(bad.some((b) => b.includes('workspace-access')));
});

test('the graph is a plausible size — a broken enumeration must fail HERE', () => {
  const { graph } = tree();
  // ~4,131 tracked non-test .ts/.tsx under apps/fiab-console today.
  assert.ok(graph.files.length > 3000, `graph collapsed to ${graph.files.length} files`);
});

test('the route population is plausible', () => {
  const { routes } = tree();
  // 1,680 today. A collapse means the walk broke, not that the API was deleted.
  assert.ok(routes.length > 1400, `only ${routes.length} routes enumerated`);
});

test('the resolver set is plausible AND contains the wrappers a hand list kept missing', () => {
  const { resolvers } = tree();
  assert.ok(resolvers.size > 100, `resolver set collapsed to ${resolvers.size}`);
  // Each of these had to be hand-added to the old OWNER_RE **after** a route
  // using it published the wrong scope. The derivation must find them itself.
  const expected = [
    [`${CONSOLE_ROOT}/app/api/items/_lib/item-crud.ts`, 'loadOwnedItem'],
    [`${CONSOLE_ROOT}/app/api/items/_lib/adx-item-scope.ts`, 'guardAdxItemRequest'],
    [`${CONSOLE_ROOT}/app/api/items/_lib/synapse-item-scope.ts`, 'guardSynapseItemRequest'],
    [`${CONSOLE_ROOT}/app/api/items/_lib/sql-server-scope.ts`, 'withBoundSqlServer'],
    [`${CONSOLE_ROOT}/app/api/items/_lib/sql-server-scope.ts`, 'loadOwnedSqlItem'],
    [`${CONSOLE_ROOT}/app/api/items/databricks-job/_lib/job-scope.ts`, 'authorizeDatabricksJobItem'],
    [`${CONSOLE_ROOT}/app/api/items/databricks-notebook/_lib/notebook-exec-scope.ts`, 'authorizeNotebookItem'],
    [`${CONSOLE_ROOT}/app/api/items/databricks-pipeline/_lib/pipeline-scope.ts`, 'authorizeDatabricksPipelineItem'],
    [`${CONSOLE_ROOT}/app/api/storage/_lib/authorize.ts`, 'authorizeStorageAccount'],
    [`${CONSOLE_ROOT}/lib/api/route-toolkit.ts`, 'withWorkspaceOwner'],
    [`${CONSOLE_ROOT}/lib/auth/workspace-guard.ts`, 'authorizeItemWorkspace'],
    [`${CONSOLE_ROOT}/lib/auth/item-access.ts`, 'resolveItemAccessByOid'],
  ];
  for (const [mod, sym] of expected) {
    assert.ok(resolvers.has(keyOf(mod, sym)), `derivation missed ${mod}::${sym}`);
  }
});

test('the resolver set does NOT sweep in telemetry — the #3625 defect, inverted', () => {
  const { resolvers } = tree();
  // `recordQueryRun` is the function whose `userOid` argument made
  // `items/warehouse/[id]/query` publish owner-scoped with no authorization.
  const bad = [...resolvers].filter((k) => /recordQueryRun|writeAudit|logSafe/.test(k));
  assert.deepEqual(bad, []);
});

test('session derivation finds the wrappers SESSION_RE does not name', () => {
  const { sessionFns } = tree();
  assert.ok(sessionFns.size > 50, `session set collapsed to ${sessionFns.size}`);
  assert.ok(sessionFns.has(keyOf(`${CONSOLE_ROOT}/app/api/adx/_shared.ts`, 'guardAdxRequest')));
  assert.ok(sessionFns.has(keyOf(`${CONSOLE_ROOT}/lib/api/route-toolkit.ts`, 'withSession')));
});

// ───────────────────────────────────────────────────────────────────────────
// 3. THE FOUR ROUTES #3625 NAMES — on the real tree, proved by MUTATION
// ───────────────────────────────────────────────────────────────────────────

/**
 * The four routes #3625 names. ALL FOUR ARE NOW GUARDED — the last of them,
 * `items/databricks-sql-warehouse/[id]/query`, was hardened under
 * GHSA-v2g8-gp3r-rg4r's seventh pass (`withSession` + `guardSynapseItemRequest`,
 * write-scoped), and the assertion below moved with it rather than being
 * deleted.
 *
 * WHY IT WAS THE FOURTH FOR SO LONG, kept because it is the classifier's
 * canonical worked example: it was `withSession` only, `warehouseId` came from
 * the BODY, and `[id]` was read exclusively for the FinOps receipt. Its only
 * owner-shaped tokens were `routeParams.id` and `session.claims.oid`, BOTH
 * inside `recordQueryRun`. Under the old `OWNER_RE` that published
 * `owner-scoped`; the derived column correctly said `session-only` until a real
 * guard landed.
 *
 * THE NEGATIVE HALF IS REPOINTED, NOT RETIRED — see {@link STILL_UNGUARDED}.
 */
const GUARDED = [
  'items/warehouse/[id]/query/route.ts',
  'items/synapse-dedicated-sql-pool/[id]/query/route.ts',
  'items/azure-sql-database/[id]/mirroring/route.ts',
  'items/databricks-sql-warehouse/[id]/query/route.ts',
];

/**
 * THE NEGATIVE DIRECTION OF THIS CONTROL SET. It must never be empty.
 *
 * This file's own header records why: a control set that models only the SAFE
 * pattern passes on the very tree that produced the defect. So when the fourth
 * route was hardened, this constant was REPOINTED rather than removed.
 *
 * The replacement is chosen to preserve the DISCRIMINATION being tested, not
 * merely to name something unguarded. An unguarded route with no owner-shaped
 * tokens at all would be a weak negative — it would classify correctly even
 * under the broken `OWNER_RE`. `items/synapse-serverless-sql-pool/[id]/query`
 * is the strong form, and is a near-twin of `synapse-dedicated-sql-pool/[id]/
 * query` in the GUARDED list above, so both directions are exercised on almost
 * identical shapes. VERIFIED AT SOURCE, not inferred from the column:
 *
 *   :24  `withSession(async (req, { session, params }) => {`  — no item guard
 *   :28  `const { id } = params;`  — the id IS read...
 *   :41  ...but only by `resolveAccessMode(id, 'synapse-serverless-sql-pool')`,
 *        which picks OBO-vs-managed-identity mode. It is not an authorization.
 *   :31  `const database = (body?.database || 'master').toString();` — the
 *        coordinate comes from the request
 *   :47  `getUserSqlToken(session.claims.oid)`   — a TOKEN MINT
 *   :69  `userOid: session.claims.oid`           — a FinOps ATTRIBUTION field
 *
 * So: two `claims.oid` reads and a consumed route id, and still no per-item
 * ownership check. That is exactly the shape the derivation must not be fooled
 * by.
 *
 * ITS SEVERITY, BOTH BRANCHES — and the DEFAULT is the service identity.
 * An earlier revision of this comment said the route "runs the statement through
 * OBO … therefore NOT an open cross-tenant hole". That was materially
 * incomplete, and incompleteness in a section headed "severity" is the
 * `deploy-integrity.md` R7 shape: asserting something the code does not
 * establish. Corrected, with both branches named:
 *
 *   `accessMode === 'user'`    :59 → `executeQueryAsUser(…, userToken, …)`.
 *        The caller's OWN Azure identity runs the statement, so their SQL RBAC
 *        is consulted. This branch is genuinely mitigated.
 *   `accessMode === 'service'` :61 → `executeQuery(serverlessTarget(database),
 *        sqlText, …)` as the CONSOLE identity, with `database` from the body
 *        (:31) and no ownership check. **This is the DEFAULT** —
 *        `lib/azure/sql-access-mode.ts` documents `'service'` as "the
 *        always-works default", `normalizeAccessMode` returns it for anything
 *        that is not the literal `'user'` (:48-50), and `resolveAccessMode`
 *        returns it on ANY miss or thrown lookup (:70-72). An item only leaves
 *        it after an explicit PATCH /access-mode.
 *
 * So on the default branch this is the SAME class as the route it replaced, not
 * a milder one. It is pinned here because the CLASSIFIER must keep getting it
 * right, and it is a live finding in its own right — not a claim that the route
 * is safe. If it is ever hardened, move it into GUARDED and repoint this again.
 */
const STILL_UNGUARDED = 'items/synapse-serverless-sql-pool/[id]/query/route.ts';

test('the four GUARDED routes #3625 names are owner-scoped TODAY — and for a stated reason', () => {
  for (const rel of GUARDED) {
    const c = classify(rel);
    assert.equal(c.owner, true, `${rel} is not owner-scoped`);
    // The reason must be a RESOLVER (`→`) or an inline comparison — never a
    // token. A row whose only entry mentioned a log field would be the defect
    // reproduced.
    assert.ok(
      c.why.some((w) => w.includes('→') || w.startsWith('inline owner comparison')),
      `${rel} classified owner-scoped with no stated reason: ${JSON.stringify(c.why)}`,
    );
    assert.equal(c.unknowns.length, 0, `${rel} has unknowns: ${JSON.stringify(c.unknowns)}`);
  }
});

test('the NEGATIVE half still holds — a session-only route carrying owner-shaped tokens is not owner-scoped', () => {
  const c = classify(STILL_UNGUARDED);
  assert.equal(c.owner, false, `${STILL_UNGUARDED} now authorizes — move it into GUARDED and REPOINT STILL_UNGUARDED (do not delete it: the negative direction must survive)`);
  assert.equal(c.session, true, 'it does check a session; only the per-item authorization is missing');
});

test(
  'MUTATION — deleting the LOG LINE from warehouse/[id]/query does not change its verdict; ' +
    'deleting its GUARD does',
  () => {
    const rel = 'items/warehouse/[id]/query/route.ts';
    const abs = path.join(REPO_ROOT, CONSOLE_ROOT, 'app/api', rel);
    // `\r?` throughout: on a Windows checkout with core.autocrlf=true the
    // working-tree file is CRLF, and a mutation regex anchored on a bare `\n`
    // silently matches nothing — which reads as "the mutation proves the
    // classifier is watching" when it proves the opposite. The assertions below
    // check the mutation LANDED before checking what it did.
    const src = fs.readFileSync(abs, 'utf8');

    // The route as it stands.
    assert.equal(classify(rel).owner, true);

    // (a) remove EVERY `session.claims.*` read — the tokens the old OWNER_RE
    //     classified on. The verdict must HOLD, because the guard is the reason.
    const noTokens = src.replace(/session\.claims\.\w+/g, "'redacted'");
    assert.ok(!/claims\.(oid|tid|tenantId)/.test(maskSource(noTokens).code), 'mutation did not remove the tokens');
    assert.equal(
      analyzeOnTree(rel, noTokens).owner,
      true,
      'the verdict moved when only the LOG/attribution tokens were removed — it was resting on them',
    );

    // (b) remove the GUARD. The verdict must FLIP. A classifier whose answer
    //     does not change when the authorization is deleted is not watching it
    //     (csa_loom_route_guards_blind_three_ways).
    const noGuard = src
      .replace(/const guard = await guardSynapseItemRequest\([\s\S]*?\);\r?\n/, 'const guard = { ctx: {} };\n')
      .replace(/if \(guard\.res\) return guard\.res;\r?\n/, '');
    assert.ok(!/guardSynapseItemRequest\s*\(/.test(maskSource(noGuard).code), 'mutation did not remove the guard');
    assert.equal(
      analyzeOnTree(rel, noGuard).owner,
      false,
      'the route still reads owner-scoped with its guard deleted — the verdict is not code-backed',
    );
  },
);

/** Re-classify one route with a MUTATED source, against the real tree. */
function analyzeOnTree(rel, mutatedSource) {
  const target = `${CONSOLE_ROOT}/app/api/${rel}`;
  const { graph: base } = tree();
  const graph = buildGraph({
    repoRoot: REPO_ROOT,
    files: base.files,
    readFile: (f) =>
      f === target ? mutatedSource : fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'),
  });
  const resolvers = deriveResolvers(graph);
  const sessionFns = deriveSessionFns(graph);
  return classifyRouteOwnership(graph, resolvers, target, sessionFns);
}

// ───────────────────────────────────────────────────────────────────────────
// 4. LOCKSTEP — the derived set must not drift APART from check-route-guards
// ───────────────────────────────────────────────────────────────────────────

test('every ownership wrapper check-route-guards names is in the DERIVED set', () => {
  const { resolvers } = tree();
  const guardSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/check-route-guards.mjs'), 'utf8');
  const derivedNames = new Set([...resolvers].map((k) => k.slice(k.lastIndexOf('::') + 2)));
  // Read the names OUT OF the sibling checker rather than transcribing them, so
  // a name added there is checked here without anyone remembering to.
  const block = guardSrc.slice(guardSrc.indexOf('GUARD_SIGNAL_RE'));
  const named = [...block.matchAll(/'([A-Za-z_$][\w$]*)(?:\\\\s\*\\\\\()?'/g)].map((m) => m[1]);
  const ownershipNames = named.filter((n) =>
    /^(?:loadOwned|updateOwned|deleteOwned|createOwned|listOwned|listAllOwned|authorizeItemWorkspace|authorizeWorkspace|withWorkspaceOwner|guardAdxItemRequest|guardSynapseItemRequest|withBoundSqlServer|loadOwnedSqlItem|authorizeNotebookItem|authorizeDatabricksJobItem|authorizeDatabricksPipelineItem|authorizeStorageAccount|resolveItemAccessByOid|resolveWorkspaceAccessByOid)/.test(n),
  );
  assert.ok(ownershipNames.length >= 8, `only ${ownershipNames.length} ownership names read out of check-route-guards`);
  const missing = ownershipNames.filter((n) => !derivedNames.has(n));
  assert.deepEqual(
    missing,
    [],
    'check-route-guards names an ownership guard the derivation does not reach — the two have drifted apart',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5. THE PARSER ITSELF (the bugs that made the derivation silently empty)
// ───────────────────────────────────────────────────────────────────────────

test('findBodyStart skips a TypeScript return-type annotation containing braces', () => {
  // The real signature that broke it: item-crud.ts::createOwnedItem.
  const code = 'function f(a: string): Promise<{ ok: true; item: X } | { ok: false; status: number }> { return 1; }';
  const start = findBodyStart(code, code.indexOf(')') + 1);
  assert.equal(code[start], '{');
  assert.equal(code.slice(start, start + 10), '{ return 1');
});

test('findBodyStart handles a bare object return type, and an unannotated function', () => {
  const a = 'function f(): { ok: boolean } { return { ok: true }; }';
  assert.equal(a.slice(findBodyStart(a, a.indexOf(')') + 1), findBodyStart(a, a.indexOf(')') + 1) + 8), '{ return');
  const b = 'function POST(req) { return 1; }';
  assert.equal(b.slice(findBodyStart(b, b.indexOf(')') + 1), findBodyStart(b, b.indexOf(')') + 1) + 8), '{ return');
});

test('a value declaration is NOT a callable — `const x = (a || b).trim()`', () => {
  const decls = parseDeclarations("const sqlText = (body?.sql || '').toString().trim();\nfunction POST(req) { return 1; }");
  assert.ok(!decls.has('sqlText'), 'a parenthesised value initialiser was registered as a function');
  assert.ok(decls.has('POST'));
});

test('a verb export assigned from a CALL is a declaration (the toolkit form)', () => {
  const decls = parseDeclarations("export const GET = withWorkspaceOwner('x', async (req) => 1);");
  assert.ok(decls.has('GET'));
});

test('the inline owner check requires a REFUSAL, not just a comparison', () => {
  const refuses = 'const ws = await read(id);\nif (ws.tenantId !== session.claims.oid) return notFound();';
  const doesNot = 'const mine = ws.tenantId === session.claims.oid;\nreturn json({ mine });';
  assert.equal(hasInlineOwnerCheck(refuses, new Set()), true);
  assert.equal(hasInlineOwnerCheck(doesNot, new Set()), false);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. THE EXEMPT LIST IS SMALL AND EXPLAINED
// ───────────────────────────────────────────────────────────────────────────

test('every AUTH_SHAPED_EXEMPT entry carries a real reason, and the list stays small', () => {
  assert.ok(AUTH_SHAPED_EXEMPT.size <= 12, `exempt list has grown to ${AUTH_SHAPED_EXEMPT.size} — it is becoming the hand list this replaced`);
  for (const [name, why] of AUTH_SHAPED_EXEMPT) {
    assert.ok(typeof why === 'string' && why.length > 40, `${name} has no substantive reason recorded`);
  }
});

test('THE WHOLE TREE has no unknown route today — and unknowns are reachable, not dead code', () => {
  const { graph, resolvers, sessionFns, routes } = tree();
  const unknown = [];
  for (const f of routes) {
    const c = classifyRouteOwnership(graph, resolvers, f, sessionFns);
    // Routes under `admin/` publish `admin` regardless, so the generator does
    // not raise their unknowns; mirror that here.
    if (c.unknowns.length && !f.includes('/app/api/admin/')) unknown.push(`${f}: ${c.unknowns.map((u) => u.name).join(', ')}`);
  }
  assert.deepEqual(unknown, [], 'unresolved auth helpers — read each at its definition and record the verdict');

  // …and the unknown path is not dead: a synthetic new helper still fires it.
  const fired = analyzeSynthetic({
    'apps/fiab-console/app/api/items/_lib/new-scope.ts': 'export async function authorizeSomethingNew(id) { return true; }',
    'apps/fiab-console/app/api/items/control/[id]/route.ts': [
      "import { authorizeSomethingNew } from '@/app/api/items/_lib/new-scope';",
      'export async function GET(req, ctx) {',
      '  if (!(await authorizeSomethingNew(ctx.params.id))) return forbidden();',
      '  return json({ ok: true });',
      '}',
    ].join('\n'),
  });
  assert.equal(fired.unknowns.length, 1);
  assert.equal(fired.unknowns[0].name, 'authorizeSomethingNew');
  assert.ok(fired.unknowns[0].module.includes('new-scope'), 'the failure must NAME the module');
});
