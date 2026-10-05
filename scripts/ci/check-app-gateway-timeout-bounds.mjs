#!/usr/bin/env node
/**
 * GUARDRAIL: the three declared bounds on the App Gateway request-timeout
 * param stay in agreement.
 *
 * WHY THIS EXISTS (#4747)
 * -----------------------
 * `appGatewayRequestTimeoutSeconds` / `consoleRequestTimeoutSeconds` is
 * deliberately bounded (`@minValue`/`@maxValue`) in THREE places rather than
 * one:
 *
 *   - platform/fiab/bicep/main.bicep              — catches a bad
 *     `.bicepparam` literal at COMPILE time (the only one of the three a
 *     literal in a params file actually binds against).
 *   - platform/fiab/bicep/modules/admin-plane/main.bicep — the same bound on
 *     the module that receives the value.
 *   - platform/fiab/bicep/modules/admin-plane/app-gateway.bicep — the bound
 *     on the direct caller of the ARM resource (`consoleRequestTimeoutSeconds`).
 *
 * That repetition is the point (#4373 review §5 — a bound stated in only one
 * of two reachable places lets an out-of-range value compile and get rejected
 * by ARM mid-deploy instead of at compile time). What repetition does NOT get
 * you for free is agreement: nothing stopped one of the three from drifting
 * to a different min/max while the others stayed put. This guard is that
 * missing check.
 *
 * SEVERITY OF THE GAP THIS CLOSES, STATED HONESTLY
 * -------------------------------------------------
 * Low. A divergence surfaces as a noisy ARM deploy-time rejection (the
 * narrowest bound in the chain still rejects an out-of-range value), not a
 * silently-wrong estate. This guard exists to keep the failure mode from
 * drifting into something less honest, not because today's values are wrong.
 *
 * THE RULE
 * --------
 * Lift the `@minValue(N)` / `@maxValue(N)` pair immediately preceding each of
 * the three param declarations below, straight from the source text — never
 * transcribe the numbers here, or a typo in this file could make the checker
 * agree with itself while the real files disagree. All three `minValue`s
 * must be equal; all three `maxValue`s must be equal.
 *
 * Run: node scripts/ci/check-app-gateway-timeout-bounds.mjs
 * Tests: node --test scripts/ci/__tests__/check-app-gateway-timeout-bounds.test.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

/** One site: a file, the param name whose preceding decorators we read. */
const SITES = [
  { file: 'platform/fiab/bicep/main.bicep', param: 'appGatewayRequestTimeoutSeconds' },
  { file: 'platform/fiab/bicep/modules/admin-plane/main.bicep', param: 'appGatewayRequestTimeoutSeconds' },
  { file: 'platform/fiab/bicep/modules/admin-plane/app-gateway.bicep', param: 'consoleRequestTimeoutSeconds' },
];

/**
 * Find `param <name> ...` and read the nearest preceding `@minValue(N)` /
 * `@maxValue(N)` decorators above it (skipping blank lines and other
 * decorators/comments in between, since a `@description(...)` commonly sits
 * between the bound decorators and the `param` line).
 */
export function extractBounds(src, paramName) {
  const lines = src.split('\n');
  const paramLineRe = new RegExp(`^\\s*param\\s+${paramName}\\b`);
  const paramIdx = lines.findIndex((l) => paramLineRe.test(l));
  if (paramIdx === -1) return null;

  let min = null;
  let max = null;
  // Walk upward from the param line through its decorator block only — stop
  // at the first line that is neither a decorator, a comment, nor blank,
  // since that is the PRECEDING symbol's body, not this param's decorators.
  for (let i = paramIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const minM = /@minValue\((-?\d+)\)/.exec(trimmed);
    const maxM = /@maxValue\((-?\d+)\)/.exec(trimmed);
    if (minM) { min = Number(minM[1]); continue; }
    if (maxM) { max = Number(maxM[1]); continue; }
    if (trimmed.startsWith('@') || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    break; // hit the previous symbol's body — stop
  }
  return { min, max };
}

function main() {
  const results = SITES.map((site) => {
    const src = readFileSync(resolve(REPO, site.file), 'utf8');
    const bounds = extractBounds(src, site.param);
    return { ...site, bounds };
  });

  const missing = results.filter((r) => !r.bounds || r.bounds.min == null || r.bounds.max == null);
  if (missing.length > 0) {
    console.error('[app-gateway-timeout-bounds] FAIL — could not find both @minValue and @maxValue immediately above these params:');
    for (const m of missing) console.error(`  ${m.file} :: ${m.param} -> ${JSON.stringify(m.bounds)}`);
    process.exitCode = 1;
    return;
  }

  const mins = new Set(results.map((r) => r.bounds.min));
  const maxes = new Set(results.map((r) => r.bounds.max));
  const summary = results.map((r) => `${r.file} :: ${r.param} = [${r.bounds.min}, ${r.bounds.max}]`).join('\n  ');

  if (mins.size > 1 || maxes.size > 1) {
    console.error('[app-gateway-timeout-bounds] FAIL — the three declared bounds have drifted apart:');
    console.error(`  ${summary}`);
    console.error('Fix: bring all three @minValue/@maxValue pairs back into agreement (#4747).');
    process.exitCode = 1;
    return;
  }

  console.log(`[app-gateway-timeout-bounds] OK — all three sites agree: [${[...mins][0]}, ${[...maxes][0]}]`);
  console.log(`  ${summary}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
