#!/usr/bin/env node
/**
 * IS THE WATCHED TABLE COMPLETE? (the level above check-deploy-paths-coverage)
 *
 * ## The gap this closes
 *
 * check-deploy-paths-coverage.mjs answers "does each DECLARED lane declare every
 * source it deploys?". Nothing answered "is every deploy lane declared?" — so a
 * lane absent from WATCHED has zero gaps BY CONSTRUCTION and reads as clean.
 *
 * That is presence-without-enforcement moved up one level: from the entry to the
 * table. And it is not hypothetical. `deploy-fiab-il5.yml` — the ONLY workflow
 * that applies platform/fiab/bicep/main.bicep to the DoD IL5 estate — is in no
 * entry at all, carries 11 deploy sources, and has never run. Adding a new deploy
 * source to it produced NO gap from the coverage guard, because nothing was
 * looking at the lane. Every other IL5-aware control in this repo enumerates it
 * (check-tenant-admin-binding.mjs, check-appimagetags-coverage.mjs,
 * check-teardown-not-on-schedule.mjs, roll-plan.mjs,
 * __tests__/bicepparam-env-reaches-deploy.test.mjs); only the staleness watchdog
 * omitted it, so this is inconsistency with an established convention rather than
 * a design choice.
 *
 * ## The rule
 *
 * A workflow MUST be in WATCHED if it is either
 *   (a) a `deploy-fiab-*.yml` lane, or
 *   (b) any workflow that APPLIES the estate template — an `az deployment …
 *       create` reaching platform/fiab/bicep/main.bicep.
 * …unless it is in {@link EXCLUSIONS} with a reason that is STILL TRUE.
 *
 * ## Why the exclusions AUTO-EXPIRE
 *
 * A named exclusion list with prose reasons rots: it ends up vouching for lanes
 * whose situation changed, which is a second copy of the problem this file
 * exists to catch. So each exclusion carries a PREDICATE, not just a sentence.
 * When the predicate stops holding, the exclusion is stale and this suite FAILS
 * demanding registration — the ratchet shape check-platform-runs-it-not-you.mjs
 * uses for its BASELINE, where an entry that no longer triggers must be deleted.
 *
 * That is what makes the IL5 exclusion honest rather than a TODO: it is not "we
 * will get to it", it is "this lane cannot be registered until its workflow emits
 * a DRY-RUN run-name, and the moment it does, this test says so."
 *
 * ## Keyed to the SAFE state
 *
 * The assertion is "every qualifying lane is watched", not "these known lanes are
 * watched". A NEW deploy-fiab-* lane, or a new workflow that applies main.bicep,
 * fails here until it is registered. A guard keyed to the unsafe pattern goes
 * green the moment someone renames; this one cannot.
 *
 * Run: node --test scripts/ci/__tests__/deploy-watched-completeness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WATCHED, DRY_RUN_MARKER } from '../check-deploy-staleness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF_DIR = path.join(REPO, '.github', 'workflows');

/** The estate template. A workflow that applies THIS is a reconcile lane. */
const ESTATE_TEMPLATE = 'platform/fiab/bicep/main.bicep';

const read = (f) => readFileSync(path.join(WF_DIR, f), 'utf8');

const workflows = () => readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

/**
 * Does this workflow APPLY the estate template?
 *
 * Deliberately narrow, and `what-if` counts as NOT applying — a what-if changes
 * nothing, so a preview lane is not a deploy path and does not belong in a
 * DEPLOY-staleness table.
 *
 * READS LOGICAL LINES, not physical ones. Every real call site in this repo is a
 * backslash continuation:
 *
 *     az deployment sub what-if \
 *       --template-file platform/fiab/bicep/main.bicep \
 *
 * so a physical-line scan sees `--template-file …main.bicep` with no verb beside
 * it and cannot tell an apply from a preview. The first cut of this function had
 * exactly that bug: its docblock claimed what-if was excluded and the code did
 * not implement it, which is the R7 shape (a claim the code did not establish) —
 * and it made bicep-whatif.yml and loom-drift-check.yml, both pure `what-if`
 * lanes, look like unwatched deploy paths.
 */
