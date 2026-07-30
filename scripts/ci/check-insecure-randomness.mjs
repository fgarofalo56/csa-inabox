#!/usr/bin/env node
/**
 * check-insecure-randomness — ratchet on `Math.random()` in Loom app code (#2656).
 *
 * WHY. `Math.random()` is not a CSPRNG: V8 uses xorshift128+, whose state is
 * recoverable from a handful of observed outputs, so given a few generated values
 * an attacker can predict the next ones. CodeQL `js/insecure-randomness` reported
 * 25 instances; the ACTUAL count when this guard was written was **184 across 150
 * files**, because CodeQL only flags the ones whose value it can trace to a
 * sink it recognises.
 *
 * Reviewed every reported site: none of them mints a secret today. They are
 * audit-row ids, notebook cell ids, run ids, temp resource names, canvas node
 * positions. So this is NOT 184 vulnerabilities, and this guard does not pretend
 * otherwise.
 *
 * The risk is the NEXT one. In a codebase where `Math.random()` is the house
 * style for identifiers, someone eventually copies an id generator into a place
 * that mints a share link, an invite code, a reset nonce or an idempotency key
 * that must be unguessable — and it looks exactly like its neighbours, so review
 * waves it through. This guard makes the count monotonically decrease, so the
 * house style shifts to `lib/util/random-id` without a 150-file flag-day PR.
 *
 * DELIBERATE PERMANENT EXCLUSIONS — these are STATISTICAL, not identity. Nothing
 * is guessed and nothing is authenticated, so a CSPRNG would add cost for zero
 * security benefit. Swapping them would be cargo-culting, not hardening:
 *
 *   lib/telemetry/rum.ts        `Math.random() * 100 < sampleRate`  (sampling)
 *   lib/clients/cost-client.ts  retry-backoff jitter
 *
 * MODE:
 *   node scripts/ci/check-insecure-randomness.mjs
 *   node scripts/ci/check-insecure-randomness.mjs --update-baseline
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = [
  'apps/fiab-console/lib',
  'apps/fiab-console/app',
  'apps/copilot-maf/src',
  'apps/fiab-report-subscriptions/src',
];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '.next', 'dist', 'build', 'copilot-corpus']);

/**
 * Files where `Math.random()` is CORRECT and must not be counted or "fixed".
 * Adding an entry is a security review: state why the value is statistical
 * rather than an identifier.
 */
const STATISTICAL_EXEMPT = new Map([
  ['apps/fiab-console/lib/telemetry/rum.ts', 'RUM sample-rate decision — a probability, not an identifier. Nothing is guessed.'],
  ['apps/fiab-console/lib/clients/cost-client.ts', 'Retry-backoff jitter — spreads load. Predictability is harmless; a CSPRNG buys nothing.'],
]);

/** Total permitted `Math.random()` occurrences outside the exempt files. */
const BASELINE = 178;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p.split(path.sep).join('/'));
  }
}

const files = [];
for (const r of ROOTS) if (fs.existsSync(r)) walk(r, files);

let total = 0;
const per = [];
for (const f of files) {
  if (STATISTICAL_EXEMPT.has(f)) continue;
  const m = fs.readFileSync(f, 'utf8').match(/Math\.random/g);
  if (m) {
    total += m.length;
    per.push([f, m.length]);
  }
}

if (process.argv.includes('--update-baseline')) {
  console.log(`[insecure-randomness] current total (excluding ${STATISTICAL_EXEMPT.size} statistical files): ${total}`);
  console.log('Set BASELINE in this file to that number. It must only ever DECREASE.');
  process.exit(0);
}

console.log(`[insecure-randomness] baseline: ${BASELINE}  current: ${total}  (across ${per.length} files)`);

if (total > BASELINE) {
  const worst = per.sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.error('\n[insecure-randomness] FAIL — Math.random() count went UP.\n');
  console.error('  Use lib/util/random-id (randomId / randomSuffix / randomUuid) instead.');
  console.error('  It is crypto-backed, uniform, and REFUSES to fall back to Math.random.\n');
  console.error('  If the new use is genuinely statistical (sampling / jitter), add the file to');
  console.error('  STATISTICAL_EXEMPT in this guard with the reason — that is a security review.\n');
  console.error('  Highest-count files:');
  for (const [f, n] of worst) console.error(`    ${n}  ${f}`);
  process.exit(1);
}

if (total < BASELINE) {
  console.log(`[insecure-randomness] OK — and the count DROPPED by ${BASELINE - total}. Lower BASELINE to ${total} to lock the gain in.`);
} else {
  console.log('[insecure-randomness] OK — no new Math.random(); baseline holds.');
}
