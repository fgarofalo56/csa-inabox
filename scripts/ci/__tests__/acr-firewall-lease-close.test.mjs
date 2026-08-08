/**
 * acr-firewall-lease verified-close self-test (FINISHLINE C24 / #3088).
 *
 * THE DEFECT THIS PINS. `_lease_close_firewall` used to be:
 *
 *     az acr update … --default-action Deny          -o none || true
 *     az acr update … --public-network-enabled false -o none || true
 *
 * Two discarded writes and no read-back, so the function returned 0
 * unconditionally — including when neither write landed. MEASURED 2026-08-07
 * after run 31143181962: the "Re-lock ACR (private endpoint only)" job
 * concluded SUCCESS while `az acr show` read publicNetworkAccess=Enabled /
 * defaultAction=Allow on three probes across a minute (so not the documented
 * 30-90s propagation lag). The Commercial ACR was publicly reachable for an
 * unknown window with CI green, and a human re-locked it by hand.
 *
 * HOW THIS TESTS IT. The real script is driven with a STUB `az` on PATH whose
 * behaviour is scripted per case, so these exercise the shipped shell — not a
 * re-implementation of it, and not a grep for the string "verify". The stub
 * records every invocation so the assertions can check what was actually
 * called. Per the FIXTURES-THAT-MODEL-THE-CODE lesson, the stub imitates `az`'s
 * OUTPUT CONTRACT — one scalar per `--query publicNetworkAccess` /
 * `--query networkRuleSet.defaultAction`, which is the exact shape the lease
 * script has used against real ACRs since #2603 — rather than the script's
 * expectations. (`scripts/ci/test-acr-firewall-lease.sh` stubs `az` the same
 * way; keeping both on one contract is what stops a fixture from agreeing with
 * a bug.)
 *
 * MUTATION-PROVEN: restoring either `|| true` in `_lease_close_firewall`, or
 * deleting the `acr_lease_verify_locked` call, turns 6 of the 10 cases below
 * RED. The CONTROL cases (a genuine lock, and a lock that lands only on the
 * second attempt) stay green, so a close that simply always fails cannot pass
 * this file either.
 *
 * WHY A SECOND SUITE. `scripts/ci/test-acr-firewall-lease.sh` already covers the
 * lease SEMANTICS (#2603 ownership, stale takeover, degraded mode) — and it
 * passes 35/35 against the UN-verified close. Measured, not assumed: its stub
 * always applies the write, so the registry really does end up locked and the
 * missing read-back is structurally invisible to it. This file exists for the
 * one thing that suite cannot see — a write that does not take.
 *
 * Run: node --test scripts/ci/__tests__/acr-firewall-lease-close.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEASE = resolve(HERE, '..', '..', 'csa-loom', 'acr-firewall-lease.sh');

/**
 * Drive `_lease_close_firewall` against a stub `az`.
 *
 * @param {object} o
 * @param {string[]} o.showSequence  what `az acr show --query "[pna, da]"` returns
 *   on successive calls, as "<pna>\t<da>"; the literal 'ERROR' makes that call
 *   exit non-zero with a stderr message (the unreadable case).
 * @param {boolean} [o.updateFails]  make every `az acr update` exit non-zero.
 */
function runClose({ showSequence, updateFails = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'acrlease-'));
  const counter = join(dir, 'show-count');
  const calls = join(dir, 'calls.log');
  writeFileSync(counter, '0');

  // The stub answers the shapes the script uses: `az acr update …` (a write) and
  // two SCALAR `az acr show … --query <prop> -o tsv` reads. Tag reads
  // (`--query tags.…`) return empty, which is what a registry with no lease tags
  // genuinely returns. One `showSequence` entry feeds ONE close attempt (both of
  // its reads), so a case reads the way a real attempt does.
  const az = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(calls)}
if [ "$2" = "update" ]; then
  ${updateFails ? 'echo "(AuthorizationFailed) does not have authorization to perform action" >&2; exit 1' : 'exit 0'}
