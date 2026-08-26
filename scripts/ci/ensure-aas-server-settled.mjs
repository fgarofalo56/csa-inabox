#!/usr/bin/env node
/**
 * ensure-aas-server-settled.mjs — bring the estate's Azure Analysis Services
 * server out of `Paused` BEFORE the ARM apply, and report enough for the caller
 * to put it back afterwards.
 *
 * ── THE DEFECT THIS REMOVES (#3948) ─────────────────────────────────────────
 *
 * `deploy-fiab-commercial` run 32874774243 failed at "Provision (idempotent)"
 * with three ARM leaves, the AAS one verbatim:
 *
 *   BadRequest on 'aasloomk6mvh5sm6z7do':
 *   The server 'aasloomk6mvh5sm6z7do' is currently being updated. Please try again later.
 *
 * #4034 taught the taxonomy to classify that as `transient.resource-mid-update`,
 * so the deploy correctly retried it — four times, with ~50s of backoff each.
 * Every attempt failed the same way, because an AAS control-plane operation on a
 * suspended S1 does not finish inside fifty seconds. The retries were not
 * useless, they were simply aimed at the wrong thing: the server was not
 * momentarily busy, it was PAUSED, and each apply nudged it into a transitional
 * state that the next apply then collided with.
 *
 * #4034's own remediation text says exactly this, and names this file's shape:
 *
 *   "For Microsoft.AnalysisServices/servers specifically, a server left
 *    Paused/Suspending by the estate PAUSE tier is the first thing to check …
 *    the durable fix is a preflight that settles the server before the apply, in
 *    the shape of scripts/ci/ensure-adx-cluster-running.mjs, rather than a
 *    longer retry budget here."
 *
 * ── WHY RESUME RATHER THAN SKIP THE ADMIN WRITE ─────────────────────────────
 *
 * `admin-plane` declares the Console UAMI as an AAS administrator. Skipping that
 * write when the server is paused would turn a loud failure into a silent one:
 * the deploy would go green with `properties.asAdministrators` still null, and
 * every semantic-model surface would later fail with a permission error nobody
 * could trace back to this deploy. `auto-bind-by-default.md` §5 and
 * `deploy-integrity.md` R6 both say the opposite — where the platform CAN
 * perform the remediation, it must. This is the same argument
 * `ensure-adx-cluster-running.mjs` makes for starting a stopped Kusto cluster,
 * and the same first-party action the deploy identity already holds.
 *
 * MEASURED, and the reason this is not hypothetical: `asAdministrators` on
 * aasloomk6mvh5sm6z7do is `null` right now. The delta that adds it landed on
 * main 2026-08-23T16:52Z, after the last successful scheduled deploy, and every
 * attempt since has died on this leaf. The write has never once completed.
 *
 * ── WHY IT DOES NOT LEAVE THE SERVER RUNNING ────────────────────────────────
 *
 * ADX can afford to be left started because `enableAutoStop: true` makes Azure
 * stop it again when it goes idle. **Analysis Services has no auto-pause.** A
 * resume that is never undone bills an S1 indefinitely and silently defeats the
 * estate PAUSE tier, so this script prints a RESUMED marker and exits with the
 * prior state in its output; the workflow re-suspends afterwards in an
 * `if: always()` step. The cost is bounded to the deploy window rather than
 * being open-ended, and the pause tier's intent survives.
 *
 * WHAT THIS DOES *NOT* CLAIM. It does not assert WHY the server was paused. The
 * estate pause-actuator suspends exactly this resource type, which is a
 * candidate explanation and not an established one — this script observes only
 * the STATE, never a suspend event (deploy-integrity.md R7). It also does not
 * claim the admin write will now succeed: it establishes only that the server is
 * no longer paused or transitional. If the write still fails, that is a
 * different defect and the deploy will say so.
 *
 * ── FAILURE MODES ───────────────────────────────────────────────────────────
 *
 *   none    already Succeeded and not transitional → no mutation at all.
 *   resume  Paused/Suspended → POST .../resume, then poll until settled.
 *   wait    Provisioning/Updating/Scaling/Resuming/Suspending/Preparing →
 *           someone else is mid-flight; poll rather than issuing a second verb.
 *   refuse  Failed/Deleting/Deleted, an unknown state string, an unreadable
 *           control plane, or a resume that did not settle inside the budget.
 *           Never "assume it came up".
 *
 * Usage:
 *   node scripts/ci/ensure-aas-server-settled.mjs \
 *     --subscription <sub-id> --rg rg-csa-loom-admin-<loc> [--timeout-seconds 1800]
 *
 * Outputs (to $GITHUB_OUTPUT when set, and always to stdout as NAME=VALUE):
 *   aas_server        the server name it acted on, or empty when none exists
 *   aas_prior_state   the state observed BEFORE any mutation
 *   aas_resumed       'true' only when THIS run issued the resume
 *
 * Tests: node --test scripts/ci/__tests__/aas-preflight.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** The api-version every AAS caller in this repo already uses. */
