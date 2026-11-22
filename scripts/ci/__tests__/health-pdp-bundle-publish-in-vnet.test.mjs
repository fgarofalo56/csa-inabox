/**
 * health-pdp-bundle-publish.yml must reach the control plane IN-VNET (#5422). Front Door routes only
 * /auth/* and /api/health/pdp/*; the live run 44980604235 got 404 from the routing-map read at the
 * Front Door host. Each assertion names the value that turns it red (assertion-design.md).
 * Run: node --test scripts/ci/__tests__/health-pdp-bundle-publish-in-vnet.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const wf = readFileSync(resolve(root, '.github/workflows/health-pdp-bundle-publish.yml'), 'utf8').replace(/\r\n/g, '\n');

// Top-level jobs under `jobs:` (2-space indent keys), as { name: body }.
function jobs() {
  const body = wf.slice(wf.indexOf('\njobs:\n') + 6);
  const out = {};
  const re = /^  ([a-z][\w-]*):\n/gm;
  const hits = [...body.matchAll(re)];
  hits.forEach((m, i) => { out[m[1]] = body.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : undefined); });
  return out;
}
const J = jobs();
const CP_CALL = /(\$\{?CP_URL\b|routing-map|publish-bundle\.mjs)/;

test('positive control: the parser found the jobs this file is about', () => {
  assert.deepEqual(Object.keys(J).sort(), ['gate', 'gov-unsupported', 'publish'],
    'breaks if a job is added/renamed without re-pinning which runner it needs');
});

test('every job that calls the control plane runs on [self-hosted, loom-aca]', () => {
  const callers = Object.entries(J).filter(([, b]) => CP_CALL.test(b));
  assert.deepEqual(callers.map(([n]) => n), ['publish'], 'positive: publish is the (only) control-plane caller; breaks if the call moves to another job');
  for (const [n, b] of callers) {
    assert.match(b, /^ {4}runs-on: \[self-hosted, loom-aca\]$/m, `${n}: would break if runs-on is ubuntu-latest (the internal CP is unreachable from it)`);
    assert.doesNotMatch(b, /runs-on: ubuntu-latest/, `${n}: a hosted runner is back`);
  }
});

test('the PUT job keeps the health-pdp-publish environment gate and is Commercial-only', () => {
  assert.match(J.publish, /^ {4}environment: health-pdp-publish$/m, 'breaks if the approval gate is dropped from the job that PUTs');
  assert.match(J.publish, /inputs\.boundary == 'Commercial'/, 'breaks if publish may run for GCC-High, where no loom-aca fleet exists');
});

test('GCC-High publish is refused with a true reason, not left to queue or 404', () => {
  assert.match(J['gov-unsupported'], /inputs\.boundary == 'GCC-High'/, 'breaks if the refusal job no longer selects GCC-High');
  assert.match(J['gov-unsupported'], /::error::mode=publish is not supported for GCC-High: .*loom-aca.*Nothing was published/s, 'breaks if the message loses the reason or the nothing-published statement');
  assert.match(J['gov-unsupported'], /^ {10}exit 1$/m, 'breaks if the refusal can exit 0 (green over nothing)');
});

test('the control plane URL comes from the estate resolver or a validated https input, never the Front Door host', () => {
  assert.match(J.publish, /bash scripts\/csa-loom\/resolve-health-console-binding\.sh --subscription "\$STAMP_SUB"/, 'breaks if the resolver step is removed');
  assert.match(J.publish, /"\$BINDING" != "resolved"/, 'breaks if a preserved/unknown binding is accepted');
  assert.match(J.publish, /"\$cp_host" = "\$iss_host" \] \|\| \[\[ "\$cp_host" == \*\.azurefd\.net \]\]/, 'breaks if a CP URL on the issuer/Front Door host is allowed');
  assert.match(J.publish, /case "\$CP_URL_IN" in https:\/\/\*\)/, 'breaks if a supplied control_plane_url is not https-validated');
  // The raw inputs must not be read into CP_URL at job level: only the validated step writes CP_URL.
  assert.doesNotMatch(J.publish, /^ {6}CP_URL: \$\{\{ inputs\.control_plane_url \}\}/m, 'breaks if the unvalidated input is wired straight to CP_URL again');
  assert.match(J.publish, /echo "CP_URL=\$cp_url"/, 'positive: the validated value is what later steps read');
});

test('no curl targets the issuer host for the control plane; the JWKS read is the only Front Door call', () => {
  const curls = [...J.publish.matchAll(/curl [^\n]*/g)].map((m) => m[0]);
  const cpCurls = curls.filter((c) => c.includes('routing-map') && !c.includes('routing-map/publish'));
  assert.equal(cpCurls.length, 1, 'positive: exactly one routing-map read');
  // The refresh: breaks if the POST is dropped (a fresh stamp has no map, GET answers 404,
  // run 45038029387), aimed at Front Door, or loses --fail.
  const refresh = curls.filter((c) => c.includes('routing-map/publish'));
  assert.equal(refresh.length, 1, 'breaks if the routing-map refresh POST is removed or duplicated');
  assert.ok(refresh[0].includes('-X POST') && refresh[0].includes('${CP_URL%/}/api/health/routing-map/publish'), 'breaks if the refresh is not a POST to the in-VNet CP');
  assert.ok(/curl -fsS /.test(refresh[0]) && !/ISSUER_URL/.test(refresh[0]), 'breaks if --fail is dropped or the refresh is aimed at Front Door');
  assert.ok(J.publish.indexOf('routing-map/publish') < J.publish.indexOf('${CP_URL%/}/api/health/routing-map"'), 'breaks if the refresh runs AFTER the read');
  assert.match(J.publish, /409\) WHY="the control plane refused to replace a non-empty routing map/, 'breaks if the 409 wipe guard is not named (or is overridden)');
  assert.ok(cpCurls[0].includes('${CP_URL%/}/api/health/routing-map'), 'breaks if the routing-map read is aimed at ISSUER_URL or a literal host');
  assert.ok(!/ISSUER_URL/.test(cpCurls[0]), 'ISSUER_URL (Front Door) in the routing-map curl');
  assert.ok(curls.some((c) => c.includes('${ISSUER_URL%/}/jwks.json')), 'positive: JWKS still read from the public issuer');
});

