#!/usr/bin/env node
/**
 * ensure-adx-cluster-running.mjs — bring the hub's Azure Data Explorer cluster
 * back to `Running` BEFORE the ARM apply, because a stopped cluster cannot
 * accept the principal assignments the template declares on it.
 *
 * ── THE DEFECT THIS REMOVES (#3754) ─────────────────────────────────────────
 *
 * `deploy-fiab-gcch` run 32126019475 (and every run since 2026-08-15) failed on
 * this ARM leaf, verbatim:
 *
 *   ClusterNotValidForPrincipals on 'adx-csa-loom-fmezxj/console-uami-alldatabasesadmin':
 *   [BadRequest] Cluster is in state 'Stopped', cannot retrieve list of principals
 *
 * `admin-plane/adx-cluster.bicep` declares two
 * `Microsoft.Kusto/clusters/principalAssignments` children — the Console UAMI's
 * AllDatabasesAdmin grant and the Activator's AllDatabasesViewer. Those are ADX
 * DATA-plane roles, not Azure RBAC, so the Kusto RP has to reach the engine to
 * write them; on a stopped cluster it cannot, and the whole subscription
 * deployment dies with it.
 *
 * ── WHY START IT RATHER THAN SKIP THE GRANTS ────────────────────────────────
 *
 * Skipping the assignment when the cluster is stopped would turn a loud failure
 * into a silent one: the deploy would go green while the Console UAMI held no
 * ADX rights at all, and every Eventhouse / KQL-database surface in that
 * boundary would fail later with a permission error nobody could trace to this
 * deploy. auto-bind-by-default.md §5 and deploy-integrity.md R6 both say the
 * opposite — where the platform CAN perform the remediation, it must. Starting
 * the cluster is a first-party action the deploy identity already holds
 * (`Microsoft.Kusto/clusters/start/action` is in Contributor, and
 * adx-cluster.bicep grants the Console UAMI Azure Kusto Contributor for exactly
 * this lifecycle).
 *
 * The cluster is also DECLARED to exist and serve: `params/gcc-high.bicepparam`
 * sets `adxEnabled = true`. A stopped cluster means Loom's Eventhouse capability
 * is dead in that boundary, which is a cloud-parity.md problem independent of
 * the deploy. `enableAutoStop: true` on the cluster caps the cost of starting
 * it: Azure stops it again once it goes idle.
 *
 * WHAT THIS DOES *NOT* CLAIM. It does not assert WHY the cluster was stopped.
 * The template requests auto-stop and the cluster is a Dev(No SLA) SKU, but
 * this run observed only the STATE, never a stop event, so no cause is asserted
 * (deploy-integrity.md R7).
 *
 * ── FAILURE MODES ───────────────────────────────────────────────────────────
 *
 *   none    already Running → no mutation at all.
 *   start   Stopped/Stopping → POST .../start, then poll until Running.
 *   wait    Starting/Creating/Updating → someone else is mid-flight; poll.
 *   refuse  Unavailable/Deleting/Deleted, an unknown state string, an
 *           unreadable control plane, or a start that did not reach Running
 *           inside the budget. Never "assume it came up".
 *
 * ── ROUND 2 (#3786): A TRANSIENT ARM BLIP TOOK THE WHOLE DEPLOY DOWN ────────
 *
 * Every `az` call here used to be single-shot, and every failure message
 * hard-coded a PERMISSIONS remediation regardless of what az actually said.
 * Both halves were wrong, and both were measured on 2026-08-24:
 *
 *   deploy-fiab-commercial run 32700023215 — the per-cluster read returned
 *   `(GatewayTimeout)`. A transient ARM failure, retryable, nothing to fix. The
 *   step reported "grant the deploy service principal Reader (or Azure Kusto
 *   Contributor)" — refuted by the run's own log, which shows the SAME identity
 *   enumerating Microsoft.Kusto/clusters in that RG one call earlier, and by the
 *   scope's inherited Owner/Contributor/Reader assignments. Re-running the exact
 *   call by hand afterwards returned `Stopped`, rc=0, empty stderr.
 *
 *   deploy-fiab-gcch run 32716865363 — the READ SUCCEEDED (`state=Stopped`) and
 *   the START was rejected with `(InsufficientResourcesForSubscription)`. That is
 *   CAPACITY: no retry and no role grant resolves it. The step led with the
 *   service principal's permissions there too.
 *
 * So: reads and starts now retry what `_az-failure-class.mjs` classifies as
 * transient, with bounded backoff, and FAIL CLOSED on exhaustion (R6). Every
 * remediation is derived from the classified cause rather than assumed (R7).
 *
 * The step's old error text also asserted that this leaf "has failed every
 * GCC-High deploy since 2026-08-15". MEASURED at step level across 30 gcch runs
 * and 25 commercial runs, that is FALSE — see the PR for the table. The gcch
 * failures from 08-15 to 08-18 were `Provision (with full Gov dispatch)` and
 * from 08-19 to 08-22 were `Bicep what-if`; this leaf first failed anything on
 * 2026-08-22T20:06Z. A failure history asserted in a string, never re-measured,
 * is the same class of defect as a cause asserted in a string.
 *
 * Usage:
 *   node scripts/ci/ensure-adx-cluster-running.mjs \
 *     --subscription <sub-id> --rg rg-csa-loom-admin-<loc> [--timeout-seconds 1800]
 *
 * Tests: node --test scripts/ci/__tests__/estate-preflight.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { definiteAbsenceCode } from './_arm-absence.mjs';
import { classifyAzFailure, isRetryable, remediationFor } from './_az-failure-class.mjs';

export const KUSTO_API_VERSION = '2024-04-13';

/**
 * PURE. What did the cluster ENUMERATION establish?
 *
 * THE BLOCKER THIS CLOSES (#3754 review). This decision used to live inline in
 * the I/O shell as a bare `if (!listed.ok) fail(…)`, which classified a MISSING
 * RESOURCE GROUP as an unreadable control plane. Two consequences, both real:
 *
 *   1. It hard-failed every GREENFIELD apply on this lane. `main.bicep` CREATES
 *      the admin resource group, and this preflight runs immediately BEFORE the
 *      provision step — so on a fresh sovereign subscription, after this lane's
 *      own Teardown with keep_resources:false, or on the never-run IL5 boundary,
 *      the RG does not exist yet and the deploy died before it could create it.
 *      That breaks the greenfield half of deploy-integrity.md R4 on the only
 *      lane that applies main.bicep to GCC-High.
 *   2. Its message told the operator to "confirm the deploy service principal
 *      holds Reader" — a cause the code had NOT established, which is R7 and
 *      exactly the defect the DNS sibling was written to avoid. Two standards in
 *      one change.
 *
 * The exit code alone cannot carry the distinction. MEASURED on live ARM
 * (Commercial, 2026-08-18): a missing RG exits 3 with `(ResourceGroupNotFound)`
 * AND prints a well-formed `[]` on stdout, while a real RG holding no clusters
 * exits 0 with `[]`. Trusting stdout reads absence as "no clusters"; trusting
 * the exit code reads it as "unreadable". Only the ARM error code separates
 * them — see _arm-absence.mjs for both raw transcripts.
 *
 * @param {{ok: boolean, stdout: string, stderr: string}} attempt
 * @returns {{decision: 'listed'|'greenfield'|'refuse', ids: string[]|null, reason: string}}
 */
