#!/usr/bin/env node
/**
 * loom-aca-queue-watchdog.mjs — detect `loom-aca` jobs the KEDA scaler never
 * served, kick ONE `gh-aca-runner` execution per tick, and go RED when a kick
 * has already had its chance and the job is still queued (#5483).
 *
 * ── THE INCIDENT THIS EXISTS FOR (measured 2026-11-25, #5483) ───────────────
 * From 05:36Z to 18:08Z the `github-runner` KEDA scale rule on the Container
 * Apps Job `gh-aca-runner` polled GitHub successfully and computed
 * `MetricValue: 0.00, Active: false` while a `loom-aca` job (run 45574659735)
 * sat QUEUED for about ten hours. Nothing alerted: a queued job is neither red
 * nor green. What unblocked it immediately was a manual
 * `az containerapp job start -n gh-aca-runner …`, whose execution registered
 * an ephemeral runner and took the queued job. Root cause is NOT established
 * (a dead PAT on a public repo and/or a wedged scaler instance), so this
 * watchdog does not try to fix the scaler. It does the one thing that was
 * measured to work, bounded, and it says so loudly when that does not help.
 *
 * ── WHAT IT READS, AND WHY THREE LISTS ──────────────────────────────────────
 * GitHub's `GET /actions/runs?status=queued` index is NOT trusted alone. On
 * the same day it returned a ZOMBIE (run 43097708136, `queued` since
 * 2026-11-11, zero jobs, refusing cancel and force-cancel). And a `loom-aca`
 * job can be queued inside a run whose own status is `in_progress` (another
 * job of the same run already started). So the population is the UNION of:
 *   1. `?status=queued`        (paginated)
 *   2. `?status=in_progress`   (paginated)
 *   3. one unfiltered page of runs created in the last RECENT_HOURS
 * minus every run whose status is `completed` (a completed run cannot hold a
 * queued job). For each remaining run the JOBS are listed, and a job counts
 * only when `status == "queued"` AND its `labels` include LABEL. It is aged
 * from ITS OWN `created_at`, never the run's.
 *
 * A run that lists ZERO jobs is counted and logged, never kicked for. It is a
 * zombie (the 43097708136 shape) or a run not yet expanded into jobs (a run
 * pending on a concurrency group looks the same); this script cannot tell the
 * two apart and does not claim to.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *   age >= KICK_AFTER_MINUTES  -> start at most ONE `gh-aca-runner` execution
 *                                 this tick, unless a YOUNGER execution is
 *                                 already Running/Processing (see below).
 *   age >= RED_AFTER_MINUTES   -> exit 1 with `::error::` naming the job, its
 *                                 age, whether a kick was made this tick and
 *                                 the execution name `az` returned.
 * KICK_AFTER (9) covers the measured cold start: the D8 node scale-up emits
 * `NotTriggerScaleUp: Maximum Allowed Cores exceeded` and takes 2-3 min before
 * the pod schedules — a delay, not a block. RED_AFTER (25) on a ~10 min cron
 * means at least one kick has already been made and failed to take the job.
 *
 * "Younger" means an execution in Running/Processing that STARTED AFTER the
 * oldest stale job was created AND within the last COLD_START_MINUTES. That is
 * the execution most plausibly still booting toward this job; starting another
 * would double the spend for nothing. An in-flight execution OLDER than the
 * job is busy with some other job (the runner is ephemeral, one job per
 * execution) and does NOT suppress. One started after the job but longer ago
 * than the cold-start window, with the job still queued, demonstrably did not
 * take it, and does not suppress either.
 *
 * ── EXIT CODES ARE CLAIMS (deploy-integrity.md R7) ──────────────────────────
 * The R7 lessons of scripts/ci/brain-scan-queue-watchdog.sh apply verbatim:
 * exiting 0 is a claim, an unreadable state is not a clean one, and a PARSE
 * failure is its own outcome, distinct from an API failure and from "nothing
 * queued".
 *   0  clean / kicked under the red threshold / kick suppressed / declared pause
 *   1  RED: a loom-aca job queued past RED_AFTER_MINUTES
 *   2  FAIL CLOSED: a GitHub or Azure read failed after bounded retries
 *   3  FAIL CLOSED: a read SUCCEEDED but its payload could not be interpreted
 *   4  the kick itself failed, or `az` exited 0 without naming an execution
 *   5  usage: required configuration missing or thresholds inconsistent
 *
 * READS are retried (API_ATTEMPTS, bounded backoff) because re-issuing a GET is
 * harmless. The START is NEVER retried: a transient-looking failure may still
 * have started an execution, and a blind retry could start two. The next tick,
 * ~10 min later, is the retry.
 *
 * ── ESTATE PAUSE ────────────────────────────────────────────────────────────
 * Keyed ONLY to the DECLARED pause register (scripts/ci/estate-pause-
 * declaration.json, read through estate-pause-declared.mjs) for BOUNDARY
 * (default Commercial). NOT the console's estate-power record, which is known
 * stale (#5484). A declared pause stands down with a `::warning::` that says
 * nothing was measured — UNMEASURED, not clean.
 *
 * Env (defaults are the production values):
 *   GITHUB_REPOSITORY (required)     owner/repo
 *   LOOM_ACA_SUBSCRIPTION (required) subscription holding the job
 *   LOOM_ACA_RESOURCE_GROUP          default rg-csa-loom-admin-centralus
 *   LOOM_ACA_JOB_NAME                default gh-aca-runner
 *   LOOM_ACA_LABEL                   default loom-aca
 *   KICK_AFTER_MINUTES / RED_AFTER_MINUTES / COLD_START_MINUTES  9 / 25 / 6
 *   RECENT_HOURS                     default 24
 *   API_ATTEMPTS                     default 3
 *   KICK                             'false' = observe only, never start
 *   CSA_LOOM_BOUNDARY                default Commercial (pause register key)
 *
 * Tests: node --test scripts/ci/__tests__/loom-aca-queue-watchdog.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyAzFailure } from './_az-failure-class.mjs';
import { loadRegister, decide as decidePause } from './estate-pause-declared.mjs';
import { PAUSE_DECLARATION_PATH } from './_estate-pause-declaration.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const EXIT = Object.freeze({
  ok: 0,
  stale: 1,
  apiUnreadable: 2,
  parseFailure: 3,
  kickFailed: 4,
  usage: 5,
});

export const DEFAULTS = Object.freeze({
  resourceGroup: 'rg-csa-loom-admin-centralus',
  jobName: 'gh-aca-runner',
  label: 'loom-aca',
  kickAfterMinutes: 9,
  redAfterMinutes: 25,
  coldStartMinutes: 6,
  recentHours: 24,
  apiAttempts: 3,
  maxPages: 10,
  kick: true,
  boundary: 'Commercial',
});

/** Execution states that mean "a runner is (or is about to be) up". */
export const IN_FLIGHT = new Set(['Running', 'Processing']);

