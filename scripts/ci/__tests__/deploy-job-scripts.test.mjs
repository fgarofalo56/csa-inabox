/**
 * Self-tests for check-deploy-job-scripts.mjs (#2816 residual).
 *
 * WHAT IS BEING PINNED. The defect these guards exist for is NOT "a bad flag". It
 * is that two commands can appear in a script in either order, and only one order
 * works — while the script text, `bash -n`, and every CI gate look identical:
 *
 *   BROKEN (deploy-loom-verify-job.sh, #1533 -> #2816)
 *     az containerapp job create --yaml <payload referencing secretRef: session-secret>
 *     az containerapp job secret set --secrets "session-secret=..."   <- never reached
 *
 *   CORRECT (deploy-copilot-evaluator-job.sh)
 *     az containerapp job secret set --secrets "loom-internal-token=..."
 *     az containerapp job update --set-env-vars "X=secretref:loom-internal-token"
 *
 * So the ORDER-SENSITIVE case and its mirror image are both tested. A check that
 * flagged every `secretRef` would "fix" #2816 and break the evaluator; a check that
 * flagged none would pass the bug. The CONTROL cases below fail under both of those
 * over-corrections, which is their entire job.
 *
 * Run: node --test scripts/ci/__tests__/deploy-job-scripts.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, declaredYamlSecrets, logicalLines, secretRefs } from '../check-deploy-job-scripts.mjs';

const rules = (src) => analyze(src).violations.map((v) => v.rule).sort();

// ---------------------------------------------------------------------------
// Rule A — secretRef must be declared before it is used
// ---------------------------------------------------------------------------

/** The exact pre-fix deploy-loom-verify-job.sh shape, reduced. */
const VERIFY_BROKEN = `#!/usr/bin/env bash
cat > "$TMP" <<YAML
properties:
  configuration:
    triggerType: Manual
    registries:
      - server: \${ACR}
  template:
    containers:
      - name: verify
        env:
          - { name: SESSION_SECRET, secretRef: session-secret }
YAML
az containerapp job create -n loom-verify -g "$RG" --yaml "$TMP" -o none
az containerapp job secret set -n loom-verify -g "$RG" --secrets "session-secret=$SS" -o none
`;

/** The fixed shape: the payload declares the secret with a placeholder. */
const VERIFY_FIXED = `#!/usr/bin/env bash
cat > "$TMP" <<YAML
properties:
  configuration:
    triggerType: Manual
    registries:
      - server: \${ACR}
    secrets:
      - name: session-secret
        value: "placeholder-overwritten-below"
  template:
    containers:
      - name: verify
        env:
          - { name: SESSION_SECRET, secretRef: session-secret }
YAML
az containerapp job create -n loom-verify -g "$RG" --yaml "$TMP" -o none
az containerapp job secret set -n loom-verify -g "$RG" --secrets "session-secret=$SS" -o none
`;

test('undeclared secretRef in a create payload is a violation', () => {
  assert.deepEqual(rules(VERIFY_BROKEN), ['undeclared-secretref']);
  const v = analyze(VERIFY_BROKEN).violations[0];
  assert.match(v.detail, /AFTER this reference/);
});

test('CONTROL: the same script with the secret declared in the payload passes', () => {
  assert.deepEqual(rules(VERIFY_FIXED), []);
});

test('CONTROL: secret set BEFORE the referencing update passes (the evaluator shape)', () => {
  const src = `#!/usr/bin/env bash
az containerapp job create -n j -g "$RG" --container-name evaluator --image "$IMG"
az containerapp job secret set -n j -g "$RG" --secrets "loom-internal-token=$T"
az containerapp job update -n j -g "$RG" --set-env-vars "LOOM_INTERNAL_TOKEN=secretref:loom-internal-token"
`;
  assert.deepEqual(rules(src), []);
});

test('the SAME two commands in the wrong order is a violation', () => {
  // Identical text to the control above, with the two lines swapped. Nothing else
  // differs — which is the point: only an order-aware check separates them.
  const src = `#!/usr/bin/env bash
az containerapp job create -n j -g "$RG" --container-name evaluator --image "$IMG"
az containerapp job update -n j -g "$RG" --set-env-vars "LOOM_INTERNAL_TOKEN=secretref:loom-internal-token"
az containerapp job secret set -n j -g "$RG" --secrets "loom-internal-token=$T"
`;
  assert.deepEqual(rules(src), ['undeclared-secretref']);
});

test('CONTROL: `--secrets` on the create itself declares the secret', () => {
  const src = `#!/usr/bin/env bash
az containerapp job create -n j -g "$RG" --container-name c --image "$IMG" \\
  --secrets "tok=$T" other=x \\
  --env-vars "T=secretref:tok"
`;
  assert.deepEqual(rules(src), []);
});

