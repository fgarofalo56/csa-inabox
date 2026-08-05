/**
 * deploy-template-sync self-test (#2945).
 *
 * The guard itself is the real test: it compiles the actual bicep and
 * byte-compares. This suite pins the parts of it that a compile in CI does NOT
 * exercise — the version pinning that makes the comparison deterministic, the
 * classification of a failure, and the refuse-to-pass-vacuously branches.
 *
 * FIXTURES ARE REAL BYTES, NOT A GUESS. On 2026-08-04 the two constants below
 * were produced by RUNNING the real tools and capturing their actual output:
 *
 *   REAL_TEMPLATE_B64 = base64 of the file written by
 *       az bicep build -f <a 17-line subscription-scoped .bicep> --outfile x.json
 *     with bicep CLI 0.45.15. Kept base64 so the bytes survive any checkout,
 *     CRLF or LF — a template literal in this file would not, and EOL handling
 *     is precisely what is under test.
 *
 *   REAL_AZ_BICEP_VERSION_STDOUT = the literal STDOUT of `az bicep version`,
 *     including its DOUBLE carriage return. Nobody would write '\r\r\n' from
 *     imagination, which is the point: the 2026-08-03 lesson in this repo is a
 *     hand-written `az` fixture that modelled the code's assumptions instead of
 *     the tool's real output, so a deploy-breaking bug shipped past its own
 *     guard. The upgrade-available WARNING goes to STDERR and is captured
 *     separately below so a parser cannot accidentally read it as a version.
 *
 * MUTATION-PROVEN. The tempting shortcut for the version drift measured in the
 * guard's header (bicep 0.45.15 vs 0.46.1 differ in 840 lines, ALL of them
 * `_generator.version`/`templateHash`) is to mask those fields instead of
 * pinning the compiler. `a whitespace-only change is a CONTENT difference` and
 * `a templateHash change is a CONTENT difference` both go RED under any
 * comparator that canonicalises JSON or masks `_generator`, while
 * `identical bytes compare equal` stays green either way — so a normalising
 * comparator cannot hide behind the happy path.
 *
 * Run: node --test scripts/ci/__tests__/deploy-template-sync.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACTS,
  assertLooksLikeArmTemplate,
  compareArtifacts,
  countEscapedCrlf,
  discoverDeployTemplates,
  parseBicepCliVersion,
  parseGeneratorVersion,
} from '../check-deploy-template-sync.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Real `az bicep build` output (bicep 0.45.15), base64 of the exact bytes. */
const REAL_TEMPLATE_B64 = [
  'ewogICIkc2NoZW1hIjogImh0dHBzOi8vc2NoZW1hLm1hbmFnZW1lbnQuYXp1cmUuY29tL3NjaGVtYXMvMjAxOC0wNS0wMS9z',
  'dWJzY3JpcHRpb25EZXBsb3ltZW50VGVtcGxhdGUuanNvbiMiLAogICJjb250ZW50VmVyc2lvbiI6ICIxLjAuMC4wIiwKICAi',
  'bWV0YWRhdGEiOiB7CiAgICAiX2dlbmVyYXRvciI6IHsKICAgICAgIm5hbWUiOiAiYmljZXAiLAogICAgICAidmVyc2lvbiI6',
  'ICIwLjQ1LjE1LjI3MjEwIiwKICAgICAgInRlbXBsYXRlSGFzaCI6ICIxODMyMTg1OTMzOTYzMTQwMTAxMyIKICAgIH0KICB9',
  'LAogICJwYXJhbWV0ZXJzIjogewogICAgInJnTmFtZSI6IHsKICAgICAgInR5cGUiOiAic3RyaW5nIiwKICAgICAgImRlZmF1',
  'bHRWYWx1ZSI6ICJsb29tLWZpeHR1cmUtcmciLAogICAgICAibWV0YWRhdGEiOiB7CiAgICAgICAgImRlc2NyaXB0aW9uIjog',
  'IlJlc291cmNlIGdyb3VwIG5hbWUuIgogICAgICB9CiAgICB9LAogICAgImxvY2F0aW9uIjogewogICAgICAidHlwZSI6ICJz',
  'dHJpbmciLAogICAgICAiZGVmYXVsdFZhbHVlIjogIltkZXBsb3ltZW50KCkubG9jYXRpb25dIiwKICAgICAgIm1ldGFkYXRh',
  'IjogewogICAgICAgICJkZXNjcmlwdGlvbiI6ICJMb2NhdGlvbi4iCiAgICAgIH0KICAgIH0KICB9LAogICJyZXNvdXJjZXMi',
  'OiBbCiAgICB7CiAgICAgICJ0eXBlIjogIk1pY3Jvc29mdC5SZXNvdXJjZXMvcmVzb3VyY2VHcm91cHMiLAogICAgICAiYXBp',
  'VmVyc2lvbiI6ICIyMDI0LTAzLTAxIiwKICAgICAgIm5hbWUiOiAiW3BhcmFtZXRlcnMoJ3JnTmFtZScpXSIsCiAgICAgICJs',
  'b2NhdGlvbiI6ICJbcGFyYW1ldGVycygnbG9jYXRpb24nKV0iLAogICAgICAidGFncyI6IHsKICAgICAgICAicHVycG9zZSI6',
  'ICJjaS1maXh0dXJlIgogICAgICB9CiAgICB9CiAgXSwKICAib3V0cHV0cyI6IHsKICAgICJyZ0lkIjogewogICAgICAidHlw',
  'ZSI6ICJzdHJpbmciLAogICAgICAidmFsdWUiOiAiW3N1YnNjcmlwdGlvblJlc291cmNlSWQoJ01pY3Jvc29mdC5SZXNvdXJj',
  'ZXMvcmVzb3VyY2VHcm91cHMnLCBwYXJhbWV0ZXJzKCdyZ05hbWUnKSldIgogICAgfQogIH0KfQ==',
].join('');

