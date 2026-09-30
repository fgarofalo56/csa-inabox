#!/usr/bin/env node
/**
 * GUARDRAIL: runner-version-pin (RVP0)
 * ---------------------------------------------------------------------------
 * RULE: the GitHub Actions runner agent baked into the in-VNet self-hosted
 *   runner image (platform/runners/github-actions/Dockerfile, ARG
 *   RUNNER_VERSION) must never age past the point where GitHub refuses to
 *   register it or to queue jobs to it.
 *
 * WHY (measured 2026-09-29). The image pinned RUNNER_VERSION=2.328.0 -- a
 *   release published 2025-08-13. From ~19:04Z on 2026-09-29 every execution of
 *   the `gh-aca-runner` Container Apps Job died at registration with a 404 from
 *   POST https://api.github.com/actions/runner-registration: "The minimum
 *   runner version required to register with GitHub Actions is now 2.329.0".
 *   Every `[self-hosted, loom-aca]` workflow queued with nothing to run it. The
 *   pin had been superseded for 350 days and nothing anywhere said so.
 *
 * WHY THE PIN IS THE VERSION THAT MATTERS. The image does NOT disable the
 *   runner's self-update (entrypoint.sh runs config.sh without
 *   --disableupdate). It does not need to for the pin to be fatal: every
 *   execution is a fresh ephemeral replica that starts from the pinned binary,
 *   and REGISTRATION (config.sh) happens before any self-update could run. So a
 *   pin below GitHub's minimum can never register, however willing the runner
 *   would have been to update afterwards. A pin with no alarm is a dead fleet on
 *   a timer.
 *
 * WHAT GITHUB PUBLISHES. Two things, and this guard reads both:
 *
 *   1. A MACHINE-READABLE SCHEDULE. GET /repos/{owner}/{repo}/actions/runners/
 *      deprecations/{version} ("Get runner version end-of-life schedule for a
 *      repository", docs.github.com/rest/actions/self-hosted-runners) returns
 *      `runtime_deprecates_at` and `registration_deprecates_at` for a runner
 *      version. Measured 2026-09-29
 *      with X-GitHub-Api-Version 2026-03-10: 2.328.0 ->
 *      runtime_deprecates_at 2025-12-16T17:40:26Z; 2.337.0 -> null;
 *      9.9.9 (never released) -> HTTP 404. `registration_deprecates_at` was
 *      absent from both 200 responses; this guard treats absent as null and
 *      does not claim to know when GitHub fills it in.
 *
 *      WHO MAY READ IT. The docs list the repository endpoint under the
 *      "Administration" repository permission (read), and say authenticated
 *      users need admin access to the repository. A workflow's GITHUB_TOKEN
 *      cannot be granted `administration` at all: actionlint rejects it as an
 *      unknown permission scope, and the scopes it lists are the complete set a
 *      workflow token can hold. Unauthenticated, the endpoint answers 401. So
 *      in the daily workflow this read is expected to be refused, and the
 *      verdict then falls back to (2), LABELLED "heuristic" in every line it
 *      prints and in the failure record. The read is still attempted on every
 *      run, so the day a token with Administration: read is supplied, the
 *      verdict becomes authoritative with no code change.
 *
 *   2. A POLICY. The self-hosted runner docs
 *      (content/actions/reference/runners/self-hosted-runners.md, read
 *      2026-09-29) say: "If you do not perform a software update within 30
 *      days, the GitHub Actions service will not queue jobs to your runner",
 *      and count every major, minor or patch release as an available update.
 *      The release-age heuristic below measures exactly that 30-day clock from
 *      the releases list, which any token (or none) can read.
 *
 *   The 350-day lag in the 2026-09-29 outage was NOT a margin GitHub's policy
 *   grants: the documented window is 30 days. Against GitHub's own runtime date
 *   for 2.328.0 (2025-12-16, about 63 days after 2.329.0 shipped on
 *   2025-10-14), a 60-day alarm would have filed its first issue about 27
 *   hours before that deadline. So the fail threshold is the documented 30
 *   days, not 60.
 *
 *   OFFLINE (hermetic; runs on every PR in loom-guardrails):
 *     1. exactly one `ARG RUNNER_VERSION=<x.y.z>` and one
 *        `ARG RUNNER_SHA256=<64 hex>` in the Dockerfile;
 *     2. the pin is >= KNOWN_FLOOR, the minimum GitHub last REPORTED to us
 *        (2.329.0, from the 2026-09-29 refusal). This can only ratchet up by
 *        hand, so it is a regression floor, not the recurrence alarm;
 *     3. scripts/csa-loom/provision-gh-runner.sh sets no literal RUNNER_VERSION
 *        that disagrees with the Dockerfile. It carried `2.328.0` and passed it
 *        as a --build-arg, which would have overridden a bumped Dockerfile
 *        default while the Dockerfile's SHA256 stayed the new one -- a checksum
 *        mismatch on the very rebuild that fixes the outage. The scan SEES:
 *        `${RUNNER_VERSION:-X}`, `${RUNNER_VERSION:=X}` (and the colon-less
 *        `-`/`=` forms), a plain or exported `RUNNER_VERSION=X`, and a
 *        hard-coded `--build-arg RUNNER_VERSION=X` / `"RUNNER_VERSION=X"`. It
 *        does NOT see: a value that arrives through ANOTHER variable
 *        (`V=2.328.0; RUNNER_VERSION=$V` -- anything containing `$` is treated
 *        as a reference, not a literal), a value set in a sourced file or by
 *        the caller's environment, a commented-out line, a value inside a
 *        heredoc or a quoted string that spans a backslash seam (the stated
 *        limits of scripts/ci/_logical-lines.mjs), or a seam INSIDE the name
 *        (`RUNNER_VER\` + `SION=X`). It OVER-reports one shape: a continuation
 *        whose next line starts with `#` (`cmd \` + `# RUNNER_VERSION=X`) is a
 *        comment to bash but reads as a setter here. That fails closed -- the
 *        offline check errors and names the line -- rather than hiding a pin.
 *
 *        BOTH FILES ARE READ BY LOGICAL LINE (scripts/ci/_logical-lines.mjs),
 *        so a backslash continuation cannot hide a setter on the next physical
 *        line: `--build-arg \` + `RUNNER_VERSION=2.328.0` is one command, and
 *        so is `ARG \` + `RUNNER_VERSION=2.337.0`. ONE seam needs more than
 *        that: bash DELETES a backslash-newline, while readLogicalLines joins
 *        with a space, so `RUNNER_VERSION=\` + `2.328.0` would read as an EMPTY
 *        value. The script scan therefore splices a seam that sits directly
 *        after `RUNNER_VERSION=` or `${RUNNER_VERSION:-` (and the `:=`, `-`,
 *        `=` forms) the way bash does -- keeping the next line's indentation,
 *        so an indented continuation still reads empty, which is also what
 *        bash sets -- and never on a comment line. The Dockerfile gets no such
 *        splice: a split `ARG RUNNER_VERSION=\` value reads as ZERO ARG pins,
 *        which is an error, so that shape fails closed rather than passing.
 *
 *   ONLINE (`--online`; runs DAILY in .github/workflows/runner-version-pin.yml
 *   on ubuntu-latest, which files/updates one tracking issue on failure):
 *     4. HEURISTIC: reads the actions/runner releases and measures how long the
 *        pin has been SUPERSEDED -- the age of the OLDEST published release
 *        newer than the pin, which is when GitHub's 30-day clock started. WARN
 *        past WARN_DAYS (14), a notice only; FAIL past FAIL_DAYS (30), the
 *        documented window.
 *     5. AUTHORITATIVE, when readable: reads GitHub's deprecation schedule for
 *        the pin. FAIL when `runtime_deprecates_at` or
 *        `registration_deprecates_at` is already past, or less than
 *        DEPRECATION_WINDOW_DAYS (30) away; WARN when one is scheduled further
 *        out. Both signals are evaluated and EITHER one failing fails the run,
 *        so the heuristic stays a second signal even when the API answers.
 *     `--failure-json <path>` writes a classified failure record for
 *     .github/scripts/deploy-notify-failure.mjs when the verdict is a failure.
 *
 * WHY TIME AND NOT "N MINOR VERSIONS BEHIND". Enforcement is keyed to TIME
 *   ("within 30 days of its publication"), not to a version count, and release
 *   cadence is uneven (measured over v2.328.0..v2.337.0: 21 to 62 days between
 *   minor releases, and patch releases -- which also start the clock -- land in
 *   between), so a version count would fire at wildly different ages. The
 *   heuristic fails at the documented window itself, which leaves no margin
 *   before the documented breach; the API date is the signal with lead time,
 *   and the heuristic's 14-day warning is a notice only. GitHub can also refuse
 *   a runner at once for a critical security update; no pre-check can see that,
 *   and this guard says so rather than implying it can.
 *
 * WHY THE AGE CHECK IS NOT A REQUIRED PR CHECK. It is a function of the
 *   CALENDAR, not of the diff: on day 31 it would red every open PR at once,
 *   including ones that never touched the runner. It gets its OWN daily
 *   workflow instead -- not a step in an existing one, because a red step in a
 *   workflow that is already red every day changes nothing anyone watches
 *   (deploy-staleness.yml was 56/56 failure when this was first placed there).
 *   It runs on a GitHub-hosted runner, the only place it may run: the
 *   self-hosted runner is the thing that is down when this alarm matters.
 *
 * FAILS CLOSED. An unreadable or refused releases API, an empty release list, a
 *   pin newer than every release, or a pin that is not a published release (its
 *   tarball would 404 at build time) is a FAILURE with the reason stated --
 *   never a pass and never "up to date". An unreadable DEPRECATIONS API is not a
 *   pass either: it is a heuristic verdict, and every line says so.
 *
 * EACH FAILURE SAYS WHAT IT IS (deploy-integrity.md R7). `--failure-json`
 *   writes one record per failed run, built from FAILURE_KINDS below. Every
 *   class is one that exists in apps/fiab-console/lib/deploy/failure-taxonomy.json:
 *
 *     kind                          class       when
 *     releases-unreadable           transient   the API could not be read:
 *                                               network error, timeout, 5xx,
 *                                               a rate-limit 429/403 after every
 *                                               attempt, a body that is not JSON
 *     releases-forbidden            permission  a 401, or a 403 that is NOT a
 *                                               rate limit: the token is not
 *                                               allowed; one attempt
 *     releases-rejected             config      any other 4xx (404, 422, ...):
 *                                               retrying cannot change it
 *     releases-unusable             transient   the API answered 200, but the
 *                                               payload was not a list or held
 *                                               no stable release
 *     pin-not-released              defect      the pin is newer than every
 *                                               release, or never published
 *     pin-deprecation-scheduled     defect      GitHub's schedule ends the pin
 *                                               within 30 days, or already did
 *     pin-superseded                defect      superseded past FAIL_DAYS (the
 *                                               heuristic alarm)
 *     dockerfile-pin-invalid        defect      offline: the ARG pair is
 *                                               missing, duplicated or malformed,
 *                                               or the pin is below KNOWN_FLOOR
 *     provision-default-disagrees   defect      offline: the provision script
 *                                               sets a literal RUNNER_VERSION
 *                                               the Dockerfile does not pin
 *
 *   Only pin-deprecation-scheduled and pin-superseded say the pin must be
 *   bumped. A payload GitHub mangled is not a stale pin, and a script/Dockerfile
 *   disagreement is not one either. The releases-* kinds say the pin's age was
 *   NOT established, in their whyStopped.
 *
 * RETRIES, RATE LIMITS AND TIMEOUT. A read is attempted up to FETCH_ATTEMPTS (3)
 *   times, and the failure record's `attempts` list has one entry per attempt
 *   actually made. Retried: network errors, a per-attempt timeout, 5xx, a 429,
 *   and a 403 that GitHub marks as a rate limit (`x-ratelimit-remaining: 0` or a
 *   `retry-after` header). Before a retry the checker waits what GitHub asked
 *   for -- `retry-after` (seconds or an HTTP date), else `x-ratelimit-reset` --
 *   capped at RETRY_WAIT_CAP_MS (60 s); with neither header it backs off 2 s,
 *   then 4 s. NOT retried: a 401 or a non-rate-limit 403 (permission), and every
 *   other 4xx (deterministic). Each attempt is bounded by FETCH_TIMEOUT_MS (30 s)
 *   through an AbortSignal; without it Node's fetch waits about 300 s for
 *   headers, three such waits overrun the job's `timeout-minutes: 10`, the job
 *   ends CANCELLED, `failure()` is false, and a black-holed API files nothing.
 *   Worst case for the two reads together is worstCaseFetchMs(): 2 x (3 x 30 s +
 *   2 x 60 s) = 420 s, inside the 600 s job limit; the self-test holds the
 *   workflow's timeout-minutes to that.
 *
 * Self-test: scripts/ci/__tests__/check-runner-version-pin.test.mjs
 * Run:       node scripts/ci/check-runner-version-pin.mjs [--online]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLogicalLines } from './_logical-lines.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const DOCKERFILE_REL = 'platform/runners/github-actions/Dockerfile';
export const PROVISION_REL = 'scripts/csa-loom/provision-gh-runner.sh';
/** Minimum GitHub reported in its 2026-09-29 registration refusal. Ratchet only. */
export const KNOWN_FLOOR = '2.329.0';
/** Heuristic notice. Files nothing; the failure at FAIL_DAYS is what files. */
export const WARN_DAYS = 14;
/** GitHub's documented window: install each new release within 30 days of its publication. */
export const FAIL_DAYS = 30;
/** Fail when GitHub's scheduled deprecation of the pin is this close, or past. */
export const DEPRECATION_WINDOW_DAYS = 30;
export const RELEASES_URL = 'https://api.github.com/repos/actions/runner/releases?per_page=100';
/** The repo whose deprecations endpoint is read when GITHUB_REPOSITORY is unset. */
export const DEFAULT_REPO = 'fgarofalo56/csa-inabox';
/** The API version the deprecations endpoint was measured with (2026-09-29). */
export const DEPRECATIONS_API_VERSION = '2026-03-10';
export const FETCH_ATTEMPTS = 3;
export const FETCH_TIMEOUT_MS = 30_000;
/** Longest wait honoured from retry-after / x-ratelimit-reset before a retry. */
export const RETRY_WAIT_CAP_MS = 60_000;

