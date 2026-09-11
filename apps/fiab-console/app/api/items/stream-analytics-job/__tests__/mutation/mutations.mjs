/**
 * #3573 / #4354 — THE MUTATION SET for the ASA R7 hint guard.
 *
 * Each arm removes or weakens one property `asa-routes-r7-hint.test.ts` claims.
 * The suite must go RED for every arm marked `expect: 'caught'`. An arm that
 * stays green is not a pass — it is a FINDING about the guard, and
 * `run-arms.mjs` prints it as one rather than folding it into a score.
 *
 * ── WHY THIS FILE IS COMMITTED ─────────────────────────────────────────────
 * The round-4 reviewer of #4354 wrote: "Your mutation harness … is not in the
 * diff (31 files, no harness) and lives only on your machine, so I could
 * neither confirm it exists nor watch it fire." A harness that only the author
 * can run is an unverifiable claim about a guard, which is the same defect
 * class the guard itself exists to remove. So it ships, in the directory it
 * measures, and it carries the arms that SURVIVED as well as the ones that
 * did not — the arm that found a gap is the arm most worth re-running.
 *
 * ── TWO SHAPES OF ARM ──────────────────────────────────────────────────────
 *   edits:  [{ file, find, replace, occurrences? }]  — needle-based source edits
 *   create: [{ file, content }]                      — NEW files, deleted after
 *
 * `occurrences` defaults to 1 and is ASSERTED, not hoped for: a needle that
 * matches zero times is a silent no-op that reads exactly like a catch
 * (`csa_loom_crlf_makes_mutation_needles_silently_noop`), and a needle that
 * matches three times mutates more than the arm describes. Either is reported
 * as NEEDLE-MISCOUNT, a third outcome distinct from caught and survived.
 *
 * ── LINE ENDINGS ───────────────────────────────────────────────────────────
 * The console sources here are CRLF in a Windows checkout and LF in the
 * repository. Needles below are written LF; `run-arms.mjs` matches against an
 * LF-normalised copy and restores the file's original ending style on write, so
 * the sweep is immune to the checkout it runs from.
 */

/** Every `file` is relative to `apps/fiab-console`. */
export const CONSOLE_RELATIVE = true;

const GUARD = 'app/api/items/stream-analytics-job/__tests__/asa-routes-r7-hint.test.ts';
const TEST_ROUTE = 'app/api/items/stream-analytics-job/[name]/test/route.ts';
const ITEM_DIR = 'app/api/items/stream-analytics-job';

/** The generic 502 catch in `[name]/test/route.ts`, exactly as it stands. */
const TEST_ROUTE_502 = [
  '    return NextResponse.json(',
  '      { ok: false, error: e?.message || String(e) },',
  '      { status: 502 },',
  '    );',
].join('\n');

const TEST_ROUTE_502_WITH_HINT = [
  '    return NextResponse.json(',
  '      { ok: false, error: e?.message || String(e), hint: HINT },',
  '      { status: 502 },',
  '    );',
].join('\n');

/** A route module carrying the exact #3573 defect, for the create-arms. */
function defectiveRoute({ importsClientDirectly }) {
  const clientImport = importsClientDirectly
    ? "import { getJob } from '@/lib/azure/stream-analytics-client';"
    : "import { getJob } from '../../_mut_asa';";
  const hint = importsClientDirectly
    ? "const HINT = 'Provision an ASA job (bicep: …stream-analytics.bicep, flag enableStreamAnalytics=true) and set LOOM_ASA_RG.';"
    : "import { ASA_HINT as HINT } from '../../_mut_hint';";
  return [
    "import { NextResponse } from 'next/server';",
    clientImport,
    hint,
    '',
    'export const GET = async () => {',
    '  try {',
    "    await getJob('x');",
    '    return NextResponse.json({ ok: true });',
    '  } catch (e) {',
    '    return NextResponse.json({ ok: false, error: String(e), hint: HINT }, { status: 502 });',
    '  }',
    '};',
    '',
  ].join('\n');
}

