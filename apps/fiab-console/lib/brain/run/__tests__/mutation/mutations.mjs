/**
 * LOOM BRAIN W10 — THE MUTATION SET (#3936 acceptance 5).
 *
 * Each arm is a SOURCE EDIT that removes or weakens one property this lane
 * claims. The suite must go RED for every arm marked `expect: 'caught'`. An arm
 * that stays green is not a pass — it is a FINDING about the tests, and
 * `run-arms.mjs` reports it as one rather than hiding it.
 *
 * ── WHY SOME ARMS ARE DELIBERATELY EXPECTED TO SURVIVE ────────────────────
 * `csa_loom_the_narrow_bypass_is_the_evasion_that_works`: this repo measures
 * that a bypass scoped to ONE itemType / cursor / detector passes a broad guard
 * and a full suite, while the broad form goes red instantly. So the set carries
 * BOTH forms of the same evasion:
 *
 *   narrow-regression-bypass-covered    scoped to a detector the tests exercise
 *   narrow-regression-bypass-uncovered  scoped to a detector they do not
 *
 * The second is expected to SURVIVE, and that expectation is written down here
 * rather than discovered later. It is the honest measure of this suite's blind
 * spot, and it is why the runtime guard `assertNoRegressionReportedAsNew` exists
 * in addition to the tests.
 *
 * ── CRLF ───────────────────────────────────────────────────────────────────
 * A needle that does not match is a silent no-op that reads as "the mutation was
 * caught" — measured in this repo as
 * `csa_loom_crlf_makes_mutation_needles_silently_noop`. `run-arms.mjs` therefore
 * asserts the file actually CHANGED, and reports NEEDLE-MISSED as its own
 * outcome, distinct from both caught and survived.
 */

/** Repo-relative from `apps/fiab-console`. */
export const CONSOLE_RELATIVE = true;

