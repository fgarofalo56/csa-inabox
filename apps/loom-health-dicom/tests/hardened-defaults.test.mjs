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

test('values defaults: allowUnenforced and allowDimse are false, DIMSE is off in harden.sh and values', () => {
  // BREAKS when: allowUnenforced / allowDimse / dimseEnabled default to true, or the harden.sh
  // DIMSE_ENABLED default becomes true. (The guards themselves are rendered through helm below.)
  assert.match(values, /^ {2}allowUnenforced: false$/m);
  assert.match(values, /^ {2}allowDimse: false$/m);
  assert.match(values, /^ {2}dimseEnabled: false$/m);
  assert.match(harden, /^DIMSE_ENABLED="\$\{DIMSE_ENABLED:-false\}"$/m);
  assert.doesNotMatch(read(join(APP, 'Dockerfile')), /EXPOSE\s+.*11112/);
  assert.match(read(join(APP, 'Dockerfile')), /^FROM /m, 'positive control: the Dockerfile was actually read');
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
    // ldapmodify: capture the -f file. ldapsearch (all behaviour keyed off the LAST args):
    //   filter (dicomAETitle=*) / (hl7ApplicationName=*) -> enumeration of $STUB_AES / one HL7 app
    //   last arg "dn"                                    -> wait-loop probe, a dn line
    //   last arg = attribute (read-back)                 -> that attribute's lines from the
    //     written ldif, ONLY for the entry whose dn equals the -b base. Fault arms:
    //     STUB_READ_FAIL=1 exits 1; STUB_EMPTY_ATTR=<attr> returns nothing for that attribute;
    //     STUB_INJECT_DN + STUB_INJECT_LINE adds one line for that dn (a value that should be absent).
    const o = out.replace(/\\/g, '/');
    stub('ldapmodify', `while [ $# -gt 0 ]; do [ "$1" = -f ] && cp "$2" "${o}"; shift; done`);
    stub('ldapsearch', [
      'DEVDN="dicomDeviceName=dcm4chee-arc,cn=Devices,cn=DICOM Configuration,dc=dcm4che,dc=org"',
      'for last; do :; done; base=""; prev=""; for a; do [ "$prev" = -b ] && base="$a"; prev="$a"; done',
      'case " $* " in',
      '  *"(dicomAETitle=*)"*) for t in $(echo "${STUB_AES:-DCM4CHEE}" | tr , " "); do echo "dn: dicomAETitle=$t,$DEVDN"; done; exit 0;;',
      '  *"(hl7ApplicationName=*)"*) echo "dn: hl7ApplicationName=*,$DEVDN"; exit 0;;',
      'esac',
      '[ "$last" = dn ] && { echo "dn: x"; exit 0; }',
      '[ "${STUB_READ_FAIL:-}" = 1 ] && { echo "ldap_result: Can\'t contact LDAP server" >&2; exit 1; }',
      '[ "${STUB_EMPTY_ATTR:-}" = "$last" ] || awk -v b="$base" -v a="$last:" \'/^dn: /{cur=substr($0,5)} cur==b && index($0,a)==1\' "' + o + '"',
      '[ "${STUB_INJECT_DN:-}" = "$base" ] && echo "$STUB_INJECT_LINE"',
      'exit 0',
    ].join('\n'));
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

// ---- W3-1 hardening (#5315): enumeration, fail-closed read-back, both listeners ----
const DEVDN = 'dicomDeviceName=dcm4chee-arc,cn=Devices,cn=DICOM Configuration,dc=dcm4che,dc=org';
const skipSh = !haveSh && 'no sh on PATH';

test('harden.sh applies the calling-AE allow-list to EVERY enumerated archive AE', { skip: skipSh }, () => {
  // BREAKS when: only AE_TITLE is written. Three AEs are enumerated, so the LOOMGW line must
  // appear exactly 3 times, once under each dn (a single-AE implementation writes 1).
  const r = runHarden({ STUB_AES: 'DCM4CHEE,DCM4CHEE_ADMIN,IOCM_REGULAR_USE' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.ldif.match(/^dcmAcceptedCallingAETitle: LOOMGW$/gm) ?? []).length, 3);
  for (const ae of ['DCM4CHEE', 'DCM4CHEE_ADMIN', 'IOCM_REGULAR_USE']) {
    assert.ok(
      r.ldif.includes(`dn: dicomAETitle=${ae},${DEVDN}\nchangetype: modify\nreplace: dcmAcceptedCallingAETitle\ndcmAcceptedCallingAETitle: LOOMGW\n`),
      `${ae} has no allow-list block`,
    );
  }
});

test('harden.sh fails (exit 1) when the read-back returns NOTHING for the AE attribute', { skip: skipSh }, () => {
  // BREAKS when: the read-back is not checked against what was written. The stub returns no
  // dcmAcceptedCallingAETitle although ENFORCE=true wrote it: exit must be 1. Positive control:
  // the same run without the fault exits 0 (the default-run test above).
  const r = runHarden({ STUB_EMPTY_ATTR: 'dcmAcceptedCallingAETitle' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AE allow-list empty after write/);
});

test('harden.sh fails (exit 1) when ldapsearch itself errors on the read-back, even where only absence is checked', { skip: skipSh }, () => {
  // BREAKS when: get() swallows the ldapsearch status (`|| true`): a failed search then reads as
  // 0 and every absence check passes. ENFORCE/HL7/DIMSE are all off here so ONLY absence checks
  // run: the mutated script exits 0, the fixed one exits 1.
  const r = runHarden({ AE_ENFORCE: 'false', HL7_AUTH: 'false', DIMSE_ENABLED: 'false', STUB_READ_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ldapsearch exited non-zero/);
});

test('harden.sh reads back cn=dicom-tls: a stray port there fails even with DIMSE off', { skip: skipSh }, () => {
  // BREAKS when: only cn=dicom is read back (the stub injects dicomPort 2762 on cn=dicom-tls only).
  const r = runHarden({ STUB_INJECT_DN: `cn=dicom-tls,${DEVDN}`, STUB_INJECT_LINE: 'dicomPort: 2762' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cn=dicom-tls still has a port/);
});

test('harden.sh reads HL7 back when HL7_AUTH=false: a leftover allow-list fails', { skip: skipSh }, () => {
  // BREAKS when: HL7 is read back only if HL7_AUTH=true (the stub injects a sender on the HL7 app).
  const r = runHarden({ HL7_AUTH: 'false', STUB_INJECT_DN: `hl7ApplicationName=*,${DEVDN}`, STUB_INJECT_LINE: 'hl7AcceptedSendingApplication: X|Y' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HL7 allow-list still present/);
  const ok = runHarden({ HL7_AUTH: 'false' });
  assert.equal(ok.status, 0, `positive control: HL7_AUTH=false with nothing injected passes (${ok.stderr})`);
});

test('harden.sh DIMSE_ENABLED=true fails when the ports read back empty', { skip: skipSh }, () => {
  // BREAKS when: DIMSE on is not verified: the stub hides dicomPort on read-back, exit must be 1.
  const r = runHarden({ DIMSE_ENABLED: 'true', STUB_EMPTY_ATTR: 'dicomPort' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no port with DIMSE_ENABLED=true/);
});

// ---- chart behaviour rendered through helm (never regex over template source) ----
const helm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' });
const haveHelm = !helm.error && helm.status === 0;
const skipHelm = !haveHelm && 'SKIPPED LOUDLY: helm is not installed on this machine, so the chart-guard/NetworkPolicy tests did NOT run here';
if (!haveHelm) console.warn(`WARNING: ${skipHelm}`);
const render = (...sets) => {
  const args = ['template', 'x', join(APP, 'chart')];
  for (const s of sets) args.push('--set-string', s);
  const r = spawnSync('helm', args, { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').replace(/\r\n/g, '\n'), stderr: r.stderr ?? '' };
};
const doc = (out, re) => out.split(/^---$/m).find((d) => re.test(d)) ?? '';

test('helm: default render succeeds with the hardened posture', { skip: skipHelm }, () => {
  // BREAKS when: the default values stop rendering, or render 11112 (DIMSE off by default).
  const r = render();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /11112/);
  assert.match(r.stdout, /name: AE_ENFORCE, value: "true"/);
});

test('helm: the string "false" for aeEnforce without allowUnenforced FAILS the render', { skip: skipHelm }, () => {
  // BREAKS when: the guard is `not .Values.hardening.aeEnforce` (a quoted "false" is truthy, the
  // render succeeds and harden.sh gets AE_ENFORCE=false). --set-string makes it a real string.
  const r = render('hardening.aeEnforce=false');
  assert.notEqual(r.status, 0, 'render must fail');
  assert.match(r.stderr, /requires hardening\.allowUnenforced=true/);
});

test('helm: aeEnforce=false renders only with allowUnenforced=true', { skip: skipHelm }, () => {
  // BREAKS when: allowUnenforced is ignored (always fails) or the string "false" counts as true.
  const ok = render('hardening.aeEnforce=false', 'hardening.allowUnenforced=true');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /name: AE_ENFORCE, value: "false"/);
  const bad = render('hardening.aeEnforce=false', 'hardening.allowUnenforced=false');
  assert.notEqual(bad.status, 0, 'allowUnenforced as the STRING "false" must not unlock it');
});

test('helm: dimseEnabled=true needs allowDimse=true', { skip: skipHelm }, () => {
  // BREAKS when: the DIMSE escape is removed (dimse alone renders) or never unlocks.
  const bad = render('hardening.dimseEnabled=true');
  assert.notEqual(bad.status, 0, 'dimseEnabled without allowDimse must fail');
  assert.match(bad.stderr, /requires hardening\.allowDimse=true/);
  const ok = render('hardening.dimseEnabled=true', 'hardening.allowDimse=true');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(doc(ok.stdout, /name: loom-health-dicom-ingress/), /port: 11112/);
  assert.match(doc(ok.stdout, /kind: Service\n[\s\S]*selector: \{app: loom-health-dicom\}/), /port: 11112/);
});

test('helm: NetworkPolicy allows 8080 only from the gateway label; 2575 closed unless hl7Enabled', { skip: skipHelm }, () => {
  // BREAKS when: a policy is missing, an allow rule uses an empty podSelector (whole namespace),
  // the gateway label differs from the W3-3 contract, or 2575 is open by default.
  const r = render();
  assert.equal(r.status, 0, r.stderr);
  const np = doc(r.stdout, /name: loom-health-dicom-ingress/);
  assert.match(np, /kind: NetworkPolicy/);
  assert.match(np, /podSelector: \{matchLabels: \{app: loom-health-dicom\}\}/, 'must select the archive pods');
  assert.match(np, /matchLabels:\n\s+app\.kubernetes\.io\/name: loom-health-dicom-gateway/);
  assert.match(np, /port: 8080/);
  assert.doesNotMatch(np, /2575/, 'HL7 must be closed by default');
  assert.doesNotMatch(np, /ipBlock|namespaceSelector/, 'no cluster-wide / CIDR allow');
  const withHl7 = doc(render('networkPolicy.hl7Enabled=true').stdout, /name: loom-health-dicom-ingress/);
  assert.match(withHl7, /port: 2575/);
  const ldap = doc(r.stdout, /name: loom-health-dicom-ldap-ingress/);
  assert.match(ldap, /port: 389/);
  assert.match(ldap, /\{app: loom-health-dicom\}/);
});

test('helm: the harden initContainer has a securityContext and resources', { skip: skipHelm }, () => {
  // BREAKS when: either block is removed from the initContainer.
  const dep = doc(render().stdout, /kind: Deployment/);
  const init = dep.slice(dep.indexOf('initContainers:'), dep.indexOf('- name: arc'));
  assert.ok(init.includes('name: harden'), 'positive control: sliced the harden container');
  assert.match(init, /allowPrivilegeEscalation: false/);
  assert.match(init, /drop: \[ALL\]/);
  assert.match(init, /limits: \{memory: 128Mi\}/);
});
