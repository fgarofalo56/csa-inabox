/**
 * Gov producers for the two Container App Job images (Gov run 42106150785).
 *
 * `modules/admin-plane/lineage-extractor-job.bicep` and `secret-expiry-monitor-job.bicep` reference LITERAL
 * `<acr>/<image>:latest`. Gov had no producer, so Provision failed InvalidParameterValueInContainerTemplate /
 * MANIFEST_UNKNOWN on both. `gov-provision-streaming-migrate.yml` (the build-only job `deploy-fiab-gcch.yml` calls) now
 * builds them inside its ACR firewall lease and proves the manifests; `deploy-fiab-gcch.yml`'s image preflight names them.
 *
 * Each control names the input that breaks it. The image names are LIFTED from the bicep consumers, not transcribed.
 *
 * NOT PROVEN HERE: that the builds succeed in Gov. Only a live run does.
 *
 * Run: node --test scripts/ci/__tests__/gov-job-images-build.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const PRODUCER = '.github/workflows/gov-provision-streaming-migrate.yml';
const BUILD = 'Build the Job images on the Gov ACR';
const PROOF = 'Prove the Job image manifests exist at :latest';
const FIRST_BUILD = 'Build both images on the Gov ACR';
const RELEASE = 'Release the ACR firewall lease (always)';

/** The `name: <image>:latest` each Job module defaults to, lifted from the bicep source. */
function consumerImages() {
  const files = {
    'azure-functions/lineage-extractor': 'platform/fiab/bicep/modules/admin-plane/lineage-extractor-job.bicep',
    'azure-functions/secret-expiry-monitor': 'platform/fiab/bicep/modules/admin-plane/secret-expiry-monitor-job.bicep',
    'azure-functions/report-subscriptions': 'platform/fiab/bicep/modules/admin-plane/report-subscriptions-job.bicep',
  };
  const out = {};
  for (const [ctx, rel] of Object.entries(files)) {
    const m = /^param image string = '\$\{acrLoginServer\}\/([a-z-]+):latest'/m.exec(read(rel));
    assert.ok(m, `${rel} no longer defaults its image to <acr>/<name>:latest; this test has nothing to compare`);
    out[ctx] = m[1];
  }
  return out;
}

const stepOf = (wf, namePrefix) => {
  const chunks = wf.split(/\n {6}- name: /);
  return chunks.find((c) => c.startsWith(namePrefix)) ?? null;
};

test('GOV JOB IMAGES: the producer builds exactly the images the bicep consumers pull, from the right contexts', () => {
  // Breaks if: a repo name drifts from the bicep default (the Job would pull a tag nothing produces), a build context
  // path is wrong (az acr build fails or builds the wrong source), or a build is deleted.
  const wf = read(PRODUCER);
  const step = stepOf(wf, BUILD);
  assert.ok(step, `step "${BUILD}" is missing`);
  const consumers = consumerImages();
  assert.equal(Object.keys(consumers).length, 3, 'population floor: three Job images are expected');
  for (const [ctx, image] of Object.entries(consumers)) {
    assert.ok(step.includes(`--image "${image}:latest"`), `${image}:latest must be built (the bicep default pulls exactly that)`);
    assert.ok(step.includes(`--image "${image}:$SHA"`), `${image}:$SHA must also be pushed (traceability)`);
    assert.ok(new RegExp(`\\n {12}${ctx}\\n`).test(step), `the build for ${image} must use the context ${ctx}`);
    assert.ok(fs.existsSync(path.join(ROOT, ctx, 'Dockerfile')), `${ctx}/Dockerfile must exist`);
  }
});

test('GOV JOB IMAGES: both steps run inside the firewall lease and only when an estate exists and the run builds', () => {
  // Breaks if: the build moves ABOVE the step that acquires the lease or BELOW the always-release (the push would hit a
  // locked registry or leave it open), or loses the `if` that keeps whatif runs and absent estates from building.
  const wf = read(PRODUCER);
  const at = (n) => wf.indexOf(`- name: ${n}`);
  const [first, build, proof, release] = [FIRST_BUILD, BUILD, PROOF, RELEASE].map(at);
  assert.ok([first, build, proof, release].every((i) => i > 0), 'all four steps must exist');
  assert.ok(first < build && build < proof && proof < release, 'order must be: first build (acquires lease) < job build < proof < release');
  for (const n of [BUILD, PROOF]) {
    assert.ok(
      stepOf(wf, n).includes("if: ${{ env.MODE != 'whatif' && steps.discover.outputs.estate == 'present' }}"),
      `"${n}" must be gated like the first build step`,
    );
  }
});

test('GOV JOB IMAGES: the manifest proof covers both images and fails closed on absent and on unreadable', () => {
  // Breaks if: an image is dropped from the loop (a missing manifest would pass), or the unreadable branch stops
  // failing (the proof would read an unreadable registry as present).
  const step = stepOf(read(PRODUCER), PROOF);
  assert.ok(step, `step "${PROOF}" is missing`);
  for (const image of Object.values(consumerImages())) assert.ok(step.includes(image), `${image} must be proven`);
  assert.ok(step.includes('elif [ $DRC -eq 3 ]'), 'the not-found answer must be its own branch');
  assert.equal((step.match(/RC=1/g) ?? []).length, 2, 'both the absent and the unreadable branches must set RC=1');
  assert.ok(step.includes('exit $RC'), 'the step must exit with the accumulated verdict');
});

test('GOV JOB IMAGES: the deploy lane preflight names both Job images, so a missing one fails fast and clearly', () => {
  // Breaks if: either ref is removed from the assert-acr-image-tags call, which is how Provision came to fail on a
  // manifest the preflight ("all 3 referenced tags present") never checked.
  const wf = read('.github/workflows/deploy-fiab-gcch.yml');
  const i = wf.indexOf('bash scripts/ci/assert-acr-image-tags.sh');
  assert.ok(i > 0, 'the preflight call is missing');
  const call = wf.slice(i, i + 1400);
  for (const image of Object.values(consumerImages())) assert.ok(call.includes(`"${image}:latest"`), `the preflight must require ${image}:latest`);
});