test('a container named like a secret does not count as a secret declaration', () => {
  // `- name:` is also container/env syntax. If the block scoping were dropped, this
  // would pass and rule A would be unable to fail on any realistic payload.
  const src = `#!/usr/bin/env bash
cat > "$TMP" <<YAML
properties:
  template:
    containers:
      - name: session-secret
        env:
          - { name: SESSION_SECRET, secretRef: session-secret }
YAML
az containerapp job create -n j -g "$RG" --yaml "$TMP"
`;
  assert.deepEqual(rules(src), ['undeclared-secretref']);
  assert.equal(declaredYamlSecrets(src).size, 0);
});

test('a secrets: block that has ended does not keep absorbing later names', () => {
  const src = `properties:
  configuration:
    secrets:
      - name: real-secret
  template:
    containers:
      - name: not-a-secret
`;
  assert.deepEqual([...declaredYamlSecrets(src)], ['real-secret']);
});

test('a commented-out secretRef is not a reference', () => {
  const src = `#!/usr/bin/env bash
# - { name: SESSION_SECRET, secretRef: session-secret }
az containerapp job create -n j -g "$RG" --container-name c --image "$IMG"
`;
  assert.deepEqual(secretRefs(src), []);
  assert.deepEqual(rules(src), []);
});

// ---------------------------------------------------------------------------
// Rule B — a mutating create/update must not discard its stderr
// ---------------------------------------------------------------------------

test('`create 2>/dev/null || update` is a violation', () => {
  const src = `#!/usr/bin/env bash
az containerapp job create -n j -g "$RG" --yaml "$TMP" -o none 2>/dev/null \\
  || az containerapp job update -n j -g "$RG" --yaml "$TMP" -o none
`;
  assert.ok(rules(src).includes('swallowed-stderr'));
});

test('CONTROL: a read-only `job show` probe may swallow output', () => {
  // The whole point of `2>/dev/null` on the probe is that a missing job is the
  // ANSWER, not an error. A guard that banned the idiom outright would force this
  // correct pattern out of the tree.
  const src = `#!/usr/bin/env bash
if az containerapp job show -n j -g "$RG" >/dev/null 2>&1; then
  az containerapp job update -n j -g "$RG" --image "$IMG"
else
  az containerapp job create -n j -g "$RG" --container-name c --image "$IMG"
fi
`;
  assert.deepEqual(rules(src), []);
});

test('`update ... 2> /dev/null` (spaced) is still a violation', () => {
  const src = 'az containerapp job update -n j -g "$RG" --image "$IMG" 2> /dev/null\n';
  assert.deepEqual(rules(src), ['swallowed-stderr']);
});

// ---------------------------------------------------------------------------
// Rule C — a flag-based create must name its container
// ---------------------------------------------------------------------------

test('flag-based create without --container-name is a violation', () => {
  const src = `#!/usr/bin/env bash
az containerapp job create -n loom-lineage-extractor -g "$RG" \\
  --environment "$CAEID" \\
  --image "$IMAGE" \\
  --cpu 0.5 --memory 1.0Gi
`;
  assert.deepEqual(rules(src), ['missing-container-name']);
});

test('CONTROL: --container-name on a continued line satisfies the rule', () => {
  // Requires the backslash-continuation joiner. Without it the flag looks like a
  // separate statement and every multi-line create in the repo would false-fail.
  const src = `#!/usr/bin/env bash
az containerapp job create -n loom-lineage-extractor -g "$RG" \\
  --environment "$CAEID" \\
  --container-name extractor \\
  --image "$IMAGE"
`;
  assert.deepEqual(rules(src), []);
});

test('CONTROL: a --yaml create names its container inside the payload', () => {
  // verify/uat set the container name in the YAML, so demanding --container-name
  // from them would be an over-broad rule that forces a meaningless flag.
  const src = `#!/usr/bin/env bash
az containerapp job create -n loom-verify -g "$RG" --yaml "$TMP" -o none
`;
  assert.deepEqual(rules(src), []);
});

test('a create inside a shell comment is ignored', () => {
  const src = '# az containerapp job create -n j -g "$RG" --image "$IMG"\n';
  assert.deepEqual(rules(src), []);
  assert.equal(analyze(src).stats.creates, 0);
});

test('a --container-name that is only in a trailing comment does not satisfy rule C', () => {
  const src = 'az containerapp job create -n j -g "$RG" --image "$IMG"  # --container-name extractor\n';
  assert.deepEqual(rules(src), ['missing-container-name']);
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test('logicalLines joins backslash continuations and keeps the start line', () => {
  const joined = logicalLines('a \\\n  b \\\n  c\nd\n');
  assert.equal(joined[0].text, 'a b c');
  assert.equal(joined[0].line, 1);
  assert.equal(joined[1].text, 'd');
  assert.equal(joined[1].line, 4);
});

test('analyze counts what it inspected, so an "ok" is not vacuous', () => {
  const { stats } = analyze(VERIFY_FIXED);
  assert.equal(stats.creates, 1);
  assert.equal(stats.secretRefs, 1);
  assert.ok(stats.declaredSecrets >= 1);
});