fi
if [ "$2" = "show" ]; then
  case "$*" in
    *--query\\ publicNetworkAccess*|*--query\\ networkRuleSet.defaultAction*)
      n=$(cat ${JSON.stringify(counter)})
      # advance one "attempt" per PAIR of reads (pna then defaultAction)
      case "$*" in *publicNetworkAccess*) i=$((n + 1)); echo "$i" > ${JSON.stringify(counter)} ;; *) i=$n ;; esac
      case "$i" in
${showSequence
  .map((v, i) => {
    const last = i === showSequence.length - 1 ? '|*' : '';
    if (v === 'ERROR') {
      return `        ${i + 1}${last}) echo "(ResourceNotFound) registry not found" >&2; exit 1 ;;`;
    }
    const [pna, da] = v.split('\t');
    return `        ${i + 1}${last}) case "$*" in *publicNetworkAccess*) printf '%s\\n' ${JSON.stringify(pna)} ;; *) printf '%s\\n' ${JSON.stringify(da)} ;; esac; exit 0 ;;`;
  })
  .join('\n')}
      esac
      ;;
    *) echo ""; exit 0 ;;
  esac
fi
exit 0
`;
  const azPath = join(dir, 'az');
  writeFileSync(azPath, az);
  chmodSync(azPath, 0o755);

  const driver = `#!/usr/bin/env bash