const DAY_MS = 86_400_000;

export const deprecationsUrl = (repo, version) =>
  `https://api.github.com/repos/${repo}/actions/runners/deprecations/${encodeURIComponent(version)}`;

/**
 * The longest the two online reads can take together: each read makes up to
 * FETCH_ATTEMPTS attempts of FETCH_TIMEOUT_MS, with at most RETRY_WAIT_CAP_MS
 * between attempts (the 2 s / 4 s backoff is below the cap).
 */
export function worstCaseFetchMs() {
  return 2 * (FETCH_ATTEMPTS * FETCH_TIMEOUT_MS + (FETCH_ATTEMPTS - 1) * RETRY_WAIT_CAP_MS);
}

/** Strict x.y.z parse. Returns [major, minor, patch] or null. */
export function parseSemver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0 when a<b, 0 when equal, >0 when a>b. Both must parse. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`compareSemver: unparseable version '${a}' or '${b}'`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Pull the RUNNER_VERSION / RUNNER_SHA256 ARG defaults out of the Dockerfile.
 * Only real `ARG` instructions count -- a comment that mentions a version is
 * not a pin. Read by LOGICAL line, so `ARG \` + `RUNNER_VERSION=x` is seen.
 */
export function readPin(dockerfileText) {
  const errors = [];
  const versions = [];
  const shas = [];
  for (const { text } of readLogicalLines(dockerfileText)) {
    const v = /^\s*ARG\s+RUNNER_VERSION=(\S*)\s*$/.exec(text);
    if (v) versions.push(v[1]);
    const s = /^\s*ARG\s+RUNNER_SHA256=(\S*)\s*$/.exec(text);
    if (s) shas.push(s[1]);
  }
  if (versions.length !== 1) {
    errors.push(`expected exactly one 'ARG RUNNER_VERSION=<x.y.z>' in ${DOCKERFILE_REL}, found ${versions.length}`);
  }
  if (shas.length !== 1) {
    errors.push(`expected exactly one 'ARG RUNNER_SHA256=<hex>' in ${DOCKERFILE_REL}, found ${shas.length}`);
  }
  const version = versions.length === 1 ? versions[0] : null;
  const sha256 = shas.length === 1 ? shas[0] : null;
  if (version !== null && !parseSemver(version)) {
    errors.push(`RUNNER_VERSION '${version}' is not a plain x.y.z version`);
  }
  if (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) {
    errors.push(`RUNNER_SHA256 '${sha256}' is not 64 lowercase hex characters`);
  }
  return { version, sha256, errors };
}

/**
 * A backslash-newline directly after `RUNNER_VERSION=` / `${RUNNER_VERSION:-`
 * (or `:=`, `-`, `=`) on a line that is not a comment. Group 1 is everything
 * before the backslash; replacing the match with it deletes the seam as bash does.
 */
export const SPLIT_TOKEN_SEAM = /^(?![ \t]*#)(.*RUNNER_VERSION:?[-=])\\\r?\n/gm;

/**
 * Every LITERAL RUNNER_VERSION a shell script sets. Two shapes:
 *   - parameter-expansion defaults: `${RUNNER_VERSION:-X}`, `${RUNNER_VERSION:=X}`,
 *     and the colon-less `${RUNNER_VERSION-X}` / `${RUNNER_VERSION=X}`;
 *   - assignments: `RUNNER_VERSION=X`, `export RUNNER_VERSION=X`, and a
 *     hard-coded `--build-arg RUNNER_VERSION=X` / `"RUNNER_VERSION=X"`.
 * A value containing `$` is a REFERENCE (e.g. the script's own
 * `"RUNNER_VERSION=${RUNNER_VERSION}"` pass-through), not a literal, and is
 * skipped; so are empty values and commented lines. See the header for what
 * this cannot see, and for why one seam is spliced before the logical read.
 */
export function scriptVersionDefaults(scriptText) {
  const out = [];
  const expansion = /\$\{RUNNER_VERSION:?[-=]([^}]*)\}/g;
  const assignment = /(?<![A-Za-z0-9_${])RUNNER_VERSION=([^\s;&|)]*)/g;
  // bash deletes a backslash-newline outright. Do that for the one seam that
  // splits the token this scan reads, and only on a line that is not a comment:
  // a comment's trailing backslash does not continue, and splicing it would
  // swallow the next line into the comment (the exploit _logical-lines.mjs
  // documents). The next line's indentation is kept, as bash keeps it.
  const spliced = String(scriptText).replace(SPLIT_TOKEN_SEAM, '$1');
  for (const { text: line } of readLogicalLines(spliced)) {
    if (/^\s*#/.test(line)) continue;
    let m;
    while ((m = expansion.exec(line)) !== null) {
      if (m[1] !== '') out.push(m[1]);
    }
    while ((m = assignment.exec(line)) !== null) {
      const value = m[1].replace(/^["']+|["']+$/g, '');
      if (value !== '' && !value.includes('$')) out.push(value);
    }
  }
  return out;
}

/**
 * The hermetic half. No network, no clock. `errors` is the flat message list;
 * `problems` carries the same messages with their FAILURE_KINDS kind, so a
 * failure record can say which of the two offline faults it was.
 */
export function checkOffline({ dockerfileText, scriptText, floor = KNOWN_FLOOR }) {
  const pin = readPin(dockerfileText);
  const problems = pin.errors.map((message) => ({ kind: 'dockerfile-pin-invalid', message }));
  if (pin.version && parseSemver(pin.version) && compareSemver(pin.version, floor) < 0) {
    problems.push({
      kind: 'dockerfile-pin-invalid',
      message:
        `RUNNER_VERSION ${pin.version} is below ${floor}, the minimum GitHub last reported it will register ` +
        `(2026-09-29 refusal). A runner built from this image cannot register.`,
    });
  }
  for (const d of scriptVersionDefaults(scriptText ?? '')) {
    if (d !== pin.version) {
      problems.push({
        kind: 'provision-default-disagrees',
        message:
          `${PROVISION_REL} sets RUNNER_VERSION to '${d}' but ${DOCKERFILE_REL} pins '${pin.version}'. ` +
          `The script passes it as a --build-arg, so it overrides the Dockerfile while the Dockerfile's ` +
          `RUNNER_SHA256 stays -- the build fails its checksum. Drop the script default; the Dockerfile owns the pin.`,
      });
    }
  }
  return { pin, problems, errors: problems.map((p) => p.message) };
}