const REAL = Buffer.from(REAL_TEMPLATE_B64, 'base64');

/** Literal STDOUT of `az bicep version` — note the double CR. */
const REAL_AZ_BICEP_VERSION_STDOUT = 'Bicep CLI version 0.45.15 (6a4a640fd8)\r\r\n\r\n';
/** Literal STDERR of the same invocation. Not a version; must never be parsed as one. */
const REAL_AZ_BICEP_VERSION_STDERR =
  'WARNING: A new Bicep release is available: v0.46.1. Upgrade now by running "az bicep upgrade".\r\n';

/** @param {Buffer} b @param {string} from @param {string} to */
function mutate(b, from, to) {
  const s = b.toString('utf8');
  assert.ok(s.includes(from), `fixture does not contain ${from} — the mutation would prove nothing`);
  return Buffer.from(s.replace(from, to), 'utf8');
}

// ── the fixture really is real ───────────────────────────────────────────────

test('the fixture is genuine az bicep build output, not a hand-written shape', () => {
  const parsed = JSON.parse(REAL.toString('utf8'));
  assert.match(parsed.$schema, /subscriptionDeploymentTemplate\.json#$/);
  assert.equal(parsed.metadata._generator.name, 'bicep');
  // Four-part build number: bicep stamps this, a human writing a fixture would
  // have written the three-part CLI version.
  assert.match(parsed.metadata._generator.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(parsed.metadata._generator.templateHash, /^\d+$/);
  // LF, and NO trailing newline — az bicep build's actual byte habit.
  assert.equal(REAL.includes(Buffer.from('\r\n')), false);
  assert.equal(REAL.subarray(-1).toString(), '}');
});

// ── version pinning (what makes the byte comparison deterministic) ───────────

test('parseGeneratorVersion maps the 4-part stamp to the 3-part installable CLI version', () => {
  const v = parseGeneratorVersion(REAL);
  assert.equal(v.stamped, '0.45.15.27210');
  assert.equal(v.cli, 'v0.45.15');
});

test('parseGeneratorVersion works on a Buffer and on a string', () => {
  assert.equal(parseGeneratorVersion(REAL.toString('utf8')).cli, 'v0.45.15');
});

test('parseGeneratorVersion THROWS when the stamp is absent — it never guesses a version', () => {
  // Compiling with a different compiler than the artifact declares would compare
  // two things that were never comparable, and report a verdict about it.
  const stripped = Buffer.from(JSON.stringify({ $schema: 'x', resources: [] }), 'utf8');
  assert.throws(() => parseGeneratorVersion(stripped), /no metadata\._generator\.version/);
});

test('parseBicepCliVersion reads the REAL stdout, double CR and all', () => {
  assert.equal(parseBicepCliVersion(REAL_AZ_BICEP_VERSION_STDOUT), '0.45.15');
});

test('parseBicepCliVersion does not mistake the upgrade WARNING for a version', () => {
  // The warning names v0.46.1. A parser that scanned stderr — or that grepped
  // for any version-shaped token — would pin the WRONG compiler and then
  // byte-compare two incomparable outputs.
  assert.equal(parseBicepCliVersion(REAL_AZ_BICEP_VERSION_STDERR), null);
});

test('parseBicepCliVersion returns null when bicep is not installed (empty stdout)', () => {
  assert.equal(parseBicepCliVersion(''), null);
  assert.equal(parseBicepCliVersion(undefined), null);
});

// ── the comparator: byte-exact verdict, classification only afterwards ───────

test('identical bytes compare equal', () => {
  const cmp = compareArtifacts(REAL, Buffer.from(REAL));
  assert.equal(cmp.equal, true);
  assert.equal(cmp.reason, 'identical');
});

test('MUTATION: one changed emitted value is a CONTENT difference and is NAMED', () => {
  const mutated = mutate(REAL, 'loom-fixture-rg', 'loom-fixture-rg-DRIFTED');
  const cmp = compareArtifacts(mutated, REAL);
  assert.equal(cmp.equal, false);
  assert.equal(cmp.reason, 'content');
  const report = cmp.report.join('\n');
  assert.match(report, /First divergence at line \d+/);
  assert.match(report, /loom-fixture-rg-DRIFTED/);
  assert.match(report, /Multiset difference: 1 line\(s\)/);
});

test('MUTATION: a templateHash change alone is a CONTENT difference — nothing is masked', () => {
  // This is the anti-over-normalization test. bicep's _generator fields are the
  // ONLY thing that varies between CLI versions (840 lines, measured), so the
  // tempting fix is to mask them. Masking would make this pass.
  const mutated = mutate(REAL, '18321859339631401013', '99999999999999999999');
  const cmp = compareArtifacts(mutated, REAL);
  assert.equal(cmp.equal, false);
  assert.equal(cmp.reason, 'content');
});

test('MUTATION: a _generator.version change alone is a CONTENT difference', () => {
  const mutated = mutate(REAL, '0.45.15.27210', '0.46.1.21595');
  assert.equal(compareArtifacts(mutated, REAL).reason, 'content');
});

test('MUTATION: a whitespace-only change is a CONTENT difference — the comparator never reparses JSON', () => {
  // Semantically identical JSON, different bytes. A comparator that did
  // JSON.parse/stringify round-tripping (or key sorting) would call this equal
  // and would then also swallow a real re-ordering emitted by a new bicep.
  const mutated = mutate(REAL, '  "contentVersion"', '   "contentVersion"');
  const cmp = compareArtifacts(mutated, REAL);
  assert.equal(cmp.equal, false);
  assert.equal(cmp.reason, 'content');
});

test('a CRLF copy FAILS, classified as eol — it is never normalized into a pass', () => {
  const crlf = Buffer.from(REAL.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
  const cmp = compareArtifacts(crlf, REAL);
  assert.equal(cmp.equal, false, 'an EOL-only difference must still FAIL');
  assert.equal(cmp.reason, 'eol');
  assert.match(cmp.report.join('\n'), /git add --renormalize/);
});

test('a CRLF copy that ALSO has a content change is classified as content, not eol', () => {
  // The dangerous confusion: an EOL-only message invites "just renormalize",
  // which would leave the content drift in place.
  const both = Buffer.from(
    mutate(REAL, 'ci-fixture', 'ci-fixture-DRIFTED').toString('utf8').replace(/\n/g, '\r\n'),
    'utf8',
  );
  const cmp = compareArtifacts(both, REAL);
  assert.equal(cmp.equal, false);
  assert.equal(cmp.reason, 'content');
});

// ── embedded CRLF (the defect this guard found on its first real CI run) ─────

/**
 * A VERBATIM 180-byte slice of the artifact that was committed on main before
 * this PR — cut out of the real file, not written by hand. It is the shape the
 * guard caught: bicep copied a CRLF .bicep source's line endings straight into a
 * deploymentScript's bash. base64 so the bytes cannot be rewritten by a checkout.
 */
const REAL_DEFECTIVE_SLICE_B64 = [
  'InNjcmlwdENvbnRlbnQiOiAic2V0IC1ldW8gcGlwZWZhaWxcclxuR1JBUEhfUkE9J1t7XCJyZXNvdXJjZUFwcElkXCI6XCIw',
  'MDAwMDAwMy0wMDAwLTAwMDAtYzAwMC0wMDAwMDAwMDAwMDBcIixcInJlc291cmNlQWNjZXNzXCI6W3tcImlkXCI6XCJlMWZl',
  'NmRkOC1iYTMxLTRkNjEtODllNy04ODYzOWRhNDY4M2RcIixc',
].join('');
const REAL_DEFECTIVE = Buffer.from(REAL_DEFECTIVE_SLICE_B64, 'base64');

test('the defective slice really is the shipped shape: CRLF bash in a deploymentScript', () => {
  const s = REAL_DEFECTIVE.toString('utf8');
  assert.match(s, /"scriptContent": "set -euo pipefail/);
  // The four characters backslash-r-backslash-n, INSIDE a JSON string value.
  assert.ok(s.includes(String.raw`\r\n`));
  // …and the file itself has no real CRLF — this is not a line-ending problem
  // with the JSON, it is CRLF *content* embedded in a value.
  assert.equal(REAL_DEFECTIVE.includes(Buffer.from('\r\n')), false);
});

test('countEscapedCrlf finds the embedded CRLF in the real defective bytes', () => {
  assert.equal(countEscapedCrlf(REAL_DEFECTIVE), 1);
});

test('countEscapedCrlf is ZERO on real LF bicep output', () => {
  assert.equal(countEscapedCrlf(REAL), 0);
});

test('countEscapedCrlf does not count a real CRLF, only the escaped form', () => {
  // A file whose own line endings are CRLF is the `eol` case, handled by
  // compareArtifacts. Conflating the two would send the developer to the wrong fix.
  const crlfFile = Buffer.from(REAL.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
  assert.equal(countEscapedCrlf(crlfFile), 0);
  assert.equal(compareArtifacts(crlfFile, REAL).reason, 'eol');
});

test('countEscapedCrlf handles empty input without throwing', () => {
  assert.equal(countEscapedCrlf(Buffer.alloc(0)), 0);
});

// ── refuse-to-pass-vacuously ─────────────────────────────────────────────────

test('assertLooksLikeArmTemplate accepts the real output', () => {
  assertLooksLikeArmTemplate(REAL, 'fixture');
});

test('assertLooksLikeArmTemplate rejects empty / invalid / non-ARM output', () => {
  // `az bicep build` exiting 0 while producing nothing usable is an observed
  // failure mode in this repo. Without these the guard would compare two empty
  // buffers and report success.
  assert.throws(() => assertLooksLikeArmTemplate(Buffer.alloc(0), 'x'), /is empty/);
  assert.throws(() => assertLooksLikeArmTemplate(Buffer.from('{'), 'x'), /not valid JSON/);
  assert.throws(() => assertLooksLikeArmTemplate(Buffer.from('[]'), 'x'), /\$schema/);
  assert.throws(
    () => assertLooksLikeArmTemplate(Buffer.from(JSON.stringify({ $schema: 'https://example/x.json' })), 'x'),
    /\$schema/,
  );
  assert.throws(
    () =>
      assertLooksLikeArmTemplate(
        Buffer.from(JSON.stringify({ $schema: 'https://x/deploymentTemplate.json#' })),
        'x',
      ),
    /no "resources"/,
  );
});

test('assertLooksLikeArmTemplate accepts BOTH ARM scopes (the sub-scope form capitalises the D)', () => {
  const rg = { $schema: 'https://x/2019-04-01/deploymentTemplate.json#', resources: [] };
  const sub = { $schema: 'https://x/2018-05-01/subscriptionDeploymentTemplate.json#', resources: [] };
  assertLooksLikeArmTemplate(Buffer.from(JSON.stringify(rg)), 'rg');
  assertLooksLikeArmTemplate(Buffer.from(JSON.stringify(sub)), 'sub');
});

// ── coverage: a second unguarded compiled artifact is the same bug ───────────

test('ARTIFACTS is non-empty and every entry points at files that exist', () => {
  assert.ok(ARTIFACTS.length > 0, 'an empty table would check nothing');
  for (const e of ARTIFACTS) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, e.artifact)), `${e.artifact} missing`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, e.source)), `${e.source} missing`);
    assert.ok(e.why && e.why.length > 20, `${e.artifact} needs a stated reason it ships`);
  }
});

test('every compiled template on disk is declared — discovery finds the known one', () => {
  const found = discoverDeployTemplates(REPO_ROOT);
  assert.ok(
    found.includes('apps/fiab-console/deploy-templates/main.json'),
    `discovery must see the shipped template; saw ${JSON.stringify(found)}`,
  );
  const declared = new Set(ARTIFACTS.map((a) => a.artifact));
  const undeclared = found.filter((f) => !declared.has(f));
  assert.deepEqual(undeclared, [], 'a committed compiled template that no ARTIFACTS entry covers');
});

test('discovery returns nothing for a tree with no deploy-templates dir (no phantom coverage)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dts-'));
  try {
    fs.mkdirSync(path.join(tmp, 'apps', 'thing'), { recursive: true });
    assert.deepEqual(discoverDeployTemplates(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('discovery FINDS a newly added compiled template (so the coverage check can fail)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dts-'));
  try {
    const dir = path.join(tmp, 'apps', 'newapp', 'deploy-templates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'main.json'), REAL);
    assert.deepEqual(discoverDeployTemplates(tmp), ['apps/newapp/deploy-templates/main.json']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
