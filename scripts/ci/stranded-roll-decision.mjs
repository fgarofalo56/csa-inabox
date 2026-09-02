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
 * fired for it). Stranded when there is no newer run at all, or when every
 * newer run also ended without producing an image.
 *
 * The tail case is the dangerous one and it is not hypothetical: if the merge
 * that cancelled the build is one the producer's `paths:` filter IGNORES — a
 * docs-only merge, which is exactly what #4296 was — then NO build is queued
 * and the estate stays behind indefinitely with nothing pending.
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
 */

/**
 * @typedef {object} StrandedVerdict
 * @property {'benign'|'stranded'|'unknown'} verdict
 * @property {string} why                 one sentence, states only what was established
 * @property {string} [remediation]       the exact command, when there is one
 * @property {ProducerRun|null} carrier    the run that will (or did) carry the work
 */

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

  const newer = producerRuns
    .filter((r) => r && Number.isFinite(Date.parse(r.created_at)) && Date.parse(r.created_at) > since)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

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

  const ends = newer.map((r) => `${r.id}:${r.conclusion || r.status}`).join(', ');
  return {
    verdict: 'stranded',
    why:
      `the producer run for this SHA ended '${upstreamConclusion}', and every newer producer run also ended without `
      + `producing an image (${ends}). The chain is broken rather than merely delayed.`,
    remediation: dispatch,
    carrier: null,
  };
}

/** True when the workflow should fail loudly rather than exit quietly. */
export function shouldFail(verdict) {
  return verdict === 'stranded' || verdict === 'unknown';
}

export const __testing = { PENDING_STATUSES };