/**
 * The HEURISTIC calendar half. `releases` is the GitHub releases API payload.
 * Returns { verdict: 'ok'|'warn'|'fail', message, latest, supersededBy, ageDays },
 * and on 'fail' a `kind` from FAILURE_KINDS naming WHICH failure it is.
 */
export function evaluateAge({ pin, releases, now, warnDays = WARN_DAYS, failDays = FAIL_DAYS }) {
  if (!parseSemver(pin)) {
    return { verdict: 'fail', kind: 'pin-not-released', message: `cannot evaluate age: pin '${pin}' is not x.y.z` };
  }
  if (!Array.isArray(releases)) {
    return {
      verdict: 'fail',
      kind: 'releases-unusable',
      message: `cannot evaluate age: the releases payload is not a list (got ${releases === null ? 'null' : typeof releases}) -- nothing was established`,
    };
  }
  const stable = releases
    .filter((r) => r && !r.draft && !r.prerelease && parseSemver(r.tag_name) && r.published_at)
    .map((r) => ({ version: r.tag_name.replace(/^v/, ''), publishedMs: Date.parse(r.published_at) }))
    .filter((r) => Number.isFinite(r.publishedMs));
  if (stable.length === 0) {
    return {
      verdict: 'fail',
      kind: 'releases-unusable',
      message: 'cannot evaluate age: the releases API returned no stable releases -- nothing was established',
    };
  }
  stable.sort((a, b) => compareSemver(b.version, a.version));
  const latest = stable[0];
  const oldest = stable[stable.length - 1];
  if (compareSemver(pin, latest.version) > 0) {
    return {
      verdict: 'fail',
      kind: 'pin-not-released',
      latest: latest.version,
      message: `pin ${pin} is NEWER than the latest published release ${latest.version} -- not a real release; the tarball download would 404`,
    };
  }
  const found = stable.some((r) => compareSemver(r.version, pin) === 0);
  if (!found && compareSemver(pin, oldest.version) > 0) {
    return {
      verdict: 'fail',
      kind: 'pin-not-released',
      latest: latest.version,
      message: `pin ${pin} is not a published actions/runner release (checked ${stable.length} releases, ${oldest.version}..${latest.version}); the tarball download would 404`,
    };
  }
  const newer = stable.filter((r) => compareSemver(r.version, pin) > 0);
  if (newer.length === 0) {
    return { verdict: 'ok', latest: latest.version, ageDays: 0, message: `pin ${pin} is the latest release` };
  }
  const first = newer.reduce((a, b) => (b.publishedMs < a.publishedMs ? b : a));
  const ageDays = Math.floor((now - first.publishedMs) / DAY_MS);
  const base =
    `pin ${pin} has been superseded for ${ageDays} day(s): ${first.version} was published ` +
    `${new Date(first.publishedMs).toISOString().slice(0, 10)}; latest is ${latest.version}`;
  if (ageDays > failDays) {
    return {
      verdict: 'fail',
      kind: 'pin-superseded',
      latest: latest.version,
      supersededBy: first.version,
      ageDays,
      message: `${base}. Past ${failDays} days: GitHub's documented rule is to install each new runner release within 30 days of its publication, and it may stop queuing jobs to this runner -- bump RUNNER_VERSION + RUNNER_SHA256 in ${DOCKERFILE_REL} and rebuild the runner image.`,
    };
  }
  if (ageDays > warnDays) {
    return {
      verdict: 'warn',
      latest: latest.version,
      supersededBy: first.version,
      ageDays,
      message: `${base}. Past ${warnDays} days; this check FAILS after ${failDays} days, GitHub's documented update window.`,
    };
  }
  return {
    verdict: 'ok',
    latest: latest.version,
    supersededBy: first.version,
    ageDays,
    message: `${base}. Within ${warnDays} days.`,
  };
}

