#!/usr/bin/env node
/**
 * estate-live-probe.mjs -- is the live estate PAUSED, or is it genuinely live?
 *
 * WHY THIS EXISTS
 * ---------------
 * The `What-If (FIAB vs live Commercial estate)` lane fails on EVERY bicep PR
 * while the estate is paused, because ARM what-if cannot enumerate
 * `Microsoft.Kusto/clusters/principalAssignments` against a stopped cluster:
 *
 *   ClusterNotValidForPrincipals - [BadRequest] Cluster is in state 'Stopped',
 *   cannot retrieve list of principals
 *
 * That is environmental. It is not drift, and it is not caused by the PR's
 * diff -- but the lane rendered it as a red verdict, which is a KNOWN state
 * reported as a NEGATIVE finding. A lane that is permanently red for
 * environmental reasons trains everyone to ignore it, which is strictly worse
 * than it reporting UNKNOWN.
 *
 * This probe lets the workflow SKIP the comparison (neutral) instead of
 * FAILING it (a drift claim it never established).
 *
 * THE TWO DIRECTIONS ARE NOT SYMMETRIC
 * ------------------------------------
 * Suppressing a check is the dangerous direction, so it requires POSITIVE
 * evidence: an observed cluster state drawn from the pause-mandate's own set.
 * Every uncertain outcome -- az failed, no clusters found, state absent --
 * resolves to `paused=false`, i.e. RUN THE CHECK. "I could not tell" must
 * never become "it is paused, skip it".
 *
 * Consequently this script ALWAYS exits 0. A probe failure is not a build
 * failure; it simply declines to suppress.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * - It does not start the cluster. That would defeat the pause mandate and
 *   bill the operator silently from a PR check.
 * - It does not match on the `ClusterNotValidForPrincipals` error string.
 *   A string allowlist would swallow that same error when the cluster IS
 *   running -- precisely the case where it is a genuine finding. The
 *   suppression keys to OBSERVED STATE and nothing else.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';

/**
 * States produced by the pause mandate itself (native ADX stop/start).
 *
 * Deliberately an ALLOWLIST, not `state !== 'Running'`. A cluster sitting in
 * `Unavailable` or `Deleting` is a real problem and the what-if SHOULD go red
 * and say so; folding those into "paused" would convert a genuine defect into
 * a silent skip -- the same class of bug this file exists to remove.
 */
export const PAUSE_STATES = new Set(['Stopped', 'Stopping', 'Starting']);

/**
 * Decide whether the estate is paused, from observed cluster states.
 *
 * @param {{name: string, state: string|null|undefined}[] | null} clusters
 *   null  => the probe could not run at all (az failed, unparseable output)
 *   []    => the probe ran and found no Kusto clusters
 * @returns {{paused: boolean, reason: string, detail: string}}
 */
export function classify(clusters) {
  if (clusters === null || clusters === undefined) {
    return {
      paused: false,
      reason: 'probe-failed',
      detail: 'estate probe could not read cluster state - NOT suppressing; the what-if will run',
    };
  }
  if (!Array.isArray(clusters)) {
    return {
      paused: false,
      reason: 'probe-malformed',
      detail: 'estate probe returned a non-array - NOT suppressing; the what-if will run',
    };
  }
  if (clusters.length === 0) {
    // A zero here is UNKNOWN, not "no clusters": a wrong subscription, a
    // missing reader grant, or an unindexed provider all look identical to a
    // genuinely empty subscription. Do not suppress on it.
    return {
      paused: false,
      reason: 'no-clusters',
      detail: 'estate probe found ZERO Kusto clusters - treating as UNKNOWN, not as paused',
    };
  }

  // A cluster whose state we could not read is UNKNOWN -- never "paused".
  // `az resource list` returns properties.state === null (it does not expand
  // properties), so a probe built on list output alone would mark EVERY
  // cluster paused and suppress this lane forever. That bug is why the state
  // read is a separate `az resource show` per cluster, and why null is
  // explicitly not a pause state here.
  const paused = clusters.filter((c) => PAUSE_STATES.has(c?.state));
  const unknown = clusters.filter((c) => !c?.state);
  const describe = (list) => list.map((c) => `${c?.name ?? '<unnamed>'}=${c?.state ?? 'UNKNOWN'}`).join(', ');

  if (paused.length > 0) {
    return {
      paused: true,
      reason: 'estate-paused',
      detail: `${paused.length} of ${clusters.length} ADX cluster(s) in a pause state: ${describe(paused)}`,
    };
  }
  if (unknown.length === clusters.length) {
    return {
      paused: false,
      reason: 'state-unreadable',
      detail: `state unreadable for all ${clusters.length} cluster(s) - NOT suppressing; the what-if will run`,
    };
  }
  return {
    paused: false,
    reason: 'estate-live',
    detail: `all ${clusters.length} ADX cluster(s) out of pause states: ${describe(clusters)}`,
  };
}

// ---------------------------------------------------------------- az plumbing

class ProbeError extends Error {}

/**
 * Resolve `az` and build a spawn plan. On Windows `az` is a .cmd shim, and the
 * three obvious ways to launch one all fail in ways that look like a real
 * result (EINVAL under shell:false; a forward-slash path returns rc=1 and reads
 * as a genuine verdict; shell:true concatenates args unescaped per DEP0190).
 * A batch shim therefore goes through cmd.exe with a hand-quoted, verbatim
 * command line. See scripts/measure/measure.mjs for the long form.
 *
 * The PATH scan below DISCARDS the path it finds and returns only a boolean.
 * Returning it — and spawning it — put `process.env.PATH` on a dataflow path
 * into `spawnSync`'s executable argument, which is CodeQL's
 * `js/indirect-command-line-injection` (CWE-078) and a TRUE positive: resolving
 * an executable out of an environment variable is exactly the shape that query
 * exists to find. It also stopped the query terminating inside its 600s budget,
 * which uploads a `codeql-failed-run.sarif` and FREEZES the repo's JS/TS alert
 * list (see .github/workflows/codeql.yml and the 2026-08-03 outage).
 *
 * A boolean cannot carry taint, and both surviving launch paths resolve the
 * binary themselves — libuv directly, cmd.exe via PATHEXT — which is more
 * faithful than this four-extension guess was.
 */