const MIN = 60_000;

/** Thrown to abort the tick with a specific outcome. Never escapes runWatchdog. */
class Abort extends Error {
  constructor(exitCode, outcome, message) {
    super(message);
    this.exitCode = exitCode;
    this.outcome = outcome;
  }
}

/**
 * PURE. Validate configuration. Returns an error string or null.
 * WHAT MAKES IT FAIL: RED_AFTER <= KICK_AFTER (the red signal would fire
 * before any kick had a chance), a missing repo or subscription, a
 * non-positive threshold.
 */
export function validateConfig(cfg) {
  if (!cfg.repo || !/^[^/\s]+\/[^/\s]+$/.test(cfg.repo)) return `GITHUB_REPOSITORY is missing or not owner/repo ('${cfg.repo ?? ''}')`;
  if (!cfg.subscription) return 'LOOM_ACA_SUBSCRIPTION is empty, so the job cannot be addressed and nothing can be measured or kicked';
  for (const k of ['kickAfterMinutes', 'redAfterMinutes', 'coldStartMinutes', 'recentHours', 'apiAttempts']) {
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) return `${k} must be a positive number (got '${cfg[k]}')`;
  }
  if (cfg.redAfterMinutes <= cfg.kickAfterMinutes) {
    return `RED_AFTER_MINUTES (${cfg.redAfterMinutes}) must exceed KICK_AFTER_MINUTES (${cfg.kickAfterMinutes}), or a job would go red before any kick could be tried`;
  }
  return null;
}

