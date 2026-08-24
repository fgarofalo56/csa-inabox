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
import { buildCmdLine, needsCmdWrapper, CmdQuoteError } from './cmd-quote.mjs';

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
 *
 * The quoting itself lives in `./cmd-quote.mjs`: it is pure, so it is testable
 * without spawning anything.
 */

/**
 * The only binaries this toolkit may launch. This is a LOOKUP TABLE, not a
 * membership set, because the value that gets spawned is the one read OUT of
 * it — never the caller's string.
 *
 * The previous shape validated a PROJECTION of the input and then spawned the
 * INPUT, which is a hole rather than a guard:
 *
 *   assertAllowed('/tmp/evil/gh.cmd')   // basename -> 'gh' -> ALLOWED
 *   needsWrapper('/tmp/evil/gh.cmd')    // explicit path -> exists -> spawned
 *
 * One directory an attacker can write to, one file named after any allowlisted
 * binary, and the allowlist waves it through. Returning the table's own frozen
 * literal severs that: what reaches `spawnSync` originates in THIS file.
 *
 * It also severs the dataflow edge that `js/indirect-command-line-injection`
 * (CWE-078) follows — for the same reason it is a real fix, not a placation.
 */
const ALLOWED_BINARIES = Object.freeze({
  __proto__: null,
  gh: 'gh', az: 'az', git: 'git', node: 'node', npm: 'npm', pnpm: 'pnpm', pwsh: 'pwsh',
});

/**
 * Launch the node running THIS process, rather than whatever `node` resolves to
 * on PATH.
 *
 * A Symbol, deliberately: it is the one way to say "this exact executable"
 * without a caller-supplied string reaching the spawn. It exists because the
 * test suite legitimately needs `process.execPath`, and that need is what the
 * old explicit-path branch was really serving — while incidentally accepting
 * every other path on the filesystem.
 */
export const SELF_NODE = Symbol('SELF_NODE');

const ALLOWED_NAMES = Object.keys(ALLOWED_BINARIES).sort().join(', ');

/**
 * Map a caller's binary name onto the allowlist's own literal.
 *
 * Returns a value drawn from `ALLOWED_BINARIES`, so the return is never the
 * argument — that substitution is the entire point. `Object.hasOwn` against a
 * null-prototype table also means `'constructor'` and `'__proto__'` are refused
 * like any other unknown name instead of inheriting a truthy hit.
 */
function canonicalBinary(bin) {
  if (typeof bin !== 'string') {
    throw new MeasurementError(`binary must be a bare allowed name (allowed: ${ALLOWED_NAMES})`, { bin: String(bin) });
  }
  const key = bin.toLowerCase();
  if (!Object.hasOwn(ALLOWED_BINARIES, key)) {
    // A path is rejected for BEING a path, not for failing to exist. The old
    // message ("explicit path but does not exist") implied the same path would
    // have been fine had it existed, which was true and was the bug.
    const why = /[\\/]/.test(bin) ? 'paths are not accepted; pass a bare name or SELF_NODE' : `allowed: ${ALLOWED_NAMES}`;
    throw new MeasurementError(`'${bin}' is not an allowed binary (${why})`, { bin });
  }
  return ALLOWED_BINARIES[key];
}

/**
 * A string safe to interpolate into an error message.
 *
 * `${bin}` throws TypeError on a Symbol ("Cannot convert a Symbol value to a
 * string"), which would replace every real failure message on the SELF_NODE
 * path with a crash inside the error handler — the failure reported would be
 * the reporter's.
 */
function binLabel(bin) {
  return bin === SELF_NODE ? `node (${process.execPath})` : String(bin);
}

