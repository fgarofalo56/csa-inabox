// Behaviour tests for the two POPULATION defects in scripts/ci/check-env-sync.mjs:
//
//   #3940 residue — layers 1 and 2 could not SEE `NEXT_PUBLIC_LOOM_*`.
//   #3344 crit. 2 — nothing could see a workflow deriving a PRESENCE verdict
//                   from `env[?name=='X'].value`, which cannot distinguish
//                   "absent" from "emitted empty".
//
// WHY THIS SUITE EXISTS
// ---------------------
// #3940 was CLOSED, and it was closed correctly for what it fixed: PR #4208
// widened parseEnvEntries() (layer 3) from `LOOM_*` to `(NEXT_PUBLIC_)?LOOM_*`.
// It did not widen layer 1 (collectReads / collectEmitted) or layer 2
// (collectConsoleDelivered), and nothing recorded that — so the issue read as
// done while two thirds of the guard kept the exact blindness it is about.
//
// Re-measured at 5f1ee0d1, BEFORE this change:
//
//   process.env.LOOM_*                                754   examined
//   process.env.NEXT_PUBLIC_LOOM_*                     11   INVISIBLE
//   `name: 'NEXT_PUBLIC_LOOM_*'` in admin-plane         13   INVISIBLE
//   of the 11 reads, emitted by no bicep at all          7
//
// AFTER: reads 765, emitted 616, delivered 470. The 7 are allowlisted with the
// reason each read site actually shows — every one has a working code default or
// a bicep-emitted server-side sibling — and the 4 that ARE emitted are
// deliberately NOT allowlisted, so the guard now enforces their wiring.
//
// #3344's second acceptance criterion is verbatim: "Guard: list env NAMES, never
// just values, when asserting presence." Measured: 23 `env[?name==…].value` sites
// across .github/workflows and scripts, 15 of which drive a presence verdict off
// that value. The clearest is .github/workflows/loom-brain-scan.yml, which prints
// "carries no LOOM_COSMOS_ENDPOINT env entry. That is a mis-deployed console,
// not a missing setting" — a cause the oracle cannot establish, because
// `cond ? value : ''` emits present-but-empty and renders identically.
//
// The 15 are NOT fixed here (they live in files this change does not own); they
// are ratcheted so the 16th is red. That is stated in the PR, not implied.
//
// Run: node --test scripts/ci/__tests__/env-sync-population.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectReads,
  collectEmitted,
  collectConsoleDelivered,
  collectConsoleEnvExpressions,
  computeMissing,
  computeUndelivered,
  classifyEnvQuerySite,
  collectEnvValueQuerySites,
  classifyPresenceSites,
  computeEnvQueryPresence,
  runEnvQueryControl,
  KNOWN_VALUE_ONLY_PRESENCE_TESTS,
  KNOWN_VALUE_ONLY_VALUE_USES,
  ENV_QUERY_CENSUS_FLOOR,
} from '../check-env-sync.mjs';

// ══════════════════════════════════════════════════════════════════════════════
// #3940 residue — the examined set must include the prefix that reaches the browser
// ══════════════════════════════════════════════════════════════════════════════

test('POPULATION: collectReads() SEES process.env.NEXT_PUBLIC_LOOM_* reads', () => {
  const reads = collectReads();
  const np = [...reads].filter((n) => n.startsWith('NEXT_PUBLIC_LOOM_'));
  // Before this change this was 0 — not because the tree had none, but because
  // the regex anchored `process.env.` directly onto `LOOM_`.
  assert.ok(np.length > 0, 'no NEXT_PUBLIC_LOOM_* read was collected — layer 1 is blind again');
  assert.ok(
    reads.size > np.length,
    'the LOOM_* population vanished; widening must ADD to the examined set, never replace it',
  );
});

test('POPULATION: collectConsoleDelivered() SEES NEXT_PUBLIC_LOOM_* env entries', () => {
  const delivered = collectConsoleDelivered();
  const np = [...delivered].filter((n) => n.startsWith('NEXT_PUBLIC_LOOM_'));
  assert.ok(np.length > 0, 'layer 2 cannot see a NEXT_PUBLIC_LOOM_* delivery');
  // The console app carries hundreds of entries; a collapse means the extractor
  // drifted rather than the tree changing.
  assert.ok(delivered.size > 100);
});

