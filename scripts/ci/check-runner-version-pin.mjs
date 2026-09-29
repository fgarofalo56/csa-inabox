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
 *        the caller's environment, or a commented-out line.
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
 * RETRIES. A read is attempted up to 3 times. Retried: network errors, 5xx,
 *   and 403 / 429 -- the two statuses GitHub uses for rate limiting, which is
 *   transient. NOT retried: every other 4xx (404, 401, 422, ...), which is
 *   deterministic.
 *
 * Self-test: scripts/ci/__tests__/check-runner-version-pin.test.mjs
 * Run:       node scripts/ci/check-runner-version-pin.mjs [--online]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const DOCKERFILE_REL = 'platform/runners/github-actions/Dockerfile';
export const PROVISION_REL = 'scripts/csa-loom/provision-gh-runner.sh';
/** Minimum GitHub reported in its 2026-09-29 registration refusal. Ratchet only. */
export const KNOWN_FLOOR = '2.329.0';
export const WARN_DAYS = 30;
export const FAIL_DAYS = 60;
export const RELEASES_URL = 'https://api.github.com/repos/actions/runner/releases?per_page=100';

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
 * Only real `ARG` lines count -- a comment that mentions a version is not a pin.
 */
export function readPin(dockerfileText) {
  const errors = [];
  const lines = String(dockerfileText).split(/\r?\n/);
  const versions = [];
  const shas = [];
  for (const line of lines) {
    const v = /^\s*ARG\s+RUNNER_VERSION=(\S*)\s*$/.exec(line);
    if (v) versions.push(v[1]);
    const s = /^\s*ARG\s+RUNNER_SHA256=(\S*)\s*$/.exec(line);
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
 * Every LITERAL RUNNER_VERSION a shell script sets. Two shapes:
 *   - parameter-expansion defaults: `${RUNNER_VERSION:-X}`, `${RUNNER_VERSION:=X}`,
 *     and the colon-less `${RUNNER_VERSION-X}` / `${RUNNER_VERSION=X}`;
 *   - assignments: `RUNNER_VERSION=X`, `export RUNNER_VERSION=X`, and a
 *     hard-coded `--build-arg RUNNER_VERSION=X` / `"RUNNER_VERSION=X"`.
 * A value containing `$` is a REFERENCE (e.g. the script's own
 * `"RUNNER_VERSION=${RUNNER_VERSION}"` pass-through), not a literal, and is
 * skipped; so are empty values and commented lines. See the header for what
 * this cannot see.
 */
export function scriptVersionDefaults(scriptText) {
  const out = [];
  const expansion = /\$\{RUNNER_VERSION:?[-=]([^}]*)\}/g;
  const assignment = /(?<![A-Za-z0-9_${])RUNNER_VERSION=([^\s;&|)]*)/g;
  for (const line of String(scriptText).split(/\r?\n/)) {
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

/** The hermetic half. No network, no clock. */
export function checkOffline({ dockerfileText, scriptText, floor = KNOWN_FLOOR }) {
  const pin = readPin(dockerfileText);
  const errors = [...pin.errors];
  if (pin.version && parseSemver(pin.version) && compareSemver(pin.version, floor) < 0) {
    errors.push(
      `RUNNER_VERSION ${pin.version} is below ${floor}, the minimum GitHub last reported it will register ` +
        `(2026-09-29 refusal). A runner built from this image cannot register.`,
    );
  }
  for (const d of scriptVersionDefaults(scriptText ?? '')) {
    if (d !== pin.version) {
      errors.push(
        `${PROVISION_REL} sets RUNNER_VERSION to '${d}' but ${DOCKERFILE_REL} pins '${pin.version}'. ` +
          `The script passes it as a --build-arg, so it overrides the Dockerfile while the Dockerfile's ` +
          `RUNNER_SHA256 stays -- the build fails its checksum. Drop the script default; the Dockerfile owns the pin.`,
      );
    }
  }
  return { pin, errors };
}

/**
 * The calendar half. `releases` is the GitHub releases API payload.
 * Returns { verdict: 'ok'|'warn'|'fail', message, latest, supersededBy, ageDays }.
 */
export function evaluateAge({ pin, releases, now, warnDays = WARN_DAYS, failDays = FAIL_DAYS }) {
  if (!parseSemver(pin)) {
    return { verdict: 'fail', message: `cannot evaluate age: pin '${pin}' is not x.y.z` };
  }
  if (!Array.isArray(releases)) {
    return { verdict: 'fail', message: 'cannot evaluate age: the releases payload is not a list' };
  }
  const stable = releases
    .filter((r) => r && !r.draft && !r.prerelease && parseSemver(r.tag_name) && r.published_at)
    .map((r) => ({ version: r.tag_name.replace(/^v/, ''), publishedMs: Date.parse(r.published_at) }))
    .filter((r) => Number.isFinite(r.publishedMs));
  if (stable.length === 0) {
    return {
      verdict: 'fail',
      message: 'cannot evaluate age: the releases API returned no stable releases -- nothing was established',
    };
  }
  stable.sort((a, b) => compareSemver(b.version, a.version));
  const latest = stable[0];
  const oldest = stable[stable.length - 1];
  if (compareSemver(pin, latest.version) > 0) {
    return {
      verdict: 'fail',
      latest: latest.version,
      message: `pin ${pin} is NEWER than the latest published release ${latest.version} -- not a real release; the tarball download would 404`,
    };
  }
  const found = stable.some((r) => compareSemver(r.version, pin) === 0);
  if (!found && compareSemver(pin, oldest.version) > 0) {
    return {
      verdict: 'fail',
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

export async function fetchReleases({ attempts = 3, fetchImpl = globalThis.fetch, backoffMs = 2000 } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'csa-loom-runner-version-pin' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetchImpl(RELEASES_URL, { headers });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status} from ${RELEASES_URL}`);
      // Any other 4xx is deterministic -- retrying cannot change it.
      if (res.status < 500 && !RETRY_4XX.has(res.status)) break;
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, backoffMs * i));
  }
  throw new Error(`could not read the actions/runner releases API after ${attempts} attempt(s): ${lastErr?.message ?? lastErr}`);
}

/**
 * The classified record .github/scripts/deploy-notify-failure.mjs reads via
 * --failure-json, so the tracking issue says WHAT failed and WHAT to do rather
 * than "no classification was captured". Classes are from
 * apps/fiab-console/lib/deploy/failure-taxonomy.json.
 */
export function buildFailureRecord({ kind, message }) {
  if (kind === 'unreadable') {
    return {
      class: 'transient',
      signalId: 'runner-version-pin.releases-api-unreadable',
      retryable: true,
      attempts: [{ attempt: 1, exitCode: 1, class: 'transient' }],
      whyStopped: 'the releases API could not be read after bounded retries; the pin age was NOT established',
      established: [{ signal: 'releases-api-unreadable', line: message }],
      remediationKind: 'operator-action',
      remediation:
        'Nothing is known about the pin from this run. Re-run the runner-version-pin workflow; if the API ' +
        'stays unreadable, check GitHub status and the workflow token.',
    };
  }
  return {
    class: 'defect',
    signalId: 'runner-version-pin.superseded',
    retryable: false,
    attempts: [{ attempt: 1, exitCode: 1, class: 'defect' }],
    whyStopped: 'the pinned actions/runner version is past the alarm threshold',
    established: [{ signal: 'runner-pin-superseded', line: message }],
    remediationKind: 'operator-action',
    remediation:
      `Bump ARG RUNNER_VERSION and ARG RUNNER_SHA256 in ${DOCKERFILE_REL} to the latest actions/runner release ` +
      '(linux-x64 hash from the release asset digest), build the image under a NEW tag, and point the ' +
      'gh-aca-runner Container Apps Job at it. See docs/fiab/github-actions-runner.md.',
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
  log = (s) => console.log(s),
  error = (s) => console.error(s),
} = {}) {
  const online = argv.includes('--online');
  const failureJson = argValue(argv, 'failure-json');
  const dockerfileText = fs.readFileSync(path.join(repoRoot, DOCKERFILE_REL), 'utf8');
  const scriptPath = path.join(repoRoot, PROVISION_REL);
  const scriptText = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  const { pin, errors } = checkOffline({ dockerfileText, scriptText });
  log(`[runner-version-pin] ${DOCKERFILE_REL}: RUNNER_VERSION=${pin.version ?? '<none>'} (floor ${KNOWN_FLOOR})`);
  if (errors.length > 0) {
    for (const e of errors) error(`::error file=${DOCKERFILE_REL}::runner-version-pin: ${e}`);
    if (failureJson) {
      fs.writeFileSync(failureJson, JSON.stringify(buildFailureRecord({ kind: 'stale', message: errors.join(' | ') }), null, 2));
    }
    return 1;
  }
  if (!online) {
    log('[runner-version-pin] OK (offline): pin is well-formed, at/above the known floor, and no script default disagrees.');
    return 0;
  }
  let releases;
  try {
    releases = await fetchReleases({ fetchImpl, backoffMs });
  } catch (e) {
    const message = `${e.message}. The pin's age was NOT established.`;
    error(`::error::runner-version-pin: ${message}`);
    if (failureJson) {
      fs.writeFileSync(failureJson, JSON.stringify(buildFailureRecord({ kind: 'unreadable', message }), null, 2));
    }
    return 1;
  }
  const r = evaluateAge({ pin: pin.version, releases, now: now() });
  if (r.verdict === 'fail') {
    error(`::error file=${DOCKERFILE_REL}::runner-version-pin: ${r.message}`);
    if (failureJson) {
      fs.writeFileSync(failureJson, JSON.stringify(buildFailureRecord({ kind: 'stale', message: r.message }), null, 2));
    }
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