/**
 * The AUTHORITATIVE half: GitHub's own deprecation schedule for the pin, as
 * returned by the deprecations endpoint. `schedule` is the parsed 200 body.
 * Returns { verdict: 'ok'|'warn'|'fail'|'unusable', message, kind? }. 'unusable'
 * means the body did not say anything this code can trust, so the caller falls
 * back to the heuristic -- it is never read as a pass.
 */
export function evaluateDeprecation({ pin, schedule, now, windowDays = DEPRECATION_WINDOW_DAYS }) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return { verdict: 'unusable', message: `the deprecations API answered 200 with a body that is not an object` };
  }
  if (schedule.runner_version !== pin) {
    return {
      verdict: 'unusable',
      message: `the deprecations API answered for runner_version '${schedule.runner_version}', not the pin '${pin}'`,
    };
  }
  const dates = [];
  for (const field of ['registration_deprecates_at', 'runtime_deprecates_at']) {
    const raw = schedule[field];
    if (raw === null || raw === undefined) continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) {
      return { verdict: 'unusable', message: `the deprecations API gave ${field}='${raw}', which is not a date` };
    }
    dates.push({ field, ms, iso: new Date(ms).toISOString() });
  }
  if (dates.length === 0) {
    return { verdict: 'ok', message: `GitHub schedules no deprecation for ${pin}` };
  }
  dates.sort((a, b) => a.ms - b.ms);
  const soonest = dates[0];
  const msLeft = soonest.ms - now;
  const all = dates.map((d) => `${d.field} ${d.iso}`).join(', ');
  if (msLeft <= 0) {
    return {
      verdict: 'fail',
      kind: 'pin-deprecation-scheduled',
      message: `GitHub's deprecation schedule for ${pin} is already PAST (${all}): ${soonest.field} was ${Math.floor(-msLeft / DAY_MS)} day(s) ago. Bump RUNNER_VERSION + RUNNER_SHA256 in ${DOCKERFILE_REL} and rebuild the runner image.`,
    };
  }
  if (msLeft <= windowDays * DAY_MS) {
    return {
      verdict: 'fail',
      kind: 'pin-deprecation-scheduled',
      message: `GitHub deprecates ${pin} soon (${all}): ${soonest.field} is ${Math.floor(msLeft / DAY_MS)} day(s) away, within ${windowDays}. Bump RUNNER_VERSION + RUNNER_SHA256 in ${DOCKERFILE_REL} and rebuild the runner image.`,
    };
  }
  return {
    verdict: 'warn',
    message: `GitHub has scheduled a deprecation for ${pin} (${all}), ${Math.floor(msLeft / DAY_MS)} day(s) away; this check FAILS inside ${windowDays} days.`,
  };
}