test('POPULATION: collectEmitted() SEES NEXT_PUBLIC_LOOM_* names in bicep', () => {
  const emitted = collectEmitted();
  assert.ok([...emitted].some((n) => n.startsWith('NEXT_PUBLIC_LOOM_')));
  // …and still carries the BARE form for the same token, so widening did not
  // narrow anything.
  assert.ok(emitted.has('LOOM_AZURE_MAPS_ACCOUNT'));
});

test('POPULATION: layer 3 and layer 1 now examine the SAME prefixes', () => {
  // The #3940 defect in one assertion: the two populations disagreeing about
  // what counts is how a name stays policed in one layer and invisible in
  // another.
  const layer3 = [...collectConsoleEnvExpressions().keys()];
  const layer2 = [...collectConsoleDelivered()];
  const npIn3 = layer3.filter((n) => n.startsWith('NEXT_PUBLIC_')).sort();
  const npIn2 = layer2.filter((n) => n.startsWith('NEXT_PUBLIC_')).sort();
  assert.deepEqual(npIn2, npIn3);
  assert.ok(npIn3.length > 0);
});

test('POPULATION: a NEXT_PUBLIC_LOOM_* read that nothing emits is RED, not invisible', () => {
  // MUTATION, in-process: pretend the console reads a NEXT_PUBLIC var no bicep
  // sets. Before the widening this could never be reported at any population
  // size; the whole point of the fix is that it now can.
  const emitted = collectEmitted();
  const invented = 'NEXT_PUBLIC_LOOM_INVENTED_BY_THIS_TEST';
  assert.ok(!emitted.has(invented), 'fixture name must genuinely not be emitted');

  // Drive the same predicate computeMissing() uses, over a widened read set.
  const { reads, missing } = computeMissing();
  assert.deepEqual(missing, [], 'the real tree must be clean before the mutation means anything');
  const mutatedReads = new Set([...reads, invented]);
  const stillMissing = [...mutatedReads].filter((n) => !emitted.has(n)).sort();
  assert.ok(
    stillMissing.includes(invented),
    'an unemitted NEXT_PUBLIC_LOOM_* read did not survive to the missing set',
  );
  // And the name is one the OLD `process.env.LOOM_` regex could not even produce.
  assert.equal(/process\.env\.(LOOM_[A-Z0-9_]+)/.exec(`process.env.${invented}`), null);
});

test('POSITIVE CONTROL: the widened populations leave the real tree clean', () => {
  assert.deepEqual(computeMissing().missing, []);
  assert.deepEqual(computeUndelivered().undelivered, []);
});

// ══════════════════════════════════════════════════════════════════════════════
// #3344 criterion 2 — a presence verdict read off `.value`
// ══════════════════════════════════════════════════════════════════════════════

const at = (src) => src.indexOf("env[?name=='");

// THE `\${…}` ESCAPES IN THE FIXTURES BELOW ARE LOAD-BEARING — DO NOT REMOVE.
// Each fixture is a TEMPLATE LITERAL holding literal shell text, and the
// backslash suppresses JS interpolation so the classifier receives the six
// characters `${VAR:-}`. CodeQL reports these as unnecessary escapes; removing
// them is a SyntaxError, not a cleanup, because `${MSAL:-}` is not a valid JS
// expression. Dismiss the finding with this reason rather than editing the code.

test('LAYER 6: an emptiness test on the captured value IS a presence verdict', () => {
  const src = `          ACCT=$(az containerapp show -n "$APP" -g "$RG" \\
            --query "properties.template.containers[0].env[?name=='LOOM_ADLS_ACCOUNT'].value | [0]" -o tsv)
          if [ -z "\${ACCT:-}" ]; then echo "Q1: UNKNOWN — no LOOM_ADLS_ACCOUNT on the app"; exit 0; fi
`;
  const c = classifyEnvQuerySite(src, at(src));
  assert.equal(c.variable, 'ACCT');
  assert.ok(c.presenceTest, 'the `-z` test was not recognised');
  assert.equal(c.hasNameQuery, false);
});

test('LAYER 6: comparing against a SPECIFIC expected value is NOT flagged', () => {
  // Absent and empty both land in the "not what we set" branch, so the verdict
  // is correct either way. A guard that flagged these would be muted in a week.
  const src = `            LIVE_URL=$(az containerapp show -g "$RG" -n loom-console \\
              --query "properties.template.containers[0].env[?name=='LOOM_POSTURE_FUNCTION_URL'].value | [0]" -o tsv)
            if [ "$LIVE_URL" = "$FUNC_URL" ]; then echo ok; else echo "::warning::read-back '$LIVE_URL'"; fi
`;
  assert.equal(classifyEnvQuerySite(src, at(src)).presenceTest, null);
});

