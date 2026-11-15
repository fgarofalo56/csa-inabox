// Static contract for the loom-health-fhir image (LHDS W2-1). Runs with
//   node --test apps/loom-health-fhir/tests/
// No docker needed. The docker build itself is the dynamic check (it fails if the
// baked validator cannot accept a valid and reject an invalid US Core Patient).
//
// assertion-design.md: every test names the input that breaks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(APP, '..', '..');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dockerfile = read(join(APP, 'Dockerfile'));
const workflow = read(join(ROOT, '.github/workflows/build-fiab-images-acr-tasks.yml'));

const stage = (name) => {
  const m = dockerfile.split(/^FROM /m).find((s) => new RegExp(`\\sAS ${name}\\n`).test(s));
  assert.ok(m, `Dockerfile has no "AS ${name}" stage`);
  return m;
};

test('runtime base image digest equals the W0-measured HAPI digest', () => {
  // BREAKS when: either the Dockerfile FROM digest or the measurement script's default
  // digest is edited without the other (e.g. FROM bumped to a new digest, or changed to a tag).
  const from = dockerfile.match(/^FROM hapiproject\/hapi@(sha256:[0-9a-f]{64}) AS runtime$/m);
  assert.ok(from, 'runtime stage must be FROM hapiproject/hapi@sha256:<64 hex> (digest-pinned, no tag)');
  const measured = read(join(ROOT, 'scripts/measure/health/fhir-engine-deploy.sh')).match(
    /LHDS_HAPI_IMAGE:-hapiproject\/hapi@(sha256:[0-9a-f]{64})/,
  );
  assert.ok(measured, 'could not lift the W0 digest from fhir-engine-deploy.sh');
  assert.equal(from[1], measured[1]);
});

test('every baked artifact is pinned by a 64-hex sha256, with no duplicates', () => {
  // BREAKS when: a lock row has a short/blank/uppercase hash, or the same name#version is listed twice.
  const rows = read(join(APP, 'packages.lock.tsv')).split('\n').filter(Boolean).map((l) => l.split('\t'));
  assert.ok(rows.length >= 10, `expected the US Core closure (>=10 packages), got ${rows.length}`);
  const seen = new Set();
  for (const [name, version, sha] of rows) {
    assert.match(sha ?? '', /^[0-9a-f]{64}$/, `${name}#${version}: sha256 must be 64 lowercase hex`);
    assert.ok(!seen.has(`${name}#${version}`), `duplicate ${name}#${version}`);
    seen.add(`${name}#${version}`);
  }
  assert.ok(seen.has('hl7.fhir.us.core#6.1.0'), 'US Core 6.1.0 must be in the closure');
  const v = Object.fromEntries(read(join(APP, 'validator.lock')).split('\n').filter(Boolean).map((l) => l.split('=')));
  assert.match(v.sha256, /^[0-9a-f]{64}$/);
  assert.ok(v.url.includes(`/${v.version}/`), 'validator url must embed the pinned version');
});

test('validator version equals the org.hl7.fhir.core version the pinned HAPI ships (6.9.12)', () => {
  // BREAKS when: validator.lock is bumped without re-measuring the server's bundled core version.
  assert.match(read(join(APP, 'validator.lock')), /^version=6\.9\.12$/m);
  assert.match(dockerfile, /ai\.loom\.health\.validator-version="6\.9\.12"/);
});

test('runtime stage downloads nothing; tools stage verifies what it fetches', () => {
  // BREAKS when: a curl/wget/ADD-url/pip/npm/mvn appears after the runtime FROM.
  const runtime = stage('runtime');
  assert.doesNotMatch(runtime, /\b(curl|wget|apt-get|pip|npm|mvn)\b|ADD\s+https?:/);
  // positive pair (absence alone is satisfied by deleting the feature):
  assert.match(runtime, /COPY --from=tools \/baked\/packages/);
  assert.match(runtime, /COPY --from=tools \/baked\/validator/);
  assert.match(stage('tools'), /fetch-baked-assets\.sh/);
  const fetch = read(join(APP, 'scripts/fetch-baked-assets.sh'));
  assert.match(fetch, /set -eu/);
  assert.match(fetch, /sha256 mismatch[\s\S]*exit 1/);
  // comments are stripped: the script's header text mentions the forbidden idiom by name
  assert.doesNotMatch(fetch.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /\|\|\s*true/);
});