set -uo pipefail
. ${JSON.stringify(LEASE)}
_lease_parse_args --acr loomacr
_lease_close_firewall
echo "CLOSE_RC=$?"
`;
  const driverPath = join(dir, 'drive.sh');
  writeFileSync(driverPath, driver);

  const r = spawnSync('bash', [driverPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      // Keep the test fast: the real defaults are 6 attempts x 20s.
      LOOM_ACR_CLOSE_ATTEMPTS: '3',
      LOOM_ACR_CLOSE_RETRY_SECONDS: '0',
      GITHUB_ACTIONS: '',
    },
  });
  const out = `${r.stdout}${r.stderr}`;
  const rc = Number((out.match(/CLOSE_RC=(\d+)/) || [])[1]);
  return { rc, out, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

test('the shipped lease script is present and readable', () => {
  assert.ok(existsSync(LEASE), `${LEASE} must exist — these tests drive the REAL script`);
});

// ── THE DEFECT ──────────────────────────────────────────────────────────────

test('C24: the registry is STILL OPEN after the writes — close FAILS', () => {
  // The measured incident: three reads, all Enabled/Allow.
  const { rc, out } = runClose({ showSequence: ['Enabled\tAllow'] });
  assert.equal(rc, 1, 'a re-lock that did not take must NOT report success');
  assert.match(out, /FAILED to re-lock ACR/);
  assert.match(out, /may be PUBLICLY REACHABLE/);
  // R6: a concrete remediation, not a bare exit code.
  assert.match(out, /az acr update --name loomacr --default-action Deny --public-network-enabled false/);
});

test('C24: the writes themselves fail — close FAILS and quotes the az error', () => {
  const { rc, out } = runClose({ showSequence: ['Enabled\tAllow'], updateFails: true });
  assert.equal(rc, 1);
  assert.match(out, /FAILED to re-lock ACR/);
  // R7: the message carries what az actually said, not an invented cause.
  assert.match(out, /AuthorizationFailed/);
});

test('C24/R7: the state is UNREADABLE — close FAILS and says so, never "locked"', () => {
  const { rc, out } = runClose({ showSequence: ['ERROR'] });
  assert.equal(rc, 1, 'unknown must never be reported as locked');
  assert.match(out, /could not READ BACK|unreadable/i);
  // The false claim this rule exists to prevent.
  assert.doesNotMatch(out, /VERIFIED locked/);
});

// ── NOT THE DEFECT (so an always-failing close cannot pass either) ───────────

test('CONTROL: the registry IS locked after the write — close succeeds', () => {
  const { rc, out } = runClose({ showSequence: ['Disabled\tDeny'] });
  assert.equal(rc, 0);
  assert.match(out, /VERIFIED locked/);
  assert.doesNotMatch(out, /FAILED to re-lock/);
});

test('CONTROL: propagation lag — open on attempt 1, locked on attempt 2 — close succeeds', () => {
  // ACR network changes propagate for ~30-90s. A single read would flag this as
  // a failure; the bounded retry is what makes the check honest rather than
  // merely strict.
  const { rc, out } = runClose({ showSequence: ['Enabled\tAllow', 'Disabled\tDeny'] });
  assert.equal(rc, 0);
  assert.match(out, /attempt 2/);
  assert.match(out, /VERIFIED locked/);
});

test('CONTROL: a half-applied state (Disabled but Allow) is NOT accepted as locked', () => {
  // Both properties gate access. Accepting one would be a green step over a
  // registry whose network rules still default to Allow.
  const { rc } = runClose({ showSequence: ['Disabled\tAllow'] });
  assert.equal(rc, 1);
});

test('CONTROL: a write error is FORGIVEN when the registry verifies locked anyway', () => {
  // Another process may have locked it first. The read-back is the truth, not
  // the write's exit code — otherwise this would fail closed on a harmless race.
  const { rc, out } = runClose({ showSequence: ['Disabled\tDeny'], updateFails: true });
  assert.equal(rc, 0);
  assert.match(out, /VERIFIED locked/);
});

test('close actually ISSUES both writes and then READS the registry back', () => {
  const { calls } = runClose({ showSequence: ['Disabled\tDeny'] });
  assert.match(calls, /--default-action Deny/);
  assert.match(calls, /--public-network-enabled false/);
  assert.match(calls, /publicNetworkAccess/, 'the verify read must actually happen');
});

// ── The call sites must not discard the verdict ──────────────────────────────

/**
 * Every place that invokes `acr-firewall-lease.sh release|sweep`, as ONE
 * LOGICAL SHELL COMMAND.
 *
 * WHY THIS IS NOT A PER-LINE GREP ANY MORE (FINISHLINE C24, second pass). The
 * original version of this check tested each physical line for BOTH the
 * invocation and the `|| true`. Three real call sites were invisible to it, and
 * all three were genuinely discarding the verdict:
 *
 *   1. console-bluegreen-roll.yml — the `if: always()` SAFETY-NET release, with
 *      `|| true` on the shell CONTINUATION line:
 *          bash …/acr-firewall-lease.sh release \
 *            --acr "…" || true
 *      Two physical lines, so neither matched both halves of the rule. This was
 *      the highest-value site in the repo to get wrong: it runs exactly when the
 *      build died before its inline release.
 *   2/3. deploy-loom-uat-job.sh and provision-gh-runner.sh — `|| true` inside an
 *      EXIT trap. Invisible twice over: the scan only walked
 *      `.github/workflows/*.yml`, and the invocation is written
 *      `bash "$SCRIPT_DIR/acr-firewall-lease.sh" release`, whose closing quote
 *      defeats `acr-firewall-lease\.sh\s+(release|sweep)`.
 *
 * That is the guard-keyed-to-one-spelling failure this repo keeps repeating: the
 * rule matched the shape of the examples in front of it rather than the property
 * it means to enforce. So: scan workflows AND scripts, accept the quoted form,
 * and join continuations before testing.
 */
function leaseCallSites() {
  const root = resolve(HERE, '..', '..', '..');
  const files = [];
  const walk = (dir, filter) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, filter);
      else if (filter(e.name)) files.push(p);
    }
  };
  walk(join(root, '.github', 'workflows'), (n) => n.endsWith('.yml') || n.endsWith('.yaml'));
  walk(join(root, 'scripts'), (n) => n.endsWith('.sh'));

  // `.sh` optionally followed by a closing quote, then the subcommand.
  const INVOKE = /acr-firewall-lease\.sh["']?\s+(release|sweep)\b/;
  const sites = [];
  for (const p of files) {
    // The lease script itself documents these strings; it is not a call site.
    if (p.endsWith('acr-firewall-lease.sh')) continue;
    const lines = readFileSync(p, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!INVOKE.test(lines[i])) continue;
      if (/^\s*#/.test(lines[i])) continue; // a comment describing the rule
      let logical = lines[i];
      let k = i;
      while (/\\\s*$/.test(logical) && k + 1 < lines.length) {
        k += 1;
        logical = `${logical.replace(/\\\s*$/, '')} ${lines[k].trim()}`;
      }
      sites.push({ file: p.slice(root.length + 1).replace(/\\/g, '/'), line: i + 1, logical });
    }
  }
  return sites;
}

