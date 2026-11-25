// Tests for scripts/ci/kv-secret-sync-plan.mjs — the decision logic behind
// .github/workflows/ops-kv-secret-sync.yml (#5483: runner-PAT expiry tracking).
//
// Each test names the value that would break it (assertion-design.md). The
// workflow-wiring tests at the bottom LIFT the calls out of the workflow file
// rather than trusting that the workflow uses this module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceGroup, validateExpiresOn, expiryMatches, effectiveExpiry } from '../kv-secret-sync-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'kv-secret-sync-plan.mjs');
const WORKFLOW = path.join(here, '..', '..', '..', '.github', 'workflows', 'ops-kv-secret-sync.yml');

// Fixed clock: 2026-11-25T12:00:00Z. "Today" is therefore 2026-11-25.
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

test('a past date is refused (breaks if the future check is dropped or inverted)', () => {
  const r = validateExpiresOn('2026-11-24', NOW);
  assert.equal(r.ok, false, '2026-11-24 is yesterday relative to NOW and must be refused');
  assert.match(r.reason, /not after today's UTC date 2026-11-25/);
});

test("today's date is refused (breaks if the comparison is `<` instead of `<=`)", () => {
  // 00:00Z today is already 12 h in the past at NOW.
  assert.equal(validateExpiresOn('2026-11-25', NOW).ok, false);
});

test('tomorrow is accepted and stamped at 00:00:00Z (positive pair for the two refusals above)', () => {
  assert.deepEqual(validateExpiresOn('2026-11-26', NOW), { ok: true, iso: '2026-11-26T00:00:00Z' });
});

test('a malformed date is refused (breaks if the YYYY-MM-DD anchor is loosened)', () => {
  for (const bad of ['2027-1-31', '31/01/2027', '2027-01-31T00:00:00Z', ' 2027-01-31x', '20270131']) {
    const r = validateExpiresOn(bad, NOW);
    assert.equal(r.ok, false, `'${bad}' must be refused`);
    assert.match(r.reason, /does not match YYYY-MM-DD/, `'${bad}' must be refused for its FORMAT`);
  }
});

test('an impossible calendar date is refused (breaks if the Date.UTC round-trip is removed: 2027-02-30 rolls to 03-02)', () => {
  const r = validateExpiresOn('2027-02-30', NOW);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a real calendar date/);
});

test('an empty expires_on means "no expiry requested", not an error (breaks if blank is treated as malformed)', () => {
  assert.deepEqual(validateExpiresOn('', NOW), { ok: true, iso: null });
});

test('job selects the job command group and containerapp the app group (breaks if the map is swapped)', () => {
  assert.deepEqual(sourceGroup('job'), ['containerapp', 'job']);
  assert.deepEqual(sourceGroup('containerapp'), ['containerapp']);
});

test('an unknown source kind is refused (breaks if lookup falls back to a default or reads the prototype)', () => {
  assert.throws(() => sourceGroup('jobs'), /not one of: containerapp, job/);
  assert.throws(() => sourceGroup('toString'), /not one of/);
});

test('read-back compares instants, not strings (az prints +00:00; breaks on a string equality)', () => {
  assert.equal(expiryMatches('2027-01-31T00:00:00Z', '2027-01-31T00:00:00+00:00'), true);
  assert.equal(expiryMatches('2027-01-31T00:00:00Z', '2027-01-30T00:00:00+00:00'), false, 'a day off must fail');
  assert.equal(expiryMatches('2027-01-31T00:00:00Z', ''), false, 'a missing expiry (no exp attribute) must fail');
});

test('blank input with an existing expiry => carried forward (breaks if a blank input returns null and erases the stamp)', () => {
  assert.deepEqual(effectiveExpiry('', '2027-01-31T00:00:00+00:00'), { iso: '2027-01-31T00:00:00Z', source: 'carried' });
  assert.deepEqual(effectiveExpiry(null, '2027-01-31T00:00:00+00:00'), { iso: '2027-01-31T00:00:00Z', source: 'carried' });
});

test('a requested expiry wins over the current one (breaks if carry-forward overrides an explicit input)', () => {
  assert.deepEqual(effectiveExpiry('2027-06-01T00:00:00Z', '2027-01-31T00:00:00+00:00'), { iso: '2027-06-01T00:00:00Z', source: 'input' });
});