/** A 429 is always a rate limit. A 403 is one only when GitHub marks it so. */
export function isRateLimited(res) {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const h = (name) => res.headers?.get?.(name) ?? null;
  return h('x-ratelimit-remaining') === '0' || h('retry-after') !== null;
}

/**
 * How long GitHub asked us to wait, in ms, capped at `capMs`; null if it did
 * not say. `retry-after` may be seconds or an HTTP date; `x-ratelimit-reset`
 * is epoch seconds and only counts when the remaining quota is 0.
 */
export function requestedWaitMs(res, nowMs, capMs = RETRY_WAIT_CAP_MS) {
  const h = (name) => res.headers?.get?.(name) ?? null;
  let ms = null;
  const ra = h('retry-after');
  if (ra !== null) {
    if (/^\d+$/.test(ra.trim())) ms = Number(ra.trim()) * 1000;
    else if (Number.isFinite(Date.parse(ra))) ms = Date.parse(ra) - nowMs;
  }
  if (ms === null && h('x-ratelimit-remaining') === '0') {
    const reset = h('x-ratelimit-reset');
    if (reset !== null && /^\d+$/.test(reset.trim())) ms = Number(reset.trim()) * 1000 - nowMs;
  }
  if (ms === null) return null;
  return Math.min(Math.max(ms, 0), capMs);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One bounded, classified GET. Resolves to the parsed JSON on 200. Throws an
 * Error carrying:
 *   attempts        -- reads actually made;
 *   status          -- the last HTTP status, if any;
 *   forbiddenStatus -- set for a 401 or a non-rate-limit 403 (permission; not retried);
 *   rejectedStatus  -- set for any other non-retried 4xx (deterministic).
 */
export async function fetchJsonWithRetry({
  url,
  label,
  headers,
  attempts = FETCH_ATTEMPTS,
  fetchImpl = globalThis.fetch,
  backoffMs = 2000,
  timeoutMs = FETCH_TIMEOUT_MS,
  retryWaitCapMs = RETRY_WAIT_CAP_MS,
  sleep = defaultSleep,
  clock = () => Date.now(),
  meta = {},
}) {
  let lastErr = null;
  let made = 0;
  let status = null;
  let forbiddenStatus = null;
  let rejectedStatus = null;
  for (let i = 1; i <= attempts; i += 1) {
    made = i;
    // `meta.attempts` reports the count on SUCCESS too, so a record built from
    // a 200 that came after a 429 says 2, not 1.
    meta.attempts = made;
    let waitMs = null;
    try {
      // One signal per attempt, covering the headers AND the body read: a
      // black-holed API must end this attempt, not the job (header, RETRIES...).
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status} from ${url}`);
      if (res.status < 500 && !isRateLimited(res)) {
        // A 401, or a 403 GitHub did not mark as a rate limit, is the token
        // not being allowed: a permission fault, and a re-run cannot change it.
        if (res.status === 401 || res.status === 403) forbiddenStatus = res.status;
        else rejectedStatus = res.status;
        break;
      }
      waitMs = requestedWaitMs(res, clock(), retryWaitCapMs);
    } catch (e) {
      lastErr =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? new Error(`no response within ${timeoutMs} ms (${e.name})`)
          : e;
    }
    if (i < attempts) await sleep(waitMs ?? backoffMs * i);
  }
  const err = new Error(`could not read the ${label} after ${made} attempt(s): ${lastErr?.message ?? lastErr}`);
  err.attempts = made;
  err.status = status;
  err.forbiddenStatus = forbiddenStatus;
  err.rejectedStatus = rejectedStatus;
  throw err;
}

const baseHeaders = (token) => {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'csa-loom-runner-version-pin' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

export async function fetchReleases({
  attempts = FETCH_ATTEMPTS,
  fetchImpl = globalThis.fetch,
  backoffMs = 2000,
  timeoutMs = FETCH_TIMEOUT_MS,
  sleep = defaultSleep,
  clock = () => Date.now(),
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  meta = {},
} = {}) {
  return fetchJsonWithRetry({
    url: RELEASES_URL,
    label: 'actions/runner releases API',
    headers: baseHeaders(token),
    attempts,
    fetchImpl,
    backoffMs,
    timeoutMs,
    sleep,
    clock,
    meta,
  });
}

/**
 * Read GitHub's deprecation schedule for `version`. Never throws: returns
 * { source: 'api', schedule } on a 200, or { source: 'unavailable', reason }
 * saying exactly why it was not read, so the verdict can be labelled heuristic.
 */
export async function readDeprecation({
  version,
  repo,
  token,
  fetchImpl = globalThis.fetch,
  backoffMs = 2000,
  timeoutMs = FETCH_TIMEOUT_MS,
  sleep = defaultSleep,
  clock = () => Date.now(),
}) {
  if (!token) {
    return {
      source: 'unavailable',
      reason: 'no token in GITHUB_TOKEN or GH_TOKEN, and the deprecations endpoint requires authentication',
    };
  }
  const url = deprecationsUrl(repo, version);
  try {
    const schedule = await fetchJsonWithRetry({
      url,
      label: 'runner deprecations API',
      headers: { ...baseHeaders(token), 'X-GitHub-Api-Version': DEPRECATIONS_API_VERSION },
      fetchImpl,
      backoffMs,
      timeoutMs,
      sleep,
      clock,
    });
    return { source: 'api', schedule };
  } catch (e) {
    if (e.forbiddenStatus) {
      return {
        source: 'unavailable',
        status: e.forbiddenStatus,
        reason:
          `the token was refused (HTTP ${e.forbiddenStatus}); GitHub documents this endpoint under the ` +
          `"Administration" repository permission (read), which a workflow GITHUB_TOKEN cannot be granted`,
      };
    }
    if (e.rejectedStatus === 404) {
      return {
        source: 'unavailable',
        status: 404,
        reason: `GitHub has no deprecation schedule for ${version} (HTTP 404; it answers 404 for a version it does not know)`,
      };
    }
    return { source: 'unavailable', status: e.rejectedStatus ?? e.status ?? null, reason: e.message };
  }
}

const BUMP_REMEDIATION =
  `Bump ARG RUNNER_VERSION and ARG RUNNER_SHA256 in ${DOCKERFILE_REL} to the latest actions/runner release ` +
  '(linux-x64 hash from the release asset digest), build the image under a NEW tag, and point the ' +
  'gh-aca-runner Container Apps Job at it. See docs/fiab/github-actions-runner.md.';

/**
 * One row per failure this checker can report. The header table is the prose
 * form of this object. Every `class` is a key of failure-taxonomy.json#classes
 * and every `remediationKind` a key of #remediationKinds; the self-test reads
 * that file and holds both to it.
 */
export const FAILURE_KINDS = Object.freeze({
  'releases-unreadable': {
    class: 'transient',
    retryable: true,
    whyStopped: 'the actions/runner releases API could not be read after bounded retries; the pin age was NOT established',
    remediationKind: 'operator-action',
    remediation:
      'Nothing is known about the pin from this run. Re-run the runner-version-pin workflow; if the API ' +
      'stays unreadable, check githubstatus.com.',
  },
  'releases-forbidden': {
    class: 'permission',
    retryable: false,
    whyStopped:
      'the actions/runner releases API refused the token (a 401, or a 403 that is not a rate limit); the pin age was NOT established',
    remediationKind: 'operator-action',
    remediation:
      `Nothing is known about the pin from this run. ${RELEASES_URL} is public, so a refusal means the token sent ` +
      'is invalid or blocked by a policy (SSO, IP allow list). Check the token the workflow passes as GITHUB_TOKEN, then re-run.',
  },
  'releases-rejected': {
    class: 'config',
    retryable: false,
    whyStopped:
      'the actions/runner releases API refused the read with a 4xx that retrying cannot change; the pin age was NOT established',
    remediationKind: 'operator-action',
    remediation:
      `Nothing is known about the pin from this run. Read ${RELEASES_URL} by hand: a 404 means the URL is wrong. ` +
      'Fix RELEASES_URL, then re-run.',
  },
  'releases-unusable': {
    class: 'transient',
    retryable: true,
    whyStopped:
      'the actions/runner releases API answered, but not with a usable release list; the pin age was NOT established',
    remediationKind: 'operator-action',
    remediation:
      'Nothing is known about the pin from this run. Re-run the runner-version-pin workflow. If the payload ' +
      `stays unusable, read ${RELEASES_URL} by hand -- the API shape may have changed, and this checker then needs a fix.`,
  },
  'pin-not-released': {
    class: 'defect',
    retryable: false,
    whyStopped: 'the pinned actions/runner version is not a published release, so the image build cannot download it',
    remediationKind: 'operator-action',
    remediation:
      `Set ARG RUNNER_VERSION in ${DOCKERFILE_REL} to a published actions/runner release, and ARG RUNNER_SHA256 ` +
      'to that release\'s linux-x64 asset digest.',
  },
  'pin-deprecation-scheduled': {
    class: 'defect',
    retryable: false,
    whyStopped: `GitHub's runner deprecations API schedules the end of the pinned version within ${DEPRECATION_WINDOW_DAYS} days, or that date has passed`,
    remediationKind: 'operator-action',
    remediation: BUMP_REMEDIATION,
  },
  'pin-superseded': {
    class: 'defect',
    retryable: false,
    whyStopped: `the pinned actions/runner version has been superseded for more than ${FAIL_DAYS} days, GitHub's documented update window`,
    remediationKind: 'operator-action',
    remediation: BUMP_REMEDIATION,
  },
  'dockerfile-pin-invalid': {
    class: 'defect',
    retryable: false,
    whyStopped: `the runner pin in ${DOCKERFILE_REL} is missing, duplicated, malformed, or below the known registration floor`,
    remediationKind: 'operator-action',
    remediation:
      `Leave exactly one ARG RUNNER_VERSION=<x.y.z> at or above ${KNOWN_FLOOR} and one ARG RUNNER_SHA256=<64 lowercase hex> ` +
      `in ${DOCKERFILE_REL}. The error lines above name which of those failed.`,
  },
  'provision-default-disagrees': {
    class: 'defect',
    retryable: false,
    whyStopped: `${PROVISION_REL} sets a literal RUNNER_VERSION that the Dockerfile does not pin`,
    remediationKind: 'operator-action',
    remediation:
      `Remove the literal RUNNER_VERSION from ${PROVISION_REL}; the Dockerfile owns the pin, and a script default ` +
      'passed as --build-arg would fail the image build\'s checksum.',
  },
});