test('LAYER 6: settling presence off the NAMES first clears the site', () => {
  // This is the documented remedy. If it did not clear, the guard would be
  // telling people to make a change that does not satisfy it.
  const src = `          NAMES=$(az containerapp show -n "$APP" -g "$RG" --query "properties.template.containers[0].env[].name" -o tsv)
          VAL=$(az containerapp show -n "$APP" -g "$RG" \\
            --query "properties.template.containers[0].env[?name=='LOOM_ADLS_ACCOUNT'].value | [0]" -o tsv)
          if [ -z "$VAL" ]; then echo "present but empty: $NAMES"; fi
`;
  const c = classifyEnvQuerySite(src, at(src));
  assert.ok(c.presenceTest);
  assert.equal(c.hasNameQuery, true, 'a companion `env[].name` query BEFORE the read must count');
});

test('LAYER 6: a LAUNDERED capture is still tracked to the variable that is tested', () => {
  // scripts/csa-loom/resolve-msal-client-id.sh captures into `raw`, launders it
  // through printf/tr into `CID`, and tests `-n "${CID:-}"`. Testing only the
  // capture called that site clean — a false negative from a too-small set.
  const src = `raw="$(az containerapp show -n "$APP" -g "$RG" \\
  --query "properties.template.containers[0].env[?name=='LOOM_MSAL_CLIENT_ID'].value | [0]" -o tsv)"
rc=$?
CID="$(printf '%s' "$raw" | tr -d '\\r')"
if [ -n "\${CID:-}" ] && [ "\${CID}" != "None" ]; then echo resolved; fi
`;
  const c = classifyEnvQuerySite(src, at(src));
  assert.equal(c.variable, 'raw');
  assert.ok(c.presenceTest, 'the test on the DERIVED variable was not seen');
});

test('LAYER 6: a presence test FOLDED across a `\\` continuation is still seen (#3420)', () => {
  // The corpus is .github/workflows/** and scripts/**/*.sh, where an `az`
  // invocation folds as a matter of house style. This layer's two judgements
  // both need a SECOND token after the one that anchors them, and on physical
  // lines neither can reach it:
  //
  //   * `-[zn]\s+"?\$VAR` — `\s` does not match a backslash, so `[ -z \` +
  //     newline + `"$X" ]` matched nothing;
  //   * the alias walk is `^…=(.+)$`-anchored, so a folded right-hand side was
  //     truncated at the seam and the second hop never reached the variable the
  //     site actually tests.
  //
  // MEASURED on this exact pair before `_logical-lines.mjs` was adopted here:
  // BOTH returned presenceTest=null — i.e. the guard called a live presence
  // verdict CLEAN and subtracted it from the flagged count, with the census
  // still printing a confident number. That is #3417's shape (eleven live
  // `|| echo` sites read as zero, every one on a continuation).
  const foldedTest = [
    '          ACCT=$(az containerapp show -n "$APP" -g "$RG" \\',
    `            --query "properties.template.containers[0].env[?name=='LOOM_ADLS_ACCOUNT'].value | [0]" -o tsv)`,
    '          if [ -z \\',
    '               "${ACCT:-}" ]; then echo "no LOOM_ADLS_ACCOUNT"; exit 0; fi',
    '',
  ].join('\n');
  const c1 = classifyEnvQuerySite(foldedTest, at(foldedTest));
  assert.equal(c1.variable, 'ACCT');
  assert.ok(c1.presenceTest, 'a `-z` split across a continuation read as no presence test at all');

  // The same blindness one hop further out: the LAUNDERING assignment folds, so
  // a physical read truncates its RHS and never learns that `CID` derives from
  // the captured `raw`.
  const foldedAlias = [
    'raw="$(az containerapp show -n "$APP" -g "$RG" \\',
    `  --query "properties.template.containers[0].env[?name=='LOOM_MSAL_CLIENT_ID'].value | [0]" -o tsv)"`,
    "CID=\"$(printf '%s' \\",
    "  \"$raw\" | tr -d '\\r')\"",
    'if [ -n "${CID:-}" ]; then echo resolved; fi',
    '',
  ].join('\n');
  const c2 = classifyEnvQuerySite(foldedAlias, at(foldedAlias));
  assert.equal(c2.variable, 'raw');
  assert.ok(c2.presenceTest, 'a folded alias RHS hid the derived variable that carries the test');
});

