#!/usr/bin/env node
/**
 * check-cross-cloud-drift.mjs — is EVERY live estate running main? (#3730)
 *
 * WHY THIS EXISTS
 * ===============
 * On 2026-08-18 the Azure Government console was serving an image built on
 * 2026-08-11: 251 commits and seven days behind main, reporting version 0.90.2
 * while Commercial reported 0.98.11. Every security fix merged in the preceding
 * week was inert in the sovereign boundary.
 *
 * NOTHING ANYWHERE SAID SO. It was found by hand-curling two URLs.
 *
 * The reason is worth stating precisely, because it is not "nobody watched
 * deploys" — a great deal watches deploys here. check-deploy-staleness.mjs
 * compares fifteen deploy lanes' run history against git, and its live-estate
 * half carried ONE entry, Commercial, under this note:
 *
 *     "GOV IS NOT LISTED, AND THAT IS REPORTED, NOT SILENT. The Gov console has
 *      no publicly-reachable marker (private ingress), so this check cannot see
 *      it."
 *
 * That is an honest-sounding sentence, and it is FALSE: the Gov marker answers
 * 200 over plain HTTPS, unauthenticated, from anywhere. A stale premise had
 * become the thing keeping the estate unmeasured, and it read as rigour on the
 * way past. This is the `stale_audit_items_propagate` shape applied to a
 * control's own scope: the control was not wrong about what it measured, it was
 * wrong about what it COULD measure, and nobody re-tested the claim.
 *
 * WHAT THIS ADDS THAT check-deploy-staleness.mjs DOES NOT
 * ------------------------------------------------------
 * That check now covers both clouds too (it shares this registry). But it also
 * carries fifteen deploy-lane rows and has exited 1 on essentially every run for
 * months, for reasons that have nothing to do with either console's freshness.
 * A cross-cloud drift signal buried in a permanently-red report is a signal
 * nobody can read, and being ignored is the exact failure mode this whole class
 * of control exists to prevent.
 *
 * So this lane does ONE thing and its red/green means ONE thing: at least one
 * live estate is not running main, or could not be measured. Nothing else can
 * turn it red, and nothing else can hide inside its green.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never dispatches, rolls or deploys anything, in either cloud. #3730 flags —
 * and explicitly declines to answer — whether Gov's dispatch-only posture is a
 * deliberate change-control decision for the sovereign boundary. Making the
 * drift VISIBLE does not require settling that question; starting a sovereign
 * deploy from CI would presume an answer nobody has given.
 *
 * THREE STATES, NOT TWO (deploy-integrity.md R7)
 * ----------------------------------------------
 * On 2026-08-05 a roll reported "the tag does not exist" when the truth was "I
 * could not reach the registry", and that one false sentence sent two separate
 * investigations down the wrong path. So this check never collapses "I could not
 * look" into either answer:
 *
 *     ok         measured, and the estate is on main (or inside its roll window)
 *     DRIFT      measured, and the estate is genuinely behind / divergent
 *     UNKNOWN    NOT measured — unreachable, unparseable, or a sha this clone
 *                does not contain
 *
 * UNKNOWN is reported as its own word with its own reason, never as "up to
 * date" and never as "behind". It DOES still fail the lane, and those two facts
 * are not in tension: an estate nobody can measure is not an estate anyone has
 * shown to be healthy. A commit this clone does not contain yields UNKNOWN and
 * never zero-behind, which is the specific arithmetic that would otherwise turn
 * a shallow checkout into a clean bill of health.
 *
 * NO RESULT IS DISCARDED. There is no `|| true`, no `continue-on-error`, no
 * `2>/dev/null`; git's stderr is captured and REPORTED rather than swallowed,
 * because a swallowed stderr is how the 2026-08-05 false claim was manufactured.
 *
 * TEETH. scripts/ci/__tests__/cross-cloud-drift.test.mjs drives every branch
 * with fixtures and asserts the verdict MOVES: a current sha passes, a stale one
 * fails, an unreachable endpoint is UNKNOWN rather than either. A guard nobody
 * has watched fail is indistinguishable from a guard that cannot.
 *
 * Usage:  node scripts/ci/check-cross-cloud-drift.mjs [--json]
 *         (needs a full-history checkout: it asks git for commit distances)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_ESTATES, describeOverrides, parseBuildMarker } from './_estate-registry.mjs';
import { classifyEstate } from './check-deploy-staleness.mjs';

/**
 * Per-request bound. A hung endpoint must become an honest UNKNOWN rather than
 * a job that sits until the runner times out — a lane that never finishes
 * reports nothing at all, which is worse than reporting that it could not look.
 */
