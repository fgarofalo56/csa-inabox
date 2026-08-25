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
  checkResolverInvocation,
  classifyResolverInvocation,
  callerCandidates,
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
        run: bash scripts/csa-loom/resolve-internal-token.sh --github-env
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

/* ── R3: the resolver's stdout must reach the runner (#4061) ─────────────── */
//
// THIS FIXTURE USED TO ENSHRINE THE DEFECT. Until #4061, GOOD_LANE above read
// `--export > /dev/null` — the exact broken shape from all four deploy lanes —
// so the suite asserted the leak was the expected form. A fixture is a claim
// about what "correct" looks like; this one was wrong for as long as the code
// was, which is why the tests never disagreed with the bug.
//
// Every case below is keyed to the SHAPE of the redirect, never the literal
// spelling `> /dev/null`. A guard keyed to one spelling is defeated by the next
// one someone types (`csa_loom_guard_keyed_to_the_unsafe_pattern`).

const lane = (cmd) => `
      - name: Adopt the estate's live internal trust token
        run: ${cmd}
`;

test('R3: the correct shape — --github-env, stdout untouched → clean, and COUNTED', () => {
  const r = checkResolverInvocation('deploy-fiab-commercial.yml', GOOD_LANE);
  assert.deepEqual(r.failures, []);
  // The count matters as much as the verdict: a guard that finds zero
  // invocations reports the same empty `failures` as a guard that found four
  // clean ones. run() fails on a zero population for exactly that reason.
  assert.equal(r.invocations, 1);
});