/** Retry a read with bounded backoff. Returns the successful result or throws Abort(2). */
async function readWithRetry(what, attempts, deps, call, describeFailure) {
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    last = await call();
    if (last.ok) return last;
    deps.log(`::warning::${what} failed (attempt ${i} of ${attempts}): ${describeFailure(last)}`);
    if (i < attempts) await deps.sleep(2000 * i);
  }
  throw new Abort(
    EXIT.apiUnreadable,
    'api-unreadable',
    `${what} failed ${attempts} time(s) in a row (last: ${describeFailure(last)}). The watchdog has established NOTHING about the loom-aca queue on this tick, so it FAILS CLOSED rather than publishing a clean verdict on an unread state (deploy-integrity.md R7).`,
  );
}

function parseJson(what, stdout) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Abort(
      EXIT.parseFailure,
      'parse-failure',
      `${what} SUCCEEDED but its output is not parseable JSON (${err.message}). This is NOT "nothing queued": the API answered and this script could not interpret the answer, so it FAILS CLOSED.`,
    );
  }
}

const ghFailure = (r) => `gh exit ${r.code}; ${String(r.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ') || '<no stderr>'}`;
const azFailure = (r) => `az exit ${r.code}, class=${classifyAzFailure(r.stderr)}; ${String(r.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ') || '<no stderr>'}`;

/** GET a GitHub path, retried, parsed. */
async function ghJson(cfg, deps, apiPath) {
  const r = await readWithRetry(`GET ${apiPath}`, cfg.apiAttempts, deps, () => deps.gh(apiPath), ghFailure);
  return parseJson(`GET ${apiPath}`, r.stdout);
}

/** Paginate a list endpoint whose body is `{ <key>: [...] }`. */
async function ghList(cfg, deps, basePath, key) {
  const out = [];
  for (let page = 1; page <= cfg.maxPages; page += 1) {
    const sep = basePath.includes('?') ? '&' : '?';
    const p = `${basePath}${sep}per_page=100&page=${page}`;
    const body = await ghJson(cfg, deps, p);
    if (!body || typeof body !== 'object' || !Array.isArray(body[key])) {
      throw new Abort(EXIT.parseFailure, 'parse-failure', `GET ${p} returned JSON with no \`${key}\` array, so the list could not be read. FAILING CLOSED.`);
    }
    out.push(...body[key]);
    if (body[key].length < 100) return out;
  }
  throw new Abort(
    EXIT.parseFailure,
    'parse-failure',
    `GET ${basePath} still had full pages after ${cfg.maxPages} pages; the rest of the list is UNREAD, so a queued job could be in the part not seen. FAILING CLOSED.`,
  );
}

/**
 * Detection. Returns { queued: [{run, job, ageMs}], zeroJobRuns: [run], runsExamined }.
 */
