#!/usr/bin/env node
/**
 * roll-lease-budget.mjs — ONE lease-wait budget for the whole
 * loom-dataplane-roll job, and a TRUE result when that job is cancelled (#4823).
 *
 * WHY THIS EXISTS (measured, run 36665140502, 2026-09-30)
 *
 *   The job has `timeout-minutes: 45`. It takes the ACR firewall lease in three
 *   steps — the preflight, the digest re-assertion and the :v0.1 pin — and each
 *   acquire used scripts/csa-loom/acr-firewall-lease.sh's default bounded wait,
 *   `LOOM_ACR_LEASE_WAIT_MINUTES:-25`. Job start 03:36:32 → step 16 (digest)
 *   started 03:40:07, waited its full 25 minutes behind
 *   build-fiab-images-acr-tasks (which takes a 120-minute lease) and exited
 *   `verdict=unknown` at 04:05:24 as designed; step 19 (pin) then started a
 *   SECOND 25-minute wait and was killed at 04:21:45 by the job timeout.
 *   ~4 minutes of setup + 25 + 25 cannot fit in 45, so whenever the next
 *   commit's build held the lease the roll ALWAYS timed out — 4 of the last 10
 *   rolls (36665140502, 36609548942, 36518875467, 36515448866).
 *
 *   And the timeout was SILENT. GitHub concludes a timed-out job `cancelled`,
 *   so `Notify on failure` (`if: failure()`) and `Durability NOT established`
 *   (`success() && …`) were both skipped; the pin step's own clean "could not
 *   acquire" error never fired because the step was killed before its wait
 *   ended. The one trace was a step-summary row.
 *
 * WHAT THIS DOES
 *
 *   `deadline`       the resolve step turns LOOM_ROLL_LEASE_BUDGET_MINUTES into
 *                    one absolute epoch, ROLL_LEASE_DEADLINE, in $GITHUB_ENV.
 *   `wait-minutes`   every acquire in the job waits only for what is LEFT of
 *                    that deadline. Waits taken in different steps therefore
 *                    cannot sum past the budget, by construction — there is one
 *                    number to keep below `timeout-minutes`, not three.
 *   `unacquired`     when an acquire fails, read the lease back and say TRUTHFULLY
 *                    what that later read shows (R7) — a snapshot taken after the
 *                    acquire gave up, not the reason it failed. Only a LIVE lease
 *                    held by ANOTHER holder at that read is classified as
 *                    contention (`transient`), and only then is a
 *                    deploy-failure.json written for the notifier. A lease that
 *                    reads back free, stale, ours, or unreadable asserts no cause.
 *   `notify-result`  turns the job status into the result the notifier is given.
 *                    A cancel that reached the timeout is reported as
 *                    `timed_out` (a genuine failure in run-outcome.mjs) AND, with
 *                    --out, writes a timeout-shaped deploy-failure.json over any
 *                    earlier one, so the filed issue says it timed out; any
 *                    earlier cancel stays `cancelled` and is logged, not filed.
 *
 * WHAT IT DOES NOT DO
 *
 *   It does not change what is pinned or when. It does not bound the roll's own
 *   retry wall-clocks (deploy-retry.mjs, up to 15m per app) — a job can still
 *   time out on those, and `notify-result` is what makes that visible.
 *
 *   The budget is a DEADLINE, not accumulated waiting. It is measured from the
 *   resolve step, so the NON-lease work between acquires (the roll, health,
 *   live-image verification) spends it too. A roll whose steps before the pin
 *   take longer than the budget leaves the pin a 0-minute wait — one attempt —
 *   so the pin then fails on ANY contention and files a failure notice. That
 *   is the price of the bound: a pin that cannot finish inside the job is the
 *   failure #4823 was; a pin that fails fast and says who held the lease is not.
 *
 * Tests: node --test scripts/ci/__tests__/roll-lease-budget.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactedLine } from './_azure-redact.mjs';

/*
 * PUBLICATION-SINKS: 2
 *
 * This module writes to a PUBLIC run log in exactly two places: the CLI's stdout
 * (`cliMain`'s default `out`) and the stderr line on a thrown error. Both carry
 * text read from the registry's lease TAGS (owner, holder url), which another
 * workflow wrote — so both go through redactedLine(), the shared publication
 * boundary, rather than trusting that no tag ever holds a subscription or
 * tenant id. The count above is DECLARED so the security graph's declared-count
 * drift check is live for this module: a third sink without updating it is a
 * finding.
 */

