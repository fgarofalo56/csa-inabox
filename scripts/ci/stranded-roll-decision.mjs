#!/usr/bin/env node
/**
 * STRANDED-ROLL DECISION — is a skipped roll benign, or is the estate stuck?
 *
 * WHY THIS EXISTS (#4298).
 *
 * `loom-roll-and-validate` chains off `build-fiab-images-acr-tasks` via
 * `workflow_run`, and its gate job is guarded by
 *
 *     if: github.event_name == 'workflow_dispatch'
 *      || github.event.workflow_run.conclusion == 'success'
 *      || github.event.workflow_run.conclusion == 'failure'
 *
 * That condition is CORRECT — you must not roll an image that was never built.
 * The defect is what happens when it is false: every job in the workflow is
 * skipped, GitHub records `conclusion: skipped` with `steps: []`, and nothing
 * anywhere says the estate did not move.
 *
 * MEASURED 2026-09-02. Five PRs merged between 03:38 and 04:21 UTC. The image
 * builds for three of them were CANCELLED by the next merge (the builder's
 * concurrency group cancels an older in-flight run), so three rolls skipped:
 *
 *     build  0e95b080  pending      <- carried all four merges
 *     build  dac8741a  cancelled
 *     build  2f4ae815  cancelled
 *     build  e52b55dc  queued (1h)
 *     roll   dac8741a  skipped, steps: []
 *     roll   0e95b080  skipped, steps: []
 *
 * The live console stayed on `e9df9169` — eight commits behind `main` — for
 * over four hours, with no red check, no annotation and no readiness signal.
 * `check-deploy-staleness.mjs` could not see it either: that measures lanes
 * that have NOT RUN, and this lane ran. It ran and did nothing.
 *
 * ── THE DISTINCTION THIS MODULE DRAWS ─────────────────────────────────────
 *
 * A cancelled build is USUALLY benign, and saying otherwise would cry wolf on
 * every merge train. During a train, each merge cancels the previous build and
 * the LAST build carries every earlier merge — the chain self-heals. So the
 * question is not "was a build cancelled" but:
 *
 *     IS THERE STILL A BUILD COMING THAT WILL CARRY THIS WORK?
 *
 * Benign when a NEWER producer run exists and is pending/queued/in_progress
 * (it will fire a roll), or already completed successfully (a roll already
 * fired for it), or concluded 'failure' with its loom-console job green (the
 * gate rolls on exactly that — see below). Stranded when there is no newer run
 * at all, or when every newer run ended in a state the gate declines.
 *
 * The tail case is the dangerous one and it is not hypothetical: if the merge
 * that cancelled the build is one the producer's `paths:` filter IGNORES — a
 * docs-only merge, which is exactly what #4296 was — then NO build is queued
 * and the estate stays behind indefinitely with nothing pending.
 *
 * ── A 'failure' SUCCESSOR IS NOT "NOTHING WAS PRODUCED" (#4300 review) ────
 *
 * The producer is a matrix over several images. When it concludes 'failure'
 * the gate does NOT stop — it reads the loom-console job's conclusion(s) out of
 * that run and rolls when they are all 'success', because a broken sibling
 * image does not make the console image unfit (#3260, `console_build=success`,
 * `proceed=true`). So a newer run that concluded 'failure' may well have rolled
 * this work, and the RUN LIST ALONE CANNOT TELL. The first version of this
 * module said "every newer producer run also ended without producing an image
 * ... the chain is broken" over exactly that run and told the operator to
 * dispatch a build that had already happened — the false-cause shape R7
 * forbids. Now a 'failure' run is judged by its `console_conclusions`, read by
 * the caller the way the gate reads them (`runsNeedingConsoleLookup` names the
 * set to read): all success is a carrier; anything else fired no roll; and a
 * run whose conclusions were not looked up, could not be read, or held no
 * loom-console job is reported as UNKNOWN naming that run — never as stranded.
 *
 * ── IT FAILS CLOSED ────────────────────────────────────────────────────────
 *
 * An unreadable API is NOT "no newer run". `decideStranded` takes the run list
 * as data and the caller passes `null` when the query itself failed; that
 * yields `unknown`, which the workflow treats as stranded-until-proven-
 * otherwise. Collapsing "I could not look" into "there is none" is the exact
 * defect `roll-gate-decision.mjs` was written to remove one gate over, and it
 * is not being re-introduced here.
 *
 * Pure functions. No network, no GitHub, no Azure — the caller does the I/O.
 */

/** Producer-run statuses that mean an image is still coming. */
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']);

