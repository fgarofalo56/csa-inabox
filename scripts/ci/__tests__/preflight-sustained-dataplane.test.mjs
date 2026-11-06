/**
 * preflight-image-tags.sh waits on the SUSTAINED data-plane probe after opening the registry (Gov run 42147678921).
 *
 * `az acr repository list` can answer before the firewall rule reaches the data plane (30-90 s). The preflight accepted
 * one success, then failed on the next probe 80 s after the open and stopped the deploy. The producers already wait on
 * acr-dataplane-gate.sh (N consecutive HTTP answers); the preflight now does too, and keeps the az read as the final,
 * honest check.
 *
 * SOURCE-TEXT PINS ONLY. Nothing here proves the gate behaves under a flapping registry; only a live run does.
 *
 * Run: node --test scripts/ci/__tests__/preflight-sustained-dataplane.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts/csa-loom/preflight-image-tags.sh'), 'utf8').replace(/\r\n/g, '\n');
const GATE_CALL = 'bash "$SCRIPT_DIR/../ci/acr-dataplane-gate.sh" --acr "$ACR" --timeout-seconds 180 --on-unconfirmed warn';

test('SUSTAINED PROBE: after acquiring the lease the preflight runs the HTTP-path gate BEFORE any az read loop', () => {
  // Breaks if: the gate call is deleted, or moved after the `data_plane_up` loop, which restores the one-success-is-enough
  // race that stopped Gov run 42147678921. Order is asserted by position, in the lease-acquired branch only.
  const acquired = SCRIPT.indexOf('LEASE_HELD="true"');
  assert.ok(acquired > 0, 'the lease-acquired branch must still exist');
  const gate = SCRIPT.indexOf(GATE_CALL, acquired);
  const loop = SCRIPT.indexOf('for _ in $(seq 1 12); do data_plane_up && break; sleep 15; done', acquired);
  assert.ok(gate > acquired, 'the sustained gate must be called after the lease is acquired');
  assert.ok(loop > gate, 'the az read loop must come AFTER the sustained gate');
  assert.ok(loop - gate < 900, 'the gate and the loop must stay adjacent (no unrelated code between them)');
});

test('SUSTAINED PROBE: the gate result is acted on, not discarded, and an unconfirmed plane still reaches the hard check', () => {
  // Breaks if: the gate is wrapped in `|| true` (deploy-integrity forbids discarding a result), or the final
  // `if ! data_plane_up` hard stop is removed (an unreachable registry would then be read as verified).
  const acquired = SCRIPT.indexOf('LEASE_HELD="true"');
  const block = SCRIPT.slice(acquired, acquired + 1800);
  assert.ok(/if ! bash "\$SCRIPT_DIR\/\.\.\/ci\/acr-dataplane-gate\.sh"[^\n]*; then\n\s+note "[^\n]*"\n\s+fi\n/.test(block), 'the gate must be an `if !` that notes an unconfirmed plane');
  assert.ok(!/acr-dataplane-gate\.sh[^\n]*\|\| true/.test(block), 'the gate result must not be discarded with `|| true`');
  const finalCheck = SCRIPT.indexOf('if ! data_plane_up; then', acquired);
  assert.ok(finalCheck > acquired, 'the final data_plane_up hard check must still exist after the wait');
  assert.ok(SCRIPT.slice(finalCheck, finalCheck + 2500).includes('exit 1'), 'the hard check must still exit 1');
});

test('SUSTAINED PROBE: the gate script the preflight calls exists and takes the flags used', () => {
  // Breaks if: the gate is renamed or loses a flag (the call would error and, under `if !`, quietly degrade to the old
  // behaviour). The executable bit is deliberately NOT asserted: every caller runs `bash <path>` and git stores these
  // scripts as 100644, so an exec-bit check can only pass on Windows (it failed on Linux CI in the first cut).
  const gatePath = path.join(ROOT, 'scripts/ci/acr-dataplane-gate.sh');
  assert.ok(fs.existsSync(gatePath), 'scripts/ci/acr-dataplane-gate.sh must exist');
  const gate = fs.readFileSync(gatePath, 'utf8');
  for (const flag of ['--acr', '--timeout-seconds', '--on-unconfirmed']) assert.ok(gate.includes(flag), `the gate must accept ${flag}`);
});