test('the call-site scan actually FINDS the known release/sweep invocations', () => {
  // A scanner that matches nothing passes every assertion below it. Pin that it
  // sees both spellings (bare and quoted) and both file kinds.
  const sites = leaseCallSites();
  assert.ok(sites.length >= 15, `expected the repo's release/sweep call sites, found ${sites.length}`);
  assert.ok(
    sites.some((s) => s.file.startsWith('.github/workflows/')),
    'must scan workflows',
  );
  assert.ok(
    sites.some((s) => s.file.startsWith('scripts/')),
    'must scan scripts/ too — two `|| true` sites hid there',
  );
  assert.ok(
    sites.some((s) => /acr-firewall-lease\.sh"\s+release/.test(s.logical)),
    'must match the quoted `"$SCRIPT_DIR/acr-firewall-lease.sh" release` form',
  );
});

test('no call site discards the verified-close verdict (`|| true` / output suppression)', () => {
  // The script can only fail loudly if the caller lets it. A discard here is not
  // a style nit — it is the C24 defect restored: a green step, or a script
  // exiting 0, over a registry that was never confirmed re-locked.
  //
  // Suppressing the OUTPUT is its own defect even when the exit code is kept:
  // `release` prints the concrete hand-remediation (deploy-integrity R6), and
  // preflight-image-tags.sh used `>/dev/null 2>&1` to throw exactly that away.
  // Match every spelling — `2>/dev/null`, `>/dev/null 2>&1`, `&>/dev/null` —
  // because keying a rule to the one spelling in front of you is how the
  // previous version of this guard missed three live call sites.
  const DISCARD = [
    /\|\|\s*true/, // exit code thrown away
    /2>\s*\/dev\/null/, // stderr thrown away
    />\s*\/dev\/null\s+2>&1/, // stdout+stderr thrown away
    /&>\s*\/dev\/null/, // bash shorthand for the same
  ];
  const offenders = leaseCallSites()
    .filter((s) => DISCARD.some((re) => re.test(s.logical)))
    .map((s) => `${s.file}:${s.line}: ${s.logical.trim()}`);
  assert.deepEqual(
    offenders,
    [],
    `these call sites discard the verified-close verdict:\n  ${offenders.join('\n  ')}`,
  );
});

test('no workflow step containing a release/sweep is marked continue-on-error', () => {
  // `continue-on-error: true` discards the verdict just as thoroughly as
  // `|| true`, and the original guard never looked for it at all.
  const wfDir = resolve(HERE, '..', '..', '..', '.github', 'workflows');
  const offenders = [];
  for (const f of readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
    const lines = readFileSync(join(wfDir, f), 'utf8').split('\n');
    // Split into steps on `- name:` / `- uses:` list items.
    let start = 0;
    const steps = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*-\s+(name|uses):/.test(lines[i])) {
        steps.push([start, i]);
        start = i;
      }
    }
    steps.push([start, lines.length]);
    for (const [a, b] of steps) {
      const body = lines.slice(a, b).join('\n');
      if (!/acr-firewall-lease\.sh["']?\s+(release|sweep)\b/.test(body)) continue;
      if (/^\s*continue-on-error:\s*true/m.test(body)) {
        offenders.push(`${f}: step at line ${a + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `these release/sweep steps are continue-on-error:\n  ${offenders.join('\n  ')}`);
});
