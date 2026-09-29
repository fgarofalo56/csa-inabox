#!/usr/bin/env node
/**
 * GUARDRAIL: runner-version-pin (RVP0)
 * ---------------------------------------------------------------------------
 * RULE: the GitHub Actions runner agent baked into the in-VNet self-hosted
 *   runner image (platform/runners/github-actions/Dockerfile, ARG
 *   RUNNER_VERSION) must never age past the point where GitHub refuses to
 *   register it.
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
 * IS THERE A PUBLIC MINIMUM-VERSION SOURCE? No machine-readable one. GitHub
 *   documents a POLICY for runners that do not auto-update (docs,
 *   content/actions/reference/runners/self-hosted-runners.md): "you will be
 *   required to update your runner version within 30 days of a new version
 *   being made available", plus a right to refuse jobs "until it has been
 *   updated" when a critical security update ships. That wording is written for
 *   runners with auto-update disabled; it is used here as the best published
 *   statement of how far behind GitHub is prepared to let a registering binary
 *   fall, because a replica that must register before it can update is in the
 *   same position. The enforced minimum itself appears only in the refusal
 *   message. So this guard does two things:
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
 *     4. reads the actions/runner releases and measures how long the pin has
 *        been SUPERSEDED -- the age of the OLDEST published release newer than
 *        the pin (that is when GitHub's 30-day clock started). WARN past
 *        WARN_DAYS (30, the documented policy); FAIL past FAIL_DAYS (60).
 *        `--failure-json <path>` writes a classified failure record for
 *        .github/scripts/deploy-notify-failure.mjs when the verdict is a failure.
 *
 * WHY 60 DAYS AND NOT "N MINOR VERSIONS BEHIND". Enforcement is keyed to TIME
 *   ("within 30 days of a new version"), not to a version count, and release
 *   cadence is uneven (measured over v2.328.0..v2.337.0: 21 to 62 days between
 *   minor releases, and patch releases -- which GitHub says also start the
 *   clock -- land in between), so a version count would fire at wildly
 *   different ages. 60 days is
 *   the documented 30-day window plus a 30-day margin to land a bump without
 *   the lane going red on the first day of breach -- and still ~290 days inside
 *   the lag GitHub actually showed this time (2.329.0 superseded 2.328.0 on
 *   2025-10-14; 2.328.0 was refused on 2026-09-29). GitHub can tighten that lag
 *   at any time, and the critical-security-update path has no lag at all; this
 *   guard cannot see the latter and says so rather than implying it does.
 *
 * WHY THE AGE CHECK IS NOT A REQUIRED PR CHECK. It is a function of the
 *   CALENDAR, not of the diff: on day 61 it would red every open PR at once,
 *   including ones that never touched the runner. It gets its OWN daily
 *   workflow instead -- not a step in an existing one, because a red step in a
 *   workflow that is already red every day changes nothing anyone watches
 *   (deploy-staleness.yml was 56/56 failure when this was first placed there).
 *   It runs on a GitHub-hosted runner, the only place it may run: the
 *   self-hosted runner is the thing that is down when this alarm matters.
 *
 * FAILS CLOSED. An unreadable releases API, an empty release list, a pin newer
 *   than every release, or a pin that is not a published release (its tarball
 *   would 404 at build time) is a FAILURE with the reason stated -- never a pass
 *   and never "up to date".
 *
 * EACH FAILURE SAYS WHAT IT IS (deploy-integrity.md R7). `--failure-json`
 *   writes one record per failed run, built from FAILURE_KINDS below. Every
 *   class is one that exists in apps/fiab-console/lib/deploy/failure-taxonomy.json:
 *
 *     kind                          class      when
 *     releases-unreadable           transient  the API could not be read:
 *                                              network error, timeout, 5xx,
 *                                              403/429 after every attempt, a
 *                                              body that is not JSON
 *     releases-rejected             config     the API refused with a 4xx that
 *                                              is NOT retried (404, 401, 422,
 *                                              ...): retrying cannot change it,
 *                                              so the record says retryable:false
 *     releases-unusable             transient  the API answered 200, but the
 *                                              payload was not a list or held
 *                                              no stable release
 *     pin-not-released              defect     the pin is newer than every
 *                                              release, or never published
 *     pin-superseded                defect     superseded past FAIL_DAYS --
 *                                              the alarm itself
 *     dockerfile-pin-invalid        defect     offline: the ARG pair is
 *                                              missing, duplicated or malformed,
 *                                              or the pin is below KNOWN_FLOOR
 *     provision-default-disagrees   defect     offline: the provision script
 *                                              sets a literal RUNNER_VERSION
 *                                              the Dockerfile does not pin
 *
 *   Only pin-superseded says "past the alarm threshold". A payload GitHub
 *   mangled is not a stale pin, and a script/Dockerfile disagreement is not one
 *   either. The three API kinds say the pin's age was NOT established, in
 *   their whyStopped. Two are `transient`: a re-run may read the API. The
 *   deterministic refusal is `config`, since a re-run cannot change a 404; it
 *   means the URL or the token is wrong. The four repo kinds are `defect`:
 *   the fault is in CSA Loom's own Dockerfile or script.
 *
 * RETRIES AND TIMEOUT. A read is attempted up to FETCH_ATTEMPTS (3) times, and
 *   the failure record's `attempts` list has one entry per attempt actually
 *   made. Retried: network errors, a per-attempt timeout, 5xx, and 403 / 429 --
 *   the two statuses GitHub uses for rate limiting. NOT retried: every other
 *   4xx (404, 401, 422, ...), which is deterministic, so that record is
 *   releases-rejected and carries ONE attempt. Each attempt is bounded by FETCH_TIMEOUT_MS (30 s) through an
 *   AbortSignal. Without that bound, Node's fetch waits about 300 s for
 *   headers. Three such waits overrun the workflow's `timeout-minutes: 10`, so
 *   the job ends CANCELLED, `failure()` is false, and a black-holed API files
 *   nothing. With the bound, the worst case is 3 x 30 s plus the 2 s and 4 s
 *   backoffs: 96 s.
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
export const WARN_DAYS = 30;
export const FAIL_DAYS = 60;
export const RELEASES_URL = 'https://api.github.com/repos/actions/runner/releases?per_page=100';
export const FETCH_ATTEMPTS = 3;
export const FETCH_TIMEOUT_MS = 30_000;

const DAY_MS = 86_400_000;

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
 * The calendar half. `releases` is the GitHub releases API payload.
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
      message: `${base}. Past ${failDays} days (GitHub's documented 30-day update window + 30 days). GitHub may refuse registration at any time -- bump RUNNER_VERSION + RUNNER_SHA256 in ${DOCKERFILE_REL} and rebuild the runner image.`,
    };
  }
  if (ageDays > warnDays) {
    return {
      verdict: 'warn',
      latest: latest.version,
      supersededBy: first.version,
      ageDays,
      message: `${base}. Past GitHub's documented ${warnDays}-day update window; this check FAILS at ${failDays} days.`,
    };
  }
  return {
    verdict: 'ok',
    latest: latest.version,
    supersededBy: first.version,
    ageDays,
    message: `${base}. Within the ${warnDays}-day window.`,
  };
}

/** Statuses that are retried besides 5xx: GitHub's two rate-limit responses. */
export const RETRY_4XX = new Set([403, 429]);