/**
 * The classified record .github/scripts/deploy-notify-failure.mjs reads via
 * --failure-json, so the tracking issue says WHAT failed and WHAT to do rather
 * than "no classification was captured".
 *
 * `findings` is [{ kind, message }], first one decides the record's kind (the
 * offline check can report two faults at once, and the online check can fail
 * on both signals; each keeps its own signal in `established`). `attempts` is
 * how many reads were actually made. An unknown kind THROWS: a record that
 * guessed its class is the defect this replaces.
 */
export function buildFailureRecord({ findings, attempts = 1 }) {
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error('buildFailureRecord: no findings -- nothing to classify');
  }
  const kind = findings[0].kind;
  const row = FAILURE_KINDS[kind];
  if (!row) throw new Error(`buildFailureRecord: unknown failure kind '${kind}'`);
  return {
    class: row.class,
    signalId: `runner-version-pin.${kind}`,
    retryable: row.retryable,
    attempts: Array.from({ length: attempts }, (_, i) => ({ attempt: i + 1, exitCode: 1, class: row.class })),
    whyStopped: row.whyStopped,
    established: findings.map((f) => ({ signal: f.kind, line: f.message })),
    remediationKind: row.remediationKind,
    remediation: row.remediation,
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] ?? null;
}

/**
 * The CLI. Exported with injectable dependencies so a test can witness the
 * EXIT CODE the workflow reads -- the alarm IS this number, not the verdict
 * objects. Returns the exit code; never calls process.exit itself. `token` is
 * injected rather than read inside, so a test never depends on the caller's
 * environment; it is sent only as a request header and never printed.
 */