export function classifyClusterListRead(attempt) {
  if (!attempt?.ok) {
    const hit = definiteAbsenceCode(String(attempt?.stderr ?? ''));
    if (hit) {
      return {
        decision: 'greenfield',
        ids: [],
        reason:
          `az reported ${hit}, a definite absence — the admin resource group does not exist yet, so there is ` +
          'no cluster to start. main.bicep creates both the RG and the cluster, and a freshly created cluster ' +
          'is Running.',
      };
    }
    return {
      decision: 'refuse',
      ids: null,
      reason:
        'the enumeration did NOT complete, so whether this estate has an ADX cluster — and whether it is ' +
        'stopped — is UNKNOWN, not absent. Refusing to treat an unreadable control plane as "nothing to start" ' +
        'and walk into the ClusterNotValidForPrincipals failure this step exists to prevent.',
    };
  }

  let ids;
  try {
    ids = JSON.parse(attempt.stdout);
  } catch {
    return {
      decision: 'refuse',
      ids: null,
      reason: 'az exited 0 enumerating clusters but its output was not JSON, so nothing was established.',
    };
  }
  if (!Array.isArray(ids)) {
    return {
      decision: 'refuse',
      ids: null,
      reason: 'az exited 0 enumerating clusters but its output was not a JSON array, so nothing was established.',
    };
  }
  if (ids.length === 0) {
    return {
      decision: 'greenfield',
      ids: [],
      reason:
        'the resource group exists and holds no Microsoft.Kusto/clusters — nothing to start. On a greenfield ' +
        'deploy the template CREATES the cluster, and a freshly created cluster is Running.',
    };
  }
  return { decision: 'listed', ids, reason: `${ids.length} ADX cluster(s) to check.` };
}