test('LAYER 6: a longer variable sharing a prefix does NOT satisfy the test', () => {
  // `-n "$EXISTING_CONF"` must not read as a presence test for `$EXISTING`.
  // Without the word boundary it did, and flagged a correct value-use site.
  const src = `  EXISTING="$(az containerapp show \\
    --query "properties.template.containers[0].env[?name=='LOOM_OPENLINEAGE_POOL_PRINCIPALS'].value | [0]" -o tsv)"
  case ",\${EXISTING}," in *) MERGED="\${EXISTING:+\${EXISTING},}x" ;; esac
  EXISTING_CONF="$(az synapse spark pool show --query x -o tsv)"
  [ -n "$EXISTING_CONF" ] && printf '%s' "$EXISTING_CONF"
`;
  const c = classifyEnvQuerySite(src, at(src));
  assert.equal(c.variable, 'EXISTING');
  assert.equal(c.presenceTest, null, 'a prefix collision produced a false positive');
});

test('LAYER 6: every spelling of an emptiness test is recognised', () => {
  for (const test0 of ['[ -z "$CID" ]', '[ -n "$CID" ]', '[ "$CID" = "" ]', '[ "$CID" != "" ]', '[ -z "${CID:-}" ]']) {
    const src = `CID=$(az containerapp show --query "env[?name=='LOOM_MSAL_CLIENT_ID'].value | [0]" -o tsv)\nif ${test0}; then echo x; fi\n`;
    assert.ok(classifyEnvQuerySite(src, at(src)).presenceTest, `not recognised: ${test0}`);
  }
});

test('LAYER 6: an unresolvable capture FAILS CLOSED rather than reading as clean', () => {
  // "cannot classify" must never render as "no defect" — that is how an
  // examined set silently shrinks. There is NO live population for this branch
  // (the assignment matcher handles every shape in the tree today), so a
  // synthetic site is the only way to prove the branch still works.
  const src = `          az containerapp show --query "properties.template.containers[0].env[?name=='LOOM_X'].value | [0]" -o tsv\n`;
  assert.equal(classifyEnvQuerySite(src, at(src)).variable, null);

  const unclassifiable = [{
    key: '.github/workflows/x.yml::LOOM_X',
    file: '.github/workflows/x.yml',
    line: 1,
    env: 'LOOM_X',
    variable: null,
    presenceTest: null,
    hasNameQuery: false,
  }];
  const { failures, counted } = classifyPresenceSites(unclassifiable, new Map());
  assert.equal(failures.length, 1, 'an unclassifiable site was absorbed as clean');
  assert.match(failures[0], /could not resolve which shell variable captures it/);
  assert.equal(counted.size, 0, 'an unclassifiable site must not be counted as a clean pass either');
});

test('LAYER 6: classifyPresenceSites compares against the ratchet it is GIVEN', () => {
  // Guards the comparison itself: a site over its allowance fails, at or under
  // it does not, and the count (not a boolean) is what decides.
  const site = (key) => ({
    key, file: key.split('::')[0], line: 1, env: key.split('::')[1],
    variable: 'V', presenceTest: '-z "$V"', hasNameQuery: false,
  });
  const k = '.github/workflows/x.yml::LOOM_X';
  assert.equal(classifyPresenceSites([site(k)], new Map([[k, 1]])).failures.length, 0);
  assert.equal(classifyPresenceSites([site(k), site(k)], new Map([[k, 1]])).failures.length, 1);
  assert.equal(classifyPresenceSites([site(k)], new Map()).failures.length, 1);
  // A site with a companion NAME query is not counted at all.
  const sound = { ...site(k), hasNameQuery: true };
  assert.equal(classifyPresenceSites([sound], new Map()).counted.size, 0);
});