/**
 * @typedef {object} ProducerRun
 * @property {string|number} id
 * @property {string} status              queued | in_progress | completed | pending | waiting
 * @property {string|null} conclusion     success | failure | cancelled | skipped | null
 * @property {string} created_at          ISO 8601
 * @property {string} [head_sha]
 * @property {string[]|null} [console_conclusions]
 *   Only meaningful on a run that concluded 'failure': the conclusion of every
 *   job in that run whose name matches /loom-console/, read the way
 *   loom-roll-and-validate's gate reads them. `undefined` = not looked up;
 *   `null` = the lookup FAILED; `[]` = looked up, no such job. Only a non-empty
 *   array establishes anything. Ignored on every other conclusion: the gate
 *   declines a cancelled/skipped run outright, whatever its matrix did.
 */

/**
 * @typedef {object} StrandedVerdict
 * @property {'benign'|'stranded'|'unknown'} verdict
 * @property {string} why                 one sentence, states only what was established
 * @property {string} [remediation]       the exact command, when there is one
 * @property {ProducerRun|null} carrier    the run that will (or did) carry the work
 */

/** The runs strictly newer than `since` (ms epoch), oldest first. Unparseable timestamps are excluded. */
function newerThan(producerRuns, since) {
  return producerRuns
    .filter((r) => r && Number.isFinite(Date.parse(r.created_at)) && Date.parse(r.created_at) > since)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** True when the loom-console conclusions of a run were actually read and named at least one job. */
function consoleEstablished(r) {
  return Array.isArray(r.console_conclusions) && r.console_conclusions.length > 0;
}

/** True when every loom-console job in the run succeeded — the condition the gate rolls on (#3260). */
function consoleSucceeded(r) {
  return consoleEstablished(r) && r.console_conclusions.every((c) => c === 'success');
}

/** Why a 'failure' run's roll outcome is not established, in the caller's terms. */
function consoleGap(r) {
  if (r.console_conclusions === undefined) return 'its loom-console job conclusions were not looked up';
  if (r.console_conclusions === null) return 'its loom-console job conclusions could not be READ';
  return "it reported NO job matching 'loom-console'";
}

/** `id:conclusion`, with the loom-console detail on a failure whose jobs were read. */
function describeEnd(r) {
  const base = `${r.id}:${r.conclusion || r.status}`;
  return r.conclusion === 'failure' && consoleEstablished(r)
    ? `${base}(loom-console: ${r.console_conclusions.join(',')})`
    : base;
}

/**
 * The runs whose loom-console outcome the caller must read before
 * `decideStranded` can say anything about them: every producer run NEWER than
 * the skipped one that concluded 'failure'. Exported so the runner enriches
 * exactly the set the decision consults — one predicate, not two that drift.
 * Returns [] when the list or timestamp is unusable; `decideStranded` reports
 * those as `unknown` on its own.
 *
 * @param {object} args
 * @param {string} args.upstreamCreatedAt
 * @param {ProducerRun[]|null|undefined} args.producerRuns
 * @returns {ProducerRun[]}
 */
export function runsNeedingConsoleLookup({ upstreamCreatedAt, producerRuns }) {
  if (!Array.isArray(producerRuns)) return [];
  const since = Date.parse(upstreamCreatedAt);
  if (!Number.isFinite(since)) return [];
  return newerThan(producerRuns, since).filter((r) => r.conclusion === 'failure');
}

/**
 * Decide whether a skipped roll leaves the estate stranded.
 *
 * @param {object} args
 * @param {string|null|undefined} args.upstreamConclusion  the conclusion that skipped the roll
 * @param {string} args.upstreamCreatedAt                  ISO timestamp of the skipped run
 * @param {ProducerRun[]|null} args.producerRuns           ALL recent producer runs, or null if
 *                                                         the query FAILED (never [] for that)
 * @param {string} [args.producerWorkflow]
 * @returns {StrandedVerdict}
 */
export function decideStranded({
  upstreamConclusion,
  upstreamCreatedAt,
  producerRuns,
  producerWorkflow = 'build-fiab-images-acr-tasks.yml',
}) {
  const dispatch = `gh workflow run ${producerWorkflow} --ref main`;

  // A success or failure never reaches this module — the gate handles both — but
  // being explicit costs nothing and stops a future caller misusing it.
  if (upstreamConclusion === 'success' || upstreamConclusion === 'failure') {
    return {
      verdict: 'benign',
      why: `the producer concluded '${upstreamConclusion}', which the roll gate handles directly; this module was not the deciding factor.`,
      carrier: null,
    };
  }

  if (producerRuns === null || producerRuns === undefined) {
    return {
      verdict: 'unknown',
      why:
        `the producer run list could not be READ, so whether another build is coming was NOT established. `
        + `This is reported as unknown rather than as "no build is coming" — an unreadable query is not a negative answer.`,
      remediation: dispatch,
      carrier: null,
    };
  }
  if (!Array.isArray(producerRuns)) {
    return {
      verdict: 'unknown',
      why: 'the producer run list was not an array, so nothing was established about it.',
      remediation: dispatch,
      carrier: null,
    };
  }

  const since = Date.parse(upstreamCreatedAt);
  if (!Number.isFinite(since)) {
    return {
      verdict: 'unknown',
      why: `the skipped run's created_at ('${upstreamCreatedAt}') could not be parsed, so 'newer than it' could not be evaluated.`,
      remediation: dispatch,
      carrier: null,
    };
  }

  const newer = newerThan(producerRuns, since);

  const coming = newer.find((r) => PENDING_STATUSES.has(r.status));
  if (coming) {
    return {
      verdict: 'benign',
      why:
        `a newer producer run (${coming.id}, status '${coming.status}') is still going, and it carries this work — `
        + 'the merge train self-heals when it completes.',
      carrier: coming,
    };
  }

  const succeeded = newer.find((r) => r.status === 'completed' && r.conclusion === 'success');
  if (succeeded) {
    return {
      verdict: 'benign',
      why: `a newer producer run (${succeeded.id}) already SUCCEEDED, so a roll has already fired for a SHA that contains this work.`,
      carrier: succeeded,
    };
  }

  // A 'failure' run whose loom-console job(s) all succeeded: the gate sets
  // proceed=true on exactly that (#3260), so the roll chained to it is the one
  // that carries this work. Its outcome is on that roll's own run, not here.
  const consoleCarrier = newer.find((r) => r.conclusion === 'failure' && consoleSucceeded(r));
  if (consoleCarrier) {
    return {
      verdict: 'benign',
      why:
        `a newer producer run (${consoleCarrier.id}) concluded 'failure', but its loom-console job concluded `
        + `'${consoleCarrier.console_conclusions.join(',')}' — and the roll gate proceeds on exactly that (#3260: a broken `
        + 'sibling image does not withhold a built console). So the roll chained to that run is the one that carries this '
        + `work; whether it succeeded is on run ${consoleCarrier.id}'s roll, not established here.`,
      carrier: consoleCarrier,
    };
  }

  if (newer.length === 0) {
    return {
      verdict: 'stranded',
      why:
        `the producer run for this SHA ended '${upstreamConclusion}' and NO newer producer run exists at all. `
        + "Nothing is coming: if the commit that superseded this one does not match the producer's `paths:` filter "
        + '(a docs-only merge, for instance), no build was ever queued and the estate stays behind indefinitely.',
      remediation: dispatch,
      carrier: null,
    };
  }

  // A 'failure' run whose loom-console outcome was NOT established cannot be
  // counted as "fired no roll" — its own gate decided that, and this module
  // did not see what it saw. Say so, and name the run, rather than assert the
  // chain is broken over a roll that may have shipped (#4300 review, R7).
  const unresolved = newer.filter((r) => r.conclusion === 'failure' && !consoleEstablished(r));
  if (unresolved.length > 0) {
    const named = unresolved.map((r) => `${r.id} (${consoleGap(r)})`).join('; ');
    return {
      verdict: 'unknown',
      why:
        `the producer run for this SHA ended '${upstreamConclusion}', and a newer producer run concluded 'failure' — `
        + `${named}. Its own roll gate decided whether loom-console rolled from it (#3260: it rolls when loom-console `
        + 'succeeded on a failed sibling), and that decision was NOT established here. Whether a roll fired for a SHA '
        + `that contains this work is therefore unknown — see run ${unresolved[0].id}.`,
      remediation:
        `gh run view ${unresolved[0].id}   # did its loom-console job succeed, and did the chained roll proceed?\n`
        + `${dispatch}   # only if no roll proceeded for it`,
      carrier: null,
    };
  }

  // Every newer run is one the gate declines: cancelled/skipped/etc outright,
  // or 'failure' with loom-console read and not all success (proceed=false).
  const ends = newer.map(describeEnd).join(', ');
  return {
    verdict: 'stranded',
    why:
      `the producer run for this SHA ended '${upstreamConclusion}', and every newer producer run also ended in a state `
      + `the roll gate declines, so no roll fired for any of them (${ends}). The chain is broken rather than merely delayed.`,
    remediation: dispatch,
    carrier: null,
  };
}

/** True when the workflow should fail loudly rather than exit quietly. */
export function shouldFail(verdict) {
  return verdict === 'stranded' || verdict === 'unknown';
}

export const __testing = { PENDING_STATUSES };