/** Poll budget for a cluster to reach Running. ADX start is minutes, not seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const POLL_INTERVAL_SECONDS = 30;

/**
 * PURE. What should be done about a cluster in this state?
 *
 * The `refuse` branch is the point of the function: an unrecognised state is
 * UNKNOWN, and an unknown state is not "probably fine". Adding a state to the
 * table is a deliberate act.
 *
 * @param {string} state `properties.state` from the Kusto RP.
 * @returns {{action: 'none'|'start'|'wait'|'refuse', reason: string}}
 */
export function classifyClusterState(state) {
  switch (String(state ?? '')) {
    case 'Running':
      return { action: 'none', reason: 'the cluster is already Running; the deploy can write its principal assignments.' };
    case 'Stopped':
    case 'Stopping':
      return {
        action: 'start',
        reason:
          `the cluster is ${state}, and Microsoft.Kusto/clusters/principalAssignments cannot be written to a ` +
          'cluster whose engine is down (ClusterNotValidForPrincipals).',
      };
    case 'Starting':
    case 'Creating':
    case 'Updating':
      return { action: 'wait', reason: `the cluster is ${state} — a control-plane operation is already in flight.` };
    case 'Unavailable':
    case 'Deleting':
    case 'Deleted':
      return {
        action: 'refuse',
        reason:
          `the cluster reports state '${state}', which no start can resolve. The deploy would fail its ` +
          'principal assignments regardless, so it stops here with the real reason instead.',
      };
    default:
      return {
        action: 'refuse',
        reason:
          `the cluster reports the unrecognised state '${state || '<empty>'}'. Whether a start would help is ` +
          'UNKNOWN, and an unknown state is not an assumption this step is willing to make.',
      };
  }
}

/**
 * PURE. Turn a poll history into a verdict.
 * @param {{state: string|null, elapsedSeconds: number, budgetSeconds: number}} p
 * @returns {{done: boolean, ok: boolean, reason: string}}
 */
export function evaluatePoll({ state, elapsedSeconds, budgetSeconds }) {
  if (state === 'Running') {
    return { done: true, ok: true, reason: `reached Running after ${elapsedSeconds}s.` };
  }
  const terminal = classifyClusterState(state);
  if (terminal.action === 'refuse') {
    return { done: true, ok: false, reason: terminal.reason };
  }
  if (elapsedSeconds >= budgetSeconds) {
    return {
      done: true,
      ok: false,
      reason:
        `still '${state}' after ${elapsedSeconds}s (budget ${budgetSeconds}s). The outcome is UNCONFIRMED, so ` +
        'this reports failure rather than letting the deploy attempt principal assignments on a cluster that ' +
        'may still be down.',
    };
  }
  return { done: false, ok: false, reason: `state='${state}', ${elapsedSeconds}s elapsed.` };
}

// ── I/O shell ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--')) out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

function az(args) {
  try {
    const stdout = execFileSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? e) };
  }
}

/**
 * Backoff schedule for a TRANSIENT az failure. Length defines the retry count:
 * 1 initial attempt + one retry per entry, so 4 attempts over ~50s of waiting.
 *
 * Bounded on purpose. deploy-integrity.md R6 asks for retry of what is genuinely
 * transient AND a fail-closed on exhaustion — "a retry that cannot fail is
 * forbidden". A schedule expressed as a finite array cannot become unbounded by
 * arithmetic the way a `while (Date.now() < deadline)` loop can.
 */
export const TRANSIENT_BACKOFF_SECONDS = [5, 15, 30];

/**
 * PURE. How long to wait before attempt N+1, or null when the budget is spent.
 *
 * Exported so the exhaustion boundary is unit-testable without burning 50s of
 * real sleep, and so a future edit that makes the schedule infinite fails a
 * test rather than hanging a deploy.
 *
 * @param {number} attemptIndex 0-based index of the attempt that just FAILED
 * @returns {number|null} seconds to sleep, or null to stop retrying
 */