test('LAYER 6: the census sees the real tree and the ratchet describes it exactly', () => {
  const sites = collectEnvValueQuerySites();
  assert.ok(
    sites.length >= ENV_QUERY_CENSUS_FLOOR,
    `census collapsed to ${sites.length}, below the floor ${ENV_QUERY_CENSUS_FLOOR}`,
  );
  const { failures, flagged, stale } = computeEnvQueryPresence();
  // Nothing unratcheted, nothing stale: the ratchet is attached to reality.
  assert.deepEqual(failures, []);
  assert.deepEqual(stale, []);
  const ratcheted = [...KNOWN_VALUE_ONLY_PRESENCE_TESTS.values()].reduce((a, b) => a + b, 0);
  assert.equal(flagged, ratcheted, 'the flagged count and the ratchet total must agree exactly');
  // And the layer is NOT policing an empty set: some sites are fine and some
  // are not, which is what makes the verdict informative.
  assert.ok(flagged > 0 && flagged < sites.length);
});

test('LAYER 6: a NEW presence-from-value site is RED (the 18th, not the 17 ratcheted)', () => {
  // MUTATION over the real predicate: add one site under a key the ratchet does
  // not carry, and confirm it is reported rather than absorbed.
  const { failures } = computeEnvQueryPresence();
  assert.deepEqual(failures, [], 'the tree must be clean before the mutation means anything');

  const counted = new Map();
  for (const s of collectEnvValueQuerySites()) {
    if (!s.presenceTest || s.hasNameQuery || s.variable === null) continue;
    counted.set(s.key, (counted.get(s.key) || 0) + 1);
  }
  const novel = '.github/workflows/brand-new.yml::LOOM_SOMETHING';
  assert.ok(!KNOWN_VALUE_ONLY_PRESENCE_TESTS.has(novel));
  counted.set(novel, 1);
  const unratcheted = [...counted].filter(
    ([k, n]) => n > (KNOWN_VALUE_ONLY_PRESENCE_TESTS.get(k) || 0),
  );
  assert.deepEqual(unratcheted, [[novel, 1]]);

  // …and a SECOND site under an already-ratcheted key is also caught, because
  // the ratchet stores a COUNT, not a boolean.
  const existing = [...KNOWN_VALUE_ONLY_PRESENCE_TESTS.keys()][0];
  const bumped = new Map(counted);
  bumped.set(existing, (KNOWN_VALUE_ONLY_PRESENCE_TESTS.get(existing) || 0) + 1);
  assert.ok(
    [...bumped].some(([k, n]) => k === existing && n > (KNOWN_VALUE_ONLY_PRESENCE_TESTS.get(k) || 0)),
  );
});

test('LAYER 6: a FIXED site makes the ratchet stale, which is itself reported', () => {
  // The ratchet must shrink. A key that no longer matches a flagged site is
  // describing a tree that no longer exists.
  const counted = new Set();
  for (const s of collectEnvValueQuerySites()) {
    if (!s.presenceTest || s.hasNameQuery || s.variable === null) continue;
    counted.add(s.key);
  }
  const fixed = new Set(counted);
  const victim = [...KNOWN_VALUE_ONLY_PRESENCE_TESTS.keys()][0];
  fixed.delete(victim);
  const stale = [...KNOWN_VALUE_ONLY_PRESENCE_TESTS.keys()].filter((k) => !fixed.has(k));
  assert.deepEqual(stale, [victim]);
});

test('POSITIVE CONTROL: the embedded layer-6 control holds', () => {
  assert.deepEqual(runEnvQueryControl(), []);
});

// ══════════════════════════════════════════════════════════════════════════════
// F1 — JOB SCOPE. The input shape that had NO FIXTURE, which is why an
// 18-mutation sweep over this suite found no survivor: every arm above separates
// a capture from its test by at most a few lines INSIDE ONE STEP. `>> "$GITHUB_ENV"`
// makes the variable job-scoped, and a step-scoped window then examines a
// smaller set than it polices — the #3956 N-1 defect, inside the fix for it.
// Ask what INPUT SHAPE has no fixture, not what mutation survives.
// ══════════════════════════════════════════════════════════════════════════════

/** Capture, export by `exportLines`, then test SIX STEPS later. */
const jobScopedFixture = (exportLines) => `      - name: capture
        run: |
          MSAL=$(az containerapp show -n "$APP" -g "$RG" \\
            --query "properties.template.containers[0].env[?name=='LOOM_MSAL_CLIENT_ID'].value | [0]" -o tsv)
${exportLines}
      - name: step two
        run: echo two

      - name: step three
        run: echo three

      - name: step four
        run: echo four

      - name: step five
        run: echo five

      - name: six steps later
        run: |
          if [ -n "\${MSAL:-}" ]; then
            echo "audience pinned"
          else
            echo "::warning::the live console has no LOOM_MSAL_CLIENT_ID, so it was deployed SEALED"
          fi
`;

