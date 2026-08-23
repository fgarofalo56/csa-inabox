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
 *
 * CURRENTLY EMPTY, AND THAT IS THE INTENDED STATE. It held exactly one entry —
 * `deploy-fiab-il5.yml` — for the length of one review round. Its predicate was
 * "the workflow still lacks a DRY-RUN `run-name`", because registering it without
 * one would have let a default `whatif-only` dispatch clear a drift it had not
 * closed. That predicate EXPIRED as designed the moment the run-name landed, and
 * the lane was registered in the same commit; the exclusion was then deleted
 * rather than reworded, which is the only honest way to retire one.
 *
 * The machinery is kept, empty, on purpose. An empty allowlist with live controls
 * is not dead code — it is the mechanism that makes the NEXT blocked lane a dated
 * obligation instead of a silent omission, and the two control tests below keep it
 * from rotting into decoration while unused.
 */
export const EXCLUSIONS = Object.freeze({});

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

/**
 * Judge ONE exclusion. PURE, and exported so the controls can drive the whole
 * mechanism from fixtures even when EXCLUSIONS is empty — otherwise an empty
 * allowlist would silently disable its own enforcement, which is the shape this
 * whole suite exists to catch.
 *
 * @returns {string[]} problems; empty means the exclusion is valid TODAY
 */
export function judgeExclusion(wf, entry, { watched, text, exists = true }) {
  const out = [];
  if (!exists) return [`EXCLUSIONS names ${wf}, which does not exist — delete the entry`];
  if (typeof entry?.reason !== 'string' || entry.reason.length <= 80) {
    out.push(`${wf} must state WHY it is not watched, at length`);
  }
  if (typeof entry?.stillExcluded !== 'function') {
    out.push(`${wf} needs an expiry PREDICATE, not just prose`);
    return out;
  }
  if (watched.has(wf)) {
    out.push(`${wf} is BOTH in WATCHED and in EXCLUSIONS — delete the exclusion, it has served its purpose`);
  }
  if (!entry.stillExcluded(text)) {
    out.push(
      `${wf}'s exclusion reason NO LONGER HOLDS — the blocking condition is resolved, so register it in WATCHED `
      + 'and delete this exclusion. An exclusion that outlives its reason is a second copy of the problem this suite exists to catch.',
    );
  }
  return out;
}

test('EXCLUSIONS auto-expire: each reason is still TRUE, or the lane must be registered', () => {
  const watched = new Set(WATCHED.map((e) => e.workflow));
  const problems = [];
  for (const [wf, entry] of Object.entries(EXCLUSIONS)) {
    problems.push(...judgeExclusion(wf, entry, {
      watched,
      exists: existsSync(path.join(WF_DIR, wf)),
      text: existsSync(path.join(WF_DIR, wf)) ? read(wf) : '',
    }));
  }
  assert.deepEqual(problems, []);
  // EXCLUSIONS is currently EMPTY, which makes the loop above vacuous — so the
  // machinery is proved from fixtures in the next test instead. Stated rather
  // than left implicit: a green here today means "nothing is excluded", not
  // "the expiry check works".
});

