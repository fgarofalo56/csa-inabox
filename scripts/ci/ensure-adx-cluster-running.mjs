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
 * Usage:
 *   node scripts/ci/ensure-adx-cluster-running.mjs \
 *     --subscription <sub-id> --rg rg-csa-loom-admin-<loc> [--timeout-seconds 1800]
 *
 * Tests: node --test scripts/ci/__tests__/estate-preflight.test.mjs
 */

import { execFileSync } from 'node:child_process';

export const KUSTO_API_VERSION = '2024-04-13';

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
  const res = az(['resource', 'show', '--ids', id, '--api-version', KUSTO_API_VERSION, '--query', 'properties.state', '-o', 'tsv']);
  if (!res.ok) return { ok: false, state: null, stderr: res.stderr };
  // `az -o tsv` carries a trailing CR on some agents; strip it before comparing.
  return { ok: true, state: res.stdout.replace(/\r/g, '').trim(), stderr: '' };
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

  const listed = az([
    'resource', 'list',
    '--subscription', args.subscription,
    '-g', args.rg,
    '--resource-type', 'Microsoft.Kusto/clusters',
    '--query', '[].id',
    '-o', 'json',
  ]);
  if (!listed.ok) {
    fail(
      `Could NOT enumerate Microsoft.Kusto/clusters in ${args.rg}, so whether this estate has an ADX cluster — ` +
        'and whether it is stopped — is UNKNOWN. Refusing to treat an unreadable control plane as "no cluster to ' +
        'start" and walk into the ClusterNotValidForPrincipals failure this step exists to prevent (#3754). ' +
        `REMEDIATION: confirm the deploy service principal holds Reader on ${args.rg} and re-run.`,
      listed.stderr,
    );
  }

  let ids;
  try {
    ids = JSON.parse(listed.stdout);
  } catch {
    fail(`az exited 0 listing clusters in ${args.rg} but its output was not JSON, so nothing was established.`);
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    console.log(
      `[adx-preflight] no Microsoft.Kusto/clusters in ${args.rg} — nothing to start. ` +
        'On a greenfield deploy the template CREATES the cluster, and a freshly created cluster is Running.',
    );
    return;
  }

  for (const id of ids) {
    const name = id.split('/').pop();
    const first = readState(id);
    if (!first.ok) {
      fail(
        `Could NOT read the state of ADX cluster '${name}', so whether the deploy's principal assignments can be ` +
          'written is UNKNOWN. This is the exact leaf that has failed every GCC-High deploy since 2026-08-15, so ' +
          'it is not something to proceed past on an unread value (#3754). ' +
          `REMEDIATION: grant the deploy service principal Reader (or Azure Kusto Contributor) on ${id}.`,
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
      const started = az([
        'resource', 'invoke-action',
        '--ids', id,
        '--action', 'start',
        '--api-version', KUSTO_API_VERSION,
      ]);
      if (!started.ok) {
        fail(
          `The start of ADX cluster '${name}' was REJECTED, so the deploy's principal assignments would still fail ` +
            'with ClusterNotValidForPrincipals. No cause is asserted beyond what az reported below. ' +
            `REMEDIATION: the deploy service principal needs Microsoft.Kusto/clusters/start/action on ${id} ` +
            '(Contributor or Azure Kusto Contributor); if the role is present, the raw error below is the real cause.',
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
          `Lost the ability to read ADX cluster '${name}' while waiting for it to start, so its state is UNKNOWN ` +
            'and this step will NOT report that the cluster came up.',
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