/**
 * A cancel observed at least this close to the job's timeout-minutes limit is
 * the timeout. ROLL_JOB_STARTED is written by the job's FIRST step, ahead of
 * checkout and setup-node, so slow setup cannot eat into the margin. It is
 * still read a few seconds after the job's own start, and the cancel reaches
 * the notify step a few seconds after the limit, so the measured elapsed time
 * at a timeout lands within about 2 minutes EITHER SIDE of timeout-minutes. In
 * run 36665140502 the job started 03:36:32 and the pin was cancelled 04:21:45,
 * i.e. 2713 s against a 2700 s limit — OVER, not under. The verdict is
 * `elapsed >= limit*60 - margin`, so over is always a timeout; the margin
 * exists for the under side. The cost is that a person cancelling in the last
 * two minutes is reported as a timeout.
 */
export const TIMEOUT_MARGIN_SECONDS = 120;

/**
 * The taxonomy signal ids this module writes into deploy-failure.json. Both
 * are REGISTERED in apps/fiab-console/lib/deploy/failure-taxonomy.json under
 * the same class, in the `<class>.<name>` form every signal there uses;
 * roll-lease-budget.test.mjs fails if either is missing or its class differs.
 */
export const LEASE_SIGNAL_ID = 'transient.acr-lease-held-past-roll-budget';
export const TIMEOUT_SIGNAL_ID = 'transient.job-exceeded-timeout-minutes';

/**
 * The exact re-dispatch command for this lane, or null when a value it needs
 * is unknown (it is then NOT guessed — the caller says what is missing).
 * boundary and tag are validated by the resolve step (a choice value, and an
 * OCI tag charset); apps is quoted unless it is plainly safe.
 */
export function redispatchCommand({ boundary, tag, apps }) {
  const b = String(boundary ?? '').trim();
  const t = String(tag ?? '').trim();
  const a = String(apps ?? '').trim() || 'all';
  if (!/^(commercial|gcc-high|il5)$/.test(b) || !/^[A-Za-z0-9._-]+$/.test(t)) return null;
  const appsArg = /^[A-Za-z0-9,._-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
  return `gh workflow run loom-dataplane-roll.yml -f boundary=${b} -f tag=${t} -f apps=${appsArg}`;
}

function redispatchSentence(ctx) {
  const cmd = redispatchCommand(ctx);
  return cmd
    ? `Re-dispatch: \`${cmd}\``
    : 'The re-dispatch command cannot be stated exactly because this run did not record its resolved boundary ' +
        `('${ctx.boundary ?? ''}') and tag ('${ctx.tag ?? ''}') — the resolve step did not complete. Dispatch ` +
        'loom-dataplane-roll.yml with the boundary and tag this run was given.';
}

function positiveInt(value, name) {
  const s = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(s) || Number(s) <= 0) {
    throw new Error(`${name} must be a positive integer, got '${s || '<empty>'}'`);
  }
  return Number(s);
}

function epochInt(value, name) {
  const s = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`${name} must be an integer epoch in seconds, got '${s || '<empty>'}'`);
  }
  return Number(s);
}

/** The absolute deadline for every lease wait in this job. */
export function leaseDeadline({ budgetMinutes, nowEpoch }) {
  return epochInt(nowEpoch, 'now') + positiveInt(budgetMinutes, 'budget-minutes') * 60;
}

/**
 * How long ONE acquire may wait, in the helper's unit (whole minutes).
 *
 * FLOOR, never round or ceil: a ceil would let a step with 61 s left wait 2
 * minutes, i.e. past the deadline. At or past the deadline this is 0, which the
 * helper treats as "one attempt, no wait" — a free lease is still taken.
 */