test('LAYER 6: a capture exported to $GITHUB_ENV and tested SIX STEPS later is FLAGGED', () => {
  // Before the window followed the variable this returned presenceTest=null and
  // the site rendered CLEAN — while the else-branch asserted a cause the oracle
  // cannot establish (deploy-integrity R7).
  for (const [label, exportLines] of [
    ['brace block', '          { echo "RG=$RG"; echo "MSAL=\${MSAL:-}"; } >> "$GITHUB_ENV"\n'],
    ['same-line echo', '          echo "MSAL=$MSAL" >> "$GITHUB_ENV"\n'],
    ['heredoc', '          cat >> "$GITHUB_ENV" <<EOF\n          MSAL=$MSAL\n          EOF\n'],
  ]) {
    const src = jobScopedFixture(exportLines);
    const r = classifyEnvQuerySite(src, at(src));
    assert.equal(r.variable, 'MSAL', `${label}: lost the capture`);
    assert.ok(r.exportedToJobScope, `${label}: the export to $GITHUB_ENV was not recognised`);
    assert.ok(
      r.presenceTest,
      `${label}: the presence test six steps after the capture was invisible — the window is ` +
        'step-scoped while the variable is job-scoped',
    );
  }
});

test('LAYER 6: a capture that never reaches $GITHUB_ENV is NOT widened', () => {
  // The counterfactual. Without it, "flagged" could just mean the window grew
  // for everything, and a guard that cries wolf on correct sites is spent.
  const src = jobScopedFixture('          echo "MSAL stays local to this step"\n');
  const r = classifyEnvQuerySite(src, at(src));
  assert.equal(r.exportedToJobScope, false);
  assert.equal(
    r.presenceTest,
    null,
    'a step-local capture was matched against a test in a LATER step — the widening is not ' +
      'keyed to the export, it is unconditional',
  );
});

test('LAYER 6: a widened window still STOPS at the next job', () => {
  // `$GITHUB_ENV` promotes to JOB scope, not file scope. The `$MSAL` in another
  // job is a different variable and must not be attributed to this read.
  const src = `      - name: capture
        run: |
          MSAL=$(az containerapp show \\
            --query "properties.template.containers[0].env[?name=='LOOM_MSAL_CLIENT_ID'].value | [0]" -o tsv)
          echo "MSAL=$MSAL" >> "$GITHUB_ENV"

  second-job:
    runs-on: ubuntu-latest
    steps:
      - name: a different job entirely
        run: |
          if [ -z "\${MSAL:-}" ]; then echo "not this one"; fi
`;
  const r = classifyEnvQuerySite(src, at(src));
  assert.ok(r.exportedToJobScope);
  assert.equal(r.presenceTest, null, 'the widened window ran past the job boundary');
});