test('the build context named in the workflow matrix row contains every COPY source (#5171)', () => {
  // BREAKS when: the row's ctx is changed to "." (repo root) or another dir, or the Dockerfile
  // COPYs a path that is not under the row's context. loom-health-cp shipped exactly this
  // mismatch (#5171); the first COPY then fails the whole build.
  const row = workflow.match(/\{"name":"loom-health-fhir","ctx":"([^"]+)"(?:,"file":"([^"]+)")?[^}]*\}/);
  assert.ok(row, 'loom-health-fhir must have a row in the build-fiab-images-acr-tasks.yml default matrix');
  const ctx = resolve(ROOT, row[1]);
  const file = row[2] ? resolve(ROOT, row[2]) : join(ctx, 'Dockerfile');
  assert.equal(file, join(APP, 'Dockerfile'), 'the matrix row must point at THIS Dockerfile');
  let copies = 0;
  for (const m of dockerfile.matchAll(/^COPY (?!--from)(.+)$/gm)) {
    const parts = m[1].trim().split(/\s+/);
    for (const src of parts.slice(0, -1)) {
      copies += 1;
      assert.ok(existsSync(join(ctx, src)), `COPY source "${src}" does not exist under build context ${row[1]}`);
    }
  }
  assert.ok(copies >= 6, `expected to examine the Dockerfile's COPY sources, saw ${copies}`);
});

test('CVE patch locks are sha256-pinned and wired into the runtime stage', () => {
  // BREAKS when: either lock loses its 64-hex sha256, the otel version drops below the fixed
  // 2.26.1 (CVE-2026-33701), libbrotli1 drops below 1.1.0-2+deb13u1 (CVE-2026-111497), or a
  // COPY overlaying the patched artifact is removed from the runtime stage.
  const kv = (f) => Object.fromEntries(read(join(APP, f)).split('\n').filter(Boolean).map((l) => l.split('=')));
  const otel = kv('otel-agent.lock');
  assert.match(otel.sha256, /^[0-9a-f]{64}$/);
  assert.equal(otel.version, '2.26.1');
  const os = kv('os-patch.lock');
  assert.match(os.sha256, /^[0-9a-f]{64}$/);
  assert.equal(os.version, '1.1.0-2+deb13u1');
  const runtime = stage('runtime');
  assert.match(runtime, /COPY --from=tools \/baked\/agent\/opentelemetry-javaagent\.jar \/app\/opentelemetry-javaagent\.jar/);
  assert.match(runtime, /COPY --from=ospatch \/out\/status\.d\/ \/var\/lib\/dpkg\/status\.d\//);
});

test('the image build and verify script expect exactly the interceptors the plugin registers', () => {
  // BREAKS when: LoomPlugin.java registers 0 interceptors (a registerInterceptor line removed or
  // commented out) so the list below shrinks; the register() calls and the
  // registeredInterceptors() literal list disagree (2 vs 1); PDP/audit order flips; or the
  // Dockerfile / verify-image.sh lose the ">0" guard or go back to a hard-coded "interceptors":0.
  const src = read(join(APP, 'plugin/src/main/java/ai/loom/health/fhir/LoomPlugin.java'));
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const registered = [...code.matchAll(/svc\.registerInterceptor\(new (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(registered, ['LoomPdpInterceptor', 'LoomAuditInterceptor'], 'PDP must register before audit');
  const literal = code.match(/new String\[\] \{([^}]*)\}/);
  assert.ok(literal, 'registeredInterceptors() literal list not found');
  assert.equal([...literal[1].matchAll(/"ai\.loom[^"]+"/g)].length, registered.length);
  for (const [name, text] of [['Dockerfile', dockerfile], ['verify-image.sh', read(join(APP, 'scripts/verify-image.sh'))]]) {
    assert.ok(text.includes("grep -cE '^[[:space:]]*svc\\.registerInterceptor\\('"),
      `${name} must lift the expected count from LoomPlugin.java, anchored so a commented-out registration is not counted`);
    assert.ok(text.includes('"$EXPECTED" -gt 0'), `${name} must fail when the plugin registers 0 interceptors`);
    assert.doesNotMatch(text, /"interceptors":\d/, `${name} must not hard-code an interceptor count`);
  }
});

test('the image is no longer labelled a skeleton, and the build skips plugin tests', () => {
  // BREAKS when: the plugin-state LABEL reverts to "skeleton-no-interceptors" (or any value
  // containing "skeleton"), or the mvn package step loses -DskipTests (the plugin tests start
  // Jetty and belong to the CI test lane, not the image build).
  assert.match(dockerfile, /LABEL ai\.loom\.health\.plugin-state="pdp-audit-interceptors"/);
  assert.doesNotMatch(dockerfile, /skeleton/i);
  assert.match(stage('tools'), /mvn -B -q -f plugin\/pom\.xml package -DskipTests/);
});