export function remainingWaitMinutes({ deadlineEpoch, nowEpoch }) {
  const left = epochInt(deadlineEpoch, 'deadline') - epochInt(nowEpoch, 'now');
  return left <= 0 ? 0 : Math.floor(left / 60);
}

/**
 * The holder id acr-firewall-lease.sh records for THIS run, mirrored from its
 * `_lease_default_owner` (GHA branch, with the LOOM_ACR_LEASE_OWNER override
 * first) and its `_lease_sanitize` character class.
 */
export function selfOwner(env = process.env) {
  const sanitize = (s) => String(s).replace(/[^A-Za-z0-9._:@/-]/g, '_');
  if (env.LOOM_ACR_LEASE_OWNER) return sanitize(env.LOOM_ACR_LEASE_OWNER);
  return sanitize(
    `gha:${env.GITHUB_REPOSITORY || 'unknown'}:${env.GITHUB_RUN_ID || '0'}:${env.GITHUB_RUN_ATTEMPT || '1'}`,
  );
}

/**
 * Parse `acr-firewall-lease.sh status` output.
 *
 * The helper reads every field through `_lease_acr_q`, which discards az's
 * stderr and returns '' on any failure, and then prints an empty owner as
 * `none` and the state as `free`. So an UNREADABLE registry prints exactly what
 * a free one prints, except for `publicNetworkAccess : <unreadable>`. That line
 * is therefore the readability test: without it a read failure would be
 * reported here as "the lease is free", which is a claim nobody established.
 */
export function parseLeaseStatus(text) {
  const field = (label) => {
    const m = String(text ?? '').match(new RegExp(`^${label}\\s*:\\s*(.*?)\\s*$`, 'm'));
    return m ? m[1] : null;
  };
  const pna = field('publicNetworkAccess');
  const owner = field('lease owner');
  const url = field('lease holder url');
  const stateLine = field('lease state');
  if (pna === null || owner === null || stateLine === null || pna === '<unreadable>') {
    return { readable: false, owner: null, url: null, state: null, remainingSeconds: null };
  }
  let state = 'unknown';
  let remainingSeconds = null;
  const live = stateLine.match(/^LIVE \((-?[0-9]+)s remaining\)/);
  if (live) {
    state = 'live';
    remainingSeconds = Number(live[1]);
  } else if (/^STALE\b/.test(stateLine)) {
    state = 'stale';
  } else if (stateLine === 'free') {
    state = 'free';
  }
  return { readable: true, owner, url: url ?? 'none', state, remainingSeconds };
}

/**
 * What to say — and whether to classify — when an acquire failed.
 *
 * WHAT THE READ-BACK IS, AND IS NOT (R7). `status` is read AFTER the acquire
 * gave up, so it is a snapshot of that later moment, not the reason the
 * acquire failed: a holder can release, or hand over to another, between the
 * acquire's last check and this read. So every message below says "when read
 * back after the acquire gave up" and asserts nothing about the wait itself.
 * The acquire's own `TIMED OUT … Current holder:` line
 * (scripts/csa-loom/acr-firewall-lease.sh, acquire loop) is the record of the
 * holder it actually saw, and the messages point at it.
 *
 * Only a LIVE lease held by ANOTHER owner at the read-back is classified
 * (`transient` contention). That classification rests on the read-back alone
 * (this module never parses the acquire's output), and the class promises only
 * that the same run, unchanged, is expected to succeed once a holder finishes.
 *
 * @returns {{verdict: 'held-by-other'|'not-held-by-other'|'holder-unreadable', message: string, failure: object|null}}
 */