test('LAYER 6: the two LIVE Gov sites the step window could not see are now flagged', () => {
  // Not synthetic. These are the misses, and both are Gov — under cloud-parity
  // a guard blind exactly where the sovereign boundary needs it is incomplete,
  // not a Commercial-first tradeoff. gov-provision-trino is the worse of the
  // two: it prints the R7 assertion verbatim, and it is a STRONGER instance
  // than loom-brain-scan.yml, the example this layer was written for.
  const sites = collectEnvValueQuerySites();
  for (const [file, env, variable] of [
    ['.github/workflows/gov-provision-trino.yml', 'LOOM_MSAL_CLIENT_ID', 'MSAL_CLIENT_ID'],
    ['.github/workflows/gov-provision-streaming-migrate.yml', 'LOOM_ADLS_ACCOUNT', 'LAKE'],
  ]) {
    const s = sites.find((x) => x.file === file && x.env === env);
    assert.ok(s, `${file}::${env} left the census entirely`);
    assert.equal(s.variable, variable);
    assert.ok(s.exportedToJobScope, `${file}::${env} is exported to $GITHUB_ENV and must widen`);
    assert.ok(
      s.presenceTest,
      `${file}::${env} still reads as clean — it derives presence from a value, several steps ` +
        'after the capture, and that is the miss F1 exists to close',
    );
    assert.ok(
      KNOWN_VALUE_ONLY_PRESENCE_TESTS.has(`${file}::${env}`),
      `${file}::${env} is flagged but not ratcheted — re-baseline the ratchet`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// F1 — FAIL CLOSED. "No test found" is not "no test exists".
// ══════════════════════════════════════════════════════════════════════════════

test('LAYER 6: a RESOLVED capture with no presence test anywhere is FLAGGED, not clean', () => {
  // Only `variable === null` used to fail closed. A resolved variable with no
  // in-window test rendered CLEAN — absence of evidence reported as evidence of
  // absence, which is what this layer's own docstring forbids.
  const s = {
    key: 'wf.yml::LOOM_X',
    file: 'wf.yml',
    line: 1,
    env: 'LOOM_X',
    variable: 'X',
    presenceTest: null,
    hasNameQuery: false,
    exportedToJobScope: false,
  };
  const { failures, countedValueUses } = classifyPresenceSites([s], new Map(), new Map());
  assert.equal(failures.length, 1, 'an untested-but-resolved site rendered as a clean pass');
  assert.match(failures[0], /NO presence test was found/);
  assert.equal(countedValueUses.get('wf.yml::LOOM_X'), 1);

  // A DECLARED value-use clears — the exemption is explicit and reviewable…
  assert.deepEqual(
    classifyPresenceSites([s], new Map(), new Map([['wf.yml::LOOM_X', 1]])).failures,
    [],
  );
  // …and it is a COUNT, so a second site under the same key is still caught.
  assert.equal(
    classifyPresenceSites([s, s], new Map(), new Map([['wf.yml::LOOM_X', 1]])).failures.length,
    1,
  );
  // A companion NAME query settles presence properly and is counted in neither.
  const sound = classifyPresenceSites([{ ...s, hasNameQuery: true }], new Map(), new Map());
  assert.deepEqual(sound.failures, []);
  assert.equal(sound.countedValueUses.size, 0);
});

test('LAYER 6: the census is FULLY accounted for — no site is silently clean', () => {
  // The printed accounting used to read as complete while two sites sat in
  // neither column. Every site is now in exactly one bucket, and the two
  // ratchets sum to the census.
  const { census, flagged, valueUses, failures, stale } = computeEnvQueryPresence();
  assert.deepEqual(failures, []);
  assert.deepEqual(stale, []);
  assert.equal(
    flagged + valueUses,
    census,
    `${census} sites but only ${flagged + valueUses} accounted for — the residual is the set ` +
      'nobody is looking at',
  );
  assert.equal(flagged, [...KNOWN_VALUE_ONLY_PRESENCE_TESTS.values()].reduce((a, b) => a + b, 0));
  assert.equal(valueUses, [...KNOWN_VALUE_ONLY_VALUE_USES.values()].reduce((a, b) => a + b, 0));
  assert.ok(census >= ENV_QUERY_CENSUS_FLOOR);
});

test('LAYER 6: a NEW value-only site is RED until it is READ and declared', () => {
  // MUTATION over the real population: an undeclared value-use must not be
  // absorbed. `stale` cannot surface a site that was never counted, so the
  // ceiling is the only thing standing between a new site and silence.
  const sites = collectEnvValueQuerySites();
  const novel = {
    key: '.github/workflows/brand-new.yml::LOOM_SOMETHING',
    file: '.github/workflows/brand-new.yml',
    line: 1,
    env: 'LOOM_SOMETHING',
    variable: 'V',
    presenceTest: null,
    hasNameQuery: false,
    exportedToJobScope: true,
  };
  assert.ok(!KNOWN_VALUE_ONLY_VALUE_USES.has(novel.key));
  const { failures } = classifyPresenceSites([...sites, novel]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /brand-new\.yml/);
  assert.match(failures[0], /JOB-scoped via/);
});

test('LAYER 6: a FIXED value-only site makes its ceiling entry stale too', () => {
  // Both ratchets shrink. An entry in KNOWN_VALUE_ONLY_VALUE_USES asserts that a
  // site was READ; leaving one that describes nothing is how a ceiling becomes
  // silent coverage.
  const counted = new Set();
  for (const s of collectEnvValueQuerySites()) {
    if (s.variable === null || s.hasNameQuery || s.presenceTest) continue;
    counted.add(s.key);
  }
  const victim = [...KNOWN_VALUE_ONLY_VALUE_USES.keys()][0];
  assert.ok(counted.has(victim), 'the ceiling names a site the classifier no longer produces');
  counted.delete(victim);
  assert.deepEqual(
    [...KNOWN_VALUE_ONLY_VALUE_USES.keys()].filter((k) => !counted.has(k)),
    [victim],
  );
});