export async function fetchReleases({
  attempts = FETCH_ATTEMPTS,
  fetchImpl = globalThis.fetch,
  backoffMs = 2000,
  timeoutMs = FETCH_TIMEOUT_MS,
  meta = {},
} = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'csa-loom-runner-version-pin' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastErr = null;
  let made = 0;
  let rejectedStatus = null;
  for (let i = 1; i <= attempts; i += 1) {
    made = i;
    // `meta.attempts` reports the count on SUCCESS too, so a record built from
    // a 200 that came after a 429 says 2, not 1.
    meta.attempts = made;
    try {
      // One signal per attempt, covering the headers AND the body read: a
      // black-holed API must end this attempt, not the job (header, RETRIES AND TIMEOUT).
      const res = await fetchImpl(RELEASES_URL, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status} from ${RELEASES_URL}`);
      // Any other 4xx is deterministic -- retrying cannot change it.
      if (res.status < 500 && !RETRY_4XX.has(res.status)) {
        rejectedStatus = res.status;
        break;
      }
    } catch (e) {
      lastErr =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? new Error(`no response within ${timeoutMs} ms (${e.name})`)
          : e;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, backoffMs * i));
  }
  const err = new Error(
    `could not read the actions/runner releases API after ${made} attempt(s): ${lastErr?.message ?? lastErr}`,
  );
  err.attempts = made;
  // Set only for the non-retried 4xx, so main() can tell "refused" from "unreadable".
  err.rejectedStatus = rejectedStatus;
  throw err;
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
      'stays unreadable, check githubstatus.com and whether the workflow token can read public repos.',
  },
  'releases-rejected': {
    class: 'config',
    retryable: false,
    whyStopped:
      'the actions/runner releases API refused the read with a 4xx that retrying cannot change; the pin age was NOT established',
    remediationKind: 'operator-action',
    remediation:
      `Nothing is known about the pin from this run. Read ${RELEASES_URL} by hand with the workflow's token: ` +
      'a 404 means the URL is wrong, a 401 means the token is invalid. Fix RELEASES_URL or the token, then re-run.',
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
  'pin-superseded': {
    class: 'defect',
    retryable: false,
    whyStopped: 'the pinned actions/runner version is past the alarm threshold',
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
 * offline check can report two faults at once; each keeps its own signal in
 * `established`). `attempts` is how many reads were actually made. An unknown
 * kind THROWS: a record that guessed its class is the defect this replaces.
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
 * EXIT CODE the workflow reads -- the alarm IS this number, not evaluateAge's
 * verdict. Returns the exit code; never calls process.exit itself.
 */
export async function main({
  argv = process.argv.slice(2),
  repoRoot = REPO_ROOT,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  backoffMs = 2000,
  timeoutMs = FETCH_TIMEOUT_MS,
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
  let releases;
  const meta = {};
  try {
    releases = await fetchReleases({ fetchImpl, backoffMs, timeoutMs, meta });
  } catch (e) {
    const message = `${e.message}. The pin's age was NOT established.`;
    error(`::error::runner-version-pin: ${message}`);
    const kind = e.rejectedStatus ? 'releases-rejected' : 'releases-unreadable';
    writeRecord([{ kind, message }], e.attempts ?? meta.attempts ?? 1);
    return 1;
  }
  const r = evaluateAge({ pin: pin.version, releases, now: now() });
  if (r.verdict === 'fail') {
    error(`::error file=${DOCKERFILE_REL}::runner-version-pin: ${r.message}`);
    writeRecord([{ kind: r.kind, message: r.message }], meta.attempts ?? 1);
    return 1;
  }
  if (r.verdict === 'warn') {
    log(`::warning file=${DOCKERFILE_REL}::runner-version-pin: ${r.message}`);
    return 0;
  }
  log(`[runner-version-pin] OK (online): ${r.message}`);
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