export const AAS_API_VERSION = '2017-08-01';
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const POLL_INTERVAL_SECONDS = 30;

/**
 * PURE. What to do about a `properties.state` reading.
 *
 * The `refuse` branch is the point of the function: an unrecognised state is
 * UNKNOWN, and an unknown state is not "probably fine". Adding a state to this
 * table is a deliberate act, not a convenience.
 *
 * @param {string} state `properties.state` from the Analysis Services RP.
 * @returns {{action: 'none'|'resume'|'wait'|'refuse', reason: string}}
 */
export function classifyServerState(state) {
  switch (String(state ?? '')) {
    case 'Succeeded':
      return { action: 'none', reason: 'the server is Succeeded and not transitional; the deploy can write its administrators.' };
    case 'Paused':
    case 'Suspended':
      return {
        action: 'resume',
        reason:
          `the server is ${state}, and an asAdministrators write cannot be applied to a suspended server — ` +
          'ARM refuses it as "currently being updated" and every retry collides with the same window.',
      };
    case 'Provisioning':
    case 'Updating':
    case 'Scaling':
    case 'Resuming':
    case 'Suspending':
    case 'Preparing':
      return { action: 'wait', reason: `the server is ${state} — a control-plane operation is already in flight.` };
    case 'Failed':
    case 'Deleting':
    case 'Deleted':
      return {
        action: 'refuse',
        reason:
          `the server reports state '${state}', which no resume can resolve. The deploy would fail its ` +
          'administrator write regardless, so it stops here with the real reason instead.',
      };
    default:
      return {
        action: 'refuse',
        reason:
          `the server reports the unrecognised state '${state || '<empty>'}'. Whether a resume would help is ` +
          'UNKNOWN, and an unknown state is not an assumption this step is willing to make.',
      };
  }
}

/**
 * PURE. Turn a poll reading into a verdict.
 * @param {{state: string|null, elapsedSeconds: number, budgetSeconds: number}} p
 * @returns {{done: boolean, ok: boolean, reason: string}}
 */
export function evaluatePoll({ state, elapsedSeconds, budgetSeconds }) {
  if (state === 'Succeeded') {
    return { done: true, ok: true, reason: `settled to Succeeded after ${elapsedSeconds}s.` };
  }
  const terminal = classifyServerState(state);
  if (terminal.action === 'refuse') {
    return { done: true, ok: false, reason: terminal.reason };
  }
  if (elapsedSeconds >= budgetSeconds) {
    return {
      done: true,
      ok: false,
      reason:
        `still '${state}' after ${elapsedSeconds}s (budget ${budgetSeconds}s). The outcome is UNCONFIRMED, so ` +
        'this reports failure rather than letting the deploy attempt an administrator write on a server that ' +
        'may still be suspended.',
    };
  }
  return { done: false, ok: false, reason: `state='${state}', ${elapsedSeconds}s elapsed.` };
}

/**
 * PURE. Should the caller re-suspend afterwards?
 *
 * Only when THIS run resumed it. A server that was already running when we
 * arrived belongs to whoever started it, and suspending it would be this script
 * reaching outside what it changed.
 *
 * @param {{priorState: string, resumedByUs: boolean}} p
 * @returns {{resuspend: boolean, reason: string}}
 */
