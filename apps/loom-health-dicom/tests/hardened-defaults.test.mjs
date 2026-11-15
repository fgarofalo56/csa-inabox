// Static + behavioural contract for the loom-health-dicom hardened defaults (LHDS W3-1).
//   node --test apps/loom-health-dicom/tests/
// No docker, no cluster. The live proof (unregistered AE refused, 11112 closed) is
// scripts/verify-image.sh; this file is what stops the defaults being loosened in review.
//
// assertion-design.md: every test names the input that breaks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(APP, '..', '..');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const harden = read(join(APP, 'ldap/harden.sh'));
const values = read(join(APP, 'chart/values.yaml'));
const helpers = read(join(APP, 'chart/templates/_helpers.tpl'));
const archive = read(join(APP, 'chart/templates/workloads.tpl'));

// Lift the enforcement flag NAME from the source of truth (harden.sh), never transcribe it:
// the line is `<NAME>="${<NAME>:-true}"` and the name ends in ENFORCE.
const enforceLine = harden.match(/^([A-Z0-9_]*ENFORCE)="\$\{\1:-(true|false)\}"$/m);
assert.ok(enforceLine, 'harden.sh has no <X>ENFORCE="${<X>ENFORCE:-default}" line: AE enforcement flag is absent');
const FLAG = enforceLine[1];

test('the AE enforcement flag defaults to true in harden.sh', () => {
  // BREAKS when: the default is edited to :-false (enforcement silently off for every deploy).
  assert.equal(enforceLine[2], 'true');
});

test('the chart passes the lifted flag to the hardening container, from values, default true', () => {
  // BREAKS when: the helper stops emitting the flag (grep -c would read 0), it is hard-coded to
  // "false", or values.yaml hardening.aeEnforce is flipped to false.
  const m = helpers.match(new RegExp(`name: ${FLAG}, value: \\{\\{ (\\.Values\\.[A-Za-z.]+) \\| quote \\}\\}`));
  assert.ok(m, `_helpers.tpl does not pass ${FLAG} from a .Values path`);
  assert.equal(m[1], '.Values.hardening.aeEnforce');
  assert.match(values, /^ {2}aeEnforce: true$/m);
  assert.match(archive, /include "lhd\.hardenEnv"/, 'the initContainer must consume the helper that carries the flag');
});

test('the chart refuses to render with enforcement off unless explicitly overridden', () => {
  // BREAKS when: the fail guard is deleted, or allowUnenforced defaults to true.
  assert.match(archive, /and \(not \.Values\.hardening\.aeEnforce\) \(not \.Values\.hardening\.allowUnenforced\)/);
  assert.match(values, /^ {2}allowUnenforced: false$/m);
});

test('DIMSE is off: harden.sh default, chart default, and no 11112 outside the dimseEnabled branch', () => {
  // BREAKS when: DIMSE_ENABLED default becomes true, values dimseEnabled becomes true, or an
  // unconditional 11112 port/Service entry is added to the template.
  assert.match(harden, /^DIMSE_ENABLED="\$\{DIMSE_ENABLED:-false\}"$/m);
  assert.match(values, /^ {2}dimseEnabled: false$/m);
  const lines = archive.split('\n');
  lines.forEach((l, i) => {
    if (!l.includes('11112')) return;
    const guard = lines.slice(Math.max(0, i - 2), i).join('\n');
    assert.match(guard, /if \.Values\.hardening\.dimseEnabled/, `line ${i + 1}: 11112 outside the dimseEnabled guard`);
  });
  assert.ok(lines.some((l) => l.includes('11112')), 'positive control: the opt-in 11112 port must still exist');
  assert.doesNotMatch(read(join(APP, 'Dockerfile')), /EXPOSE\s+.*11112/);
});

test('HL7 authentication defaults on, with a non-empty sender allow-list', () => {
  // BREAKS when: HL7_AUTH default flips to false, or the default allow-list is emptied.
  assert.match(harden, /^HL7_AUTH="\$\{HL7_AUTH:-true\}"$/m);
  assert.match(harden, /^HL7_ALLOWED_SENDING="\$\{HL7_ALLOWED_SENDING:-[^}|]+\|[^}]+\}"$/m);
  assert.match(values, /^ {2}hl7Auth: true$/m);
});

