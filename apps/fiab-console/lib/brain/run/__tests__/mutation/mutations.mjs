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
 * The second was a DECLARED BLIND SPOT — expected to survive, written down
 * rather than discovered — and it no longer is. The G3 fix from the review of
 * #4014 (assert the TRANSITION, not the destination state) closed it, and the
 * arm is now `expect: 'caught'`. There are currently NO declared survivors, and
 * `expect: 'survives'` remains available for the next honest one.
 *
 * The lesson that produced it is still the operating one: when an arm survives,
 * write it down and say why, rather than dropping it from the set.
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
      'THIS WAS A DECLARED BLIND SPOT AND IS NO LONGER ONE. It survived while the runtime ' +
      'guard only inspected records whose state was `new` and every test named its own ' +
      'detector. The G3 fix — asserting the TRANSITION (any fingerprint with a prior `fixed` ' +
      'record that recurs must appear in digest.regressions) rather than the destination ' +
      'state — closed it, because the guard now ranges over the occurrences instead of over ' +
      'one state. Kept, and flipped to `caught`: the arm that found the gap is the one most ' +
      'worth re-running.',
    expect: 'caught',
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
    // The needle moved when `suppressionExpired` gained its NaN guard (review of
    // #4014, S1) — the arm reported NEEDLE-MISSED, which is the harness being
    // honest and is ALSO an arm silently leaving the sweep's population. Re-aimed
    // at the return, which is what the mutation is actually about.
    find: '  return atMs >= expiresMs;',
    replace: '  return false;',
  },
  {
    // The DATA-side twin of the arm above, and the reason that one is not
    // sufficient on its own. `Date.parse` returns NaN for an unreadable expiry,
    // and every comparison against NaN is false — so a suppression could be made
    // permanent WITHOUT touching this code at all, just by writing 'never' into
    // a Cosmos document. The 26-arm sweep could not see that, because a mutation
    // sweep only mutates CODE. This arm removes the NaN guard so the sweep now
    // covers the data route too.
    id: 'unparseable-expiry-reads-as-not-yet-expired',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      'Removes the NaN guard from `suppressionExpired`, restoring the shape where an ' +
      "unparseable `expiresAt` ('', 'never', a date-only string) makes the comparison false " +
      'FOREVER. Same outcome as `suppressions-never-expire`, reached through DATA rather than ' +
      'code — which is exactly why a code-only mutation sweep cannot see it.',
    expect: 'caught',
    find: '  if (!Number.isFinite(atMs) || !Number.isFinite(expiresMs)) {',
    replace: '  if (false) {',
  },
  {
    // The READ-boundary half of the same finding. `reconcile()` dereferences
    // `prior.suppression.expiresAt`, and until this review nothing validated
    // what Cosmos handed back — an `accepted` document with no `suppression` at
    // all killed the whole run with a TypeError, every night, permanently.
    id: 'cosmos-read-boundary-removed',
    file: 'lib/brain/run/cosmos-finding-store.ts',
    why:
      'Restores the raw `as unknown as FindingRecord` cast on the READ path, so a stored ' +
      'document is reconciled against without any shape check. Two input shapes had no ' +
      'fixture anywhere before this review: one kills the lane permanently, the other ' +
      'suppresses a finding forever in silence.',
    expect: 'caught',
    find: '      out.push(validateFindingDocument(record, doc.id));',
    replace: '      out.push(record as unknown as FindingRecord);',
  },
  {
    // B1. The lane could not have completed a single run in either boundary, and
    // no gate on the PR could see it, because none of them authenticate.
    id: 'scan-identity-never-asserted',
    file: 'lib/brain/run/azure/scan-credential.ts',
    why:
      'Drops the fail-closed on a token minted by the wrong principal. The scan then ' +
      'authenticates as whatever the credential chain happens to pick — which, with ' +
      'EnvironmentCredential ahead of ManagedIdentityCredential, was the deploy service ' +
      'principal on every run, in both boundaries. It holds no Cosmos data-plane role, and ' +
      '`recordRun` fires on OK, PAUSED and UNREACHABLE alike.',
    expect: 'caught',
    find: '    if (!verdict.ok) throw new ScanIdentityError(verdict);',
    replace: '    if (!verdict.ok) void verdict;',
  },
  {
    // S5. The axis that turns "paused for sixty nights" into something other
    // than a green tick.
    id: 'scan-staleness-never-goes-red',
    file: 'lib/brain/run/scan.ts',
    why:
      'Removes the staleness arm from the exit-code mapping, so a lane that has not actually ' +
      'scanned anything inside its declared ceiling exits 0 exactly like a healthy paused ' +
      'night. Under the standing estate-pause mandate PAUSED is the NORMAL mode, so this is ' +
      'the shape in which the lane would go green forever having examined nothing.',
    expect: 'caught',
    find: '  if (outcome.scanStaleness?.exceeded === true) return 4;',
    replace: '',
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

  // ── ARMS FROM THE INDEPENDENT REVIEW OF #4014 ────────────────────────────
  //
  // All five SURVIVED on first measurement. Each is kept here permanently: the
  // arm that found a gap is the arm most worth re-running, because the gap it
  // found is the shape the next edit will take. The reviewer's framing was
  // right and is worth restating — the escapes were not in the logic the
  // original 14 arms covered, they were in the SEAMS: the composition root, the
  // real store, and the runtime module wiring.

  {
    id: 'cli-exit-from-verdict-only',
    file: 'lib/brain/run/cli.ts',
    why:
      "REVIEW ARM 4. The exact regression `unreachable-exits-zero` caught inside scan.ts, one " +
      'layer up in the composition root — which no test imported. `main()` is the only ' +
      'mapping the PROCESS uses, so a narrow verdict-only mapping here makes a POPULATION ' +
      'REGRESSION exit 0 and the workflow print "Scan completed."',
    expect: 'caught',
    find: '  return exitCodeForOutcome(outcome);',
    replace: "  return outcome.verdict.kind === 'unreachable' ? 2 : 0;",
  },
  {
    id: 'cli-entrypoint-never-fires',
    file: 'lib/brain/run/cli.ts',
    why:
      'REVIEW ARM 5. Neuter the direct-invocation predicate and `node cli.js` exits 0 having ' +
      'produced no output, no verdict, no job output and no step summary — while the workflow ' +
      'prints "Scan completed." GREEN OVER LITERALLY NOTHING, which is the precise failure ' +
      '#3936 exists to prevent.',
    expect: 'caught',
    find: "  return typeof argv1 === 'string' &&",
    replace: "  return false && typeof argv1 === 'string' &&",
  },  {
    id: 'regression-laundered-as-acknowledged-narrow',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      'REVIEW ARM 6, and the one that broke the compensation argument. Route a recurrence to ' +
      '`acknowledged` instead of `new`, scoped to a detector no test exercises. The runtime ' +
      'guard never fires because it only inspected records whose state is `new`; the digest ' +
      'counts it under stillOpen; nothing prints. The BROAD form below is caught, so this is ' +
      'the narrow shape this repo measures as the evasion that actually works.',
    expect: 'caught',
    find: "    if (prior.state === 'fixed') {\n      // ── THE REGRESSION.",
    replace:
      "    if (prior.state === 'fixed' && prior.detector === 'config-drift') {\n" +
      '      next.push({\n' +
      '        ...carried,\n' +
      "        state: 'acknowledged',\n" +
      "        acknowledgedBy: 'auto',\n" +
      '        acknowledgedAt: at,\n' +
      '        regressionCount: prior.regressionCount,\n' +
      '      });\n' +
      '      stillOpen += 1;\n' +
      '      continue;\n' +
      '    }\n' +
      "    if (prior.state === 'fixed') {\n      // ── THE REGRESSION.",
  },
  {
    id: 'regression-laundered-as-acknowledged-broad',
    file: 'lib/brain/run/lifecycle.ts',
    why:
      'REVIEW ARM 7 — the BROAD control for the arm above. Route EVERY recurrence to ' +
      '`acknowledged`. Without this pair the narrow arm proves nothing: a suite that caught ' +
      'only the broad form would look identical to one that caught both.',
    expect: 'caught',
    find: "    if (prior.state === 'fixed') {\n      // ── THE REGRESSION.",
    replace:
      "    if (prior.state === 'fixed') {\n" +
      '      next.push({\n' +
      '        ...carried,\n' +
      "        state: 'acknowledged',\n" +
      "        acknowledgedBy: 'auto',\n" +
      '        acknowledgedAt: at,\n' +
      '        regressionCount: prior.regressionCount,\n' +
      '      });\n' +
      '      stillOpen += 1;\n' +
      '      continue;\n' +
      '    }\n' +
      "    if (false) {\n      // ── THE REGRESSION.",
  },
  {
    id: 'suppression-ceiling-removed',
    file: 'lib/brain/run/model.ts',
    why:
      'REVIEW ARM 8. A suppression that never expires, in ONE TOKEN — because the over-long ' +
      'fixture was built FROM the constant (`MAX_SUPPRESSION_DAYS + 1`), so the guard moved ' +
      'with the code it guards. The direct answer to "can you make a suppression that never ' +
      'expires?" was yes.',
    expect: 'caught',
    find: 'export const MAX_SUPPRESSION_DAYS = 180;',
    replace: 'export const MAX_SUPPRESSION_DAYS = 3650000;',
  },
  {
    id: 'report-drops-not-evaluated',
    file: 'lib/brain/run/report.ts',
    why:
      'REVIEW ARM 9. Deletes the NOT EVALUATED section from the log report and the step ' +
      'summary. That section is the ONLY place a blind detector\'s frozen backlog surfaces to ' +
      'the operator, and no test asserted it.',
    expect: 'caught',
    find: '  if (d.notEvaluated.length > 0) {',
    replace: '  if (false) {',
  },
  {
    id: 'r7-reached-may-claim-unreachable',
    file: 'lib/brain/run/verdict.ts',
    why:
      'REVIEW ARM 10. Neuters the half of the R7 runtime assertion that stops a verdict which ' +
      'REACHED Azure from claiming it could not. That function is explicitly justified as the ' +
      'defense against "a later edit that unifies every red message under one phrase" — and ' +
      'the defense itself had no coverage.',
    expect: 'caught',
    find: '  if (!mustSay && says) {',
    replace: '  if (false) {',
  },
  {
    id: 'r7-reachfailure-need-not-say',
    file: 'lib/brain/run/verdict.ts',
    why:
      'REVIEW ARM 11. The other half: a genuine reach failure no longer has to say "could not ' +
      'reach".',
    expect: 'caught',
    find: '  if (mustSay && !says) {',
    replace: '  if (false) {',
  },
  {
    id: 'history-store-specifier-one-level-too-high',
    file: 'lib/brain/run/cli.ts',
    why:
      'S1(b) as a permanent arm. From `lib/brain/run/cli.js` the store specifier must be ' +
      '`../history/cosmos-store`; `../../history/cosmos-store` resolves to `lib/history/` and ' +
      'MODULE_NOT_FOUNDs. This shipped, and three gates missed it because none had the ' +
      'runtime-assembled specifier in its population.',
    expect: 'caught',
    find: "export const HISTORY_STORE_SPECIFIER = ['..', 'history', 'cosmos-store'].join('/');",
    replace:
      "export const HISTORY_STORE_SPECIFIER = ['..', '..', 'history', 'cosmos-store'].join('/');",
  },
  {
    id: 'population-basis-from-any-run',
    file: 'lib/brain/run/scan.ts',
    why:
      'S3 as a permanent arm. Take the population basis from the last run of ANY verdict ' +
      'rather than the last run that actually SCANNED. One PAUSED night then erases the ' +
      'baseline — and under the standing estate-pause mandate PAUSED is the normal operating ' +
      'mode, so the P0 comparator would be switched off almost always.',
    expect: 'caught',
    find: '  const previousRun = await deps.findings.lastScannedRun(deps.estateId);',
    replace: '  const previousRun = await deps.findings.lastRun(deps.estateId);',
  },
  {
    id: 'high-water-mark-ignored',
    file: 'lib/brain/run/population.ts',
    why:
      'G4 as a permanent arm. Without a high-water mark the comparator is a RATCHET: 19% per ' +
      'run for 12 runs loses 92.3% of the population with zero regressions reported, and a ' +
      'single large drop is red for exactly one run — clearable by pressing "Re-run jobs".',
    expect: 'caught',
    find: '    const highWater = prior.maxExamined;',
    replace: '    const highWater = 0;',
  },
  {
    id: 'high-water-rebase-unbounded',
    file: 'lib/brain/run/population.ts',
    why:
      'The SECOND-pass review finding, as a permanent arm. This restores the exact pre-fix ' +
      're-basing rule — the decayed mark takes TODAY\'S value unconditionally. Measured end to ' +
      'end through snapshotPopulations + detectPopulationRegression: drop 19% (inside the 20% ' +
      'step tolerance, so silent), hold 31 days, repeat twelve times, and 1000 -> 80 fires ZERO ' +
      'regressions over 372 days, because each hold launders the reduction into the new ' +
      'baseline. The anti-ratchet above is intact throughout — the identical erosion at DAILY ' +
      'cadence fires 11 of 12 — so this arm is invisible to every check that does not drive the ' +
      'DECAY.',
    expect: 'caught',
    find: '      maxExamined: announcedSinceMark ? examined : bounded,',
    replace: '      maxExamined: examined,',
  },
];