for (const [label, cmd] of [
  ['the literal #4061 shape', 'bash scripts/csa-loom/resolve-internal-token.sh --export > /dev/null'],
  ['no space before the redirect', 'bash scripts/csa-loom/resolve-internal-token.sh --github-env >/dev/null'],
  ['explicit fd 1', 'bash scripts/csa-loom/resolve-internal-token.sh --github-env 1>/dev/null'],
  ['both streams', 'bash scripts/csa-loom/resolve-internal-token.sh --github-env &>/dev/null'],
  ['stdout onto stderr', 'bash scripts/csa-loom/resolve-internal-token.sh --github-env >&2'],
  ['append to a file', 'bash scripts/csa-loom/resolve-internal-token.sh --github-env >> "$LOG"'],
  ['redirect to a variable path', 'bash scripts/csa-loom/resolve-internal-token.sh --github-env > "$OUT"'],
  ['piped to tee', 'bash scripts/csa-loom/resolve-internal-token.sh --github-env | tee /tmp/t'],
  ['piped to a filter', 'bash scripts/csa-loom/resolve-internal-token.sh --github-env | grep -v add-mask'],
]) {
  test(`R3 MUTATION: ${label} → red`, () => {
    const r = checkResolverInvocation('deploy-fiab-commercial.yml', lane(cmd));
    assert.equal(r.invocations, 1, 'the invocation must still be COUNTED, not skipped');
    assert.ok(r.failures.length >= 1, `\`${cmd}\` must not pass`);
    assert.match(r.failures.join('\n'), /#4061/);
  });
}

test('R3 MUTATION: the redirect hides on a backslash continuation → still red', () => {
  // The continuation-blindness class: a physical-line matcher answers "clean"
  // here, and a clean answer is read as evidence.
  const src = `
      - name: Adopt
        run: |
          bash scripts/csa-loom/resolve-internal-token.sh --github-env \\
            > /dev/null
`;
  const r = checkResolverInvocation('deploy-fiab-commercial.yml', src);
  assert.equal(r.invocations, 1);
  assert.ok(r.failures.length >= 1, 'a continuation must not launder the redirect');
});

test('R3 MUTATION: --github-env captured in $( ) → red (a $( ) swallows the mask too)', () => {
  const r = checkResolverInvocation(
    'x.yml',
    lane('OUT=$(bash scripts/csa-loom/resolve-internal-token.sh --github-env)'),
  );
  assert.ok(r.failures.length >= 1);
  assert.match(r.failures.join('\n'), /command substitution/);
});

test('R3 MUTATION: --export captured into a variable instead of eval → red', () => {
  const r = checkResolverInvocation(
    'x.yml',
    lane('TOKEN=$(bash scripts/csa-loom/resolve-internal-token.sh --export)'),
  );
  assert.ok(r.failures.length >= 1);
  assert.match(r.failures.join('\n'), /eval/);
});

test('R3 MUTATION: bare --export with nothing capturing it → red (it prints the token)', () => {
  const r = checkResolverInvocation('x.yml', lane('bash scripts/csa-loom/resolve-internal-token.sh --export'));
  assert.ok(r.failures.length >= 1);
  assert.match(r.failures.join('\n'), /PRINTS THE TOKEN/);
});

test('R3 MUTATION: no mode at all is --export by default → red, not silently allowed', () => {
  // The script's own `MODE="${1:---export}"` default. A classifier that treated
  // "no mode" as unknown-and-therefore-fine would wave through the one shape
  // that prints the secret with no flag to grep for.
  assert.equal(classifyResolverInvocation('bash scripts/csa-loom/resolve-internal-token.sh').mode, '--export');
  const r = checkResolverInvocation('x.yml', lane('bash scripts/csa-loom/resolve-internal-token.sh'));
  assert.ok(r.failures.length >= 1);
});

test('R3 ALLOWED: eval "$(… --export)" — the documented shell shape', () => {
  const r = checkResolverInvocation(
    'x.sh',
    lane('eval "$(bash scripts/csa-loom/resolve-internal-token.sh --export)"'),
  );
  assert.deepEqual(r.failures, []);
  assert.equal(r.invocations, 1);
});

test('R3 ALLOWED: 2> captures stderr — that cannot destroy a stdout workflow command', () => {
  // Deliberately not flagged. deploy-integrity R7 requires stderr be CAPTURED
  // rather than discarded, and a guard that also banned `2>` would push authors
  // toward `2>/dev/null`, which is the R7 defect.
  const r = checkResolverInvocation(
    'x.yml',
    lane('bash scripts/csa-loom/resolve-internal-token.sh --github-env 2>"$ERR"'),
  );
  assert.deepEqual(r.failures, []);
});

test('R3 ALLOWED: 2>&1 folds stderr into stdout without moving stdout', () => {
  const r = checkResolverInvocation(
    'x.yml',
    lane('bash scripts/csa-loom/resolve-internal-token.sh --github-env 2>&1'),
  );
  assert.deepEqual(r.failures, []);
});

test('R3 ALLOWED: a captured --fingerprint never carries the value', () => {
  const r = checkResolverInvocation(
    'x.yml',
    lane('FP=$(bash scripts/csa-loom/resolve-internal-token.sh --fingerprint)'),
  );
  assert.deepEqual(r.failures, []);
});

test('R3 ALLOWED: `||` is a control operator, not a pipe', () => {
  const r = checkResolverInvocation(
    'x.yml',
    lane('bash scripts/csa-loom/resolve-internal-token.sh --github-env || exit 1'),
  );
  assert.deepEqual(r.failures, []);
});

test('R3 FALSE POSITIVE PIN: a comment describing the bad shape is not an invocation', () => {
  // The resolver's own header documents `… --export > /dev/null` as the defect.
  // A guard that fired on prose would flag the file that explains the bug.
  const src = `
      # DO NOT DO THIS: bash scripts/csa-loom/resolve-internal-token.sh --export > /dev/null
      - name: Adopt
        run: bash scripts/csa-loom/resolve-internal-token.sh --github-env
`;
  const r = checkResolverInvocation('deploy-fiab-commercial.yml', src);
  assert.deepEqual(r.failures, []);
  assert.equal(r.invocations, 1, 'the comment must not be counted either');
});

test('R3 FALSE POSITIVE PIN: a file that never names the resolver is not policed', () => {
  const r = checkResolverInvocation('unrelated.yml', lane('echo hello > /dev/null'));
  assert.deepEqual(r.failures, []);
  assert.equal(r.invocations, 0);
});

test('R3 scope: the caller sweep reaches shell scripts, not just the deploy lanes', () => {
  // A guard scoped to the four files that already carried the defect cannot see
  // the fifth caller. Assert the population actually spans both trees.
  const files = callerCandidates(process.cwd());
  assert.ok(
    files.some((f) => f.startsWith('.github/workflows/')),
    'workflows must be in scope',
  );
  assert.ok(
    files.some((f) => f.startsWith('scripts/') && f.endsWith('.sh')),
    'scripts/**/*.sh must be in scope — a caller can be a shell script',
  );
});