function needsWrapper(bin) {
  if (process.platform !== 'win32') return false;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['.cmd', '.exe', '.bat', '']) {
      const found = path.join(dir, bin + ext);
      if (existsSync(found)) return /\.(cmd|bat)$/i.test(found);
    }
  }
  throw new ProbeError(`could not resolve '${bin}' on PATH`);
}

function spawnPlan(bin, args) {
  // Hard-coded, not a parameter: this script launches exactly one program.
  if (bin !== 'az') throw new ProbeError(`refusing to launch '${bin}'; this probe runs az only`);
  if (!needsWrapper(bin)) return { cmd: bin, argv: args, opts: {} };
  const q = (a) => {
    // cmd.exe expands %VAR% even inside double quotes, with no reliable
    // escape. Running a DIFFERENT command than the one requested is worse
    // than not running one, so refuse rather than guess.
    if (a.includes('%')) throw new ProbeError(`argument would expand in cmd.exe: ${a}`);
    return /[\s"|&<>^]/.test(a) || a === '' ? `"${a.replace(/"/g, '""')}"` : a;
  };
  // Pin the interpreter: a redirected ComSpec would choose the program that
  // runs every command this probe issues.
  const comspec = process.env.ComSpec || '';
  return {
    cmd: /(^|[\\/])cmd\.exe$/i.test(comspec) ? comspec : 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${[bin, ...args].map(q).join(' ')}"`],
    opts: { windowsVerbatimArguments: true },
  };
}

/** Run az and parse JSON. Throws on anything that is not a clean parse. */
function azJson(args) {
  const plan = spawnPlan('az', args);
  const res = spawnSync(plan.cmd, plan.argv, {
    encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
    shell: false, windowsHide: true, ...plan.opts,
  });
  if (res.error) throw new ProbeError(`az failed to launch: ${res.error.message}`);
  if (res.status === null) throw new ProbeError('az did not exit normally (timeout or signal)');
  if (res.status !== 0) throw new ProbeError(`az exited ${res.status}: ${(res.stderr || '').trim().slice(0, 300)}`);
  const text = (res.stdout || '').trim();
  if (!text) throw new ProbeError('az succeeded but produced NO output - that is UNKNOWN, not empty');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ProbeError(`az output is not JSON: ${e.message}`);
  }
}

/**
 * Read every Kusto cluster's name + running state.
 *
 * Two calls on purpose: `az resource list` does NOT expand properties (it
 * returns properties.state === null), so the state must come from a per-cluster
 * `az resource show`. The -g/-n form is used rather than --ids because a
 * leading-slash ARM id gets rewritten by MSYS into a Windows path when this is
 * run from Git Bash, which turns a valid id into an argument error.
 */
function readClusters(subscription) {
  const sub = subscription ? ['--subscription', subscription] : [];
  const list = azJson(['resource', 'list', '--resource-type', 'Microsoft.Kusto/clusters',
    '-o', 'json', '--only-show-errors', ...sub]);
  if (!Array.isArray(list)) throw new ProbeError('az resource list did not return an array');

  return list.map((r) => {
    try {
      const d = azJson(['resource', 'show', '-g', r.resourceGroup, '-n', r.name,
        '--resource-type', 'Microsoft.Kusto/clusters', '-o', 'json', '--only-show-errors', ...sub]);
      return { name: r.name, state: d?.properties?.state ?? null };
    } catch (e) {
      // One unreadable cluster is UNKNOWN for that cluster, not a pause and not
      // a probe-wide failure. classify() treats a null state as unknown.
      process.stderr.write(`  [probe] state unreadable for ${r.name}: ${e.message}\n`);
      return { name: r.name, state: null };
    }
  });
}

// ---------------------------------------------------------------- entrypoint

function main() {
  const argv = process.argv.slice(2);
  const subIdx = argv.indexOf('--subscription');
  const subscription = subIdx >= 0 ? argv[subIdx + 1] : undefined;

  let clusters = null;
  try {
    clusters = readClusters(subscription);
  } catch (e) {
    process.stderr.write(`  [probe] FAILED: ${e.message}\n`);
    clusters = null; // -> classify() declines to suppress
  }

  const verdict = classify(clusters);
  process.stdout.write(`paused=${verdict.paused}\nreason=${verdict.reason}\ndetail=${verdict.detail}\n`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `paused=${verdict.paused}\nreason=${verdict.reason}\ndetail=${verdict.detail}\n`);
  }
  if (verdict.paused) {
    process.stdout.write(`::notice::Estate is PAUSED - the live what-if is UNMEASURED, not clean. ${verdict.detail}\n`);
  } else if (verdict.reason !== 'estate-live') {
    process.stdout.write(`::warning::Estate probe inconclusive (${verdict.reason}); running the what-if anyway. ${verdict.detail}\n`);
  }
  // ALWAYS 0: a probe that cannot answer must not fail the build, and must not
  // suppress the lane either. Both are handled by paused=false above.
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('estate-live-probe.mjs')) {
  main();
}