const FETCH_TIMEOUT_MS = 20_000;

const DAY_MS = 86_400_000;

/** Ref this run compares against. Overridable so the self-test can pin one. */
const BRANCH = process.env.LOOM_DRIFT_BRANCH || 'HEAD';

// ── IO: the live estates ────────────────────────────────────────────────────

/**
 * Fetch one estate's /build-marker.txt and parse it.
 *
 * Returns `{ sha, stamp, error }`. `error` is non-null for EVERY way this can
 * fail to produce a sha, and each carries a distinct, true reason:
 *   - transport failure / timeout   "could not reach <url> — ..."
 *   - a non-200                     "could not read <url> — HTTP 503"
 *   - a 200 that is not a marker    the parser's reason (HTML page, no sha=, ...)
 *
 * `fetchImpl` is injectable so the self-test can drive every branch without a
 * network.
 */
export async function probeMarker(estate, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(estate.markerUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `no response within ${FETCH_TIMEOUT_MS}ms`
      : String(e?.message || e).slice(0, 160);
    // "could not reach", stated as what it is. NOT "the estate is stale" and
    // NOT "the estate is current" — this run established neither.
    return { sha: null, stamp: null, error: `could not reach ${estate.markerUrl} — ${why}` };
  }
  if (!res.ok) {
    return { sha: null, stamp: null, error: `could not read ${estate.markerUrl} — HTTP ${res.status}` };
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    return { sha: null, stamp: null, error: `could not read the body of ${estate.markerUrl} — ${String(e?.message || e).slice(0, 160)}` };
  }
  return parseBuildMarker(text);
}

/**
 * The version string an estate reports. DISPLAY METADATA ONLY.
 *
 * "0.90.2 against 0.98.11" is how a human sees the size of the gap; two opaque
 * hashes are not. But a version is a LABEL and the sha is the FACT, so this can
 * never move a verdict: its failure is recorded as a null version and nothing
 * else. Wiring it into the exit code would let a rate-limited or slow
 * /api/version turn a healthy estate red, which is how a useful signal becomes
 * one people mute.
 */
export async function probeVersion(estate, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(estate.versionUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { version: null, error: `HTTP ${res.status}` };
    const body = await res.json();
    const v = typeof body?.current === 'string' ? body.current : null;
    return v ? { version: v, error: null } : { version: null, error: 'no `current` field in /api/version' };
  } catch (e) {
    return { version: null, error: String(e?.message || e).slice(0, 120) };
  }
}

// ── IO: git ─────────────────────────────────────────────────────────────────

/**
 * Run git, returning stdout, or throwing an Error whose message carries git's
 * OWN stderr.
 *
 * Capturing stderr is the whole point. The alternative — `2>/dev/null` and an
 * inference from the exit code — is how "I could not reach the registry" became
 * "the tag does not exist" on 2026-08-05. If git says the abbreviation is
 * ambiguous, or that the object is missing, or that this is a shallow clone,
 * the operator gets to read that sentence rather than a guess about it.
 */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const stderr = String(e?.stderr || '').trim();
    throw new Error(stderr || String(e?.message || e));
  }
}

/**
 * Resolve a live sha against this checkout. PURE of policy — it measures, it
 * does not judge.
 *
 * Returns `{ ancestor, commitsBehind, ageDays, behindSince, behindForMinutes,
 * error }`. On ANY git failure it returns an `error` and leaves every number
 * null, so the caller cannot mistake "not measurable" for zero.
 *
 * Both cloud shapes reach here: a 40-hex Commercial sha and an 8-hex Gov one.
 * git resolves an abbreviation happily as long as it is present and unambiguous
 * — and when it is NOT (a shallow checkout, a collision), it says so on stderr
 * and that sentence is what gets reported. Verified against the live values:
 * `git rev-list --count 28de89fb..HEAD` = 251, matching the hand count in #3730.
 *
 * The sha reaching `execFileSync` has already passed GIT_OBJECT_ID in the
 * parser, and there is no shell, so nothing here interpolates marker bytes into
 * a command line.
 */