export async function detect(cfg, deps) {
  const nowMs = deps.now();
  const base = `repos/${cfg.repo}/actions/runs`;
  const since = new Date(nowMs - cfg.recentHours * 60 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const lists = [
    await ghList(cfg, deps, `${base}?status=queued`, 'workflow_runs'),
    await ghList(cfg, deps, `${base}?status=in_progress`, 'workflow_runs'),
  ];
  // ONE unfiltered recent page, deliberately not paginated: it is the backstop
  // for the filtered index, and lists 1-2 are already exhaustive for what they
  // cover.
  const recent = await ghJson(cfg, deps, `${base}?per_page=100&created=${encodeURIComponent(`>=${since}`)}`);
  if (!recent || !Array.isArray(recent.workflow_runs)) {
    throw new Abort(EXIT.parseFailure, 'parse-failure', 'the recent-runs page returned JSON with no `workflow_runs` array. FAILING CLOSED.');
  }
  lists.push(recent.workflow_runs);

  const runs = new Map();
  for (const list of lists) {
    for (const run of list) {
      if (!run || typeof run !== 'object' || !Number.isInteger(run.id)) {
        throw new Abort(EXIT.parseFailure, 'parse-failure', `a workflow run entry had no integer id (${JSON.stringify(run)?.slice(0, 120)}). FAILING CLOSED.`);
      }
      if (run.status === 'completed') continue;
      runs.set(run.id, run);
    }
  }

  const queued = [];
  const zeroJobRuns = [];
  for (const run of runs.values()) {
    const jobs = await ghList(cfg, deps, `${base}/${run.id}/jobs`, 'jobs');
    if (jobs.length === 0) {
      zeroJobRuns.push(run);
      continue;
    }
    for (const job of jobs) {
      if (!job || job.status !== 'queued') continue;
      if (!Array.isArray(job.labels)) {
        throw new Abort(EXIT.parseFailure, 'parse-failure', `queued job ${job.id} in run ${run.id} has no \`labels\` array, so whether it targets ${cfg.label} is UNKNOWN. FAILING CLOSED.`);
      }
      if (!job.labels.includes(cfg.label)) continue;
      const created = Date.parse(job.created_at);
      if (!Number.isFinite(created)) {
        throw new Abort(EXIT.parseFailure, 'parse-failure', `queued ${cfg.label} job ${job.id} in run ${run.id} has an unparseable created_at ('${job.created_at}'), so its age is UNKNOWN. FAILING CLOSED.`);
      }
      queued.push({ run, job, ageMs: nowMs - created });
    }
  }
  queued.sort((a, b) => b.ageMs - a.ageMs);
  return { queued, zeroJobRuns, runsExamined: runs.size };
}

/** Read the job's executions. Returns [{name, status, startMs}]. */
export async function readExecutions(cfg, deps) {
  const args = ['containerapp', 'job', 'execution', 'list', '-n', cfg.jobName, '-g', cfg.resourceGroup, '--subscription', cfg.subscription, '-o', 'json'];
  const what = `az containerapp job execution list (${cfg.jobName} in ${cfg.resourceGroup})`;
  const r = await readWithRetry(what, cfg.apiAttempts, deps, () => deps.az(args), azFailure);
  const body = parseJson(what, r.stdout);
  if (!Array.isArray(body)) {
    throw new Abort(EXIT.parseFailure, 'parse-failure', `${what} returned JSON that is not an array. FAILING CLOSED.`);
  }
  return body.map((e) => {
    const status = e?.properties?.status ?? e?.status;
    const start = e?.properties?.startTime ?? e?.startTime;
    if (typeof status !== 'string' || typeof e?.name !== 'string') {
      throw new Abort(EXIT.parseFailure, 'parse-failure', `${what} returned an execution with no name/status (${JSON.stringify(e)?.slice(0, 160)}), so whether a runner is already booting is UNKNOWN. FAILING CLOSED.`);
    }
    const startMs = start ? Date.parse(start) : NaN;
    if (IN_FLIGHT.has(status) && !Number.isFinite(startMs)) {
      throw new Abort(EXIT.parseFailure, 'parse-failure', `in-flight execution ${e.name} has no parseable startTime ('${start}'), so whether it is younger than the queued job is UNKNOWN. FAILING CLOSED.`);
    }
    return { name: e.name, status, startMs };
  });
}

/**
 * PURE. The in-flight execution that should suppress a kick for `oldest`, or null.
 * WHAT MAKES IT RETURN NON-NULL: status Running/Processing AND startMs after the
 * job's created_at AND startMs within the last coldStartMinutes.
 */
export function youngerInFlight(executions, oldest, nowMs, coldStartMinutes) {
  const created = Date.parse(oldest.job.created_at);
  return (
    executions.find(
      (e) => IN_FLIGHT.has(e.status) && e.startMs > created && nowMs - e.startMs < coldStartMinutes * MIN,
    ) ?? null
  );
}

/** Start ONE execution. Never retried. Returns { ok, name, message }. */
async function kickOnce(cfg, deps) {
  const args = ['containerapp', 'job', 'start', '-n', cfg.jobName, '-g', cfg.resourceGroup, '--subscription', cfg.subscription, '-o', 'json'];
  const r = await deps.az(args);
  if (!r.ok) {
    return { ok: false, name: null, message: `az containerapp job start FAILED (${azFailure(r)}). No execution was confirmed started. Not retried within this tick, because a failed start may still have created one.` };
  }
  let body = null;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    body = null;
  }
  const name = body && typeof body.name === 'string' && body.name ? body.name : null;
  if (!name) {
    return { ok: false, name: null, message: `az containerapp job start exited 0 but its output named NO execution (stdout: '${String(r.stdout ?? '').slice(0, 160)}'). Whether an execution started is NOT established.` };
  }
  return { ok: true, name, message: null };
}

const minutes = (ms) => (ms / MIN).toFixed(1);
const describeJob = (q) => `job '${q.job.name}' (id ${q.job.id}) in run ${q.run.id} '${q.run.name ?? ''}' [${q.job.html_url ?? q.run.html_url ?? ''}]`;

