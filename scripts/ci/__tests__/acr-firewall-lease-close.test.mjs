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

test('no workflow appends `|| true` to an acr-firewall-lease release/sweep', () => {
  // The script can only fail loudly if the caller lets it. Two workflows used to
  // swallow it (gov-console-roll, gov-provision-dbx-sql-invnet) — with the
  // verified close in place, that `|| true` would restore the whole defect.
  const wfDir = resolve(HERE, '..', '..', '..', '.github', 'workflows');
  const offenders = [];
  for (const f of readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
    const body = readFileSync(join(wfDir, f), 'utf8');
    for (const line of body.split('\n')) {
      if (!/acr-firewall-lease\.sh\s+(release|sweep)/.test(line)) continue;
      if (/\|\|\s*true/.test(line) || /2>\s*\/dev\/null/.test(line)) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these call sites discard the verified-close verdict:\n  ${offenders.join('\n  ')}`,
  );
});
