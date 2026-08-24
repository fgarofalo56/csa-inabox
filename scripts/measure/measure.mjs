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

/**
 * Windows ships `az`/`gh` as .cmd shims. Getting these launched correctly is
 * fiddly enough to be worth spelling out, because two of the three obvious
 * approaches fail in ways that LOOK like a real result:
 *
 *   - `shell:false` on a .cmd  -> Node >= 20 throws EINVAL (CVE-2024-27980).
 *   - `shell:true` with a FORWARD-SLASH path -> fails to launch and still
 *     returns rc=1, which reads as a genuine non-zero verdict.
 *   - `shell:true` with args   -> Node deprecates it (DEP0190): args are
 *     concatenated, not escaped, so a value containing a space or a quote
 *     silently changes the command.
 *
 * So a batch shim goes through `cmd.exe /d /s /c` with a hand-quoted command
 * line and `windowsVerbatimArguments`, which preserves argument fidelity. The
 * outer quote pair is required — cmd strips it, leaving the inner quoting intact.
 */
export function quoteForCmd(arg) {
  if (arg === '') return '""';
  return /[\s"^&|<>()]/.test(arg) ? `"${String(arg).replace(/"/g, '""')}"` : arg;
}

function resolveExe(bin) {
  const wrap = (file) => {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
      return { file, batch: true };
    }
    return { file, batch: false };
  };

  // An explicit path (absolute, or containing a separator) is used as given.
  // Without this, a full path like `C:\Program Files\nodejs\node.exe` is not
  // found by a PATH scan and reports "could not resolve" for a binary that
  // plainly exists — caught by this module's own self-test on first run.
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    if (existsSync(bin)) return wrap(bin);
    throw new MeasurementError(`'${bin}' is an explicit path but does not exist`, { bin });
  }
  if (process.platform !== 'win32') return { file: bin, batch: false };
  const exts = ['.cmd', '.exe', '.bat', ''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      if (existsSync(p)) return wrap(p);
    }
  }
  // Not found on PATH. Fail loudly rather than guessing.
  throw new MeasurementError(`could not resolve '${bin}' on PATH`, { bin });
}

/** Build the spawn triple for a resolved binary, batch shim or not. Exported for testing. */
export function spawnPlan(bin, args) {
  const { file, batch } = resolveExe(bin);
  if (!batch) return { cmd: file, argv: args, opts: {} };
  const line = [file.replace(/\//g, '\\'), ...args].map(quoteForCmd).join(' ');
  return {
    cmd: process.env.ComSpec || 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${line}"`],
    opts: { windowsVerbatimArguments: true },
  };
}

/**
 * A GitHub SECONDARY rate limit is a transient refusal, not a verdict and not a
 * quota exhaustion — it is refused BEFORE metering, so `core.used` stays ~flat
 * (observed: used=10/5000 while every request 403'd). Distinguishing it matters:
 * treating it as a real answer is how twenty PRs got reported at `0/0/0`.
 *
 * Retry is bounded and FAILS CLOSED — on exhaustion it throws like any other
 * failure. A retry that cannot fail would just relocate the lie.
 */
function isSecondaryRateLimit(stderr) {
  return /rate limit|secondary rate|abuse detection/i.test(stderr || '');
}

/**
 * Run a command and return its OWN exit status (R2), with no shell (R3).
 * Throws on non-zero: a failed command must not yield a value (R1).
 */
export function run(bin, args, { allowNonZero = false, timeoutMs = 600000, retries = 0, onRetry = null } = {}) {
  const plan = spawnPlan(bin, args);
  let last = null;
  let lastStatus = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = spawnSync(plan.cmd, plan.argv, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      windowsHide: true,
      ...plan.opts,
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
    if (res.status === 0 || allowNonZero) {
      return { rc: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    }

    last = (res.stderr || '').trim();
    lastStatus = res.status;
    if (attempt < retries && isSecondaryRateLimit(last)) {
      const waitMs = 30000 * (attempt + 1); // progressive, like the limit itself
      if (onRetry) onRetry(attempt + 1, waitMs, last);
      // Block synchronously; callers are scripts, not servers.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      continue;
    }
    break;
  }

  throw new MeasurementError(
    `${bin} exited ${lastStatus}: ${last?.slice(0, 400) || '<no stderr>'}`,
    { bin, args, status: lastStatus, stderr: last, rateLimited: isSecondaryRateLimit(last) },
  );
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
/** gh reads default to retrying a SECONDARY rate limit — it is transient, not a verdict. */
export const gh = (args, opts = {}) => runJson('gh', args, {
  retries: 4,
  onRetry: (n, ms, err) => process.stderr.write(
    `  [measure] secondary rate limit (attempt ${n}); waiting ${ms / 1000}s — this is NOT a verdict\n`,
  ),
  ...opts,
});

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