test('CONTROL: the exclusion machinery works, driven from fixtures (EXCLUSIONS is empty)', () => {
  // Every branch of judgeExclusion, exercised without needing a live exclusion.
  // This is what keeps an empty allowlist from rotting into decoration, and it
  // is the exact mechanism that retired the IL5 entry: its predicate was "the
  // workflow still lacks a DRY-RUN run-name", and it expired the moment that
  // line landed.
  const il5Predicate = (text) => {
    const runName = text.replace(/\r\n/g, '\n').split('\n').find((l) => /^run-name:/.test(l));
    return !runName || !runName.includes(DRY_RUN_MARKER);
  };
  const REASON = 'x'.repeat(100);
  const none = new Set();

  // Still-blocked lane: predicate TRUE ⇒ valid exclusion, no problems.
  assert.deepEqual(
    judgeExclusion('w.yml', { reason: REASON, stillExcluded: il5Predicate }, { watched: none, text: 'name: w\non:\n' }),
    [],
  );
  // A run-name WITHOUT the marker is still blocked (gcc's historical state).
  assert.deepEqual(
    judgeExclusion('w.yml', { reason: REASON, stillExcluded: il5Predicate }, { watched: none, text: 'name: w\nrun-name: w (whatif-only)\n' }),
    [],
  );
  // THE EXPIRY: a run-name CARRYING the marker ⇒ the exclusion must fail.
  const expired = judgeExclusion(
    'w.yml',
    { reason: REASON, stillExcluded: il5Predicate },
    { watched: none, text: `name: w\nrun-name: w — ${DRY_RUN_MARKER} (whatif-only, applies nothing)\n` },
  );
  assert.equal(expired.length, 1, 'an expired predicate must produce exactly one problem');
  assert.match(expired[0], /NO LONGER HOLDS/);

  // Prose with no predicate is refused.
  assert.match(
    judgeExclusion('w.yml', { reason: REASON }, { watched: none, text: '' }).join(' '),
    /needs an expiry PREDICATE/,
  );
  // A too-thin reason is refused.
  assert.match(
    judgeExclusion('w.yml', { reason: 'because', stillExcluded: () => true }, { watched: none, text: '' }).join(' '),
    /must state WHY/,
  );
  // Belt-and-braces on both lists at once.
  assert.match(
    judgeExclusion('w.yml', { reason: REASON, stillExcluded: () => true }, { watched: new Set(['w.yml']), text: '' }).join(' '),
    /BOTH in WATCHED and in EXCLUSIONS/,
  );
  // A named file that does not exist is refused.
  assert.match(
    judgeExclusion('gone.yml', { reason: REASON, stillExcluded: () => true }, { watched: none, text: '', exists: false }).join(' '),
    /which does not exist/,
  );
});

test('ATOMICITY: IL5 is registered AND its run-name carries the marker — neither half alone', () => {
  // These two are ONE change split across two lanes' files, and either half alone
  // reddens main: registering without the run-name fails the DRY_RUN_MARKER
  // contract in deploy-staleness.test.mjs; the run-name without registration
  // expires the exclusion predicate above. Pinned together so a future edit
  // cannot remove one and leave the other.
  const entry = WATCHED.find((e) => e.workflow === 'deploy-fiab-il5.yml');
  assert.ok(entry, 'deploy-fiab-il5.yml is not in WATCHED — the DoD boundary is unmeasured again');

  const text = read('deploy-fiab-il5.yml');
  const runName = text.replace(/\r\n/g, '\n').split('\n').find((l) => /^run-name:/.test(l));
  assert.ok(runName, 'deploy-fiab-il5.yml lost its run-name while still being WATCHED — a default whatif-only dispatch would now clear its drift');
  assert.ok(
    runName.includes(DRY_RUN_MARKER),
    `deploy-fiab-il5.yml's run-name no longer carries "${DRY_RUN_MARKER}", so pickLastRealSuccess cannot filter a dry run out`,
  );

  // The entry has to be a real one, not a placeholder: it must declare the
  // template it applies and the param file that decides what that apply deploys.
  assert.ok(entry.paths.includes('platform/fiab/bicep/main.bicep'), 'the IL5 entry does not watch the estate template it applies');
  assert.ok(entry.paths.includes('platform/fiab/bicep/params/il5.bicepparam'), 'the IL5 entry does not watch its param file');
  assert.ok(typeof entry.maxDays === 'number' && entry.maxDays > 0, 'the IL5 entry needs a maxDays');
  assert.ok(typeof entry.why === 'string' && entry.why.length > 80, 'the IL5 entry needs a substantive `why`');

  // THE IMPORT EDGE. `_arm-absence.mjs` is imported by ensure-adx-cluster-running
  // and never argv, so NO execution shape can detect it — not the `.sh` matcher,
  // not the `node` matcher #3787 added. Hand-listing it is permanent, so it is
  // asserted here rather than trusted to a coverage guard that structurally
  // cannot see it.
  assert.ok(
    entry.paths.includes('scripts/ci/_arm-absence.mjs'),
    'the IL5 entry does not watch _arm-absence.mjs — an IMPORTED module no execution shape can ever detect',
  );
});