/**
 * The whole tick. Never throws; returns { exitCode, outcome, lines, kick }.
 * deps: { gh(path), az(args), now(), sleep(ms), pause(today) -> {declared, lines}, log(line) }
 */
export async function runWatchdog(cfgIn, depsIn) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const lines = [];
  const deps = { ...depsIn, log: (l) => { lines.push(l); depsIn.log?.(l); } };
  const done = (exitCode, outcome, extra = {}) => ({ exitCode, outcome, lines, ...extra });

  const bad = validateConfig(cfg);
  if (bad) {
    deps.log(`::error::loom-aca queue watchdog misconfigured: ${bad}.`);
    return done(EXIT.usage, 'usage');
  }

  try {
    // ── 1. Declared pause (NOT the console estate-power record, #5484) ──────
    const today = new Date(deps.now()).toISOString().slice(0, 10);
    const pause = deps.pause(today);
    for (const l of pause.lines ?? []) deps.log(l);
    if (pause.declared === true) {
      deps.log(
        `::warning::the ${cfg.boundary} estate is DECLARED paused in ${PAUSE_DECLARATION_PATH}, so the loom-aca queue watchdog is STANDING DOWN. Nothing was measured and nothing was kicked on this tick: this is UNMEASURED, not clean. A loom-aca job queued while the pause stands will not be detected here.`,
      );
      return done(EXIT.ok, 'paused');
    }

    // ── 2. Detect ───────────────────────────────────────────────────────────
    const { queued, zeroJobRuns, runsExamined } = await detect(cfg, deps);
    deps.log(`[watchdog] runs examined (non-completed, union of queued/in_progress/recent): ${runsExamined}; queued ${cfg.label} jobs: ${queued.length}`);
    if (zeroJobRuns.length > 0) {
      deps.log(
        `::notice::${zeroJobRuns.length} non-completed run(s) list ZERO jobs and were IGNORED (zombie, or not yet expanded into jobs — this script cannot tell which): ${zeroJobRuns.map((r) => `${r.id} (${r.status}, created ${r.created_at})`).join(', ')}`,
      );
    }
    for (const q of queued) deps.log(`[watchdog] queued: ${describeJob(q)} age ${minutes(q.ageMs)} min`);

    // ── 3. Executions — read EVERY tick, so a broken Azure credential is
    //       found on a quiet tick and not first during an incident.
    const executions = await readExecutions(cfg, deps);
    const inFlight = executions.filter((e) => IN_FLIGHT.has(e.status));
    deps.log(`[watchdog] ${cfg.jobName} executions listed: ${executions.length}; Running/Processing: ${inFlight.length}${inFlight.length ? ` (${inFlight.map((e) => `${e.name}=${e.status}`).join(', ')})` : ''}`);

    // ── 4. Kick ─────────────────────────────────────────────────────────────
    const stale = queued.filter((q) => q.ageMs >= cfg.kickAfterMinutes * MIN);
    let kick = { made: false, name: null, suppressedBy: null, failure: null };
    if (stale.length > 0) {
      const oldest = stale[0];
      const younger = youngerInFlight(executions, oldest, deps.now(), cfg.coldStartMinutes);
      if (younger) {
        kick.suppressedBy = younger;
        deps.log(
          `::notice::kick SUPPRESSED: execution ${younger.name} is ${younger.status}, started after ${describeJob(oldest)} was queued and within the ${cfg.coldStartMinutes}-min cold-start window, so it may still take the job.`,
        );
      } else if (!cfg.kick) {
        deps.log(`::notice::KICK=false — would have started one ${cfg.jobName} execution for ${describeJob(oldest)} (queued ${minutes(oldest.ageMs)} min); started NOTHING.`);
      } else {
        const r = await kickOnce(cfg, deps);
        if (r.ok) {
          kick = { ...kick, made: true, name: r.name };
          deps.log(
            `::warning::KICKED: started ${cfg.jobName} execution '${r.name}' because ${describeJob(oldest)} was queued ${minutes(oldest.ageMs)} min (>= ${cfg.kickAfterMinutes}) and the KEDA scaler had not served it. A kick working is a WORKAROUND, not health: the scale rule did not fire. See docs/fiab/github-actions-runner.md "Queue watchdog".`,
          );
        } else {
          kick = { ...kick, failure: r.message };
          deps.log(`::error::kick for ${describeJob(oldest)} (queued ${minutes(oldest.ageMs)} min): ${r.message}`);
        }
      }
    }

    // ── 5. Red ──────────────────────────────────────────────────────────────
    const red = queued.filter((q) => q.ageMs >= cfg.redAfterMinutes * MIN);
    const kickSays = kick.made
      ? `a kick WAS made this tick (execution '${kick.name}')`
      : kick.failure
        ? 'a kick was ATTEMPTED this tick and FAILED (above)'
        : kick.suppressedBy
          ? `no kick this tick (suppressed by in-flight execution ${kick.suppressedBy.name})`
          : cfg.kick
            ? 'no kick this tick'
            : 'no kick this tick (KICK=false)';
    for (const q of red) {
      deps.log(
        `::error::${cfg.label} ${describeJob(q)} has been QUEUED ${minutes(q.ageMs)} min (>= ${cfg.redAfterMinutes}); ${kickSays}. The in-VNet runner is not serving this label. Manual remedy: az containerapp job start -n ${cfg.jobName} -g ${cfg.resourceGroup} --subscription <sub>; then read the KEDA events (docs/fiab/github-actions-runner.md).`,
      );
    }

    if (kick.failure) return done(EXIT.kickFailed, 'kick-failed', { kick, red });
    if (red.length > 0) return done(EXIT.stale, 'stale-red', { kick, red });
    if (kick.made) return done(EXIT.ok, 'kicked', { kick, red });
    if (kick.suppressedBy) return done(EXIT.ok, 'suppressed', { kick, red });
    deps.log(`[watchdog] no ${cfg.label} job queued >= ${cfg.kickAfterMinutes} min.`);
    return done(EXIT.ok, 'clean', { kick, red });
  } catch (err) {
    if (err instanceof Abort) {
      deps.log(`::error::${err.message}`);
      return done(err.exitCode, err.outcome);
    }
    deps.log(`::error::loom-aca queue watchdog hit an unexpected error (${err?.stack ?? err}); it has established nothing and FAILS CLOSED.`);
    return done(EXIT.parseFailure, 'unexpected');
  }
}