export function appliesEstateTemplate(text) {
  const logical = [];
  let acc = '';
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*#/.test(line)) { continue; }
    if (line.endsWith('\\')) { acc += `${line.slice(0, -1)} `; continue; }
    logical.push(acc + line);
    acc = '';
  }
  if (acc) logical.push(acc);

  return logical
    .filter((l) => !/\becho\b/.test(l))
    .filter((l) => !/::(?:warning|notice|error|debug)::/.test(l))
    .filter((l) => /(?:-f|--template-file)\s+["']?[^\s"']*platform\/fiab\/bicep\/main\.bicep/.test(l))
    // Keyed to the APPLY verb, not to the absence of `what-if`: a lane using some
    // future preview subcommand is excluded by default rather than admitted.
    .some((l) => /\baz\s+deployment\s+(?:sub|group|mg|tenant)\s+create\b/.test(l));
}

/**
 * Lanes deliberately NOT in WATCHED, each with a predicate that must STILL hold.
 * `stillExcluded(text)` returning FALSE means the reason has expired and the lane
 * must now be registered.
 */
export const EXCLUSIONS = Object.freeze({
  'deploy-fiab-il5.yml': {
    reason:
      'IL5 SHOULD be watched and is not — this is a KNOWN GAP with a blocking dependency, not a design choice. '
      + 'Its run_mode DEFAULTS to `whatif-only` and the workflow declares NO `run-name`, so a default dispatch '
      + 'would succeed having applied nothing and pickLastRealSuccess could not tell it from a real apply — '
      + 'registering it in that state would let one dry run clear a drift it had not closed, which is precisely '
      + 'what DRY_RUN_MARKER exists to prevent and precisely the state deploy-fiab-gcch.yml was in when it was '
      + 'registered. The fix is one `run-name:` line in .github/workflows/deploy-fiab-il5.yml, a file the lane '
      + 'that found this does not own, so it is routed rather than taken. THIS EXCLUSION EXPIRES BY ITSELF: the '
      + 'predicate below goes false the moment that line lands, and this suite then fails until IL5 is in WATCHED.',
    // TRUE while the lane still lacks a dry-run-marked run-name.
    stillExcluded: (text) => {
      const runName = text.replace(/\r\n/g, '\n').split('\n').find((l) => /^run-name:/.test(l));
      return !runName || !runName.includes(DRY_RUN_MARKER);
    },
  },
});

// ---------------------------------------------------------------------------

test('POPULATION: the enumeration is not vacuous', () => {
  // A completeness check over an empty population is the exact defect it exists
  // to catch, one level down. In THIS repo all three counts are non-zero.
  const all = workflows();
  assert.ok(all.length >= 50, `only ${all.length} workflow(s) enumerated — the scan is broken`);

  const lanes = all.filter((f) => /^deploy-fiab-.*\.ya?ml$/.test(f));
  assert.ok(lanes.length >= 4, `only ${lanes.length} deploy-fiab-* lane(s) found — expected at least commercial/gcch/gcc/il5`);

  const appliers = all.filter((f) => appliesEstateTemplate(read(f)));
  assert.ok(appliers.length >= 3, `only ${appliers.length} workflow(s) apply ${ESTATE_TEMPLATE} — the detector drifted`);

  assert.ok(Array.isArray(WATCHED) && WATCHED.length >= 15, `WATCHED holds ${WATCHED?.length} entries`);
});

test('every deploy-fiab-* lane is WATCHED, or excluded for a reason that still holds', () => {
  const watched = new Set(WATCHED.map((e) => e.workflow));
  const missing = [];
  for (const f of workflows().filter((x) => /^deploy-fiab-.*\.ya?ml$/.test(x))) {
    if (watched.has(f)) continue;
    if (Object.prototype.hasOwnProperty.call(EXCLUSIONS, f)) continue;
    missing.push(f);
  }
  assert.deepEqual(
    missing,
    [],
    `deploy lane(s) in no WATCHED entry: ${missing.join(', ')}. A lane absent from the table has ZERO gaps by `
    + 'construction — check-deploy-paths-coverage cannot see it, and nothing anywhere says its deploy path is drifting. '
    + 'Register it in WATCHED, or add it to EXCLUSIONS in this file with a reason AND an expiry predicate.',
  );
});

test('every workflow that APPLIES main.bicep is WATCHED, or excluded', () => {
  // The deploy-fiab-* name is a convention, not a guarantee. This catches a
  // reconcile lane that applies the estate template under any other name.
  const watched = new Set(WATCHED.map((e) => e.workflow));
  const missing = workflows()
    .filter((f) => !watched.has(f))
    .filter((f) => !Object.prototype.hasOwnProperty.call(EXCLUSIONS, f))
    .filter((f) => appliesEstateTemplate(read(f)));
  assert.deepEqual(
    missing,
    [],
    `workflow(s) applying ${ESTATE_TEMPLATE} but in no WATCHED entry: ${missing.join(', ')}`,
  );
});

test('CONTROL: the detector fires on a real apply and NOT on a mention or a what-if', () => {
  // Without this, "0 missing" and "the detector matches nothing" are the same
  // output. Every negative below is a shape that really occurs in these
  // workflows — none is invented.
  const apply = [
    '          az deployment sub create \\',
    '            --location "$LOC" \\',
    '            --template-file platform/fiab/bicep/main.bicep \\',
    '            --parameters platform/fiab/bicep/params/commercial.bicepparam',
  ].join('\n');
  assert.equal(appliesEstateTemplate(apply), true, 'a real continuation-style apply must be detected');
  assert.equal(appliesEstateTemplate('  az deployment sub create -f platform/fiab/bicep/main.bicep\n'), true);

  // THE what-if SHAPE, verbatim from bicep-whatif.yml:284 and
  // loom-drift-check.yml:140. Both are pure preview lanes that apply NOTHING,
  // and both were false positives until this function read logical lines.
  const whatIf = [
    '          az deployment sub what-if \\',
    '            --name loom-fiab-whatif-1 \\',
    '            --location "$FIAB_LOCATION" \\',
    '            --template-file platform/fiab/bicep/main.bicep \\',
    '            --parameters platform/fiab/bicep/params/commercial-full.bicepparam',
  ].join('\n');
  assert.equal(appliesEstateTemplate(whatIf), false, 'a what-if applies nothing and is not a deploy path');

  assert.equal(appliesEstateTemplate('  # applies platform/fiab/bicep/main.bicep\n'), false);
  assert.equal(appliesEstateTemplate('  echo "see platform/fiab/bicep/main.bicep"\n'), false);
  assert.equal(appliesEstateTemplate('  echo "::notice::platform/fiab/bicep/main.bicep"\n'), false);
  // Named without any command — e.g. a path filter or a matrix entry.
  assert.equal(appliesEstateTemplate('      - platform/fiab/bicep/main.bicep\n'), false);
});

test('LIVE CONTROL: the two real what-if lanes are correctly NOT counted as appliers', () => {
  // Pins the fix against the actual tree, so a future loosening of the detector
  // that re-admits them fails here with their names on it rather than quietly
  // demanding two preview lanes be registered as deploy paths.
  for (const wf of ['bicep-whatif.yml', 'loom-drift-check.yml']) {
    if (!existsSync(path.join(WF_DIR, wf))) continue;
    const text = read(wf);
    assert.match(text, /platform\/fiab\/bicep\/main\.bicep/, `${wf} no longer references the estate template — this control is moot`);
    assert.equal(
      appliesEstateTemplate(text),
      false,
      `${wf} runs \`az deployment sub what-if\` and applies NOTHING; counting it as a deploy path would demand a `
      + 'staleness entry for a lane that never deploys.',
    );
  }
});

test('EXCLUSIONS auto-expire: each reason is still TRUE, or the lane must be registered', () => {
  const watched = new Set(WATCHED.map((e) => e.workflow));
  for (const [wf, entry] of Object.entries(EXCLUSIONS)) {
    assert.ok(existsSync(path.join(WF_DIR, wf)), `EXCLUSIONS names ${wf}, which does not exist — delete the entry`);
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.length > 80,
      `${wf} must state WHY it is not watched, at length`,
    );
    assert.equal(typeof entry.stillExcluded, 'function', `${wf} needs an expiry PREDICATE, not just prose`);

    assert.ok(
      !watched.has(wf),
      `${wf} is BOTH in WATCHED and in EXCLUSIONS — delete the exclusion, it has served its purpose`,
    );
    assert.ok(
      entry.stillExcluded(read(wf)),
      `${wf}'s exclusion reason NO LONGER HOLDS — the blocking condition is resolved, so register it in WATCHED `
      + 'and delete this exclusion. An exclusion that outlives its reason is a second copy of the problem this suite exists to catch.',
    );
  }
});

test('CONTROL: the IL5 expiry predicate genuinely discriminates', () => {
  // The predicate is the whole mechanism, so it gets its own two-arm control.
  // If it returned true unconditionally the exclusion would never expire and the
  // test above would be decoration.
  const pred = EXCLUSIONS['deploy-fiab-il5.yml'].stillExcluded;
  assert.equal(pred('name: x\non:\n  workflow_dispatch:\n'), true, 'no run-name at all must remain excluded');
  assert.equal(pred('name: x\nrun-name: deploy-fiab-il5\n'), true, 'a run-name without the marker must remain excluded');
  assert.equal(
    pred(`name: x\nrun-name: deploy-fiab-il5 — ${DRY_RUN_MARKER} (whatif-only, applies nothing)\n`),
    false,
    'a run-name CARRYING the marker must EXPIRE the exclusion — otherwise IL5 stays unwatched forever',
  );
  // And the live file is in the state the exclusion claims.
  assert.equal(pred(read('deploy-fiab-il5.yml')), true, 'deploy-fiab-il5.yml already has a DRY-RUN run-name — register it');
});