export const MUTATIONS = [
  {
    id: 'regression-reported-as-new',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      'THE REQUIRED ARM. Removes the fixed -> regressed transition so a finding that comes ' +
      'back after being repaired is reported as merely `new`. This is the single most ' +
      'valuable signal in the lane; if this survives, the lane is decorative.',
    expect: 'caught',
    find: "    if (prior.state === 'fixed') {",
    replace: "    if (false && prior.state === 'fixed') {",
  },
  {
    id: 'narrow-regression-bypass-covered',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      'The NARROW form of the arm above, scoped to a detector the lifecycle suite exercises ' +
      "('unreachable-service'). A broad guard plus a full suite is exactly what a narrow " +
      'bypass walks past; this arm is here to prove the tests are not merely broad.',
    expect: 'caught',
    find: "    if (prior.state === 'fixed') {",
    replace:
      "    if (prior.state === 'fixed' && prior.detector !== 'unreachable-service') {",
  },
  {
    id: 'narrow-regression-bypass-uncovered',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      "The same bypass scoped to a detector NO test exercises for regression ('config-drift'). " +
      'EXPECTED TO SURVIVE. Recorded rather than hidden: it is the measured blind spot of this ' +
      'suite, and the reason the runtime guard exists in addition to the tests.',
    expect: 'survives',
    find: "    if (prior.state === 'fixed') {",
    replace: "    if (prior.state === 'fixed' && prior.detector !== 'config-drift') {",
  },
  {
    id: 'scheduler-produces-zero-findings',
    file: 'lib/brain/run/scan.ts',
    why:
      'THE REQUIRED ARM. Runs the scan with an EMPTY detector list, so every run reports a ' +
      'clean estate. A lane that can be silently emptied is the `lcu-autopilot` failure with ' +
      'extra steps.',
    expect: 'caught',
    find: '  const detectorRun = runDetectors(source.graph, deps.detectors);',
    replace: '  const detectorRun = runDetectors(source.graph, []);',
  },
  {
    id: 'blind-detector-closes-its-backlog',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      'Deletes P-BLIND: a detector that ranged over NOTHING may now mark its whole backlog ' +
      'fixed. The run after the detector is repaired then re-reports every one of them as ' +
      '`new`, so the regression signal is not merely lost — it is inverted into a wave of ' +
      'false new findings.',
    expect: 'caught',
    find: '    if (!evaluatedDetectors.has(prior.detector)) {',
    replace: '    if (false && !evaluatedDetectors.has(prior.detector)) {',
  },
  {
    id: 'paused-from-merely-not-running',
    file: 'lib/brain/run/verdict.ts',
    why:
      'Replaces "every reading is DEFINITIVELY stopped" with "nothing is Online", which ' +
      'launders Unknown / Pausing / Resuming / Starting / Scaling into PAUSED. A mid-pause or ' +
      'half-broken estate then reads as a clean neutral outcome and the lane can never go red.',
    expect: 'caught',
    find: '  if (definitelyStopped === probe.readings.length) {',
    replace: '  if (running === 0) {',
  },
  {
    id: 'could-not-reach-on-every-red-verdict',
    file: 'lib/brain/run/verdict.ts',
    why:
      'The 2026-08-05 defect, reintroduced: unify every red message under one phrase, so a ' +
      'run that REACHED Azure and got zero rows claims a connectivity failure. That exact ' +
      'substitution sent two investigations down the wrong path.',
    expect: 'caught',
    find: '        `reached Azure (${ctx.cloud}) successfully and the discovery query returned ZERO ` +',
    replace:
      '        `${COULD_NOT_REACH} — reached Azure (${ctx.cloud}) and the discovery query returned ZERO ` +',
  },
  {
    id: 'suppressions-never-expire',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      'Makes every suppression permanent. An `accepted` that never expires is ' +
      'indistinguishable from a deleted detector, and it is how a real finding gets buried ' +
      'with a plausible-looking reason attached.',
    expect: 'caught',
    find: '  return Date.parse(at) >= Date.parse(s.expiresAt);',
    replace: '  return false;',
  },
  {
    id: 'acceptance-without-a-reason',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      'Drops the empty-reason rejection, so a finding can be suppressed with no explanation ' +
      'at all. Six months later nobody can tell that record from a detector that was deleted.',
    expect: 'caught',
    find: "  if (reason === '') {",
    replace: '  if (false) {',
  },
  {
    id: 'population-regression-goes-unseen',
    file: 'lib/brain/run/population.ts',
    why:
      'Deletes the went-blind branch, so a detector that examined 33 things yesterday and 0 ' +
      'today passes silently. Measured live on 2026-08-24: without this signal the run ' +
      'reported a cheerful `ok` with "0 findings" after its input was destroyed.',
    expect: 'caught',
    find: '    if (!prior.blind && cur.blind) {',
    replace: '    if (false && !prior.blind && cur.blind) {',
  },
  {
    id: 'probe-may-lose-a-resource-silently',
    file: 'lib/brain/run/verdict.ts',
    why:
      'Removes the discovered-vs-readings check, so a probe that quietly drops resources ' +
      'shrinks the examined population with nothing to see it — PRP §3.8 names that as this ' +
      "repo's dominant evasion class.",
    expect: 'caught',
    find: '  if (probe.readings.length !== probe.discovered) {',
    replace: '  if (false) {',
  },
  {
    id: 'store-hides-fixed-findings',
    file: 'lib/brain/run/ports.ts',
    why:
      'Defeats the regression property one layer BELOW the lifecycle, where no type can catch ' +
      'it: the store stops returning `fixed` records, so every recurrence looks brand new and ' +
      '`reconcile` is never even given the chance to see the repair history.',
    expect: 'caught',
    find: '    return [...this.bucket(estateId).values()];',
    replace: "    return [...this.bucket(estateId).values()].filter((r) => r.state !== 'fixed');",
  },
  {
    id: 'unreachable-exits-zero',
    file: 'lib/brain/run/scan.ts',
    why:
      'Makes a red verdict exit 0. A scheduled job that exits 0 having produced nothing is ' +
      'precisely the silently-broken path `deploy-integrity.md` R1 forbids, and this repo has ' +
      'shipped several.',
    expect: 'caught',
    find: "  if (outcome.verdict.kind === 'unreachable') return 2;",
    replace: "  if (false) return 2;",
  },
  {
    id: 'paused-run-reconciles-the-backlog',
    file: 'lib/brain/run/scan.ts',
    why:
      'Lets a PAUSED run fall through to the scanning path. Reconciling against a run that ' +
      'examined nothing marks the entire backlog fixed, and the first run after a resume ' +
      're-reports all of it as new.',
    expect: 'caught',
    find: "  if (verdict.kind !== 'ok') {",
    replace: "  if (verdict.kind === 'unreachable') {",
  },
];
