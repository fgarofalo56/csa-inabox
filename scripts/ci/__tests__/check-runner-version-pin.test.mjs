/**
 * Self-test for scripts/ci/check-runner-version-pin.mjs (RVP0).
 *
 * Every load-bearing assertion below names, in its message or the comment
 * above it, the input that turns it red (assertion-design.md). The release
 * fixture is the REAL actions/runner release list as read from
 * GET /repos/actions/runner/releases on 2026-09-29 (tag + published_at,
 * v2.328.0..v2.337.0), so the ages the tests compute are the ages that
 * actually happened -- the 350-day case is the outage this guard exists for.
 *
 * Run: node --test scripts/ci/__tests__/check-runner-version-pin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_FLOOR,
  WARN_DAYS,
  FAIL_DAYS,
  DOCKERFILE_REL,
  PROVISION_REL,
  compareSemver,
  readPin,
  scriptVersionDefaults,
  checkOffline,
  evaluateAge,
  fetchReleases,
} from '../check-runner-version-pin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CHECKER = join(HERE, '..', 'check-runner-version-pin.mjs');
const DAY = 86_400_000;

// Measured 2026-09-29 from the GitHub releases API (not transcribed from memory).
const RELEASES = [
  ['v2.337.0', '2026-08-26T14:33:29Z'],
  ['v2.336.0', '2026-07-20T17:45:55Z'],
  ['v2.335.1', '2026-06-09T01:32:05Z'],
  ['v2.335.0', '2026-06-08T17:08:55Z'],
  ['v2.334.0', '2026-04-21T18:54:03Z'],
  ['v2.333.1', '2026-03-27T17:01:07Z'],
  ['v2.333.0', '2026-03-18T17:30:37Z'],
  ['v2.332.0', '2026-02-25T13:52:08Z'],
  ['v2.331.0', '2026-01-09T17:26:04Z'],
  ['v2.330.0', '2025-11-19T14:38:48Z'],
  ['v2.329.0', '2025-10-14T14:57:30Z'],
  ['v2.328.0', '2025-08-13T16:49:24Z'],
].map(([tag_name, published_at]) => ({ tag_name, published_at, draft: false, prerelease: false }));

const OUTAGE = Date.parse('2026-09-29T19:04:00Z');
const SHA = '70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613';
const dockerfile = (version, sha = SHA) =>
  [
    'FROM ubuntu:22.04',
    '# For an arm64 build, pass the matching linux-arm64 hash, e.g. v2.300.0:',
    '#   RUNNER_SHA256=9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393',
    `ARG RUNNER_VERSION=${version}`,
    `ARG RUNNER_SHA256=${sha}`,
    'ARG TARGETARCH=amd64',
  ].join('\n');

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

test('the real Dockerfile + provision script pass the offline check', () => {
  const dockerfileText = readFileSync(join(REPO_ROOT, DOCKERFILE_REL), 'utf8');
  const scriptText = readFileSync(join(REPO_ROOT, PROVISION_REL), 'utf8');
  const { pin, errors } = checkOffline({ dockerfileText, scriptText });
  // RED if the Dockerfile pin goes back to 2.328.0 (below the floor), or if the
  // provision script regains a `${RUNNER_VERSION:-2.328.0}` default.
  assert.deepEqual(errors, [], `real tree must be clean; got: ${errors.join(' | ')}`);
  // RED if the pin is dropped below the floor even with the error list somehow empty.
  assert.ok(compareSemver(pin.version, KNOWN_FLOOR) >= 0, `pin ${pin.version} must be >= ${KNOWN_FLOOR}`);
});

// ---------------------------------------------------------------------------
// readPin
// ---------------------------------------------------------------------------

test('readPin reads the ARG lines and ignores version-shaped comments', () => {
  const r = readPin(dockerfile('2.337.0'));
  // RED if a commented `RUNNER_SHA256=` line were counted (sha would be the
  // arm64 hash, or the count would be 2 and sha null).
  assert.equal(r.sha256, SHA);
  assert.equal(r.version, '2.337.0');
  assert.deepEqual(r.errors, []);
});

test('readPin fails on a missing, duplicated, malformed version or sha', () => {
  // RED if a missing ARG is treated as "no pin to check" instead of an error.
  assert.match(readPin('FROM x\nARG RUNNER_SHA256=' + SHA).errors.join('|'), /exactly one 'ARG RUNNER_VERSION/);
  // RED if the second ARG silently wins.
  assert.match(
    readPin(dockerfile('2.337.0') + '\nARG RUNNER_VERSION=2.328.0').errors.join('|'),
    /found 2/,
  );
  // RED if a floating value like `latest` were accepted as a version.
  assert.match(readPin(dockerfile('latest')).errors.join('|'), /not a plain x\.y\.z/);
  // RED if a 63-char sha (one digit dropped in a copy-paste) were accepted.
  assert.match(readPin(dockerfile('2.337.0', SHA.slice(1))).errors.join('|'), /not 64 lowercase hex/);
});

// ---------------------------------------------------------------------------
// checkOffline: floor + script default
// ---------------------------------------------------------------------------

test('a pin below the known floor fails; the floor itself passes', () => {
  // 2.328.0 is the version GitHub refused on 2026-09-29. RED if the floor
  // comparison is removed or inverted.
  const below = checkOffline({ dockerfileText: dockerfile('2.328.0'), scriptText: '' });
  assert.equal(below.errors.length, 1, `2.328.0 must produce exactly one error; got ${below.errors.join(' | ')}`);
  assert.match(below.errors[0], /below 2\.329\.0/);
  // Boundary: RED if the comparison is `<=` instead of `<`.
  const at = checkOffline({ dockerfileText: dockerfile(KNOWN_FLOOR), scriptText: '' });
  assert.deepEqual(at.errors, []);
});

test('a provision-script default that disagrees with the Dockerfile fails', () => {
  const pinned = dockerfile('2.337.0');
  // The exact line the script carried before this fix. RED if the script scan is dropped.
  const stale = 'RUNNER_VERSION="${RUNNER_VERSION:-2.328.0}"\n';
  const bad = checkOffline({ dockerfileText: pinned, scriptText: stale });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /defaults RUNNER_VERSION to '2\.328\.0'.*pins '2\.337\.0'/);
  // Positive pairs, so the absence above is not satisfied by a scan that
  // matches everything: an EMPTY default (the fixed form) and an AGREEING
  // default both pass. RED if every `${RUNNER_VERSION:-…}` were flagged.
  assert.deepEqual(checkOffline({ dockerfileText: pinned, scriptText: 'RUNNER_VERSION="${RUNNER_VERSION:-}"' }).errors, []);
  assert.deepEqual(
    checkOffline({ dockerfileText: pinned, scriptText: 'RUNNER_VERSION="${RUNNER_VERSION:-2.337.0}"' }).errors,
    [],
  );
  // A comment quoting the old line is prose, not a pin. RED if comments were scanned.
  assert.deepEqual(scriptVersionDefaults('# was: ${RUNNER_VERSION:-2.328.0}\n'), []);
  // And the scan does see a live one (positive control for the line above).
  assert.deepEqual(scriptVersionDefaults('  V="${RUNNER_VERSION:-2.1.0}"\n'), ['2.1.0']);
});

// ---------------------------------------------------------------------------
// evaluateAge: the recurrence alarm
// ---------------------------------------------------------------------------

test('the outage itself: 2.328.0 on 2026-09-29 is FAIL, superseded 350 days', () => {
  const r = evaluateAge({ pin: '2.328.0', releases: RELEASES, now: OUTAGE });
  // RED if the fail threshold were missing, or age were measured from the pin's
  // own release date (411 days) or from the latest release (33 days -> warn).
  assert.equal(r.verdict, 'fail', r.message);
  assert.equal(r.supersededBy, '2.329.0');
  assert.equal(r.ageDays, 350);
});

test('the clock starts at the OLDEST newer release, and a patch release starts it', () => {
  // pin 2.335.0 on the outage date: oldest newer = 2.335.1 (a PATCH, 112 days)
  // -> fail. If the code measured from the LATEST newer (2.337.0, 34 days) it
  // would say warn; if it skipped patch releases it would pick 2.336.0 (71
  // days). Only the correct rule gives fail + 2.335.1 + 112.
  const r = evaluateAge({ pin: '2.335.0', releases: RELEASES, now: OUTAGE });
  assert.equal(r.verdict, 'fail', r.message);
  assert.equal(r.supersededBy, '2.335.1');
  assert.equal(r.ageDays, 112);
});

test('thresholds: ok through day 30, warn 31..60, fail from day 61', () => {
  const t0 = Date.parse('2026-08-26T14:33:29Z'); // v2.337.0 published; pin 2.336.0
  const at = (days) => evaluateAge({ pin: '2.336.0', releases: RELEASES, now: t0 + days * DAY + 1000 });
  assert.equal(WARN_DAYS, 30);
  assert.equal(FAIL_DAYS, 60);
  // Each boundary pair is RED under an off-by-one (`>=` for `>`) on that threshold.
  assert.equal(at(30).verdict, 'ok');
  assert.equal(at(31).verdict, 'warn');
  assert.equal(at(60).verdict, 'warn');
  assert.equal(at(61).verdict, 'fail');
});

test('the latest release is ok; drafts and prereleases do not start the clock', () => {
  assert.equal(evaluateAge({ pin: '2.337.0', releases: RELEASES, now: OUTAGE }).verdict, 'ok');
  const withPre = [
    { tag_name: 'v2.338.0', published_at: '2026-06-01T00:00:00Z', draft: false, prerelease: true },
    { tag_name: 'v2.339.0', published_at: '2026-06-01T00:00:00Z', draft: true, prerelease: false },
    ...RELEASES,
  ];
  // Both non-stable releases are 120 days old. RED if either filter is dropped
  // (the verdict becomes fail).
  const r = evaluateAge({ pin: '2.337.0', releases: withPre, now: OUTAGE });
  assert.equal(r.verdict, 'ok', r.message);
  assert.equal(r.latest, '2.337.0');
});

test('fails closed when nothing was established or the pin is not a release', () => {
  // RED if an empty list read as "nothing newer, so up to date".
  assert.equal(evaluateAge({ pin: '2.337.0', releases: [], now: OUTAGE }).verdict, 'fail');
  // RED if an error-object payload (e.g. {message:'rate limited'}) read as up to date.
  assert.equal(evaluateAge({ pin: '2.337.0', releases: { message: 'x' }, now: OUTAGE }).verdict, 'fail');
  // A typo'd future version: RED if "nothing newer" were accepted as ok.
  const future = evaluateAge({ pin: '2.340.0', releases: RELEASES, now: OUTAGE });
  assert.equal(future.verdict, 'fail');
  assert.match(future.message, /NEWER than the latest/);
  // A version inside the range that was never published (tarball would 404).
  const ghost = evaluateAge({ pin: '2.330.5', releases: RELEASES, now: OUTAGE });
  assert.equal(ghost.verdict, 'fail');
  assert.match(ghost.message, /not a published actions\/runner release/);
});

// ---------------------------------------------------------------------------
// fetchReleases: an unreadable API is a failure, not a pass
// ---------------------------------------------------------------------------

test('fetchReleases retries a 5xx, then throws naming the failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 503 };
  };
  // RED if a failed read resolved to [] (which evaluateAge would then have to catch).
  await assert.rejects(fetchReleases({ fetchImpl, backoffMs: 1 }), /could not read.*HTTP 503/);
  // RED if the retry loop were removed (calls = 1).
  assert.equal(calls, 3);
});

test('fetchReleases does not retry a 404, and returns the body on 200', async () => {
  let calls = 0;
  await assert.rejects(
    fetchReleases({
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 404 };
      },
      backoffMs: 1,
    }),
    /HTTP 404/,
  );
  // RED if 4xx were treated as transient (calls = 3).
  assert.equal(calls, 1);
  const body = await fetchReleases({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => RELEASES }) });
  assert.equal(body.length, RELEASES.length);
});

// ---------------------------------------------------------------------------
// CLI wiring: main() must turn an error into a non-zero exit
// ---------------------------------------------------------------------------

function sandbox(version, scriptText) {
  const root = mkdtempSync(join(tmpdir(), 'rvp0-'));
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'csa-loom'), { recursive: true });
  mkdirSync(join(root, 'platform', 'runners', 'github-actions'), { recursive: true });
  copyFileSync(CHECKER, join(root, 'scripts', 'ci', 'check-runner-version-pin.mjs'));
  writeFileSync(join(root, DOCKERFILE_REL), dockerfile(version));
  writeFileSync(join(root, PROVISION_REL), scriptText);
  return join(root, 'scripts', 'ci', 'check-runner-version-pin.mjs');
}

function run(checker) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [checker], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

test('CLI exits 1 with an ::error:: for the outage pin, 0 for a good pin', () => {
  // RED if main() printed the errors but returned 0 -- the gate-that-cannot-fail shape.
  const bad = run(sandbox('2.328.0', ''));
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /::error file=platform\/runners\/github-actions\/Dockerfile::runner-version-pin: RUNNER_VERSION 2\.328\.0 is below 2\.329\.0/);
  const good = run(sandbox('2.337.0', 'RUNNER_VERSION="${RUNNER_VERSION:-}"\n'));
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /OK \(offline\)/);
});