export function describeUnacquired({ status, self, step, acr, waitMinutes, budgetMinutes, boundary, tag, apps }) {
  const allowance =
    `This step was allowed to wait up to ${waitMinutes}m — what remained of this job's ` +
    `${budgetMinutes}m lease-wait budget, a deadline shared by every lease acquire in the job so ` +
    'their waits cannot add up past timeout-minutes.';
  const pointer =
    "If the acquire timed out, its own `TIMED OUT … Current holder:` line above names the holder it actually saw.";

  if (!status.readable) {
    return {
      verdict: 'holder-unreadable',
      message:
        `Could not read the ACR firewall lease on '${acr}' back after the acquire gave up, so the holder is ` +
        `NOT named here and no cause is asserted. ${pointer} ${allowance}`,
      failure: null,
    };
  }

  if (status.state === 'live' && status.owner !== self && status.owner !== 'none') {
    const readBack =
      `when read back after the acquire gave up, the ACR firewall lease on '${acr}' was held by ` +
      `'${status.owner}' (${status.url}), LIVE for another ${status.remainingSeconds}s`;
    return {
      verdict: 'held-by-other',
      message:
        `The acquire gave up after this step's ${waitMinutes}m allowance; ${readBack}. That read-back is a later ` +
        `snapshot and does not by itself establish who held the lease throughout the wait. ${pointer} ` +
        `${allowance} Contention for the lease, not a defect in this run.`,
      failure: {
        schemaVersion: 1,
        step,
        command: 'acr-firewall-lease.sh acquire',
        class: 'transient',
        signalId: LEASE_SIGNAL_ID,
        retryable: true,
        established: [
          {
            signal: 'acr-lease-read-back',
            line:
              `read back after the acquire gave up: lease owner '${status.owner}', holder url ${status.url}, ` +
              `LIVE for another ${status.remainingSeconds}s`,
          },
        ],
        remediationKind: 'operator-action',
        remediation:
          'Nothing in the roll is broken; the registry lease was held by another run. If that holder is ' +
          'build-fiab-images-acr-tasks on a push to main, its successful completion triggers a new automatic ' +
          'roll of that newer commit, which takes the lease and pins :v0.1 itself — no action is needed. ' +
          `Otherwise, once the holder has finished: ${redispatchSentence({ boundary, tag, apps })}`,
        whyStopped:
          `the acquire gave up after this step's allowance of ${waitMinutes}m (the remainder of the job's ` +
          `${budgetMinutes}m shared lease-wait budget); ${readBack}`,
      },
    };
  }

  const recorded =
    status.state === 'live'
      ? `held by THIS run ('${status.owner}')`
      : `${status.state} (recorded owner '${status.owner}')`;
  return {
    verdict: 'not-held-by-other',
    message:
      `When read back after the acquire gave up, the ACR firewall lease on '${acr}' was recorded as ${recorded}. ` +
      'That is a later snapshot, not the reason the acquire failed — a holder may have released in between, and ' +
      "the helper also prints owner 'none' / free when it cannot read the owner tag — so no cause is asserted " +
      `here. ${pointer} ${allowance}`,
    failure: null,
  };
}

/**
 * The --result to hand deploy-notify-failure.mjs, and a TRUE note about it.
 *
 * A running job in this workflow is NOT cancelled by concurrency: the group has
 * `cancel-in-progress: false`, so a newer run waits as PENDING (and it is the
 * older PENDING run GitHub cancels, before it has any steps). A cancel observed
 * by a step here is therefore the timeout or a person/GitHub cancelling this
 * run — never a supersede, so there is no quiet "superseded" branch to keep.
 */