export function resolveAgainstGit(sha, branch = BRANCH, now = Date.now()) {
  const empty = {
    ancestor: undefined, commitsBehind: null, ageDays: null,
    behindSince: null, behindForMinutes: null, error: null,
  };
  let head;
  try {
    head = git(['rev-parse', branch]);
  } catch (e) {
    return { ...empty, error: `could not resolve ${branch} in this checkout — ${e.message}` };
  }
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
  } catch (e) {
    // Missing OR ambiguous OR shallow. UNKNOWN, never zero-behind.
    return { ...empty, error: `the commit ${sha} is not resolvable in this checkout — ${e.message}` };
  }

  let ancestor;
  try {
    git(['merge-base', '--is-ancestor', sha, head]);
    ancestor = true;
  } catch {
    // Exit 1 from --is-ancestor is a genuine ANSWER ("no"), not a malfunction,
    // which is why this one catch does not become an error: the estate is
    // running a build off a branch / revert / force-pushed history. Reporting a
    // commit distance between unrelated histories would be arithmetic on two
    // different timelines, so classifyEstate reports `divergent` and no number.
    ancestor = false;
  }

  let commitsBehind = null;
  let behindSince = null;
  let behindForMinutes = null;
  let ageDays = null;
  try {
    if (ancestor) {
      commitsBehind = Number(git(['rev-list', '--count', `${sha}..${head}`]));
      if (!Number.isFinite(commitsBehind)) {
        return { ...empty, ancestor, error: `git rev-list returned a non-numeric count for ${sha}..${branch}` };
      }
      if (commitsBehind > 0) {
        // The OLDEST unapplied commit — "how long has merged code been sitting
        // undeployed". Reduced rather than indexed so the answer does not depend
        // on git's output ordering.
        const oldest = git(['log', '--format=%cI', `${sha}..${head}`])
          // PHYSICAL-LINES-OK: splits `git log` OUTPUT, not a shell body.
          .split('\n')
          .map((s) => Date.parse(s.trim()))
          .reduce((min, t) => (Number.isFinite(t) && t < min ? t : min), Number.POSITIVE_INFINITY);
        if (Number.isFinite(oldest)) {
          behindSince = new Date(oldest).toISOString();
          behindForMinutes = Math.max(0, Math.round((now - oldest) / 60_000));
        }
        // A null behindForMinutes is left null on purpose: classifyEstate treats
        // an unmeasurable wait as stale, never as a fresh one.
      }
    }
    ageDays = Math.max(0, Math.round((now - Date.parse(git(['log', '-1', '--format=%cI', sha]))) / DAY_MS));
  } catch (e) {
    return { ...empty, ancestor, error: `could not measure the distance from ${sha} to ${branch} — ${e.message}` };
  }
  return { ancestor, commitsBehind, ageDays, behindSince, behindForMinutes, error: null };
}

// ── the verdict ─────────────────────────────────────────────────────────────

/**
 * The exit decision over classified estate rows. PURE.
 *
 * Any row that is not measurably current fails the lane. `stale` is set by
 * classifyEstate and is the union of "behind past its roll window", "divergent"
 * and "could not be measured" — one boolean, computed in one place, so a new
 * failure mode cannot be added and then forgotten to be wired into the exit
 * code. A verdict that is computed and then discarded is the "gate that cannot
 * fail" shape this repo has recorded repeatedly; here the returned code IS the
 * process exit code and nothing else decides it.
 *
 * The counts are split so the SUMMARY LINE can say which kind of problem it is:
 * "1 estate behind" and "1 estate unmeasurable" need different responses, and
 * collapsing them is the R7 error this check exists not to make.
 *
 * @param {{state:string, stale:boolean}[]} rows
 * @returns {{drifted:object[], unknown:object[], code:number}}
 */
export function decideCrossCloud(rows) {
  const bad = rows.filter((r) => r.stale);
  const unknown = bad.filter((r) => r.state === 'unknown');
  const drifted = bad.filter((r) => r.state !== 'unknown');
  return { drifted, unknown, code: bad.length ? 1 : 0 };
}

/** Build one classified row for one estate. Injectable IO for the self-test. */
export async function buildRow(estate, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const resolve = deps.resolveAgainstGit || resolveAgainstGit;
  const marker = await probeMarker(estate, fetchImpl);
  const version = await probeVersion(estate, fetchImpl);

  if (marker.error) {
    // Could not establish WHICH build is running. classifyEstate turns this into
    // state 'unknown' + stale, with the reason carried through verbatim.
    return {
      ...classifyEstate({ ...estate, error: marker.error }),
      id: estate.id,
      markerUrl: estate.markerUrl,
      buildStamp: null,
      version: version.version,
      versionError: version.error,
      rollHint: estate.rollHint,
    };
  }

  const g = resolve(marker.sha);
  const row = classifyEstate({
    ...estate,
    liveSha: marker.sha,
    // A git failure is passed as `error` so the row reports WHY it is unknown,
    // rather than reporting an unexplained null distance.
    error: g.error,
    ancestor: g.ancestor,
    commitsBehind: g.commitsBehind,
    ageDays: g.ageDays,
    behindSince: g.behindSince,
    behindForMinutes: g.behindForMinutes,
  });
  return {
    ...row,
    id: estate.id,
    markerUrl: estate.markerUrl,
    buildStamp: marker.stamp,
    version: version.version,
    versionError: version.error,
    rollHint: estate.rollHint,
  };
}

