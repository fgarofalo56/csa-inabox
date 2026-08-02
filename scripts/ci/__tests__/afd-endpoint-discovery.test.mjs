/**
 * afd-endpoint-discovery guard tests (#2828).
 *
 * The guard exists because a CDN endpoint name that was never fetched from Azure
 * is a guess, and the roll's Front Door purge guessed for months while reporting
 * success. These tests pin the three ways a name can fail to be discovered —
 * literal, `${{ }}` expression, and a variable holding a constant — and, just as
 * importantly, the shapes that must stay GREEN, because a guard that also fails
 * correct code gets weakened or deleted.
 *
 * MUTATION-PROVEN (see the PR body for the live run): re-introducing
 * `--endpoint-name ${{ env.APP_NAME }}` in loom-roll-and-validate.yml turns the
 * repo-wide guard RED naming that file and line, and the CONTROL rows — the
 * discovered `"$EN"` / `"$FD_ENDPOINT"` / `"$ep"` invocations — stay `ok` in both
 * directions, so the guard is discriminating rather than just noisy.
 *
 * Run: node --test scripts/ci/__tests__/afd-endpoint-discovery.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logicalLines,
  isInvocation,
  classifyEndpointArg,
  isDiscoveryDerived,
  scanSource,
} from '../check-afd-endpoint-discovery.mjs';

/* ---------------------------- classification ---------------------------- */

test('a bare literal is a literal', () => {
  assert.deepEqual(classifyEndpointArg('loom-console'), { kind: 'literal', name: null });
  assert.deepEqual(classifyEndpointArg('"loom-console"'), { kind: 'literal', name: null });
});

test('a ${{ }} expression is NOT discovery — it is a parse-time constant', () => {
  assert.equal(classifyEndpointArg('${{ env.APP_NAME }}').kind, 'expression');
  assert.equal(classifyEndpointArg('"${{ inputs.endpoint }}"').kind, 'expression');
});

test('a shell variable is a variable, quoted or braced', () => {
  assert.deepEqual(classifyEndpointArg('"$EN"'), { kind: 'variable', name: 'EN' });
  assert.deepEqual(classifyEndpointArg('$EN'), { kind: 'variable', name: 'EN' });
  assert.deepEqual(classifyEndpointArg('"${FD_ENDPOINT}"'), { kind: 'variable', name: 'FD_ENDPOINT' });
});

test('an interpolated argument is unnameable, and unnameable is not "fine"', () => {
  const c = classifyEndpointArg('"loom-console-$SUFFIX"');
  assert.equal(c.kind, 'variable');
  assert.equal(c.name, null);
  // A name we cannot trace must never count as derived.
  assert.equal(isDiscoveryDerived('SUFFIX=$(az afd endpoint list -o tsv)', c.name), false);
});

/* ------------------------------- tracing -------------------------------- */

test('a variable assigned straight from `az afd ... list` is derived', () => {
  const src = 'EP=$(az afd endpoint list --profile-name "$P" -g "$RG" --query "[].name" -o tsv)\n';
  assert.equal(isDiscoveryDerived(src, 'EP'), true);
});

test('the two-hop `for ep in $EPS` shape (fiab-orphan-sweep) is derived', () => {
  const src = [
    'EPS="$(az afd endpoint list -g "$RG" --profile-name "$P" --query "[].name" -o tsv)"',
    'for ep in $EPS; do',
    '  az afd endpoint delete -y --endpoint-name "$ep"',
    'done',
  ].join('\n');
  assert.equal(isDiscoveryDerived(src, 'ep'), true);
});

test('a variable holding a constant is NOT derived, however many hops', () => {
  const src = 'BASE=loom-console\nEP="$BASE"\nEP2="$EP"\n';
  assert.equal(isDiscoveryDerived(src, 'EP2'), false);
});

test('`az containerapp list` is not CDN discovery', () => {
  assert.equal(isDiscoveryDerived('EP=$(az containerapp list --query "[0].name" -o tsv)', 'EP'), false);
});

test('KNOWN LIMIT — multiple assignments pass if ANY reaches discovery', () => {
  // Textual trace, not dataflow. A variable assigned both a constant and a
  // discovery result passes, even though the constant could be the one that wins
  // at runtime. Pinned so the limitation is a documented decision rather than an
  // unnoticed hole: if someone later adds real dataflow, this test tells them
  // exactly which behaviour they are changing.
  const src = 'EP=loom-console\nEP=$(az afd endpoint list --query "[].name" -o tsv)\n';
  assert.equal(isDiscoveryDerived(src, 'EP'), true);
  // CONTROL — with ONLY the constant assignment it is correctly not derived.
  assert.equal(isDiscoveryDerived('EP=loom-console\n', 'EP'), false);
});