test('image pins: both Dockerfiles are digest-pinned and the archive is >= 5.35.2', () => {
  // BREAKS when: FROM uses a tag, the digest is not 64 hex, or the version label drops below 5.35.2
  // (the CISA ICSMA-26-288-02 fix) or disagrees with the tag the W0 recipe measured.
  const arc = read(join(APP, 'Dockerfile'));
  const ldap = read(join(APP, 'ldap/Dockerfile'));
  assert.match(arc, /^FROM dcm4che\/dcm4chee-arc-psql@sha256:[0-9a-f]{64}$/m);
  assert.match(ldap, /^FROM dcm4che\/slapd-dcm4chee@sha256:[0-9a-f]{64}$/m);
  const ver = arc.match(/ai\.loom\.health\.dcm4chee-version="(\d+)\.(\d+)\.(\d+)"/);
  assert.ok(ver, 'arc Dockerfile lacks the dcm4chee-version label');
  const [maj, min, pat] = ver.slice(1).map(Number);
  assert.ok(maj > 5 || (maj === 5 && (min > 35 || (min === 35 && pat >= 2))), `version ${ver[0]} is below 5.35.2`);
  const w0 = read(join(ROOT, 'scripts/measure/health/dicom-engine-deploy.sh')).match(
    /LHDS_ARC_IMAGE:-dcm4che\/dcm4chee-arc-psql:(\d+\.\d+\.\d+)/,
  );
  assert.ok(w0, 'could not lift the W0 arc tag from dicom-engine-deploy.sh');
  assert.equal(`${maj}.${min}.${pat}`, w0[1]);
  assert.equal(read(join(APP, 'chart/Chart.yaml')).match(/^appVersion: "([^"]+)"$/m)?.[1], w0[1]);
});

