/**
 * internal-token single-writer guard self-test (#3056).
 *
 * MUTATION-PROVEN. The guard's whole value is that it goes RED when someone
 * re-introduces a second writer, so every assertion below breaks the invariant
 * and requires the verdict to flip. If the guard is ever weakened to a
 * name-match or a prose-match (the `route_guards_blind_three_ways` class), at
 * least one of these fails.
 *
 * Also pins the FALSE-POSITIVE fix: the first run of this guard flagged
 * `deploy.yml` and `full-app-deploy-commercial.yml` purely from prose — one
 * deploys a different template and only names the platform one in a header
 * comment, the other contains the sentence "this deliberately does NOT run
 * `az deployment sub create`". A guard that fires on a comment gets ignored.
 *
 * Run: node --test scripts/ci/__tests__/internal-token-single-writer.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBicepAdopts,
  checkDeployLane,
  appliesPlatformTemplate,
  stripCommentLines,
} from '../check-internal-token-single-writer.mjs';

const GOOD_BICEP = `
var somethingElse = 1

var loomInternalToken = empty(loomInternalTokenValue)
  ? guid(loomGeneratedSecretSeed, 'loom-maf-internal-token-v1')
  : loomInternalTokenValue

var next = 2
`;

// The pre-#3056 form: a bare mint from a newGuid()-seeded value.
const CLOBBERING_BICEP = `
var loomInternalToken = guid(loomGeneratedSecretSeed, 'loom-maf-internal-token-v1')

var next = 2
`;

test('bicep that adopts the estate value → no failures', () => {
  assert.deepEqual(checkBicepAdopts(GOOD_BICEP), []);
});

test('MUTATION: revert bicep to a bare mint → guard names the newGuid() root', () => {
  const fail = checkBicepAdopts(CLOBBERING_BICEP);
  assert.ok(fail.length >= 1, 'a bare mint must not pass');
  assert.match(fail.join('\n'), /newGuid\(\)/);
  assert.match(fail.join('\n'), /#3056/);
});

test('MUTATION: drop the empty() greenfield guard → red (day-one would have no token)', () => {
  const noEmpty = `
var loomInternalToken = loomInternalTokenValue

var next = 2
`;
  const fail = checkBicepAdopts(noEmpty);
  assert.ok(fail.length >= 1);
  assert.match(fail.join('\n'), /greenfield|#3089|fails closed/);
});

test('a renamed/removed assignment fails LOUD rather than silently passing', () => {
  const fail = checkBicepAdopts('var unrelated = 1\n');
  assert.equal(fail.length, 1);
  assert.match(fail[0], /could not find/);
});

const GOOD_LANE = `
      - name: Adopt the estate's live internal trust token (never re-mint it)
        run: bash scripts/csa-loom/resolve-internal-token.sh --export > /dev/null
      - name: Provision
        run: |
          az deployment sub create \\
            --template-file platform/fiab/bicep/main.bicep \\
            --parameters loomInternalTokenValue="$LOOM_INTERNAL_TOKEN"
`;

test('a deploy lane that resolves AND passes → no failures', () => {
  assert.deepEqual(checkDeployLane('deploy-fiab-commercial.yml', GOOD_LANE), []);
});

test('MUTATION: strip the adopt step from a lane → red', () => {
  const noResolve = GOOD_LANE.replace(/.*resolve-internal-token\.sh.*\n/, '').replace(
    /.*Adopt the estate.*\n/,
    '',
  );
  const fail = checkDeployLane('deploy-fiab-commercial.yml', noResolve);
  assert.ok(fail.length >= 1);
  assert.match(fail.join('\n'), /never calls/);
});

test('MUTATION: resolve but forget to pass the parameter → still red', () => {
  const noParam = GOOD_LANE.replace(/.*loomInternalTokenValue.*\n/, '');
  const fail = checkDeployLane('deploy-fiab-commercial.yml', noParam);
  assert.ok(fail.length >= 1);
  assert.match(fail.join('\n'), /never passes/);
});

test('a workflow that does not apply the platform template is not policed', () => {
  const unrelated = `
      - run: |
          az deployment sub create \\
            --template-file deploy/bicep/landing-zone-alz/main.bicep
`;
  assert.deepEqual(checkDeployLane('deploy.yml', unrelated), []);
});

test('FALSE POSITIVE PIN: a header comment naming the platform template is not an apply', () => {
  const commentOnly = `
# deployed SEPARATELY by platform/fiab/bicep/main.bicep, which runs INTO the
      - run: |
          az deployment sub create \\
            --template-file deploy/bicep/landing-zone-alz/main.bicep
`;
  assert.equal(appliesPlatformTemplate(commentOnly), false);
  assert.deepEqual(checkDeployLane('deploy.yml', commentOnly), []);
});

test('FALSE POSITIVE PIN: prose saying it does NOT run the deploy is not an apply', () => {
  const prose = `
      # This deliberately does NOT run \`az deployment sub create\` (full main.bicep):
      # re-running platform/fiab/bicep/main.bicep fights pre-existing drift.
      - name: Roll Container Apps
        run: az containerapp update --image "$ACR/loom-console:$TAG"
`;
  assert.equal(appliesPlatformTemplate(prose), false);
  assert.deepEqual(checkDeployLane('full-app-deploy-commercial.yml', prose), []);
});

test('stripCommentLines removes only whole-line comments', () => {
  const out = stripCommentLines('  # gone\nkept: 1\n   #also gone\n  value: "a # b"\n');
  assert.equal(out.includes('gone'), false);
  assert.match(out, /kept: 1/);
  assert.match(out, /a # b/); // an inline hash inside a value survives
});