export function shouldResuspend({ priorState, resumedByUs }) {
  if (!resumedByUs) {
    return {
      resuspend: false,
      reason: `this run did not resume the server (prior state '${priorState}'), so it does not own putting it back.`,
    };
  }
  return {
    resuspend: true,
    reason:
      `this run resumed the server from '${priorState}'. Analysis Services has no auto-pause, so leaving it ` +
      'running would bill an S1 indefinitely and silently defeat the estate PAUSE tier.',
  };
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

/**
 * Run az and return {ok, stdout, stderr}. stderr is CAPTURED, never discarded —
 * per deploy-integrity R7 a swallowed stderr turns "I could not read this" into
 * "it is not there", which is how a permission denial gets reported as an
 * absent resource.
 */
function az(args) {
  try {
    const stdout = execFileSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: String(stdout).trim(), stderr: '' };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout ?? '').trim(), stderr: String(e.stderr ?? e.message ?? '').trim() };
  }
}

function emit(name, value) {
  const line = `${name}=${value}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const subscription = args.subscription;
  const rg = args.rg;
  const budgetSeconds = Number(args['timeout-seconds'] ?? DEFAULT_TIMEOUT_SECONDS);

  if (!subscription || !rg) {
    console.error('[aas-preflight] ERROR: --subscription and --rg are both required.');
    process.exit(2);
  }

  const list = az([
    'resource', 'list',
    '--subscription', subscription,
    '--resource-group', rg,
    '--resource-type', 'Microsoft.AnalysisServices/servers',
    '--query', '[].name', '-o', 'tsv',
  ]);
  if (!list.ok) {
    console.error(
      '[aas-preflight] ERROR: could not LIST Analysis Services servers. This is NOT the same as "there is no ' +
        'server" — the lookup did not happen at all. az said:',
    );
    console.error(list.stderr);
    process.exit(1);
  }

  const name = list.stdout.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!name) {
    console.log(`[aas-preflight] No Microsoft.AnalysisServices/servers in ${rg}. Nothing to settle.`);
    emit('aas_server', '');
    emit('aas_prior_state', '');
    emit('aas_resumed', 'false');
    return;
  }

  const id = `/subscriptions/${subscription}/resourceGroups/${rg}/providers/Microsoft.AnalysisServices/servers/${name}`;
  const readState = () => {
    const r = az(['resource', 'show', '--ids', id, '--api-version', AAS_API_VERSION, '--query', 'properties.state', '-o', 'tsv']);
    return r.ok ? r.stdout.replace(/\r/g, '').trim() : null;
  };

  const first = readState();
  if (first === null) {
    console.error(`[aas-preflight] ERROR: could not READ ${name}'s state, so it is NOT established what it is.`);
    process.exit(1);
  }

  emit('aas_server', name);
  emit('aas_prior_state', first);

  const decision = classifyServerState(first);
  console.log(`[aas-preflight] ${name}: state='${first}' -> ${decision.action} — ${decision.reason}`);

  if (decision.action === 'refuse') {
    console.error(`::error::[aas-preflight] REFUSING: ${decision.reason}`);
    emit('aas_resumed', 'false');
    process.exit(1);
  }
  if (decision.action === 'none') {
    emit('aas_resumed', 'false');
    return;
  }

  let resumedByUs = false;
  if (decision.action === 'resume') {
    const r = az(['resource', 'invoke-action', '--ids', id, '--api-version', AAS_API_VERSION, '--action', 'resume']);
    if (!r.ok) {
      console.error(`[aas-preflight] ERROR: the resume on ${name} FAILED. az said:`);
      console.error(r.stderr);
      emit('aas_resumed', 'false');
      process.exit(1);
    }
    resumedByUs = true;
    console.log(`[aas-preflight] resume issued on ${name}; polling until it settles.`);
  }
  emit('aas_resumed', String(resumedByUs));

  const started = Date.now();
  for (;;) {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    const state = readState();
    const v = evaluatePoll({ state, elapsedSeconds, budgetSeconds });
    if (v.done) {
      if (v.ok) {
        console.log(`[aas-preflight] ${name}: ${v.reason}`);
        return;
      }
      console.error(`::error::[aas-preflight] ${name}: ${v.reason}`);
      process.exit(1);
    }
    console.log(`[aas-preflight] ${name}: ${v.reason}`);
    sleepSync(POLL_INTERVAL_SECONDS * 1000);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) main();