export function notifyResult({ jobStatus, startedEpoch, nowEpoch, timeoutMinutes }) {
  const status = String(jobStatus ?? '').trim();
  if (status !== 'cancelled') return { result: status, level: null, note: null };

  const limit = positiveInt(timeoutMinutes, 'timeout-minutes');
  if (!/^[0-9]+$/.test(String(startedEpoch ?? '').trim())) {
    return {
      result: 'cancelled',
      level: 'warning',
      note:
        'This run was CANCELLED before its start time was recorded, so whether it hit the ' +
        `${limit}-minute timeout cannot be established. Reported as cancelled (no verdict); nothing is filed.`,
    };
  }
  const elapsed = epochInt(nowEpoch, 'now') - epochInt(startedEpoch, 'started');
  if (elapsed >= limit * 60 - TIMEOUT_MARGIN_SECONDS) {
    return {
      result: 'timed_out',
      level: 'error',
      elapsedSeconds: elapsed,
      limitMinutes: limit,
      note:
        `This run was cancelled ${elapsed}s after it started — at its ${limit}-minute timeout-minutes limit. ` +
        'GitHub concludes a timed-out job as `cancelled`, which the failure notifier would log and not file, ' +
        'so it is reported as timed_out: a genuine failure. The step whose outcome is `cancelled` in this ' +
        'run is the one the limit interrupted.',
    };
  }
  return {
    result: 'cancelled',
    level: 'notice',
    note:
      `This run was cancelled ${elapsed}s after it started, before its ${limit}-minute limit, so it was not ` +
      'the timeout: a person or GitHub cancelled it. It was not superseded either — the concurrency group has ' +
      'cancel-in-progress: false. Reported as cancelled (no verdict); nothing is filed.',
  };
}

/**
 * The step ids whose outcome is `cancelled`, from a `id=outcome` list (space-
 * or comma-separated) the workflow builds out of `steps.<id>.outcome`. A step
 * interrupted by the job timeout reports `cancelled`; steps after it report
 * `skipped` (or nothing, for `if: always()`/`cancelled()` ones), and steps
 * without an `id:` are not in the steps context at all — so an empty result
 * means "not identifiable from here", never "nothing was running".
 */
export function interruptedSteps(outcomes) {
  return String(outcomes ?? '')
    .split(/[\s,]+/)
    .map((pair) => pair.match(/^([A-Za-z0-9_-]+)=(.*)$/))
    .filter((m) => m && m[2] === 'cancelled')
    .map((m) => m[1]);
}

/**
 * The deploy-failure.json a TIMED-OUT roll hands the notifier (#4823 round 2).
 *
 * Without it, deploy-notify-failure.mjs renders its no-artifact text — "the
 * failing step did not run through scripts/ci/deploy-retry.mjs … wiring it is
 * the fix" — which is FALSE here (the roll and pin retags DO run through
 * deploy-retry.mjs) and never says the job timed out; and a stale artifact an
 * earlier step wrote would be rendered as the cause. So on `timed_out` this is
 * written unconditionally, OVERWRITING any file already at that path.
 *
 * What it asserts is only what the notify step measured: the elapsed time, the
 * limit, and which step id reports `cancelled`. What made the run slow is NOT
 * established and is said not to be.
 */