test('guards kept: no result-discarding, token never printed, allow_empty_stamp refusal', () => {
  const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // comments may name the banned constructs
  assert.doesNotMatch(code, /continue-on-error|\|\| true|2>\/dev\/null/, 'breaks if a result-discarding construct is introduced');
  assert.match(J.publish, /echo "::add-mask::\$tok"/, 'breaks if the token mask is dropped');
  const tokEchoes = J.publish.split('\n').filter((l) => /\becho\b.*\$tok\b/.test(l));
  assert.equal(tokEchoes.length, 2, 'positive: exactly the mask line and the GITHUB_ENV line mention $tok');
  assert.ok(tokEchoes.every((l) => l.includes('::add-mask::') || l.includes('>> "$GITHUB_ENV"')), 'breaks if a new echo prints the token to the log');
  assert.match(J.publish, /"\$n" = "0" \] && \[ "\$ALLOW_EMPTY" != "true"/, 'breaks if the empty-stamp refusal is removed');
  assert.match(J.publish, /curl -fsS -H @"\$WORK\/auth\.hdr"/, 'breaks if --fail (-f) is dropped from the authenticated read');
  for (const n of ['LOOM_HEALTH_CP_URL', 'LOOM_HEALTH_CP_AUDIENCE', 'LOOM_HEALTH_DEFAULT_STAMP_ID']) {
    assert.ok(J.publish.includes(`# unset-var-ok: ${n}`), `breaks if ${n} (written by the resolver) loses its unset-var-ok marker`);
  }
});
