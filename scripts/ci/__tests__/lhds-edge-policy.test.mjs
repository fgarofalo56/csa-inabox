/**
 * Structural test for the LHDS edge policy (#5149 items 4 and 5): the APIM fragment
 * lhds-tenant-routing and the knob that reaches the WAF per-address rule.
 *
 * SCOPE, stated plainly: this reads source text. It does NOT execute APIM policy and
 * proves nothing about a live 429, a Retry-After value or a Gov deploy; those stay
 * "supported-in-code, never exercised" until scripts/measure/health/edge-probe.mjs
 * has run against a deployed gateway in each cloud.
 *
 * Each test names the edit that turns it red (assertion-design.md). The LHDS_REPO_ROOT
 * env var points the suite at a sandbox copy for mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/lhds-edge-policy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n');
const H = 'platform/fiab/bicep/modules/health';
const xml = read(`${H}/policies/lhds-tenant-routing.fragment.xml`);
const fragBicep = read(`${H}/apim-fragment.bicep`);
const ingress = read(`${H}/ingress.bicep`);
const stamp = read(`${H}/stamp.bicep`);
const health = read('platform/fiab/bicep/health.bicep');

const at = (needle) => {
  const i = xml.indexOf(needle);
  assert.ok(i >= 0, `fragment no longer contains ${needle}`);
  return i;
};

test('policy order: tenant mismatch 403 precedes the map lookup, quota follows the route, backend is last', () => {
  // Breaks if rate-limit-by-key moves above the route lookup (the quota would be unreadable)
  // or the 403 moves below the map fetch (answer would leak whether the tenant exists).
  const order = ['<validate-jwt', 'code="403"', 'cache-lookup-value key="lhds-routing-map"', 'name="lhdsRoute"', '<rate-limit-by-key', '<set-backend-service'].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `policy statements are out of order: ${order}`);
});

test('quota counter is keyed by the URL tenant, never by caller address or token', () => {
  const m = xml.match(/<rate-limit-by-key\b[^>]*>/);
  assert.ok(m, 'no rate-limit-by-key element');
  const tag = m[0];
  assert.match(tag, /counter-key="@\(&quot;lhds-tenant-&quot; \+ \(string\)context\.Variables\[&quot;lhdsTenant&quot;\]\)"/);
  // Positive pin above; these fail if the key is swapped for a per-caller one, which would
  // let one tenant's many callers each get a full quota (and defeat a noisy-neighbour cap).
  assert.doesNotMatch(tag, /IpAddress|Authorization|lhdsJwt|lhdsTokenTenant/);
  assert.match(tag, /renewal-period="60"/, 'maxRequestsPerMinute is per minute: renewal-period must be 60');
});

test('quota limit comes from the registry field the publisher emits, with the module default as fallback', () => {
  assert.match(xml, /r\[&quot;maxRequestsPerMinute&quot;\] != null \? \(int\)r\[&quot;maxRequestsPerMinute&quot;\] : __DEFAULT_RPM__/);
  const pub = read('apps/loom-health-cp/src/routing/publisher.ts');
  assert.match(pub, /maxRequestsPerMinute: t\.quotas\.maxRequestsPerMinute/, 'publisher no longer emits the field the fragment reads');
});

test('every __TOKEN__ in the fragment is substituted by apim-fragment.bicep, and vice versa', () => {
  const inXml = new Set(xml.match(/__[A-Z0-9_]+__/g));
  const inBicep = new Set([...fragBicep.matchAll(/'(__[A-Z0-9_]+__)'/g)].map((x) => x[1]));
  assert.ok(inXml.size >= 5, `expected >= 5 distinct tokens, found ${inXml.size}`);
  assert.deepEqual([...inXml].sort(), [...inBicep].sort(), 'an unsubstituted token would deploy literally into the policy');
});

test('429 is produced by rate-limit-by-key (which sets Retry-After itself) and no hand-written 429 can shadow it', () => {
  // A hand-written return-response 429 without Retry-After would break the contract the probe checks.
  assert.doesNotMatch(xml, /code="429"/);
  assert.match(xml, /<rate-limit-by-key\b/);
});

test('the not-serving and map-unavailable 503s carry Retry-After', () => {
  const blocks = xml.split('<return-response>').slice(1).filter((b) => b.includes('code="503"'));
  assert.equal(blocks.length, 2, 'expected exactly the two 503 answers');
  for (const b of blocks) assert.match(b.split('</return-response>')[0], /name="Retry-After"/);
});

test('item 5 wiring: healthConfig.wafClientRateLimitPerMinute reaches the WAF custom rule', () => {
  assert.match(health, /wafClientRateLimitPerMinute: int\(healthConfig\.\?wafClientRateLimitPerMinute \?\? 6000\)/);
  assert.match(stamp, /param wafClientRateLimitPerMinute int = 6000/);
  assert.match(stamp, /wafClientRateLimitPerMinute: wafClientRateLimitPerMinute/);
  assert.match(ingress, /wafClientRateLimitPerMinute > 0 \? \[/, '0 must drop the rule (the Gov escape)');
  assert.match(ingress, /customRules: wafRateLimitRules/);
});

test('WAF rule groups by client address only (a token claim is not a WAF key)', () => {
  assert.match(ingress, /variableName: 'ClientAddr'/);
  assert.doesNotMatch(ingress, /groupByVariables:[^\]]*(RequestHeader|GeoMatch)/);
});