// ---- behavioural: run harden.sh against stub LDAP tools and read what it would write ----
const sh = spawnSync('sh', ['-c', 'exit 0']);
const haveSh = sh.status === 0;
function runHarden(env) {
  const dir = mkdtempSync(join(tmpdir(), 'lhd-stub-'));
  try {
    const out = join(dir, 'written.ldif');
    const stub = (name, body) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
    // ldapmodify: capture the -f file. ldapsearch: wait-loop probe (last arg "dn") -> a dn line;
    // read-back (last arg = attribute) -> the attribute lines that were written.
    stub('ldapmodify', `while [ $# -gt 0 ]; do [ "$1" = -f ] && cp "$2" "${out.replace(/\\/g, '/')}"; shift; done`);
    stub('ldapsearch', `for last; do :; done; if [ "$last" = dn ]; then echo "dn: x"; else grep "^$last:" "${out.replace(/\\/g, '/')}" || true; fi`);
    const r = spawnSync('sh', [join(APP, 'ldap/harden.sh')], {
      env: { ...process.env, PATH: dir + delimiter + process.env.PATH, LDAP_ROOTPASS: 'stub', ...env },
      encoding: 'utf8',
    });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, ldif: existsSync(out) ? read(out) : '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('harden.sh defaults write the allow-list and strip the DIMSE port', { skip: !haveSh && 'no sh on PATH' }, () => {
  // BREAKS when: the default run omits dcmAcceptedCallingAETitle / hl7AcceptedSendingApplication,
  // or writes any dicomPort value (a listener would bind).
  const r = runHarden({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.ldif, /^dcmAcceptedCallingAETitle: LOOMGW$/m);
  assert.match(r.ldif, /^hl7AcceptedSendingApplication: LOOMGW\|LOOM$/m);
  assert.match(r.ldif, /^replace: dicomPort\n(\n|$)/m, 'dicomPort must be replaced with NO value');
  assert.doesNotMatch(r.ldif, /^dicomPort:/m);
});

test(`harden.sh with ${FLAG}=false removes the allow-list (mutation arm: the default test above would fail)`, { skip: !haveSh && 'no sh on PATH' }, () => {
  // BREAKS when: the flag stops controlling the allow-list. Paired with the default test, so
  // deleting the feature cannot satisfy both.
  const r = runHarden({ [FLAG]: 'false' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.ldif, /^dcmAcceptedCallingAETitle: /m);
  assert.match(r.ldif, /^replace: dcmAcceptedCallingAETitle$/m);
});

test('harden.sh rejects a non-boolean flag value rather than treating it as off', { skip: !haveSh && 'no sh on PATH' }, () => {
  // BREAKS when: ENFORCE=yes (or an empty/garbled value) is accepted silently.
  const r = runHarden({ [FLAG]: 'yes' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`${FLAG} must be true or false`));
  assert.equal(r.ldif, '', 'nothing may be written when the flag is invalid');
});

test('harden.sh with DIMSE_ENABLED=true writes the DICOM ports (positive control for the strip)', { skip: !haveSh && 'no sh on PATH' }, () => {
  // BREAKS when: the DIMSE opt-in stops writing 11112, which would make the default
  // "no dicomPort" assertion above satisfiable by deleting the port logic.
  const r = runHarden({ DIMSE_ENABLED: 'true' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.ldif, /^dicomPort: 11112$/m);
});

// ---- jar patch layer: versions are lifted from the Dockerfile, thresholds are the advisory fixes ----
const dockerfile = read(join(APP, 'Dockerfile'));
const arg = (n) => dockerfile.match(new RegExp(`^ARG ${n}=(\\S+)$`, 'm'))?.[1];
const allArgs = (n) => [...dockerfile.matchAll(new RegExp(`^ARG ${n}=(\\S+)$`, 'mg'))].map((m) => m[1]);
const atLeast = (have, min) => {
  const a = have.split(/[.-]/).map((x) => parseInt(x, 10));
  const b = min.split(/[.-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number.isNaN(a[i]) ? 0 : (a[i] ?? 0);
    const y = Number.isNaN(b[i]) ? 0 : (b[i] ?? 0);
    if (x !== y) return x > y;
  }
  return true;
};

test('patched jars are at or above the CVE fix versions, pinned by sha256, with module.xml renamed', () => {
  // BREAKS when: NETTY_HANDLER_VERSION drops below 4.1.137 (CVE-2026-75595) or BCPROV_VERSION below
  // 1.85 (CVE-2026-8763); a sha256 is not 64 hex; the module.xml sed is dropped or does not use
  // the same ARG as the jar it installs (the archive would fail to load the module).
  const netty = arg('NETTY_HANDLER_VERSION');
  const bc = arg('BCPROV_VERSION');
  assert.ok(netty && bc, 'Dockerfile lacks the NETTY_HANDLER_VERSION / BCPROV_VERSION ARGs');
  assert.ok(atLeast(netty, '4.1.137'), `netty-handler ${netty} is below the CVE-2026-75595 fix 4.1.137`);
  assert.ok(atLeast(bc, '1.85'), `bcprov ${bc} is below the CVE-2026-8763 fix 1.85`);
  assert.match(arg('NETTY_HANDLER_SHA256') ?? '', /^[0-9a-f]{64}$/);
  assert.match(arg('BCPROV_SHA256') ?? '', /^[0-9a-f]{64}$/);
  assert.match(dockerfile, /sed -i "s#netty-handler-4\.1\.136\.Final\.jar#netty-handler-\$\{NETTY_HANDLER_VERSION\}\.jar#"/);
  assert.match(dockerfile, /sed -i "s#bcprov-jdk18on-1\.84\.jar#bcprov-jdk18on-\$\{BCPROV_VERSION\}\.jar#"/);
  assert.match(dockerfile, /sha256sum -c -/);
  // two stages each declare the version: they must agree
  assert.equal(new Set(allArgs('NETTY_HANDLER_VERSION')).size, 1, 'NETTY_HANDLER_VERSION differs between stages');
  assert.equal(new Set(allArgs('BCPROV_VERSION')).size, 1, 'BCPROV_VERSION differs between stages');
});

test('version comparator has positive and negative controls (else the test above could not fail)', () => {
  // BREAKS when: the comparator is inverted or ignores the patch component:
  // 4.1.136 < 4.1.137, 1.84 < 1.85, equal passes, 4.2.0 passes.
  assert.equal(atLeast('4.1.136.Final', '4.1.137'), false);
  assert.equal(atLeast('1.84', '1.85'), false);
  assert.equal(atLeast('4.1.137.Final', '4.1.137'), true);
  assert.equal(atLeast('4.2.0.Final', '4.1.137'), true);
});