// ── Production dependencies ────────────────────────────────────────────────
function spawnResult(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  if (r.error) return { ok: false, code: -1, stdout: '', stderr: String(r.error.message) };
  return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return Number(raw);
}

async function main() {
  const cfg = {
    repo: process.env.GITHUB_REPOSITORY ?? '',
    subscription: process.env.LOOM_ACA_SUBSCRIPTION ?? '',
    resourceGroup: process.env.LOOM_ACA_RESOURCE_GROUP || DEFAULTS.resourceGroup,
    jobName: process.env.LOOM_ACA_JOB_NAME || DEFAULTS.jobName,
    label: process.env.LOOM_ACA_LABEL || DEFAULTS.label,
    kickAfterMinutes: envNumber('KICK_AFTER_MINUTES', DEFAULTS.kickAfterMinutes),
    redAfterMinutes: envNumber('RED_AFTER_MINUTES', DEFAULTS.redAfterMinutes),
    coldStartMinutes: envNumber('COLD_START_MINUTES', DEFAULTS.coldStartMinutes),
    recentHours: envNumber('RECENT_HOURS', DEFAULTS.recentHours),
    apiAttempts: envNumber('API_ATTEMPTS', DEFAULTS.apiAttempts),
    kick: (process.env.KICK ?? 'true').toLowerCase() !== 'false',
    boundary: process.env.CSA_LOOM_BOUNDARY || DEFAULTS.boundary,
  };
  const deps = {
    gh: async (p) => spawnResult('gh', ['api', p]),
    az: async (args) => spawnResult('az', args),
    now: () => Date.now(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    pause: (today) => {
      const { register, readError } = loadRegister(path.join(REPO_ROOT, PAUSE_DECLARATION_PATH));
      return decidePause({ register, readError, boundary: cfg.boundary, today });
    },
    log: (l) => console.log(l),
  };
  const result = await runWatchdog(cfg, deps);
  const summary = `## loom-aca queue watchdog\n\noutcome: **${result.outcome}** (exit ${result.exitCode})\n\n${result.lines.map((l) => `- ${l.replace(/^::\w+::/, '')}`).join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`[watchdog] outcome=${result.outcome} exit=${result.exitCode}`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