export function nextRetryDelaySeconds(attemptIndex) {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0) return null;
  return attemptIndex < TRANSIENT_BACKOFF_SECONDS.length ? TRANSIENT_BACKOFF_SECONDS[attemptIndex] : null;
}

/**
 * Run an `az` call, retrying ONLY what `_az-failure-class.mjs` calls transient.
 *
 * Returns the LAST attempt's result plus what was learned about it, so a caller
 * can build a message from the established cause instead of a hypothesis. A
 * `denied`, `capacity`, `notfound` or `unknown` failure returns immediately —
 * retrying a refusal just delays the truth by 50 seconds.
 *
 * @param {string[]} args
 * @param {{runner?: Function, sleep?: Function, label?: string}} [io] seams for tests
 * @returns {{ok: boolean, stdout: string, stderr: string, kind: string|null, attempts: number}}
 */
export function azWithRetry(args, io = {}) {
  const runner = io.runner ?? az;
  const sleep = io.sleep ?? sleepSeconds;
  const label = io.label ?? 'az';
  let attempts = 0;
  for (;;) {
    const res = runner(args);
    attempts += 1;
    if (res.ok) return { ...res, kind: null, attempts };

    const kind = classifyAzFailure(res.stderr);
    if (!isRetryable(kind)) return { ...res, kind, attempts };

    const delay = nextRetryDelaySeconds(attempts - 1);
    if (delay == null) {
      // FAIL CLOSED. The budget is spent and the call never succeeded, so the
      // outcome is UNCONFIRMED and this hands that back rather than proceeding.
      return { ...res, kind, attempts };
    }
    console.log(
      `[adx-preflight] ${label}: transient az failure (attempt ${attempts}) — retrying in ${delay}s.`,
    );
    sleep(delay);
  }
}

function fail(message, stderr) {
  console.log(`::error::${message}`);
  if (stderr) {
    console.log('--- raw az stderr (first 20 lines) ---');
    console.log(stderr.split('\n').slice(0, 20).join('\n'));
  }
  process.exit(1);
}

