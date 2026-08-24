#!/usr/bin/env node
/**
 * measure.mjs — measurements that cannot silently return a fake zero.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-23 three separate "clean" results were produced by queries that
 * never ran, and every one was indistinguishable from a real answer:
 *
 *   1. `R=$(az ... | tr -d '\r'); RC=$?`   -> RC is `tr`'s, not az's.
 *      Seven container apps reported "0 requests" at rc=0. The query had failed.
 *   2. Git Bash rewrote a leading-slash ARM id (`/subscriptions/...`) into a
 *      Windows path, so az answered "usage error" and the metric came back null.
 *      `null` was then read as zero.
 *   3. `gh api .../check-runs` returned HTTP 403 (secondary rate limit) and the
 *      caller's jq default produced `0/0/0` for twenty PRs.
 *
 * Each was caught only by a POSITIVE CONTROL — a subject known to be non-zero.
 * Without one, "no data" and "no activity" are the same string, and the wrong
 * one is always the more convenient.
 *
 * THE RULES THIS FILE ENFORCES
 * ----------------------------
 * R1. A failed command NEVER yields a value. It throws. There is no default.
 * R2. Exit status is captured from the subject process, never from a pipeline.
 *     Nothing here pipes; `spawnSync` returns the child's own status.
 * R3. No shell => no MSYS path mangling. ARM ids pass through untouched.
 * R4. `null` / missing / unparseable is UNKNOWN, a distinct state from 0.
 * R5. A zero result is REFUSED unless a positive control proves the query works.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** UNKNOWN is a value you cannot accidentally treat as a number (R4). */
export const UNKNOWN = Symbol('UNKNOWN');

export class MeasurementError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'MeasurementError';
    this.detail = detail;
  }
}

/** Windows ships `az`/`gh` as .cmd shims; resolve them so we never need a shell (R3). */
function resolveExe(bin) {
  // An explicit path (absolute, or containing a separator) is used as given.
  // Without this, a full path like `C:\Program Files\nodejs\node.exe` is not
  // found by a PATH scan and reports "could not resolve" for a binary that
  // plainly exists — caught by this module's own self-test on first run.
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    if (existsSync(bin)) return { file: bin, shell: false };
    throw new MeasurementError(`'${bin}' is an explicit path but does not exist`, { bin });
  }
  if (process.platform !== 'win32') return { file: bin, shell: false };
  const exts = ['.cmd', '.exe', '.bat', ''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      if (existsSync(p)) return { file: p, shell: false };
    }
  }
  // Not found on PATH. Fail loudly rather than falling back to a shell,
  // because `spawnSync(shell:true)` with a forward-slash .CMD returns rc=1
  // WITHOUT running anything -- a false "caught" that looks like a real result.
  throw new MeasurementError(`could not resolve '${bin}' on PATH`, { bin });
}

/**
 * Run a command and return its OWN exit status (R2), with no shell (R3).
 * Throws on non-zero: a failed command must not yield a value (R1).
 */
export function run(bin, args, { allowNonZero = false, timeoutMs = 600000 } = {}) {
  const { file } = resolveExe(bin);
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });

  if (res.error) {
    throw new MeasurementError(`${bin} failed to launch: ${res.error.message}`, { bin, args });
  }
  // status === null means killed by signal/timeout -- NOT a zero result.
  if (res.status === null) {
    throw new MeasurementError(`${bin} did not exit normally (timeout or signal)`, {
      bin, signal: res.signal,
    });
  }
  if (res.status !== 0 && !allowNonZero) {
    const err = (res.stderr || '').trim();
    throw new MeasurementError(
      `${bin} exited ${res.status}: ${err.slice(0, 400) || '<no stderr>'}`,
      { bin, args, status: res.status, stderr: err },
    );
  }
  return { rc: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Run and parse JSON. Unparseable output is an error, never an empty object (R1/R4). */
export function runJson(bin, args, opts) {
  const { stdout } = run(bin, args, opts);
  const text = stdout.trim();
  if (!text) {
    throw new MeasurementError(`${bin} succeeded but produced NO output — that is UNKNOWN, not empty`, { bin, args });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new MeasurementError(`${bin} output is not JSON: ${e.message}`, { bin, head: text.slice(0, 200) });
  }
}

export const az = (args, opts) => runJson('az', [...args, '-o', 'json'], opts);
export const gh = (args, opts) => runJson('gh', args, opts);

/**
 * The core guard (R5): report a numeric measurement ONLY when a positive
 * control proves the query path works.
 *
 *   subject  () => number | UNKNOWN
 *   control  () => number | UNKNOWN   -- must be > 0, or the result is refused
 *
 * A zero subject with a zero/failed control is NOT "zero activity"; it is a
 * broken query, and this throws rather than returning a number you would quote.
 */
export function measureWithControl({ label, subject, control, controlLabel = 'control' }) {
  let controlValue;
  try {
    controlValue = control();
  } catch (e) {
    throw new MeasurementError(
      `CONTROL '${controlLabel}' FAILED, so '${label}' cannot be interpreted: ${e.message}`,
      { label, controlLabel, cause: e },
    );
  }
  if (controlValue === UNKNOWN || !(Number(controlValue) > 0)) {
    throw new MeasurementError(
      `CONTROL '${controlLabel}' returned ${String(controlValue)} — it must be > 0. ` +
      `Refusing to report '${label}': a zero here would be indistinguishable from a broken query.`,
      { label, controlLabel, controlValue },
    );
  }

  const value = subject();
  if (value === UNKNOWN) {
    throw new MeasurementError(`'${label}' is UNKNOWN (no data retrieved) — that is NOT zero`, { label });
  }
  return { label, value: Number(value), control: { label: controlLabel, value: Number(controlValue) } };
}

/**
 * Sum an Azure Monitor metric. Returns UNKNOWN (never 0) when there is no
 * series / no timeseries / no datapoint carrying a value (R4).
 */
export function metricTotal(resourceId, metric, startIso, { aggregation = 'Total', interval = 'P1D' } = {}) {
  const d = az(['monitor', 'metrics', 'list', '--resource', resourceId, '--metric', metric,
    '--aggregation', aggregation, '--interval', interval, '--start-time', startIso]);
  const series = d?.value;
  if (!Array.isArray(series) || series.length === 0) return UNKNOWN;
  const ts = series[0]?.timeseries;
  if (!Array.isArray(ts) || ts.length === 0) return UNKNOWN;
  const pts = ts[0]?.data;
  if (!Array.isArray(pts) || pts.length === 0) return UNKNOWN;
  const have = pts.map((p) => p?.[aggregation.toLowerCase()] ?? p?.total).filter((v) => v !== null && v !== undefined);
  if (have.length === 0) return UNKNOWN;
  return have.reduce((a, b) => a + Number(b), 0);
}

/** Check-run counts for a commit. Throws on 403/404 rather than yielding 0/0/0. */
export function checkRuns(repo, sha) {
  const d = gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
  const runs = d?.check_runs;
  if (!Array.isArray(runs)) {
    throw new MeasurementError('check-runs response has no check_runs array — UNKNOWN, not zero', { repo, sha });
  }
  const total = runs.length;
  if (total === 0) {
    throw new MeasurementError(
      'check-runs returned ZERO runs. A PR with no checks is possible but rare; ' +
      'far more often this is a 403 or a wrong SHA. Verify before treating it as a verdict.',
      { repo, sha },
    );
  }
  return {
    total,
    red: runs.filter((r) => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion)).length,
    pending: runs.filter((r) => r.status !== 'completed').length,
  };
}