/** One line per estate, for both the ok and the fail report. */
function describeRow(r) {
  const verdict = !r.stale ? 'ok     ' : r.state === 'unknown' ? 'UNKNOWN' : 'DRIFT  ';
  const sha = (r.liveSha || '????????').slice(0, 8);
  const behind = r.commitsBehind === null || r.commitsBehind === undefined
    ? 'behind=?'
    : `behind=${r.commitsBehind}`;
  const ver = r.version ? `v${r.version}` : 'v?';
  const stamp = r.buildStamp || '?';
  return `  ${verdict}  ${r.name.padEnd(18)} ${sha}  ${behind.padEnd(12)} ${ver.padEnd(10)} built ${stamp}`;
}

async function main() {
  const rows = [];
  for (const estate of CLOUD_ESTATES) rows.push(await buildRow(estate));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  }

  // An override is announced BEFORE any verdict, always. A run whose answer came
  // from a fabricated endpoint must never be mistakable for a run that measured
  // production — that is the whole reason the override is allowed to exist.
  const overrides = describeOverrides();
  if (overrides.length) {
    console.log('[cross-cloud-drift] NON-PRODUCTION ENDPOINTS IN USE — this run did NOT measure the real estates:');
    for (const o of overrides) console.log(`  ${o.id} ${o.kind} URL <- ${o.env}=${o.url}`);
  }

  console.log('[cross-cloud-drift] live estates vs main:');
  for (const r of rows) console.log(describeRow(r));

  const { drifted, unknown, code } = decideCrossCloud(rows);

  if (code === 0) {
    console.log('[cross-cloud-drift] OK — every live estate was MEASURED and is running main');
    console.log('  (or is inside its documented roll-in-flight window). No estate was skipped.');
    return 0;
  }

  // The two problems are named separately, because they have different fixes.
  if (drifted.length) {
    console.error(`\n[cross-cloud-drift] FAIL — ${drifted.length} live estate(s) are NOT running main.\n`);
    for (const r of drifted) {
      console.error(`  ${r.name} [${r.state}] — ${r.detail}`);
      console.error(`    running: ${r.liveSha || 'unknown'}${r.version ? `  version ${r.version}` : ''}${r.buildStamp ? `  built ${r.buildStamp}` : ''}`);
      console.error(`    marker:  ${r.markerUrl}`);
      console.error(`    roll it: ${r.rollHint}\n`);
    }
  }
  if (unknown.length) {
    console.error(`\n[cross-cloud-drift] FAIL — ${unknown.length} live estate(s) could NOT BE MEASURED.\n`);
    for (const r of unknown) {
      console.error(`  ${r.name} — ${r.detail}`);
      console.error(`    marker:  ${r.markerUrl}`);
      console.error('    This is UNKNOWN, not "up to date" and not "behind". Nothing here established');
      console.error('    which build that estate is serving, so nothing here says it is healthy.\n');
    }
  }
  console.error('  deploy-integrity.md R3: drift between the live estate and main is a defect with');
  console.error('  an owner, not a background condition. A merged fix is not a deployed fix.\n');
  return code;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // SET THE CODE, DO NOT SLAM THE PROCESS.
  //
  // This was `main().then((c) => process.exit(c))`, copied from the sibling
  // check, and on Windows it CRASHED instead of exiting: the HTML-error-page
  // case in the self-test produced exit 3221226505 (0xC0000409) and
  //
  //     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
  //     file src\win\async.c, line 94
  //
  // — an abrupt process.exit() racing undici's still-closing keep-alive
  // sockets. The verdict had already printed correctly, so this was invisible
  // to the eye and visible only to an assertion on the exit CODE.
  //
  // It matters beyond tidiness. This lane's entire contract is that its exit
  // status is a truthful verdict; a status that is sometimes 1 and sometimes a
  // Windows crash code is not one, and a crash that happened a few lines EARLIER
  // would have produced a non-zero exit with no report at all — a failure the
  // operator could not act on. Assigning `process.exitCode` lets the loop drain
  // and the real code stand. Node exits as soon as the sockets release.
  main().then(
    (c) => { process.exitCode = c; },
    (e) => {
      // A crash in the alarm is NOT a clean estate. Say so, loudly, and fail.
      console.error(`[cross-cloud-drift] the check itself failed — ${e?.stack || e}`);
      console.error('  This is UNKNOWN for every estate: nothing was established about either cloud.');
      process.exitCode = 1;
    },
  );
}