export function timeoutFailure({ elapsedSeconds, limitMinutes, interrupted, boundary, tag, apps }) {
  const named = interrupted.length > 0;
  const where = named
    ? `while step id${interrupted.length > 1 ? 's' : ''} ${interrupted.map((s) => `'${s}'`).join(', ')} ` +
      `reported \`cancelled\``
    : 'in a step this record cannot name (no step with an `id:` reports `cancelled`; the run\'s step list ' +
      'shows which one was interrupted)';
  return {
    schemaVersion: 1,
    step: named ? interrupted.join(', ') : 'unidentified',
    command: `job timeout-minutes (${limitMinutes})`,
    class: 'transient',
    signalId: TIMEOUT_SIGNAL_ID,
    retryable: true,
    established: [
      {
        signal: 'job-elapsed',
        line:
          `the job was cancelled ${elapsedSeconds}s after its first step recorded the start; its ` +
          `timeout-minutes limit is ${limitMinutes} (${limitMinutes * 60}s), and a cancel within ` +
          `${TIMEOUT_MARGIN_SECONDS}s of that limit is read as the timeout`,
      },
      {
        signal: 'interrupted-step',
        line: named
          ? `steps.<id>.outcome == 'cancelled' for: ${interrupted.join(', ')}`
          : 'no step with an id reported cancelled',
      },
    ],
    remediationKind: 'operator-action',
    remediation:
      'GitHub cancelled the job at its time limit, so no step after the interrupted one did its work — ' +
      '`Roll back on failure` is gated on failure() and did not run. If the roll step was interrupted, ' +
      'apps may be part-way rolled: read the live revisions before acting. Classified transient on the ' +
      'expectation that the same run, unchanged, completes once whatever was slow has cleared — this record ' +
      'does not establish that; if the SAME step times out again on a re-run, it is not transient: read that ' +
      "step's log. " +
      redispatchSentence({ boundary, tag, apps }),
    whyStopped:
      `the job reached its ${limitMinutes}-minute timeout-minutes limit (cancelled ${elapsedSeconds}s after it ` +
      `started) ${where}. What made the run that slow is NOT established by this record — the interrupted ` +
      "step's own log is.",
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

const nowEpoch = () => Math.floor(Date.now() / 1000);

export function cliMain(argv, env = process.env, out = (s) => process.stdout.write(redactedLine(s))) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'deadline':
      out(`${leaseDeadline({ budgetMinutes: arg(rest, 'budget-minutes'), nowEpoch: arg(rest, 'now') ?? nowEpoch() })}\n`);
      return 0;
    case 'wait-minutes':
      out(`${remainingWaitMinutes({ deadlineEpoch: arg(rest, 'deadline'), nowEpoch: arg(rest, 'now') ?? nowEpoch() })}\n`);
      return 0;
    case 'unacquired': {
      const statusFile = arg(rest, 'status-file');
      if (!statusFile) throw new Error('unacquired needs --status-file');
      const severity = arg(rest, 'severity') ?? 'error';
      if (!['error', 'warning'].includes(severity)) throw new Error(`--severity must be error|warning, got '${severity}'`);
      const d = describeUnacquired({
        status: parseLeaseStatus(fs.readFileSync(statusFile, 'utf8')),
        self: selfOwner(env),
        step: arg(rest, 'step') ?? 'unnamed step',
        acr: arg(rest, 'acr') ?? '<unknown registry>',
        waitMinutes: arg(rest, 'wait-minutes') ?? '?',
        budgetMinutes: arg(rest, 'budget-minutes') ?? '?',
        boundary: arg(rest, 'boundary'),
        tag: arg(rest, 'tag'),
        apps: arg(rest, 'apps'),
      });
      const artifact = arg(rest, 'out');
      if (artifact && d.failure) fs.writeFileSync(artifact, `${JSON.stringify(d.failure, null, 2)}\n`, 'utf8');
      out(`::${severity}::${d.message}\n`);
      return 0;
    }
    case 'notify-result': {
      const r = notifyResult({
        jobStatus: arg(rest, 'job-status'),
        startedEpoch: arg(rest, 'started'),
        nowEpoch: arg(rest, 'now') ?? nowEpoch(),
        timeoutMinutes: arg(rest, 'timeout-minutes'),
      });
      if (r.note) out(`::${r.level}::${r.note}\n`);
      const artifact = arg(rest, 'out');
      if (r.result === 'timed_out' && artifact) {
        // Written unconditionally on a timeout, OVERWRITING any artifact an
        // earlier step left: that one describes a different, earlier failure.
        const failure = timeoutFailure({
          elapsedSeconds: r.elapsedSeconds,
          limitMinutes: r.limitMinutes,
          interrupted: interruptedSteps(arg(rest, 'step-outcomes')),
          boundary: arg(rest, 'boundary'),
          tag: arg(rest, 'tag'),
          apps: arg(rest, 'apps'),
        });
        fs.writeFileSync(artifact, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
        out(`Wrote the timeout classification to ${artifact} (${failure.signalId}), replacing any earlier artifact.\n`);
      }
      out(`result=${r.result}\n`);
      return 0;
    }
    default:
      throw new Error(`unknown command '${cmd ?? ''}' (deadline | wait-minutes | unacquired | notify-result)`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.exit(cliMain(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(redactedLine(`::error::roll-lease-budget: ${e.message}\n`));
    process.exit(2);
  }
}