function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function readState(id) {
  const res = azWithRetry(
    ['resource', 'show', '--ids', id, '--api-version', KUSTO_API_VERSION, '--query', 'properties.state', '-o', 'tsv'],
    { label: `read state of ${id.split('/').pop()}` },
  );
  if (!res.ok) return { ok: false, state: null, stderr: res.stderr, kind: res.kind, attempts: res.attempts };
  // `az -o tsv` carries a trailing CR on some agents; strip it before comparing.
  return { ok: true, state: res.stdout.replace(/\r/g, '').trim(), stderr: '', kind: null, attempts: res.attempts };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = ['subscription', 'rg'].filter((k) => !args[k]);
  if (missing.length) {
    fail(
      `ensure-adx-cluster-running: missing required argument(s) --${missing.join(' --')}, so no cluster can be located.`,
    );
  }
  const budgetSeconds = Number(args['timeout-seconds'] ?? DEFAULT_TIMEOUT_SECONDS);
  // A non-numeric --timeout-seconds used to produce NaN, and `elapsed >= NaN` is
  // ALWAYS false — so the poll below would never terminate on its own, bounded
  // only by the job's `timeout-minutes`. A budget that cannot be exceeded is a
  // budget that is not enforced.
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    fail(
      `ensure-adx-cluster-running: --timeout-seconds must be a positive number; got ` +
        `'${args['timeout-seconds']}'. Refusing to poll on a budget that can never be exceeded.`,
    );
  }

  const listed = azWithRetry(
    [
      'resource', 'list',
      '--subscription', args.subscription,
      '-g', args.rg,
      '--resource-type', 'Microsoft.Kusto/clusters',
      '--query', '[].id',
      '-o', 'json',
    ],
    { label: `enumerate Microsoft.Kusto/clusters in ${args.rg}` },
  );
  const enumeration = classifyClusterListRead(listed);

  if (enumeration.decision === 'refuse') {
    // The classifier has already decided this is not a definite absence. Whether
    // it is a denial, capacity, a transient blip that outlived its budget, or
    // something with no name yet is what `kind` carries — and it is the only
    // thing this message is allowed to assert.
    const kind = listed.ok ? 'unknown' : classifyAzFailure(listed.stderr);
    fail(
      `Could NOT enumerate Microsoft.Kusto/clusters in ${args.rg} after ${listed.attempts} attempt(s) — ` +
        `${enumeration.reason} az classified this as: ${kind}. ` +
        `REMEDIATION: ${remediationFor(kind, args.rg, listed.attempts)}`,
      listed.stderr,
    );
  }

  if (enumeration.decision === 'greenfield') {
    console.log(`[adx-preflight] ${enumeration.reason}`);
    return;
  }

  // SCOPE, stated rather than assumed: this starts every Microsoft.Kusto/clusters
  // in the admin RG, not only the one the template writes principal assignments
  // on. Today the admin plane deploys exactly one, so the two sets are identical;
  // if a second is ever added here it would also be started (and billed). Each
  // cluster it acts on is named in the log below, so the scope is never silent.
  for (const id of enumeration.ids) {
    const name = id.split('/').pop();
    const first = readState(id);
    if (!first.ok) {
      fail(
        `Could NOT read the state of ADX cluster '${name}' after ${first.attempts} attempt(s), so whether the ` +
          "deploy's principal assignments can be written is UNKNOWN. It is not something to proceed past on an " +
          `unread value (#3754). az classified this as: ${first.kind}. ` +
          `REMEDIATION: ${remediationFor(first.kind, id, first.attempts)}`,
        first.stderr,
      );
    }

    const verdict = classifyClusterState(first.state);
    console.log(`[adx-preflight] ${name}: state=${first.state} → ${verdict.action} — ${verdict.reason}`);

    if (verdict.action === 'none') continue;
    if (verdict.action === 'refuse') {
      fail(
        `ADX cluster '${name}' cannot be brought to Running: ${verdict.reason} ` +
          'The deployment declares Microsoft.Kusto/clusters/principalAssignments on it, which the Kusto RP can ' +
          'only write against a live engine, so the apply would fail regardless. ' +
          'REMEDIATION: resolve the cluster state in the portal (Data Explorer → the cluster → Overview), then re-run.',
      );
    }

    if (verdict.action === 'start') {
      const started = azWithRetry(
        ['resource', 'invoke-action', '--ids', id, '--action', 'start', '--api-version', KUSTO_API_VERSION],
        { label: `start ${name}` },
      );
      if (!started.ok) {
        fail(
          `The start of ADX cluster '${name}' was REJECTED after ${started.attempts} attempt(s), so the deploy's ` +
            'principal assignments would still fail with ClusterNotValidForPrincipals. ' +
            `az classified this as: ${started.kind}. ` +
            `REMEDIATION: ${remediationFor(started.kind, id, started.attempts)}`,
          started.stderr,
        );
      }
      console.log(`[adx-preflight] ${name}: start accepted — polling for Running.`);
    }

    // Poll for Running whether we started it or found it mid-flight. `az resource
    // invoke-action` returning is NOT evidence the engine is up, and reporting
    // success on an unverified outcome is the thing deploy-integrity.md R6
    // forbids most explicitly.
    let elapsed = 0;
    for (;;) {
      const poll = readState(id);
      if (!poll.ok) {
        fail(
          `Lost the ability to read ADX cluster '${name}' while waiting for it to start (${poll.attempts} ` +
            'attempt(s)), so its state is UNKNOWN and this step will NOT report that the cluster came up. ' +
            `az classified this as: ${poll.kind}. REMEDIATION: ${remediationFor(poll.kind, id, poll.attempts)}`,
          poll.stderr,
        );
      }
      const step = evaluatePoll({ state: poll.state, elapsedSeconds: elapsed, budgetSeconds });
      if (step.done && step.ok) {
        console.log(`[adx-preflight] ${name}: ${step.reason}`);
        break;
      }
      if (step.done) {
        fail(
          `ADX cluster '${name}' did not reach Running: ${step.reason} ` +
            'REMEDIATION: start it from the portal (Data Explorer → the cluster → Start) and re-run this workflow; ' +
            'if it will not start, the cluster itself is the defect, not this deploy.',
        );
      }
      console.log(`[adx-preflight] ${name}: ${step.reason} — waiting ${POLL_INTERVAL_SECONDS}s.`);
      sleepSeconds(POLL_INTERVAL_SECONDS);
      elapsed += POLL_INTERVAL_SECONDS;
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('ensure-adx-cluster-running.mjs')) main();