test('blank input and no current expiry => none (breaks if an absent/garbage expiry is invented)', () => {
  assert.deepEqual(effectiveExpiry('', ''), { iso: null, source: 'none' });
  assert.deepEqual(effectiveExpiry('', 'None'), { iso: null, source: 'none' });
});

test('CLI exit codes: refusal is 2, mismatch is 1 (breaks if the workflow could read a refusal as success)', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  assert.equal(run('expiry', '2000-01-01').status, 2);
  assert.equal(run('source-group', 'nope').status, 2);
  const ok = run('source-group', 'job');
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'containerapp job');
  assert.equal(run('check-exp', '2027-01-31T00:00:00Z', '2027-02-01T00:00:00+00:00').status, 1);
  assert.equal(run('check-exp', '2027-01-31T00:00:00Z', '2027-01-31T00:00:00+00:00').status, 0);
});

// ---- workflow wiring (lifted from the file, not transcribed) ----------------
const wf = readFileSync(WORKFLOW, 'utf8');

test('the workflow validates expires_on BEFORE the first Key Vault write (breaks if the check moves after `secret set`)', () => {
  const check = wf.indexOf('kv-secret-sync-plan.mjs expiry');
  const write = wf.indexOf('az keyvault secret set');
  assert.ok(check > 0, 'the workflow no longer calls the expiry check');
  assert.ok(write > 0, 'the workflow no longer writes the vault');
  assert.ok(check < write, 'expiry must be validated before the vault is written');
});

test('the workflow reads the source through the selected command group and verifies the expiry read-back', () => {
  assert.match(wf, /kv-secret-sync-plan\.mjs source-group "\$SOURCE_KIND"/);
  assert.match(wf, /az "\$\{GROUP\[@\]\}" secret list/, 'the secret read must use the selected group, not a hard-coded `containerapp`');
  assert.match(wf, /--query attributes\.expires/, 'the read-back must query the expiry ATTRIBUTE');
  assert.match(wf, /kv-secret-sync-plan\.mjs check-exp/);
});

// The body of ONE workflow_dispatch input: the lines after `      <name>:` that
// are indented deeper than the key, stopping at the next input key. CRLF-safe.
function inputBlock(name) {
  const lines = wf.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `      ${name}:`);
  assert.ok(start >= 0, `input '${name}' not found in the workflow`);
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (!/^ {8,}\S/.test(l)) break;
    body.push(l);
  }
  return body.join('\n');
}

test('existing containerapp defaults are unchanged (breaks if a default moved; each match is bounded to its own input block)', () => {
  assert.match(inputBlock('source_kind'), /default: 'containerapp'/);
  assert.match(inputBlock('containerapp'), /default: 'loom-console'/);
  assert.match(inputBlock('aca_secret'), /default: 'loom-msal-client-secret'/);
  assert.match(inputBlock('kv_secret'), /default: 'loom-msal-client-secret'/);
  // Bounding control: the aca_secret block must not run on into kv_secret.
  assert.doesNotMatch(inputBlock('aca_secret'), /Key Vault secret name/);
  assert.match(inputBlock('kv_secret'), /Key Vault secret name/);
});

test('the vault write passes the expiry argument through (breaks if "${EXP_ARGS[@]}" is dropped from `secret set`)', () => {
  const setLine = wf.split(/\r?\n/).find((l) => /az keyvault secret set /.test(l));
  assert.ok(setLine, 'no `az keyvault secret set` line in the workflow');
  assert.ok(setLine.includes('"${EXP_ARGS[@]}"'), `secret set does not pass the expiry: ${setLine.trim()}`);
  assert.match(wf, /EXP_ARGS=\(--expires "\$EXP_ISO"\)/, 'EXP_ARGS no longer carries --expires "$EXP_ISO"');
});

test('a blank expires_on carries the current expiry forward in the workflow (breaks if the carry-forward call is removed)', () => {
  const carry = wf.indexOf('kv-secret-sync-plan.mjs effective-exp');
  const write = wf.indexOf('az keyvault secret set');
  assert.ok(carry > 0 && carry < write, 'effective-exp must run before the vault write');
  assert.match(wf, /az keyvault secret list --vault-name "\$KV" \\\r?\n\s+--query "\[\?name=='\$KV_SECRET'\]\.attributes\.expires \| \[0\]"/);
});