export async function main({
  argv = process.argv.slice(2),
  repoRoot = REPO_ROOT,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  backoffMs = 2000,
  timeoutMs = FETCH_TIMEOUT_MS,
  sleep = defaultSleep,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
  log = (s) => console.log(s),
  error = (s) => console.error(s),
} = {}) {
  const online = argv.includes('--online');
  const failureJson = argValue(argv, 'failure-json');
  const writeRecord = (findings, attempts) => {
    if (failureJson) {
      fs.writeFileSync(failureJson, JSON.stringify(buildFailureRecord({ findings, attempts }), null, 2));
    }
  };
  const dockerfileText = fs.readFileSync(path.join(repoRoot, DOCKERFILE_REL), 'utf8');
  const scriptPath = path.join(repoRoot, PROVISION_REL);
  const scriptText = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  const { pin, problems } = checkOffline({ dockerfileText, scriptText });
  log(`[runner-version-pin] ${DOCKERFILE_REL}: RUNNER_VERSION=${pin.version ?? '<none>'} (floor ${KNOWN_FLOOR})`);
  if (problems.length > 0) {
    for (const p of problems) error(`::error file=${DOCKERFILE_REL}::runner-version-pin: ${p.message}`);
    writeRecord(problems, 1);
    return 1;
  }
  if (!online) {
    log('[runner-version-pin] OK (offline): pin is well-formed, at/above the known floor, and no script default disagrees.');
    return 0;
  }
  const clock = now;
  let releases;
  const meta = {};
  try {
    releases = await fetchReleases({ fetchImpl, backoffMs, timeoutMs, sleep, clock, token, meta });
  } catch (e) {
    const message = `${e.message}. The pin's age was NOT established.`;
    error(`::error::runner-version-pin: ${message}`);
    const kind = e.forbiddenStatus ? 'releases-forbidden' : e.rejectedStatus ? 'releases-rejected' : 'releases-unreadable';
    writeRecord([{ kind, message }], e.attempts ?? meta.attempts ?? 1);
    return 1;
  }
  const age = evaluateAge({ pin: pin.version, releases, now: now() });
  // A release list that says nothing, or a pin that is not a release, fails on
  // its own: the deprecation schedule cannot rescue a tarball that would 404.
  if (age.verdict === 'fail' && age.kind !== 'pin-superseded') {
    error(`::error file=${DOCKERFILE_REL}::runner-version-pin: ${age.message}`);
    writeRecord([{ kind: age.kind, message: age.message }], meta.attempts ?? 1);
    return 1;
  }

  const dep = await readDeprecation({ version: pin.version, repo, token, fetchImpl, backoffMs, timeoutMs, sleep, clock });
  let depVerdict = null;
  let source;
  if (dep.source === 'api') {
    depVerdict = evaluateDeprecation({ pin: pin.version, schedule: dep.schedule, now: now() });
    if (depVerdict.verdict === 'unusable') {
      source = `heuristic -- ${depVerdict.message}`;
      depVerdict = null;
    } else {
      source = 'deprecations API + release-age heuristic';
    }
  } else {
    source = `heuristic -- GitHub's runner deprecations API was not read: ${dep.reason}`;
  }
  const tag = `[verdict source: ${source}]`;
  if (depVerdict === null) {
    // Said on every heuristic run, so a green heuristic verdict never reads as
    // an authoritative one.
    log(`::warning::runner-version-pin: verdict is HEURISTIC (release age only). ${tag}`);
  }

  const fails = [];
  if (depVerdict?.verdict === 'fail') fails.push({ kind: depVerdict.kind, message: `${depVerdict.message} ${tag}` });
  if (age.verdict === 'fail') fails.push({ kind: age.kind, message: `${age.message} ${tag}` });
  if (fails.length > 0) {
    for (const f of fails) error(`::error file=${DOCKERFILE_REL}::runner-version-pin: ${f.message}`);
    writeRecord(fails, meta.attempts ?? 1);
    return 1;
  }
  const parts = [depVerdict?.message, age.message].filter(Boolean).join('; ');
  if (depVerdict?.verdict === 'warn' || age.verdict === 'warn') {
    log(`::warning file=${DOCKERFILE_REL}::runner-version-pin: ${parts} ${tag}`);
    return 0;
  }
  log(`[runner-version-pin] OK (online): ${parts} ${tag}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error::runner-version-pin crashed: ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