test('an undeclared variable is not derived', () => {
  assert.equal(isDiscoveryDerived('echo hi', 'EP'), false);
});

/* ----------------------------- line handling ---------------------------- */

test('a backslash-continued invocation is analysed as ONE command', () => {
  const src = ['az afd endpoint purge --profile-name "$P" -g "$RG" \\', '  --endpoint-name loom-console --content-paths "/*"'].join('\n');
  const found = scanSource(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'literal');
  assert.equal(found[0].line, 1, 'reports the line the command STARTS on');
});

test('comments and emitted strings are not invocations', () => {
  assert.equal(isInvocation('# az afd endpoint purge --endpoint-name loom-console'), false);
  assert.equal(isInvocation(' * az afd endpoint purge --endpoint-name loom-console'), false);
  assert.equal(isInvocation('// az afd endpoint purge --endpoint-name loom-console'), false);
  assert.equal(isInvocation('echo "az afd endpoint purge --endpoint-name loom-console"'), false);
  assert.equal(isInvocation('console.log("az afd ... --endpoint-name x")'), false);
  assert.equal(isInvocation('echo "::warning::az afd endpoint purge --endpoint-name x"'), false);
  // CONTROL — the real thing still registers.
  assert.equal(isInvocation('az afd endpoint purge --endpoint-name "$EN"'), true);
});

test('`az network private-endpoint` is a different resource and is ignored', () => {
  const src = 'az network private-endpoint dns-zone-group create --endpoint-name "$PE" -n default\n';
  assert.deepEqual(scanSource(src), []);
});

test('logicalLines keeps unrelated lines separate', () => {
  const ll = logicalLines('a\nb\nc');
  assert.deepEqual(ll.map((l) => l.text), ['a', 'b', 'c']);
  assert.deepEqual(ll.map((l) => l.line), [1, 2, 3]);
});

/* ------------------------------- end to end ------------------------------ */

test('the exact #2828 source is flagged as an EXPRESSION', () => {
  const src = [
    'FD_PROFILE=$(az afd profile list -g "$RG" --query "[0].name" -o tsv)',
    'if [[ -n "$FD_PROFILE" ]]; then',
    '  az afd endpoint purge --profile-name "$FD_PROFILE" -g "$RG" \\',
    '    --endpoint-name ${{ env.APP_NAME }} --content-paths \'/*\' --no-wait || true',
    'fi',
  ].join('\n');
  const found = scanSource(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'expression');
  assert.equal(found[0].derived, false);
  assert.equal(found[0].allowed, false);
});

test('CONTROL — the fixed source passes', () => {
  const src = [
    'EPLIST=$(az afd endpoint list --profile-name "$P" -g "$RG" --query "[].[name,hostName]" -o tsv)',
    "EPNAMES=$(printf '%s\\n' \"$EPLIST\" | awk -F'\\t' 'NF{print $1}')",
    'for EN in $EPNAMES; do',
    '  az afd route list --profile-name "$P" -g "$RG" --endpoint-name "$EN" --query "[].customDomains[].id" -o tsv',
    'done',
  ].join('\n');
  const found = scanSource(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].derived, true, 'EN -> EPNAMES -> EPLIST -> az afd endpoint list');
});

test('the allowlist marker works on the line and on the line above', () => {
  const inline = 'az afd endpoint purge --endpoint-name operator-supplied # afd-endpoint-discovery-ok: operator input';
  assert.equal(scanSource(inline)[0].allowed, true);

  const above = ['# afd-endpoint-discovery-ok: operator input', 'az afd endpoint purge --endpoint-name operator-supplied'].join('\n');
  const f = scanSource(above);
  assert.equal(f.length, 1);
  assert.equal(f[0].allowed, true);

  // CONTROL — without the marker the same line fails.
  assert.equal(scanSource('az afd endpoint purge --endpoint-name operator-supplied')[0].allowed, false);
});

test('`--endpoint-name=value` is caught too, not just the space form', () => {
  const found = scanSource('az cdn endpoint purge --endpoint-name=loom-console --content-paths "/*"');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'literal');
});