/**
 * Decide whether `bin` needs the cmd.exe wrapper — and return ONLY that boolean.
 *
 * The PATH scan deliberately DISCARDS the path it finds. An earlier version
 * returned it and spawned it, which put `process.env.PATH` on a dataflow path
 * into `spawnSync`'s executable argument. That is CodeQL's
 * `js/indirect-command-line-injection` (CWE-078), and it is a TRUE positive:
 * resolving an executable out of an environment variable is the shape the query
 * exists to find. It also stopped the query terminating inside its 600s budget,
 * which on main uploads a `codeql-failed-run.sarif` and FREEZES the whole JS/TS
 * alert list (see .github/workflows/codeql.yml, and the 2026-08-03 outage).
 *
 * Returning a boolean severs the flow at a type that cannot carry taint, and it
 * is the better code regardless: both remaining launch paths resolve the binary
 * themselves — libuv for a direct spawn, cmd.exe (via PATHEXT) for a shim — and
 * both are more faithful than this four-extension guess ever was.
 *
 * `bin` here is always a literal out of ALLOWED_BINARIES, so there is no
 * explicit-path branch to serve. There used to be one, for `process.execPath`;
 * SELF_NODE serves that need now without also accepting every other path.
 */
function needsWrapper(bin) {
  if (process.platform !== 'win32') return false;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['.cmd', '.exe', '.bat', '']) {
      // `found` is consumed for its EXTENSION and then dropped. It must never
      // be returned, spawned, or interpolated — see the note above.
      const found = path.join(dir, bin + ext);
      if (existsSync(found)) return needsCmdWrapper(found);
    }
  }
  // Not found on PATH. Fail loudly rather than guessing.
  throw new MeasurementError(`could not resolve '${bin}' on PATH`, { bin });
}

/**
 * Build the spawn triple. Every value that can become the EXECUTABLE originates
 * in this file: a frozen literal from ALLOWED_BINARIES, the literal `cmd.exe`,
 * or `process.execPath`. Nothing derived from argv or the environment does.
 *
 * NOT exported. An exported function's parameters are an external taint source
 * to a static analyser, and exporting this one — solely so a unit test could
 * reach the .cmd branch without az installed — was itself enough to stop the
 * same query terminating. The pure half lives in cmd-quote.mjs and is tested
 * directly there instead.
 */