export const MUTATIONS = [
  // ── THE ORIGINAL BLOCKER (review of 2026-09-08) ───────────────────────────
  {
    id: 'hint-reinjected-into-test-route',
    why:
      'THE REQUIRED ARM, and the one the first version of this guard could not see. Puts the ' +
      'deleted LOOM_ASA_RG hint back on the GENERIC 502 of [name]/test/route.ts. Before the ' +
      'derivation existed this produced a byte-identical PASS, which is a guard being cited as ' +
      'proof of a property it never checked.',
    expect: 'caught',
    edits: [{ file: TEST_ROUTE, find: TEST_ROUTE_502, replace: TEST_ROUTE_502_WITH_HINT }],
  },
  {
    id: 'honest-501-gate-deleted',
    why:
      'The opposite direction, so "delete the hint everywhere" cannot pass either. Strips the ' +
      'hint from the NOT-CONFIGURED 501 in [name]/test/route.ts. R7 forbids asserting an ' +
      'unestablished cause; it does not forbid stating an established one, and an honest gate ' +
      'that quietly disappears is a regression in the other direction.',
    expect: 'caught',
    edits: [
      {
        file: TEST_ROUTE,
        find: "      return NextResponse.json({ ok: false, error: e.message, hint: HINT }, { status: 501 });",
        replace: "      return NextResponse.json({ ok: false, error: e.message }, { status: 501 });",
      },
    ],
  },

  // ── MUT-A (round-4 review, SURVIVED against the previous version) ─────────
  //
  // "The derivation trusts the row's `module` LABEL, not the module the row
  // actually drives." Both forms are kept: the relabel, and the stronger
  // ignore-the-handler form that the round-4 shape reduces to once the static
  // handler imports are gone.
  {
    id: 'mut-a-row-relabelled-to-another-module',
    why:
      'ROUND-4 MUT-A, form 1. Relabel the [name]/test row to [name]/query/route.ts and re-inject ' +
      'the hint into [name]/test/route.ts. Against the previous version this was byte-identically ' +
      'GREEN with the defect live. It must now fail on the undriven-module assertion, because ' +
      'relabelling a row moves its coverage with it and leaves the module it abandoned exposed.',
    expect: 'caught',
    edits: [
      {
        file: GUARD,
        find: "    name: 'POST /[name]/test',\n    module: '[name]/test/route.ts',\n    method: 'POST',",
        replace: "    name: 'POST /[name]/test',\n    module: '[name]/query/route.ts',\n    method: 'PUT',",
      },
      {
        file: GUARD,
        find: "    arrange: (err) => { client.compileQuery.mockRejectedValue(err); },\n    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),",
        replace: "    arrange: (err) => { client.saveTransformation.mockRejectedValue(err); },\n    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),",
      },
      { file: TEST_ROUTE, find: TEST_ROUTE_502, replace: TEST_ROUTE_502_WITH_HINT },
    ],
  },
  {
    id: 'mut-a-invoke-ignores-the-resolved-handler',
    why:
      'ROUND-4 MUT-A, form 2 — the shape the fix reduces the attack to. The row keeps its honest ' +
      'label, `loadHandler` still imports [name]/test/route.ts, and `invoke` simply throws the ' +
      'handler away and drives the QUERY route instead. Resolving by path is not sufficient on ' +
      'its own; `driveWith` also asserts the resolved handler was called exactly once. If this ' +
      'ever survives, the label is decorative again.',
    expect: 'caught',
    edits: [
      {
        file: GUARD,
        find: "    arrange: (err) => { client.compileQuery.mockRejectedValue(err); },\n    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),",
        replace:
          "    arrange: (err) => { client.saveTransformation.mockRejectedValue(err); },\n" +
          "    invoke: async (h) => {\n" +
          "      void h;\n" +
          "      const other = await loadHandler('[name]/query/route.ts', 'PUT');\n" +
          "      return other(jsonReq({ query: 'SELECT 1' }), params);\n" +
          '    },',
      },
      { file: TEST_ROUTE, find: TEST_ROUTE_502, replace: TEST_ROUTE_502_WITH_HINT },
    ],
  },
  {
    id: 'mut-a-invoke-calls-then-discards',
    why:
      'ROUND-4 MUT-A, form 3. The refinement of form 2 that a call-count check alone would miss: ' +
      'call the resolved handler (so the count is 1), throw its Response away, and assert against ' +
      "another module's. Caught only by the response-IDENTITY half of `driveWith`.",
    expect: 'caught',
    edits: [
      {
        file: GUARD,
        find: "    arrange: (err) => { client.compileQuery.mockRejectedValue(err); },\n    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),",
        replace:
          "    arrange: (err) => { client.compileQuery.mockRejectedValue(err); client.saveTransformation.mockRejectedValue(err); },\n" +
          "    invoke: async (h) => {\n" +
          "      await h(jsonReq({ query: 'SELECT 1' }), params);\n" +
          "      const other = await loadHandler('[name]/query/route.ts', 'PUT');\n" +
          "      return other(jsonReq({ query: 'SELECT 1' }), params);\n" +
          '    },',
      },
      { file: TEST_ROUTE, find: TEST_ROUTE_502, replace: TEST_ROUTE_502_WITH_HINT },
    ],
  },

  // ── MUT-B (round-4 review, SURVIVED against the previous version) ─────────
  {
    id: 'mut-b-new-route-reaches-the-client-by-indirection',
    why:
      'ROUND-4 MUT-B. A new ASA route whose OWN bytes carry none of the marker vocabulary: it ' +
      'reaches the client through a local helper and emits its remediation from an imported ' +
      'ASA_HINT const. Against the previous version this was GREEN — the route was discovered, ' +
      'excluded from scope by the own-bytes predicate, and then "proven exempt" by the same ' +
      'matcher that had excluded it. Not hypothetical: this PR created seven identical copies of ' +
      'the HINT literal, which is exactly the pressure that produces a shared _hint.ts.',
    expect: 'caught',
    create: [
      { file: `${ITEM_DIR}/_mut_hint.ts`, content: "export const ASA_HINT =\n  'Provision an ASA job (bicep: …stream-analytics.bicep, flag enableStreamAnalytics=true) and set LOOM_ASA_RG.';\n" },
      { file: `${ITEM_DIR}/_mut_asa.ts`, content: "export { getJob } from '@/lib/azure/stream-analytics-client';\n" },
      { file: `${ITEM_DIR}/[name]/scale/route.ts`, content: defectiveRoute({ importsClientDirectly: false }) },
    ],
  },
  {
    id: 'mut-b2-closure-reverted-to-own-bytes',
    why:
      'The DEFENCE for MUT-B, mutated directly. Removes the import-closure walk so ' +
      '`reachesAsaVocabulary` reads only the entry file. The predicate has its own controls ' +
      '(`the in-scope predicate FOLLOWS INDIRECTION and fails closed`), so a later "simplify ' +
      'this back" edit must go red on them rather than quietly restoring the escape.',
    expect: 'caught',
    edits: [
      {
        file: GUARD,
        find: '    if (depth >= maxDepth) continue;',
        replace: '    if (depth >= 0) continue;',
      },
    ],
  },
  {
    id: 'mut-b3-unresolvable-import-fails-open',
    why:
      'The fail-closed half. An unresolvable first-party specifier stops meaning "I could not ' +
      'establish that this module is clean" and starts meaning "clean". That substitution — an ' +
      'unestablished fact reported as an established one — is deploy-integrity.md R7 itself, ' +
      'inside the guard that enforces R7.',
    expect: 'caught',
    edits: [
      {
        file: GUARD,
        find: '      if (r.file === null) return true; // unresolvable first-party -> cannot be proven clean',
        replace: '      if (r.file === null) continue; // MUTANT: unresolvable read as clean',
      },
    ],
  },
  {
    id: 'mut-b4-predicate-carve-out-shrinks-the-population',
    why:
      'The SHRINK half of MUT-B, which fail-closed-at-zero is silent about — the round-4 reviewer ' +
      'put it exactly: "a population that shrinks by one is silent." A NARROW carve-out inside ' +
      '`reachesAsaVocabulary` drops ONE module out of scope, its driver row is deleted, and the ' +
      'hint goes back on its generic 502. Note what does NOT catch this: the file is still on ' +
      'disk, still walked, and still in the generated inventory, so the cross-check agrees; and ' +
      'the exempt-by-source assertion calls the SAME mutated predicate, so it agrees too. That ' +
      'tautology is the reviewer\'s point about proving an exemption with the matcher that ' +
      'produced it. The floor is the only instrument left, and this repo measures the narrow ' +
      'bypass as the evasion that actually works.',
    expect: 'caught',
    edits: [
      {
        file: GUARD,
        find:
          '  const seen = new Set<string>();\n' +
          '  const stack: Array<{ file: string; depth: number }> = [{ file: entry, depth: 0 }];',
        replace:
          // Split on EITHER separator: `entry` is an absolute path built with
          // `path.join`, so it is backslash-separated on Windows and a
          // '/'-anchored needle would carve out nothing at all — a mutation that
          // silently does not apply reads exactly like a defended property.
          "  if (entry.split(/[\\\\/]/).includes('test')) return false; // MUTANT: narrow carve-out\n" +
          '  const seen = new Set<string>();\n' +
          '  const stack: Array<{ file: string; depth: number }> = [{ file: entry, depth: 0 }];',
      },
      {
        file: GUARD,
        find:
          "  {\n" +
          "    name: 'POST /[name]/test',\n" +
          "    module: '[name]/test/route.ts',\n" +
          "    method: 'POST',\n" +
          "    // Default `mode` is 'compile', so `compileQuery` is the call that rejects.\n" +
          '    arrange: (err) => { client.compileQuery.mockRejectedValue(err); },\n' +
          "    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),\n" +
          '  },\n',
        replace: '',
      },
      { file: TEST_ROUTE, find: TEST_ROUTE_502, replace: TEST_ROUTE_502_WITH_HINT },
    ],
  },
  {
    id: 'mut-b5-same-carve-out-with-the-floor-also-removed',
    why:
      'THE ATTRIBUTION CONTROL for the arm above, and a DECLARED BLIND SPOT rather than a ' +
      'discovered one. Identical carve-out, plus the floor dropped to 0. It SURVIVES, and that ' +
      'is the point: without the floor the previous arm would be green too, so the catch there is ' +
      'attributable to the floor and to nothing else. An arm pair is the only way to say that — a ' +
      'suite that caught the first arm for some other reason would look identical from one run.',
    expect: 'survives',
    edits: [
      {
        file: GUARD,
        find:
          '  const seen = new Set<string>();\n' +
          '  const stack: Array<{ file: string; depth: number }> = [{ file: entry, depth: 0 }];',
        replace:
          // Split on EITHER separator: `entry` is an absolute path built with
          // `path.join`, so it is backslash-separated on Windows and a
          // '/'-anchored needle would carve out nothing at all — a mutation that
          // silently does not apply reads exactly like a defended property.
          "  if (entry.split(/[\\\\/]/).includes('test')) return false; // MUTANT: narrow carve-out\n" +
          '  const seen = new Set<string>();\n' +
          '  const stack: Array<{ file: string; depth: number }> = [{ file: entry, depth: 0 }];',
      },
      {
        file: GUARD,
        find:
          "  {\n" +
          "    name: 'POST /[name]/test',\n" +
          "    module: '[name]/test/route.ts',\n" +
          "    method: 'POST',\n" +
          "    // Default `mode` is 'compile', so `compileQuery` is the call that rejects.\n" +
          '    arrange: (err) => { client.compileQuery.mockRejectedValue(err); },\n' +
          "    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),\n" +
          '  },\n',
        replace: '',
      },
      { file: GUARD, find: 'const IN_SCOPE_FLOOR = 8;', replace: 'const IN_SCOPE_FLOOR = 0;' },
      { file: TEST_ROUTE, find: TEST_ROUTE_502, replace: TEST_ROUTE_502_WITH_HINT },
    ],
  },

  // ── MUT-D (round-4 review, CAUGHT — kept, because the fix for MUT-A removed
  //    the accident that caught it and a real instrument had to replace it) ──
  {
    id: 'mut-d-filter-inside-the-walk-predicate',
    why:
      'ROUND-4 MUT-D. A filter INSIDE the walk (`entry === \'test\' -> continue`) plus the row ' +
      'relabelled, so the derivation is fully evaded. The previous version caught this by ' +
      'ACCIDENT — its relabelled row still called the real [name]/test handler through a static ' +
      'import. MUT-A\'s fix removes that accident, so the catch now has to come from somewhere ' +
      'real: the walk is cross-checked against docs/fiab/route-inventory.md, a generated artifact ' +
      'held to the tree by its own CI drift gate. A `continue` in the walk must now be paired ' +
      'with an edit to a file a different gate regenerates.',
    expect: 'caught',
    edits: [
      {
        file: GUARD,
        find: "    if (entry === '__tests__' || entry === 'node_modules') continue;",
        replace: "    if (entry === '__tests__' || entry === 'node_modules' || entry === 'test') continue;",
      },
      {
        file: GUARD,
        find: "    name: 'POST /[name]/test',\n    module: '[name]/test/route.ts',\n    method: 'POST',",
        replace: "    name: 'POST /[name]/test',\n    module: '[name]/query/route.ts',\n    method: 'PUT',",
      },
      {
        file: GUARD,
        find: "    arrange: (err) => { client.compileQuery.mockRejectedValue(err); },\n    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),",
        replace: "    arrange: (err) => { client.saveTransformation.mockRejectedValue(err); },\n    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),",
      },
      { file: TEST_ROUTE, find: TEST_ROUTE_502, replace: TEST_ROUTE_502_WITH_HINT },
    ],
  },

  // ── MUT-F / NIT-6 (round-4 review) ────────────────────────────────────────
  {
    id: 'mut-f-new-undriven-route-nested-deeper',
    why:
      'ROUND-4 MUT-F. A NEW marker-carrying route with no driver, nested one level deeper than ' +
      'any existing route. Proves the walk recurses arbitrarily deep and that an undriven ' +
      'in-scope module is named by path rather than merely counted.',
    expect: 'caught',
    create: [
      { file: `${ITEM_DIR}/[name]/scale/deep/route.ts`, content: defectiveRoute({ importsClientDirectly: true }) },
    ],
  },
  {
    id: 'mut-c-route-tsx-escapes-the-walk',
    why:
      'ROUND-4 NIT 6. The same defect in a `route.tsx`. Next.js accepts it; the previous walk ' +
      'collected `route.ts` only, so it was invisible — as it still is to ' +
      'scripts/ci/generate-route-inventory.mjs, which carries the same restriction. Closed here ' +
      'by matching the shape (route.{ts,tsx,js,jsx,mjs,cjs}) rather than the one extension.',
    expect: 'caught',
    create: [
      { file: `${ITEM_DIR}/[name]/scale/route.tsx`, content: defectiveRoute({ importsClientDirectly: true }) },
    ],
  },

  // ── The instruments themselves ────────────────────────────────────────────
  {
    id: 'inventory-cross-check-parses-nothing',
    why:
      'Points the second instrument at a prefix no row carries, so it silently measures an empty ' +
      'set. A cross-check that matches zero rows agrees with ANY walk — the "guard that watches ' +
      'nothing" shape this repo keeps finding. The assertion that the parsed inventory is ' +
      'non-empty is what makes the cross-check non-vacuous, and this arm is its control.',
    expect: 'caught',
    edits: [
      {
        file: GUARD,
        find: "const INVENTORY_PREFIX = 'items/stream-analytics-job/';",
        replace: "const INVENTORY_PREFIX = 'items/stream-analytics-job-does-not-exist/';",
      },
    ],
  },
  {
    id: 'crlf-blind-needle-control',
    why:
      'NOT a guard mutation — a control on THIS HARNESS. The needle is written with a literal CR ' +
      'so it cannot match the LF-normalised copy. The expected outcome is NEEDLE-MISCOUNT, not ' +
      'CAUGHT: if a zero-match needle were reported as a catch, every arm above could be silently ' +
      'measuring nothing and the sweep would still score perfectly.',
    expect: 'needle-miscount',
    edits: [{ file: GUARD, find: 'const IN_SCOPE_FLOOR = 8;\r', replace: 'const IN_SCOPE_FLOOR = 0;' }],
  },
];