function spawnPlan(bin, args) {
  // SELF_NODE resolves to this process's own executable. It cannot be a .cmd,
  // so it never needs the wrapper.
  if (bin === SELF_NODE) return { cmd: process.execPath, argv: args, opts: {} };
  const file = canonicalBinary(bin);
  if (!needsWrapper(file)) return { cmd: file, argv: args, opts: {} };
  // The interpreter is a LITERAL. ComSpec used to be honoured when it "named
  // cmd.exe", tested as /(^|[\\/])cmd\.exe$/i — which any attacker who can set
  // ComSpec satisfies by naming their binary `cmd.exe` in a directory they own.
  // A guard one rename away from defeat is not a guard; libuv resolving
  // `cmd.exe` from System32 on PATH is both safer and one fewer env read.
  return {
    cmd: 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${buildCmdLine(file, args)}"`],
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
  const label = binLabel(bin);
  let plan;
  try {
    plan = spawnPlan(bin, args);
  } catch (e) {
    // A refused argument is still a refusal to produce a value (R1); callers
    // only ever have to catch MeasurementError.
    if (e instanceof CmdQuoteError) {
      throw new MeasurementError(`${label} cannot be launched safely: ${e.message}`, { bin: label, args, cause: e });
    }
    throw e;
  }
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
      throw new MeasurementError(`${label} failed to launch: ${res.error.message}`, { bin: label, args });
    }
    // status === null means killed by signal/timeout -- NOT a zero result.
    if (res.status === null) {
      throw new MeasurementError(`${label} did not exit normally (timeout or signal)`, {
        bin: label, signal: res.signal,
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
    `${label} exited ${lastStatus}: ${last?.slice(0, 400) || '<no stderr>'}`,
    { bin: label, args, status: lastStatus, stderr: last, rateLimited: isSecondaryRateLimit(last) },
  );
}

/** Run and parse JSON. Unparseable output is an error, never an empty object (R1/R4). */
export function runJson(bin, args, opts) {
  const label = binLabel(bin);
  const { stdout } = run(bin, args, opts);
  const text = stdout.trim();
  if (!text) {
    throw new MeasurementError(`${label} succeeded but produced NO output — that is UNKNOWN, not empty`, { bin: label, args });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new MeasurementError(`${label} output is not JSON: ${e.message}`, { bin: label, head: text.slice(0, 200) });
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

/**
 * Was a green check-run HOLLOW — did it report success having executed nothing?
 *
 * A required check that skips every substantive step still reports `success`,
 * and branch protection accepts it. Observed on `main`: `vitest (node 20)` came
 * back green with steps 4-8 skipped, including "Run vitest", because the last
 * merge touched no console files. A live test failure sat behind that green.
 *
 * Returns `{ hollow, ran, skipped, skippedNames }`. Note that hollowness is NOT
 * automatically a defect — a skip can be genuinely path-appropriate for the diff
 * being tested. It is a defect when the green is then read as coverage. This
 * reports the fact and leaves the judgement to the caller, which is the only
 * honest split.
 */
export function checkRunHollowness(repo, jobId) {
  const job = gh(['api', `repos/${repo}/actions/jobs/${jobId}`]);
  const steps = job?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new MeasurementError('job has no steps — UNKNOWN, not hollow and not sound', { repo, jobId });
  }
  // Setup/teardown steps are noise; they run even when everything real is skipped.
  const NOISE = /^(Set up job|Complete job|Post |Run actions\/checkout|Checkout)/i;
  const substantive = steps.filter((s) => !NOISE.test(s.name));
  const skipped = substantive.filter((s) => s.conclusion === 'skipped');
  const ran = substantive.filter((s) => s.conclusion !== 'skipped');
  return {
    hollow: substantive.length > 0 && ran.length === 0,
    ran: ran.length,
    skipped: skipped.length,
    skippedNames: skipped.map((s) => s.name),
    conclusion: job.conclusion,
  };
}

/** Extract the job id from a check-run's details_url, or null. */
export function jobIdFromUrl(url) {
  const m = String(url || '').match(/\/job\/(\d+)/);
  return m ? m[1] : null;
}
/**
 * Check-run counts for a commit. Throws on 403/404 rather than yielding 0/0/0,
 * and PAGINATES — a `per_page=100` read that returns exactly 100 is SATURATED,
 * not complete. Reading a truncated page as the whole set produced a confident
 * "no vitest check on this SHA" for a commit that had one on page 2.
 */
export function checkRuns(repo, sha) {
  const all = [];
  let total = null;
  for (let page = 1; page <= 20; page++) {
    const d = gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`]);
    const runs = d?.check_runs;
    if (!Array.isArray(runs)) {
      throw new MeasurementError('check-runs response has no check_runs array — UNKNOWN, not zero', { repo, sha, page });
    }
    if (total === null) total = d.total_count;
    all.push(...runs);
    if (runs.length < 100 || all.length >= (total ?? Infinity)) break;
  }

  if (all.length === 0) {
    throw new MeasurementError(
      'check-runs returned ZERO runs. A PR with no checks is possible but rare; ' +
      'far more often this is a 403 or a wrong SHA. Verify before treating it as a verdict.',
      { repo, sha },
    );
  }
  // A short read against a known total is a partial answer, not a verdict.
  if (total !== null && all.length < total) {
    throw new MeasurementError(
      `check-runs TRUNCATED: fetched ${all.length} of ${total}. Refusing to report counts ` +
      'from a partial page — that is how a missing check reads as an absent one.',
      { repo, sha, fetched: all.length, total },
    );
  }

  return {
    total: all.length,
    declaredTotal: total,
    red: all.filter((r) => ['failure', 'timed_out'].includes(r.conclusion)).length,
    cancelled: all.filter((r) => r.conclusion === 'cancelled').length,
    pending: all.filter((r) => r.status !== 'completed').length,
    runs: all,
  };
}
